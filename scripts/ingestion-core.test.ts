import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  addRetrievalSummary,
  applyUrlPolicy,
  buildChunks,
  canonicalizeUrl,
  contentHash,
  DiscoveredSource,
  extractTitle,
  extractEventEndDate,
  htmlToText,
  IngestionConfig,
  isNoIndexPage,
  isPageDue,
  isEventExpired,
  parseSitemapEntries,
  resolveSitemapPolicy,
  shouldEmbedPage,
} from './ingestion-core';

const testDirectory = path.dirname(fileURLToPath(import.meta.url));
const config = JSON.parse(fs.readFileSync(path.resolve(testDirectory, '../ingestion-config.json'), 'utf8')) as IngestionConfig;

function source(overrides: Partial<DiscoveredSource> = {}): DiscoveredSource {
  return {
    url: 'https://thewellaustin.com/beliefs',
    lastModified: '2026-01-01T00:00:00Z',
    sitemapUrl: 'https://thewellaustin.com/page-sitemap.xml',
    sitemapName: 'page-sitemap.xml',
    contentType: 'page',
    refreshHours: 168,
    depth: 'deep',
    ...overrides,
  };
}

test('parses sitemap URL and index entries with lastmod and entities', () => {
  const xml = `<?xml version="1.0"?><urlset>
    <url><loc>https://example.com/a?x=1&amp;y=2</loc><lastmod>2026-10-01</lastmod></url>
    <url><loc>https://example.com/b</loc></url>
  </urlset>`;
  assert.deepEqual(parseSitemapEntries(xml), [
    { url: 'https://example.com/a?x=1&y=2', lastModified: '2026-10-01' },
    { url: 'https://example.com/b', lastModified: null },
  ]);
});

test('canonicalizes URLs consistently with legacy document URLs', () => {
  assert.equal(canonicalizeUrl('/beliefs/', 'https://thewellaustin.com/'), 'https://thewellaustin.com/beliefs');
  assert.equal(canonicalizeUrl('https://THEWELLAUSTIN.com//events/?ref=x#top', 'https://ignored.test'), 'https://thewellaustin.com/events');
  assert.equal(canonicalizeUrl('/', 'https://thewellaustin.com'), 'https://thewellaustin.com/');
});

test('maps all configured sitemap names and rejects unknown ones', () => {
  for (const policy of config.sitemaps) {
    assert.equal(resolveSitemapPolicy(`https://thewellaustin.com/${policy.name}`, config)?.name, policy.name);
  }
  assert.equal(resolveSitemapPolicy('https://thewellaustin.com/unapproved-sitemap.xml', config), null);
});

test('applies volatility overrides and exclusions', () => {
  assert.equal(applyUrlPolicy(source({ url: 'https://thewellaustin.com/events/fall-night' }), config)?.refreshHours, 24);
  assert.equal(applyUrlPolicy(source({ url: 'https://thewellaustin.com/beliefs' }), config)?.refreshHours, 720);
  assert.equal(applyUrlPolicy(source({ url: 'https://thewellaustin.com/team/person' }), config)?.refreshHours, 168);
  assert.equal(applyUrlPolicy(source({ url: 'https://thewellaustin.com/search-resources' }), config), null);
  assert.equal(applyUrlPolicy(source({ url: 'https://thewellaustin.com/resources-old' }), config), null);
});

test('regression: Lament and the current retreat are eligible', () => {
  const sermonPolicy = resolveSitemapPolicy('https://thewellaustin.com/sermons-sitemap.xml', config)!;
  const retreatPolicy = resolveSitemapPolicy('https://thewellaustin.com/retreatevents-sitemap.xml', config)!;
  assert.ok(applyUrlPolicy(source({
    url: 'https://thewellaustin.com/sermons/lament',
    sitemapName: sermonPolicy.name,
    contentType: sermonPolicy.contentType,
  }), config));
  assert.equal(applyUrlPolicy(source({
    url: 'https://thewellaustin.com/retreats/2026',
    sitemapName: retreatPolicy.name,
    contentType: retreatPolicy.contentType,
  }), config)?.refreshHours, 24);
});

