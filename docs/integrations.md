# Optional services

Local use needs none of these services. This repository does not include
production accounts, credentials, signing material or a hosted service plan.

## Models

Install a supported Claude or Codex CLI from its official provider and complete
that provider's sign-in flow. Supreme invokes those local tools using your
account and permissions. Available models depend on the installed CLI and your
provider access. OpenRouter configuration uses your own account when enabled.

## Slack

The simplest local path is a bot token configured in Connectors. Socket Mode
also needs your own app-level token and Slack app event subscriptions. Grant
only the scopes needed for your workflow. Configure identity and notification
preferences before enabling notifications.

OAuth requires `SLACK_CLIENT_ID`, `SLACK_CLIENT_SECRET` and an explicit
`SLACK_REDIRECT_URL` pointing to your own handler. This legacy local exchange
is suitable only for your own configured instance. Never ship a shared client
secret in a desktop bundle; a shared service should perform exchanges server-side.
The community bundle staging script excludes both Slack credentials.

## Accounts and relay

See ../supabase/SETUP.md. These features use your own Supabase project and its
RLS policies. There is no default connection to Supreme production.

## Workers, email and notifications

`worker.mjs`, `Dockerfile.worker` and `lib/flymachines.mjs` describe the original
optional worker. Set your own Fly application, image and runtime configuration.
Do not use the example application name as an existing service. Review provider
CLI versions and resource costs before deploying; no worker is deployed by CI.

Inbound email functions under `supabase/functions` require your own Resend
domain, webhook verification secrets, user mappings and Supabase deployment.
Configure the inbound domain and sender identity explicitly. Push delivery needs
your own notification credentials and a valid VAPID_SUBJECT contact when used.

These service flows are included as source references. The launch verification
covers local fixture-backed operation; live Slack OAuth, cloud workers, email,
mobile push and hosted Supabase are not claimed as verified deployments.
