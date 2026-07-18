-- Dashboard analytics fields. Run once in the Supabase SQL editor before deploying dashboard code.

alter table query_logs
  add column if not exists category text,
  add column if not exists cache_hit boolean not null default false,
  add column if not exists time_to_first_token_ms integer,
  add column if not exists total_response_time_ms integer;

create table if not exists chat_events (
  id uuid primary key default gen_random_uuid(),
  event_type text not null check (event_type in ('rate_limited', 'api_error')),
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

alter table documents enable row level security;
alter table query_logs enable row level security;
alter table chat_events enable row level security;

revoke all on table documents from anon, authenticated;
revoke all on table query_logs from anon, authenticated;
revoke all on table chat_events from anon, authenticated;
revoke execute on function match_documents(vector, float8, int) from anon, authenticated;
