export interface MonitoringQuery {
  id: string;
  question: string | null;
  retrieved_urls: string[] | null;
  similarity_scores: number[] | null;
  answer: string | null;
  fallback_triggered: boolean | null;
  category: string | null;
  cache_hit: boolean | null;
  time_to_first_token_ms: number | null;
  total_response_time_ms: number | null;
  created_at: string;
}

export interface MonitoringEvent {
  event_type: string;
  created_at: string;
}

export interface IngestionStatus {
  conclusion: string | null;
  createdAt: string | null;
  url: string | null;
  failuresInWindow: number;
}

export interface MonitoringInput {
  queries: MonitoringQuery[];
  events: MonitoringEvent[];
  documentChunks: number | null;
  newestDocumentAt: string | null;
  ingestion: IngestionStatus | null;
  periodStart: Date;
  periodEnd: Date;
}

export interface MonitoringReport {
  subject: string;
  text: string;
  html: string;
}

const SENSITIVE_CATEGORIES = new Set(['crisis', 'pastoral']);
const CHICAGO_TIME_ZONE = 'America/Chicago';

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

function formatDate(date: Date): string {
  return new Intl.DateTimeFormat('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    timeZone: CHICAGO_TIME_ZONE,
  }).format(date);
}

function formatDateTime(value: string | null): string {
  if (!value) return 'Unavailable';
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return 'Unavailable';
  return new Intl.DateTimeFormat('en-US', {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    timeZoneName: 'short',
    timeZone: CHICAGO_TIME_ZONE,
  }).format(date);
}

function percentage(numerator: number, denominator: number): string {
  return denominator ? `${(numerator / denominator * 100).toFixed(1)}%` : '0.0%';
}

function average(values: number[]): number | null {
  if (!values.length) return null;
  return Math.round(values.reduce((total, value) => total + value, 0) / values.length);
}

function percentile(values: number[], fraction: number): number | null {
  if (!values.length) return null;
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.min(Math.ceil(sorted.length * fraction) - 1, sorted.length - 1)];
}

function formatMilliseconds(value: number | null): string {
  return value === null ? 'Unavailable' : `${(value / 1000).toFixed(2)}s`;
}

function displayedQuestion(query: MonitoringQuery): string {
  if (SENSITIVE_CATEGORIES.has(query.category ?? '')) return '[Sensitive query redacted]';
  const normalized = query.question?.replace(/\s+/g, ' ').trim() || '[Empty question]';
  return normalized.length > 180 ? `${normalized.slice(0, 177)}...` : normalized;
}

function summarizeCategories(queries: MonitoringQuery[]): Array<[string, number]> {
  const counts = new Map<string, number>();
  for (const query of queries) {
    const category = query.category || 'other';
    counts.set(category, (counts.get(category) ?? 0) + 1);
  }
  return [...counts.entries()].sort((left, right) => right[1] - left[1]);
}

function summarizeRepeatedQuestions(queries: MonitoringQuery[]): Array<[string, number]> {
  const counts = new Map<string, { label: string; count: number }>();
  for (const query of queries) {
    if (SENSITIVE_CATEGORIES.has(query.category ?? '')) continue;
    const label = query.question?.replace(/\s+/g, ' ').trim();
    if (!label) continue;
    const key = label.toLowerCase();
    const existing = counts.get(key);
    counts.set(key, { label, count: (existing?.count ?? 0) + 1 });
  }
  return [...counts.values()]
    .sort((left, right) => right.count - left.count)
    .slice(0, 5)
    .map(({ label, count }) => [label, count]);
}

