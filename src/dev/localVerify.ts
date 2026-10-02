import * as fs from 'fs';
import * as path from 'path';
import { spawn } from 'child_process';
import { config } from '../config';
import { git } from '../integrations/claudeCodeCli';

/**
 * The local gate before a push: compile what changed and run the changed
 * tests the way the repo itself documents (officercc's .claude/CLAUDE.md and
 * its runASingle*Test scripts), so a broken build or a failing unit test
 * costs minutes here instead of a 20-minute Jenkins round. What this
 * deliberately does NOT do, because the repo's own notes say it doesn't
 * work: `mvn test` (officercc5 skips Surefire outright, `-am` drags every
 * upstream module's tests in, and offline runs die on Surefire plugin
 * resolution) and `mvn install`/`package` (fails offline on jar plugins).
 * Compile is `test-compile` with `-am`, under JDK 8 — the reactor targets
 * 1.8 and its Lombok breaks on JDK 16+ during annotation processing.
 */

export interface ChangedTests {
  /** Reactor modules (top-level dirs with a pom.xml) touched by the change. */
  modules: string[];
  unitTests: { module: string; fqcn: string }[];
  integrationTests: { module: string; fqcn: string }[];
}

const INTEGRATION_TEST_RE = /(ITest|IntegrationTest|IT)$/;
const UNIT_TEST_RE = /Tests?$/;

/** Which modules a change touches and which test classes it adds or edits — from paths alone, no file reads. */
export function analyzeChangedFiles(files: string[], isModule: (topLevelDir: string) => boolean): ChangedTests {
  const modules = new Set<string>();
  const unitTests: ChangedTests['unitTests'] = [];
  const integrationTests: ChangedTests['integrationTests'] = [];
  for (const file of files) {
    const normalized = file.replace(/\\/g, '/');
    const top = normalized.split('/')[0];
    if (!top || top === normalized) continue; // a root-level file (pom.xml, README) touches no module
    if (!isModule(top)) continue;
    modules.add(top);
    const test = normalized.match(/^([^/]+)\/src\/test\/java\/(.+)\.java$/);
    if (!test) continue;
    const fqcn = test[2].replace(/\//g, '.');
    const className = fqcn.split('.').pop()!;
    if (INTEGRATION_TEST_RE.test(className)) integrationTests.push({ module: test[1], fqcn });
    else if (UNIT_TEST_RE.test(className)) unitTests.push({ module: test[1], fqcn });
  }
  return { modules: [...modules], unitTests, integrationTests };
}

const JDK_ROOTS = ['C:\\Program Files\\Java', 'C:\\Program Files\\AdoptOpenJDK', 'C:\\Program Files\\Eclipse Adoptium', 'C:\\Program Files\\Microsoft', 'C:\\Program Files\\Zulu', 'C:\\Program Files\\Amazon Corretto'];

function jdkVersionOf(home: string): string | null {
  try {
    const release = fs.readFileSync(path.join(home, 'release'), 'utf8');
    return /JAVA_VERSION="([^"]+)"/.exec(release)?.[1] ?? null;
  } catch {
    return null;
  }
}

/**
 * A JDK whose version starts with `major` ("1.8" or "17"), with javac — from
 * `envVar` if set (JAVA_HOME_COMPILE / JAVA_HOME_RUN, the repo scripts' own
 * overrides), else by scanning the usual Windows install roots. The default
 * JAVA_HOME on this machine is JDK 21 (confirmed live), which the reactor
 * can't compile under, so it's never used implicitly.
 */
export function detectJdkHome(major: string, envVar?: string, roots: string[] = JDK_ROOTS): string | null {
  const fromEnv = envVar ? process.env[envVar] : undefined;
  if (fromEnv && fs.existsSync(path.join(fromEnv, 'bin'))) return fromEnv;
  for (const root of roots) {
    let entries: string[] = [];
    try {
      entries = fs.readdirSync(root);
    } catch {
      continue;
    }
    for (const entry of entries) {
      const home = path.join(root, entry);
      const version = jdkVersionOf(home);
      if (version && version.startsWith(major) && fs.existsSync(path.join(home, 'bin', process.platform === 'win32' ? 'javac.exe' : 'javac'))) return home;
    }
  }
  return null;
}

