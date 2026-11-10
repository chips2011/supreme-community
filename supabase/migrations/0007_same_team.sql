-- Same team (Paper section 19): share a project with a teammate by email.
-- See docs/same-team.md. Run after 0006. Idempotent: safe to re-run.
--
-- What this adds: a shared copy of a project record, who is in it, member
-- access to that project's threads, plays and lease, a queue for messages
-- waiting behind a running turn, the invite email (Resend via pg_net, key in
-- Vault under `resend_api_key`), and member access to `project:<id>` Realtime
-- topics. Every private row stays exactly as private as before.

-- ---------------------------------------------------------------------------
-- projects: the shared copy of a project record. Only projects that have been
-- shared get a row; private projects stay inside user_docs.repos as before.
create table if not exists public.projects (
  id         uuid primary key,
  owner_id   uuid        not null references auth.users(id) on delete cascade,
  data       jsonb       not null default '{}'::jsonb,   -- { name, contextBlocks, base }
  updated_at timestamptz not null default now()
);

-- project_members: one row per person per project. The owner's own row is
-- written when they first share; an invitee's row has no user_id until they
-- sign in with that email. `token` is the join link.
create table if not exists public.project_members (
  id          uuid        primary key default gen_random_uuid(),
  project_id  uuid        not null references public.projects(id) on delete cascade,
  email       text        not null,
  user_id     uuid        references auth.users(id) on delete cascade,
  role        text        not null default 'editor' check (role in ('owner', 'editor')),
  name        text,
  token       text        not null unique default encode(gen_random_bytes(16), 'hex'),
  invited_by  uuid        references auth.users(id) on delete set null,
  created_at  timestamptz not null default now(),
  accepted_at timestamptz,
  unique (project_id, email)
);
create index if not exists project_members_user_idx  on public.project_members (user_id);
create index if not exists project_members_email_idx on public.project_members (email);

-- threads: a project column so a row can be read by the project's members.
alter table public.threads add column if not exists project_id uuid;
create index if not exists threads_project_idx on public.threads (project_id, updated_at desc);

-- plays: mirrored plays. Own rows, plus the rows of any project shared with you.
create table if not exists public.plays (
  id         uuid        primary key,
  user_id    uuid        not null references auth.users(id) on delete cascade,
  project_id uuid,
  data       jsonb       not null,
  updated_at timestamptz not null default now()
);
create index if not exists plays_user_idx    on public.plays (user_id);
create index if not exists plays_project_idx on public.plays (project_id);

-- thread_queue: a message waiting behind a running turn in a shared thread.
-- Prompt text only; the sender's Mac keeps the full run body and is the only
-- Mac that will ever run it.
create table if not exists public.thread_queue (
  id          uuid        primary key,
  project_id  uuid        not null references public.projects(id) on delete cascade,
  task_id     uuid        not null,
  tab_id      text        not null,
  user_id     uuid        not null references auth.users(id) on delete cascade,
  name        text,
  prompt      text        not null,
  status      text        not null default 'queued' check (status in ('queued', 'running', 'done', 'expired', 'failed')),
  created_at  timestamptz not null default now(),
  started_at  timestamptz,
  finished_at timestamptz,
  run_id      uuid
);
create index if not exists thread_queue_project_idx on public.thread_queue (project_id, status, created_at);

-- run_lease: members may hold the lease for a shared thread.
alter table public.run_lease add column if not exists project_id uuid;

-- ---------------------------------------------------------------------------
-- Membership helpers. security definer so policies can consult project_members
-- without recursing into its own row-level security.
create or replace function public.is_project_member(p uuid)
returns boolean
language sql stable security definer set search_path = public as $$
  select p is not null and exists (
    select 1 from public.project_members m
    where m.project_id = p and m.user_id = (select auth.uid())
  );
$$;

create or replace function public.owns_project(p uuid)
returns boolean
language sql stable security definer set search_path = public as $$
  select p is not null and exists (
    select 1 from public.projects x where x.id = p and x.owner_id = (select auth.uid())
  );
$$;

-- ---------------------------------------------------------------------------
-- Row-Level Security.
alter table public.projects        enable row level security;
alter table public.project_members enable row level security;
alter table public.plays           enable row level security;
alter table public.thread_queue    enable row level security;

drop policy if exists "projects read" on public.projects;
create policy "projects read" on public.projects
  for select using (owner_id = (select auth.uid()) or public.is_project_member(id));
drop policy if exists "projects insert" on public.projects;
create policy "projects insert" on public.projects
  for insert with check (owner_id = (select auth.uid()));
drop policy if exists "projects update" on public.projects;
create policy "projects update" on public.projects
  for update using (owner_id = (select auth.uid())) with check (owner_id = (select auth.uid()));
drop policy if exists "projects delete" on public.projects;
create policy "projects delete" on public.projects
  for delete using (owner_id = (select auth.uid()));

drop policy if exists "members read" on public.project_members;
create policy "members read" on public.project_members
  for select using (public.is_project_member(project_id) or public.owns_project(project_id));
