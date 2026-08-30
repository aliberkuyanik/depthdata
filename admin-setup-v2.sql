-- DepthData Console v2 additions
-- Run AFTER admin-setup.sql (safe to run once): Supabase -> SQL Editor -> paste -> Run.

-- People allowed into the console besides you (you are the owner via ADMIN_PASSWORD).
create table if not exists console_users (
  id bigint generated always as identity primary key,
  created_at timestamptz not null default now(),
  name text not null,
  email text not null,
  role text not null default 'viewer',      -- viewer | admin (informational for now)
  key_hash text not null,                   -- sha256 of their personal access key
  last_seen timestamptz
);

-- First question of every in-app support chat session, so nothing vanishes.
create table if not exists support_logs (
  id bigint generated always as identity primary key,
  created_at timestamptz not null default now(),
  question text not null,
  page text not null default ''
);

alter table console_users enable row level security;
alter table support_logs enable row level security;

create index if not exists idx_support_created on support_logs (created_at desc);
