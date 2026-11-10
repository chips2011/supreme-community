-- Section 32, Email to Supreme (2026-09-25). An email forwarded to
-- <project>@in.example.com waits here until the owner's Mac picks it up
-- (lib/email-pickup.mjs) and feeds it to the inbound path. The mail
-- service's inbound hook (not built yet: a small route on the Slack app's
-- Vercel side, holding the service role key) writes each row with owner set
-- to the Supreme user whose address sent it. A Mac reads and stamps only its
-- own rows. NOT APPLIED: Alex okays it first.
create table if not exists public.inbound_emails (
  id uuid primary key default gen_random_uuid(),
  owner uuid not null references auth.users (id) on delete cascade,
  to_addr text not null,
  from_addr text not null,
  subject text not null default '',
  text text not null default '',
  message_id text,
  in_reply_to text,
  raw_headers jsonb not null default '{}'::jsonb,
  received_at timestamptz not null default now(),
  picked_at timestamptz
);

create index if not exists inbound_emails_owner_unpicked
  on public.inbound_emails (owner, received_at)
  where picked_at is null;

alter table public.inbound_emails enable row level security;

drop policy if exists "owner reads own inbound emails" on public.inbound_emails;
create policy "owner reads own inbound emails" on public.inbound_emails
  for select using (owner = auth.uid());

drop policy if exists "owner stamps own inbound emails" on public.inbound_emails;
create policy "owner stamps own inbound emails" on public.inbound_emails
  for update using (owner = auth.uid()) with check (owner = auth.uid());

drop policy if exists "owner deletes own inbound emails" on public.inbound_emails;
create policy "owner deletes own inbound emails" on public.inbound_emails
  for delete using (owner = auth.uid());

-- No insert policy: only the service role (the inbound hook) writes rows.
