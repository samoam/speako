import { config } from '../config';
import { db } from '../storage/db';
import { TranscriptSegment } from '../types';
import { insertChunk, getAllChunks, CorpusChunkWithSessionName } from '../storage/corpusRepository';
import { getGeminiClient } from '../gemini/geminiClient';

/**
 * gemini-embedding-001's embedContent only accepts one input text per call
 * (no multi-text batching, unlike older embedding models) — so this bounds
 * *concurrency* instead, running up to this many embedding calls in flight
 * at once rather than one-at-a-time, which is what indexSessionForRag used
 * to do via a plain sequential for-await loop.
 */
const EMBED_CONCURRENCY = 8;

/**
 * Past-session corpus chunks only change when a session finishes indexing
 * (indexSessionForRag, below) — everything else during a live session is
 * read-only against this data. retrieve() used to re-query+re-JSON.parse
 * every chunk's embedding on every trigger fire (up to a few times/minute);
 * this cache makes that a one-time cost per process until the corpus
 * actually changes.
 */
let corpusCache: CorpusChunkWithSessionName[] | null = null;

function getCorpus(): CorpusChunkWithSessionName[] {
  if (!corpusCache) corpusCache = getAllChunks();
  return corpusCache;
}

export async function embedText(text: string): Promise<number[]> {
  const res = await getGeminiClient().models.embedContent({
    model: config.ragEmbeddingModel,
    contents: text,
  });
  return res.embeddings[0].values;
}

export function cosineSimilarity(a: number[], b: number[]): number {
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

/**
 * Embeds a finished session's finalized transcript segments into the RAG
 * corpus (one chunk per segment — utterance-level chunking keeps citations
 * precise). Called automatically once a session stops, same rationale as
 * sentiment/trigger detection: this is text already stored/shown, and the
 * corpus needs to stay populated for live suggestion-grounding to work at all.
 */
export async function indexSessionForRag(sessionId: string, segments: TranscriptSegment[]): Promise<void> {
  const toEmbed = segments.map((segment, i) => ({ segment, chunkIndex: i })).filter((s) => s.segment.text.trim());

  // Embed with bounded concurrency (see EMBED_CONCURRENCY) instead of one
  // sequential await per segment — the embedding API has no multi-text batch
  // endpoint for this model, so this is the available speedup.
  const chunks: Omit<import('../storage/corpusRepository').CorpusChunk, 'id'>[] = new Array(toEmbed.length);
  let cursor = 0;
  async function worker(): Promise<void> {
    while (cursor < toEmbed.length) {
      const index = cursor++;
      const { segment, chunkIndex } = toEmbed[index];
      const embedding = await embedText(segment.text);
      chunks[index] = { sessionId, chunkIndex, text: segment.text, startMs: segment.startMs, endMs: segment.endMs, embedding };
    }
  }
  await Promise.all(Array.from({ length: Math.min(EMBED_CONCURRENCY, toEmbed.length) }, worker));

  // All embeddings are known up front now, so the inserts can be one
  // transaction instead of N separately auto-committed (fsync'd) writes.
  const insertAll = db.transaction((rows: typeof chunks) => {
    for (const row of rows) insertChunk(row);
  });
  insertAll(chunks);
  corpusCache = null; // invalidate — next retrieve() re-reads the now-larger corpus
}

export interface RetrievedChunk extends CorpusChunkWithSessionName {
  score: number;
}

export interface RetrievalResult {
  chunks: RetrievedChunk[];
  suppressed: boolean;
}

/**
 * Embeds the query (the transcript window around a trigger) and searches all
 * PAST sessions' indexed chunks (excluding the live session itself — that
 * context is already visible in the live transcript, no need to retrieve it).
 * Brute-force cosine similarity is deliberate — fine at personal scale
 * (hundreds/low-thousands of chunks), avoids running a separate vector DB.
 * Returns suppressed:true (spec §7.1 point 4) when nothing clears the
 * similarity threshold, so callers can skip generating a low-grounding suggestion.
 *
 * excludeSessionId is optional — omit it for a cross-session query with no
 * "current session" to exclude (see src/qa/crossSessionQa.ts's "ask across
 * all my meetings", the only caller that omits it today).
 */
export async function retrieve(queryText: string, excludeSessionId?: string): Promise<RetrievalResult> {
  const queryVector = await embedText(queryText);
  const candidates = excludeSessionId ? getCorpus().filter((chunk) => chunk.sessionId !== excludeSessionId) : getCorpus();

  const scored = candidates
    .map((chunk) => ({ ...chunk, score: cosineSimilarity(queryVector, chunk.embedding) }))
    .filter((chunk) => chunk.score >= config.ragSimilarityThreshold)
    .sort((a, b) => b.score - a.score)
    .slice(0, config.ragTopK);

  return { chunks: scored, suppressed: scored.length === 0 };
}
