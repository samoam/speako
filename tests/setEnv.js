// Loaded before ts-node compiles/imports any source file, so config.ts's
// required-env-var check passes without needing real GCP credentials.
process.env.GCP_PROJECT_ID = process.env.GCP_PROJECT_ID || 'test-project';
