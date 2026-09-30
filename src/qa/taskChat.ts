import { generateText } from '../ai/aiRouter';
import { Task } from '../storage/taskRepository';
import { TaskChatMessage } from '../storage/taskChatRepository';
import { getExternalMessageById } from '../storage/externalMessageRepository';
import { gatherReplyContext } from '../drafts/kinds/replyContextGathering';
import { buildMessageBlock } from '../drafts/kinds/replyDraftShared';

function buildHistoryBlock(history: TaskChatMessage[]): string {
  if (!history.length) return '(no prior discussion yet)';
  return history.map((m) => `${m.role === 'user' ? 'User' : 'Assistant'}: ${m.text}`).join('\n');
}

/**
 * Answers one free-form question in a task's "discuss this task" chat
 * (src/interface/public/index.html's Task Detail right-hand panel) —
 * distinct from src/drafts/kinds/replyDraftShared.ts's generateReplyDraft,
 * which drafts a reply TO SEND through the approve-gate lifecycle. This
 * just answers, grounded in the same tool-fanout context reply drafting
 * already gets (gatherReplyContext, with the question driving the query
 * instead of the message/task text) plus the conversation so far — no
 * draft/clarify envelope, no persistence beyond the caller's own
 * appendTaskChatMessage calls.
 */
export async function answerTaskChatQuestion(task: Task, question: string, history: TaskChatMessage[]): Promise<string> {
  let message;
  try {
    message = getExternalMessageById(task.externalRef);
  } catch {
    message = undefined;
  }
  const gatheredContext = await gatherReplyContext(message, task, { queryOverride: question });

  const prompt = [
    `You are helping the user understand and discuss a task on their Dashboard — you are NOT drafting a reply to send, just answering questions about it.`,
    `Task: ${task.title}`,
    task.description ? `Description: ${task.description}` : '',
    buildMessageBlock(task, message),
    `Context gathered from Speako's connected tools (Jira, Confluence, mem0, RAG, code search, Bitbucket, Jenkins, past Teams/email history, past meetings, web search — some may be empty if nothing relevant was found):\n${gatheredContext}`,
    `Conversation so far:\n${buildHistoryBlock(history)}`,
    `The user's newest question: ${JSON.stringify(question)}`,
    `Answer directly and concisely, grounded in the task and the gathered context above. If you don't know, say so — don't invent details.`,
  ]
    .filter(Boolean)
    .join('\n\n');

  return (await generateText('chat', 'answerTaskChatQuestion', prompt)) || "I don't have anything more specific to add.";
}
