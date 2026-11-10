-- Section 32 (2026-09-25): what the resend-inbound function needs, kept in
-- Vault and handed only to the service role. Secrets are stored with
-- vault.create_secret under the names below, never in this file.
create or replace function public.inbound_email_config()
returns json
language sql
security definer
set search_path = ''
as $$
  select json_build_object(
    'resend_api_key', (select decrypted_secret from vault.decrypted_secrets where name = 'supreme_inbound_resend_key'),
    'webhook_secret', (select decrypted_secret from vault.decrypted_secrets where name = 'supreme_inbound_webhook_secret'),
    'sender_aliases', (select decrypted_secret from vault.decrypted_secrets where name = 'supreme_inbound_sender_aliases')
  );
$$;
revoke all on function public.inbound_email_config() from public, anon, authenticated;
grant execute on function public.inbound_email_config() to service_role;
