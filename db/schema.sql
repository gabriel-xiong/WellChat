  -- Supabase schema for The Well Austin RAG assistant

  create extension if not exists vector;

  create table if not exists documents (
    id uuid primary key default gen_random_uuid(),
    url text not null,
    title text,
    section text,
    content text not null,
    embedding vector(1536) not null,
    depth text check (depth in ('deep', 'shallow')),
    content_type text,
    last_indexed_at timestamptz not null default now()
  );

  create index if not exists idx_documents_embedding on documents using ivfflat (embedding vector_cosine_ops) with (lists = 100);

  create table if not exists query_logs (
    id uuid primary key default gen_random_uuid(),
    question text,
    retrieved_chunk_ids uuid[],
    retrieved_urls text[],
    retrieved_titles text[],
    similarity_scores float8[],
    answer text,
    fallback_triggered boolean,
    category text,
    cache_hit boolean not null default false,
    time_to_first_token_ms integer,
    total_response_time_ms integer,
    created_at timestamptz not null default now()
  );

  create table if not exists chat_events (
    id uuid primary key default gen_random_uuid(),
    event_type text not null check (event_type in ('rate_limited', 'api_error')),
    metadata jsonb not null default '{}'::jsonb,
    created_at timestamptz not null default now()
  );

  create or replace function match_documents(
    query_embedding vector(1536),
    similarity_threshold float8 default 0.0,
    limit_count int default 5
  )
  returns table (
    id uuid,
    url text,
    title text,
    section text,
    content text,
    embedding vector(1536),
    depth text,
    content_type text,
    last_indexed_at timestamptz,
    similarity float8
  )
  language sql stable as $$
    select
      d.id,
      d.url,
      d.title,
      d.section,
      d.content,
      d.embedding,
      d.depth,
      d.content_type,
      d.last_indexed_at,
      1 - (d.embedding <=> query_embedding) as similarity
    from documents d
    where 1 - (d.embedding <=> query_embedding) >= similarity_threshold
    order by d.embedding <=> query_embedding asc
    limit limit_count;
  $$;

  alter table documents enable row level security;
  alter table query_logs enable row level security;
  alter table chat_events enable row level security;

  revoke all on table documents from anon, authenticated;
  revoke all on table query_logs from anon, authenticated;
  revoke all on table chat_events from anon, authenticated;
  revoke execute on function match_documents(vector, float8, int) from anon, authenticated;
