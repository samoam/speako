import test from 'node:test';
import assert from 'node:assert/strict';
import { saveChapters, getChapters } from '../src/storage/chaptersRepository';
import { createSession } from '../src/storage/segmentRepository';

test('chaptersRepository: getChapters returns undefined when nothing saved', () => {
  createSession('ch-none', ['en-US'], 'No Chapters', { sessionType: 'personal' });
  assert.equal(getChapters('ch-none'), undefined);
});

test('chaptersRepository: save then get round-trips chapters', () => {
  createSession('ch-basic', ['en-US'], 'Basic', { sessionType: 'personal' });
  const chapters = [
    { startMs: 0, title: 'Kickoff', summary: 'Opening.' },
    { startMs: 60000, title: 'Deep dive', summary: 'Main discussion.' },
  ];
  const saved = saveChapters('ch-basic', chapters);
  assert.equal(saved.sessionId, 'ch-basic');
  assert.ok(saved.generatedAt);

  const fetched = getChapters('ch-basic');
  assert.deepEqual(fetched!.chapters, chapters);
});

test('chaptersRepository: saving again for the same session upserts rather than duplicating', () => {
  createSession('ch-upsert', ['en-US'], 'Upsert', { sessionType: 'personal' });
  saveChapters('ch-upsert', [{ startMs: 0, title: 'First', summary: 'a' }]);
  saveChapters('ch-upsert', [{ startMs: 0, title: 'Second', summary: 'b' }]);

  const fetched = getChapters('ch-upsert');
  assert.equal(fetched!.chapters.length, 1);
  assert.equal(fetched!.chapters[0].title, 'Second');
});
