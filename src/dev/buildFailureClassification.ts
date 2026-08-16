import { config } from '../config';
import { getGeminiClient } from '../gemini/geminiClient';
import { logGeminiUsage } from '../gemini/logUsage';
import { JenkinsTestReport, JenkinsStage } from '../integrations/jenkinsClient';

export type FailureCategory = 'compile_error' | 'lint_error' | 'test_regression' | 'flaky_test' | 'infra_failure' | 'unknown';

export interface HeuristicSignals {
  hasTestReport: boolean;
  failCount: number;
  /** True if a build/compile stage is recorded as FAILED before any test stage ran — a strong compile-error signal, independent of the log-pattern match. */
  failedBeforeTestStage: boolean;
  matched: { pattern: string; category: FailureCategory; excerpt: string }[];
  /** Test names with Jenkins' own age === 1 — i.e. newly failing this build, not a carry-over. */
  newlyFailingTests: string[];
  /** Test names that also failed in at least one of the recent builds passed in — evidence toward "this test is just flaky," not a fresh regression. */
  historicallyFlakyTests: string[];
}

interface PatternEntry {
  pattern: RegExp;
  category: FailureCategory;
}

/** One exported table, easy to extend — matched against the console log tail. Order matters: infra checked first so a timeout/connection-loss during a test run isn't miscategorized as a test failure. */
export const FAILURE_PATTERNS: PatternEntry[] = [
  // infra_failure
  { pattern: /Cannot contact .*: java\.lang\.InterruptedException/, category: 'infra_failure' },
  { pattern: /channel is already closed/, category: 'infra_failure' },
  { pattern: /No space left on device/, category: 'infra_failure' },
  { pattern: /java\.net\.UnknownHostException/, category: 'infra_failure' },
  { pattern: /Connection (refused|reset)/, category: 'infra_failure' },
  { pattern: /Failed to connect to .*docker/i, category: 'infra_failure' },
  { pattern: /Agent went offline/, category: 'infra_failure' },
  { pattern: /Queue task was cancelled/, category: 'infra_failure' },
  { pattern: /Received fatal alert/, category: 'infra_failure' },
  { pattern: /error: RPC failed|fatal: unable to access/, category: 'infra_failure' },
  // compile_error
  { pattern: /COMPILATION ERROR/, category: 'compile_error' },
  { pattern: /cannot find symbol/, category: 'compile_error' },
  { pattern: /error TS\d+/, category: 'compile_error' },
  { pattern: /BUILD FAILURE/, category: 'compile_error' },
  { pattern: /SyntaxError:/, category: 'compile_error' },
  { pattern: /error: package .* does not exist/, category: 'compile_error' },
  // lint_error
  { pattern: /ESLint found/i, category: 'lint_error' },
  { pattern: /\d+ problems? \(\d+ errors?/, category: 'lint_error' },
  { pattern: /Checkstyle .* violations/i, category: 'lint_error' },
  { pattern: /prettier --check/, category: 'lint_error' },
  { pattern: /ruff|flake8 .*E\d{3}/, category: 'lint_error' },
  // flaky-leaning infra-ish signatures (kept last so a real compile/infra match above wins first)
  { pattern: /Timeout has been exceeded|TimedOut/, category: 'flaky_test' },
  { pattern: /ConcurrentModification/, category: 'flaky_test' },
  { pattern: /Address already in use/, category: 'flaky_test' },
  { pattern: /StaleElementReference|element not interactable/, category: 'flaky_test' },
  { pattern: /ECONNRESET/, category: 'flaky_test' },
];

/** Scans the console log tail for the first N pattern matches (capped so one very noisy log can't blow up the prompt), and computes newly-failing/historically-flaky test sets from the current + recent test reports. */
export function extractSignals(log: string, report: JenkinsTestReport | null, stages: JenkinsStage[], recentReports: JenkinsTestReport[]): HeuristicSignals {
  const matched: HeuristicSignals['matched'] = [];
  const lines = log.split('\n');
  for (const line of lines) {
    for (const { pattern, category } of FAILURE_PATTERNS) {
      if (pattern.test(line)) {
        matched.push({ pattern: pattern.source, category, excerpt: line.trim().slice(0, 300) });
        break;
      }
    }
    if (matched.length >= 20) break;
  }

  const testStageNames = new Set(['test', 'tests', 'unit test', 'unit tests']);
  let failedBeforeTestStage = false;
  for (const stage of stages) {
    const isTestStage = testStageNames.has(stage.name.trim().toLowerCase());
    if (stage.status === 'FAILED' && !isTestStage) {
      // A non-test stage failed and no test stage before it succeeded — treat as pre-test failure.
      const testStageIndex = stages.findIndex((s) => testStageNames.has(s.name.trim().toLowerCase()));
      const thisIndex = stages.indexOf(stage);
      if (testStageIndex === -1 || thisIndex < testStageIndex) {
        failedBeforeTestStage = true;
        break;
      }
    }
  }

  const newlyFailingTests = (report?.failures ?? []).filter((f) => f.age === 1).map((f) => `${f.className}.${f.name}`);
  const recentlyFailedNames = new Set<string>();
  for (const recent of recentReports) {
    for (const f of recent.failures) recentlyFailedNames.add(`${f.className}.${f.name}`);
  }
  const historicallyFlakyTests = (report?.failures ?? []).map((f) => `${f.className}.${f.name}`).filter((name) => recentlyFailedNames.has(name));

  return {
    hasTestReport: !!report,
    failCount: report?.failCount ?? 0,
    failedBeforeTestStage,
    matched,
    newlyFailingTests,
    historicallyFlakyTests,
  };
}

/** Cheap, deterministic first guess — used as-is when Gemini is unavailable, and fed into the LLM prompt as a starting hypothesis otherwise. Priority: infra > compile > lint > (test failures, distinguishing regression vs flaky) > unknown. */
export function classifyByHeuristics(signals: HeuristicSignals): FailureCategory {
  const byCategory = (cat: FailureCategory) => signals.matched.find((m) => m.category === cat);
  if (byCategory('infra_failure')) return 'infra_failure';
  if (byCategory('compile_error') || (signals.failedBeforeTestStage && !signals.hasTestReport)) return 'compile_error';
  if (byCategory('lint_error')) return 'lint_error';
  if (signals.failCount > 0) {
    const allFlaky = signals.newlyFailingTests.every((t) => signals.historicallyFlakyTests.includes(t));
    if (byCategory('flaky_test') || (signals.newlyFailingTests.length > 0 && allFlaky)) return 'flaky_test';
    if (signals.newlyFailingTests.some((t) => !signals.historicallyFlakyTests.includes(t))) return 'test_regression';
    return 'flaky_test';
  }
  return 'unknown';
}

export interface BuildFailureAnalysis {
  category: FailureCategory;
  confidence: number;
  summary: string;
  suspectFiles: string[];
  suspectTests: string[];
  /** Only compile_error/lint_error/test_regression are ever fixable by a code-writing agent — infra_failure and flaky_test are explicitly never proposed for an automatic fix (see buildFixPrompt.ts). */
  fixable: boolean;
  suggestedFix: string;
  evidence: string[];
}

const CLASSIFY_SCHEMA = {
  type: 'object',
  properties: {
    category: { type: 'string', enum: ['compile_error', 'lint_error', 'test_regression', 'flaky_test', 'infra_failure', 'unknown'] },
    confidence: { type: 'number', description: '0 to 1.' },
    summary: { type: 'string', description: 'One paragraph a human can read in a notification.' },
    suspectFiles: { type: 'array', items: { type: 'string' }, description: 'Repo-relative paths you can see in the log/stack traces — never invented.' },
    suspectTests: { type: 'array', items: { type: 'string' }, description: 'Fully-qualified failing test names.' },
    fixable: { type: 'boolean', description: 'True only for compile_error/lint_error/test_regression.' },
    suggestedFix: { type: 'string', description: 'What a fix would need to do — becomes the seed of a scoped fix prompt.' },
    evidence: { type: 'array', items: { type: 'string' }, description: 'Verbatim log lines this classification is based on.' },
  },
  required: ['category', 'confidence', 'summary', 'suspectFiles', 'suspectTests', 'fixable', 'suggestedFix', 'evidence'],
};

/**
 * Two-stage: the heuristic signals are computed first and handed to Gemini
 * as facts ("deterministic scan found: ..."), never re-derived — this is
 * what keeps the LLM from calling a test "a regression" when it's already
 * in the historically-flaky set, or calling something a real bug when the
 * failure happened before the test stage even ran. Falls back to the
 * heuristic category alone (fixable only for the three genuinely-fixable
 * categories) if Gemini is unavailable/errors — this must degrade, never break.
 */
export async function classifyBuildFailure(input: {
  log: string;
  signals: HeuristicSignals;
  stages: JenkinsStage[];
  report: JenkinsTestReport | null;
  branch: string;
  ticketKey: string | null;
}): Promise<BuildFailureAnalysis> {
  const heuristicCategory = classifyByHeuristics(input.signals);
  const fallback: BuildFailureAnalysis = {
    category: heuristicCategory,
    confidence: 0.4,
    summary: `Build on branch ${input.branch} failed, classified as ${heuristicCategory} from log patterns alone (Gemini unavailable).`,
    suspectFiles: [],
    suspectTests: input.signals.newlyFailingTests,
    fixable: ['compile_error', 'lint_error', 'test_regression'].includes(heuristicCategory),
    suggestedFix: '',
    evidence: input.signals.matched.map((m) => m.excerpt),
  };

  if (!config.geminiApiKey) return fallback;

  try {
    const prompt = `You are classifying why a Jenkins build failed on branch "${input.branch}"${input.ticketKey ? ` (ticket ${input.ticketKey})` : ''}.

Deterministic scan found:
- Heuristic category guess: ${heuristicCategory}
- Failed before any test stage ran: ${input.signals.failedBeforeTestStage}
- Test report present: ${input.signals.hasTestReport}, failCount: ${input.signals.failCount}
- Newly-failing tests (age=1, i.e. new this build): ${input.signals.newlyFailingTests.join(', ') || '(none)'}
- Historically-flaky tests (failed in a recent prior build too): ${input.signals.historicallyFlakyTests.join(', ') || '(none)'}
- Pattern matches: ${input.signals.matched.map((m) => `${m.category}: ${m.excerpt}`).join(' | ') || '(none)'}

Console log tail:
${input.log.slice(-8000)}

Prefer "infra_failure" when the failure clearly happened outside the test/compile stages (timeouts, connection loss, agent offline). Never call a test "test_regression" if it's already in the historically-flaky list — call it "flaky_test" instead. Only list suspectFiles you can actually see referenced in the log. Set fixable=true only for compile_error/lint_error/test_regression — infra_failure and flaky_test are never something a code fix should attempt.`;

    const response = await getGeminiClient().models.generateContent({
      model: config.geminiFastModel,
      contents: prompt,
      config: { responseMimeType: 'application/json', responseSchema: CLASSIFY_SCHEMA, thinkingConfig: { thinkingBudget: 1 } },
    });
    logGeminiUsage('classifyBuildFailure', response);
    const parsed = JSON.parse(response.text ?? '{}');
    if (!parsed.category) return fallback;
    return {
      category: parsed.category,
      confidence: typeof parsed.confidence === 'number' ? parsed.confidence : 0.5,
      summary: parsed.summary || fallback.summary,
      suspectFiles: parsed.suspectFiles ?? [],
      suspectTests: parsed.suspectTests ?? input.signals.newlyFailingTests,
      fixable: !!parsed.fixable,
      suggestedFix: parsed.suggestedFix || '',
      evidence: parsed.evidence ?? fallback.evidence,
    };
  } catch {
    return fallback;
  }
}
