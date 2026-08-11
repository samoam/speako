/**
 * One-time Microsoft Graph device-code sign-in. Run with `npm run msgraph-auth`
 * after setting MS_GRAPH_CLIENT_ID in .env to an Azure AD app registration's
 * Application (client) ID — register one at https://entra.microsoft.com
 * (App registrations > New registration), no redirect URI needed since this
 * uses the device-code flow, and under Authentication enable "Allow public
 * client flows". Add the delegated API permissions Mail.Read + Chat.Read
 * under API permissions (user consent is enough — no admin approval needed
 * for these two). No client secret is created or used — device-code is a
 * public-client flow by design, which is what makes it safe for a local app
 * to hold.
 *
 * Saves the resulting token cache to MS_GRAPH_TOKEN_PATH (default
 * ./data/msgraph-token.json, gitignored — never commit this file).
 */
import { config } from '../src/config';
import { createGraphClientApp, MS_GRAPH_SCOPES } from '../src/integrations/msGraphAuth';

async function main() {
  if (!config.msGraphClientId) {
    console.error('Set MS_GRAPH_CLIENT_ID in .env first — see NOTES.md.');
    process.exit(1);
  }

  const app = createGraphClientApp();

  const result = await app.acquireTokenByDeviceCode({
    scopes: MS_GRAPH_SCOPES,
    deviceCodeCallback: (response: any) => {
      const verificationUri = response.verificationUri ?? response.verification_uri;
      const userCode = response.userCode ?? response.user_code;
      if (!verificationUri || !userCode) {
        console.log('\n[debug] unexpected device code response shape:', JSON.stringify(response));
      }
      console.log('\nTo sign in, open this URL in a browser and enter the code below:\n');
      console.log(`  ${verificationUri}`);
      console.log(`\n  Code: ${userCode}\n`);
      console.log('Waiting for sign-in...');
    },
  });

  if (!result) {
    console.error('Sign-in did not complete — no token returned.');
    process.exit(1);
  }

  console.log(`\nSigned in as ${result.account?.username}. Saved token cache to ${config.msGraphTokenPath}.`);
  console.log('Outlook/Teams sync is now active — it runs automatically in the background while Speako is running.');
}

main().catch((err) => {
  console.error('msgraph-auth failed:', err.message);
  if (err.errorCode) console.error('  errorCode:', err.errorCode);
  if (err.subError) console.error('  subError:', err.subError);
  if (err.errorMessage) console.error('  errorMessage:', err.errorMessage);
  process.exit(1);
});
