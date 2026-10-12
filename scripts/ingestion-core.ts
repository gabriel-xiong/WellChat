import { createHash } from 'node:crypto';

export type Depth = 'deep' | 'shallow';

export interface SitemapPolicy {
  name: string;
  contentType: string;
  refreshHours: number;
  depth: Depth;
}

export interface UrlPolicy {
  pattern: string;
  refreshHours?: number;
  contentType?: string;
  depth?: Depth;
}

export interface IngestionConfig {
  sitemapIndex: string;
  sitemaps: SitemapPolicy[];
  urlPolicies: UrlPolicy[];
  excludePatterns: string[];
}

export interface SitemapEntry {
  url: string;
  lastModified: string | null;
}

export interface DiscoveredSource extends SitemapEntry {
  sitemapUrl: string;
  sitemapName: string;
  contentType: string;
  refreshHours: number;
  depth: Depth;
}

export interface PageChunk {
  url: string;
  title: string;
  section: string;
  content: string;
  depth: Depth;
  content_type: string;
  embedding?: number[];
}

function decodeXmlEntities(value: string): string {
  return value
    .replaceAll('&amp;', '&')
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>')
    .replaceAll('&quot;', '"')
    .replaceAll('&apos;', "'");
}

export function parseSitemapEntries(xml: string): SitemapEntry[] {
  const entries: SitemapEntry[] = [];
  const blocks = xml.match(/<(?:url|sitemap)>[\s\S]*?<\/(?:url|sitemap)>/gi) ?? [];
  for (const block of blocks) {
    const location = block.match(/<loc>\s*([\s\S]*?)\s*<\/loc>/i)?.[1];
    if (!location) continue;
    const lastModified = block.match(/<lastmod>\s*([\s\S]*?)\s*<\/lastmod>/i)?.[1] ?? null;
    entries.push({
      url: decodeXmlEntities(location.trim()),
      lastModified: lastModified ? decodeXmlEntities(lastModified.trim()) : null,
    });
  }
  return entries;
}

export function canonicalizeUrl(value: string, baseSiteUrl: string): string {
  const url = new URL(value, `${baseSiteUrl.replace(/\/+$/, '')}/`);
  url.hash = '';
  url.search = '';
  url.hostname = url.hostname.toLowerCase();
  url.protocol = url.protocol.toLowerCase();
  const path = url.pathname.replace(/\/{2,}/g, '/').replace(/\/$/, '') || '/';
  url.pathname = path;
  return url.toString().replace(/\/$/, path === '/' ? '/' : '');
}

export function sitemapName(url: string): string {
  return new URL(url).pathname.split('/').filter(Boolean).at(-1) ?? '';
}

export function resolveSitemapPolicy(url: string, config: IngestionConfig): SitemapPolicy | null {
  const name = sitemapName(url);
  return config.sitemaps.find((candidate) => candidate.name === name) ?? null;
}

export function applyUrlPolicy(source: DiscoveredSource, config: IngestionConfig): DiscoveredSource | null {
  const pathname = new URL(source.url).pathname;
  if (config.excludePatterns.some((pattern) => new RegExp(pattern, 'i').test(pathname))) return null;
  const override = config.urlPolicies.find((policy) => new RegExp(policy.pattern, 'i').test(pathname));
  if (!override) return source;
  return {
    ...source,
    refreshHours: override.refreshHours ?? source.refreshHours,
    contentType: override.contentType ?? source.contentType,
    depth: override.depth ?? source.depth,
  };
}

export function isPageDue(
  source: DiscoveredSource,
  documents: Array<{ last_indexed_at: string }>,
  now: Date,
  forceCheck = false
): boolean {
  if (forceCheck || !documents.length) return true;
  const timestamps = documents.map((document) => Date.parse(document.last_indexed_at)).filter(Number.isFinite);
  if (!timestamps.length) return true;
  const lastVerified = Math.max(...timestamps);
  const sitemapModified = source.lastModified ? Date.parse(source.lastModified) : Number.NaN;
  if (Number.isFinite(sitemapModified) && sitemapModified > lastVerified) return true;
  return now.getTime() - lastVerified >= source.refreshHours * 60 * 60 * 1000;
}

