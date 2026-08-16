import { config } from '../config';
import { getGeminiClient } from '../gemini/geminiClient';
import { logGeminiUsage } from '../gemini/logUsage';
import { getTasksCreatedSince, Task, TaskSource } from '../storage/taskRepository';

const SOURCE_LABELS: Record<TaskSource, string> = {
  jira: 'Jira ticket',
  bitbucket_pr: 'PR review',
  action_item: 'action item',
  teams_message: 'Teams message',
  email_message: 'email',
  jenkins_build: 'Jenkins build',
};

function startOfTodayIso(): string {
  const now = new Date();
  now.setHours(0, 0, 0, 0);
  return now.toISOString();
}

function groupBySource(tasks: Task[]): Partial<Record<TaskSource, Task[]>> {
  const groups: Partial<Record<TaskSource, Task[]>> = {};
  for (const task of tasks) {
    (groups[task.source] ??= []).push(task);
  }
  return groups;
}

const NOTHING_NEW = 'Nothing new since yesterday — the queue is quiet this morning.';

function plainSummary(tasks: Task[]): string {
  if (!tasks.length) return NOTHING_NEW;
  const groups = groupBySource(tasks);
  const parts = Object.entries(groups).map(([source, items]) => `${items!.length} new ${SOURCE_LABELS[source as TaskSource]}${items!.length === 1 ? '' : 's'}`);
  return `${parts.join(', ')}.`;
}

const BRIEFING_SCHEMA = {
  type: 'object',
  properties: {
    briefing: {
      type: 'string',
      description: 'A few-sentence natural-language morning digest of what is new, grouped sensibly by urgency/source. Mention counts and the most important items by name, not just a raw list.',
    },
  },
  required: ['briefing'],
};

/**
 * The morning digest — pulled from tasks.created_at (the only "genuinely
 * new" signal that exists; see taskRepository.ts's getTasksCreatedSince)
 * since local midnight. Falls back to a plain templated count-by-source
 * summary when Gemini isn't configured, same fallback convention as
 * actionItemDrafts.ts's suggest*Fields functions.
 */
export async function buildMorningBriefing(): Promise<string> {
  const tasks = getTasksCreatedSince(startOfTodayIso());
  if (!tasks.length) return NOTHING_NEW;
  if (!config.geminiApiKey) return plainSummary(tasks);

  const lines = tasks.slice(0, 30).map((t) => `- [${SOURCE_LABELS[t.source]}] ${t.title} (priority ${t.priorityScore})`);
  const prompt = `You are writing a short morning briefing for a developer, summarizing what's new in their work queue since yesterday.

New items today:
${lines.join('\n')}

Write a few sentences highlighting counts by category and calling out the most urgent/important items by name. Be concise — this is read at a glance, not a report.`;

  const response = await getGeminiClient().models.generateContent({
    model: config.geminiFastModel,
    contents: prompt,
    config: { responseMimeType: 'application/json', responseSchema: BRIEFING_SCHEMA, thinkingConfig: { thinkingBudget: 1 } },
  });
  logGeminiUsage('buildMorningBriefing', response);
  const parsed = JSON.parse(response.text ?? '{}');
  return parsed.briefing || plainSummary(tasks);
}