export interface LocalVerifyResult {
  ok: boolean;
  /** One line for the checklist. */
  summary: string;
  failingTests: string[];
  /** The tail of the build/test output — what a fix agent gets to read. */
  output: string;
  modules: string[];
  /** The gate itself could not run (a runner not found, a missing tool) — not the code's fault, so no fix round; fix the machine and retry. */
  toolingFailure?: boolean;
}

/**
 * Git Bash drops the backslashes of a Windows path given as an argument
 * (confirmed live: `bash C:\...\runASingleUnitTest.sh` → "bash:
 * C:Usersmadadi...: No such file or directory", exit 127), while the
 * same path with forward slashes works.
 */
export function toBashPath(p: string): string {
  return p.replace(/\\/g, '/');
}

/** Exit 127 is bash's "command/script not found" — the runner never ran, so nothing about the code was tested. */
export function isToolingFailure(code: number | null, output: string): boolean {
  return code === 127 || /^(\/bin\/)?bash: .*: No such file or directory/m.test(output) || /^(\/bin\/)?bash: .*: command not found/m.test(output);
}

const COMMAND_TIMEOUT_MS = 30 * 60 * 1000;
const OUTPUT_TAIL_LINES = 120;

type CommandOutcome = { code: number | null; output: string };

function run(cmd: string, args: string[], cwd: string, env: NodeJS.ProcessEnv, signal: AbortSignal, onLine: (line: string) => void): Promise<CommandOutcome> {
  return new Promise((resolve) => {
    // Maven's Windows launcher is mvn.cmd, and Node ≥ 18.20/20.12/22 refuses
    // to spawn a .cmd/.bat without a shell (EINVAL, the CVE-2024-27980 fix —
    // seen live). The arguments here carry no shell metacharacters.
    const child = spawn(cmd, args, { cwd, env, shell: /\.(cmd|bat)$/i.test(cmd) });
    let output = '';
    let partial = '';
    const onData = (chunk: Buffer) => {
      const text = chunk.toString('utf8');
      output += text;
      partial += text;
      const lines = partial.split('\n');
      partial = lines.pop() ?? '';
      for (const line of lines) if (line.trim()) onLine(line.trimEnd());
    };
    child.stdout?.on('data', onData);
    child.stderr?.on('data', onData);
    const timer = setTimeout(() => child.kill(), COMMAND_TIMEOUT_MS);
    const onAbort = () => child.kill();
    signal.addEventListener('abort', onAbort, { once: true });
    child.on('error', (err) => {
      clearTimeout(timer);
      signal.removeEventListener('abort', onAbort);
      resolve({ code: null, output: `${output}\n${err.message}` });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      signal.removeEventListener('abort', onAbort);
      resolve({ code, output });
    });
  });
}

const tail = (text: string, lines = OUTPUT_TAIL_LINES) => text.split('\n').filter((l) => l.trim()).slice(-lines).join('\n');

/** Offline-plugin/dependency resolution failures — the one case where a retry without `-o` is the fix (the repo notes: project deps are cached, plugins often aren't). */
const OFFLINE_RESOLUTION_RE = /Could not resolve|Cannot access .* in offline mode|Non-resolvable|Could not find artifact|has not been downloaded from it before/i;

