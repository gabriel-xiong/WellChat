import assert from 'node:assert/strict';
import test from 'node:test';
import { getEventDateScope } from './event-time';

const fridayInChicago = new Date('2026-11-20T18:00:00Z');

test('resolves relative event periods in the Austin timezone', () => {
  assert.equal(
    getEventDateScope('What is happening this week?', fridayInChicago),
    '“this week” means Monday, November 16, 2026 through Sunday, November 22, 2026 in Austin time.'
  );
  assert.equal(
    getEventDateScope('What events are happening next week?', fridayInChicago),
    '“next week” means Monday, November 23, 2026 through Sunday, November 29, 2026 in Austin time.'
  );
  assert.equal(
    getEventDateScope('What is happening this weekend?', fridayInChicago),
    '“this weekend” means Friday, November 20, 2026 through Sunday, November 22, 2026 in Austin time.'
  );
  assert.equal(
    getEventDateScope('What is happening next weekend?', fridayInChicago),
    '“next weekend” means Friday, November 27, 2026 through Sunday, November 29, 2026 in Austin time.'
  );
});

test('does not add a calendar scope to non-relative event questions', () => {
  assert.equal(getEventDateScope('What events are in November?', fridayInChicago), null);
});
