// Loaded before ts-node compiles/imports any source file, so config.ts's
// required-env-var check passes without needing real GCP credentials.
process.env.GCP_PROJECT_ID = process.env.GCP_PROJECT_ID || 'test-project';
// In-memory DB so tests never touch the real ./data/speako.db.
process.env.DB_PATH = ':memory:';

// Force every optional-integration credential to unset, regardless of what a
// developer's real .env has configured on this machine — config.ts's
// dotenv.config() call never overwrites an already-set process.env value, so
// setting these to '' here (before config.ts loads) wins. Without this, unit
// tests that assert "X is not configured" behavior are silently at the mercy
// of whatever's in the local .env, making them pass/fail depending on whose
// machine runs them rather than on the code under test.
for (const key of [
  'GEMINI_API_KEY',
  'JIRA_URL',
  'JIRA_PERSONAL_TOKEN',
  'CONFLUENCE_URL',
  'CONFLUENCE_USERNAME',
  'CONFLUENCE_API_TOKEN',
  'BITBUCKET_SERVER_URL',
  'BITBUCKET_SERVER_USERNAME',
  'BITBUCKET_SERVER_TOKEN',
  'MEM0_MCP_URL',
  'MEM0_MCP_API_KEY',
  'RAG_MCP_URL',
  'RAG_MCP_API_KEY',
  'GOOGLE_CALENDAR_CREDENTIALS_PATH',
]) {
  process.env[key] = '';
}
