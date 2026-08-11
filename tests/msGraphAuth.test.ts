import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as path from 'path';
import { config } from '../src/config';
import { updateSettings } from '../src/settingsStore';
import { isMsGraphConfigured, getGraphAccessToken } from '../src/integrations/msGraphAuth';

const tokenPath = path.join(process.cwd(), 'data', 'test-msgraph-token.json');

test.afterEach(() => {
  updateSettings({ msGraphClientId: '', msGraphTokenPath: '' });
  if (fs.existsSync(tokenPath)) fs.unlinkSync(tokenPath);
});

test('isMsGraphConfigured: false when clientId is unset', () => {
  updateSettings({ msGraphClientId: '', msGraphTokenPath: tokenPath });
  assert.equal(isMsGraphConfigured(), false);
});

test('isMsGraphConfigured: false when clientId is set but the token cache file does not exist yet (auth script not run)', () => {
  updateSettings({ msGraphClientId: 'test-client-id', msGraphTokenPath: tokenPath });
  assert.equal(fs.existsSync(tokenPath), false);
  assert.equal(isMsGraphConfigured(), false);
});

test('isMsGraphConfigured: true once both clientId is set and the token cache file exists', () => {
  fs.mkdirSync(path.dirname(tokenPath), { recursive: true });
  fs.writeFileSync(tokenPath, '{}');
  updateSettings({ msGraphClientId: 'test-client-id', msGraphTokenPath: tokenPath });
  assert.equal(isMsGraphConfigured(), true);
});

test('getGraphAccessToken: throws a clear "not configured" error when unset, rather than an MSAL internals error', async () => {
  updateSettings({ msGraphClientId: '', msGraphTokenPath: tokenPath });
  await assert.rejects(() => getGraphAccessToken(), /not configured/i);
});

test('getGraphAccessToken: throws a clear "sign in again" error when configured but no account is cached', async () => {
  fs.mkdirSync(path.dirname(tokenPath), { recursive: true });
  fs.writeFileSync(tokenPath, '{}'); // valid-looking but empty MSAL cache — no accounts
  updateSettings({ msGraphClientId: 'test-client-id', msGraphTokenPath: tokenPath });
  await assert.rejects(() => getGraphAccessToken(), /msgraph-auth/i);
});