export function isNoIndexPage(html: string): boolean {
  const metaTags = html.match(/<meta\b[^>]*>/gi) ?? [];
  return metaTags.some((tag) =>
    /(?:name|property)=["'](?:robots|googlebot)["']/i.test(tag)
      && /content=["'][^"']*\bnoindex\b/i.test(tag)
  );
}

export function normalizeWhitespace(text: string): string {
  return text.replace(/[\s\u00A0]+/g, ' ').trim();
}

export function decodeHtmlEntities(text: string): string {
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

export function htmlToText(html: string): string {
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
    : html;
  const withoutChrome = contentHtml
    .replace(/<nav[\s\S]*?<\/nav>/gi, ' ')
    .replace(/<header[\s\S]*?<\/header>/gi, ' ')
    .replace(/<footer[\s\S]*?<\/footer>/gi, ' ');
  const withoutScripts = withoutChrome.replace(/<script[\s\S]*?<\/script>/gi, ' ');
  const withoutStyles = withoutScripts.replace(/<style[\s\S]*?<\/style>/gi, ' ');
  const withHeadingMarkers = withoutStyles.replace(/<h([1-6])[^>]*>([\s\S]*?)<\/h\1>/gi, (_, _level, content) => {
    const heading = normalizeWhitespace(decodeHtmlEntities(content.replace(/<[^>]+>/g, ' ')));
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
    .replaceAll('"/>', ' ')
    .replaceAll('→', ' ')
    .replace(/\s\+\s/g, ' ');
  return normalizePlainText(cleanedText).replaceAll(' # ', '\n# ');
}

export function shouldEmbedPage(hash: string, storedHash: string | null | undefined, forceEmbed = false): boolean {
  return forceEmbed || !storedHash || hash !== storedHash;
}

export function extractTitle(html: string): string {
  const titleMatch = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  if (titleMatch?.[1]) return normalizeWhitespace(decodeHtmlEntities(titleMatch[1].replace(/<[^>]+>/g, ' ')));
  const h1Match = html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i);
  if (h1Match?.[1]) return normalizeWhitespace(decodeHtmlEntities(h1Match[1].replace(/<[^>]+>/g, ' ')));
  return 'Untitled Page';
}

const EVENT_MONTHS = new Map<string, number>([
  ['jan', 0], ['january', 0], ['feb', 1], ['february', 1], ['mar', 2], ['march', 2],
  ['apr', 3], ['april', 3], ['may', 4], ['jun', 5], ['june', 5], ['jul', 6], ['july', 6],
  ['aug', 7], ['august', 7], ['sep', 8], ['sept', 8], ['september', 8], ['oct', 9],
  ['october', 9], ['nov', 10], ['november', 10], ['dec', 11], ['december', 11],
]);

export function extractEventEndDate(html: string, text: string, url: string): Date | null {
  const datePublished = html.match(/["']datePublished["']\s*:\s*["'](\d{4})-(\d{2})-(\d{2})/i);
  const urlYear = new URL(url).pathname.match(/\/(20\d{2})(?:\/|$)/)?.[1];
  const publishedYear = datePublished ? Number(datePublished[1]) : null;
  const publishedMonth = datePublished ? Number(datePublished[2]) - 1 : null;
  let year = urlYear ? Number(urlYear) : publishedYear;
  if (!year) return null;

  const datePattern = /\b(Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:t(?:ember)?)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)\s*\.?\s*(\d{1,2})\b/gi;
  const firstHeading = text.match(/(?:^|\n)#\s+([^\n]+)/)?.[1];
  const firstHeadingIndex = text.indexOf('\n# ');
  const preamble = firstHeadingIndex > 0 ? text.slice(0, firstHeadingIndex) : '';
  const dateBearingText = new URL(url).pathname.startsWith('/retreats/') && datePattern.test(preamble)
    ? preamble
    : firstHeading ?? text.slice(0, 1200);
  datePattern.lastIndex = 0;
  const matches = [...dateBearingText.matchAll(datePattern)].map((match) => ({
    month: EVENT_MONTHS.get(match[1].toLowerCase())!,
    day: Number(match[2]),
  })).filter(({ month, day }) => Number.isInteger(month) && day >= 1 && day <= 31);
  if (!matches.length) return null;

  if (!urlYear && publishedMonth !== null && matches[0].month < publishedMonth - 6) year += 1;
  let previousMonth = matches[0].month;
  let end = new Date(Date.UTC(year, matches[0].month, matches[0].day, 23, 59, 59));
  for (const match of matches.slice(1)) {
    if (match.month < previousMonth) year += 1;
    const candidate = new Date(Date.UTC(year, match.month, match.day, 23, 59, 59));
    if (candidate > end) end = candidate;
    previousMonth = match.month;
  }
  return Number.isNaN(end.getTime()) ? null : end;
}

export function isEventExpired(endDate: Date | null, now: Date, graceHours = 48): boolean {
  return Boolean(endDate && now.getTime() > endDate.getTime() + graceHours * 60 * 60 * 1000);
}

export function splitByHeadings(text: string): Array<{ section: string; content: string }> {
  const parts = text.split(/\n(?=# )/g).map((part) => part.trim()).filter(Boolean);
  if (parts.length <= 1) return [{ section: 'page', content: text }];
  return parts.map((part) => {
    const firstLineEnd = part.indexOf('\n');
    const firstLine = firstLineEnd >= 0 ? part.slice(0, firstLineEnd) : part;
    const section = firstLine.replace(/^#\s*/, '').trim() || 'page';
    let content = firstLineEnd >= 0 ? part.slice(firstLineEnd + 1).trim() : '';
    if (content.toLowerCase().startsWith(section.toLowerCase())) content = content.slice(section.length).trim();
    return { section, content };
  });
}

export function mergeShortSections(sections: Array<{ section: string; content: string }>): Array<{ section: string; content: string }> {
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

export function chunkLongText(section: { section: string; content: string }, maxLength = 1800): Array<{ section: string; content: string }> {
  if (section.content.length <= maxLength) return [section];
  const words = section.content.split(/\s+/);
  const chunks: Array<{ section: string; content: string }> = [];
  let currentWords: string[] = [];
  let currentLength = 0;
  for (const word of words) {
    currentWords.push(word);
    currentLength += word.length + (currentWords.length > 1 ? 1 : 0);
    if (currentLength >= maxLength) {
      chunks.push({ section: section.section, content: currentWords.join(' ') });
      currentWords = [];
      currentLength = 0;
    }
  }
  if (currentWords.length) chunks.push({ section: section.section, content: currentWords.join(' ') });
  return chunks;
}

export function buildChunks(url: string, title: string, depth: Depth, contentType: string, text: string): PageChunk[] {
  const chunks = mergeShortSections(splitByHeadings(text)).flatMap((section) =>
    chunkLongText(section).map((bounded) => ({
      url,
      title,
      section: bounded.section,
      content: bounded.content,
      depth,
      content_type: contentType,
    }))
  );
  const filtered = chunks.filter((chunk) => chunk.content.trim().length >= 20);
  return filtered.length ? filtered : [{ url, title, section: 'page', content: text, depth, content_type: contentType }];
}

export function contentHash(title: string, chunks: PageChunk[]): string {
  const normalizedChunks = chunks.map(({ section, content }) => ({
    section: normalizeWhitespace(section),
    content: normalizeWhitespace(content),
  })).sort((left, right) =>
    left.section.localeCompare(right.section) || left.content.localeCompare(right.content)
  );
  const canonical = JSON.stringify({
    title: normalizeWhitespace(title),
    chunks: normalizedChunks,
  });
  return createHash('sha256').update(canonical).digest('hex');
}

export function summaryForSource(url: string, contentType: string): string | undefined {
  if (contentType === 'sundays' || url.includes('/sundays')) return 'Sunday gathering times, service times, worship service schedule, weekly meeting times, location, and visitor information at The Well Austin.';
  if (contentType === 'event') return 'This page contains information about an event at The Well Austin.';
  if (contentType === 'retreat') return 'This page contains dates, registration, location, and details for a retreat at The Well Austin.';
  if (contentType === 'job') return 'This page contains information about a job opening at The Well Austin.';
  if (contentType === 'community_group') return 'This page contains information about a community group at The Well Austin.';
  if (contentType === 'sermon') return 'This page contains a sermon series from The Well Austin.';
  if (contentType === 'resource') return 'This page contains a resource from The Well Austin.';
  if (contentType === 'staff') return 'This page contains information about a staff or team member at The Well Austin.';
  if (url.includes('/giving')) return 'This page contains information about how to give and donate to The Well Austin.';
  if (url.includes('/serve')) return 'This page contains information about volunteer teams and how to serve at The Well Austin.';
  if (url.includes('/beliefs')) return 'This page contains information about what The Well Austin believes doctrinally.';
  if (url.includes('/mission')) return 'This page describes the mission, vision, and values of The Well Austin.';
  return undefined;
}

export function addRetrievalSummary(chunks: PageChunk[], summary: string | undefined): PageChunk[] {
  if (!summary) return chunks;
  return chunks.map((chunk) => ({ ...chunk, content: `${summary}\n\n${chunk.content}` }));
}
