import assert from 'node:assert/strict';
import test from 'node:test';
import { isGeneratedFallback } from './chat-quality';

test('recognizes model-generated fallback answers for dashboard reporting', () => {
  assert.equal(isGeneratedFallback("I don't have information on specific events happening in November 2026."), true);
  assert.equal(isGeneratedFallback("I can't answer that based on what I know."), true);
  assert.equal(isGeneratedFallback('The requested information is not available in the provided context.'), true);
});

test('does not classify grounded answers as fallbacks', () => {
  assert.equal(isGeneratedFallback('Students November Hang is on November 20 from 6:00 PM to 8:00 PM.'), false);
});
