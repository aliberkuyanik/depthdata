-- DepthData Admin v1 database setup
-- Run this once: Supabase dashboard -> SQL Editor -> New query -> paste all -> Run.

-- Leads from the login page signup form
create table if not exists access_requests (
  id bigint generated always as identity primary key,
  created_at timestamptz not null default now(),
  name text not null default '',
  email text not null,
  company text not null default '',
  source text not null default 'login page',
  status text not null default 'new',      -- new | contacted | invited | closed
  notes text not null default ''
);

-- In-app bug reports and feedback
create table if not exists reports (
  id bigint generated always as identity primary key,
  created_at timestamptz not null default now(),
  type text not null default 'General',
  message text not null,
  email text not null default '',
  page text not null default '',
  app text not null default 'manager',     -- manager | employee
  status text not null default 'open'      -- open | resolved
);

-- Lock both tables completely: row level security ON with no public policies.
-- The serverless functions use the secret (service) key, which bypasses RLS.
-- The publishable key can therefore read nothing. This is intentional.
alter table access_requests enable row level security;
alter table reports enable row level security;

-- Helpful indexes for the console views
create index if not exists idx_requests_status on access_requests (status, created_at desc);
create index if not exists idx_reports_status on reports (status, created_at desc);
