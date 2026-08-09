import test from 'node:test';
import assert from 'node:assert/strict';
import { config } from '../src/config';
import { updateSettings, onSettingsChanged } from '../src/settingsStore';

test('settingsStore: overriding a dynamic config field takes effect immediately', () => {
  const before = config.geminiModel;
  updateSettings({ geminiModel: 'custom-test-model' });
  assert.equal(config.geminiModel, 'custom-test-model');
  assert.notEqual(config.geminiModel, before === 'custom-test-model' ? undefined : before);
});

test('settingsStore: an empty-string value clears the override, falling back to env/default', () => {
  updateSettings({ geminiModel: 'temporary-override' });
  assert.equal(config.geminiModel, 'temporary-override');

  updateSettings({ geminiModel: '' });
  assert.equal(config.geminiModel, process.env.GEMINI_MODEL || 'gemini-flash-latest');
});

test('settingsStore: numeric dynamic fields round-trip through string storage', () => {
  updateSettings({ ragTopK: '9' });
  assert.equal(config.ragTopK, 9);
  updateSettings({ ragTopK: '' });
});

test('settingsStore: boolean dynamic fields respect explicit "false"', () => {
  updateSettings({ waveformEnabled: 'false' });
  assert.equal(config.waveformEnabled, false);
  updateSettings({ waveformEnabled: '' });
  assert.equal(config.waveformEnabled, true); // default
});

test('settingsStore: onSettingsChanged listeners fire on every updateSettings call', () => {
  let callCount = 0;
  onSettingsChanged(() => {
    callCount++;
  });
  updateSettings({ geminiModel: 'x' });
  updateSettings({ geminiModel: '' });
  assert.equal(callCount, 2);
});
