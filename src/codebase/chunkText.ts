// Recursive character-based chunker — same algorithm shape as rag-mcp-server's
// chunking.py, reimplemented here since Speako has no text chunker yet
// (transcript segments are used whole; source files need real chunking).

const SEPARATORS = ['\n\n\n', '\n\n', '\n', '. ', '! ', '? ', ' '];

function splitOnSeparator(text: string, separator: string): string[] {
  if (!text.includes(separator)) return [text];
  const parts = text.split(separator);
  return [...parts.slice(0, -1).map((p) => p + separator), parts[parts.length - 1]];
}

function splitPiece(piece: string, chunkSize: number, separators: string[]): string[] {
  if (piece.length <= chunkSize) return [piece];
  if (separators.length === 0) {
    const result: string[] = [];
    for (let i = 0; i < piece.length; i += chunkSize) result.push(piece.slice(i, i + chunkSize));
    return result;
  }
  const pieces = splitOnSeparator(piece, separators[0]);
  if (pieces.length === 1) return splitPiece(piece, chunkSize, separators.slice(1));

  const result: string[] = [];
  for (const p of pieces) {
    if (p.length > chunkSize) result.push(...splitPiece(p, chunkSize, separators.slice(1)));
    else result.push(p);
  }
  return result;
}

export function chunkText(text: string, chunkSize = 2000, overlap = 200, minChunk = 100): string[] {
  const trimmed = text.trim();
  if (!trimmed) return [];

  const pieces = splitPiece(trimmed, chunkSize, SEPARATORS);

  const chunks: string[] = [];
  let current = '';
  for (const piece of pieces) {
    if (current && current.length + piece.length > chunkSize) {
      chunks.push(current);
      current = overlap ? current.slice(-overlap) : '';
    }
    current += piece;
  }
  if (current) chunks.push(current);

  if (chunks.length > 1 && chunks[chunks.length - 1].trim().length < minChunk) {
    const last = chunks.pop()!;
    chunks[chunks.length - 1] += last;
  }

  return chunks.map((c) => c.trim()).filter(Boolean);
}
