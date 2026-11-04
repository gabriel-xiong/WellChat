import assert from 'node:assert/strict';
import test from 'node:test';
import { calculateLexicalScore, calculateTemporalEvidenceScore, fuseRetrievalCandidates, getDomainCorrections, MatchDocument, normalizeRetrievalQuery, selectLexicalSearchTerms } from './retrieval';
import { isInferredAuthoritativeUrl, matchingApprovedResourceUrls } from './retrieval-resources';

function chunk(id: string, overrides: Partial<MatchDocument> = {}): MatchDocument {
  return { id, url: `https://thewellaustin.com/${id}`, title: id, section: 'Page', content: 'General information from The Well.', depth: 'deep', last_indexed_at: null, similarity: 0.4, ...overrides };
}

test('extracts subject terms and expands real typo/synonym failures', () => {
  assert.deepEqual(selectLexicalSearchTerms('any resources on lament?'), ['lament']);
  assert.deepEqual(selectLexicalSearchTerms('Do you have sermons about lament?'), ['lament']);
  assert.deepEqual(selectLexicalSearchTerms('What information do you have about the retreat?'), ['retreat']);
  assert.ok(selectLexicalSearchTerms('When is the reheat?').includes('retreat'));
  assert.ok(selectLexicalSearchTerms('Are there careers here?').includes('jobs'));
  assert.equal(normalizeRetrievalQuery('When is the reheat?'), 'retreat');
  assert.deepEqual(getDomainCorrections('When is the reheat?'), [{ from: 'reheat', to: 'retreat' }]);
  assert.deepEqual(getDomainCorrections('What is our mission?'), []);
});

test('expands relative event dates in the church timezone', () => {
  const november = new Date('2026-11-01T18:00:00Z');
  assert.deepEqual(selectLexicalSearchTerms('What events are happening this month?', 8, november), ['events', 'november', 'nov']);
  const stillOctoberInAustin = new Date('2026-11-01T03:30:00Z');
  assert.deepEqual(selectLexicalSearchTerms('events this month', 8, stillOctoberInAustin), ['events', 'october', 'oct']);
});

test('weights title and URL evidence above incidental body matches', () => {
  const title = chunk('title', { title: 'Lament', content: 'A teaching.' });
  const body = chunk('body', { title: 'Resources', content: 'A paragraph that happens to mention lament.' });
  assert.ok(calculateLexicalScore('lament', title) > calculateLexicalScore('lament', body));
});

test('date-bearing chunks win ties for time-sensitive questions', () => {
  const generic = chunk('retreat-general', { title: 'Retreats', content: 'A hosted weekend at CYJ Retreats.' });
  const dates = chunk('retreat-dates', { title: 'Retreats', content: "Women's Retreat Nov. 6 to Nov. 8. Men's Retreat Nov. 13 to Nov. 15." });
  assert.equal(calculateLexicalScore('When is the retreat?', generic), calculateLexicalScore('When is the retreat?', dates));
  assert.ok(calculateTemporalEvidenceScore('When is the retreat?', dates) > calculateTemporalEvidenceScore('When is the retreat?', generic));
  assert.equal(fuseRetrievalCandidates('When is the retreat?', [], [generic, dates], [generic, dates]).chunks[0].id, 'retreat-dates');
});

test('RRF rewards candidates corroborated by vector and lexical retrieval', () => {
  const corroborated = chunk('lament', { title: 'Lament', similarity: 0.48 });
  const vectorOnly = chunk('generic', { similarity: 0.51 });
  const result = fuseRetrievalCandidates('lament', [vectorOnly, corroborated], [corroborated]);
  assert.equal(result.chunks[0].id, 'lament');
  assert.deepEqual(result.chunks[0].retrievalOrigins?.sort(), ['lexical', 'vector']);
});

test('authoritative resources outrank secondary pages for direct intents', () => {
  const story = chunk('story', { url: 'https://thewellaustin.com/stories/finding-belonging-at-the-college-retreat', title: 'Finding Belonging at the College Retreat', similarity: 0.5 });
  const retreat = chunk('retreat', { url: 'https://thewellaustin.com/retreats/2026', title: "2026 Women's and Men's Retreats", similarity: 0 });
  const result = fuseRetrievalCandidates('Retreat', [story], [story, retreat], [retreat]);
  assert.equal(result.chunks[0].id, 'retreat');
});

test('caps repeated chunks from one URL so one page cannot crowd out sources', () => {
  const repeated = Array.from({ length: 5 }, (_, index) => chunk(`same-${index}`, { url: 'https://thewellaustin.com/sundays', similarity: 0.6 - index * 0.01 }));
  const alternatives = [chunk('events', { similarity: 0.5 }), chunk('community', { similarity: 0.49 })];
  const result = fuseRetrievalCandidates('church information', [...repeated, ...alternatives], [], [], 5, 2);
  assert.equal(result.chunks.filter((candidate) => candidate.url.endsWith('/sundays')).length, 2);
  assert.ok(result.chunks.some((candidate) => candidate.id === 'events'));
});

test('weak lexical-only body evidence does not manufacture retrieval confidence', () => {
  const weak = chunk('weak', { title: 'Resources', content: 'This page briefly mentions lament.', similarity: 0 });
  const result = fuseRetrievalCandidates('lament', [], [weak]);
  assert.ok(result.confidence < 0.45);
  assert.equal(result.diagnostics[0].vectorSimilarity, null);
  assert.equal(result.diagnostics[0].origins[0], 'lexical');
});

test('diagnostics explain rank inputs and final selection', () => {
  const candidate = chunk('events', { title: 'Events', similarity: 0.52 });
  const result = fuseRetrievalCandidates('What events are happening?', [candidate], [candidate], [candidate]);
  assert.equal(result.diagnostics[0].selected, true);
  assert.equal(result.diagnostics[0].vectorRank, 1);
  assert.equal(result.diagnostics[0].lexicalRank, 1);
  assert.equal(result.diagnostics[0].authoritativeRank, 1);
  assert.ok(result.diagnostics[0].reciprocalRankScore > 0);
  assert.ok(result.diagnostics[0].confidence >= 0.9);
});

test('benchmark and production share the complete authoritative resource map', () => {
  assert.deepEqual(matchingApprovedResourceUrls('Who are the pastors or staff?'), ['https://thewellaustin.com/team']);
  assert.deepEqual(matchingApprovedResourceUrls('What is the mission of The Well?'), ['https://thewellaustin.com/mission']);
  assert.deepEqual(matchingApprovedResourceUrls('Tell me about missionaries The Well supports'), ['https://thewellaustin.com/missions']);
  assert.deepEqual(matchingApprovedResourceUrls('How do I make a financial contribution?'), ['https://thewellaustin.com/giving']);
  assert.deepEqual(matchingApprovedResourceUrls('Is The Well hiring?'), ['https://thewellaustin.com/jobs']);
});

test('infers exact subject pages without confusing singular and plural collections', () => {
  assert.equal(isInferredAuthoritativeUrl('any resources on lament?', 'https://thewellaustin.com/sermons/lament'), true);
  assert.equal(isInferredAuthoritativeUrl('Retreat', 'https://thewellaustin.com/retreats/2026'), true);
  assert.equal(isInferredAuthoritativeUrl('What is our mission?', 'https://thewellaustin.com/mission'), true);
  assert.equal(isInferredAuthoritativeUrl('What is our mission?', 'https://thewellaustin.com/missions'), false);
});
