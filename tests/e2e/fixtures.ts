import { E2E_DB_PATH } from './env';

// This file runs in the Playwright test process, a separate Node process
// from the one running the app under test — so seeding here writes to the
// same on-disk SQLite file the server reads/writes (WAL mode allows
// multiple processes to share one DB file safely). Setting these before any
// src/ import matters: dotenv.config() in src/config.ts never overwrites an
// already-set env var, so this reliably wins over whatever's in the real
// .env, exactly like tests/integration/setEnv.js.
process.env.GCP_PROJECT_ID = process.env.GCP_PROJECT_ID || 'test-project';
process.env.DB_PATH = E2E_DB_PATH;

// Lazy require, not a top-level re-export: importing segmentRepository
// eagerly opens db.ts's better-sqlite3 handle as an import-time side
// effect. Playwright loads every spec file during test collection, which
// happens before/around global-setup.ts's cleanup — a top-level import here
// would hold the file open and make that cleanup's unlink() fail with
// EBUSY on Windows. Deferring the require into each function call means the
// handle only opens once a test body actually runs, strictly after global
// setup has already finished.
function repo(): typeof import('../../src/storage/segmentRepository') {
  return require('../../src/storage/segmentRepository');
}

export function createSession(...args: Parameters<typeof import('../../src/storage/segmentRepository').createSession>): void {
  repo().createSession(...args);
}

export function insertFinalSegment(...args: Parameters<typeof import('../../src/storage/segmentRepository').insertFinalSegment>): void {
  repo().insertFinalSegment(...args);
}

export function getSession(...args: Parameters<typeof import('../../src/storage/segmentRepository').getSession>): ReturnType<typeof import('../../src/storage/segmentRepository').getSession> {
  return repo().getSession(...args);
}

export function endSession(...args: Parameters<typeof import('../../src/storage/segmentRepository').endSession>): void {
  repo().endSession(...args);
}
