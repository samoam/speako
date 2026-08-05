import { TranscriptSegment } from './types';

function fmtTime(ms: number): string {
  const s = Math.floor(ms / 1000);
  const mm = String(Math.floor(s / 60)).padStart(2, '0');
  const ss = String(s % 60).padStart(2, '0');
  return `${mm}:${ss}`;
}

export function toPlainText(segments: TranscriptSegment[]): string {
  return segments.map((s) => `[${fmtTime(s.startMs)}] ${s.speaker}: ${s.text}`).join('\n');
}
