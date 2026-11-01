-- Hybrid retrieval hardening: weighted lexical search and explainable diagnostics.
-- Safe to apply repeatedly.

alter table public.query_logs
  add column if not exists retrieval_diagnostics jsonb;

create index if not exists documents_weighted_search_idx
on public.documents using gin ((
  setweight(to_tsvector('english', coalesce(title, '')), 'A') ||
  setweight(to_tsvector('simple', coalesce(url, '')), 'A') ||
  setweight(to_tsvector('english', coalesce(section, '')), 'B') ||
  setweight(to_tsvector('english', coalesce(content, '')), 'C')
));

create or replace function public.search_documents_lexical(
  search_query text,
  limit_count integer default 60
)
returns table (
  id uuid,
  url text,
  title text,
  section text,
  content text,
  depth text,
  content_type text,
  last_indexed_at timestamptz,
  similarity double precision,
  lexical_score double precision
)
language sql
stable
security definer
set search_path = public
as $$
  with searchable as (
    select
      d.*,
      setweight(to_tsvector('english', coalesce(d.title, '')), 'A') ||
      setweight(to_tsvector('simple', coalesce(d.url, '')), 'A') ||
      setweight(to_tsvector('english', coalesce(d.section, '')), 'B') ||
      setweight(to_tsvector('english', coalesce(d.content, '')), 'C') as document_vector,
      websearch_to_tsquery('english', search_query) as query_vector
    from public.documents d
  )
  select
    s.id,
    s.url,
    s.title,
    s.section,
    s.content,
    s.depth,
    s.content_type,
    s.last_indexed_at,
    0::double precision as similarity,
    ts_rank_cd(s.document_vector, s.query_vector, 32)::double precision as lexical_score
  from searchable s
  where s.document_vector @@ s.query_vector
  order by lexical_score desc, s.url asc
  limit greatest(1, least(limit_count, 200));
$$;

revoke all on function public.search_documents_lexical(text, integer) from public;
revoke all on function public.search_documents_lexical(text, integer) from anon, authenticated;
grant execute on function public.search_documents_lexical(text, integer) to service_role;