test('migration-free scheduling uses the newest stored verification timestamp', () => {
  const now = new Date('2026-10-11T12:00:00Z');
  const hourly = source({ refreshHours: 24, lastModified: '2026-10-01T00:00:00Z' });
  assert.equal(isPageDue(hourly, [], now), true);
  assert.equal(isPageDue(hourly, [{ last_indexed_at: '2026-10-11T00:00:00Z' }], now), false);
  assert.equal(isPageDue(hourly, [{ last_indexed_at: '2026-10-10T11:00:00Z' }], now), true);
  assert.equal(isPageDue(source({ lastModified: '2026-10-11T01:00:00Z' }), [{ last_indexed_at: '2026-10-11T00:00:00Z' }], now), true);
  assert.equal(isPageDue(hourly, [{ last_indexed_at: '2026-10-11T11:00:00Z' }], now, true), true);
});

test('detects noindex regardless of meta attribute order', () => {
  assert.equal(isNoIndexPage('<meta name="robots" content="noindex, follow">'), true);
  assert.equal(isNoIndexPage('<meta content="nofollow, noindex" name="googlebot">'), true);
  assert.equal(isNoIndexPage('<meta name="robots" content="index, follow">'), false);
});

test('extracts event end dates, including year rollover and year-specific retreat URLs', () => {
  const published = '<script type="application/ld+json">{"datePublished":"2026-07-20T20:18:46+00:00"}</script>';
  assert.equal(
    extractEventEndDate(published, '# Living Sent Sep . 28 Oct . 05 Oct . 26', 'https://thewellaustin.com/events/living-sent')?.toISOString(),
    '2026-10-26T23:59:59.000Z'
  );
  assert.equal(
    extractEventEndDate(published, '# Prayer Sep . 02 Apr . 21', 'https://thewellaustin.com/events/prayer')?.toISOString(),
    '2027-04-21T23:59:59.000Z'
  );
  assert.equal(
    extractEventEndDate('', '# Retreat Nov. 6 to Nov. 8', 'https://thewellaustin.com/retreats/2025')?.toISOString(),
    '2025-11-08T23:59:59.000Z'
  );
});

test('event expiration allows a safety grace window', () => {
  const end = new Date('2026-09-25T23:59:59Z');
  assert.equal(isEventExpired(end, new Date('2026-09-26T12:00:00Z')), false);
  assert.equal(isEventExpired(end, new Date('2026-09-28T12:00:00Z')), true);
  assert.equal(isEventExpired(null, new Date('2026-09-28T12:00:00Z')), false);
});

test('extracts main content, removes scripts and preserves nested heading text', () => {
  const html = `<html><head><title>Faith &amp; Life</title></head><body><nav>Ignore me</nav><main>
    <h1>What <em>We</em> Believe</h1><p>Meaningful body content for retrieval.</p>
    <script>secret()</script><h2>Jesus</h2><p>More meaningful content.</p></main></body></html>`;
  const text = htmlToText(html);
  assert.equal(extractTitle(html), 'Faith & Life');
  assert.match(text, /# What We Believe/);
  assert.match(text, /Meaningful body content/);
  assert.doesNotMatch(text, /Ignore me|secret/);
});

test('content hashes are deterministic and change with answer-bearing content', () => {
  const first = addRetrievalSummary(
    buildChunks('https://example.com', 'Title', 'deep', 'page', '# Heading\nAnswer one with sufficient content.'),
    'Retrieval summary.'
  );
  const same = structuredClone(first);
  const changed = structuredClone(first);
  changed[0].content = changed[0].content.replace('one', 'two');
  assert.equal(contentHash('Title', first), contentHash('Title', same));
  assert.equal(contentHash('Title', first), contentHash('Title', [...same].reverse()));
  assert.notEqual(contentHash('Title', first), contentHash('Title', changed));
  assert.notEqual(contentHash('Title', first), contentHash('Changed title', first));
});

test('embedding is skipped only for matching hashes unless explicitly forced', () => {
  assert.equal(shouldEmbedPage('same', 'same'), false);
  assert.equal(shouldEmbedPage('new', 'old'), true);
  assert.equal(shouldEmbedPage('new', null), true);
  assert.equal(shouldEmbedPage('same', 'same', true), true);
});

test('long content is chunked without dropping words', () => {
  const words = Array.from({ length: 1000 }, (_, index) => `word${index}`);
  const chunks = buildChunks('https://example.com', 'Title', 'deep', 'page', words.join(' '));
  assert.ok(chunks.length > 1);
  assert.deepEqual(chunks.flatMap((chunk) => chunk.content.split(/\s+/)), words);
});
