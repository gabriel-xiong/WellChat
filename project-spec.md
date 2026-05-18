# The Well Austin — Website Assistant MVP Spec

## Goal
A RAG-powered chat widget that helps visitors find practical information from approved church content. Not an AI pastor — a navigation and information assistant.

---

## Stack
- **Frontend + Backend:** Next.js only (frontend + API routes in one app)
- **Hosting:** Vercel
- **Vector DB:** Supabase + pgvector
- **Embeddings:** OpenAI `text-embedding-3-small` (1536 dimensions)
- **LLM:** OpenAI GPT-4o mini
- **Ingestion:** TypeScript script (`npm run ingest`)

---

## Repo Structure
```
/the-well-assistant
  /app
    page.tsx
    /api
      /chat
        route.ts
  /components
    ChatWidget.tsx
  /lib
    openai.ts
    supabase.ts
    retrieval.ts
    prompt.ts
    guardrails.ts
  /scripts
    ingest.ts
  /db
    schema.sql
  .env.example
  README.md
```

---

## Environment Variables
```env
OPENAI_API_KEY=
NEXT_PUBLIC_SUPABASE_URL=
SUPABASE_SERVICE_ROLE_KEY=
MIN_SIMILARITY_THRESHOLD=0.75
BASE_SITE_URL=https://thewellaustin.com
ESCALATION_CONTACT=
```

Notes:
- `NEXT_PUBLIC_SUPABASE_URL` — safe to expose to browser; just identifies your database
- `SUPABASE_SERVICE_ROLE_KEY` — server-side only, never expose to browser; grants write access
- `NEXT_PUBLIC_SUPABASE_ANON_KEY` — only add if client ever queries Supabase directly; not needed for MVP
- `MIN_SIMILARITY_THRESHOLD` — start at 0.75, tune after reviewing real query logs
- `BASE_SITE_URL` — used by ingestion script to resolve relative URLs
- `ESCALATION_CONTACT` — fills placeholder in system prompt; set after staff conversation

---

## Chunking Strategy
- Page-level chunking by default (one chunk per page)
- If a page is long or covers multiple unrelated topics, split by section headings
- No arbitrary fixed-size chunking for MVP

---

## Content Ingestion

### MVP Demo (start here)
| Page | URL | Depth | Notes |
|------|-----|-------|-------|
| Sundays | `/sundays` | Deep | Service times, location, what to expect |
| Community Groups | `/community` | Shallow | Link to page, don't enumerate groups |
| Serve | `/serve` | Deep | Volunteering info |
| Giving | `/giving` | Deep | Philosophy + all 4 giving methods + staff contact |
| Ministries | `/ministries` | Deep | Kids ministry etc. |
| Events | `/events` | Deep | Re-indexed weekly |
| Contact/Escalation | TBD | Deep | Needed for bot fallback routing |

### Expanded V1 (add after core flow is proven)
| Page | URL | Depth | Notes |
|------|-----|-------|-------|
| Mission | `/mission` | Deep | Who they are |
| Beliefs | `/beliefs` | Deep | Doctrinal basics only — add with caution |
| Team | `/team` | Deep | Staff + contact routing |
| Stories | `/stories` | Shallow | Link to collection only |
| Sermons | `/sermons` | Shallow | Link to collection only |
| Well Said Podcast | `/podcast` | Shallow | Link to collection only |
| Resource Library | `/resources` | Deep | Single stable page |
| Church Planting | `/planting` | Deep | Single stable page |
| Missions | `/missions` | Deep | Single stable page |
| Ministry Residency | `/residency` | Deep | Single stable page |
| Impact Reports | `/impact` | Deep | Single stable page |

---

