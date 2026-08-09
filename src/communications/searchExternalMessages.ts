import { config } from '../config';
import { embedText, cosineSimilarity } from '../rag/rag';
import { getExternalMessageChunksBySource, ExternalMessageSource } from '../storage/externalMessageRepository';

export interface ExternalMessageMatch {
  messageId: string;
  source: ExternalMessageSource;
  text: string;
  score: number;
}

/** Brute-force cosine search scoped to one source — same pattern as codebase/searchCode.ts. */
export async function searchExternalMessages(query: string, source: ExternalMessageSource, limit = 5): Promise<ExternalMessageMatch[]> {
  const queryVector = await embedText(query);
  const candidates = getExternalMessageChunksBySource(source);

  return candidates
    .map((chunk) => ({
      messageId: chunk.messageId,
      source: chunk.source,
      text: chunk.text,
      score: cosineSimilarity(queryVector, chunk.embedding),
    }))
    .filter((m) => m.score >= config.ragSimilarityThreshold)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
}
