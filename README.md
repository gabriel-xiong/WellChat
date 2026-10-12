# WellChat

A production RAG-powered chat assistant deployed for [The Well Austin Community Church](https://thewellaustin.com). Answers visitor questions using semantic search over approved website content, with source-grounded responses and links to supporting pages.


## Overview

WellChat ingests approved church website pages, chunks and embeds the content using OpenAI embeddings, and stores vectors in Supabase pgvector. When a visitor asks a question, the system embeds the query, retrieves the most relevant chunks using a hybrid re-ranking pipeline, and generates a grounded answer via GPT-4o mini with streaming.

Sensitive queries (pastoral care, crisis/self-harm) are handled with dedicated guardrails that bypass retrieval entirely and route to appropriate resources.

## Demo

Live deployment: https://thewellaustin.com/ 

## Stack

| Layer | Technology |
|---|---|
| Frontend + Backend | Next.js (App Router) |
| Vector Database | Supabase + pgvector |
| Embeddings | OpenAI `text-embedding-3-small` (1536d) |
| LLM | OpenAI GPT-4o mini |
| Hosting | Vercel |
| Ingestion | TypeScript script (`npm run ingest`) |

## Architecture

```
User question
    ↓
Embed query (text-embedding-3-small)
    ↓
Supabase pgvector cosine similarity search (top 12)
    ↓
Hybrid re-ranking (semantic similarity + lexical boost)
    ↓
Top 5 chunks passed to GPT-4o mini with system prompt
    ↓
Streaming response with source links
    ↓
Query logged to Supabase (question, chunks, scores, answer)
```

## Key Features

- **Hybrid retrieval** — combines cosine similarity scores with lexical keyword boosting across URL, title, section, and content fields for improved precision on ambiguous queries
- **Streaming responses** — OpenAI streaming API with real-time token display in the chat UI
- **Guardrail routing** — crisis/self-harm queries bypass retrieval and immediately return emergency resources (911, 988 Lifeline); pastoral queries route to staff contact
- **Tunable similarity threshold** — configurable via environment variable, logged per-query for iterative tuning
- **Semantic answer caching** — conservatively reuses grounded answers for equivalent, non-sensitive questions and invalidates them when the corpus changes
- **Request deduplication** — a Redis single-flight lock prevents simultaneous identical questions from repeating embedding, retrieval, and generation work
- **Graceful degradation** — returns approved church resources when Redis, embeddings, retrieval, or generation are temporarily unavailable
- **Section-aware chunking** — heading-based splitting with short-section merging and URL-specific summary injection to improve embedding quality
- **Incremental indexing pipeline** — sitemap discovery, volatility-aware checks, content hashes, and failure-safe replacement keep coverage current without re-embedding unchanged pages

## Project Structure

```
/
├── app/
│   ├── page.tsx               # Demo page
│   └── api/chat/route.ts      # RAG pipeline endpoint
├── components/
│   └── ChatWidget.tsx         # Chat UI with streaming
├── scripts/
│   ├── ingest.ts              # Ingestion pipeline
│   ├── ingestion-core.ts      # Pure discovery, scheduling, extraction, hashing, and chunking logic
│   └── ingestion-core.test.ts # Deterministic ingestion regression tests
├── ingestion-config.json      # Approved sitemaps, refresh tiers, and exclusions
├── db/
│   └── schema.sql             # Supabase schema + match_documents RPC
└── .env.example
```

## Getting Started

### Prerequisites

- Node.js 20+
- Supabase project with pgvector enabled
- OpenAI API key

### Setup

1. **Clone and install**
   ```bash
   git clone https://github.com/yourusername/wellchat.git
   cd wellchat
   npm install
   ```

2. **Configure environment**
   ```bash
   cp .env.example .env.local
   ```
Fill in:
   ```env
   OPENAI_API_KEY=
   NEXT_PUBLIC_SUPABASE_URL=
   SUPABASE_SERVICE_ROLE_KEY=
   MIN_SIMILARITY_THRESHOLD=0.25
   BASE_SITE_URL=https://thewellaustin.com
   ESCALATION_CONTACT=
   KV_REST_API_URL=
   KV_REST_API_TOKEN=
   ADMIN_DASHBOARD_USERNAME=
   ADMIN_DASHBOARD_PASSWORD=
   ```

3. **Initialize database**

   Run `db/schema.sql` in the Supabase SQL editor. This creates the `documents` table, `query_logs` table, and `match_documents` RPC function.

   Existing deployments should run `db/dashboard-migration.sql` once to add dashboard telemetry fields and lock analytics tables to the service role.

   Run `db/scalability-migration.sql` once to add corpus-versioned semantic answer caching. The application safely skips semantic caching until this migration exists.

4. **Ingest content**
   ```bash
   npm run ingest
   ```
   Edit `ingestion-config.json` to control approved sitemap types, refresh intervals, URL overrides, and exclusions.

5. **Run locally**
   ```bash
   npm run dev
   ```
   Open [http://localhost:3000](http://localhost:3000).

## Ingestion

The production workflow runs daily and:

1. Discovers URLs from 16 explicitly approved WordPress sitemaps.
2. Applies daily, weekly, or monthly check intervals based on content volatility.
3. Excludes utility and `noindex` pages and retires expired dated events after a safety window.
4. Extracts and chunks due pages, then compares deterministic cleaned-content hashes.
5. Skips OpenAI entirely for unchanged pages.
6. Embeds only new or changed chunks with `text-embedding-3-small`.
7. Inserts validated replacement chunks before deleting old chunks, so an embedding or insert failure cannot erase the last good version.
8. Advances the existing corpus version only when stored content actually changes.

Incremental ingestion uses the existing `documents` table and requires no additional database migration. Stored chunks are deterministically fingerprinted in memory; unchanged pages only receive a refreshed `last_indexed_at` verification timestamp.

Useful commands:

```bash
npm test                    # deterministic ingestion unit tests
npm run test:ingestion:live # live sitemap and regression-page checks; no API key usage
npm run ingest:discover     # inventory approved sitemap coverage; no API key usage
npm run ingest:audit        # parse every eligible live page; no embedding calls
npm run ingest              # production-capable incremental ingestion
npm run ingest -- --force-check # fetch all pages but still skip matching hashes
npm run ingest -- --force-embed # deliberate full re-embedding for maintenance
```

GitHub Actions uses concurrency protection so scheduled and manual ingestion runs cannot overlap. A missing or failed sitemap never causes pages owned by that sitemap to be retired.

## Deployment

Deploy to Vercel:

```bash
git push origin main
```

Set the same environment variables in Vercel → Project Settings → Environment Variables.

## WordPress Embed

The production widget is delivered through a small loader script that creates an isolated iframe. WordPress does not receive API keys or run any retrieval logic.

```html
<script
  src="https://the-well-rag-agent.vercel.app/widget.js?v=1"
  data-site="the-well"
  data-cfasync="false"
  async
></script>
```

Add the script globally at the end of the `body` element. The dedicated iframe page is available at `/widget`, and `/embed-preview` provides a neutral host page for testing the loader before WordPress installation.

The iframe security policy currently allows these parent sites:

- `https://stg-getwellaustin-staging.kinsta.cloud`
- `https://thewellaustin.com`
- `https://www.thewellaustin.com`

See `wordpress/README.md` for Elementor Custom Code and plugin installation options.

## Environment Variables

| Variable | Description |
|---|---|
| `OPENAI_API_KEY` | OpenAI API key |
| `NEXT_PUBLIC_SUPABASE_URL` | Supabase project URL (safe to expose to browser) |
| `SUPABASE_SERVICE_ROLE_KEY` | Supabase service role key — server-side only, never exposed to the client |
| `MIN_SIMILARITY_THRESHOLD` | Minimum cosine similarity to return results (default: `0.25`) |
| `BASE_SITE_URL` | Base URL for resolving relative paths during ingestion |
| `ESCALATION_CONTACT` | Contact info injected into fallback and pastoral responses |
| `SEMANTIC_CACHE_THRESHOLD` | Minimum cosine similarity for semantic answer reuse (default: `0.94`) |
| `SEMANTIC_CACHE_TTL_SECONDS` | Maximum semantic answer lifetime in seconds (default: seven days) |
| `KV_REST_API_URL` | Upstash Redis REST URL used for global rate limiting and answer caching |
| `KV_REST_API_TOKEN` | Upstash Redis REST token; server-side only |
| `ADMIN_DASHBOARD_USERNAME` | HTTP Basic username protecting `/admin` |
| `ADMIN_DASHBOARD_PASSWORD` | Strong HTTP Basic password protecting `/admin`; server-side only |

## Operations Dashboard

The authenticated dashboard at `/admin` reports query volume, fallback and escalation rates, retrieval sources, API errors, rate-limit activity, and browser-measured response latency. It also includes searchable raw visitor questions and generated answers for product and pastoral-support planning.

Because visitor questions can contain sensitive information, use a unique 24+ character dashboard password, share access narrowly, and never expose the Supabase service role key to the browser. Dashboard analytics retain up to 90 days in the view; configure a database retention policy separately if older records should be deleted.

## RAG Evaluation

Run the end-to-end evaluation with:

```bash
npm run benchmark:rag
```

It reports retrieval `Precision@K`, `Recall@K`, MRR, and `nDCG@K`, followed by model-judged generation faithfulness, answer relevance, citation correctness, and groundedness. It also reports generation quality only for questions with perfect retrieval recall, which separates generation failures from retrieval failures. Detailed per-question results are saved under `tmp/rag-evals/`.

Optional environment variables are `RAG_EVAL_K` (default `5`), `RAG_EVAL_LIMIT` (useful for smoke tests), `RAG_EVAL_GENERATION_MODEL`, and `RAG_EVAL_JUDGE_MODEL`.

When no OpenAI API key is available, `npm run benchmark:rag:keyless` evaluates the deployed chat endpoint and uses local open-source NLI and sentence-embedding models for generation scoring. This mode requires Python, PyTorch, and Transformers. Its scores are reproducible proxies and should not be compared directly with scores from the OpenAI-judged mode without human calibration.
