import assert from 'node:assert/strict';
import { test } from 'node:test';
import { patchConsole, getLogBuffer, onLogEntry } from '../src/logging/logStore';

test('patchConsole captures console.log/warn/error into the buffer and notifies listeners', () => {
  patchConsole();

  const captured: any[] = [];
  const unsubscribe = onLogEntry((entry) => captured.push(entry));

  const marker = `marker-${Math.random()}`;
  console.log(marker, 'plain string');
  console.warn(marker, 'warn message');
  console.error(marker, 'error message');
  unsubscribe();

  assert.equal(captured.length, 3);
  assert.equal(captured[0].level, 'log');
  assert.equal(captured[0].message, `${marker} plain string`);
  assert.equal(captured[1].level, 'warn');
  assert.equal(captured[2].level, 'error');
  assert.ok(typeof captured[0].timestamp === 'string' && !Number.isNaN(Date.parse(captured[0].timestamp)));
  assert.ok(captured[1].seq > captured[0].seq);

  const buffer = getLogBuffer();
  const tail = buffer.slice(-3);
  assert.deepEqual(tail, captured);
});

test('console.log still writes to the real console when patched (not swallowed)', () => {
  patchConsole();
  const original = console.log;
  let sawCall = false;
  console.log = (...args: unknown[]) => {
    sawCall = true;
    return original.apply(console, args);
  };
  try {
    console.log('still-visible');
  } finally {
    console.log = original;
  }
  assert.ok(sawCall);
});

test('getLogBuffer caps at 500 entries, evicting the oldest', () => {
  patchConsole();

  for (let i = 0; i < 520; i++) {
    console.log(`cap-test-${i}`);
  }

  const buffer = getLogBuffer();
  assert.equal(buffer.length, 500);
  assert.equal(buffer[buffer.length - 1].message, 'cap-test-519');
  assert.ok(!buffer.some((e) => e.message === 'cap-test-0'));
});

test('formats non-string args (objects, Errors) into readable messages', () => {
  patchConsole();

  const captured: any[] = [];
  const unsubscribe = onLogEntry((entry) => captured.push(entry));
  console.log({ a: 1 });
  console.error(new Error('boom'));
  unsubscribe();

  assert.equal(captured[0].message, '{"a":1}');
  assert.match(captured[1].message, /boom/);
});
