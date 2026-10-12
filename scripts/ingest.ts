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
  extractEventEndDate,
  extractTitle,
  htmlToText,
  IngestionConfig,
  isEventExpired,
  isNoIndexPage,
  isPageDue,
  PageChunk,
  parseSitemapEntries,
  resolveSitemapPolicy,
  shouldEmbedPage,
  summaryForSource,
} from './ingestion-core';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const CONFIG_FILE = process.env.INGESTION_CONFIG_FILE
  ? path.resolve(process.env.INGESTION_CONFIG_FILE)
  : path.resolve(SCRIPT_DIR, '../ingestion-config.json');
const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL?.replace(/\/+$/, '');
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const BASE_SITE_URL = process.env.BASE_SITE_URL?.replace(/\/+$/, '');
const OPENAI_EMBEDDINGS_URL = process.env.OPENAI_EMBEDDINGS_URL ?? 'https://api.openai.com/v1/embeddings';
const FETCH_TIMEOUT_MS = 30_000;
const FETCH_ATTEMPTS = 3;

interface StoredDocument {
  id: string;
  url: string;
  title: string | null;
  section: string | null;
  content: string;
  depth: string | null;
  content_type: string | null;
  last_indexed_at: string;
}

interface RunOptions {
  dryRun: boolean;
  discoveryOnly: boolean;
  forceCheck: boolean;
  forceEmbed: boolean;
  limit: number | null;
}

interface DiscoveryResult {
  sources: Map<string, DiscoveredSource>;
  successfulSitemaps: Set<string>;
  failedSitemaps: string[];
  ignoredSitemaps: string[];
}

interface RunStats {
  discovered: number;
  due: number;
  checked: number;
  unchanged: number;
  indexed: number;
  excluded: number;
  expired: number;
  failed: number;
  embeddedTokensApproximation: number;
}

class NonRetryableFetchError extends Error {}

function parseOptions(argv: string[]): RunOptions {
  const limitArgument = argv.find((argument) => argument.startsWith('--limit='));
  const parsedLimit = limitArgument ? Number(limitArgument.split('=', 2)[1]) : null;
  if (parsedLimit !== null && (!Number.isInteger(parsedLimit) || parsedLimit < 1)) {
    throw new Error('--limit must be a positive integer.');
  }
  return {
    dryRun: argv.includes('--dry-run'),
    discoveryOnly: argv.includes('--discovery-only'),
    forceCheck: argv.includes('--force-check') || argv.includes('--force-embed'),
    forceEmbed: argv.includes('--force-embed'),
    limit: parsedLimit,
  };
}

function assertEnvironment(options: RunOptions): void {
  if (!BASE_SITE_URL) throw new Error('BASE_SITE_URL is required.');
  if (options.discoveryOnly) return;
  if (!SUPABASE_URL) throw new Error('NEXT_PUBLIC_SUPABASE_URL is required.');
  if (!SUPABASE_SERVICE_ROLE_KEY) throw new Error('SUPABASE_SERVICE_ROLE_KEY is required.');
  if (!options.dryRun && !OPENAI_API_KEY) throw new Error('OPENAI_API_KEY is required.');
}

function loadConfig(): IngestionConfig {
  const raw = process.env.INGESTION_CONFIG_JSON ?? fs.readFileSync(CONFIG_FILE, 'utf8');
  const parsed = JSON.parse(raw) as IngestionConfig;
  if (!parsed.sitemapIndex || !Array.isArray(parsed.sitemaps) || !parsed.sitemaps.length) {
    throw new Error(`${CONFIG_FILE} must define sitemapIndex and at least one sitemap policy.`);
  }
  const names = new Set<string>();
  for (const sitemap of parsed.sitemaps) {
    if (!sitemap.name || names.has(sitemap.name)) throw new Error(`Duplicate or empty sitemap policy: ${sitemap.name}`);
    if (!Number.isFinite(sitemap.refreshHours) || sitemap.refreshHours < 1) throw new Error(`Invalid refreshHours for ${sitemap.name}.`);
    names.add(sitemap.name);
  }
  for (const policy of parsed.urlPolicies ?? []) new RegExp(policy.pattern, 'i');
  for (const pattern of parsed.excludePatterns ?? []) new RegExp(pattern, 'i');
  return parsed;
}

