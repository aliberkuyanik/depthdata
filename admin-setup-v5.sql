-- DepthData v5: self-serve accounts and real connectors
-- Run once in Supabase SQL Editor. Safe to run again.

create table if not exists accounts (
  id bigint generated always as identity primary key,
  created_at timestamptz not null default now(),
  email text not null unique,
  name text not null default '',
  pass_hash text not null,            -- scrypt: salt:hash
  workspace_id bigint not null references workspaces(id) on delete cascade,
  role text not null default 'admin'
);

create table if not exists connectors (
  id bigint generated always as identity primary key,
  created_at timestamptz not null default now(),
  workspace_id bigint not null references workspaces(id) on delete cascade,
  provider text not null,             -- anthropic | openai | copilot
  label text not null default '',
  enc_key text not null,              -- AES-256-GCM encrypted admin key
  meta text not null default '',      -- provider extras (e.g. github org slug)
  status text not null default 'connected',
  last_sync timestamptz,
  last_error text not null default ''
);

alter table accounts enable row level security;
alter table connectors enable row level security;

create index if not exists idx_connectors_ws on connectors (workspace_id);

-- workspaces created via signup have no access code
alter table workspaces alter column code_hash set default '';
