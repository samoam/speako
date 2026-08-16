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
 */
async function fetchChatTitles(): Promise<Map<string, string | null>> {
  const chats = await paginateConnectorTool<ConnectorChat>({ tool: 'teams_list_chats', args: { limit: PAGE_LIMIT }, paging: 'cursor' });
  return new Map(chats.map((chat) => [chat.id, chat.topic ?? null]));
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
