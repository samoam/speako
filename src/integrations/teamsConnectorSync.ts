import { paginateConnectorTool } from './claudeConnectorCli';
import { upsertExternalMessage } from '../storage/externalMessageRepository';
import { config } from '../config';

const PAGE_LIMIT = 25;

export interface ConnectorChatMessage {
  id: string;
  chatId: string;
  summary?: string;
  createdDateTime: string;
  from?: { displayName?: string; email?: string };
}

interface ConnectorChat {
  id: string;
  chatType?: string;
  topic?: string | null;
}

/**
 * Builds a chatId -> display title map from teams_list_chats — a chat
 * message itself carries no topic (see ConnectorChatMessage), only its
 * chatId. `topic` is null for 1:1 chats (confirmed live), so those fall back
 * to the message's own sender display name, matching the old Playwright
 * scraper's chatName behavior for DMs.
 *
 * First page only, and never fatal: confirmed live (2026-09-30) that
 * requesting page 2 with the connector's OWN returned nextCursor fails —
 * Graph 400 BadRequest inside the server, a 60s timeout (twice, with the
 * retry) from a direct call — and because this ran inside syncTeamsMessages'
 * Promise.all, that failure discarded every fetched message: no Teams
 * message had been stored since the switch to the connector. Page 1 is the 25
 * most recently active chats, which covers recent messages; any other chat
 * falls back to the sender's name like a 1:1 does.
 */
async function fetchChatTitles(): Promise<Map<string, string | null>> {
  try {
    const chats = await paginateConnectorTool<ConnectorChat>({ tool: 'teams_list_chats', args: { limit: PAGE_LIMIT }, paging: 'cursor', maxPages: 1 });
    return new Map(chats.map((chat) => [chat.id, chat.topic ?? null]));
  } catch (err: any) {
    console.error('[teams-sync] chat titles unavailable, falling back to sender names:', err.message);
    return new Map();
  }
}

export function mapTeamsMessageToExternalMessage(
  msg: ConnectorChatMessage,
  chatTitles: Map<string, string | null>
): { id: string; source: 'teams'; title: string | null; participants: string[]; occurredAt: string; bodyText: string } {
  const title = chatTitles.get(msg.chatId) ?? msg.from?.displayName ?? null;
  return {
    id: msg.id,
    source: 'teams',
    title,
    participants: msg.from?.displayName ? [msg.from.displayName] : [],
    occurredAt: msg.createdDateTime,
    bodyText: (msg.summary ?? '').trim(),
  };
}

/**
 * Fetches chat messages sent since `sinceIso` across every chat the user is
 * a member of, paginating via the shared paginateConnectorTool() helper
 * (claudeConnectorCli.ts).
 *
 * `query` is required by the tool schema (minLength 1) with no real
 * match-everything wildcard support — a literal '*' was observed causing a
 * Graph API 400 BadRequest in production (Graph's search parser rejects it
 * as invalid KQL rather than treating it as glob-all). With afterDateTime
 * set, the connector matches `query` as a plain literal substring (per-chat
 * scan path, not full-text search), so a single space is a safe stand-in
 * that satisfies the schema without any special-character parsing — nearly
 * every real chat message contains at least one space.
 */
export async function fetchRecentTeamsMessages(sinceIso: string): Promise<ConnectorChatMessage[]> {
  return paginateConnectorTool<ConnectorChatMessage>({
    tool: 'chat_message_search',
    args: { query: ' ', afterDateTime: sinceIso, limit: PAGE_LIMIT },
  });
}

export interface TeamsSyncResult {
  messageCount: number;
}

/**
 * Pulls recent Teams chat messages via the Microsoft 365 Claude connector
 * and upserts raw rows into external_messages — replaces the old headless-
 * Chromium DOM scrape (teamsPlaywright.ts, deleted). Read-only, same as the
 * connector's coverage generally: no Teams send tool exists (write-gated,
 * unavailable), so replies stay exactly as they already are — a manual
 * copy-paste draft (src/drafts/kinds/teamsReplyDraft.ts), unaffected by this.
 */
export async function syncTeamsMessages(): Promise<TeamsSyncResult> {
  const sinceIso = new Date(Date.now() - config.teamsSyncLookbackHours * 60 * 60_000).toISOString();
  const [messages, chatTitles] = await Promise.all([fetchRecentTeamsMessages(sinceIso), fetchChatTitles()]);
  for (const msg of messages) upsertExternalMessage(mapTeamsMessageToExternalMessage(msg, chatTitles));
  return { messageCount: messages.length };
}
