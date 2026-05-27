# WellChat

A production RAG-powered chat assistant deployed for [The Well Austin Community Church](https://thewellaustin.com). Answers visitor questions using semantic search over approved website content, with source-grounded responses and links to supporting pages.

## Demo

> Live deployment: [wellchat demo]([https://the-well-rag.vercel.app)](https://the-well-rag-agent.vercel.app/)

## What I Built

- Full-stack chat widget with real-time streaming responses
- Supabase pgvector retrieval backend with hybrid semantic + lexical re-ranking
- Website ingestion and section-aware chunking pipeline
- Guardrail routing for crisis and pastoral-care queries
- Query logging for retrieval debugging and similarity threshold tuning

## Overview

WellChat ingests approved church website pages, chunks and embeds the content using OpenAI embeddings, and stores vectors in Supabase pgvector. When a visitor asks a question, the system embeds the query, retrieves the most relevant chunks using a hybrid re-ranking pipeline, and generates a grounded answer via GPT-4o mini with streaming.

Sensitive queries (pastoral care, crisis/self-harm) are handled with dedicated guardrails that bypass retrieval entirely and route to appropriate resources.

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
- **Section-aware chunking** — heading-based splitting with short-section merging and URL-specific summary injection to improve embedding quality
- **Re-indexing pipeline** — delete-then-reinsert ingestion flow prevents stale chunk accumulation; can be run manually or scheduled via GitHub Actions

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
│   └── approved-pages.json    # Approved content sources
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
   ```

3. **Initialize database**

   Run `db/schema.sql` in the Supabase SQL editor. This creates the `documents` table, `query_logs` table, and `match_documents` RPC function.

4. **Ingest content**
   ```bash
   npm run ingest
   ```
   Edit `scripts/approved-pages.json` to control which pages are indexed and at what depth (`deep` or `shallow`).

5. **Run locally**
   ```bash
   npm run dev
   ```
   Open [http://localhost:3000](http://localhost:3000).

## Ingestion

The ingestion pipeline:
1. Fetches each approved URL
2. Extracts clean text from the `<main>` tag, stripping nav/footer noise
3. Splits content by heading sections, merging short sections
4. Prepends a URL-specific summary to each chunk for embedding quality
5. Generates embeddings via OpenAI
6. Deletes existing rows for the URL and reinserts fresh chunks

Re-run `npm run ingest` whenever content changes. To automate, schedule the script via GitHub Actions.

## Deployment

Deploy to Vercel:

```bash
git push origin main
```

Set the same environment variables in Vercel → Project Settings → Environment Variables.

## Environment Variables

| Variable | Description |
|---|---|
| `OPENAI_API_KEY` | OpenAI API key |
| `NEXT_PUBLIC_SUPABASE_URL` | Supabase project URL (safe to expose to browser) |
| `SUPABASE_SERVICE_ROLE_KEY` | Supabase service role key — server-side only, never exposed to the client |
| `MIN_SIMILARITY_THRESHOLD` | Minimum cosine similarity to return results (default: `0.25`) |
| `BASE_SITE_URL` | Base URL for resolving relative paths during ingestion |
| `ESCALATION_CONTACT` | Contact info injected into fallback and pastoral responses |
