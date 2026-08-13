import { config } from '../config';
import { getGeminiClient } from '../gemini/geminiClient';
import { logGeminiUsage } from '../gemini/logUsage';
import { ActionItem } from '../storage/summaryRepository';

/**
 * Shared by every suggestXFields() below — each is a one-off Gemini call
 * that turns an action item's free-text description into fields for one
 * external tool's dialog, fired when that dialog opens (src/interface/
 * server.ts's /suggest routes). Same cost-tiering convention as chapters.ts/
 * analyzeConversation.ts (mechanical extraction from short text already in
 * hand → fast model, thinking mostly off). Only the prompt intro, schema,
 * and fallback-shaping differ per tool — pulled out once here instead of
 * repeating the guard/prompt-suffix/call/log/parse shape five times.
 */
async function draftFields<T>(logLabel: string, promptIntro: string, item: ActionItem, schema: object, shape: (parsed: any) => T): Promise<T> {
  if (!config.geminiApiKey) throw new Error('GEMINI_API_KEY is not configured — see NOTES.md.');

  const prompt = `${promptIntro}

Action item: ${JSON.stringify(item.description)}
Owner: ${item.owner ?? 'unspecified'}
Due date: ${item.dueDate ?? 'unspecified'}`;

  const response = await getGeminiClient().models.generateContent({
    model: config.geminiFastModel,
    contents: prompt,
    config: { responseMimeType: 'application/json', responseSchema: schema, thinkingConfig: { thinkingBudget: 1 } },
  });
  logGeminiUsage(logLabel, response);

  const parsed = JSON.parse(response.text ?? '{}');
  return shape(parsed);
}

export interface JiraFieldSuggestion {
  issueType: string;
  summary: string;
  description: string;
  transition: string | null;
  comment: string;
}

const JIRA_PROMPT_INTRO = `You are helping turn a meeting action item into a Jira issue update. The action item may
describe brand-new work, or may be about changing an existing issue's status (issue keys, if any, are
already named directly in the text).`;

const JIRA_SCHEMA = {
  type: 'object',
  properties: {
    issueType: { type: 'string', description: 'The most fitting Jira issue type: Task, Bug, Story, Epic, or Subtask.' },
    summary: { type: 'string', description: 'A concise, professional Jira issue title (under 100 characters) — not just the raw sentence.' },
    description: { type: 'string', description: "A clear, well-formatted issue description in Markdown, expanding on the action item's context without inventing facts it doesn't imply." },
    transition: {
      type: 'string',
      nullable: true,
      description: 'If this action item is about changing an EXISTING issue\'s status (e.g. "mark as done", "move to in progress"), the target status name (e.g. "In Progress", "Done", "To Do") — otherwise null.',
    },
    comment: { type: 'string', description: 'A short comment to add to an existing issue, summarizing this action item — meaningful whether or not this turns out to be about an existing issue.' },
  },
  required: ['issueType', 'summary', 'description', 'comment'],
};

/**
 * Never decides create-vs-update mode itself — that's still driven by the
 * deterministic issue-key regex in jiraMcp.ts/index.html, and the user can
 * always override the dialog's mode toggle regardless of what this suggests.
 */
export function suggestJiraFields(item: ActionItem): Promise<JiraFieldSuggestion> {
  return draftFields('suggestJiraFields', JIRA_PROMPT_INTRO, item, JIRA_SCHEMA, (parsed) => ({
    issueType: parsed.issueType || 'Task',
    summary: parsed.summary || item.description,
    description: parsed.description || '',
    transition: parsed.transition || null,
    comment: parsed.comment || item.description,
  }));
}

export interface ConfluenceFieldSuggestion {
  title: string;
  content: string;
}

const CONFLUENCE_PROMPT_INTRO = 'You are helping turn a meeting action item into a Confluence page. Draft a title and a\ndocumentation-worthy body from it.';

const CONFLUENCE_SCHEMA = {
  type: 'object',
  properties: {
    title: { type: 'string', description: 'A concise Confluence page title (under 100 characters).' },
    content: { type: 'string', description: "The page body in Markdown, expanding on the action item's context into something worth documenting, without inventing facts it doesn't imply." },
  },
  required: ['title', 'content'],
};

export function suggestConfluenceFields(item: ActionItem): Promise<ConfluenceFieldSuggestion> {
  return draftFields('suggestConfluenceFields', CONFLUENCE_PROMPT_INTRO, item, CONFLUENCE_SCHEMA, (parsed) => ({
    title: parsed.title || item.description.slice(0, 100),
    content: parsed.content || item.description,
  }));
}

export interface EmailFieldSuggestion {
  subject: string;
  body: string;
}

const EMAIL_PROMPT_INTRO = 'You are helping turn a meeting action item into an email draft.';

const EMAIL_SCHEMA = {
  type: 'object',
  properties: {
    subject: { type: 'string', description: 'A concise email subject line (under 80 characters).' },
    body: { type: 'string', description: "A short, professional plain-text email body drafted from the action item — a real message a recipient could act on, not just the raw sentence restated. Don't invent a recipient name or sign-off if it isn't implied." },
  },
  required: ['subject', 'body'],
};

/** The drafted subject/body still open in the user's own mail client (mailto:) for them to review, address, and send themselves. */
export function suggestEmailFields(item: ActionItem): Promise<EmailFieldSuggestion> {
  return draftFields('suggestEmailFields', EMAIL_PROMPT_INTRO, item, EMAIL_SCHEMA, (parsed) => ({
    subject: parsed.subject || item.description.slice(0, 80),
    body: parsed.body || item.description,
  }));
}

export interface TeamsMessageFieldSuggestion {
  message: string;
}

const TEAMS_MESSAGE_PROMPT_INTRO = 'You are helping turn a meeting action item into a short Teams chat message.';

const TEAMS_MESSAGE_SCHEMA = {
  type: 'object',
  properties: {
    message: { type: 'string', description: 'A short, casual chat message (not an email — a sentence or two, the way a real Teams message reads) drafted from the action item.' },
  },
  required: ['message'],
};

/** The drafted message still opens in Teams' own compose UI for the user to pick a recipient/channel and send themselves. */
export function suggestTeamsMessageFields(item: ActionItem): Promise<TeamsMessageFieldSuggestion> {
  return draftFields('suggestTeamsMessageFields', TEAMS_MESSAGE_PROMPT_INTRO, item, TEAMS_MESSAGE_SCHEMA, (parsed) => ({
    message: parsed.message || item.description,
  }));
}

export interface ScheduleMeetingFieldSuggestion {
  title: string;
  details: string;
}

const SCHEDULE_MEETING_PROMPT_INTRO = 'You are helping turn a meeting action item into a follow-up calendar event.';

const SCHEDULE_MEETING_SCHEMA = {
  type: 'object',
  properties: {
    title: { type: 'string', description: 'A concise calendar event title (under 80 characters).' },
    details: { type: 'string', description: "A short event description giving whoever's invited enough context for why this meeting exists, drafted from the action item." },
  },
  required: ['title', 'details'],
};

/** Opens Google Calendar's own prefilled create-event screen for the user to set attendees/time and create it themselves. */
export function suggestScheduleMeetingFields(item: ActionItem): Promise<ScheduleMeetingFieldSuggestion> {
  return draftFields('suggestScheduleMeetingFields', SCHEDULE_MEETING_PROMPT_INTRO, item, SCHEDULE_MEETING_SCHEMA, (parsed) => ({
    title: parsed.title || item.description.slice(0, 80),
    details: parsed.details || item.description,
  }));
}
