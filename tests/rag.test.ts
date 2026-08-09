import test from 'node:test';
import assert from 'node:assert/strict';
import { cosineSimilarity } from '../src/rag/rag';

// retrieve() itself isn't unit-tested here: it calls embedText() from within
// the same module, and node:test's mock.method only intercepts calls made
// through a module's exports object — same-file internal calls bypass that,
// so mocking embedText wouldn't actually affect retrieve()'s behavior. Real
// end-to-end coverage of retrieve() belongs in a Phase 2 integration test
// that can use a real Gemini key.

test('cosineSimilarity: identical vectors score 1', () => {
  assert.ok(Math.abs(cosineSimilarity([1, 2, 3], [1, 2, 3]) - 1) < 1e-9);
});

test('cosineSimilarity: orthogonal vectors score 0', () => {
  assert.ok(Math.abs(cosineSimilarity([1, 0], [0, 1])) < 1e-9);
});

test('cosineSimilarity: opposite vectors score -1', () => {
  assert.ok(Math.abs(cosineSimilarity([1, 0], [-1, 0]) - -1) < 1e-9);
});

test('cosineSimilarity: is scale-invariant (magnitude does not affect the score)', () => {
  const a = cosineSimilarity([1, 2, 3], [4, 5, 6]);
  const b = cosineSimilarity([2, 4, 6], [4, 5, 6]); // same direction as [1,2,3], different magnitude
  assert.ok(Math.abs(a - b) < 1e-9);
});