async function fetchWithRetry(url: string, init: RequestInit = {}, attempts = FETCH_ATTEMPTS): Promise<Response> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const response = await fetch(url, {
        ...init,
        headers: { 'User-Agent': 'TheWellIngest/2.0', ...init.headers },
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      });
      if (response.ok) return response;
      const body = await response.text();
      const message = `${response.status} ${response.statusText}: ${body.slice(0, 300)}`;
      if (response.status < 500 && response.status !== 429) throw new NonRetryableFetchError(message);
      lastError = new Error(message);
    } catch (error) {
      if (error instanceof NonRetryableFetchError) throw error;
      lastError = error;
      if (attempt === attempts) break;
    }
    await new Promise((resolve) => setTimeout(resolve, 250 * 2 ** (attempt - 1)));
  }
  throw lastError instanceof Error ? lastError : new Error(`Failed to fetch ${url}`);
}

function serviceHeaders(extra: Record<string, string> = {}): Record<string, string> {
  return {
    apikey: SUPABASE_SERVICE_ROLE_KEY!,
    Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY!}`,
    Accept: 'application/json',
    ...extra,
  };
}

async function discoverSources(config: IngestionConfig): Promise<DiscoveryResult> {
  const indexUrl = canonicalizeUrl(config.sitemapIndex, BASE_SITE_URL!);
  const indexEntries = parseSitemapEntries(await (await fetchWithRetry(indexUrl)).text());
  if (!indexEntries.length) throw new Error(`Sitemap index contained no entries: ${indexUrl}`);

  const sources = new Map<string, DiscoveredSource>();
  const successfulSitemaps = new Set<string>();
  const failedSitemaps: string[] = [];
  const ignoredSitemaps: string[] = [];
  for (const entry of indexEntries) {
    const sitemapUrl = canonicalizeUrl(entry.url, BASE_SITE_URL!);
    const policy = resolveSitemapPolicy(sitemapUrl, config);
    if (!policy) {
      ignoredSitemaps.push(sitemapUrl);
      continue;
    }
    try {
      const pageEntries = parseSitemapEntries(await (await fetchWithRetry(sitemapUrl)).text());
      if (!pageEntries.length) throw new Error('Sitemap contained no URLs.');
      successfulSitemaps.add(sitemapUrl);
      for (const pageEntry of pageEntries) {
        const url = canonicalizeUrl(pageEntry.url, BASE_SITE_URL!);
        if (new URL(url).origin !== new URL(BASE_SITE_URL!).origin) continue;
        const candidate = applyUrlPolicy({
          url,
          lastModified: pageEntry.lastModified,
          sitemapUrl,
          sitemapName: policy.name,
          contentType: policy.contentType,
          refreshHours: policy.refreshHours,
          depth: policy.depth,
        }, config);
        if (!candidate) continue;
        const existing = sources.get(url);
        if (!existing || candidate.refreshHours < existing.refreshHours) sources.set(url, candidate);
      }
    } catch (error) {
      failedSitemaps.push(sitemapUrl);
      console.error(`Failed to discover ${sitemapUrl}:`, error instanceof Error ? error.message : error);
    }
  }

  const missing = config.sitemaps.filter((policy) =>
    !indexEntries.some((entry) => new URL(entry.url).pathname.endsWith(`/${policy.name}`))
  );
  if (missing.length) throw new Error(`Configured sitemaps missing from index: ${missing.map((item) => item.name).join(', ')}`);
  return { sources, successfulSitemaps, failedSitemaps, ignoredSitemaps };
}

async function loadStoredDocuments(): Promise<Map<string, StoredDocument[]>> {
  const grouped = new Map<string, StoredDocument[]>();
  const pageSize = 1000;
  for (let offset = 0; ; offset += pageSize) {
    const endpoint = `${SUPABASE_URL}/rest/v1/documents?select=id,url,title,section,content,depth,content_type,last_indexed_at&order=url.asc&limit=${pageSize}&offset=${offset}`;
    const rows = await (await fetchWithRetry(endpoint, { headers: serviceHeaders() })).json() as StoredDocument[];
    for (const row of rows) {
      const url = canonicalizeUrl(row.url, BASE_SITE_URL!);
      grouped.set(url, [...(grouped.get(url) ?? []), row]);
    }
    if (rows.length < pageSize) break;
  }
  return grouped;
}

function storedFingerprint(documents: StoredDocument[]): string | null {
  if (!documents.length) return null;
  const first = documents[0];
  return contentHash(first.title ?? 'Untitled Page', documents.map((document) => ({
    url: document.url,
    title: document.title ?? 'Untitled Page',
    section: document.section ?? 'page',
    content: document.content,
    depth: document.depth === 'shallow' ? 'shallow' : 'deep',
    content_type: document.content_type ?? 'page',
  })));
}

async function touchDocuments(url: string, checkedAt: string): Promise<void> {
  const response = await fetchWithRetry(`${SUPABASE_URL}/rest/v1/documents?url=eq.${encodeURIComponent(url)}`, {
    method: 'PATCH',
    headers: serviceHeaders({ 'Content-Type': 'application/json', Prefer: 'return=minimal' }),
    body: JSON.stringify({ last_indexed_at: checkedAt }),
  });
  await response.body?.cancel();
}

async function embedTexts(texts: string[]): Promise<number[][]> {
  const response = await fetchWithRetry(OPENAI_EMBEDDINGS_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${OPENAI_API_KEY}` },
    body: JSON.stringify({ model: 'text-embedding-3-small', input: texts }),
  });
  const payload = await response.json() as { data?: Array<{ index: number; embedding: number[] }> };
  const embeddings = (payload.data ?? []).sort((left, right) => left.index - right.index).map((item) => item.embedding);
  if (embeddings.length !== texts.length || embeddings.some((embedding) => embedding.length !== 1536)) {
    throw new Error(`Embedding response mismatch: expected ${texts.length} 1536-dimensional vectors, received ${embeddings.length}.`);
  }
  return embeddings;
}

