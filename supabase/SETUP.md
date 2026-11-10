# Optional Supabase setup

No Supabase project is needed for local use. This directory contains the
original 0.1.119 schema and optional function source; it contains no production
data or credentials. Hosted setup is not part of the offline acceptance checks.

1. Create your own Supabase project. Use its SQL editor to review and apply
   `migrations/*.sql` in filename order. Review every migration before applying
   it, especially service configuration, notification/email triggers and the
   identity/sharing policies. Do not paste administrative credentials into the app.
2. Review all exposed tables, grants and RLS policies for your deployment.
   User-facing access must remain scoped by ownership or explicit membership.
   Review security-definer functions and verify cross-user access is denied
   with two test accounts. Enable the needed Realtime tables/channels for relay.
3. Configure your chosen Auth providers. Add the local browser origin
   `http://127.0.0.1:4757` to your redirect allowlist. The community desktop
   does not register the official app's callback schemes; use the browser flow
   until you configure your own desktop scheme and redirect handler.
4. Set `SUPABASE_URL` and the project's publishable key in `SUPABASE_ANON_KEY`
   in an ignored `.env.local`. The variable name is retained for compatibility.
   A legacy anon key also works. Never use a secret or service-role key here.
5. Start the app, sign in, and verify that only that user's records are visible
   and mirrored. Test sign-out and a second user before enabling shared use.

Optional edge functions require their own server-side secrets and infrastructure.
The service-role credential is restricted to those functions, never the client
or desktop bundle. The app's account is separate from model-provider accounts.

Current references:
- https://supabase.com/docs/guides/api/api-keys
- https://supabase.com/docs/guides/database/postgres/row-level-security
- https://supabase.com/docs/guides/auth/redirect-urls
