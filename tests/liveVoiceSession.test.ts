import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import { buildFunctionDeclarations, VOICE_TOOL_KEYS, LiveVoiceSession } from '../src/voice/liveVoiceSession';
import * as ragModule from '../src/rag/rag';

test('buildFunctionDeclarations: one search_<tool> function per tool, with a query parameter', () => {
  const declarations = buildFunctionDeclarations(['jira', 'mem0']);
  assert.equal(declarations.length, 2);

  const jira = declarations.find((d) => d.name === 'search_jira');
  assert.ok(jira);
  assert.equal(typeof jira.description, 'string');
  assert.equal(jira.parametersJsonSchema.type, 'object');
  assert.deepEqual(jira.parametersJsonSchema.required, ['query']);
  assert.equal(jira.parametersJsonSchema.properties.query.type, 'string');

  const mem0 = declarations.find((d) => d.name === 'search_mem0');
  assert.ok(mem0);
});

test('buildFunctionDeclarations: empty input returns no declarations', () => {
  assert.deepEqual(buildFunctionDeclarations([]), []);
});

test('VOICE_TOOL_KEYS: matches the confirmed voice-grounding scope (no email/teams/webSearch)', () => {
  assert.deepEqual(new Set(VOICE_TOOL_KEYS), new Set(['jira', 'confluence', 'mem0', 'ragCloud', 'bitbucket', 'localCodebase']));
});

// search_pastMeetings is dispatched separately from the VOICE_TOOL_KEYS/
// searchByTool path (see liveVoiceSession.ts's own comment on why) — these
// tests exist because that tool was missing entirely until this session,
// which is exactly what let the "chat doesn't know about my meetings" bug
// through unnoticed.
test('LiveVoiceSession: dispatches search_pastMeetings via rag.ts\'s retrieve(), not the tool catalog', async () => {
  const retrieveSpy = mock.method(ragModule, 'retrieve', async (query: string) => {
    assert.equal(query, 'the migration discussion');
    return {
      suppressed: false,
      chunks: [{ sessionName: 'Sprint Review', text: 'We discussed the migration timeline.' }],
    };
  });
  try {
    const session = new LiveVoiceSession({ systemInstruction: 'test' });
    let sentResponse: any = null;
    (session as any).session = { sendToolResponse: (r: any) => (sentResponse = r) };

    await (session as any).handleMessage({
      toolCall: { functionCalls: [{ id: 'call-1', name: 'search_pastMeetings', args: { query: 'the migration discussion' } }] },
    });

    assert.equal(retrieveSpy.mock.callCount(), 1);
    const output = sentResponse.functionResponses[0].response.output;
    assert.match(output, /Sprint Review/);
    assert.match(output, /migration timeline/);
  } finally {
    retrieveSpy.mock.restore();
  }
});

test('LiveVoiceSession: search_pastMeetings reports no-match plainly instead of an empty/confusing result', async () => {
  const retrieveSpy = mock.method(ragModule, 'retrieve', async () => ({ suppressed: true, chunks: [] }));
  try {
    const session = new LiveVoiceSession({ systemInstruction: 'test' });
    let sentResponse: any = null;
    (session as any).session = { sendToolResponse: (r: any) => (sentResponse = r) };

    await (session as any).handleMessage({
      toolCall: { functionCalls: [{ id: 'call-1', name: 'search_pastMeetings', args: { query: 'something obscure' } }] },
    });

    assert.match(sentResponse.functionResponses[0].response.output, /no past meetings/i);
  } finally {
    retrieveSpy.mock.restore();
  }
});
