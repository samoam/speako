/**
 * Multi-source routing (spec §3.2), scoped down to the two sources actually
 * wired up (Bitbucket + personal RAG) rather than the full GitHub/Jira/
 * Confluence/web-search matrix. A simple keyword heuristic decides whether a
 * piece of text is code/technical enough to be worth querying Bitbucket for —
 * cheap and fast, matching the "decide before you retrieve" principle from
 * trigger detection rather than always broadcasting to every source.
 */
export function looksCodeRelated(text: string): boolean {
  return /\b(API|function|class|endpoint|repo(?:sitory)?|branch|commit|bug|error|exception|deploy(?:ment)?|version|config|variable|method|service|database|schema|query|pull request|PR|pipeline|build)\b/i.test(
    text
  );
}
