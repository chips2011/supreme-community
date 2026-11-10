-- Live run state, database-backed (2026-08-31). Realtime broadcast is the
-- fast path for mirroring a teammate's run; this table is the truth that
-- polling can always reach — Alex's Mac joins the realtime channel and is
-- closed by the far end within milliseconds, every time, so a mirror that
-- only travels by broadcast simply never arrives there. One row per running
-- tab, upserted every few seconds by the runner's Mac, deleted at landing.
create table if not exists public.run_state (
  tab_id uuid primary key,
  task_id uuid not null,
  project_id uuid not null,
  user_id uuid not null default auth.uid(),
  state jsonb not null,
  updated_at timestamptz not null default now()
);

alter table public.run_state enable row level security;

drop policy if exists "members read run state" on public.run_state;
create policy "members read run state" on public.run_state
  for select using (public.is_project_member(project_id));

drop policy if exists "members insert own run state" on public.run_state;
create policy "members insert own run state" on public.run_state
  for insert with check (user_id = auth.uid() and public.is_project_member(project_id));

drop policy if exists "members update own run state" on public.run_state;
create policy "members update own run state" on public.run_state
  for update using (user_id = auth.uid());

drop policy if exists "members delete own run state" on public.run_state;
create policy "members delete own run state" on public.run_state
  for delete using (user_id = auth.uid());
