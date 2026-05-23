import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const ROOT_DIR = path.dirname(fileURLToPath(import.meta.url));
const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL?.replace(/\/+$/, '');
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const BASE_SITE_URL = process.env.BASE_SITE_URL?.replace(/\/+$/, '');
const APPROVED_PAGES_FILE = path.resolve(ROOT_DIR, '../approved-pages.json');

export type Depth = 'deep' | 'shallow';
export interface ApprovedPageConfig {
  url: string;
  depth: Depth;
}

interface PageChunk {
  url: string;
  title: string;
  section: string;
  content: string;
  depth: Depth;
  content_type: string;
  embedding?: number[];
}

function assertEnv(): void {
  if (!SUPABASE_URL) throw new Error('NEXT_PUBLIC_SUPABASE_URL is required.');
  if (!SUPABASE_SERVICE_ROLE_KEY) throw new Error('SUPABASE_SERVICE_ROLE_KEY is required.');
  if (!OPENAI_API_KEY) throw new Error('OPENAI_API_KEY is required.');
  if (!BASE_SITE_URL) throw new Error('BASE_SITE_URL is required.');
}

function loadApprovedPages(): ApprovedPageConfig[] {
  if (fs.existsSync(APPROVED_PAGES_FILE)) {
    const raw = fs.readFileSync(APPROVED_PAGES_FILE, 'utf-8');
    const parsed = JSON.parse(raw) as ApprovedPageConfig[];
    if (!Array.isArray(parsed)) {
      throw new Error(`${APPROVED_PAGES_FILE} must contain an array of approved pages.`);
    }
    return parsed;
  }

  const envJson = process.env.APPROVED_PAGES_JSON;
  if (envJson) {
    const parsed = JSON.parse(envJson) as ApprovedPageConfig[];
    if (!Array.isArray(parsed)) {
      throw new Error('APPROVED_PAGES_JSON must be a JSON array of approved pages.');
    }
    return parsed;
  }

  throw new Error(
    'No approved pages config found. Create scripts/approved-pages.json or set APPROVED_PAGES_JSON in the environment.'
  );
}

