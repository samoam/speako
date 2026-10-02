import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { analyzeChangedFiles, detectJdkHome, extractFailingTests, toBashPath, isToolingFailure } from '../src/dev/localVerify';

const isModule = (dir: string) => ['officercc5-service', 'officercc4db', 'officercc-common'].includes(dir);

test('analyzeChangedFiles: modules from top-level dirs with a pom, unit vs integration tests from the class name', () => {
  const result = analyzeChangedFiles(
    [
      'officercc5-service/src/main/java/com/gtechna/officercc5/service/EscalationFineServiceImpl.java',
      'officercc5-service/src/test/java/com/gtechna/officercc5/service/EscalationFineServiceIntegrationTest.java',
      'officercc-common/src/test/java/com/gtechna/common/util/TruncateUtilsTest.java',
      'officercc5-scheduler/src/test/java/com/gtechna/officercc5/scheduler/job/EventBasedDataPushJobOAuth2ITest.java', // not a module here
      'pom.xml',
      'README.md',
      'docs/notes.txt',
    ],
    isModule
  );
  assert.deepEqual(result.modules, ['officercc5-service', 'officercc-common']);
  assert.deepEqual(result.unitTests, [{ module: 'officercc-common', fqcn: 'com.gtechna.common.util.TruncateUtilsTest' }]);
  assert.deepEqual(result.integrationTests, [{ module: 'officercc5-service', fqcn: 'com.gtechna.officercc5.service.EscalationFineServiceIntegrationTest' }]);
});

test('analyzeChangedFiles: Windows separators and *IT / *Tests names', () => {
  const result = analyzeChangedFiles(['officercc4db\\src\\test\\java\\com\\gti\\cc\\db\\model\\TicketIT.java', 'officercc4db/src/test/java/com/gti/cc/db/model/TicketTests.java'], isModule);
  assert.deepEqual(result.integrationTests.map((t) => t.fqcn), ['com.gti.cc.db.model.TicketIT']);
  assert.deepEqual(result.unitTests.map((t) => t.fqcn), ['com.gti.cc.db.model.TicketTests']);
});

test('extractFailingTests: JUnitCore and Surefire failure lines', () => {
  const output = [
    'There were 2 failures:',
    '1) testCount_Zero(com.gtechna.officercc5.service.EscalationFineServiceTest)',
    'java.lang.AssertionError: expected:<1> but was:<0>',
    '2) testOther(com.gtechna.officercc5.service.EscalationFineServiceTest)',
    '[ERROR] testSurefire(com.gtechna.common.util.TruncateUtilsTest)  Time elapsed: 0.01 s  <<< FAILURE!',
    '[ERROR]   TruncateUtilsTest.testElapsed:42 expected: <a> but was: <b>',
  ].join('\n');
  assert.deepEqual(extractFailingTests(output), [
    'com.gtechna.officercc5.service.EscalationFineServiceTest.testCount_Zero',
    'com.gtechna.officercc5.service.EscalationFineServiceTest.testOther',
    'com.gtechna.common.util.TruncateUtilsTest.testSurefire',
    'TruncateUtilsTest.testElapsed',
  ]);
});

test('detectJdkHome: picks the JDK whose release file matches the major version and that has javac; env override wins', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'speako-jdks-'));
  const javac = process.platform === 'win32' ? 'javac.exe' : 'javac';
  const mk = (name: string, version: string, withJavac = true) => {
    const home = path.join(root, name);
    fs.mkdirSync(path.join(home, 'bin'), { recursive: true });
    fs.writeFileSync(path.join(home, 'release'), `JAVA_VERSION="${version}"\nOS_NAME="Windows"\n`);
    if (withJavac) fs.writeFileSync(path.join(home, 'bin', javac), '');
    return home;
  };
  mk('jdk-21', '21.0.9');
  mk('jre-8', '1.8.0_292', false);
  const jdk8 = mk('jdk-8.0.292.10-hotspot', '1.8.0_292');
  const jdk17 = mk('jdk-17', '17.0.19');
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  assert.equal(detectJdkHome('1.8', undefined, [root]), jdk8, 'a JRE without javac is skipped');
  assert.equal(detectJdkHome('17', undefined, [root]), jdk17);
  assert.equal(detectJdkHome('11', undefined, [root]), null);
  const prev = process.env.SPEAKO_TEST_JDK;
  process.env.SPEAKO_TEST_JDK = jdk17;
  try {
    assert.equal(detectJdkHome('1.8', 'SPEAKO_TEST_JDK', [root]), jdk17, 'an explicit env override is taken as-is');
  } finally {
    if (prev === undefined) delete process.env.SPEAKO_TEST_JDK;
    else process.env.SPEAKO_TEST_JDK = prev;
  }
});

test('toBashPath: Windows separators become the forward slashes Git Bash accepts', () => {
  assert.equal(toBashPath('C:\\Users\\madadi\\wt\\.claude\\runASingleUnitTest.sh'), 'C:/Users/madadi/wt/.claude/runASingleUnitTest.sh');
  assert.equal(toBashPath('/already/posix'), '/already/posix');
});

test('isToolingFailure: a runner bash could not find is a gate problem, a failing test is not', () => {
  assert.equal(isToolingFailure(127, ''), true);
  assert.equal(isToolingFailure(1, '/bin/bash: C:UsersmadadiAppDataLocalTempwt.clauderunASingleUnitTest.sh: No such file or directory\n'), true);
  assert.equal(isToolingFailure(1, 'bash: mvn: command not found\n'), true);
  assert.equal(isToolingFailure(1, 'Tests run: 3, Failures: 1\n1) run(com.gtechna.T)\n'), false);
  assert.equal(isToolingFailure(0, ''), false);
});
