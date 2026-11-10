import type { AuthChangeEvent, EmailOtpType, Session, SupabaseClient } from '@supabase/supabase-js';
import { api } from './api';
import { boot } from './actions';
import { set, toast } from './store';
import { captureAnalytics, identifyAnalyticsUser, resetAnalyticsUser } from './analytics';
import { clearBlockedPrompts, loadBlockedPrompts } from './lib/prefs';

interface AuthConfig {
  configured: boolean;
  url?: string;
  anonKey?: string;
}

let client: SupabaseClient | null = null;
let initialization: Promise<void> | null = null;
let appBoot: Promise<void> | null = null;
let lastAttachedToken: string | null = null;
let signoutRequest: Promise<void> | null = null;
let desktopAuthUnsubscribe: (() => void) | null = null;
let lastDesktopCallback: string | null = null;
let backendSessionCheck: Promise<void> | null = null;

function bootAppOnce(): Promise<void> {
  if (!appBoot) appBoot = boot();
  return appBoot;
}

class AttachError extends Error {
  status: number;

  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}

async function attachBackendSession(session: Session): Promise<void> {
  if (lastAttachedToken === session.access_token) return;
  // The timeout keeps a wedged verify (the service waiting on a dead network)
  // from holding the sign-in screen on its spinner forever; a timeout counts
  // as transient, never as a rejected token.
  const response = await fetch('/api/auth/session', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ access_token: session.access_token, user: session.user }),
    signal: AbortSignal.timeout(15_000),
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new AttachError(body.error || 'Could not finish signing in.', response.status);
  lastAttachedToken = session.access_token;
}

async function notifyBackendSignout(): Promise<void> {
  if (signoutRequest) return signoutRequest;
  signoutRequest = api('/api/auth/signout', { method: 'POST' })
    .then(() => undefined)
    .finally(() => { signoutRequest = null; });
  return signoutRequest;
}

async function acceptSession(session: Session, { initial = false, renewed = false }: { initial?: boolean; renewed?: boolean } = {}): Promise<void> {
  const gateUntilAttached = initial || !appBoot;
  const newlyAttached = lastAttachedToken !== session.access_token;
  set((s) => {
    s.session = session;
    s.user = session.user;
    s.authError = null;
    if (gateUntilAttached) s.authReady = false;
  });
  loadBlockedPrompts();
  try {
    await attachBackendSession(session);
    const metadata = session.user.user_metadata || {};
    const displayName = [metadata.name, metadata.full_name]
      .find((value) => typeof value === 'string' && value.trim()) as string | undefined;
    identifyAnalyticsUser(session.user.id, {
      email: session.user.email,
      name: displayName?.trim(),
    });
    if (newlyAttached) captureAnalytics(initial ? 'auth_session_restored' : 'auth_completed', { auth_method: 'supabase' });
    set((s) => { s.authReady = true; });
    await bootAppOnce();
  } catch (error) {
    if (newlyAttached) captureAnalytics('auth_failed', { auth_method: 'supabase', failure_stage: 'backend_session' });
    const rejected = error instanceof AttachError && error.status === 401;
    if (rejected && !renewed && client) {
      // The access token lapsed while the app was closed; the refresh token
      // in storage is usually still good. Renew once and try again before
      // treating this as a real sign-out.
      const refreshed = await client.auth.refreshSession().catch(() => null);
      const next = refreshed && !refreshed.error ? refreshed.data.session : null;
      if (next && next.access_token !== session.access_token) {
        return acceptSession(next, { initial, renewed: true });
      }
    }
    if (rejected) {
      // Both the access token and its renewal are dead: this session is over.
      if (gateUntilAttached) {
        await client?.auth.signOut({ scope: 'local' }).catch(() => {});
        clearBlockedPrompts();
        set((s) => { s.session = null; s.user = null; s.authReady = true; });
      }
      toast((error as Error).message || 'Could not finish signing in.');
      return;
    }
    // Anything else is transient: the service was mid-restart, the network was
    // not up yet, Supabase blinked. Wiping the stored session over that is how
    // a restart used to land on the sign-in screen. Stay signed in, run
    // locally, and let the heartbeat repair the handshake when it can.
    set((s) => { s.authReady = true; });
    void bootAppOnce();
    toast('Could not reach the cloud. Working locally until it reconnects.');
  }
}