/** Failing test names, from JUnitCore ("1) testX(com.a.B)") and Surefire ("[ERROR] testX(com.a.B)") output. */
export function extractFailingTests(output: string): string[] {
  const names = new Set<string>();
  for (const m of output.matchAll(/^\s*\d+\)\s+(\w+)\(([\w.$]+)\)/gm)) names.add(`${m[2]}.${m[1]}`);
  for (const m of output.matchAll(/\[ERROR\]\s+(\w+)\(([\w.$]+)\)/g)) names.add(`${m[2]}.${m[1]}`);
  for (const m of output.matchAll(/\[ERROR\]\s+([\w.$]+)\.(\w+):\d+/g)) names.add(`${m[1]}.${m[2]}`);
  return [...names];
}

/**
 * Compiles the changed modules (with their upstream reactor siblings) and
 * runs the changed unit-test classes; integration tests run only when a
 * local integration-test config dir is configured (they need the automation
 * database — on Jenkins otherwise). Non-Maven repos are skipped, not failed.
 */
export async function runLocalVerify(worktreePath: string, baseBranch: string, log: (message: string) => void, signal: AbortSignal): Promise<LocalVerifyResult> {
  if (!fs.existsSync(path.join(worktreePath, 'pom.xml'))) return { ok: true, summary: 'Skipped — not a Maven project.', failingTests: [], output: '', modules: [] };
  const files = (await git(['diff', '--name-only', `origin/${baseBranch}...HEAD`], worktreePath)).split('\n').map((l) => l.trim()).filter(Boolean);
  const changed = analyzeChangedFiles(files, (dir) => fs.existsSync(path.join(worktreePath, dir, 'pom.xml')));
  if (!changed.modules.length) return { ok: true, summary: 'Skipped — no module source changed.', failingTests: [], output: '', modules: [] };

  const jdk8 = detectJdkHome('1.8', 'JAVA_HOME_COMPILE');
  if (!jdk8) return { ok: false, summary: 'No JDK 8 found for compiling (the reactor targets 1.8) — set JAVA_HOME_COMPILE.', failingTests: [], output: '', modules: changed.modules };
  const jdk17 = detectJdkHome('17', 'JAVA_HOME_RUN');
  const env: NodeJS.ProcessEnv = { ...process.env, JAVA_HOME: jdk8, PATH: `${path.join(jdk8, 'bin')}${path.delimiter}${process.env.PATH ?? ''}`, JAVA_HOME_COMPILE: jdk8, ...(jdk17 ? { JAVA_HOME_RUN: jdk17 } : {}) };
  const mvn = process.platform === 'win32' ? 'mvn.cmd' : 'mvn';
  let output = '';
  const onLine = (line: string) => {
    // Maven is chatty; the run log gets the lines that say something happened.
    if (/\[ERROR\]|BUILD (SUCCESS|FAILURE)|Tests run:|Building |COMPILATION ERROR|^\s*\d+\) |^OK \(|^FAILURES/.test(line)) log(line.slice(0, 220));
  };

  log(`Compiling ${changed.modules.join(', ')} (and upstream modules) with JDK 8 at ${jdk8}…`);
  // Not -q: a cold compile of this reactor took 13 min live, and Maven's
  // "Building <module>" lines are the only progress the run log can show.
  const compileArgs = ['-pl', changed.modules.join(','), '-am', 'test-compile'];
  let compile = await run(mvn, ['-o', ...compileArgs], worktreePath, env, signal, onLine);
  output += compile.output;
  if (compile.code !== 0 && OFFLINE_RESOLUTION_RE.test(compile.output)) {
    log('Offline resolution failed — retrying the compile online…');
    compile = await run(mvn, compileArgs, worktreePath, env, signal, onLine);
    output += compile.output;
  }
  if (compile.code !== 0) {
    return { ok: false, summary: `Compilation failed in ${changed.modules.join(', ')}.`, failingTests: [], output: tail(output), modules: changed.modules };
  }

  const ran: string[] = [];
  if (changed.unitTests.length) {
    const script = path.join(worktreePath, '.claude', 'runASingleUnitTest.sh');
    const byModule = new Map<string, string[]>();
    for (const t of changed.unitTests) byModule.set(t.module, [...(byModule.get(t.module) ?? []), t.fqcn]);
    for (const [module, classes] of byModule) {
      log(`Running ${classes.length} unit test class(es) in ${module}…`);
      const viaMaven = () => run(mvn, ['-q', '-pl', module, `-Dtest=${classes.join(',')}`, '-DfailIfNoTests=false', '-Dsurefire.failIfNoSpecifiedTests=false', 'test'], worktreePath, env, signal, onLine);
      let outcome = fs.existsSync(script) && jdk17 ? await run('bash', [toBashPath(script), module, ...classes, '--offline'], worktreePath, env, signal, onLine) : await viaMaven();
      output += outcome.output;
      if (isToolingFailure(outcome.code, outcome.output)) {
        // The repo's runner could not even start — not the code's fault. Maven
        // is slower but needs nothing beyond what the compile just used. The
        // runner's own last words go to the log: onLine filters them out, and
        // without them a live failure of this kind was undiagnosable.
        log(`The test runner could not start (exit ${outcome.code}) — running the tests through Maven instead. Runner output: ${tail(outcome.output, 12)}`);
        outcome = await viaMaven();
        output += outcome.output;
      }
      ran.push(...classes);
      if (isToolingFailure(outcome.code, outcome.output)) {
        return { ok: false, summary: `The local gate could not run the unit tests in ${module} (neither the runner nor Maven could start) — see the output.`, failingTests: [], output: tail(output), modules: changed.modules, toolingFailure: true };
      }
      if (outcome.code !== 0) {
        const failing = extractFailingTests(outcome.output);
        return { ok: false, summary: `Unit tests failed in ${module}: ${failing.length ? failing.join(', ') : classes.join(', ')}.`, failingTests: failing.length ? failing : classes, output: tail(output), modules: changed.modules };
      }
    }
  }

  let integrationNote = '';
  if (changed.integrationTests.length) {
    const configDir = config.localVerifyIntegrationConfigDir;
    const script = path.join(worktreePath, '.claude', 'runASingleIntegrationTest.sh');
    if (configDir && fs.existsSync(configDir) && fs.existsSync(script) && jdk17) {
      for (const t of changed.integrationTests) {
        log(`Running integration test ${t.fqcn} against ${configDir}…`);
        const outcome = await run('bash', [toBashPath(script), t.module, t.fqcn, '--config-dir', toBashPath(configDir), '--offline'], worktreePath, { ...env, GTI_APP_CONFIG_PATH: configDir }, signal, onLine);
        output += outcome.output;
        ran.push(t.fqcn);
        if (isToolingFailure(outcome.code, outcome.output)) {
          // No Maven fallback here — the integration runner wires up the config dir the suite needs; Jenkins runs it either way.
          log(`The integration-test runner could not start (exit ${outcome.code}) — ${t.fqcn} is left to Jenkins.`);
          integrationNote += ` ${t.fqcn} left to Jenkins (the local runner could not start).`;
          continue;
        }
        if (outcome.code !== 0) {
          const failing = extractFailingTests(outcome.output);
          return { ok: false, summary: `Integration test failed: ${failing.length ? failing.join(', ') : t.fqcn}.`, failingTests: failing.length ? failing : [t.fqcn], output: tail(output), modules: changed.modules };
        }
      }
    } else {
      integrationNote = ` ${changed.integrationTests.length} integration test class(es) left to Jenkins (no local integration-test config).`;
      log(`Integration tests (${changed.integrationTests.map((t) => t.fqcn.split('.').pop()).join(', ')}) need the automation database — left to Jenkins.`);
    }
  }

  return { ok: true, summary: `Compiled ${changed.modules.join(', ')}; ${ran.length ? `${ran.length} test class(es) passed.` : 'no unit tests to run.'}${integrationNote}`, failingTests: [], output: tail(output), modules: changed.modules };
}
