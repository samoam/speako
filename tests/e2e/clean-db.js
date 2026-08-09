// Run before Playwright starts (see package.json's "pretest:e2e"), not as
// Playwright's own globalSetup — Playwright starts webServer as part of its
// internal plugin-setup tasks BEFORE running a configured globalSetup file,
// so by the time a globalSetup-based cleanup ran, the server had already
// created and opened this exact file, and unlink() failed with EBUSY on
// Windows. A separate process that runs and exits before `playwright test`
// is invoked at all sidesteps that ordering entirely.
const fs = require('fs');
const path = require('path');

const dbPath = path.join(__dirname, '..', '..', 'data', 'speako-e2e.db');
for (const suffix of ['', '-wal', '-shm']) {
  const file = dbPath + suffix;
  if (fs.existsSync(file)) fs.unlinkSync(file);
}
