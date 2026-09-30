import { db } from '../storage/db';
import { generateJson } from '../ai/aiRouter';
import { ExternalMessage } from '../storage/externalMessageRepository';
import { askJev, isJevConfigured, jevChoice, jevTrue, URGENCY_QUESTION, URGENCY_SIGNALS } from '../integrations/typesafeJev';

/**
 * Who "me" is, inferred from data already collected rather than a config
 * value or new DOM-scraping — the account owner is the only sender who
 * appears across nearly every synced chat (their own 1:1s plus every group
 * they're in), so whichever sender has the most distinct chat titles is "me."
 * Returns null (caller skips this run) rather than guessing when there's not
 * enough data yet (e.g. right after the very first sync).
 */
export function detectMyTeamsDisplayName(): string | null {
  const rows = db.prepare(`SELECT title, participants FROM external_messages WHERE source = 'teams'`).all() as any[];
  const chatsBySender = new Map<string, Set<string>>();
  for (const row of rows) {
    if (!row.title) continue;
    const participants: string[] = row.participants ? JSON.parse(row.participants) : [];
    const sender = participants[0];
    if (!sender) continue;
    if (!chatsBySender.has(sender)) chatsBySender.set(sender, new Set());
    chatsBySender.get(sender)!.add(row.title);
  }

  let best: string | null = null;
  let bestCount = 0;
  for (const [sender, chats] of chatsBySender) {
    if (chats.size > bestCount) {
      bestCount = chats.size;
      best = sender;
    }
  }
  return best;
}

/** Teams messages not yet triaged, excluding the user's own outgoing messages (nothing to triage there). */
export function getUntriagedTeamsMessages(myName: string): ExternalMessage[] {
  const rows = db
    .prepare(
      `SELECT em.* FROM external_messages em
       LEFT JOIN teams_message_triage t ON t.message_id = em.id
       WHERE em.source = 'teams' AND t.message_id IS NULL`
    )
    .all() as any[];
  return rows
    .map((r) => ({
      id: r.id,
      source: r.source,
      title: r.title,
      participants: r.participants ? JSON.parse(r.participants) : [],
      occurredAt: r.occurred_at,
      bodyText: r.body_text,
    }))
    .filter((m) => m.participants[0] !== myName);
}

export type MessageUrgencySignal = 'none' | 'soon' | 'urgent';

export interface TeamsMessageClassification {
  directedAtMe: boolean;
  summary: string;
  draftReply: string | null;
  urgencySignal: MessageUrgencySignal;
}

const CLASSIFY_SCHEMA = {
  type: 'object',
  properties: {
    directedAtMe: {
      type: 'boolean',
      description:
        'True if this message is a 1:1 direct message to the reader, explicitly asks them something, or @mentions them by name. False for general group/channel chatter not aimed at them specifically.',
    },
    summary: { type: 'string', description: 'One or two sentences capturing what the reader needs to know from this message.' },
    draftReply: {
      type: 'string',
      nullable: true,
      description: 'Only when directedAtMe is true: a short, casual draft reply (a sentence or two, the way a real Teams message reads). Null otherwise.',
    },
    urgencySignal: {
      type: 'string',
      enum: ['none', 'soon', 'urgent'],
      description:
        '"urgent" if the message explicitly demands fast action (words like ASAP/urgent/blocking, or a same-day deadline/escalation tone). "soon" if there is a clear but not-immediate deadline or expectation. "none" otherwise.',
    },
  },
  required: ['directedAtMe', 'summary', 'urgencySignal'],
};

/**
 * One Gemini call per message — same shape as src/summarization/
 * actionItemDrafts.ts's draftFields() (fast model, thinking mostly off,
 * structured JSON output), since this is the same kind of mechanical
 * extraction from short text already in hand.
 */
