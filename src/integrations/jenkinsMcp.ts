import { config } from '../config';
import { McpServerClient } from '../mcp/mcpClient';
import { onSettingsChanged } from '../settingsStore';
import { isJenkinsConfigured, jobPathFor, JenkinsBuildStatus } from './jenkinsClient';

/**
 * Jenkins' own MCP server (`<JENKINS_URL>/mcp-server/mcp`), used where the
 * REST client (jenkinsClient.ts) can't answer: knowing WHICH build a trigger
 * produced. A REST buildWithParameters returns nothing usable, but on a
 * single job shared by every branch, "the job's latest build" may belong to a
 * different branch — so a triggered run is followed from its queue item to
 * its own build number. Confirmed live (2026-09-30) that it accepts Basic
 * auth with the same JENKINS_USER/JENKINS_API_TOKEN as REST (no password
 * needed), and that every tool answers with one text block holding
 * `{"message", "result", "status": "COMPLETED"}` — "not found" is COMPLETED
 * with no `result`, not an error. Needs Node's --use-system-ca (see NOTES.md).
 */
let mcpClient: McpServerClient | null = null;
function getClient(): McpServerClient {
  if (!mcpClient) {
    mcpClient = new McpServerClient({
      transport: 'http',
      url: `${config.jenkinsUrl.replace(/\/+$/, '')}/mcp-server/mcp`,
      apiKey: '',
      authorization: `Basic ${Buffer.from(`${config.jenkinsUser}:${config.jenkinsApiToken}`).toString('base64')}`,
    });
  }
  return mcpClient;
}

onSettingsChanged(() => {
  mcpClient?.close();
  mcpClient = null;
});

export function isJenkinsTestJobConfigured(): boolean {
  return isJenkinsConfigured() && !!config.jenkinsTestJob;
}

/** The parsed `result` of one tool call; null when Jenkins reports nothing found. */
async function callJenkinsTool(name: string, args: Record<string, unknown>): Promise<any | null> {
  const response = await getClient().callTool(name, args);
  const text = response?.content?.find((c: any) => c.type === 'text')?.text ?? '';
  if (response?.isError) throw new Error(`Jenkins MCP ${name} failed: ${text.slice(0, 300)}`);
  let parsed: any;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error(`Jenkins MCP ${name} returned non-JSON: ${text.slice(0, 300)}`);
  }
  if (parsed.status && parsed.status !== 'COMPLETED') throw new Error(`Jenkins MCP ${name}: ${parsed.status} — ${parsed.message ?? ''}`);
  return parsed.result ?? null;
}

/**
 * NOT yet confirmed live (the shared test job didn't exist when this was
 * written): Jenkins' own queue API identifies an item by numeric `id` and
 * by a `queue/item/<id>/` URL, so either form is accepted here.
 */
function extractQueueId(result: any): number | null {
  if (result == null) return null;
  const direct = result.id ?? result.queueId ?? result.queueItem?.id;
  if (Number.isFinite(Number(direct))) return Number(direct);
  const match = JSON.stringify(result).match(/queue\/item\/(\d+)/);
  return match ? Number(match[1]) : null;
}

/** Queues one build of `jobFullName` with `parameters` (e.g. the branch to test) and returns the queue item id to follow. */
export async function triggerJenkinsBuild(jobFullName: string, parameters: Record<string, string>): Promise<number> {
  const result = await callJenkinsTool('triggerBuild', { jobFullName, parameters });
  const queueId = extractQueueId(result);
  if (queueId == null) throw new Error(`Jenkins accepted the trigger but returned no queue item id: ${JSON.stringify(result).slice(0, 300)}`);
  return queueId;
}

export type QueueState = { state: 'waiting'; why: string | null } | { state: 'started'; buildNumber: number } | { state: 'cancelled' } | { state: 'gone' };

/**
 * Follows a queue item to the build it became. Same not-yet-confirmed-live
 * caveat as extractQueueId: the shape follows Jenkins' queue item JSON
 * (`executable.number` once started, `cancelled`, `why` while waiting).
 * `gone` = Jenkins no longer knows the item (queue items expire a few minutes
 * after leaving the queue), which the caller treats as a lost trigger.
 */
export async function getQueueState(queueId: number): Promise<QueueState> {
  const item = await callJenkinsTool('getQueueItem', { id: queueId });
  if (!item) return { state: 'gone' };
  const number = Number(item.executable?.number);
  if (Number.isFinite(number) && number > 0) return { state: 'started', buildNumber: number };
  if (item.cancelled) return { state: 'cancelled' };
  return { state: 'waiting', why: item.why ?? null };
}

/** One specific build (not the job's latest) — confirmed live on a real job that getBuild with a `tree` returns exactly these fields. */
export async function getBuildByNumber(jobFullName: string, buildNumber: number): Promise<JenkinsBuildStatus | null> {
  const build = await callJenkinsTool('getBuild', { jobFullName, buildNumber, tree: 'number,result,building,timestamp,duration,url,displayName' });
  if (!build) return null;
  return {
    jobPath: jobPathFor(jobFullName),
    number: build.number,
    result: build.result ?? null,
    building: !!build.building,
    timestamp: build.timestamp ?? 0,
    durationMs: build.duration ?? 0,
    url: build.url ?? '',
    displayName: build.displayName ?? `#${build.number}`,
  };
}
