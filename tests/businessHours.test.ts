import test from 'node:test';
import assert from 'node:assert/strict';
import { isHourWithinRange } from '../src/util/businessHours';

test('isHourWithinRange: true inside the window', () => {
  assert.equal(isHourWithinRange(8, 8, 18), true);
  assert.equal(isHourWithinRange(12, 8, 18), true);
  assert.equal(isHourWithinRange(17, 8, 18), true);
});

test('isHourWithinRange: false at/after the end hour and before the start hour', () => {
  assert.equal(isHourWithinRange(18, 8, 18), false);
  assert.equal(isHourWithinRange(23, 8, 18), false);
  assert.equal(isHourWithinRange(7, 8, 18), false);
  assert.equal(isHourWithinRange(0, 8, 18), false);
});
