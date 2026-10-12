import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import http from 'node:http';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { buildChunks, extractTitle, htmlToText, IngestionConfig } from './ingestion-core';

const directory = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(directory, '..');
const tsxCli = path.resolve(repositoryRoot, 'node_modules/tsx/dist/cli.mjs');
const ingestScript = path.resolve(directory, 'ingest.ts');
const pageHtml = '<html><head><title>Stable page</title></head><body><main><h1>Information</h1><p>This answer-bearing content is stable and long enough to index safely.</p></main></body></html>';

interface MockCounters {
  embeddings: number;
  inserts: number;
  deletes: number;
  touches: number;
}

async function runScenario(mode: 'matching' | 'changed' | 'invalid-embedding' | 'delete-failure'): Promise<{ code: number | null; output: string; counters: MockCounters }> {
  const counters: MockCounters = { embeddings: 0, inserts: 0, deletes: 0, touches: 0 };
  let baseUrl = '';
  const server = http.createServer(async (request, response) => {
    const url = new URL(request.url ?? '/', baseUrl);
    if (request.method === 'GET' && url.pathname === '/wp-sitemap.xml') {
      response.end(`<sitemapindex><sitemap><loc>${baseUrl}/page-sitemap.xml</loc></sitemap></sitemapindex>`);
      return;
    }
    if (request.method === 'GET' && url.pathname === '/page-sitemap.xml') {
      response.end(`<urlset><url><loc>${baseUrl}/page</loc><lastmod>2026-10-01</lastmod></url></urlset>`);
      return;
    }
    if (request.method === 'GET' && url.pathname === '/page') {
      response.end(pageHtml);
      return;
    }
    if (request.method === 'GET' && url.pathname === '/rest/v1/documents') {
      const pageUrl = `${baseUrl}/page`;
      const title = extractTitle(pageHtml);
      const chunks = buildChunks(pageUrl, title, 'deep', 'page', htmlToText(pageHtml));
      response.setHeader('Content-Type', 'application/json');
      response.end(JSON.stringify(chunks.map((chunk, index) => ({
        id: `00000000-0000-0000-0000-00000000000${index + 1}`,
        url: pageUrl,
        title: chunk.title,
        section: chunk.section,
        content: mode === 'matching' ? chunk.content : `${chunk.content} old`,
        depth: chunk.depth,
        content_type: chunk.content_type,
        last_indexed_at: '2026-10-01T00:00:00Z',
      }))));
      return;
    }
    if (request.method === 'PATCH' && url.pathname === '/rest/v1/documents') {
      counters.touches += 1;
      response.statusCode = 204;
      response.end();
      return;
    }
    if (request.method === 'POST' && url.pathname === '/v1/embeddings') {
      counters.embeddings += 1;
      const body = await readJson(request) as { input: string[] };
      response.setHeader('Content-Type', 'application/json');
      const dimensions = mode === 'invalid-embedding' ? 1 : 1536;
      response.end(JSON.stringify({ data: body.input.map((_, index) => ({ index, embedding: Array(dimensions).fill(0.01) })) }));
      return;
    }
    if (request.method === 'POST' && url.pathname === '/rest/v1/documents') {
      counters.inserts += 1;
      const body = await readJson(request) as unknown[];
      response.setHeader('Content-Type', 'application/json');
      response.end(JSON.stringify(body.map((_, index) => ({ id: `10000000-0000-0000-0000-00000000000${index + 1}` }))));
      return;
    }
    if (request.method === 'DELETE' && url.pathname === '/rest/v1/documents') {
      counters.deletes += 1;
      if (mode === 'delete-failure') {
        response.statusCode = 503;
        response.end('temporary delete failure');
        return;
      }
      response.statusCode = 204;
      response.end();
      return;
    }
    if (request.method === 'POST' && url.pathname === '/rest/v1/rag_corpus_state') {
      response.statusCode = 204;
      response.end();
      return;
    }
    if (request.method === 'DELETE' && url.pathname === '/rest/v1/semantic_answer_cache') {
      response.statusCode = 204;
      response.end();
      return;
    }
    response.statusCode = 404;
    response.end('not found');
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  baseUrl = `http://127.0.0.1:${address.port}`;

  const config: IngestionConfig = {
    sitemapIndex: '/wp-sitemap.xml',
    sitemaps: [{ name: 'page-sitemap.xml', contentType: 'page', refreshHours: 24, depth: 'deep' }],
    urlPolicies: [],
    excludePatterns: [],
  };
  const result = await runIngest({
    ...process.env,
    BASE_SITE_URL: baseUrl,
    NEXT_PUBLIC_SUPABASE_URL: baseUrl,
    SUPABASE_SERVICE_ROLE_KEY: 'test-service-key',
    OPENAI_API_KEY: 'test-openai-key',
    OPENAI_EMBEDDINGS_URL: `${baseUrl}/v1/embeddings`,
    INGESTION_CONFIG_JSON: JSON.stringify(config),
  });
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  return { ...result, counters };
}

function readJson(request: http.IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let body = '';
    request.setEncoding('utf8');
    request.on('data', (chunk) => { body += chunk; });
    request.on('end', () => {
      try { resolve(JSON.parse(body)); } catch (error) { reject(error); }
    });
    request.on('error', reject);
  });
}

function runIngest(env: NodeJS.ProcessEnv): Promise<{ code: number | null; output: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [tsxCli, ingestScript, '--force-check'], {
      cwd: repositoryRoot,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    child.stdout.on('data', (chunk) => { output += chunk; });
    child.stderr.on('data', (chunk) => { output += chunk; });
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, output }));
  });
}

test('matching content hash makes no embedding or replacement request', async () => {
  const scenario = await runScenario('matching');
  assert.equal(scenario.code, 0, scenario.output);
  assert.equal(scenario.counters.embeddings, 0);
  assert.equal(scenario.counters.inserts, 0);
  assert.equal(scenario.counters.deletes, 0);
  assert.equal(scenario.counters.touches, 1);
  assert.match(scenario.output, /"unchanged": 1/);
});

test('changed content embeds once and replaces once', async () => {
  const scenario = await runScenario('changed');
  assert.equal(scenario.code, 0, scenario.output);
  assert.equal(scenario.counters.embeddings, 1);
  assert.equal(scenario.counters.inserts, 1);
  assert.equal(scenario.counters.deletes, 1);
  assert.match(scenario.output, /"indexed": 1/);
});

test('invalid embedding response never replaces stored chunks and fails the run', async () => {
  const scenario = await runScenario('invalid-embedding');
  assert.equal(scenario.code, 1, scenario.output);
  assert.equal(scenario.counters.embeddings, 1);
  assert.equal(scenario.counters.inserts, 0);
  assert.equal(scenario.counters.deletes, 0);
  assert.match(scenario.output, /Embedding response mismatch/);
  assert.match(scenario.output, /"failed": 1/);
});

test('old-chunk cleanup failure preserves newly inserted chunks and completes safely', async () => {
  const scenario = await runScenario('delete-failure');
  assert.equal(scenario.code, 0, scenario.output);
  assert.equal(scenario.counters.embeddings, 1);
  assert.equal(scenario.counters.inserts, 1);
  assert.equal(scenario.counters.deletes, 3);
  assert.match(scenario.output, /old-chunk cleanup pending/);
  assert.match(scenario.output, /prevent an availability regression/);
  assert.match(scenario.output, /"indexed": 1/);
  assert.match(scenario.output, /"failed": 0/);
});
