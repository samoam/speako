import { getGraphAccessToken, isMsGraphConfigured } from './msGraphAuth';
import { upsertExternalMessage } from '../storage/externalMessageRepository';
import { config } from '../config';

const GRAPH_BASE = 'https://graph.microsoft.com/v1.0';
const REQUEST_TIMEOUT_MS = 15_000;

async function graphGet(url: string, accessToken: string): Promise<any> {
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${accessToken}` },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Microsoft Graph request failed: ${res.status} ${res.statusText} — ${url}\n${body}`);
  }
  return res.json();
}

/**
 * Crude HTML-to-plain-text: strips tags/entities well enough for search
 * purposes without pulling in a full HTML parser dependency (no existing
 * precedent for one in this codebase — see EXTERNAL_INGESTION_PROMPT.md's
 * "strip HTML markup" instruction for the same requirement on the manual
 * ingestion path). Not meant to be pixel-perfect, just noise-free enough for
 * chunking/embedding.
 */
export function htmlToPlainText(html: string): string {
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|tr|li)>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export interface GraphEmail {
  id: string;
  subject?: string;
  receivedDateTime: string;
  from?: { emailAddress?: { address?: string; name?: string } };
  toRecipients?: { emailAddress?: { address?: string; name?: string } }[];
  body?: { contentType?: string; content?: string };
  bodyPreview?: string;
}

export function mapEmailToExternalMessage(email: GraphEmail): { id: string; source: 'email'; title: string | null; participants: string[]; occurredAt: string; bodyText: string } {
  const participants = [email.from?.emailAddress?.address, ...(email.toRecipients ?? []).map((r) => r.emailAddress?.address)].filter(
    (p): p is string => !!p
  );
  const rawBody = email.body?.content ?? email.bodyPreview ?? '';
  const bodyText = email.body?.contentType === 'html' ? htmlToPlainText(rawBody) : rawBody.trim();
  return {
    id: email.id,
    source: 'email',
    title: email.subject ?? null,
    participants,
    occurredAt: email.receivedDateTime,
    bodyText,
  };
}

/** Fetches Outlook inbox messages received since `sinceIso`, following @odata.nextLink pages fully. */
export async function fetchRecentEmails(sinceIso: string, accessToken: string): Promise<GraphEmail[]> {
  const select = 'id,subject,receivedDateTime,from,toRecipients,body';
  let url: string | null =
    `${GRAPH_BASE}/me/mailFolders/inbox/messages?$filter=receivedDateTime ge ${sinceIso}&$select=${select}&$top=50&$orderby=receivedDateTime desc`;
  const emails: GraphEmail[] = [];
  while (url) {
    const page: any = await graphGet(url, accessToken);
    emails.push(...(page.value ?? []));
    url = page['@odata.nextLink'] ?? null;
  }
  return emails;
}

export interface GraphChat {
  id: string;
  topic?: string | null;
  chatType?: string;
  members?: { displayName?: string }[];
}

export interface GraphChatMessage {
  id: string;
  chatId: string;
  chatTopic?: string | null;
  createdDateTime: string;
  from?: { user?: { displayName?: string } };
  body?: { contentType?: string; content?: string };
}

export function mapChatMessageToExternalMessage(msg: GraphChatMessage): { id: string; source: 'teams'; title: string | null; participants: string[]; occurredAt: string; bodyText: string } {
  const rawBody = msg.body?.content ?? '';
  const bodyText = msg.body?.contentType === 'html' ? htmlToPlainText(rawBody) : rawBody.trim();
  return {
    // Namespaced by chat id since Graph message ids are only unique within a chat.
    id: `${msg.chatId}:${msg.id}`,
    source: 'teams',
    title: msg.chatTopic ?? null,
    participants: msg.from?.user?.displayName ? [msg.from.user.displayName] : [],
    occurredAt: msg.createdDateTime,
    bodyText,
  };
}

/**
 * Fetches recent messages across the user's 1:1/group chats. Scoped to Chat.Read
 * (not ChannelMessage.Read.All — see config.ts's msGraph* comment on why:
 * channel messages need tenant-admin consent in most orgs, chats don't).
 * The /chats/{id}/messages endpoint doesn't support server-side date
 * filtering, so this fetches the most recent page per chat (newest first) and
 * filters/stops client-side once messages fall before sinceIso — a chat with
 * more than $top unread-since-cutoff messages in one poll window would miss
 * the overflow, an accepted tradeoff for a 15-minute-default poll cadence.
 */
export async function fetchRecentChatMessages(sinceIso: string, accessToken: string): Promise<GraphChatMessage[]> {
  const sinceMs = new Date(sinceIso).getTime();
  const chatsPage: any = await graphGet(`${GRAPH_BASE}/me/chats?$top=50`, accessToken);
  const chats: GraphChat[] = chatsPage.value ?? [];

  const results: GraphChatMessage[] = [];
  for (const chat of chats) {
    try {
      const page: any = await graphGet(`${GRAPH_BASE}/chats/${chat.id}/messages?$top=50`, accessToken);
      for (const raw of page.value ?? []) {
        if (new Date(raw.createdDateTime).getTime() < sinceMs) continue;
        if (!raw.body?.content) continue; // system events (member added, etc.) have no body worth indexing
        results.push({ ...raw, chatId: chat.id, chatTopic: chat.topic ?? null });
      }
    } catch (err: any) {
      console.error(`[msgraph] failed to fetch messages for chat ${chat.id}:`, err.message);
    }
  }
  return results;
}

export interface MsGraphSyncResult {
  emailCount: number;
  chatMessageCount: number;
}

/**
 * Pulls recent Outlook + Teams activity and upserts raw rows into
 * external_messages — the same table/contract the external daily-agent path
 * (docs/EXTERNAL_INGESTION_PROMPT.md) writes to, so the existing "Index
 * communications" chunk/embed step (src/communications/indexExternalMessages.ts)
 * needs no changes to pick these up. Each source is fetched independently so
 * one failing doesn't block the other (matches bitbucketServer.ts's
 * per-repo try/catch convention).
 */
export async function syncOutlookAndTeams(): Promise<MsGraphSyncResult> {
  if (!isMsGraphConfigured()) {
    throw new Error('Microsoft Graph is not configured — run `npm run msgraph-auth` first (see NOTES.md).');
  }
  const accessToken = await getGraphAccessToken();
  const sinceIso = new Date(Date.now() - config.msGraphLookbackHours * 60 * 60_000).toISOString();

  let emailCount = 0;
  try {
    const emails = await fetchRecentEmails(sinceIso, accessToken);
    for (const email of emails) upsertExternalMessage(mapEmailToExternalMessage(email));
    emailCount = emails.length;
  } catch (err: any) {
    console.error('[msgraph] email sync failed:', err.message);
  }

  let chatMessageCount = 0;
  try {
    const messages = await fetchRecentChatMessages(sinceIso, accessToken);
    for (const msg of messages) upsertExternalMessage(mapChatMessageToExternalMessage(msg));
    chatMessageCount = messages.length;
  } catch (err: any) {
    console.error('[msgraph] Teams chat sync failed:', err.message);
  }

  return { emailCount, chatMessageCount };
}