## Supabase Schema
```sql
documents (
  id uuid primary key,
  url text not null,
  title text,
  section text,
  content text not null,
  embedding vector(1536),
  depth text check (depth in ('deep', 'shallow')),
  content_type text,
  last_indexed_at timestamptz default now()
)

query_logs (
  id uuid primary key,
  question text,
  retrieved_chunk_ids uuid[],
  retrieved_urls text[],
  retrieved_titles text[],
  similarity_scores float8[],
  answer text,
  fallback_triggered boolean,
  created_at timestamptz default now()
)
```

**Logging note:** For pastoral, sensitive, or crisis queries, avoid logging full question text or redact before storing. Users may share personal information when asking about prayer, counseling, or mental health.

---

## Re-ingestion Behavior
On each `npm run ingest` run:
1. Delete all existing rows for the approved URLs
2. Re-fetch, chunk, embed, and reinsert fresh

Rationale: upsert alone would leave stale chunks from old page versions alongside new ones, producing outdated answers.

---

## Retrieval & Fallback Rules
- Retrieve top 3–5 chunks from Supabase pgvector
- If top match similarity is below `MIN_SIMILARITY_THRESHOLD`, do not answer — use fallback instead
- Treat threshold as tunable; log real similarity scores before hardening it
- If retrieved chunks don't directly support the answer, say the information is not available in approved website content
- Always return source URLs used in the answer
- For shallow pages, provide a link rather than attempting detailed claims

---

## Re-indexing
- **MVP:** manual script — `npm run ingest`
- **Long-term:** weekly cron job via GitHub Actions
- **Events:** re-indexed weekly; day TBD after staff conversation
- **No live fetching** during chat queries
- Event answers should include source link and `last_indexed_at` metadata, phrased as "according to the events page as of [date]"

---

## Basic Logging
For each query, log to `query_logs` table:
- User question (redact if pastoral/sensitive)
- Retrieved chunk IDs, URLs, titles
- Similarity scores
- Final answer
- Whether fallback was triggered
- Timestamp

Start with console logs locally; write to Supabase once hosted.

---

## Bot Behavior
- Answer only from retrieved context
- Always include source link with answer
- If answer not in context → say so, route to `ESCALATION_CONTACT`
- Pastoral care / sensitive questions → route to real person
- Emergency / self-harm language → route to 911 and 988 Lifeline immediately
- No invented details: times, names, events, policies, staff responsibilities
- `/beliefs` factual questions allowed ("what does The Well believe about X"); no personal spiritual advice or theological debate

---

## System Prompt (draft)
```
You are a website assistant for The Well Austin Community Church.
Your job is to help visitors find practical information from
approved church content.

Answer only from the provided context. If the answer is not
available, say you don't know based on the available website
information and suggest contacting The Well directly at
[ESCALATION_CONTACT].

Always include a source link when answering.

For shallow-indexed pages like community groups, sermons, stories,
and podcast, provide a brief description and link to the page
rather than attempting detailed answers.

For questions about what The Well believes, answer factually
from the provided content. Do not give personal spiritual advice,
make theological recommendations, or tell someone what they
should believe or do.

Do not act as a pastor, counselor, or spiritual authority. For
pastoral care, counseling, or sensitive personal situations,
route to a real person at [ESCALATION_CONTACT].

If someone expresses a mental health crisis or self-harm risk,
direct them to emergency services (911) or the 988 Suicide and
Crisis Lifeline immediately.

Do not invent service times, staff names, event details, or
church policies.
```

---

## WordPress Embed Target
The MVP will first be deployed as a hosted demo page at `the-well-assistant.vercel.app`. After staff approval of bot behavior, the widget will be packaged for WordPress:

```html
<script
  src="https://the-well-assistant.vercel.app/widget.js"
  data-site="the-well"
></script>
```

The WordPress site only displays the widget. All retrieval and AI logic stays on the hosted Next.js backend.

---

## Build Order
1. `schema.sql` — documents + query_logs + match_documents RPC
2. Supabase setup
3. `ingest.ts`
4. `/api/chat` route
5. Basic `ChatWidget`
6. Local testing (`npm run ingest` → `npm run dev`)
7. Deploy hosted demo to Vercel
8. Staff review + approval
9. WordPress embed

