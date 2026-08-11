import * as fs from 'fs';
import * as path from 'path';
import { PublicClientApplication, ICachePlugin } from '@azure/msal-node';
import { config } from '../config';

/**
 * Delegated permissions requested for native Outlook/Teams ingestion — see
 * NOTES.md. offline_access is what lets acquireTokenSilent refresh without a
 * repeat sign-in. User.Read isn't used by the sync itself, but self-service
 * account diagnostics (license/mailbox checks when Mail.Read/Chat.Read fail
 * mysteriously) need it — it's virtually always pre-approved on an app
 * registration, so requesting it doesn't add real friction.
 */
export const MS_GRAPH_SCOPES = ['Mail.Read', 'Chat.Read', 'User.Read', 'offline_access'];

export function isMsGraphConfigured(): boolean {
  return !!(config.msGraphClientId && fs.existsSync(config.msGraphTokenPath));
}

/** Persists MSAL's serialized cache to disk between runs — msal-node has no built-in file persistence, unlike googleapis' plain JSON token file (googleCalendar.ts). */
function fileCachePlugin(tokenPath: string): ICachePlugin {
  return {
    beforeCacheAccess: async (context) => {
      if (fs.existsSync(tokenPath)) context.tokenCache.deserialize(fs.readFileSync(tokenPath, 'utf-8'));
    },
    afterCacheAccess: async (context) => {
      if (context.cacheHasChanged) {
        fs.mkdirSync(path.dirname(tokenPath), { recursive: true });
        fs.writeFileSync(tokenPath, context.tokenCache.serialize());
      }
    },
  };
}

export function createGraphClientApp(tokenPath: string = config.msGraphTokenPath): PublicClientApplication {
  return new PublicClientApplication({
    auth: {
      clientId: config.msGraphClientId,
      authority: `https://login.microsoftonline.com/${config.msGraphTenantId}`,
    },
    cache: { cachePlugin: fileCachePlugin(tokenPath) },
  });
}

/**
 * Silently refreshes a cached token (from the one-time `npm run msgraph-auth`
 * device-code sign-in) into a fresh access token — throws if nothing's been
 * authorized yet, same "feature not set up" signal as isMsGraphConfigured()
 * returning false, but for callers that need the actual token.
 */
export async function getGraphAccessToken(): Promise<string> {
  if (!isMsGraphConfigured()) {
    throw new Error('Microsoft Graph is not configured — run `npm run msgraph-auth` first (see NOTES.md).');
  }
  const app = createGraphClientApp();
  const accounts = await app.getTokenCache().getAllAccounts();
  if (accounts.length === 0) {
    throw new Error('No signed-in Microsoft account found in the token cache — run `npm run msgraph-auth` again.');
  }
  const result = await app.acquireTokenSilent({ account: accounts[0], scopes: MS_GRAPH_SCOPES });
  if (!result?.accessToken) {
    throw new Error('Failed to acquire a Microsoft Graph access token.');
  }
  return result.accessToken;
}
