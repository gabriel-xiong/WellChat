"use client";

import { useMemo, useState } from "react";
import { CHAT_CATEGORIES, classifyQuestion } from "@/lib/chat-analytics";

export interface QueryLogRow {
  id: string;
  question: string | null;
  retrieved_urls: string[] | null;
  retrieved_titles: string[] | null;
  similarity_scores: number[] | null;
  answer: string | null;
  fallback_triggered: boolean | null;
  category: string | null;
  cache_hit: boolean | null;
  time_to_first_token_ms: number | null;
  total_response_time_ms: number | null;
  created_at: string;
}

export interface ChatEventRow {
  id: string;
  event_type: "rate_limited" | "api_error";
  created_at: string;
}

type Range = 7 | 30 | 90;

function withinDays(date: string, days: number): boolean {
  return new Date(date).getTime() >= Date.now() - days * 24 * 60 * 60 * 1000;
}

function percentage(value: number, total: number): string {
  return total ? `${Math.round((value / total) * 100)}%` : "0%";
}

function percentile(values: number[], percentileValue: number): number | null {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(Math.ceil((percentileValue / 100) * sorted.length) - 1, sorted.length - 1)];
}

function formatLatency(value: number | null): string {
  if (value === null) return "Not yet measured";
  return value >= 1000 ? `${(value / 1000).toFixed(1)}s` : `${value}ms`;
}

function formatDate(value: string): string {
  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date(value));
}

function categoryFor(query: QueryLogRow): string {
  return query.category || classifyQuestion(query.question || "");
}