async function insertChunks(chunks: PageChunk[], indexedAt: string): Promise<string[]> {
  const response = await fetchWithRetry(`${SUPABASE_URL}/rest/v1/documents`, {
    method: 'POST',
    headers: serviceHeaders({ 'Content-Type': 'application/json', Prefer: 'return=representation' }),
    body: JSON.stringify(chunks.map((chunk) => ({
      url: chunk.url,
      title: chunk.title,
      section: chunk.section,
      content: chunk.content,
      embedding: chunk.embedding,
      depth: chunk.depth,
      content_type: chunk.content_type,
      last_indexed_at: indexedAt,
    }))),
  });
  const inserted = await response.json() as Array<{ id: string }>;
  if (inserted.length !== chunks.length || inserted.some((row) => !row.id)) {
    throw new Error(`Insert response mismatch: expected ${chunks.length} rows, received ${inserted.length}.`);
  }
  return inserted.map((row) => row.id);
}

async function deleteDocuments(ids: string[]): Promise<void> {
  for (let start = 0; start < ids.length; start += 100) {
    const batch = ids.slice(start, start + 100);
    const response = await fetchWithRetry(`${SUPABASE_URL}/rest/v1/documents?id=in.(${batch.join(',')})`, {
      method: 'DELETE',
      headers: serviceHeaders({ Prefer: 'return=minimal' }),
    });
    await response.body?.cancel();
  }
}

async function replacePageSafely(existing: StoredDocument[], chunks: PageChunk[], indexedAt: string): Promise<boolean> {
  await insertChunks(chunks, indexedAt);
  try {
    await deleteDocuments(existing.map((document) => document.id));
    return false;
  } catch (error) {
    console.warn(
      `New chunks were stored, but ${existing.length} old chunks could not be fully removed. `
      + `The new data is being preserved to prevent an availability regression; a later ingestion run will retry cleanup. `
      + `Cause: ${error instanceof Error ? error.message : error}`
    );
    return true;
  }
}

async function activateNewCorpusVersion(): Promise<void> {
  const version = crypto.randomUUID();
  const response = await fetch(`${SUPABASE_URL}/rest/v1/rag_corpus_state?on_conflict=singleton`, {
    method: 'POST',
    headers: serviceHeaders({ 'Content-Type': 'application/json', Prefer: 'resolution=merge-duplicates,return=minimal' }),
    body: JSON.stringify({ singleton: true, active_version: version, updated_at: new Date().toISOString() }),
  });
  if (!response.ok) throw new Error(`${response.status} ${response.statusText}: ${await response.text()}`);
  const cleanup = await fetch(`${SUPABASE_URL}/rest/v1/semantic_answer_cache?corpus_version=neq.${version}`, {
    method: 'DELETE',
    headers: serviceHeaders(),
  });
  if (!cleanup.ok) console.warn(`Stale semantic-cache cleanup failed: ${cleanup.status} ${await cleanup.text()}`);
}

function approximateTokens(chunks: PageChunk[]): number {
  return Math.ceil(chunks.reduce((total, chunk) => total + chunk.section.length + chunk.content.length, 0) / 4);
}

