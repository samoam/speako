import { config } from '../config';
import { TranscriptSegment } from '../types';
import { insertChunk, getAllChunksExcludingSession, CorpusChunkWithSessionName } from '../storage/corpusRepository';
import { getGeminiClient } from '../gemini/geminiClient';

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
  for (let i = 0; i < segments.length; i++) {
    const segment = segments[i];
    if (!segment.text.trim()) continue;
    const embedding = await embedText(segment.text);
    insertChunk({
      sessionId,
      chunkIndex: i,
      text: segment.text,
      startMs: segment.startMs,
      endMs: segment.endMs,
      embedding,
    });
  }
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
 */
export async function retrieve(queryText: string, excludeSessionId: string): Promise<RetrievalResult> {
  const queryVector = await embedText(queryText);
  const candidates = getAllChunksExcludingSession(excludeSessionId);

  const scored = candidates
    .map((chunk) => ({ ...chunk, score: cosineSimilarity(queryVector, chunk.embedding) }))
    .filter((chunk) => chunk.score >= config.ragSimilarityThreshold)
    .sort((a, b) => b.score - a.score)
    .slice(0, config.ragTopK);

  return { chunks: scored, suppressed: scored.length === 0 };
}
