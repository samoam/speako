/**
 * One-time Google Calendar OAuth setup. Run with `npm run gcal-auth` after
 * setting GOOGLE_CALENDAR_CREDENTIALS_PATH in .env to point at an OAuth
 * "Desktop app" client secret JSON downloaded from the Google Cloud Console
 * (APIs & Services > Credentials). Spins up a temporary local server to
 * catch the OAuth redirect, exchanges the code for a refresh token, and
 * saves it to GOOGLE_CALENDAR_TOKEN_PATH (default ./data/gcal-token.json,
 * gitignored — never commit this file, it's a live credential).
 */
import * as fs from 'fs';
import * as http from 'http';
import { google } from 'googleapis';
import { config } from '../src/config';

const REDIRECT_PORT = 51823;
const REDIRECT_URI = `http://localhost:${REDIRECT_PORT}/oauth2callback`;
const SCOPES = ['https://www.googleapis.com/auth/calendar.readonly'];

async function main() {
  if (!config.googleCalendarCredentialsPath) {
    console.error('Set GOOGLE_CALENDAR_CREDENTIALS_PATH in .env first — see README.md.');
    process.exit(1);
  }

  const raw = JSON.parse(fs.readFileSync(config.googleCalendarCredentialsPath, 'utf-8'));
  const creds = raw.installed || raw.web;
  const client = new google.auth.OAuth2(creds.client_id, creds.client_secret, REDIRECT_URI);

  const authUrl = client.generateAuthUrl({ access_type: 'offline', scope: SCOPES, prompt: 'consent' });

  const code: string = await new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      const url = new URL(req.url || '', REDIRECT_URI);
      const code = url.searchParams.get('code');
      res.end(code ? 'Authorized — you can close this tab.' : 'Missing code.');
      server.close();
      if (code) resolve(code);
      else reject(new Error('No authorization code received'));
    });
    server.listen(REDIRECT_PORT, () => {
      console.log('Open this URL in your browser and approve access:\n');
      console.log(authUrl);
      console.log(`\nWaiting for the redirect on ${REDIRECT_URI} ...`);
    });
  });

  const { tokens } = await client.getToken(code);
  fs.mkdirSync(require('path').dirname(config.googleCalendarTokenPath), { recursive: true });
  fs.writeFileSync(config.googleCalendarTokenPath, JSON.stringify(tokens, null, 2));
  console.log(`\nSaved token to ${config.googleCalendarTokenPath}. Calendar integration is now active.`);
}

main().catch((err) => {
  console.error('gcal-auth failed:', err.message);
  process.exit(1);
});