drop policy if exists "members insert" on public.project_members;
create policy "members insert" on public.project_members
  for insert with check (public.owns_project(project_id));
drop policy if exists "members update" on public.project_members;
create policy "members update" on public.project_members
  for update using (public.owns_project(project_id) or user_id = (select auth.uid()))
  with check (public.owns_project(project_id) or user_id = (select auth.uid()));
drop policy if exists "members delete" on public.project_members;
create policy "members delete" on public.project_members
  for delete using (public.owns_project(project_id));

-- "own threads" (0001) stays. Members of a shared project get the same rights
-- on that project's threads.
drop policy if exists "member threads" on public.threads;
create policy "member threads" on public.threads
  for all using (project_id is not null and public.is_project_member(project_id))
  with check (project_id is not null and public.is_project_member(project_id));

drop policy if exists "own plays" on public.plays;
create policy "own plays" on public.plays
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);
drop policy if exists "member plays" on public.plays;
create policy "member plays" on public.plays
  for all using (project_id is not null and public.is_project_member(project_id))
  with check (project_id is not null and public.is_project_member(project_id));

drop policy if exists "member queue" on public.thread_queue;
create policy "member queue" on public.thread_queue
  for all using (public.is_project_member(project_id))
  with check (public.is_project_member(project_id));

-- "own lease" (0002) stays for private threads and the cloud worker.
drop policy if exists "member lease" on public.run_lease;
create policy "member lease" on public.run_lease
  for all using (project_id is not null and public.is_project_member(project_id))
  with check (project_id is not null and public.is_project_member(project_id));

-- ---------------------------------------------------------------------------
-- Lease for a shared thread: same rules as acquire_lease (0004), plus the
-- project so members can see and steal a dead one.
create or replace function public.acquire_thread_lease(p_task uuid, p_project uuid, p_owner text, p_ttl_seconds int default 30)
returns text
language plpgsql security invoker as $$
declare
  cur public.run_lease%rowtype;
  uid uuid := (select auth.uid());
begin
  select * into cur from public.run_lease where task_id = p_task for update;
  if not found then
    insert into public.run_lease (task_id, user_id, project_id, owner, owner_since, heartbeat)
      values (p_task, uid, p_project, p_owner, now(), now());
    return p_owner;
  end if;
  if cur.owner = p_owner then
    update public.run_lease
      set heartbeat = now(), project_id = coalesce(project_id, p_project)
      where task_id = p_task;
    return p_owner;
  elsif cur.heartbeat < now() - make_interval(secs => p_ttl_seconds) then
    update public.run_lease
      set owner = p_owner, owner_since = now(), heartbeat = now(), user_id = uid,
          project_id = coalesce(project_id, p_project)
      where task_id = p_task;
    return p_owner;
  else
    return cur.owner;
  end if;
end;
$$;

-- ---------------------------------------------------------------------------
-- Counts the invite email and the join page both show.
create or replace function public.project_counts(p uuid)
returns table (workstreams int, plays int, context_notes int)
language sql stable security definer set search_path = public as $$
  select
    (select count(*)::int from public.threads t where t.project_id = p and t.archived = false),
    (select count(*)::int from public.plays x where x.project_id = p),
    (select case when jsonb_typeof(pr.data -> 'contextBlocks') = 'array'
                 then jsonb_array_length(pr.data -> 'contextBlocks') else 0 end
       from public.projects pr where pr.id = p);
$$;

create or replace function public.sharer_name(p_owner uuid)
returns text
language sql stable security definer set search_path = public as $$
  select coalesce(nullif(pr.name, ''), nullif(split_part(coalesce(pr.email, ''), '@', 1), ''), 'A teammate')
  from public.profiles pr where pr.id = p_owner;
$$;

-- The join page reads this with the anon key: names and counts only.
create or replace function public.invite_preview(p_token text)
returns json
language plpgsql stable security definer set search_path = public as $$
declare
  m public.project_members%rowtype;
  p public.projects%rowtype;
  c record;
begin
  if p_token is null or length(p_token) < 16 then return null; end if;
  select * into m from public.project_members where token = p_token limit 1;
  if not found then return null; end if;
  select * into p from public.projects where id = m.project_id;
  if not found then return null; end if;
  select * into c from public.project_counts(p.id);
  return json_build_object(
    'project', coalesce(p.data ->> 'name', 'Project'),
    'sharer', public.sharer_name(p.owner_id),
    'email', m.email,
    'role', m.role,
    'accepted', m.accepted_at is not null,
    'workstreams', c.workstreams,
    'plays', c.plays,
    'contextNotes', c.context_notes
  );
end;
$$;
grant execute on function public.invite_preview(text) to anon, authenticated;

-- Binds every pending invite for the signed-in email to this account. Called
-- after sign-in; returns the rows it bound.
create or replace function public.accept_invites()
returns setof public.project_members
language plpgsql security definer set search_path = public as $$
declare
  uid  uuid := (select auth.uid());
  mail text := lower(coalesce((select auth.jwt() ->> 'email'), ''));
  nm   text;
