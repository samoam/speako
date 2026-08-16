import test from 'node:test';
import assert from 'node:assert/strict';
import { PrReviewFinding } from '../src/storage/prReviewRequestRepository';
import { DiffAnchor } from '../src/integrations/bitbucketServer';
import { resolveFindingAnchor, formatFindingComment, stagePrReviewComments, formatRetractionComment } from '../src/summarization/prReviewComments';

function finding(overrides: Partial<PrReviewFinding> = {}): PrReviewFinding {
  return { file: 'src/foo.ts', line: 12, severity: 'major', comment: 'This could leak a resource.', ...overrides };
}

test('formatFindingComment: always includes the AI-drafted attribution trailer', () => {
  const text = formatFindingComment(finding());
  assert.match(text, /major/);
  assert.match(text, /This could leak a resource\./);
  assert.match(text, /Drafted by Speako/);
});

test('resolveFindingAnchor: exact (path, line) match in the diff -> inline comment', () => {
  const anchors: DiffAnchor[] = [{ line: 12, lineType: 'ADDED', fileType: 'TO' }];
  const result = resolveFindingAnchor(finding({ line: 12 }), ['src/foo.ts'], anchors);
  assert.equal(result.mode, 'inline');
  assert.deepEqual(result.anchor, { path: 'src/foo.ts', line: 12, lineType: 'ADDED', fileType: 'TO', diffType: 'EFFECTIVE' });
  assert.equal(result.warning, null);
});

test('resolveFindingAnchor: path changed but the exact line is not in the diff -> file-level comment with a warning', () => {
  const anchors: DiffAnchor[] = [{ line: 40, lineType: 'ADDED', fileType: 'TO' }];
  const result = resolveFindingAnchor(finding({ line: 12 }), ['src/foo.ts'], anchors);
  assert.equal(result.mode, 'file');
  assert.deepEqual(result.anchor, { path: 'src/foo.ts', diffType: 'EFFECTIVE', fileType: 'TO' });
  assert.match(result.warning!, /outside this PR's diff/);
});

test('resolveFindingAnchor: no line given but the path is changed -> file-level comment, no warning', () => {
  const result = resolveFindingAnchor(finding({ line: null }), ['src/foo.ts'], []);
  assert.equal(result.mode, 'file');
  assert.equal(result.warning, null);
});

test('resolveFindingAnchor: file not in the PR\'s changed paths at all -> general comment with a warning', () => {
  const result = resolveFindingAnchor(finding({ file: 'src/unrelated.ts' }), ['src/foo.ts'], []);
  assert.equal(result.mode, 'general');
  assert.equal(result.anchor, null);
  assert.match(result.warning!, /isn't one of this PR's changed files/);
});

test('stagePrReviewComments: maps every finding in order, prefixing general comments with the file path', () => {
  const findings = [finding({ file: 'src/foo.ts', line: 12 }), finding({ file: 'src/gone.ts', line: 5, comment: 'stale reference' })];
  const anchorsByPath = new Map<string, DiffAnchor[]>([['src/foo.ts', [{ line: 12, lineType: 'ADDED', fileType: 'TO' }]]]);
  const staged = stagePrReviewComments(findings, ['src/foo.ts'], anchorsByPath);

  assert.equal(staged.length, 2);
  assert.equal(staged[0].findingIndex, 0);
  assert.equal(staged[0].mode, 'inline');
  assert.doesNotMatch(staged[0].text, /^`/); // inline comments aren't prefixed with a file path

  assert.equal(staged[1].findingIndex, 1);
  assert.equal(staged[1].mode, 'general');
  assert.match(staged[1].text, /^`src\/gone\.ts:5`/);
});

test('formatRetractionComment: references the original file/line and states the reason', () => {
  const text = formatRetractionComment({ file: 'src/foo.ts', line: 12 }, 'the reviewer already addressed this');
  assert.match(text, /src\/foo\.ts:12/);
  assert.match(text, /the reviewer already addressed this/);
});

test('formatRetractionComment: omits the line when there is none', () => {
  const text = formatRetractionComment({ file: 'src/foo.ts', line: null }, 'no longer applies');
  assert.match(text, /`src\/foo\.ts`/);
  assert.doesNotMatch(text, /src\/foo\.ts:/);
});
