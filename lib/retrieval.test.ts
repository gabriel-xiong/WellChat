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
