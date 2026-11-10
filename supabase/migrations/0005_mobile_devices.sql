-- Phone presence and TestFlight requests for the desktop Remote page.
-- Run after 0004_lease.sql. Idempotent.

create table if not exists public.mobile_devices (
  user_id     uuid        not null references auth.users(id) on delete cascade,
  device_id   text        not null,
  platform    text        not null default 'ios',
  device_name text,
  app_version text,
  last_seen   timestamptz not null default now(),
  primary key (user_id, device_id)
);
create index if not exists mobile_devices_user_seen_idx
  on public.mobile_devices (user_id, last_seen desc);

create table if not exists public.testflight_requests (
  user_id      uuid        not null references auth.users(id) on delete cascade,
  email        text        not null,
  requested_at timestamptz not null default now(),
  primary key (user_id, email)
);

alter table public.mobile_devices enable row level security;
alter table public.testflight_requests enable row level security;

drop policy if exists "own mobile devices" on public.mobile_devices;
create policy "own mobile devices" on public.mobile_devices
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

drop policy if exists "own testflight requests" on public.testflight_requests;
create policy "own testflight requests" on public.testflight_requests
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);
