import { _setConfigOverrides } from './config';
import { getAllSettings, setSetting, deleteSetting } from './storage/settingsRepository';

const listeners: Array<() => void> = [];

/** Notified whenever settings change, so cached clients (Gemini, Jira/Confluence, mem0, rag) can invalidate. */
export function onSettingsChanged(cb: () => void): void {
  listeners.push(cb);
}

/** Empty value clears that key's override, falling back to .env/default. */
export function updateSettings(patch: Record<string, string>): void {
  for (const [key, value] of Object.entries(patch)) {
    if (!value) deleteSetting(key);
    else setSetting(key, value);
  }
  _setConfigOverrides(getAllSettings());
  listeners.forEach((cb) => cb());
}

// Self-initializing on first import, same pattern as db.ts's eager setup.
_setConfigOverrides(getAllSettings());
