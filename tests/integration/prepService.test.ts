import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { config } from '../../src/config';
import { isJiraConfigured } from '../../src/integrations/jiraMcp';
import { isConfluenceConfigured } from '../../src/integrations/confluenceMcp';
import { getAtlassianClient } from '../../src/integrations/atlassianMcp';
import { closeRagClient } from '../../src/integrations/ragClient';
import { createSession } from '../../src/storage/segmentRepository';
import { getPrepBrief } from '../../src/storage/prepBriefRepository';
import { runPrep } from '../../src/prep/PrepService';

const canRunPrep = config.geminiApiKey && (isJiraConfigured() || isConfluenceConfigured());

test(
  'runPrep: a real design_dev prep run against real Jira/Confluence synthesizes a real brief',
  { skip: !canRunPrep, timeout: 90_000 },
  async () => {
    const sessionId = `integration-prep-${Math.floor(Math.random() * 1e9)}`;
    createSession(sessionId, ['en-US'], 'Integration test session', {
      sessionType: 'work',
      meetingType: 'design_dev',
    });

    await runPrep({
      sessionId,
      sessionName: 'Integration test session',
      meetingType: 'design_dev',
      activeTools: null,
    });

    const brief = getPrepBrief(sessionId);
    assert.ok(brief, 'expected a prep brief to be persisted');
    assert.equal(typeof brief!.prepBriefText, 'string');
    assert.ok(brief!.prepBriefText.trim().length > 0);
    console.log(`[integration] prep brief sources_queried: ${brief!.sourcesQueried.join(', ')}`);
  }
);

after(() => {
  if (isJiraConfigured() || isConfluenceConfigured()) {
    getAtlassianClient().close();
  }
  // design_dev's workflow also queries ragCloud (see designDev.ts) — same
  // open-connection issue as mem0RagCloud.test.ts if left uncleaned.
  closeRagClient();
});
