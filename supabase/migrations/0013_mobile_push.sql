-- Section 33, the phone buzzes when a scheduled task lands, and reads light (2026-09-26).
-- The iOS app writes its APNs device token onto its own mobile_devices row;
-- the phone-push function reads it back with the service key to send.
-- push_env is 'sandbox' for a debug build, 'production' for TestFlight.
-- Run after 0012_slack_relay.sql. Idempotent. The row's existing
-- "own mobile devices" policy already covers the new columns.

alter table public.mobile_devices add column if not exists push_token text;
alter table public.mobile_devices add column if not exists push_env text;
alter table public.mobile_devices add column if not exists push_at timestamptz;

-- A handset has one token. When a second account signs in on the same phone,
-- the first account's row still holds it (RLS stops the phone clearing it),
-- so phone-push sends to a token only for the account that registered it last.
create index if not exists mobile_devices_push_token_idx
  on public.mobile_devices (push_token) where push_token is not null;

-- The phone's conversation screen reads one tab, not the workstream. It used
-- to pull threads.data whole every 2.5 s (a busy workstream is megabytes,
-- every tab, every message). This returns the tab list with only the open
-- tab's last p_last messages, in just the fields the phone draws, and when
-- the thread has not moved since p_since, only that it has not.
-- security invoker: the caller's own RLS on threads decides what it may read.
create or replace function public.thread_tab(p_thread uuid, p_tab text, p_last int default 80, p_since text default null)
returns jsonb
language sql stable security invoker set search_path = public
as $$
  select case when p_since is not null and th.data->>'updatedAt' = p_since
    then jsonb_build_object('id', th.id, 'unchanged', true, 'updatedAt', th.data->'updatedAt')
    else jsonb_build_object(
      'id', th.id,
      'title', th.data->'title',
      'repo', th.data->'repo',
      'repoName', th.data->'repoName',
      'lastActivity', th.data->'lastActivity',
      'updatedAt', th.data->'updatedAt',
      'tabs', coalesce((
        select jsonb_agg(jsonb_build_object(
          'id', t->'id', 'name', t->'name', 'model', t->'model', 'status', t->'status',
          'messages', case when t->>'id' = p_tab then coalesce((
            select jsonb_agg(jsonb_build_object(
              'role', case when jsonb_typeof(m->'role') = 'string' then m->'role' else '"assistant"'::jsonb end,
              'content', case when jsonb_typeof(m->'content') = 'string' then m->'content' else '""'::jsonb end,
              'model', m->'model', 'ts', m->'ts', 'ok', m->'ok', 'stopped', m->'stopped',
              'error', m->'error', 'hiddenInTranscript', m->'hiddenInTranscript') order by i)
            from jsonb_array_elements(coalesce(t->'messages', '[]'::jsonb)) with ordinality as x(m, i)
            where i > jsonb_array_length(coalesce(t->'messages', '[]'::jsonb)) - greatest(p_last, 1)
          ), '[]'::jsonb) else '[]'::jsonb end
        ) order by o)
        from jsonb_array_elements(coalesce(th.data->'tabs', '[]'::jsonb)) with ordinality as y(t, o)
      ), '[]'::jsonb))
    end
  from public.threads th
  where th.id = p_thread
$$;
grant execute on function public.thread_tab(uuid, text, int, text) to authenticated;
