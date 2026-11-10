-- Atomic execution lease (Phase B, cloud handoff). Guarantees a single writer per
-- task: the desktop OR a cloud worker runs it, never both. See docs/relay.md +
-- docs/cloud-worker.md. Run after 0002. Idempotent.

-- Acquire/renew/steal in one atomic step. Returns the EFFECTIVE owner after the
-- call: if it's you, you hold the lease and may run; if it's someone else, they
-- hold a fresh lease and you must not run. A lease whose heartbeat is older than
-- p_ttl_seconds is considered dead and can be stolen (covers a crashed runner).
create or replace function public.acquire_lease(p_task uuid, p_owner text, p_ttl_seconds int default 30)
returns text
language plpgsql
security invoker
as $$
declare
  cur public.run_lease%rowtype;
  uid uuid := (select auth.uid());
begin
  -- RLS restricts visibility to the caller's own rows; FOR UPDATE serialises
  -- concurrent acquirers of the same task.
  select * into cur from public.run_lease where task_id = p_task for update;

  if not found then
    insert into public.run_lease (task_id, user_id, owner, owner_since, heartbeat)
      values (p_task, uid, p_owner, now(), now());
    return p_owner;
  end if;

  if cur.owner = p_owner then
    update public.run_lease set heartbeat = now() where task_id = p_task;   -- renew mine
    return p_owner;
  elsif cur.heartbeat < now() - make_interval(secs => p_ttl_seconds) then
    update public.run_lease                                                 -- steal dead lease
      set owner = p_owner, owner_since = now(), heartbeat = now()
      where task_id = p_task;
    return p_owner;
  else
    return cur.owner;                                                       -- held by a live other
  end if;
end;
$$;

-- Release only if you still hold it.
create or replace function public.release_lease(p_task uuid, p_owner text)
returns void
language sql
security invoker
as $$
  delete from public.run_lease where task_id = p_task and owner = p_owner;
$$;
