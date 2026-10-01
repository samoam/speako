/**
 * Progress-log lines (PR review, dev cycle, code change, dev plan,
 * implementations) are stored as "[<ISO time>] message" — the time travels
 * inside the string so the JSON `log` columns stay plain string arrays and
 * lines written before this existed (no prefix) still render as-is. The UI
 * (index.html's logLineParts) shows the prefix as local HH:MM:SS.
 */
export function stampLogLine(message: string, at: Date = new Date()): string {
  return `[${at.toISOString()}] ${message}`;
}

const STAMP = /^\[(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z)\] /;

/** The message without its time prefix (unchanged if it has none). */
export function unstampLogLine(line: string): string {
  return line.replace(STAMP, '');
}
