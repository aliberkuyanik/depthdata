-- DepthData Console v3 ticket fields
-- Run once in Supabase SQL Editor. Safe to run again.

alter table reports add column if not exists title text not null default '';
alter table reports add column if not exists priority text not null default 'p3';  -- p1 critical | p2 high | p3 normal | p4 low
alter table reports add column if not exists assignee text not null default '';
alter table reports add column if not exists channel text not null default '';     -- in app | email | call | in person
alter table reports add column if not exists company text not null default '';
