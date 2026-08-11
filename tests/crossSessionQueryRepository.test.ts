import test from 'node:test';
import assert from 'node:assert/strict';
import { insertCrossSessionQuery, getCrossSessionQueryHistory } from '../src/storage/crossSessionQueryRepository';

test('crossSessionQueryRepository: insert then history round-trips fields, newest first', () => {
  const marker = `csq-${Date.now()}`;
  insertCrossSessionQuery({ questionText: `${marker} first question`, answerText: 'answer one', sourcesUsed: ['Session A'] });
  const second = insertCrossSessionQuery({ questionText: `${marker} second question`, answerText: 'answer two', sourcesUsed: [] });

  assert.equal(second.questionText, `${marker} second question`);
  assert.ok(second.askedAt);

  const history = getCrossSessionQueryHistory();
  const marked = history.filter((h) => h.questionText.startsWith(marker));
  assert.equal(marked.length, 2);
  assert.equal(marked[0].questionText, `${marker} second question`, 'expected newest-first ordering');
  assert.deepEqual(marked[1].sourcesUsed, ['Session A']);
});