function normalizeUrl(url: string): string {
  if (/^https?:\/\//i.test(url)) return url;
  return `${BASE_SITE_URL}${url.startsWith('/') ? '' : '/'}${url}`;
}

function normalizeWhitespace(text: string): string {
  return text.replace(/[\s\u00A0]+/g, ' ').trim();
}

function decodeHtmlEntities(text: string): string {
  return text.replace(/&(?:quot|amp|apos|lt|gt);/g, (entity) => {
    switch (entity) {
      case '&quot;': return '"';
      case '&amp;': return '&';
      case '&apos;': return "'";
      case '&lt;': return '<';
      case '&gt;': return '>';
      default: return entity;
    }
  }).replace(/&#(\d+);/g, (_, code) => String.fromCharCode(Number(code)))
    .replace(/&#x([\da-fA-F]+);/g, (_, code) => String.fromCharCode(parseInt(code, 16)));
}

function htmlToText(html: string): string {
  const normalizePlainText = (text: string): string => {
    const headingBreakToken = '___HEADING_BREAK___';
    return normalizeWhitespace(text.replace(/\n+(?=\s*# )/g, ` ${headingBreakToken} `))
      .replaceAll(headingBreakToken, '\n');
  };
  const lowerHtml = html.toLowerCase();
  const mainStart = lowerHtml.indexOf('<main');
  const mainOpenEnd = mainStart >= 0 ? html.indexOf('>', mainStart) : -1;
  const mainEnd = lowerHtml.lastIndexOf('</main>');
  const contentHtml = mainStart >= 0 && mainOpenEnd >= 0 && mainEnd > mainOpenEnd
    ? html.slice(mainOpenEnd + 1, mainEnd)
    : html
      .replace(/<nav[\s\S]*<\/nav>/gi, ' ')
      .replace(/<header[\s\S]*<\/header>/gi, ' ')
      .replace(/<footer[\s\S]*<\/footer>/gi, ' ');
  const withoutScripts = contentHtml.replace(/<script[\s\S]*?<\/script>/gi, ' ');
  const withoutStyles = withoutScripts.replace(/<style[\s\S]*?<\/style>/gi, ' ');
  const withHeadingMarkers = withoutStyles.replace(/<h([1-6])[^>]*>([\s\S]*?)<\/h\1>/gi, (_, level, content) => {
    const heading = normalizeWhitespace(decodeHtmlEntities(content));
    return `\n\n# ${heading}\n\n`;
  });
  const textOnly = withHeadingMarkers.replace(/<[^>]+>/g, ' ');
  const plainText = normalizePlainText(decodeHtmlEntities(textOnly));
  const skipToContentIndex = plainText.slice(0, 3000).toLowerCase().indexOf('skip to content');
  const contentWithoutSkipLink = skipToContentIndex >= 0
    ? plainText.slice(skipToContentIndex + 'skip to content'.length).trim()
    : plainText;
  const cleanedText = contentWithoutSkipLink
    .replaceAll('Watch Video', ' ')
    .replaceAll('Learn More', ' ')
    .replaceAll('Register', ' ')
    .replaceAll('Copy to clipboard', ' ')
    .replaceAll('" />', ' ')
    .replaceAll('→', ' ')
    .replace(/\s\+\s/g, ' ');
  return normalizePlainText(cleanedText).replaceAll(' # ', '\n# ');
}

function extractTitle(html: string): string {
  const titleMatch = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  if (titleMatch?.[1]) return normalizeWhitespace(decodeHtmlEntities(titleMatch[1]));

  const h1Match = html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i);
  if (h1Match?.[1]) return normalizeWhitespace(decodeHtmlEntities(h1Match[1]));

  return 'Untitled Page';
}

function splitByHeadings(text: string): Array<{ section: string; content: string }> {
  const parts = text.split(/\n(?=# )/g).map((part) => part.trim()).filter(Boolean);
  if (parts.length <= 1) {
    return [{ section: 'page', content: text }];
  }

  return parts.map((part) => {
    const firstLineEnd = part.indexOf('\n');
    const firstLine = firstLineEnd >= 0 ? part.slice(0, firstLineEnd) : part;
    const section = firstLine.replace(/^#\s*/, '').trim() || 'page';
    let content = firstLineEnd >= 0 ? part.slice(firstLineEnd + 1).trim() : '';
    if (content.toLowerCase().startsWith(section.toLowerCase())) {
      content = content.slice(section.length).trim();
    }
    return { section, content };
  });
}

function mergeShortSections(sections: Array<{ section: string; content: string }>): Array<{ section: string; content: string }> {
  const merged: Array<{ section: string; content: string }> = [];

  for (let index = 0; index < sections.length; index += 1) {
    const current = { ...sections[index] };

    while (current.content.length < 300 && index + 1 < sections.length) {
      index += 1;
      const next = sections[index];
      current.content = `${current.content}\n\n${next.section}\n\n${next.content}`.trim();
    }

    merged.push(current);
  }

  return merged;
}

function chunkLongText(section: { section: string; content: string }, maxLength = 1800): Array<{ section: string; content: string }> {
  if (section.content.length <= maxLength) return [section];

  const words = section.content.split(/\s+/);
  const chunks: Array<{ section: string; content: string }> = [];
  let currentWords: string[] = [];

  for (const word of words) {
    currentWords.push(word);
    if (currentWords.join(' ').length >= maxLength) {
      chunks.push({ section: section.section, content: currentWords.join(' ') });
      currentWords = [];
    }
  }

  if (currentWords.length) {
    chunks.push({ section: section.section, content: currentWords.join(' ') });
  }

  return chunks;
}

function buildChunks(url: string, title: string, depth: Depth, text: string): PageChunk[] {
  const sectioned = mergeShortSections(splitByHeadings(text));
  const chunks: PageChunk[] = [];

  for (const section of sectioned) {
    const boundedSections = chunkLongText(section, 1800);
    for (const bounded of boundedSections) {
      chunks.push({
        url,
        title,
        section: bounded.section,
        content: bounded.content,
        depth,
        content_type: 'page',
      });
    }
  }

  const filteredChunks = chunks.filter((chunk) => chunk.content.trim().length >= 20);
  return filteredChunks.length ? filteredChunks : [{ url, title, section: 'page', content: text, depth, content_type: 'page' }];
}

function summaryForUrl(url: string): string | undefined {
  if (url.includes('/sundays')) return 'Sunday gathering times, service times, worship service schedule, what time does church start, weekly meeting times, location, address, where is The Well located at The Well Austin: 9am and 11am at Eastside Early College High School, 903 Neal Street, Austin TX.';
  if (url.includes('/giving')) return 'This page contains information about how to give and donate to The Well Austin.';
  if (url.includes('/serve')) return 'This page contains information about volunteer teams and how to sign up to serve and volunteer at The Well Austin.';
  if (url.includes('/community')) return 'This page contains information about community groups across Austin at The Well Austin.';
  if (url.includes('/ministries')) return 'This page contains information about ministries including kids ministry at The Well Austin.';
  if (url.includes('/beliefs')) return 'This page contains information about what The Well Austin believes doctrinally.';
  if (url.includes('/events')) return 'This page contains information about upcoming events at The Well Austin.';
  if (url.includes('/team')) return 'This page contains information about The Well Austin staff and team members.';
  return undefined;
}

function formatEventListings(text: string): string {
  const monthPattern = 'Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec';
  const cleanedText = text.replace(new RegExp(`\\b(${monthPattern})\\s+\\.\\s+(\\d{1,2})\\b`, 'g'), '$1 $2');
  const datePattern = new RegExp(`\\b(${monthPattern})\\s+(\\d{1,2})(?:\\s+[—-]\\s+(${monthPattern})\\s+(\\d{1,2}))?\\b`, 'g');
  const matches = Array.from(cleanedText.matchAll(datePattern));

  if (!matches.length) return cleanedText;

  const eventLines = matches.map((match, index) => {
    const nextMatch = matches[index + 1];
    const eventName = cleanedText.slice(match.index! + match[0].length, nextMatch?.index ?? cleanedText.length).trim();
    const startDate = `${match[1]} ${Number(match[2])}`;
    const endDate = match[3] && match[4] ? ` - ${match[3]} ${Number(match[4])}` : '';
    return eventName ? `- ${eventName}: ${startDate}${endDate}` : '';
  }).filter(Boolean);

  return eventLines.length ? eventLines.join('\n') : cleanedText;
}

async function fetchPage(url: string): Promise<string> {
  const response = await fetch(url, { headers: { 'User-Agent': 'TheWellIngest/1.0' } });
  if (!response.ok) {
    throw new Error(`Failed to fetch ${url}: ${response.status} ${response.statusText}`);
  }
  return response.text();
}

async function embedTexts(texts: string[]): Promise<number[][]> {
  const response = await fetch('https://api.openai.com/v1/embeddings', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${OPENAI_API_KEY}`,
    },
    body: JSON.stringify({ model: 'text-embedding-3-small', input: texts }),
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`OpenAI embedding request failed: ${response.status} ${response.statusText} - ${body}`);
  }

  const payload = await response.json();
  return payload.data.map((item: any) => item.embedding as number[]);
}

async function deleteExistingRows(url: string): Promise<void> {
  const encodedUrl = encodeURIComponent(url);
  const response = await fetch(`${SUPABASE_URL}/rest/v1/documents?url=eq.${encodedUrl}`, {
    method: 'DELETE',
    headers: {
      apikey: SUPABASE_SERVICE_ROLE_KEY,
      Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
      Accept: 'application/json',
    },
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Supabase delete failed for ${url}: ${response.status} ${response.statusText} - ${body}`);
  }
}

async function insertChunks(chunks: PageChunk[], indexedAt: string): Promise<void> {
  const rows = chunks.map((chunk) => ({
    url: chunk.url,
    title: chunk.title,
    section: chunk.section,
    content: chunk.content,
    embedding: chunk.embedding,
    depth: chunk.depth,
    content_type: chunk.content_type,
    last_indexed_at: indexedAt,
  }));

  const response = await fetch(`${SUPABASE_URL}/rest/v1/documents`, {
    method: 'POST',
    headers: {
      apikey: SUPABASE_SERVICE_ROLE_KEY,
      Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
    body: JSON.stringify(rows),
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Supabase insert failed: ${response.status} ${response.statusText} - ${body}`);
  }
}

async function ingestPage(page: ApprovedPageConfig): Promise<void> {
  const resolvedUrl = normalizeUrl(page.url);
  console.log(`Ingesting ${resolvedUrl} (${page.depth})...`);

  const html = await fetchPage(resolvedUrl);
  const title = extractTitle(html);
  const plainText = resolvedUrl.includes('/events') ? formatEventListings(htmlToText(html)) : htmlToText(html);
  const summary = summaryForUrl(resolvedUrl);
  const rawChunks = buildChunks(resolvedUrl, title, page.depth, plainText).map((chunk) => ({
    ...chunk,
    content: summary ? `${summary}\n\n${chunk.content}` : chunk.content,
  }));

  const texts = rawChunks.map((chunk) => `${chunk.section}\n\n${chunk.content}`);
  const embeddings = await embedTexts(texts);

  const indexedAt = new Date().toISOString();
  const chunksWithEmbedding = rawChunks.map((chunk, index) => ({
    ...chunk,
    embedding: embeddings[index],
  }));

  await deleteExistingRows(resolvedUrl);
  await insertChunks(chunksWithEmbedding, indexedAt);
  console.log(`Stored ${chunksWithEmbedding.length} chunks for ${resolvedUrl}`);
}

async function main(): Promise<void> {
  assertEnv();
  const approvedPages = loadApprovedPages();

  if (!approvedPages.length) {
    console.log('No approved pages configured. Nothing to ingest.');
    return;
  }

  for (const page of approvedPages) {
    try {
      await ingestPage(page);
    } catch (error) {
      console.error(`Failed to ingest ${page.url}:`, error instanceof Error ? error.message : error);
    }
  }

  console.log('Ingestion complete.');
}

if (process.argv[1].endsWith('ingest.ts') || process.argv[1].endsWith('ingest.js')) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  });
}
