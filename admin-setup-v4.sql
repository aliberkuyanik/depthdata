-- DepthData v4: pilot workspaces and real usage data (concierge pipeline)
-- Run once in Supabase SQL Editor. Safe to run again.

create table if not exists workspaces (
  id bigint generated always as identity primary key,
  created_at timestamptz not null default now(),
  name text not null,
  domain text not null default '',
  code_hash text not null,            -- sha256 of the workspace access code
  status text not null default 'active'
);

-- One row per user per day per tool, from the company's admin console export
create table if not exists usage_daily (
  id bigint generated always as identity primary key,
  created_at timestamptz not null default now(),
  workspace_id bigint not null references workspaces(id) on delete cascade,
  day date not null,
  email text not null,
  name text not null default '',
  department text not null default '',
  tool text not null default '',
  prompts integer not null default 0,
  tokens bigint not null default 0,
  cost numeric not null default 0
);

alter table workspaces enable row level security;
alter table usage_daily enable row level security;

create index if not exists idx_usage_ws_day on usage_daily (workspace_id, day desc);
create index if not exists idx_usage_ws_email on usage_daily (workspace_id, email);