async function processSource(
  source: DiscoveredSource,
  existing: StoredDocument[],
  options: RunOptions,
  stats: RunStats
): Promise<boolean> {
  try {
    const html = await (await fetchWithRetry(source.url)).text();
    const checkedAt = new Date().toISOString();
    stats.checked += 1;
    if (isNoIndexPage(html)) {
      if (!options.dryRun) await deleteDocuments(existing.map((document) => document.id));
      stats.excluded += 1;
      console.log(`[excluded:noindex] ${source.url}`);
      return existing.length > 0;
    }

    const title = extractTitle(html);
    const text = htmlToText(html);
    if (text.length < 20) throw new Error(`Extracted content is unexpectedly short (${text.length} characters).`);
    if ((source.contentType === 'event' || source.contentType === 'retreat')
      && isEventExpired(extractEventEndDate(html, text, source.url), new Date())) {
      if (!options.dryRun) await deleteDocuments(existing.map((document) => document.id));
      stats.expired += 1;
      console.log(`[expired] ${source.url}`);
      return existing.length > 0;
    }

    const chunks = addRetrievalSummary(
      buildChunks(source.url, title, source.depth, source.contentType, text),
      summaryForSource(source.url, source.contentType)
    );
    const hash = contentHash(title, chunks);
    if (!shouldEmbedPage(hash, storedFingerprint(existing), options.forceEmbed)) {
      if (!options.dryRun) await touchDocuments(source.url, checkedAt);
      stats.unchanged += 1;
      console.log(`[unchanged] ${source.url}`);
      return false;
    }

    stats.embeddedTokensApproximation += approximateTokens(chunks);
    if (options.dryRun) {
      console.log(`[would-index] ${source.url} (${chunks.length} chunks)`);
      return false;
    }
    const embeddings = await embedTexts(chunks.map((chunk) => `${chunk.section}\n\n${chunk.content}`));
    const retainedOldChunks = await replacePageSafely(
      existing,
      chunks.map((chunk, index) => ({ ...chunk, embedding: embeddings[index] })),
      checkedAt
    );
    stats.indexed += 1;
    console.log(`[indexed] ${source.url} (${chunks.length} chunks${retainedOldChunks ? '; old-chunk cleanup pending' : ''})`);
    return true;
  } catch (error) {
    stats.failed += 1;
    console.error(`[failed] ${source.url}:`, error instanceof Error ? error.message : error);
    return false;
  }
}

async function main(): Promise<void> {
  const options = parseOptions(process.argv.slice(2));
  assertEnvironment(options);
  const config = loadConfig();
  const discovery = await discoverSources(config);
  if (options.discoveryOnly) {
    const contentTypes = [...discovery.sources.values()].reduce<Record<string, number>>((result, source) => {
      result[source.contentType] = (result[source.contentType] ?? 0) + 1;
      return result;
    }, {});
    console.log(JSON.stringify({
      eligibleUrls: discovery.sources.size,
      successfulSitemaps: discovery.successfulSitemaps.size,
      failedSitemaps: discovery.failedSitemaps,
      ignoredSitemaps: discovery.ignoredSitemaps,
      contentTypes,
    }, null, 2));
    if (discovery.failedSitemaps.length) process.exitCode = 1;
    return;
  }

  const stored = await loadStoredDocuments();
  const now = new Date();
  const sources = [...discovery.sources.values()].sort((left, right) => left.url.localeCompare(right.url));
  const due = sources.filter((source) => isPageDue(source, stored.get(source.url) ?? [], now, options.forceCheck));
  const selected = options.limit ? due.slice(0, options.limit) : due;
  const stats: RunStats = {
    discovered: sources.length,
    due: due.length,
    checked: 0,
    unchanged: 0,
    indexed: 0,
    excluded: 0,
    expired: 0,
    failed: 0,
    embeddedTokensApproximation: 0,
  };
  console.log(`Discovered ${sources.length} eligible URLs across ${discovery.successfulSitemaps.size} sitemaps; ${due.length} due.`);
  if (options.dryRun) console.log('Dry run: no database writes or OpenAI requests will be made.');

  let corpusChanged = false;
  for (const source of selected) {
    if (await processSource(source, stored.get(source.url) ?? [], options, stats)) corpusChanged = true;
  }
  if (corpusChanged && !options.dryRun) {
    try {
      await activateNewCorpusVersion();
      console.log('Corpus version advanced because stored content changed.');
    } catch (error) {
      console.warn('Content changed, but semantic-cache versioning was unavailable:', error instanceof Error ? error.message : error);
    }
  } else {
    console.log('Corpus version unchanged.');
  }
  console.log(JSON.stringify({ ...stats, failedSitemaps: discovery.failedSitemaps.length }, null, 2));
  if (discovery.failedSitemaps.length || stats.failed) process.exitCode = 1;
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : '';
if (invokedPath === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