export function buildWeeklyMonitoringReport(input: MonitoringInput): MonitoringReport {
  const { queries, events } = input;
  const fallbacks = queries.filter((query) => query.fallback_triggered);
  const retrievalFallbacks = fallbacks.filter((query) => !query.cache_hit && !(query.retrieved_urls?.length));
  const postRetrievalAbstentions = fallbacks.filter((query) => (query.retrieved_urls?.length ?? 0) > 0);
  const cacheHits = queries.filter((query) => query.cache_hit).length;
  const totalTimes = queries.flatMap((query) => query.total_response_time_ms === null ? [] : [query.total_response_time_ms]);
  const firstTokenTimes = queries.flatMap((query) => query.time_to_first_token_ms === null ? [] : [query.time_to_first_token_ms]);
  const slowQueries = queries.filter((query) => (query.total_response_time_ms ?? 0) >= 10_000);
  const rateLimits = events.filter((event) => event.event_type === 'rate_limited').length;
  const apiErrors = events.filter((event) => event.event_type === 'api_error').length;
  const categories = summarizeCategories(queries);
  const repeated = summarizeRepeatedQuestions(queries);
  const newestDocumentAgeHours = input.newestDocumentAt
    ? (input.periodEnd.getTime() - new Date(input.newestDocumentAt).getTime()) / 3_600_000
    : null;

  const alerts: string[] = [];
  if (queries.length && fallbacks.length / queries.length >= 0.1) alerts.push(`Fallback rate is ${percentage(fallbacks.length, queries.length)}.`);
  if (retrievalFallbacks.length) alerts.push(`${retrievalFallbacks.length} queries fell back because retrieval had no sources.`);
  if (apiErrors) alerts.push(`${apiErrors} API errors were recorded.`);
  if (input.ingestion?.conclusion && input.ingestion.conclusion !== 'success') alerts.push(`Latest ingestion concluded with ${input.ingestion.conclusion}.`);
  if ((input.ingestion?.failuresInWindow ?? 0) > 0) alerts.push(`${input.ingestion?.failuresInWindow} ingestion runs failed during the period.`);
  if (newestDocumentAgeHours === null || newestDocumentAgeHours > 48) alerts.push('The indexed corpus has not been refreshed in the last 48 hours.');

  const period = `${formatDate(input.periodStart)} – ${formatDate(input.periodEnd)}`;
  const subject = `WellChat weekly monitoring: ${fallbacks.length} fallbacks / ${queries.length} queries (${period})`;
  const metrics = [
    ['Queries', String(queries.length)],
    ['Fallbacks', `${fallbacks.length} (${percentage(fallbacks.length, queries.length)})`],
    ['Retrieval fallbacks (no sources)', String(retrievalFallbacks.length)],
    ['Abstentions after retrieval', String(postRetrievalAbstentions.length)],
    ['Cache hits', `${cacheHits} (${percentage(cacheHits, queries.length)})`],
    ['Average first token', formatMilliseconds(average(firstTokenTimes))],
    ['P95 total response', formatMilliseconds(percentile(totalTimes, 0.95))],
    ['Responses ≥10s', String(slowQueries.length)],
    ['Rate limited requests', String(rateLimits)],
    ['API errors', String(apiErrors)],
    ['Indexed chunks', input.documentChunks === null ? 'Unavailable' : String(input.documentChunks)],
    ['Newest indexed content', formatDateTime(input.newestDocumentAt)],
    ['Latest ingestion', input.ingestion ? `${input.ingestion.conclusion ?? 'unknown'} — ${formatDateTime(input.ingestion.createdAt)}` : 'Unavailable'],
  ] as const;

  const fallbackLines = (items: MonitoringQuery[]) => items.slice(0, 20).map((query) => {
    const sourceState = query.retrieved_urls?.length ? `${query.retrieved_urls.length} source(s)` : 'no sources';
    return `- ${displayedQuestion(query)} — ${sourceState} — ${formatDateTime(query.created_at)}`;
  });
  const text = [
    `WellChat weekly monitoring — ${period}`,
    '',
    alerts.length ? `Needs attention:\n${alerts.map((alert) => `- ${alert}`).join('\n')}` : 'No alert thresholds were crossed.',
    '',
    'Metrics:',
    ...metrics.map(([label, value]) => `- ${label}: ${value}`),
    '',
    'Retrieval fallbacks — no sources found (sensitive text is redacted):',
    ...(fallbackLines(retrievalFallbacks).length ? fallbackLines(retrievalFallbacks) : ['- None']),
    '',
    'Abstentions after retrieval — sources existed, but the answer was safely withheld:',
    ...(fallbackLines(postRetrievalAbstentions).length ? fallbackLines(postRetrievalAbstentions) : ['- None']),
    '',
    'Top categories:',
    ...(categories.length ? categories.map(([category, count]) => `- ${category}: ${count}`) : ['- None']),
    '',
    'Most repeated non-sensitive questions:',
    ...(repeated.length ? repeated.map(([question, count]) => `- ${question}: ${count}`) : ['- None']),
    '',
    input.ingestion?.url ? `Latest ingestion run: ${input.ingestion.url}` : '',
  ].filter((line, index, all) => line || index < all.length - 1).join('\n');

  const metricRows = metrics.map(([label, value]) => `<tr><td style="padding:7px 12px;border-bottom:1px solid #e5e7eb">${escapeHtml(label)}</td><td style="padding:7px 12px;border-bottom:1px solid #e5e7eb;font-weight:600">${escapeHtml(value)}</td></tr>`).join('');
  const fallbackItems = (items: MonitoringQuery[]) => items.slice(0, 20).map((query) => `<li style="margin:8px 0"><strong>${escapeHtml(displayedQuestion(query))}</strong><br><span style="color:#52605d">${query.retrieved_urls?.length ?? 0} source(s) · ${escapeHtml(formatDateTime(query.created_at))}</span></li>`).join('') || '<li>None</li>';
  const alertHtml = alerts.length
    ? `<div style="background:#fff4e5;border:1px solid #f0c36d;border-radius:8px;padding:12px 16px"><strong>Needs attention</strong><ul>${alerts.map((alert) => `<li>${escapeHtml(alert)}</li>`).join('')}</ul></div>`
    : '<div style="background:#eaf8f4;border:1px solid #9bd8c8;border-radius:8px;padding:12px 16px"><strong>No alert thresholds were crossed.</strong></div>';
  const html = `<!doctype html><html><body style="font-family:Arial,sans-serif;color:#17332f;line-height:1.45"><div style="max-width:720px;margin:auto;padding:24px"><h1 style="font-size:24px;margin-bottom:4px">WellChat weekly monitoring</h1><p style="color:#52605d;margin-top:0">${escapeHtml(period)}</p>${alertHtml}<h2 style="font-size:18px;margin-top:24px">Metrics</h2><table style="width:100%;border-collapse:collapse;border:1px solid #e5e7eb">${metricRows}</table><h2 style="font-size:18px;margin-top:24px">Retrieval fallbacks</h2><p style="color:#52605d">No sources were found. Sensitive pastoral and crisis query text is always redacted.</p><ol>${fallbackItems(retrievalFallbacks)}</ol><h2 style="font-size:18px;margin-top:24px">Abstentions after retrieval</h2><p style="color:#52605d">Sources existed, but the answer was safely withheld rather than inferred.</p><ol>${fallbackItems(postRetrievalAbstentions)}</ol><h2 style="font-size:18px;margin-top:24px">Top categories</h2><ul>${categories.map(([category, count]) => `<li>${escapeHtml(category)}: ${count}</li>`).join('') || '<li>None</li>'}</ul><h2 style="font-size:18px;margin-top:24px">Most repeated questions</h2><ul>${repeated.map(([question, count]) => `<li>${escapeHtml(question)}: ${count}</li>`).join('') || '<li>None</li>'}</ul>${input.ingestion?.url ? `<p><a href="${escapeHtml(input.ingestion.url)}">View latest ingestion run</a></p>` : ''}</div></body></html>`;

  return { subject, text, html };
}
