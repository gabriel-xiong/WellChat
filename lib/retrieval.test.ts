import assert from 'node:assert/strict';
import test from 'node:test';
import {
  MatchDocument,
  mergeRetrievalCandidates,
  rerankChunks,
  selectLexicalSearchTerms,
} from './retrieval';

function chunk(overrides: Partial<MatchDocument>): MatchDocument {
  return {
    id: crypto.randomUUID(),
    url: 'https://thewellaustin.com/resources',
    title: 'Resources',
    section: 'Resources',
    content: 'General resources from The Well.',
    depth: 'deep',
    last_indexed_at: null,
    similarity: 0.4,
    ...overrides,
  };
}

test('selects subject terms while removing generic request language', () => {
  assert.deepEqual(selectLexicalSearchTerms('any resources on lament?'), ['lament']);
  assert.deepEqual(selectLexicalSearchTerms('Do you have sermons about lament?'), ['lament']);
  assert.deepEqual(selectLexicalSearchTerms('What information do you have about the retreat?'), ['retreat']);
});

test('expands relative event dates without treating broad phrasing as search terms', () => {
  const november = new Date('2026-11-01T18:00:00Z');
  assert.deepEqual(
    selectLexicalSearchTerms('What events are happening this month?', 4, november),
    ['events', 'november', 'nov']
  );
  assert.deepEqual(
    selectLexicalSearchTerms('What is happening this month?', 4, november),
    ['events', 'november', 'nov']
  );
  assert.deepEqual(
    selectLexicalSearchTerms('What events are happening in November?', 4, november),
    ['events', 'november', 'nov']
  );
});

test('uses the church timezone when resolving this month', () => {
  const stillOctoberInAustin = new Date('2026-11-01T03:30:00Z');
  assert.deepEqual(
    selectLexicalSearchTerms('events this month', 4, stillOctoberInAustin),
    ['events', 'october', 'oct']
  );
});

test('lexical candidates survive vector candidate exclusion and rerank first', () => {
  const generic = chunk({ id: 'generic', similarity: 0.43 });
  const lament = chunk({
    id: 'lament',
    url: 'https://thewellaustin.com/sermons/lament',
    title: 'Lament - The Well Austin Community Church',
    section: 'Psalm',
    content: 'Lament teaches us how to suffer without losing hope.',
    similarity: 0.25,
    lexicalMatch: true,
  });
  const merged = mergeRetrievalCandidates([generic], [lament]);
  assert.deepEqual(merged.map((candidate) => candidate.id), ['generic', 'lament']);
  assert.equal(rerankChunks('any resources on lament?', merged, 1)[0].id, 'lament');
});

test('merging marks duplicate vector candidates without discarding cosine similarity', () => {
  const vector = chunk({ id: 'same', similarity: 0.61 });
  const lexical = chunk({ id: 'same', similarity: 0.25, lexicalMatch: true });
  const merged = mergeRetrievalCandidates([vector], [lexical]);
  assert.equal(merged.length, 1);
  assert.equal(merged[0].similarity, 0.61);
  assert.equal(merged[0].lexicalMatch, true);
});

test('direct collection pages outrank secondary stories for a one-word subject', () => {
  const story = chunk({
    id: 'story',
    url: 'https://thewellaustin.com/stories/finding-belonging-at-the-college-retreat',
    title: 'Finding Belonging at the College Retreat',
    similarity: 0.25,
    lexicalMatch: true,
  });
  const currentRetreat = chunk({
    id: 'current-retreat',
    url: 'https://thewellaustin.com/retreats/2026',
    title: "2026 Women's and Men's Retreats",
    similarity: 0.25,
    lexicalMatch: true,
  });
  assert.equal(rerankChunks('Retreat', [story, currentRetreat], 1)[0].id, 'current-retreat');
});

test('time-bearing Sunday chunk outranks same-page parking chunks for service-time questions', () => {
  const parking = chunk({
    id: 'parking',
    url: 'https://thewellaustin.com/sundays',
    title: 'Sundays With Us',
    section: 'Parking',
    content: 'Sunday gathering times, service times, location, and visitor information.',
    similarity: 0.25,
    lexicalMatch: true,
  });
  const gathering = chunk({
    id: 'gathering',
    url: 'https://thewellaustin.com/sundays',
    title: 'Sundays With Us',
    section: 'Sundays With Us',
    content: 'Currently meeting at Eastside Early College High School. Gatherings at 9:00am and 11:00am.',
    similarity: 0.25,
    lexicalMatch: true,
  });
  assert.equal(rerankChunks('What time are Sunday services?', [parking, gathering], 1)[0].id, 'gathering');
});

test('event index and requested-month events outrank adjacent-month event pages', () => {
  const index = chunk({
    id: 'events-index',
    url: 'https://thewellaustin.com/events',
    title: 'Events',
    section: 'Events',
    content: 'Nov. 6–15 Retreats. Nov. 20 Students November Hang. Dec. 13 Winter Worship Night.',
    content_type: 'event',
    similarity: 0.25,
    lexicalMatch: true,
  });
  const novemberRetreat = chunk({
    id: 'november-retreat',
    url: 'https://thewellaustin.com/retreats/2026',
    title: "2026 Women's and Men's Retreats",
    section: 'Nov. 6–15',
    content: "Women's Retreat Nov. 6–8. Men's Retreat Nov. 13–15.",
    content_type: 'retreat',
    similarity: 0.25,
    lexicalMatch: true,
  });
  const december = chunk({
    id: 'december-event',
    url: 'https://thewellaustin.com/events/winter-worship-night',
    title: 'Winter Worship Night',
    section: 'Events Home',
    content: 'Winter Worship Night Dec. 13 at 7:00pm.',
    content_type: 'event',
    similarity: 0.25,
    lexicalMatch: true,
  });
  assert.deepEqual(
    rerankChunks('What events are happening in November?', [december, novemberRetreat, index], 3)
      .map((candidate) => candidate.id),
    ['events-index', 'november-retreat', 'december-event']
  );
});
