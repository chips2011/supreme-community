# Auth handshake (frontend ↔ local backend)

The **app account** is Supabase. It is separate from the **model login**
(Claude/ChatGPT subscription via the local CLI) — don't conflate them in the UI.
The account gates the app; the model login is set up later in onboarding.

## What the frontend owns (Codex)

A sign-in screen with **two options** (both enabled in Supabase):
- **Continue with Google** (OAuth)
- **Email magic link** (OTP)

Use `@supabase/supabase-js` in the frontend for the actual auth flow (this is the
one place the browser talks to Supabase directly). The local backend never runs
the login — it only *verifies* the resulting token and starts cloud sync.

## The handshake

1. **On boot**, ask the backend whether accounts are on:
   ```
   GET /api/auth/config
   → { configured: boolean, url: string, anonKey: string }
   ```
   - `configured: false` → no Supabase keys set → **skip login entirely**, run
     the app exactly as today (local-only). Don't show the sign-in screen.
   - `configured: true` → init the Supabase client with `{ url, anonKey }` and
     show sign-in if there's no active Supabase session.

2. **After the user signs in** (Google or magic link), you have a Supabase
   session. Hand its access token to the local backend so it can hydrate + sync:
   ```
   POST /api/auth/session
   body: { access_token: session.access_token, user: session.user }
   → 200 { configured, signedIn, user, ready }   // ready=true when hydrate done
   → 401 if the token is invalid/expired
   ```
   Do this on initial sign-in **and** on every token refresh
   (`supabase.auth.onAuthStateChange`) so the backend always has a live token.

3. **On sign-out**:
   ```
   POST /api/auth/signout   → { ok: true }
   ```
   (Local data stays on the machine; only cloud mirroring stops.)

4. **Optional**: `GET /api/auth/status` returns the current
   `{ configured, signedIn, user, ready }` if you want to reflect sync state.

## Notes

- Persisting the Supabase session in the browser (localStorage, the supabase-js
  default) is fine — it's a single-user machine. On refresh, re-POST the token
  to `/api/auth/session` so the backend re-attaches.
- Everything else (projects, threads, settings) keeps using the same `/api/*`
  endpoints unchanged. Sync happens server-side; the frontend doesn't manage it.
- `ready:false` briefly after sign-in on a fresh machine means cloud data is
  still hydrating into the local store — fine to show the app immediately; a
  reload/poll will reflect pulled threads.
