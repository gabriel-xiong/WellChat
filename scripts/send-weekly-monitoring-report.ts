import { createClient } from '@supabase/supabase-js';
import {
  buildWeeklyMonitoringReport,
  IngestionStatus,
  MonitoringEvent,
  MonitoringQuery,
} from './weekly-monitoring-core';

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL?.replace(/\/+$/, '');
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const RESEND_API_KEY = process.env.RESEND_API_KEY;
const EMAIL_TO = process.env.MONITORING_EMAIL_TO;
const EMAIL_FROM = process.env.MONITORING_EMAIL_FROM;
const LOOKBACK_DAYS = Math.max(1, Number(process.env.MONITORING_LOOKBACK_DAYS ?? '7'));
const DRY_RUN = process.argv.includes('--dry-run') || process.env.MONITORING_REPORT_DRY_RUN === 'true';

function required(name: string, value: string | undefined): string {
  if (!value) throw new Error(`${name} is required.`);
  return value;
}

async function readAllQueries(since: string): Promise<MonitoringQuery[]> {
  const supabase = createClient(required('NEXT_PUBLIC_SUPABASE_URL', SUPABASE_URL), required('SUPABASE_SERVICE_ROLE_KEY', SUPABASE_SERVICE_ROLE_KEY), { auth: { persistSession: false } });
  const rows: MonitoringQuery[] = [];
  const pageSize = 1000;
  for (let offset = 0; ; offset += pageSize) {
    const { data, error } = await supabase
      .from('query_logs')
      .select('id,question,retrieved_urls,similarity_scores,answer,fallback_triggered,category,cache_hit,time_to_first_token_ms,total_response_time_ms,created_at')
      .gte('created_at', since)
      .order('created_at', { ascending: false })
      .range(offset, offset + pageSize - 1);
    if (error) throw new Error(`Unable to read query logs: ${error.message}`);
    const page = (data ?? []) as MonitoringQuery[];
    rows.push(...page);
    if (page.length < pageSize) return rows;
  }
}

async function readSupportingMetrics(since: string): Promise<{
  events: MonitoringEvent[];
  documentChunks: number | null;
  newestDocumentAt: string | null;
}> {
  const supabase = createClient(required('NEXT_PUBLIC_SUPABASE_URL', SUPABASE_URL), required('SUPABASE_SERVICE_ROLE_KEY', SUPABASE_SERVICE_ROLE_KEY), { auth: { persistSession: false } });
  const [eventResult, countResult, newestResult] = await Promise.all([
    supabase.from('chat_events').select('event_type,created_at').gte('created_at', since),
    supabase.from('documents').select('id', { count: 'exact', head: true }),
    supabase.from('documents').select('last_indexed_at').order('last_indexed_at', { ascending: false }).limit(1).maybeSingle(),
  ]);
  if (eventResult.error) throw new Error(`Unable to read chat events: ${eventResult.error.message}`);
  if (countResult.error) throw new Error(`Unable to count documents: ${countResult.error.message}`);
  if (newestResult.error) throw new Error(`Unable to read corpus freshness: ${newestResult.error.message}`);
  return {
    events: (eventResult.data ?? []) as MonitoringEvent[],
    documentChunks: countResult.count,
    newestDocumentAt: newestResult.data?.last_indexed_at ?? null,
  };
}

async function readIngestionStatus(since: Date): Promise<IngestionStatus | null> {
  const token = process.env.GITHUB_TOKEN;
  const repository = process.env.GITHUB_REPOSITORY;
  if (!token || !repository) return null;
  try {
    const response = await fetch(`https://api.github.com/repos/${repository}/actions/workflows/ingest.yml/runs?per_page=30`, {
      headers: {
        Accept: 'application/vnd.github+json',
        Authorization: `Bearer ${token}`,
        'User-Agent': 'WellChat-monitoring',
        'X-GitHub-Api-Version': '2022-11-28',
      },
      signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) throw new Error(`GitHub returned ${response.status}`);
    const payload = await response.json() as { workflow_runs?: Array<{ conclusion?: string; created_at?: string; html_url?: string }> };
    const runs = payload.workflow_runs ?? [];
    const latest = runs[0];
    return {
      conclusion: latest?.conclusion ?? null,
      createdAt: latest?.created_at ?? null,
      url: latest?.html_url ?? null,
      failuresInWindow: runs.filter((run) => run.conclusion === 'failure' && run.created_at && new Date(run.created_at) >= since).length,
    };
  } catch (error) {
    console.warn('Unable to include GitHub ingestion status:', error instanceof Error ? error.message : error);
    return null;
  }
}

async function sendEmail(subject: string, text: string, html: string): Promise<void> {
  const response = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${required('RESEND_API_KEY', RESEND_API_KEY)}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      from: required('MONITORING_EMAIL_FROM', EMAIL_FROM),
      to: required('MONITORING_EMAIL_TO', EMAIL_TO).split(',').map((email) => email.trim()).filter(Boolean),
      subject,
      text,
      html,
    }),
    signal: AbortSignal.timeout(20_000),
  });
  if (!response.ok) throw new Error(`Resend email failed: ${response.status} ${await response.text()}`);
}

async function main(): Promise<void> {
  const periodEnd = new Date();
  const periodStart = new Date(periodEnd.getTime() - LOOKBACK_DAYS * 86_400_000);
  const since = periodStart.toISOString();
  const [queries, supporting, ingestion] = await Promise.all([
    readAllQueries(since),
    readSupportingMetrics(since),
    readIngestionStatus(periodStart),
  ]);
  const report = buildWeeklyMonitoringReport({
    queries,
    events: supporting.events,
    documentChunks: supporting.documentChunks,
    newestDocumentAt: supporting.newestDocumentAt,
    ingestion,
    periodStart,
    periodEnd,
  });

  if (DRY_RUN) {
    console.log(report.subject);
    console.log('\n' + report.text);
    return;
  }

  await sendEmail(report.subject, report.text, report.html);
  console.log(`Sent weekly monitoring report to ${EMAIL_TO}.`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