export default function AdminDashboard({
  queries,
  events,
  generatedAt,
}: {
  queries: QueryLogRow[];
  events: ChatEventRow[];
  generatedAt: string;
}) {
  const [range, setRange] = useState<Range>(30);
  const [search, setSearch] = useState("");
  const [category, setCategory] = useState("all");
  const [fallbackOnly, setFallbackOnly] = useState(false);

  const rangedQueries = useMemo(() => queries.filter((query) => withinDays(query.created_at, range)), [queries, range]);
  const rangedEvents = useMemo(() => events.filter((event) => withinDays(event.created_at, range)), [events, range]);
  const todayCount = queries.filter((query) => withinDays(query.created_at, 1)).length;
  const sevenDayCount = queries.filter((query) => withinDays(query.created_at, 7)).length;
  const thirtyDayCount = queries.filter((query) => withinDays(query.created_at, 30)).length;
  const fallbackCount = rangedQueries.filter((query) => query.fallback_triggered).length;
  const pastoralCount = rangedQueries.filter((query) => ["pastoral", "crisis"].includes(categoryFor(query))).length;
  const crisisCount = rangedQueries.filter((query) => categoryFor(query) === "crisis").length;
  const ttftValues = rangedQueries.flatMap((query) => query.time_to_first_token_ms === null ? [] : [query.time_to_first_token_ms]);
  const medianTtft = percentile(ttftValues, 50);
  const p95Ttft = percentile(ttftValues, 95);
  const rateLimitedCount = rangedEvents.filter((event) => event.event_type === "rate_limited").length;
  const errorCount = rangedEvents.filter((event) => event.event_type === "api_error").length;

  const categories = useMemo(() => {
    const counts = new Map<string, number>();
    for (const query of rangedQueries) {
      const value = categoryFor(query);
      counts.set(value, (counts.get(value) || 0) + 1);
    }
    return [...counts.entries()].sort((a, b) => b[1] - a[1]);
  }, [rangedQueries]);

  const topPages = useMemo(() => {
    const pages = new Map<string, { title: string; count: number }>();
    for (const query of rangedQueries) {
      query.retrieved_urls?.forEach((url, index) => {
        const current = pages.get(url);
        pages.set(url, {
          title: query.retrieved_titles?.[index] || current?.title || url,
          count: (current?.count || 0) + 1,
        });
      });
    }
    return [...pages.entries()].sort((a, b) => b[1].count - a[1].count).slice(0, 7);
  }, [rangedQueries]);

  const dailyTrend = useMemo(() => {
    const days = Math.min(range, 14);
    return Array.from({ length: days }, (_, reverseIndex) => {
      const date = new Date();
      date.setHours(0, 0, 0, 0);
      date.setDate(date.getDate() - (days - reverseIndex - 1));
      const nextDate = new Date(date);
      nextDate.setDate(nextDate.getDate() + 1);
      const matches = rangedQueries.filter((query) => {
        const time = new Date(query.created_at).getTime();
        return time >= date.getTime() && time < nextDate.getTime();
      });
      const scores = matches.flatMap((query) => query.similarity_scores?.[0] === undefined ? [] : [query.similarity_scores[0]]);
      return {
        label: new Intl.DateTimeFormat("en-US", { weekday: "short" }).format(date),
        count: matches.length,
        similarity: scores.length ? scores.reduce((sum, score) => sum + score, 0) / scores.length : null,
      };
    });
  }, [range, rangedQueries]);
  const highestDailyCount = Math.max(...dailyTrend.map((day) => day.count), 1);

  const visibleQuestions = useMemo(() => {
    const normalizedSearch = search.trim().toLowerCase();
    return rangedQueries.filter((query) => {
      const matchesSearch = !normalizedSearch || query.question?.toLowerCase().includes(normalizedSearch) || query.answer?.toLowerCase().includes(normalizedSearch);
      const matchesCategory = category === "all" || categoryFor(query) === category;
      return matchesSearch && matchesCategory && (!fallbackOnly || query.fallback_triggered);
    });
  }, [rangedQueries, search, category, fallbackOnly]);

  return (
    <main className="min-h-screen bg-[#f4f7f5] text-[#173c36]">
      <header className="border-b border-[#d9e3df] bg-white">
        <div className="mx-auto flex max-w-[1500px] flex-col gap-4 px-5 py-5 sm:flex-row sm:items-center sm:justify-between sm:px-8">
          <div>
            <p className="text-xs font-semibold uppercase text-[#008e81]">The Well Austin</p>
            <h1 className="mt-1 text-2xl font-semibold">WellChat operations</h1>
          </div>
          <div className="flex items-center gap-3">
            <span className="text-xs text-[#66817b]">Updated {formatDate(generatedAt)}</span>
            <a href="/admin" className="rounded-md border border-[#bdd4ce] bg-white px-3 py-2 text-sm font-semibold hover:bg-[#edf6f3]">Refresh</a>
          </div>
        </div>
      </header>

      <div className="mx-auto max-w-[1500px] space-y-6 px-5 py-6 sm:px-8">
        <section className="flex flex-col gap-3 border-b border-[#d9e3df] pb-5 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <h2 className="text-base font-semibold">Usage overview</h2>
            <p className="mt-1 text-sm text-[#627a75]">Restricted operational data. Visitor questions may contain sensitive information.</p>
          </div>
          <div className="inline-flex w-fit rounded-md border border-[#cbdad6] bg-white p-1" aria-label="Dashboard date range">
            {([7, 30, 90] as Range[]).map((days) => (
              <button key={days} type="button" onClick={() => setRange(days)} className={`rounded px-3 py-1.5 text-sm font-semibold ${range === days ? "bg-[#173c36] text-white" : "text-[#527069] hover:bg-[#edf4f1]"}`}>
                {days} days
              </button>
            ))}
          </div>
        </section>

        <section className="grid grid-cols-2 gap-3 lg:grid-cols-4 xl:grid-cols-8">
          {[
            ["Today", todayCount.toLocaleString()],
            ["Past 7 days", sevenDayCount.toLocaleString()],
            ["Past 30 days", thirtyDayCount.toLocaleString()],
            ["Fallback rate", percentage(fallbackCount, rangedQueries.length)],
            ["Pastoral share", percentage(pastoralCount, rangedQueries.length)],
            ["Crisis routes", crisisCount.toLocaleString()],
            ["Median TTFT", formatLatency(medianTtft)],
            ["p95 TTFT", formatLatency(p95Ttft)],
          ].map(([label, value]) => (
            <article key={label} className="rounded-md border border-[#d8e2df] bg-white px-4 py-4">
              <p className="text-xs font-medium text-[#678079]">{label}</p>
              <p className="mt-2 text-xl font-semibold text-[#123f38]">{value}</p>
            </article>
          ))}
        </section>

        <section className="grid gap-4 lg:grid-cols-[1.5fr_1fr_1fr]">
          <article className="rounded-md border border-[#d8e2df] bg-white p-5">
            <div className="flex items-baseline justify-between">
              <h2 className="font-semibold">Query volume</h2>
              <span className="text-xs text-[#6a817c]">Last {dailyTrend.length} days</span>
            </div>
            <div className="mt-6 flex h-40 items-end gap-2 border-b border-[#dbe5e1] pb-2">
              {dailyTrend.map((day, index) => (
                <div key={`${day.label}-${index}`} className="flex h-full min-w-0 flex-1 flex-col justify-end gap-2" title={`${day.count} queries${day.similarity === null ? "" : `, ${day.similarity.toFixed(2)} avg top similarity`}`}>
                  <span className="text-center text-[10px] font-semibold text-[#527069]">{day.count || ""}</span>
                  <div className="min-h-1 bg-[#00a99a]" style={{ height: `${Math.max((day.count / highestDailyCount) * 100, 3)}%` }} />
                  <span className="truncate text-center text-[10px] text-[#718681]">{day.label}</span>
                </div>
              ))}
            </div>
          </article>

          <article className="rounded-md border border-[#d8e2df] bg-white p-5">
            <h2 className="font-semibold">Question categories</h2>
            <div className="mt-4 space-y-3">
              {categories.slice(0, 7).map(([name, count]) => (
                <div key={name}>
                  <div className="flex justify-between text-xs"><span className="capitalize">{name}</span><span>{count}</span></div>
                  <div className="mt-1 h-1.5 overflow-hidden bg-[#e7eeeb]"><div className="h-full bg-[#38b9ad]" style={{ width: percentage(count, rangedQueries.length) }} /></div>
                </div>
              ))}
              {!categories.length ? <p className="text-sm text-[#718681]">No queries in this period.</p> : null}
            </div>
          </article>

          <article className="rounded-md border border-[#d8e2df] bg-white p-5">
            <h2 className="font-semibold">Reliability</h2>
            <dl className="mt-4 divide-y divide-[#e3ebe8]">
              <div className="flex items-center justify-between py-3"><dt className="text-sm text-[#5f7771]">API errors</dt><dd className="font-mono text-sm font-semibold">{errorCount}</dd></div>
              <div className="flex items-center justify-between py-3"><dt className="text-sm text-[#5f7771]">Rate limited</dt><dd className="font-mono text-sm font-semibold">{rateLimitedCount}</dd></div>
              <div className="flex items-center justify-between py-3"><dt className="text-sm text-[#5f7771]">Cache hits</dt><dd className="font-mono text-sm font-semibold">{rangedQueries.filter((query) => query.cache_hit).length}</dd></div>
              <div className="flex items-center justify-between py-3"><dt className="text-sm text-[#5f7771]">Latency samples</dt><dd className="font-mono text-sm font-semibold">{ttftValues.length}</dd></div>
            </dl>
          </article>
        </section>

        <section className="rounded-md border border-[#d8e2df] bg-white p-5">
          <h2 className="font-semibold">Most retrieved pages</h2>
          <div className="mt-4 grid gap-x-8 gap-y-3 md:grid-cols-2">
            {topPages.map(([url, page], index) => (
              <div key={url} className="flex min-w-0 items-center gap-3 border-b border-[#e7eeeb] pb-3">
                <span className="font-mono text-xs text-[#78908a]">{String(index + 1).padStart(2, "0")}</span>
                <div className="min-w-0 flex-1"><p className="truncate text-sm font-semibold">{page.title}</p><p className="truncate text-xs text-[#6b817c]">{url}</p></div>
                <span className="font-mono text-xs font-semibold">{page.count}</span>
              </div>
            ))}
            {!topPages.length ? <p className="text-sm text-[#718681]">No retrieval data in this period.</p> : null}
          </div>
        </section>

        <section className="rounded-md border border-[#d8e2df] bg-white">
          <div className="border-b border-[#dfe8e5] p-5">
            <div className="flex flex-col gap-1 sm:flex-row sm:items-baseline sm:justify-between">
              <div><h2 className="font-semibold">Visitor questions</h2><p className="mt-1 text-sm text-[#647b75]">Raw questions are visible for product and pastoral-support planning.</p></div>
              <span className="text-xs text-[#6f847f]">Showing {Math.min(visibleQuestions.length, 200)} of {visibleQuestions.length}</span>
            </div>
            <div className="mt-4 grid gap-3 md:grid-cols-[minmax(240px,1fr)_180px_auto]">
              <input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search questions or answers" className="h-10 rounded-md border border-[#c9d9d4] px-3 text-sm outline-none focus:border-[#00a99a] focus:ring-2 focus:ring-[#c9efea]" />
              <select value={category} onChange={(event) => setCategory(event.target.value)} className="h-10 rounded-md border border-[#c9d9d4] bg-white px-3 text-sm outline-none focus:border-[#00a99a]">
                <option value="all">All categories</option>
                {CHAT_CATEGORIES.map((name) => <option key={name} value={name}>{name[0].toUpperCase() + name.slice(1)}</option>)}
              </select>
              <label className="flex h-10 items-center gap-2 text-sm"><input type="checkbox" checked={fallbackOnly} onChange={(event) => setFallbackOnly(event.target.checked)} className="size-4 accent-[#008f82]" />Fallbacks only</label>
            </div>
          </div>

          <div className="divide-y divide-[#e4ebe9]">
            {visibleQuestions.slice(0, 200).map((query) => {
              const topScore = query.similarity_scores?.[0];
              return (
                <details key={query.id} className="group px-5 py-4 open:bg-[#f8fbfa]">
                  <summary className="grid cursor-pointer list-none gap-2 md:grid-cols-[130px_100px_minmax(260px,1fr)_120px_90px] md:items-center">
                    <span className="text-xs text-[#6b817c]">{formatDate(query.created_at)}</span>
                    <span className="w-fit rounded bg-[#e5f5f1] px-2 py-1 text-[11px] font-semibold capitalize text-[#12695f]">{categoryFor(query)}</span>
                    <span className="text-sm font-medium text-[#173c36]">{query.question || "Question not recorded"}</span>
                    <span className={`text-xs font-semibold ${query.fallback_triggered ? "text-[#a14e2d]" : "text-[#48716a]"}`}>{query.fallback_triggered ? "Fallback" : query.cache_hit ? "Cached" : "Answered"}</span>
                    <span className="text-right font-mono text-xs text-[#607973]">{topScore === undefined ? "-" : topScore.toFixed(2)}</span>
                  </summary>
                  <div className="mt-4 grid gap-4 border-l-2 border-[#a6dcd5] pl-4 text-sm md:grid-cols-[1fr_260px]">
                    <div><p className="mb-1 text-xs font-semibold uppercase text-[#6c817c]">Answer</p><p className="whitespace-pre-wrap leading-6 text-[#355851]">{query.answer || "No answer recorded."}</p></div>
                    <dl className="space-y-2 text-xs text-[#607973]">
                      <div><dt className="font-semibold">Top source</dt><dd className="mt-0.5 break-all">{query.retrieved_urls?.[0] || "None"}</dd></div>
                      <div><dt className="font-semibold">First token / total</dt><dd className="mt-0.5">{formatLatency(query.time_to_first_token_ms)} / {formatLatency(query.total_response_time_ms)}</dd></div>
                      <div><dt className="font-semibold">Query ID</dt><dd className="mt-0.5 break-all font-mono">{query.id}</dd></div>
                    </dl>
                  </div>
                </details>
              );
            })}
            {!visibleQuestions.length ? <p className="p-8 text-center text-sm text-[#718681]">No questions match these filters.</p> : null}
          </div>
        </section>
      </div>
    </main>
  );
}
