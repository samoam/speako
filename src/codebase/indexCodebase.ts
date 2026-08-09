import { config } from '../config';
import { walkLocalRepo } from './walkLocalRepo';
import { chunkText } from './chunkText';
import { embedText } from '../rag/rag';
import { insertCodeChunk, deleteChunksForRepo } from '../storage/codeRepository';

export function isLocalCodebaseConfigured(): boolean {
  return config.codebaseLocalPaths.length > 0;
}

export interface CodebaseIndexProgress {
  repo: string;
  status: 'started' | 'done' | 'failed';
  fileCount?: number;
  chunkCount?: number;
  error?: string;
}

/**
 * Reindexes every configured local codebase path. One repo failing (bad path,
 * embedding error) doesn't stop the rest — each is independently try/caught,
 * same isolation idea as PrepService's per-source trySource().
 */
export async function runCodebaseIndex(onProgress?: (p: CodebaseIndexProgress) => void): Promise<void> {
  for (const { name, path: repoPath } of config.codebaseLocalPaths) {
    onProgress?.({ repo: name, status: 'started' });
    try {
      deleteChunksForRepo(name);
      const { files } = walkLocalRepo(repoPath);

      let chunkCount = 0;
      for (const file of files) {
        const chunks = chunkText(file.content);
        for (let i = 0; i < chunks.length; i++) {
          const embedding = await embedText(chunks[i]);
          insertCodeChunk({
            repoName: name,
            filePath: file.relativePath,
            chunkIndex: i,
            text: chunks[i],
            embedding,
          });
          chunkCount++;
        }
      }

      onProgress?.({ repo: name, status: 'done', fileCount: files.length, chunkCount });
    } catch (err) {
      onProgress?.({ repo: name, status: 'failed', error: err instanceof Error ? err.message : String(err) });
    }
  }
}
