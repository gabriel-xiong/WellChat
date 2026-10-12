import fs from 'node:fs';
import path from 'node:path';
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
  isEventExpired,
  parseSitemapEntries,
  resolveSitemapPolicy,
  summaryForSource,
} from './ingestion-core';

const directory = path.dirname(fileURLToPath(import.meta.url));
const config = JSON.parse(fs.readFileSync(path.resolve(directory, '../ingestion-config.json'), 'utf8')) as IngestionConfig;
const baseUrl = (process.env.BASE_SITE_URL ?? 'https://thewellaustin.com').replace(/\/+$/, '');
const concurrency = 8;

async function fetchText(url: string): Promise<string> {
  const response = await fetch(url, { headers: { 'User-Agent': 'TheWellIngestAudit/1.0' }, signal: AbortSignal.timeout(30_000) });
  if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
  return response.text();
}

async function main(): Promise<void> {
  const index = parseSitemapEntries(await fetchText(canonicalizeUrl(config.sitemapIndex, baseUrl)));
  const sources = new Map<string, DiscoveredSource>();

  for (const sitemap of index) {
    const sitemapUrl = canonicalizeUrl(sitemap.url, baseUrl);
    const policy = resolveSitemapPolicy(sitemapUrl, config);
    if (!policy) continue;
    for (const entry of parseSitemapEntries(await fetchText(sitemapUrl))) {
      const source = applyUrlPolicy({
        url: canonicalizeUrl(entry.url, baseUrl),
        lastModified: entry.lastModified,
        sitemapUrl,
        sitemapName: policy.name,
        contentType: policy.contentType,
        refreshHours: policy.refreshHours,
        depth: policy.depth,
      }, config);
      if (source) sources.set(source.url, source);
    }
  }

  const queue = [...sources.values()];
  const failures: Array<{ url: string; error: string }> = [];
  const suspicious: Array<{ url: string; reason: string }> = [];
  const noindex: string[] = [];
  const expired: string[] = [];
  const hashes = new Map<string, string[]>();
  let pages = 0;
  let chunks = 0;
  let characters = 0;
  let approximateTokens = 0;

  async function worker(): Promise<void> {
    while (queue.length) {
      const source = queue.shift();
      if (!source) return;
      try {
        const html = await fetchText(source.url);
        if (isNoIndexPage(html)) {
          noindex.push(source.url);
          continue;
        }
        const title = extractTitle(html);
        const text = htmlToText(html);
        if ((source.contentType === 'event' || source.contentType === 'retreat')
          && isEventExpired(extractEventEndDate(html, text, source.url), new Date())) {
          expired.push(source.url);
          continue;
        }
        const pageChunks = addRetrievalSummary(
          buildChunks(source.url, title, source.depth, source.contentType, text),
          summaryForSource(source.url, source.contentType)
        );
        const hash = contentHash(title, pageChunks);
        hashes.set(hash, [...(hashes.get(hash) ?? []), source.url]);
        pages += 1;
        chunks += pageChunks.length;
        characters += pageChunks.reduce((total, chunk) => total + chunk.content.length, 0);
        approximateTokens += Math.ceil(pageChunks.reduce((total, chunk) => total + chunk.section.length + chunk.content.length, 0) / 4);
        if (title === 'Untitled Page') suspicious.push({ url: source.url, reason: 'missing title' });
        if (text.length < 100) suspicious.push({ url: source.url, reason: `only ${text.length} extracted characters` });
        if (text.length > 250_000) suspicious.push({ url: source.url, reason: `${text.length} extracted characters is unexpectedly large` });
      } catch (error) {
        failures.push({ url: source.url, error: error instanceof Error ? error.message : String(error) });
      }
    }
  }

  await Promise.all(Array.from({ length: concurrency }, () => worker()));
  const duplicateContent = [...hashes.values()].filter((urls) => urls.length > 1);
  const report = {
    discovered: sources.size,
    indexablePages: pages,
    noindexPages: noindex,
    expiredPages: expired,
    chunks,
    characters,
    approximateEmbeddingTokens: approximateTokens,
    approximateEmbeddingCostUsdAtTwoCentsPerMillion: Number((approximateTokens * 0.02 / 1_000_000).toFixed(6)),
    failures,
    suspicious,
    duplicateContent,
  };
  console.log(JSON.stringify(report, null, 2));
  if (failures.length || suspicious.length) process.exitCode = 1;
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
