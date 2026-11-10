-- Conductor: accounts + per-user data (local-first, cloud-synced).
--
-- The app on each person's Mac stays the working store (~/.workbench). This
-- schema is the cloud mirror: real accounts + a private, per-user backup of
-- their projects, threads, settings, and duel/eval history. Every row is
-- isolated by Row-Level Security to auth.uid().
--
-- Model logins (Claude/ChatGPT subscriptions via the local CLI) are NOT here —
-- those live on the user's machine. This is only the app account + their data.
--
-- Run this once against a fresh Supabase project (SQL Editor → paste → Run,
-- or `supabase db push`). Idempotent: safe to re-run.

-- ---------------------------------------------------------------------------
-- profiles: one row per auth user (identity + plan/billing hook)
create table if not exists public.profiles (
  id         uuid primary key references auth.users(id) on delete cascade,
  email      text,
  name       text,
  plan       text        not null default 'free',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- user_docs: whole-file JSON blobs the app reads/writes wholesale.
-- Mirrors ~/.workbench/repos.json and settings.json. key in ('repos','settings').
create table if not exists public.user_docs (
  user_id    uuid        not null references auth.users(id) on delete cascade,
  key        text        not null,
  data       jsonb       not null default '{}'::jsonb,
  updated_at timestamptz not null default now(),
  primary key (user_id, key)
);

-- ---------------------------------------------------------------------------
-- threads: one row per thread/task. Mirrors ~/.workbench/tasks/<id>.json.
-- `data` is the full document; `summary` is the light list-view projection so
-- listing threads never has to pull every full transcript.
create table if not exists public.threads (
  id            uuid primary key,
  user_id       uuid        not null references auth.users(id) on delete cascade,
  data          jsonb       not null,
  summary       jsonb       not null default '{}'::jsonb,
  archived      boolean     not null default false,
  last_activity timestamptz,
  updated_at    timestamptz not null default now()
);
create index if not exists threads_user_idx on public.threads (user_id, last_activity desc);

-- ---------------------------------------------------------------------------
-- evals: append-only duel/pick log. Mirrors evals.jsonl — the preference-pair
-- data the product's eval moat is built on (every A/B pick is a labeled compare).
create table if not exists public.evals (
  id      uuid primary key default gen_random_uuid(),
  user_id uuid        not null references auth.users(id) on delete cascade,
  record  jsonb       not null,
  at      timestamptz not null default now()
);
create index if not exists evals_user_idx on public.evals (user_id, at desc);

-- ---------------------------------------------------------------------------
-- Row-Level Security: every row is private to its owner. Nothing is readable
-- or writable across accounts, even with a valid token for another user.
alter table public.profiles  enable row level security;
alter table public.user_docs enable row level security;
alter table public.threads   enable row level security;
alter table public.evals     enable row level security;

drop policy if exists "own profile" on public.profiles;
create policy "own profile" on public.profiles
  for all using (auth.uid() = id) with check (auth.uid() = id);

drop policy if exists "own docs" on public.user_docs;
create policy "own docs" on public.user_docs
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

drop policy if exists "own threads" on public.threads;
create policy "own threads" on public.threads
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

drop policy if exists "own evals" on public.evals;
create policy "own evals" on public.evals
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

-- ---------------------------------------------------------------------------
-- Auto-provision a profile row when a new auth user signs up.
create or replace function public.handle_new_user()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  insert into public.profiles (id, email, name)
  values (
    new.id,
    new.email,
    coalesce(new.raw_user_meta_data->>'name', new.raw_user_meta_data->>'full_name', '')
  )
  on conflict (id) do nothing;
  return new;
end; $$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- ---------------------------------------------------------------------------
-- Keep updated_at fresh on every write.
create or replace function public.touch_updated_at()
returns trigger language plpgsql as $$
begin new.updated_at = now(); return new; end; $$;

drop trigger if exists touch_profiles on public.profiles;
create trigger touch_profiles before update on public.profiles
  for each row execute function public.touch_updated_at();

drop trigger if exists touch_user_docs on public.user_docs;
create trigger touch_user_docs before update on public.user_docs
  for each row execute function public.touch_updated_at();

drop trigger if exists touch_threads on public.threads;
create trigger touch_threads before update on public.threads
  for each row execute function public.touch_updated_at();
