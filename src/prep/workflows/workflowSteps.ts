import { MeetingType } from '../meetingTypes';
import { ToolKey } from '../../tools/activeTools';

export interface WorkflowStep {
  label: string;
  /** Omitted for steps that use Speako's own local data (past sessions, sentiment, open action items) rather than an external tool. */
  tool?: ToolKey;
}

/**
 * Human-readable description of what each meeting type's workflow gathers,
 * for display in the new-session UI before the user commits to a type. Hand-
 * maintained alongside src/prep/workflows/*.ts rather than introspected from
 * the actual gather() functions — those are async and source names don't
 * carry a friendly label, so keeping this list in sync by hand (same source/
 * tool names used in each workflow's trySource/toolSource calls) is simpler
 * than building a description DSL for a one-way informational display.
 */
export const WORKFLOW_STEPS: Record<MeetingType, WorkflowStep[]> = {
  standup: [
    { label: 'Your recent Jira activity (last 24h)', tool: 'jira' },
    { label: 'Blocked or overdue tickets', tool: 'jira' },
    { label: 'Sprint goal / team working agreement', tool: 'confluence' },
    { label: 'Notes from the last standup' },
  ],
  sprint_planning: [
    { label: 'Prioritized backlog', tool: 'jira' },
    { label: 'Carryover tickets from last sprint', tool: 'jira' },
    { label: 'Sprint velocity tracking', tool: 'confluence' },
    { label: 'Recent code changes', tool: 'bitbucket' },
    { label: 'Your pull request review activity', tool: 'bitbucketReviews' },
    { label: 'Notes from the last planning session' },
  ],
  sprint_review: [
    { label: 'Current / just-closed sprint tickets', tool: 'jira' },
    { label: 'Sprint goal / release notes', tool: 'confluence' },
    { label: 'Recent commits for demo-relevant activity', tool: 'bitbucket' },
    { label: 'Your pull request review activity', tool: 'bitbucketReviews' },
    { label: 'Related stakeholder email threads', tool: 'email' },
  ],
  retro: [
    { label: 'Action items from the last retro' },
    { label: "This sprint's completed/carried-over tickets", tool: 'jira' },
    { label: 'Retro template / prior notes', tool: 'confluence' },
    { label: 'Notably negative-tone moments from the last meeting' },
  ],
  one_on_one: [
    { label: 'Durable facts about this person', tool: 'mem0' },
    { label: 'Relevant past 1:1 conversations' },
    { label: 'Their open action items' },
    { label: 'Their recent Jira activity', tool: 'jira' },
    { label: 'Recent email exchanges with them', tool: 'email' },
    { label: 'Recent Teams conversations with them', tool: 'teams' },
    { label: 'Notes from the last 1:1' },
  ],
  design_dev: [
    { label: 'Related design docs', tool: 'confluence' },
    { label: 'Related Jira tickets', tool: 'jira' },
    { label: 'Recent code activity', tool: 'bitbucket' },
    { label: 'External references (MyRAG)', tool: 'ragCloud' },
    { label: 'Relevant snippets from your local codebase', tool: 'localCodebase' },
    { label: 'Related email threads', tool: 'email' },
    { label: 'Related Teams conversations', tool: 'teams' },
    { label: 'Background from web search', tool: 'webSearch' },
  ],
  generic: [
    { label: 'Jira tickets matching this topic', tool: 'jira' },
    { label: 'Confluence pages matching this topic', tool: 'confluence' },
    { label: 'Relevant past sessions' },
    { label: 'Related email threads', tool: 'email' },
    { label: 'Related Teams conversations', tool: 'teams' },
    { label: 'Related code, if the topic looks code-related', tool: 'bitbucket' },
  ],
};
