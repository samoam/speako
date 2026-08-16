import test from 'node:test';
import assert from 'node:assert/strict';
import { buildChatInstruction, buildPracticeInstruction, buildResumeInstruction } from '../src/voice/systemInstructions';
import { PrepBrief } from '../src/storage/prepBriefRepository';

function makeBrief(overrides?: Partial<PrepBrief>): PrepBrief {
  return {
    id: 'brief-1',
    sessionId: 'session-1',
    meetingType: 'one_on_one',
    calendarEventId: null,
    sourcesQueried: [],
    prepBriefText: 'Discuss Q3 goals and the migration timeline.',
    rawContext: [],
    anticipatedQa: null,
    generatedAt: new Date().toISOString(),
    ...overrides,
  };
}

test('buildChatInstruction: describes its real capabilities, including past Speako meetings', () => {
  // Deliberately checking for capabilities in plain language, not exact
  // function names — a previous version hardcoded names like "searchRag"
  // that had already drifted out of sync with the real declared tool names
  // (see liveVoiceSession.ts's PAST_MEETINGS_FUNCTION_NAME/buildFunctionDeclarations),
  // and past Speako meetings weren't even mentioned as a real capability.
  const instruction = buildChatInstruction();
  for (const phrase of ['past Speako meetings', 'Jira', 'Confluence', 'Bitbucket']) {
    assert.ok(instruction.includes(phrase), `expected instruction to mention ${phrase}`);
  }
});

test('buildPracticeInstruction: includes the meeting type, session name, and prep brief text', () => {
  const instruction = buildPracticeInstruction(makeBrief(), 'one_on_one', 'Weekly sync with Sam');
  assert.ok(instruction.includes('one_on_one'));
  assert.ok(instruction.includes('Weekly sync with Sam'));
  assert.ok(instruction.includes('Discuss Q3 goals and the migration timeline.'));
});

test('buildPracticeInstruction: works with no anticipatedQa (prep succeeded without it)', () => {
  const instruction = buildPracticeInstruction(makeBrief({ anticipatedQa: null }), 'generic', null);
  assert.ok(!instruction.includes('undefined'));
  assert.ok(instruction.includes('Discuss Q3 goals'));
});

test('buildPracticeInstruction: weaves in likely questions and questions to ask when present', () => {
  const brief = makeBrief({
    anticipatedQa: {
      likelyQuestions: [{ question: 'Why did you choose this approach?', suggestedAnswer: 'Because X', basedOn: 'ETICK-1' }],
      questionsToAsk: [{ question: 'What about the rollback plan?', why: 'Risk area' }],
    },
  });
  const instruction = buildPracticeInstruction(brief, 'design_dev', 'Design review');
  assert.ok(instruction.includes('Why did you choose this approach?'));
  assert.ok(instruction.includes('What about the rollback plan?'));
});

test('buildResumeInstruction: includes the prior transcript and instructs the model not to re-greet', () => {
  const instruction = buildResumeInstruction('[00:00] You: Let\'s talk about the migration.\n[00:05] Assistant: Sure, what do you want to know?');
  assert.ok(instruction.includes("Let's talk about the migration."));
  assert.ok(instruction.toLowerCase().includes('continuing'));
  assert.ok(instruction.toLowerCase().includes('not greet'));
});
