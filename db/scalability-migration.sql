-- Semantic answer caching and corpus-version invalidation.
-- Run once in the Supabase SQL editor before enabling semantic cache traffic.

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

alter table rag_corpus_state enable row level security;
alter table semantic_answer_cache enable row level security;

revoke all on table rag_corpus_state from anon, authenticated;
revoke all on table semantic_answer_cache from anon, authenticated;
revoke execute on function match_semantic_answer_cache(vector, uuid, float8) from anon, authenticated;
revoke execute on function record_semantic_cache_hit(uuid) from anon, authenticated;
