-- Realtime Authorization for the relay: make the control/run/presence channels
-- PRIVATE, so only the account that owns a topic can subscribe or send on it.
-- Without this, the channel topics embed a (non-secret) user id, and any
-- authenticated user who learned another's id could join their channel.
--
-- Mechanism (Supabase Realtime Authorization): when a client opens a channel
-- with `{ config: { private: true } }`, Realtime checks RLS on
-- `realtime.messages` using the caller's JWT. We allow a row only when the
-- topic's embedded user id equals auth.uid().
--
-- Topic shapes (see docs/relay.md) all carry the user id as the 2nd colon
-- segment: `control:<userId>`, `run:<userId>:<cmdId>`, `presence:<userId>`.
-- Run after 0001/0002. Idempotent.

-- True when the current user owns the given relay topic.
create or replace function public.owns_relay_topic(topic text)
returns boolean
language sql
stable
as $$
  select split_part(topic, ':', 2) = (select auth.uid())::text;
$$;

-- Note: RLS is already enabled on realtime.messages by default (and the table is
-- owned by supabase_realtime_admin, so we can't ALTER it here) — we only add the
-- ownership policies below.

-- Receive (subscribe / read broadcast + presence) only on your own topics.
drop policy if exists "relay read own topic" on realtime.messages;
create policy "relay read own topic" on realtime.messages
  for select to authenticated
  using ( public.owns_relay_topic( (select realtime.topic()) ) );

-- Send (broadcast + presence) only on your own topics.
drop policy if exists "relay write own topic" on realtime.messages;
create policy "relay write own topic" on realtime.messages
  for insert to authenticated
  with check ( public.owns_relay_topic( (select realtime.topic()) ) );
