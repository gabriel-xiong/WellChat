import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  applyUrlPolicy,
  buildChunks,
  canonicalizeUrl,
  extractTitle,
  htmlToText,
  IngestionConfig,
  parseSitemapEntries,
  resolveSitemapPolicy,
} from './ingestion-core';

const directory = path.dirname(fileURLToPath(import.meta.url));
const config = JSON.parse(fs.readFileSync(path.resolve(directory, '../ingestion-config.json'), 'utf8')) as IngestionConfig;
const baseUrl = 'https://thewellaustin.com';

test('live sitemap coverage includes all approved types and known regression pages', async () => {
  const indexResponse = await fetch(`${baseUrl}${config.sitemapIndex}`);
  assert.equal(indexResponse.ok, true);
  const sitemapEntries = parseSitemapEntries(await indexResponse.text());
  const approved = sitemapEntries.filter((entry) => resolveSitemapPolicy(entry.url, config));
  assert.equal(approved.length, config.sitemaps.length);

  const urls = new Set<string>();
  for (const sitemap of approved) {
    const policy = resolveSitemapPolicy(sitemap.url, config)!;
    const response = await fetch(sitemap.url);
    assert.equal(response.ok, true, sitemap.url);
    for (const entry of parseSitemapEntries(await response.text())) {
      const url = canonicalizeUrl(entry.url, baseUrl);
      const source = applyUrlPolicy({
        url,
        lastModified: entry.lastModified,
        sitemapUrl: canonicalizeUrl(sitemap.url, baseUrl),
        sitemapName: policy.name,
        contentType: policy.contentType,
        refreshHours: policy.refreshHours,
        depth: policy.depth,
      }, config);
      if (source) urls.add(source.url);
    }
  }

  assert.ok(urls.size >= 250, `Expected at least 250 eligible URLs, found ${urls.size}`);
  assert.ok(urls.has(`${baseUrl}/sermons/lament`));
  assert.ok(urls.has(`${baseUrl}/retreats/2026`));
});

for (const url of [`${baseUrl}/sermons/lament/`, `${baseUrl}/retreats/2026/`, `${baseUrl}/beliefs/`]) {
  test(`live page extracts useful chunks: ${url}`, async () => {
    const response = await fetch(url);
    assert.equal(response.ok, true);
    const html = await response.text();
    const title = extractTitle(html);
    const text = htmlToText(html);
    const chunks = buildChunks(canonicalizeUrl(url, baseUrl), title, 'deep', 'page', text);
    assert.notEqual(title, 'Untitled Page');
    assert.ok(text.length >= 200, `Expected at least 200 extracted characters, found ${text.length}`);
    assert.ok(chunks.length >= 1);
    assert.ok(chunks.every((chunk) => chunk.content.length >= 20));
  });
}
