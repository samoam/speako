import test from 'node:test';
import assert from 'node:assert/strict';
import { isToolActive, ALL_TOOL_KEYS } from '../src/tools/activeTools';

test('isToolActive: null activeTools means every tool is active', () => {
  for (const tool of ALL_TOOL_KEYS) {
    assert.equal(isToolActive(null, tool), true);
  }
});

test('isToolActive: explicit list only activates listed tools', () => {
  assert.equal(isToolActive(['jira', 'confluence'], 'jira'), true);
  assert.equal(isToolActive(['jira', 'confluence'], 'confluence'), true);
  assert.equal(isToolActive(['jira', 'confluence'], 'bitbucket'), false);
});

test('isToolActive: empty list means no tools are active', () => {
  for (const tool of ALL_TOOL_KEYS) {
    assert.equal(isToolActive([], tool), false);
  }
});

test('ALL_TOOL_KEYS includes every expected tool exactly once', () => {
  const expected = ['jira', 'confluence', 'bitbucket', 'mem0', 'ragCloud', 'localCodebase', 'webSearch', 'email', 'teams'];
  assert.deepEqual([...ALL_TOOL_KEYS].sort(), [...expected].sort());
  assert.equal(new Set(ALL_TOOL_KEYS).size, ALL_TOOL_KEYS.length);
});
