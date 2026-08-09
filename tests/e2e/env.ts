import path from 'path';

// Shared between playwright.config.ts (spawns the server with these) and
// global-setup.ts/fixtures.ts (which need to know where the server's DB
// file lives to reset/seed it directly).
export const E2E_PORT = 3100;
export const E2E_DB_PATH = path.join(__dirname, '..', '..', 'data', 'speako-e2e.db');
