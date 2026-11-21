import assert from 'node:assert/strict';
import test from 'node:test';
import { buildInitialFallbackAnswer, classifyFallbackIntent } from './fallback-response';

test('distinguishes undocumented church information from out-of-scope questions', () => {
  assert.equal(classifyFallbackIntent('What classes can I sign up for?', 'other'), 'church_information_missing');
  assert.equal(classifyFallbackIntent('What is the doctrine on baptism?', 'beliefs'), 'church_information_missing');
  assert.equal(classifyFallbackIntent('Who is winning the Super Bowl?', 'other'), 'out_of_scope');
});

test('explains the correct reason for an initial fallback', () => {
  const contact = 'info@thewellaustin.com';
  assert.match(buildInitialFallbackAnswer('What classes can I sign up for?', 'other', contact), /couldn't find published information/i);
  assert.match(buildInitialFallbackAnswer('Who is winning the Super Bowl?', 'other', contact), /can help with information published by The Well/i);
});
