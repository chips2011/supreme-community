-- Section 34, Landed on the phone (2026-10-05). When this person last read
-- each tab, shared by their Macs and their phone, so Landed is one list:
-- completing a tab on the phone takes it out of Landed on the Mac, and
-- reading it on the Mac takes it out on the phone. A tab is in Landed while
-- its last turn came back after this stamp. Each Mac still keeps its own
-- looks in the window (web/src/lib/vitality.ts) and writes the ones that
-- matter here (web/src/lib/seen.ts). Run after 0013_mobile_push.sql.
-- Idempotent.

create table if not exists public.tab_seen (
  user_id   uuid        not null default auth.uid() references auth.users(id) on delete cascade,
  thread_id uuid        not null,
  tab_id    text        not null,
  seen_at   timestamptz not null,
  primary key (user_id, thread_id, tab_id)
);

alter table public.tab_seen enable row level security;

drop policy if exists "own seen" on public.tab_seen;
create policy "own seen" on public.tab_seen
  for all using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));

grant select, insert, update, delete on public.tab_seen to authenticated;

-- Several stamps at once, [{thread_id, tab_id, seen_at}]. A stamp only ever
-- moves forward, so a Mac coming back with an older look never un-reads a
-- tab the phone has already completed. Returns how many rows it wrote.
create or replace function public.mark_seen(p_stamps jsonb)
returns int language sql volatile security invoker set search_path = public as $$
  with incoming as (
    select (s->>'thread_id')::uuid as thread_id, s->>'tab_id' as tab_id, max((s->>'seen_at')::timestamptz) as seen_at
    from jsonb_array_elements(case when jsonb_typeof(p_stamps) = 'array' then p_stamps else '[]'::jsonb end) as x(s)
    where coalesce(s->>'thread_id', '') ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
      and coalesce(s->>'tab_id', '') <> ''
      and coalesce(s->>'seen_at', '') <> ''
    group by 1, 2
  ), written as (
    insert into public.tab_seen as seen (user_id, thread_id, tab_id, seen_at)
    select auth.uid(), thread_id, tab_id, seen_at from incoming
    on conflict (user_id, thread_id, tab_id) do update
      set seen_at = greatest(seen.seen_at, excluded.seen_at)
    returning 1
  )
  select count(*)::int from written;
$$;

grant execute on function public.mark_seen(jsonb) to authenticated;