export async function classifyWithJev(message: ExternalMessage, myName: string): Promise<{ directedAtMe: boolean; urgencySignal: MessageUrgencySignal } | null> {
  if (!isJevConfigured()) return null;
  try {
    const answers = await askJev(`Reader: ${myName}\nChat: ${message.title ?? 'Unknown chat'}\nSender: ${message.participants[0] ?? 'Unknown'}\n\n${message.bodyText}`, {
      directedAtMe: {
        type: 'noul',
        instructions: `This message is aimed at ${myName} specifically: a 1:1 direct message to them, a question asked of them, or an @mention of them — not general group chatter.`,
      },
      urgency: URGENCY_QUESTION,
    }, 'classifyTeamsMessage');
    const directedAtMe = jevTrue(answers.directedAtMe);
    const urgencySignal = jevChoice(answers.urgency, URGENCY_SIGNALS);
    if (directedAtMe === null || urgencySignal === null) return null;
    return { directedAtMe, urgencySignal };
  } catch (err: any) {
    console.error('[teams-triage] Jev classification failed, falling back to Gemini:', err.message);
    return null;
  }
}

export async function classifyMessage(message: ExternalMessage, myName: string): Promise<TeamsMessageClassification> {
  // Same split as emailTriage.ts's classifyMessage: Jev decides, the AI router writes.
  const jev = await classifyWithJev(message, myName);
  try {
    const prompt = `You are triaging a Microsoft Teams message for "${myName}", who is reading it.

Chat: ${message.title ?? 'Unknown chat'}
Sender: ${message.participants[0] ?? 'Unknown'}
Message: ${JSON.stringify(message.bodyText)}

Decide whether this message is directed at ${myName} specifically (a 1:1 DM, a direct question, or an @mention of them)
versus general group/channel chatter they should just be aware of. Summarize what they need to know, and if it's
directed at them, draft a short reply they could send back.${
      jev ? `\n\nIt has already been decided that this message ${jev.directedAtMe ? 'IS' : 'is NOT'} directed at ${myName} — use that as directedAtMe.` : ''
    }`;

    const parsed = await generateJson<any>('triageProse', 'classifyTeamsMessage', prompt, CLASSIFY_SCHEMA);
    const directedAtMe = jev?.directedAtMe ?? !!parsed.directedAtMe;
    const urgencySignal: MessageUrgencySignal = jev?.urgencySignal ?? (['none', 'soon', 'urgent'].includes(parsed.urgencySignal) ? parsed.urgencySignal : 'none');
    return {
      directedAtMe,
      summary: parsed.summary || message.bodyText.slice(0, 200),
      draftReply: directedAtMe ? parsed.draftReply || null : null,
      urgencySignal,
    };
  } catch {
    // Never let a bad/missing LLM response block the rest of the batch —
    // same "never crash on a malformed response" convention as
    // actionItemDrafts.ts's fallback-shaping.
    return { directedAtMe: jev?.directedAtMe ?? false, summary: message.bodyText.slice(0, 200), draftReply: null, urgencySignal: jev?.urgencySignal ?? 'none' };
  }
}

const insertTriageStmt = db.prepare(`
  INSERT INTO teams_message_triage (message_id, directed_at_me, summary, draft_reply, urgency_signal)
  VALUES (@messageId, @directedAtMe, @summary, @draftReply, @urgencySignal)
  ON CONFLICT(message_id) DO UPDATE SET
    directed_at_me = excluded.directed_at_me,
    summary = excluded.summary,
    draft_reply = excluded.draft_reply,
    urgency_signal = excluded.urgency_signal
`);

/**
 * Classifies every not-yet-triaged Teams message and stores the result —
 * called after each Teams sync (src/interface/server.ts's
 * runTeamsSync()), both from the manual "Sync now" button and the
 * background poll timer. One message failing classification never
 * blocks the rest (per-item try/catch inside classifyMessage() itself).
 */
export async function runTeamsMessageTriage(): Promise<{ triaged: number }> {
  const myName = detectMyTeamsDisplayName();
  if (!myName) return { triaged: 0 };

  const messages = getUntriagedTeamsMessages(myName);
  let triaged = 0;
  for (const message of messages) {
    try {
      const result = await classifyMessage(message, myName);
      insertTriageStmt.run({
        messageId: message.id,
        directedAtMe: result.directedAtMe ? 1 : 0,
        summary: result.summary,
        draftReply: result.draftReply,
        urgencySignal: result.urgencySignal,
      });
      triaged++;
    } catch (err: any) {
      console.error('[teams-triage] failed to triage a message:', err.message);
    }
  }
  return { triaged };
}
