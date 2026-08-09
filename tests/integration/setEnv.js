// Unlike tests/setEnv.js (which deliberately blanks every credential for
// hermetic unit tests), this one leaves the real .env's credentials intact —
// that's the whole point of the integration tier: hit real Jira/Confluence/
// Bitbucket/Gemini/mem0/MyRAG with whatever's actually configured. Individual
// tests skip themselves (via isXConfigured() checks) when a given service
// isn't configured on the machine running them.
process.env.GCP_PROJECT_ID = process.env.GCP_PROJECT_ID || 'test-project';
process.env.DB_PATH = ':memory:';