---

## Milestone Prompts for Codex

### Milestone 1 — Schema
```
Here is my project spec: [paste spec]

Build schema.sql only. Include:
- documents table with pgvector(1536)
- query_logs table
- match_documents RPC function for cosine similarity search

Do not build anything else yet.
```

### Milestone 2 — Ingestion script
```
Here is my project spec: [paste spec]
Here is my schema: [paste schema.sql]

Build scripts/ingest.ts only. It should:
- Accept a list of approved URLs from a config
- Fetch and extract clean text from each page
- Chunk by page, split by heading if page is long
- Generate embeddings via OpenAI text-embedding-3-small
- Delete existing rows for each URL then reinsert
- Store depth, title, section, url, content, embedding, last_indexed_at

Do not build the chat route or UI yet.
```

### Milestone 3 — Chat route
```
Here is my project spec: [paste spec]
Here is my schema: [paste schema.sql]
Here is my ingestion script: [paste ingest.ts]

Build app/api/chat/route.ts only. It should:
- Accept a user question via POST
- Embed the question using OpenAI
- Query Supabase match_documents RPC for top 5 chunks
- If top similarity is below MIN_SIMILARITY_THRESHOLD, return fallback
- Build prompt with system prompt + retrieved context + source URLs
- Call OpenAI GPT-4o mini
- Return answer, source URLs, fallback_triggered flag
- Log to query_logs table

Do not build the UI yet.
```

### Milestone 4 — Chat UI
```
Here is my project spec: [paste spec]
Here is my chat route: [paste route.ts]

Build components/ChatWidget.tsx and app/page.tsx only. The widget should:
- Bottom-right chat bubble layout
- Open/close toggle
- Message history
- Loading state
- Error state
- Source links displayed under each answer
- Basic mobile responsiveness

Do not modify the backend.
```

### Milestone 5 — WordPress embed
```
Here is my project spec: [paste spec]
Here is my ChatWidget: [paste ChatWidget.tsx]

Package the chat widget as an embeddable script that can be loaded via:
<script src="https://the-well-assistant.vercel.app/widget.js" data-site="the-well"></script>

The widget should mount itself into the host page without interfering with existing styles.
```

---

## How to Review Each Milestone

**Milestone 1 (schema)** — paste the SQL into Supabase's SQL editor and run it. Confirm tables exist in the table editor and `match_documents` appears under Database → Functions.

**Milestone 2 (ingestion)** — run `npm run ingest` locally. Open Supabase table editor and check that documents rows exist with clean content, correct URLs, and non-null embeddings. Spot check a few rows.

**Milestone 3 (chat route)** — use curl or Postman to POST a question to `http://localhost:3000/api/chat`. Confirm response has `answer`, `sources`, and `fallback_triggered`. Check query_logs in Supabase. Test a question you know is in the content and one you know isn't.

**Milestone 4 (UI)** — run `npm run dev` and test manually in the browser. Confirm source links appear, loading state works, and error state triggers if backend is killed.

**Milestone 5 (embed)** — load the widget script on a plain HTML test page and confirm it mounts without breaking page layout.

---

## Future Features (post-MVP)
- Semantic search across sermons, podcast episodes, and stories by topic
- Admin UI for re-indexing without running a script
- Weekly cron automation for events re-indexing
- Rate limiting / abuse protection before real deployment

---

## Open Items Before Launch
- [ ] Get escalation contact from staff → set `ESCALATION_CONTACT`
- [ ] Confirm events page update day for cron schedule
- [ ] Confirm group update cadence (determines whether `/community` stays shallow long-term)
- [ ] Verify `/events` page content is in raw HTML (not JS-rendered) before writing scraper
- [ ] Staff approval of bot behavior before WordPress embed
