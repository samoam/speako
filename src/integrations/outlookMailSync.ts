import { paginateConnectorTool } from './claudeConnectorCli';
import { upsertExternalMessage } from '../storage/externalMessageRepository';
import { config } from '../config';

const PAGE_LIMIT = 25;

export interface ConnectorEmail {
  id: string;
  subject?: string;
  sender?: string;
  recipients?: string[];
  receivedDateTime: string;
  summary?: string;
}

export function mapEmailToExternalMessage(email: ConnectorEmail): { id: string; source: 'email'; title: string | null; participants: string[]; occurredAt: string; bodyText: string } {
  const participants = [email.sender, ...(email.recipients ?? [])].filter((p): p is string => !!p);
  return {
    id: email.id,
    source: 'email',
    title: email.subject ?? null,
    participants,
    occurredAt: email.receivedDateTime,
    bodyText: (email.summary ?? '').trim(),
  };
}

/**
 * Fetches inbox messages received since `sinceIso`, paginating via the
 * shared paginateConnectorTool() helper (claudeConnectorCli.ts). `summary`
 * is already a plain-text preview (confirmed against real inbox data), so
 * no HTML-stripping step is needed the way the old Graph-based body.content
 * field required.
 */
export async function fetchRecentEmails(sinceIso: string): Promise<ConnectorEmail[]> {
  return paginateConnectorTool<ConnectorEmail>({
    tool: 'outlook_email_search',
    args: { afterDateTime: sinceIso, order: 'newest', limit: PAGE_LIMIT },
  });
}

export interface EmailSyncResult {
  emailCount: number;
}

/**
 * Pulls recent Outlook mail via the Microsoft 365 Claude connector and
 * upserts raw rows into external_messages — the same table/contract the
 * external daily-agent path (docs/EXTERNAL_INGESTION_PROMPT.md) writes to,
 * so the existing "Index communications" chunk/embed step
 * (src/communications/indexExternalMessages.ts) needs no changes to pick
 * these up. Teams chat sync is a separate module (teamsConnectorSync.ts) —
 * same connector, different tool (chat_message_search vs. outlook_email_search).
 */
export async function syncOutlookMail(): Promise<EmailSyncResult> {
  const sinceIso = new Date(Date.now() - config.emailSyncLookbackHours * 60 * 60_000).toISOString();
  const emails = await fetchRecentEmails(sinceIso);
  for (const email of emails) upsertExternalMessage(mapEmailToExternalMessage(email));
  return { emailCount: emails.length };
}
