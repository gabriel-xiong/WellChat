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

  create table if not exists rag_corpus_state (
    singleton boolean primary key default true check (singleton),
    active_version uuid not null default gen_random_uuid(),
    updated_at timestamptz not null default now()
  );

  insert into rag_corpus_state (singleton)
  values (true)
  on conflict (singleton) do nothing;

  create table if not exists semantic_answer_cache (
    id uuid primary key default gen_random_uuid(),
    question text not null,
    question_embedding vector(1536) not null,
    answer text not null,
    retrieved_chunk_ids uuid[] not null default '{}',
    retrieved_urls text[] not null default '{}',
    retrieved_titles text[] not null default '{}',
    corpus_version uuid not null,
    hit_count integer not null default 0,
    created_at timestamptz not null default now(),
    last_hit_at timestamptz,
    expires_at timestamptz not null
  );

  create index if not exists idx_semantic_answer_cache_embedding
    on semantic_answer_cache using hnsw (question_embedding vector_cosine_ops);
  create index if not exists idx_semantic_answer_cache_version_expiry
    on semantic_answer_cache (corpus_version, expires_at);

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

  create or replace function match_semantic_answer_cache(
    query_embedding vector(1536),
    requested_corpus_version uuid,
    match_threshold float8 default 0.94
  )
  returns table (
    id uuid,
    question text,
    answer text,
    retrieved_chunk_ids uuid[],
    retrieved_urls text[],
    retrieved_titles text[],
    similarity float8
  )
  language sql stable as $$
    select
      c.id,
      c.question,
      c.answer,
      c.retrieved_chunk_ids,
      c.retrieved_urls,
      c.retrieved_titles,
      1 - (c.question_embedding <=> query_embedding) as similarity
    from semantic_answer_cache c
    where c.corpus_version = requested_corpus_version
      and c.expires_at > now()
      and 1 - (c.question_embedding <=> query_embedding) >= match_threshold
    order by c.question_embedding <=> query_embedding asc
    limit 3;
  $$;

  create or replace function record_semantic_cache_hit(cache_id uuid)
  returns void
  language sql volatile as $$
    update semantic_answer_cache
    set hit_count = hit_count + 1,
        last_hit_at = now()
    where id = cache_id;
  $$;

  alter table documents enable row level security;
  alter table query_logs enable row level security;
  alter table chat_events enable row level security;
  alter table rag_corpus_state enable row level security;
  alter table semantic_answer_cache enable row level security;

  revoke all on table documents from anon, authenticated;
  revoke all on table query_logs from anon, authenticated;
  revoke all on table chat_events from anon, authenticated;
  revoke all on table rag_corpus_state from anon, authenticated;
  revoke all on table semantic_answer_cache from anon, authenticated;
  revoke execute on function match_documents(vector, float8, int) from anon, authenticated;
  revoke execute on function match_semantic_answer_cache(vector, uuid, float8) from anon, authenticated;
  revoke execute on function record_semantic_cache_hit(uuid) from anon, authenticated;
