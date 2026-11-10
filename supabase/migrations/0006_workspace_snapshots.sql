-- Private workspace archives used while a thread runs in Supreme Cloud.
-- Objects are namespaced as <auth.uid()>/<task id>/<snapshot id>.tgz and are
-- readable or writable only by that authenticated user.

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('workspace-snapshots', 'workspace-snapshots', false, 52428800, array['application/gzip'])
on conflict (id) do update set
  public = excluded.public,
  file_size_limit = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types;

drop policy if exists "workspace snapshots read own" on storage.objects;
create policy "workspace snapshots read own" on storage.objects
  for select to authenticated
  using (
    bucket_id = 'workspace-snapshots'
    and split_part(name, '/', 1) = (select auth.uid())::text
  );

drop policy if exists "workspace snapshots insert own" on storage.objects;
create policy "workspace snapshots insert own" on storage.objects
  for insert to authenticated
  with check (
    bucket_id = 'workspace-snapshots'
    and split_part(name, '/', 1) = (select auth.uid())::text
  );

drop policy if exists "workspace snapshots delete own" on storage.objects;
create policy "workspace snapshots delete own" on storage.objects
  for delete to authenticated
  using (
    bucket_id = 'workspace-snapshots'
    and split_part(name, '/', 1) = (select auth.uid())::text
  );
