import test from 'node:test';
import assert from 'node:assert/strict';
import { jobPathFor, isJenkinsConfigured } from '../src/integrations/jenkinsClient';
import { updateSettings } from '../src/settingsStore';

test.afterEach(() => updateSettings({ jenkinsUrl: '', jenkinsUser: '', jenkinsApiToken: '' }));

test('isJenkinsConfigured: false until url/user/token are all set', () => {
  assert.equal(isJenkinsConfigured(), false);
  updateSettings({ jenkinsUrl: 'https://jenkins.example.com' });
  assert.equal(isJenkinsConfigured(), false);
  updateSettings({ jenkinsUser: 'madadi' });
  assert.equal(isJenkinsConfigured(), false);
  updateSettings({ jenkinsApiToken: 'tok' });
  assert.equal(isJenkinsConfigured(), true);
});

test('jobPathFor: a plain folder path with no branch', () => {
  assert.equal(jobPathFor('Team/officercc'), '/job/Team/job/officercc');
});

test('jobPathFor: encodes a branch name\'s slashes as %2F, addressing it as one path segment', () => {
  assert.equal(jobPathFor('Team/officercc', 'feature/PROJ-1-x'), '/job/Team/job/officercc/job/feature%2FPROJ-1-x');
});

test('jobPathFor: encodes special characters in folder/branch segments', () => {
  assert.equal(jobPathFor('My Team'), '/job/My%20Team');
});

test('jobPathFor: strips empty segments from a folder path with leading/trailing/double slashes', () => {
  assert.equal(jobPathFor('/Team//officercc/'), '/job/Team/job/officercc');
});
