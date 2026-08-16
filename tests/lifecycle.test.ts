import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeStatusName, toLifecycleState, nextStates, isProposableTransition, assertProposable, LIFECYCLE_GRAPH } from '../src/dev/lifecycle';

test('normalizeStatusName: lowercases and collapses punctuation/whitespace', () => {
  assert.equal(normalizeStatusName('  In-Progress!! '), 'in progress');
  assert.equal(normalizeStatusName('QA_Ready'), 'qa ready');
});

test('toLifecycleState: matches a canonical state name directly', () => {
  assert.equal(toLifecycleState('In Progress'), 'In Progress');
  assert.equal(toLifecycleState('qa ready'), 'QA Ready');
});

test('toLifecycleState: matches via STATE_ALIASES', () => {
  assert.equal(toLifecycleState('To Do'), 'Dev Ready');
  assert.equal(toLifecycleState('Done'), 'Release');
  assert.equal(toLifecycleState('Reopened'), 'Return');
});

test('toLifecycleState: null for a status outside the known graph', () => {
  assert.equal(toLifecycleState('Some Bespoke Project Status'), null);
});

test('nextStates: matches the blueprint\'s fixed lifecycle graph, including the Return loop', () => {
  assert.deepEqual(nextStates('Evaluation'), ['On Hold', 'Dev Ready']);
  assert.deepEqual(nextStates('On Hold'), ['Dev Ready']);
  assert.deepEqual(nextStates('Dev Ready'), ['In Progress']);
  assert.deepEqual(nextStates('In Progress'), ['QA Ready']);
  assert.deepEqual(nextStates('QA Ready'), ['Release', 'Return']);
  assert.deepEqual(nextStates('Return'), ['In Progress']);
  assert.deepEqual(nextStates('Release'), []);
});

test('isProposableTransition / assertProposable: accepts every edge in the graph', () => {
  for (const from of Object.keys(LIFECYCLE_GRAPH) as (keyof typeof LIFECYCLE_GRAPH)[]) {
    for (const to of LIFECYCLE_GRAPH[from]) {
      assert.equal(isProposableTransition(from, to), true);
      assert.doesNotThrow(() => assertProposable(from, to));
    }
  }
});

test('assertProposable: rejects skipping a state (e.g. Evaluation straight to In Progress)', () => {
  assert.equal(isProposableTransition('Evaluation', 'In Progress'), false);
  assert.throws(() => assertProposable('Evaluation', 'In Progress'), /not a valid transition/);
});

test('assertProposable: rejects any transition out of the terminal Release state', () => {
  assert.equal(nextStates('Release').length, 0);
  assert.throws(() => assertProposable('Release', 'Evaluation'), /terminal state/);
});

test('assertProposable: rejects going backwards (e.g. QA Ready to Dev Ready)', () => {
  assert.equal(isProposableTransition('QA Ready', 'Dev Ready'), false);
  assert.throws(() => assertProposable('QA Ready', 'Dev Ready'));
});
