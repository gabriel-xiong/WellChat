import assert from 'node:assert/strict';
import test from 'node:test';
import { classifyQuestion } from './chat-analytics';

test('specific multiword intents beat broad overlapping keywords', () => {
  assert.equal(classifyQuestion('How do I visit a community group?'), 'community');
  assert.equal(classifyQuestion('Are there events after the Sunday service?'), 'sundays');
});

test('classifies job and career questions independently from staff', () => {
  assert.equal(classifyQuestion('Are there any careers at The Well?'), 'jobs');
  assert.equal(classifyQuestion('Who is on the staff team?'), 'staff');
});

test('keeps high-priority safety categories ahead when phrases tie', () => {
  assert.equal(classifyQuestion('I want to hurt myself and need someone to talk to'), 'crisis');
});
