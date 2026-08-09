import test from 'node:test';
import assert from 'node:assert/strict';
import { looksCodeRelated } from '../src/router';

test('looksCodeRelated: true for text containing technical keywords', () => {
  assert.equal(looksCodeRelated('Can you check the API endpoint for that service?'), true);
  assert.equal(looksCodeRelated('There was a deployment error in the pipeline.'), true);
  assert.equal(looksCodeRelated('Let\'s look at the git repo and the branch.'), true);
  assert.equal(looksCodeRelated('We need to update the database schema.'), true);
});

test('looksCodeRelated: false for everyday non-technical text', () => {
  assert.equal(looksCodeRelated('Let\'s grab lunch and talk about the quarterly offsite.'), false);
  assert.equal(looksCodeRelated('How was your weekend?'), false);
});

test('looksCodeRelated: is case-insensitive', () => {
  assert.equal(looksCodeRelated('Check the API and the ENDPOINT config.'), true);
});