function authChanged(event: AuthChangeEvent, session: Session | null): void {
  if (session) {
    void acceptSession(session);
    return;
  }
  lastAttachedToken = null;
  clearBlockedPrompts();
  set((s) => { s.session = null; s.user = null; s.authReady = true; });
  if (event === 'SIGNED_OUT') void notifyBackendSignout().catch(() => {});
}

function callbackError(callback: URL): string | null {
  const hash = new URLSearchParams(callback.hash.replace(/^#/, ''));
  return callback.searchParams.get('error_description')
    || callback.searchParams.get('error')
    || hash.get('error_description')
    || hash.get('error');
}

async function verifyEmailCallback(callback: URL): Promise<boolean> {
  if (!client) return false;
  const tokenHash = callback.searchParams.get('token_hash');
  if (!tokenHash) return false;
  const type = (callback.searchParams.get('type') || 'email') as EmailOtpType;
  const { error } = await client.auth.verifyOtp({ token_hash: tokenHash, type });
  if (error) throw error;
  return true;
}

async function acceptBrowserAuthCallback(): Promise<void> {
  if (window.conductorDesktop || !client) return;
  const callback = new URL(window.location.href);
  const providerError = callbackError(callback);
  const hasEmailToken = callback.searchParams.has('token_hash');
  if (!providerError && !hasEmailToken) return;

  // One-time tokens should never remain in browser history after they are read.
  window.history.replaceState({}, document.title, window.location.pathname);
  if (providerError) throw new Error(providerError);
  await verifyEmailCallback(callback);
}

// Add to Slack lands here: the hosted page forwarded Slack's code into
// conductor://slack/callback; the service trades it for the token.
async function acceptSlackCallback(callback: URL): Promise<void> {
  try {
    const providerError = callbackError(callback);
    if (providerError) throw new Error(`Slack did not connect: ${providerError}`);
    const res = await api('/api/slack/oauth/exchange', {
      method: 'POST',
      body: JSON.stringify({ code: callback.searchParams.get('code') || '', state: callback.searchParams.get('state') || '' }),
    }) as { slack?: { health?: { state?: string }; team?: string } };
    const health = res.slack?.health?.state || '';
    set((s) => { s.slackReady = health !== 'rejected'; });
    toast(health === 'ok' ? `Slack connected${res.slack?.team ? ` to ${res.slack.team}` : ''}` : 'Slack connected. Checking the token…');
    window.dispatchEvent(new CustomEvent('supreme:slack-changed'));
  } catch (error) {
    toast((error as Error).message || 'Slack did not connect.');
  }
}

async function acceptDesktopAuthCallback(value: string): Promise<void> {
  if (!value || lastDesktopCallback === value) return;
  let parsed: URL | null = null;
  try { parsed = new URL(value); } catch { parsed = null; }
  if (parsed && parsed.hostname === 'slack') {
    lastDesktopCallback = value;
    await acceptSlackCallback(parsed);
    return;
  }
  if (!client) return;
  lastDesktopCallback = value;
  try {
    const callback = new URL(value);
    const providerError = callbackError(callback);
    if (providerError) throw new Error(providerError);
    if (await verifyEmailCallback(callback)) return;
    const code = callback.searchParams.get('code');
    if (!code) throw new Error('The sign-in link did not include an authorization code.');
    // Match this callback to the exact flow that started it (see the desktop
    // client's experimental.appendPkceFlowIdToRedirects note). auth-js only
    // auto-reads sb_flow_id from window.location, which a deep link never
    // becomes, so pass it through explicitly.
    const flowId = callback.searchParams.get('sb_flow_id');
    const { error } = await client.auth.exchangeCodeForSession(code, flowId ? { flowId } : undefined);
    if (error) throw error;
  } catch (error) {
    // A failed exchange used to vanish into a toast that the sign-in screen may
    // not render, leaving the Google button stuck on "Opening Google…". Log it
    // and put it on the auth state so AuthGate can show the reason and re-enable
    // the buttons instead of appearing to hang.
    const message = (error as Error).message || 'Could not finish desktop sign-in.';
    captureAnalytics('auth_failed', { auth_method: 'oauth', failure_stage: 'callback_exchange' });
    console.error('[auth] desktop sign-in callback failed:', error);
    set((s) => { s.authError = message; });
    toast(message);
  }
}

function installDesktopAuthCallbacks(): void {
  const desktop = window.conductorDesktop;
  if (!desktop || desktopAuthUnsubscribe) return;
  desktopAuthUnsubscribe = desktop.onAuthCallback((value) => {
    void acceptDesktopAuthCallback(value);
  });
  void desktop.takeAuthCallback().then((value) => {
    if (value) return acceptDesktopAuthCallback(value);
  }).catch((error) => {
    toast((error as Error).message || 'Could not read the desktop sign-in callback.');
  });
}

async function initialize(): Promise<void> {
  let config: AuthConfig;
  try {
    const response = await fetch('/api/auth/config');
    if (response.status === 404) {
      // Rolling-update compatibility: an older local process has no account
      // feature at all, which is equivalent to accounts being disabled.
      config = { configured: false };
    } else {
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(body.error || 'Could not check account setup.');
      config = body as AuthConfig;
    }
  } catch (error) {
    // Fail closed if account configuration cannot be determined.
    set((s) => { s.authConfigured = true; s.authReady = true; });
    toast((error as Error).message || 'Could not check account setup.');
    return;
  }

  if (!config.configured) {
    set((s) => { s.authConfigured = false; s.authReady = true; });
    await bootAppOnce();
    return;
  }

  if (!config.url || !config.anonKey) {
    set((s) => { s.authConfigured = true; s.authReady = true; });
    toast('Account sign-in is not fully configured.');
    return;
  }

  // Keep local-only installs on the existing lightweight path: Supabase's
  // browser bundle is loaded only after the backend says accounts are enabled.
  const { createClient } = await import('@supabase/supabase-js');
  client = createClient(config.url, config.anonKey, window.conductorDesktop ? {
    auth: {
      flowType: 'pkce',
      detectSessionInUrl: false,
      // The OAuth code returns through the `conductor://auth/callback` deep link,
      // never the renderer's own URL, so auth-js cannot recover the PKCE flow id
      // from window.location when we exchange it. Without the id the exchange
      // falls back to the most-recently-stored verifier — wrong whenever more
      // than one sign-in has been started (a retry, a second click, a leftover
      // from a prior launch): the completed flow's verifier no longer matches,
      // the exchange fails, and every stale attempt leaves a dead verifier
      // behind. Have auth-js carry the id back in the redirect (?sb_flow_id=)
      // so acceptDesktopAuthCallback can pass it explicitly and the exact
      // verifier for THIS attempt is used.
      experimental: { appendPkceFlowIdToRedirects: true },
    },
  } : undefined);
  set((s) => { s.authConfigured = true; });
  // The desktop window is often hidden or minimised for hours; auth-js pauses
  // its refresh timer on hidden documents, and a token that lapses leaves the
  // local service signed in on paper and failing every cloud call. Keep the
  // timer running regardless.
  if (window.conductorDesktop && typeof client.auth.startAutoRefresh === 'function') void client.auth.startAutoRefresh();
  try {
    await acceptBrowserAuthCallback();
  } catch (error) {
    toast((error as Error).message || 'Could not finish email sign-in.');
  }
  const { data, error } = await client.auth.getSession();
  if (error) {
    set((s) => { s.authReady = true; });
    toast(error.message);
  } else if (data.session) {
    await acceptSession(data.session, { initial: true });
  } else {
    set((s) => { s.session = null; s.user = null; s.authReady = true; });
  }

  client.auth.onAuthStateChange((event, session) => {
    // Keep Supabase's callback synchronous; continue the backend handshake in
    // the next microtask so token-refresh internals are never blocked.
    queueMicrotask(() => authChanged(event, session));
  });
  installDesktopAuthCallbacks();
}

export function initializeAuth(): Promise<void> {
  if (!initialization) initialization = initialize();
  return initialization;
}

// The local service can restart independently of the renderer. Supabase keeps
// the browser session, but the new backend process has no in-memory token. A
// quiet heartbeat restores that handshake without signing the user out or
// requiring a page refresh.
// Renew ahead of the lapse, so the service never sits on a dead token.
const RENEW_AHEAD_MS = 2 * 60_000;

export function ensureBackendSession(): Promise<void> {
  if (!client) return Promise.resolve();
  if (backendSessionCheck) return backendSessionCheck;
  backendSessionCheck = (async () => {
    const { data, error } = await client!.auth.getSession();
    if (error || !data.session) return;
    let session = data.session;
    const response = await fetch('/api/auth/status');
    if (!response.ok) return;
    const status = await response.json().catch(() => ({}));
    const serverExpiry = Date.parse(String(status.expiresAt || status.team?.expiresAt || ''));
    const serverStale = status.signedIn !== true
      || status.expired === true
      || status.team?.expired === true
      || (Number.isFinite(serverExpiry) && serverExpiry - Date.now() < RENEW_AHEAD_MS);
    if (!serverStale) return;
    // The token the service holds is about to lapse or already has. If ours is
    // the same one, get a fresh session first; then hand it over.
    const ownExpiry = Number(session.expires_at || 0) * 1000;
    if (session.access_token === lastAttachedToken || (ownExpiry && ownExpiry - Date.now() < RENEW_AHEAD_MS)) {
      const refreshed = await client!.auth.refreshSession();
      if (!refreshed.error && refreshed.data.session) session = refreshed.data.session;
    }
    lastAttachedToken = null;
    await attachBackendSession(session);
  })().catch(() => {
    // Expected while the local service is down; the next heartbeat retries.
  }).finally(() => {
    backendSessionCheck = null;
  });
  return backendSessionCheck;
}

export async function signInWithGoogle(): Promise<void> {
  if (!client) throw new Error('Account sign-in is not ready yet.');
  set((s) => { s.authError = null; });
  captureAnalytics('auth_started', { auth_method: 'google' });
  const desktop = window.conductorDesktop;
  try {
    const { data, error } = await client.auth.signInWithOAuth({
      provider: 'google',
      options: desktop
        ? { redirectTo: desktop.authCallbackUrl, skipBrowserRedirect: true }
        : { redirectTo: window.location.origin },
    });
    if (error) throw error;
    if (desktop) {
      if (!data.url) throw new Error('Google sign-in did not return an authorization URL.');
      await desktop.openExternalAuth(data.url);
    }
  } catch (error) {
    captureAnalytics('auth_failed', { auth_method: 'google', failure_stage: 'start' });
    throw error;
  }
}

export async function sendMagicLink(email: string): Promise<void> {
  if (!client) throw new Error('Account sign-in is not ready yet.');
  set((s) => { s.authError = null; });
  captureAnalytics('auth_started', { auth_method: 'magic_link' });
  const desktop = window.conductorDesktop;
  const { error } = await client.auth.signInWithOtp({
    email,
    options: { emailRedirectTo: desktop?.authCallbackUrl || window.location.origin },
  });
  if (error) {
    captureAnalytics('auth_failed', { auth_method: 'magic_link', failure_stage: 'send' });
    throw error;
  }
}

// Wipe this Mac's local threads + onboarding progress and sign out, returning the
// app to a clean first-run. Local-only (each Mac has its own ~/.workbench); the
// cloud copy and other machines are untouched. Used to re-test onboarding.
export async function resetThisMac(): Promise<void> {
  captureAnalytics('local_workspace_reset_started');
  try {
    await api('/api/account/reset', { method: 'POST' });
  } catch (error) {
    toast((error as Error).message || 'Could not reset this Mac.');
    return;
  }
  // Sign-out clears the Supabase session; the next sign-in re-runs onboarding
  // because settings.onboarding was cleared server-side.
  await signOutAccount();
}

export async function signOutAccount(): Promise<void> {
  if (!client) return;
  set((s) => { s.authReady = false; });
  try {
    const { error } = await client.auth.signOut();
    if (error) throw error;
    await notifyBackendSignout();
    captureAnalytics('auth_signed_out');
    resetAnalyticsUser();
  } catch (error) {
    toast((error as Error).message || 'Could not finish signing out.');
  } finally {
    lastAttachedToken = null;
    clearBlockedPrompts();
    set((s) => { s.session = null; s.user = null; s.authReady = true; });
  }
}