begin
  if uid is null or mail = '' then return; end if;
  select coalesce(nullif(pr.name, ''), split_part(mail, '@', 1)) into nm from public.profiles pr where pr.id = uid;
  return query
    update public.project_members m
      set user_id = uid,
          accepted_at = coalesce(m.accepted_at, now()),
          name = coalesce(nullif(m.name, ''), nm)
      where lower(m.email) = mail and m.user_id is null
      returning m.*;
end;
$$;

-- ---------------------------------------------------------------------------
-- The invite email (Paper 19.3), sent by the database when an invite row is
-- written. Resend over pg_net; the API key is read from Vault. Without the
-- key the row is still written and nothing is sent, so the app keeps working
-- before the key exists. One-time setup, run once in the SQL editor:
--   select vault.create_secret('re_xxxxxxxx', 'resend_api_key');
create extension if not exists pg_net with schema extensions;

create or replace function public.send_invite_email()
returns trigger
language plpgsql security definer set search_path = public, extensions as $$
declare
  key    text;
  proj   public.projects%rowtype;
  c      record;
  sharer text;
  name   text;
  link   text;
  what   text;
  subj   text;
  html   text;
  plain  text;
begin
  if new.role <> 'editor' or new.user_id is not null then return new; end if;
  begin
    select decrypted_secret into key from vault.decrypted_secrets
      where name = 'resend_api_key' order by created_at desc limit 1;
  exception when others then
    key := null;
  end;
  if key is null then return new; end if;

  select * into proj from public.projects where id = new.project_id;
  if not found then return new; end if;
  select * into c from public.project_counts(proj.id);
  sharer := public.sharer_name(proj.owner_id);
  name   := coalesce(proj.data ->> 'name', 'a project');
  link   := 'https://example.com/join/' || new.token;
  what   := c.workstreams || ' workstream' || case when c.workstreams = 1 then '' else 's' end
         || '  ·  ' || c.plays || ' play' || case when c.plays = 1 then '' else 's' end
         || case when c.context_notes > 0 then '  ·  shared context' else '' end;
  subj   := sharer || ' shared ' || name || ' with you';
  plain  := subj || E'\n' || what || E'\n\nOpen ' || name || ': ' || link
         || E'\n\nSent to ' || new.email || ' only. This is not a public link.';
  html   := '<div style="font-family:-apple-system,Helvetica,Arial,sans-serif;color:#111;max-width:480px;margin:0 auto;padding:32px 24px">'
         || '<p style="font-size:12px;letter-spacing:.04em;color:#666;margin:0 0 24px">Supreme</p>'
         || '<h1 style="font-size:20px;font-weight:600;margin:0 0 8px">' || subj || '</h1>'
         || '<p style="font-size:14px;color:#555;margin:0 0 24px">' || what || '</p>'
         || '<p style="margin:0 0 32px"><a href="' || link || '" style="display:inline-block;background:#1f3bd6;color:#fff;text-decoration:none;font-size:14px;font-weight:600;padding:10px 16px;border-radius:8px">Open ' || name || '</a></p>'
         || '<p style="font-size:12px;color:#888;margin:0">Sent to ' || new.email || ' only. This is not a public link.</p>'
         || '</div>';

  perform net.http_post(
    url := 'https://api.resend.com/emails',
    headers := jsonb_build_object('Authorization', 'Bearer ' || key, 'Content-Type', 'application/json'),
    body := jsonb_build_object(
      'from', 'Supreme <hello@example.com>',
      'to', jsonb_build_array(new.email),
      'subject', subj,
      'html', html,
      'text', plain
    )
  );
  return new;
end;
$$;

drop trigger if exists send_invite_email on public.project_members;
create trigger send_invite_email
  after insert on public.project_members
  for each row execute function public.send_invite_email();

-- ---------------------------------------------------------------------------
-- Realtime: members may use project:<projectId>[:...] topics. Per-user topics
-- keep the 0003 rule (2nd colon segment equals auth.uid()).
create or replace function public.can_use_relay_topic(topic text)
returns boolean
language plpgsql stable security definer set search_path = public as $$
declare
  seg text := split_part(topic, ':', 2);
begin
  if split_part(topic, ':', 1) = 'project' then
    if seg !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then return false; end if;
    return public.is_project_member(seg::uuid);
  end if;
  return seg = (select auth.uid())::text;
end;
$$;

drop policy if exists "relay read own topic" on realtime.messages;
create policy "relay read own topic" on realtime.messages
  for select to authenticated
  using ( public.can_use_relay_topic( (select realtime.topic()) ) );

drop policy if exists "relay write own topic" on realtime.messages;
create policy "relay write own topic" on realtime.messages
  for insert to authenticated
  with check ( public.can_use_relay_topic( (select realtime.topic()) ) );

-- ---------------------------------------------------------------------------
-- Keep updated_at fresh.
drop trigger if exists touch_projects on public.projects;
create trigger touch_projects before update on public.projects
  for each row execute function public.touch_updated_at();

drop trigger if exists touch_plays on public.plays;
create trigger touch_plays before update on public.plays
  for each row execute function public.touch_updated_at();
