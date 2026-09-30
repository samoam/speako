import { db } from '../storage/db';
import { generateJson } from '../ai/aiRouter';
import { ExternalMessage } from '../storage/externalMessageRepository';
import { askJev, isJevConfigured, jevChoice, jevTrue, URGENCY_QUESTION, URGENCY_SIGNALS } from '../integrations/typesafeJev';

/**
 * Untriaged inbox email — unlike Teams (a multi-person chat log where "is
 * this at me" has to be inferred), every row here already IS the user's own
 * mail (sync only ever reads /me/mailFolders/inbox, never Sent Items), so
 * there's no identity detection step: the question is just whether it needs
 * a reply, not whether it's "theirs."
 */
export function getUntriagedEmailMessages(): ExternalMessage[] {
  const rows = db
    .prepare(
      `SELECT em.* FROM external_messages em
       LEFT JOIN email_message_triage t ON t.message_id = em.id
       WHERE em.source = 'email' AND t.message_id IS NULL`
    )
    .all() as any[];
  return rows.map((r) => ({
    id: r.id,
    source: r.source,
    title: r.title,
    participants: r.participants ? JSON.parse(r.participants) : [],
    occurredAt: r.occurred_at,
    bodyText: r.body_text,
  }));
}

export type MessageUrgencySignal = 'none' | 'soon' | 'urgent';

export interface EmailMessageClassification {
  needsReply: boolean;
  summary: string;
  draftReply: string | null;
  urgencySignal: MessageUrgencySignal;
}

const CLASSIFY_SCHEMA = {
  type: 'object',
  properties: {
    needsReply: {
      type: 'boolean',
      description: 'True if this email is asking the reader something or otherwise expects a response from them. False for FYI notifications, newsletters, automated alerts, or anything not expecting a reply.',
    },
    summary: { type: 'string', description: 'One or two sentences capturing what the reader needs to know from this email.' },
    draftReply: {
      type: 'string',
      nullable: true,
      description: 'Only when needsReply is true: a short, professional draft reply. Null otherwise.',
    },
    urgencySignal: {
      type: 'string',
      enum: ['none', 'soon', 'urgent'],
      description:
        '"urgent" if the email explicitly demands fast action (words like ASAP/urgent/blocking, or a same-day deadline/escalation tone). "soon" if there is a clear but not-immediate deadline or expectation (e.g. "by end of week"). "none" otherwise.',
    },
  },
  required: ['needsReply', 'summary', 'urgencySignal'],
};

/**
 * One Gemini call per email — same shape as src/summarization/
 * actionItemDrafts.ts's draftFields() and teamsMessageTriage.ts's
 * classifyMessage() (fast model, thinking mostly off, structured JSON).
 */
export async function classifyWithJev(message: ExternalMessage): Promise<{ needsReply: boolean; urgencySignal: MessageUrgencySignal } | null> {
  if (!isJevConfigured()) return null;
  try {
    const answers = await askJev(`Subject: ${message.title ?? 'No subject'}\nFrom: ${message.participants[0] ?? 'Unknown'}\n\n${message.bodyText}`, {
      needsReply: {
        type: 'noul',
        instructions: 'This email asks the reader something or otherwise expects a response from them (not an FYI, newsletter, notification, or automated alert).',
      },
      urgency: URGENCY_QUESTION,
    }, 'classifyEmailMessage');
    const needsReply = jevTrue(answers.needsReply);
    const urgencySignal = jevChoice(answers.urgency, URGENCY_SIGNALS);
    if (needsReply === null || urgencySignal === null) return null;
    return { needsReply, urgencySignal };
  } catch (err: any) {
    console.error('[email-triage] Jev classification failed, falling back to Gemini:', err.message);
    return null;
  }
}

export async function classifyMessage(message: ExternalMessage): Promise<EmailMessageClassification> {
  // Jev owns the two decisions when it answers; the prose (summary, draft) Jev
  // can't write goes through the AI router (Claude first, Gemini failover),
  // which also decides alone when Jev is unavailable.
  const jev = await classifyWithJev(message);
  try {
    const decided = jev
      ? `\n\nIt has already been decided that this email ${jev.needsReply ? 'DOES' : 'does NOT'} need a reply — use that as needsReply.`
      : '';
    const prompt = `You are triaging an inbox email.

Subject: ${message.title ?? 'No subject'}
From: ${message.participants[0] ?? 'Unknown'}
Body: ${JSON.stringify(message.bodyText)}

Decide whether this email needs a reply (a question, request, or anything expecting a response) versus is purely
informational (a notification, newsletter, automated alert, FYI). Summarize what the reader needs to know, and if
it needs a reply, draft a short, professional response.${decided}`;

    const parsed = await generateJson<any>('triageProse', 'classifyEmailMessage', prompt, CLASSIFY_SCHEMA);
    const needsReply = jev?.needsReply ?? !!parsed.needsReply;
    const urgencySignal: MessageUrgencySignal = jev?.urgencySignal ?? (['none', 'soon', 'urgent'].includes(parsed.urgencySignal) ? parsed.urgencySignal : 'none');
    return {
      needsReply,
      summary: parsed.summary || message.bodyText.slice(0, 200),
      draftReply: needsReply ? parsed.draftReply || null : null,
      urgencySignal,
    };
  } catch {
    // Never let a bad/missing LLM response block the rest of the batch —
    // same convention as actionItemDrafts.ts/teamsMessageTriage.ts.
    return { needsReply: jev?.needsReply ?? false, summary: message.bodyText.slice(0, 200), draftReply: null, urgencySignal: jev?.urgencySignal ?? 'none' };
  }
}

const insertTriageStmt = db.prepare(`
  INSERT INTO email_message_triage (message_id, needs_reply, summary, draft_reply, urgency_signal)
  VALUES (@messageId, @needsReply, @summary, @draftReply, @urgencySignal)
  ON CONFLICT(message_id) DO UPDATE SET
    needs_reply = excluded.needs_reply,
    summary = excluded.summary,
    draft_reply = excluded.draft_reply,
    urgency_signal = excluded.urgency_signal
`);

/**
 * Classifies every not-yet-triaged inbox email and stores the result —
 * called after each email sync (via the Microsoft 365 connector), same
 * "chain triage onto the end of the sync that just ran" convention as
 * Teams' runTeamsSync(). One message failing never blocks the rest
 * (per-item try/catch inside classifyMessage() itself).
 */
export async function runEmailTriage(): Promise<{ triaged: number }> {
  const messages = getUntriagedEmailMessages();
  let triaged = 0;
  for (const message of messages) {
    try {
      const result = await classifyMessage(message);
      insertTriageStmt.run({
        messageId: message.id,
        needsReply: result.needsReply ? 1 : 0,
        summary: result.summary,
        draftReply: result.draftReply,
        urgencySignal: result.urgencySignal,
      });
      triaged++;
    } catch (err: any) {
      console.error('[email-triage] failed to triage a message:', err.message);
    }
  }
  return { triaged };
}
