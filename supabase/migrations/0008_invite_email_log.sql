-- Same team: the invite email, made observable. Run after 0007. Idempotent.
--
-- Every fire of the invite trigger writes one line per step to
-- public.invite_email_log (readable only in the dashboard: RLS on, no
-- policies), so a share that produced no email can be read back instead of
-- guessed at. The sharer's name comes from what the app knows (the owner's
-- member row, then the profile), never the bare email local part, and the
-- email carries a Reply-To to the sharer.

create table if not exists public.invite_email_log (
  id         bigserial primary key,
  member_id  uuid,
  email      text,
  step       text        not null,
  detail     text,
  created_at timestamptz not null default now()
);
alter table public.invite_email_log enable row level security;

create or replace function public.sharer_name(p_owner uuid)
returns text
language sql stable security definer set search_path = public as $$
  select coalesce(
    (select nullif(m.name, '') from public.project_members m
       where m.user_id = p_owner and m.role = 'owner' and nullif(m.name, '') is not null
       order by m.created_at desc limit 1),
    (select nullif(pr.name, '') from public.profiles pr where pr.id = p_owner),
    (select nullif(split_part(coalesce(pr.email, ''), '@', 1), '') from public.profiles pr where pr.id = p_owner),
    'A teammate'
  );
$$;

create or replace function public.sharer_email(p_owner uuid)
returns text
language sql stable security definer set search_path = public as $$
  select coalesce(
    (select nullif(m.email, '') from public.project_members m
       where m.user_id = p_owner and m.role = 'owner' order by m.created_at desc limit 1),
    (select nullif(pr.email, '') from public.profiles pr where pr.id = p_owner)
  );
$$;

create or replace function public.send_invite_email()
returns trigger
language plpgsql security definer set search_path = public, extensions as $$
declare
  key     text;
  proj    public.projects%rowtype;
  c       record;
  sharer  text;
  reply   text;
  pname   text;
  link    text;
  what    text;
  subj    text;
  html    text;
  plain   text;
  rid     bigint;
begin
  insert into public.invite_email_log (member_id, email, step) values (new.id, new.email, 'fired');
  if new.role <> 'editor' or new.user_id is not null then
    insert into public.invite_email_log (member_id, email, step, detail) values (new.id, new.email, 'skipped', 'role=' || new.role || ' accepted=' || (new.user_id is not null)::text);
    return new;
  end if;
  begin
    select decrypted_secret into key from vault.decrypted_secrets
      where name = 'resend_api_key' order by created_at desc limit 1;
  exception when others then
    insert into public.invite_email_log (member_id, email, step, detail) values (new.id, new.email, 'vault error', sqlerrm);
    return new;
  end;
  if key is null then
    insert into public.invite_email_log (member_id, email, step) values (new.id, new.email, 'no key');
    return new;
  end if;
  select * into proj from public.projects where id = new.project_id;
  if not found then
    insert into public.invite_email_log (member_id, email, step) values (new.id, new.email, 'no project');
    return new;
  end if;
  begin
    select * into c from public.project_counts(proj.id);
    sharer := public.sharer_name(proj.owner_id);
    reply  := public.sharer_email(proj.owner_id);
    pname  := coalesce(proj.data ->> 'name', 'a project');
    link   := 'https://example.com/join/' || new.token;
    what   := c.workstreams || ' workstream' || case when c.workstreams = 1 then '' else 's' end
           || '  ·  ' || c.plays || ' play' || case when c.plays = 1 then '' else 's' end
           || case when c.context_notes > 0 then '  ·  shared context' else '' end;
    subj   := sharer || ' shared ' || pname || ' with you';
    plain  := subj || E'\n' || what || E'\n\nOpen ' || pname || ': ' || link
           || E'\n\nSent to ' || new.email || ' only. This is not a public link.'
           || case when reply is not null then E'\n\nReply to this email to reach ' || sharer || ' at ' || reply || '.' else '' end;
    html   := '<div style="font-family:-apple-system,Helvetica,Arial,sans-serif;color:#111;max-width:480px;margin:0 auto;padding:32px 24px">'
           || '<p style="font-size:12px;letter-spacing:.04em;color:#666;margin:0 0 24px">Supreme</p>'
           || '<h1 style="font-size:20px;font-weight:600;margin:0 0 8px">' || subj || '</h1>'
           || '<p style="font-size:14px;color:#555;margin:0 0 24px">' || what || '</p>'
           || '<p style="margin:0 0 32px"><a href="' || link || '" style="display:inline-block;background:#1f3bd6;color:#fff;text-decoration:none;font-size:14px;font-weight:600;padding:10px 16px;border-radius:8px">Open ' || pname || '</a></p>'
           || '<p style="font-size:12px;color:#888;margin:0">Sent to ' || new.email || ' only. This is not a public link.'
           || case when reply is not null then ' Reply to this email to reach ' || sharer || '.' else '' end || '</p>'
           || '</div>';
  exception when others then
    insert into public.invite_email_log (member_id, email, step, detail) values (new.id, new.email, 'compose error', sqlerrm);
    return new;
  end;
  begin
    select net.http_post(
      url := 'https://api.resend.com/emails',
      headers := jsonb_build_object('Authorization', 'Bearer ' || key, 'Content-Type', 'application/json'),
      body := jsonb_strip_nulls(jsonb_build_object(
        'from', 'Supreme <hello@example.com>',
        'to', jsonb_build_array(new.email),
        'reply_to', reply,
        'subject', subj,
        'html', html,
        'text', plain
      ))
    ) into rid;
  exception when others then
    insert into public.invite_email_log (member_id, email, step, detail) values (new.id, new.email, 'http_post error', sqlerrm);
    return new;
  end;
  insert into public.invite_email_log (member_id, email, step, detail) values (new.id, new.email, 'queued', 'request ' || rid::text);
  return new;
end;
$$;

drop trigger if exists send_invite_email on public.project_members;
create trigger send_invite_email
  after insert on public.project_members
  for each row execute function public.send_invite_email();

-- Leftovers from today's diagnosis, if they exist.
drop function if exists public._invite_trace(uuid);
drop function if exists public._vault_probe_rpc();
drop function if exists public._vault_probe();
