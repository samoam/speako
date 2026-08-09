import { config } from '../config';
import { embedText, cosineSimilarity } from '../rag/rag';
import { getAllCodeChunks } from '../storage/codeRepository';

export interface CodeMatch {
  repoName: string;
  filePath: string;
  text: string;
  score: number;
}

/** Brute-force cosine search over local code_chunks — same shape as rag.ts's retrieve(). */
export async function searchCode(query: string, limit = 5): Promise<CodeMatch[]> {
  const queryVector = await embedText(query);
  const candidates = getAllCodeChunks();

  return candidates
    .map((chunk) => ({
      repoName: chunk.repoName,
      filePath: chunk.filePath,
      text: chunk.text,
      score: cosineSimilarity(queryVector, chunk.embedding),
    }))
    .filter((m) => m.score >= config.ragSimilarityThreshold)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
}
