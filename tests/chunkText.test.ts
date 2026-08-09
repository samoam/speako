import test from 'node:test';
import assert from 'node:assert/strict';
import { chunkText } from '../src/codebase/chunkText';

test('chunkText: empty input returns no chunks', () => {
  assert.deepEqual(chunkText(''), []);
  assert.deepEqual(chunkText('   '), []);
});

test('chunkText: short text under chunkSize returns a single chunk', () => {
  const text = 'A short paragraph that fits in one chunk.';
  const chunks = chunkText(text, 2000, 200, 100);
  assert.equal(chunks.length, 1);
  assert.equal(chunks[0], text);
});

test('chunkText: splits long text into multiple chunks respecting target size', () => {
  const paragraph = 'This is a sentence that repeats to build up length. ';
  const text = paragraph.repeat(100); // ~5400 chars
  const chunks = chunkText(text, 500, 50, 50);
  assert.ok(chunks.length > 1, 'expected multiple chunks for long input');
  for (const chunk of chunks) {
    // Some slack allowed since splitting prefers separator boundaries over hard cutoffs.
    assert.ok(chunk.length <= 600, `chunk exceeded expected size bound: ${chunk.length}`);
  }
});

test('chunkText: hard-slices a single unsplittable huge token', () => {
  const text = 'x'.repeat(5000); // no separators at all
  const chunks = chunkText(text, 500, 0, 50);
  assert.ok(chunks.length >= 9, `expected the huge token to be hard-sliced into many chunks, got ${chunks.length}`);
  assert.equal(chunks.join(''), text);
});

test('chunkText: merges a trailing short chunk into the previous one', () => {
  // Construct text whose natural split would leave a tiny trailing remainder under minChunk.
  const text = 'A'.repeat(490) + '\n\n' + 'B'.repeat(20);
  const chunks = chunkText(text, 500, 0, 50);
  // The trailing "BBBB..." (20 chars) is under minChunk (50) and should be folded into the prior chunk, not stand alone.
  assert.ok(chunks[chunks.length - 1].includes('B'.repeat(20)));
  assert.ok(!chunks.some((c) => c === 'B'.repeat(20)));
});

test('chunkText: preserves total content across chunk boundaries (ignoring overlap duplication)', () => {
  const text = Array.from({ length: 20 }, (_, i) => `Paragraph number ${i} with some filler words to add length.`).join('\n\n');
  const chunks = chunkText(text, 300, 0, 20);
  const rejoined = chunks.join('');
  for (let i = 0; i < 20; i++) {
    assert.ok(rejoined.includes(`Paragraph number ${i}`), `missing paragraph ${i} in output`);
  }
});
