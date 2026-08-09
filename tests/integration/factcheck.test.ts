import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { config } from '../../src/config';
import { isJiraConfigured } from '../../src/integrations/jiraMcp';
import { isConfluenceConfigured } from '../../src/integrations/confluenceMcp';
import { getAtlassianClient } from '../../src/integrations/atlassianMcp';
import { createSession } from '../../src/storage/segmentRepository';
import { factCheckClaim, isAnyFactCheckSourceConfigured } from '../../src/factcheck/factcheck';

const canFactCheck = config.geminiApiKey && isAnyFactCheckSourceConfigured();

test(
  'factCheckClaim: a real claim against real Jira/Confluence returns a valid result shape',
  { skip: !canFactCheck, timeout: 90_000 },
  async () => {
    const sessionId = `integration-factcheck-${Math.floor(Math.random() * 1e9)}`;
    createSession(sessionId, ['en-US'], 'Integration factcheck session', { sessionType: 'work' });

    // factCheckClaim throws on a Gemini API error rather than failing soft —
    // correct in the real app, since both call sites (session.ts, server.ts)
    // already catch it. Retry once here so a transient 503 doesn't fail this
    // test over something the app already handles.
    let outcome;
    try {
      outcome = await factCheckClaim('The project uses a SQLite database for storage.', sessionId);
    } catch (err: any) {
      if (!/503|UNAVAILABLE/.test(err.message ?? '')) throw err;
      console.log('[integration] transient Gemini 503, retrying once...');
      outcome = await factCheckClaim('The project uses a SQLite database for storage.', sessionId);
    }

    // Real ticket/wiki data drifts over time, so this only asserts a valid
    // shape comes back (or null, when nothing applicable was found) — not a
    // specific verdict.
    if (outcome) {
      assert.ok(['match', 'conflict', 'insufficient'].includes(outcome.result));
      assert.equal(typeof outcome.sourceQueried, 'string');
      console.log(`[integration] factCheckClaim result: ${outcome.result} (source: ${outcome.sourceQueried})`);
    } else {
      console.log('[integration] factCheckClaim returned null (no applicable source found for the claim)');
    }
  }
);

after(() => {
  if (isJiraConfigured() || isConfluenceConfigured()) {
    getAtlassianClient().close();
  }
});
