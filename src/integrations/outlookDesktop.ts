import { execFile } from 'child_process';
import * as path from 'path';
import { promisify } from 'util';
import { upsertExternalMessage } from '../storage/externalMessageRepository';
import { config } from '../config';

const execFileAsync = promisify(execFile);

const SCRIPT_PATH = path.join(__dirname, '..', '..', 'scripts', 'outlookExport.ps1');
/** Mail bodies can add up across a 48h inbox window — well above execFile's 1MB default maxBuffer. */
const MAX_BUFFER_BYTES = 50 * 1024 * 1024;
const TIMEOUT_MS = 60_000;

/** Outlook COM automation only exists on Windows, and only for classic desktop Outlook (not "New Outlook") — see scripts/outlookExport.ps1's header comment. There's no cheap way to detect "New Outlook" vs classic from Node, so this is a necessary-but-not-sufficient check; a real failure surfaces clearly when syncOutlookDesktop() actually runs. */
export function isOutlookDesktopConfigured(): boolean {
  return process.platform === 'win32';
}

export interface OutlookDesktopItem {
  id: string;
  subject?: string | null;
  receivedTime: string;
  participants?: string[];
  bodyText?: string | null;
}

export function mapOutlookItemToExternalMessage(item: OutlookDesktopItem): { id: string; source: 'email'; title: string | null; participants: string[]; occurredAt: string; bodyText: string } {
  return {
    // Namespaced so a real EntryID collision across machines/profiles can't collide with a Graph-sourced email id.
    id: `outlook-desktop:${item.id}`,
    source: 'email',
    title: item.subject ?? null,
    participants: item.participants ?? [],
    occurredAt: item.receivedTime,
    bodyText: (item.bodyText ?? '').trim(),
  };
}

/** Runs the PowerShell COM automation script and returns its parsed JSON array — throws with the script's own stderr on failure (e.g. Outlook not installed, "New Outlook" with no COM support, or the Object Model Guard prompt being dismissed/timed out). */
export async function runOutlookExport(sinceIso: string): Promise<OutlookDesktopItem[]> {
  const { stdout } = await execFileAsync(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', SCRIPT_PATH, '-SinceIso', sinceIso],
    { maxBuffer: MAX_BUFFER_BYTES, timeout: TIMEOUT_MS }
  );
  return JSON.parse(stdout);
}

export interface OutlookDesktopSyncResult {
  emailCount: number;
}

/**
 * Fallback email ingestion via classic Outlook desktop's own connection —
 * see config.ts's outlookDesktopLookbackHours comment for why this exists
 * alongside msGraphSync.ts (Graph's Mail API can't reach hybrid/on-prem
 * mailboxes or B2B-guest identities; this rides the local Outlook client
 * instead, which already has a working connection regardless). Writes into
 * the same external_messages table both other ingestion paths use.
 */
export async function syncOutlookDesktop(): Promise<OutlookDesktopSyncResult> {
  if (!isOutlookDesktopConfigured()) {
    throw new Error('Outlook desktop sync is only available on Windows.');
  }
  const sinceIso = new Date(Date.now() - config.outlookDesktopLookbackHours * 60 * 60_000).toISOString();
  const items = await runOutlookExport(sinceIso);
  for (const item of items) upsertExternalMessage(mapOutlookItemToExternalMessage(item));
  return { emailCount: items.length };
}
