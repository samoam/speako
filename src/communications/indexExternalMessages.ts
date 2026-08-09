import { chunkText } from '../codebase/chunkText';
import { embedText } from '../rag/rag';
import {
  getUnindexedMessages,
  markMessageIndexed,
  insertExternalMessageChunk,
  deleteChunksForMessage,
} from '../storage/externalMessageRepository';

export interface ExternalMessageIndexProgress {
  messageId: string;
  status: 'started' | 'done' | 'failed';
  chunkCount?: number;
  error?: string;
}

/**
 * Processes every external_messages row with indexed_at IS NULL — written by
 * a separate daily-indexing task (see docs/EXTERNAL_INGESTION_PROMPT.md), not
 * Speako itself. One message failing (bad text, embedding error) doesn't stop
 * the rest — same per-item isolation as runCodebaseIndex.
 */
export async function runExternalMessageIndex(onProgress?: (p: ExternalMessageIndexProgress) => void): Promise<void> {
  for (const message of getUnindexedMessages()) {
    onProgress?.({ messageId: message.id, status: 'started' });
    try {
      deleteChunksForMessage(message.id);
      const chunks = chunkText(message.bodyText);

      for (let i = 0; i < chunks.length; i++) {
        const embedding = await embedText(chunks[i]);
        insertExternalMessageChunk({
          messageId: message.id,
          source: message.source,
          chunkIndex: i,
          text: chunks[i],
          embedding,
        });
      }

      markMessageIndexed(message.id);
      onProgress?.({ messageId: message.id, status: 'done', chunkCount: chunks.length });
    } catch (err) {
      onProgress?.({ messageId: message.id, status: 'failed', error: err instanceof Error ? err.message : String(err) });
    }
  }
}
