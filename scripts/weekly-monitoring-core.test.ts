import assert from 'node:assert/strict';
import test from 'node:test';
import { buildWeeklyMonitoringReport, MonitoringInput, MonitoringQuery } from './weekly-monitoring-core';

function query(overrides: Partial<MonitoringQuery>): MonitoringQuery {
  return {
    id: crypto.randomUUID(),
    question: 'When are services?',
    retrieved_urls: ['https://thewellaustin.com/sundays'],
    similarity_scores: [0.6],
    answer: 'Services are at 9 and 11.',
    fallback_triggered: false,
    category: 'sundays',
    cache_hit: false,
    time_to_first_token_ms: 800,
    total_response_time_ms: 2500,
    created_at: '2026-10-30T15:00:00Z',
    ...overrides,
  };
}

function input(queries: MonitoringQuery[]): MonitoringInput {
  return {
    queries,
    events: [{ event_type: 'rate_limited', created_at: '2026-10-30T15:00:00Z' }],
    documentChunks: 1000,
    newestDocumentAt: '2026-11-01T12:00:00Z',
    ingestion: {
      conclusion: 'success',
      createdAt: '2026-11-01T12:00:00Z',
      url: 'https://github.com/example/actions/runs/1',
      failuresInWindow: 0,
    },
    periodStart: new Date('2026-10-26T14:00:00Z'),
    periodEnd: new Date('2026-11-02T14:00:00Z'),
  };
}

test('builds a useful weekly report with fallback and operational metrics', () => {
  const report = buildWeeklyMonitoringReport(input([
    query({}),
    query({ question: 'Unknown event?', fallback_triggered: true, retrieved_urls: [] }),
  ]));
  assert.match(report.subject, /1 fallbacks \/ 2 queries/);
  assert.match(report.text, /Fallbacks: 1 \(50\.0%\)/);
  assert.match(report.text, /Retrieval fallbacks \(no sources\): 1/);
  assert.match(report.text, /Abstentions after retrieval: 0/);
  assert.match(report.text, /Rate limited requests: 1/);
  assert.match(report.html, /Unknown event\?/);
});

test('separates retrieval failures from safe abstentions after retrieval', () => {
  const report = buildWeeklyMonitoringReport(input([
    query({ question: 'Unknown event?', fallback_triggered: true, retrieved_urls: [] }),
    query({ question: 'Do you use intinction at communion?', fallback_triggered: true }),
  ]));
  assert.match(report.text, /Retrieval fallbacks \(no sources\): 1/);
  assert.match(report.text, /Abstentions after retrieval: 1/);
  assert.match(report.text, /Retrieval fallbacks — no sources found/);
  assert.match(report.text, /Abstentions after retrieval — sources existed/);
});

test('redacts sensitive query text from both email formats', () => {
  const secretText = 'I need someone to talk to about a private crisis';
  const report = buildWeeklyMonitoringReport(input([
    query({ question: secretText, category: 'pastoral', fallback_triggered: true }),
  ]));
  assert.doesNotMatch(report.text, new RegExp(secretText));
  assert.doesNotMatch(report.html, new RegExp(secretText));
  assert.match(report.text, /Sensitive query redacted/);
});

test('escapes user-submitted query text in the HTML email', () => {
  const report = buildWeeklyMonitoringReport(input([
    query({ question: '<script>alert(1)</script>', fallback_triggered: true }),
  ]));
  assert.doesNotMatch(report.html, /<script>/);
  assert.match(report.html, /&lt;script&gt;/);
});
