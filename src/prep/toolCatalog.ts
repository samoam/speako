import { searchJira } from '../integrations/jiraMcp';
import { searchConfluence } from '../integrations/confluenceMcp';
import { searchBitbucketServer } from '../integrations/bitbucketServer';
import { searchMemory } from '../integrations/mem0Client';
import * as ragClient from '../integrations/ragClient';
import { searchCode } from '../codebase/searchCode';
import { searchExternalMessages } from '../communications/searchExternalMessages';
import { prepWebSearch } from './webSearch';
import { ToolKey } from '../tools/activeTools';

type ToolSearchFn = (query: string, limit: number) => Promise<string>;

/**
 * One normalized search+format function per tool — the single place that
 * knows how to call each integration and shape its results into a text
 * block. Workflow files (src/prep/workflows/*.ts) never call searchJira etc.
 * directly; they only declare {tool, name, query, limit} and let
 * gatherToolSources (types.ts) look up the function here. Adding a new tool
 * everywhere it's relevant is now: one function here + one array entry per
 * meeting type that should use it — no fetch/format code duplicated per type.
 */
export const TOOL_CATALOG: Record<ToolKey, ToolSearchFn> = {
  jira: async (query, limit) => (await searchJira(query, limit)).map((m) => `${m.path}: ${m.snippet}`).join('\n'),
  confluence: async (query, limit) => (await searchConfluence(query, limit)).map((m) => `${m.path}: ${m.snippet}`).join('\n'),
  bitbucket: async (query, limit) => (await searchBitbucketServer(query, limit)).map((m) => `${m.path}: ${m.snippet}`).join('\n'),
  mem0: async (query, limit) => (await searchMemory(query, limit)).map((m) => m.memory).join('\n'),
  ragCloud: async (query, limit) => (await ragClient.search(query, limit)).map((m) => m.text).join('\n'),
  localCodebase: async (query, limit) => (await searchCode(query, limit)).map((m) => `${m.repoName}/${m.filePath}: ${m.text.slice(0, 300)}`).join('\n\n'),
  email: async (query, limit) => (await searchExternalMessages(query, 'email', limit)).map((m) => m.text).join('\n\n'),
  teams: async (query, limit) => (await searchExternalMessages(query, 'teams', limit)).map((m) => m.text).join('\n\n'),
  webSearch: async (query) => prepWebSearch(query),
};

export function searchByTool(tool: ToolKey, query: string, limit: number): Promise<string> {
  return TOOL_CATALOG[tool](query, limit);
}
