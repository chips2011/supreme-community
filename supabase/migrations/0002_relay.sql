-- Relay: offline command queue + execution lease. See docs/relay.md.
-- Run after 0001_init.sql. Idempotent.

-- ---------------------------------------------------------------------------
-- commands: phone → desktop queue for when the Mac is asleep/offline. When the
-- desktop is present, commands go over Realtime broadcast instead and never
-- touch this table; this is the durable fallback that drains on wake.
create table if not exists public.commands (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid        not null references auth.users(id) on delete cascade,
  payload    jsonb       not null,                 -- { type, taskId, tabId, prompt, ... }
  status     text        not null default 'queued', -- queued | claimed | done | failed
  claimed_by text,                                  -- runnerId that took it
  claimed_at timestamptz,
  result     jsonb,
  created_at timestamptz not null default now()
);
create index if not exists commands_user_pending_idx
  on public.commands (user_id, status, created_at);

-- ---------------------------------------------------------------------------
-- run_lease: single-writer guarantee for a task's execution. Only `owner` runs
-- it; the other runner (desktop or cloud worker) observes. Heartbeat lets a live
-- runner reclaim a lease whose owner died. See Phase B in docs/relay.md.
create table if not exists public.run_lease (
  task_id     uuid primary key,
  user_id     uuid        not null references auth.users(id) on delete cascade,
  owner       text        not null,                -- desktop-<id> | cloud-<id>
  owner_since timestamptz not null default now(),
  heartbeat   timestamptz not null default now()
);
create index if not exists run_lease_user_idx on public.run_lease (user_id);

-- ---------------------------------------------------------------------------
-- RLS: private to the owner, same as every other table.
alter table public.commands  enable row level security;
alter table public.run_lease enable row level security;

drop policy if exists "own commands" on public.commands;
create policy "own commands" on public.commands
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

drop policy if exists "own lease" on public.run_lease;
create policy "own lease" on public.run_lease
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);
