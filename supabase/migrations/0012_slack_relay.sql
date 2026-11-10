-- 2026-09-25: a teammate's @Supreme runs on the teammate's own Mac. The
-- Slack listener lives on one Mac (the app token's); when someone else in a
-- shared project asks, that Mac writes the request here for the asker's Mac,
-- which picks it up and answers in Slack with the workspace bot token it
-- already holds. A row is readable by its sender and its recipient only, and
-- can only be addressed to someone who shares a project with the sender.
create table if not exists public.slack_relay (
  id uuid primary key default gen_random_uuid(),
  sender uuid not null default auth.uid() references auth.users (id) on delete cascade,
  recipient uuid not null references auth.users (id) on delete cascade,
  kind text not null check (kind in ('mention', 'action', 'view')),
  payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  picked_at timestamptz,
  note text
);

create index if not exists slack_relay_recipient_unpicked
  on public.slack_relay (recipient, created_at)
  where picked_at is null;

alter table public.slack_relay enable row level security;

create or replace function public.shares_a_project_with(other uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.project_members mine
    join public.project_members theirs on theirs.project_id = mine.project_id
    where mine.user_id = auth.uid() and theirs.user_id = other
  );
$$;
revoke all on function public.shares_a_project_with(uuid) from public, anon;
grant execute on function public.shares_a_project_with(uuid) to authenticated;

drop policy if exists "sender writes to a teammate" on public.slack_relay;
create policy "sender writes to a teammate" on public.slack_relay
  for insert with check (sender = auth.uid() and public.shares_a_project_with(recipient));

drop policy if exists "sender and recipient read" on public.slack_relay;
create policy "sender and recipient read" on public.slack_relay
  for select using (sender = auth.uid() or recipient = auth.uid());

drop policy if exists "recipient stamps" on public.slack_relay;
create policy "recipient stamps" on public.slack_relay
  for update using (recipient = auth.uid()) with check (recipient = auth.uid());

drop policy if exists "sender or recipient deletes" on public.slack_relay;
create policy "sender or recipient deletes" on public.slack_relay
  for delete using (sender = auth.uid() or recipient = auth.uid());
