// Zero-dependency Supabase client for the local backend. We keep the no-deps
// ethos: raw fetch against Supabase's REST (PostgREST, /rest/v1) and Auth
// (GoTrue, /auth/v1) endpoints — no @supabase/supabase-js on the server.
//
// Everything here is config-gated. When SUPABASE_URL / SUPABASE_ANON_KEY are
// not set, isConfigured() is false and the app runs entirely local, exactly as
// before. Accounts + cloud sync only switch on once a project is configured.
//
// Data access uses the *logged-in user's* access token (passed from the
// frontend), so Postgres Row-Level Security enforces per-user isolation — the
// server never holds a god-mode service key in normal operation.

// Read env live (not at module load) so a .env loaded during boot is picked up
// regardless of import order.
function env() {
  return {
    url: (process.env.SUPABASE_URL || '').replace(/\/+$/, ''),
    anon: process.env.SUPABASE_ANON_KEY || '',
  };
}

// When the access token runs out, from its JWT payload. No verification here:
// the service only needs to know when to ask the renderer for a fresh one
// (Supabase issues one-hour tokens; the renderer holds the refresh token).
export function tokenExpiry(token) {
  try {
    const payload = JSON.parse(Buffer.from(String(token || '').split('.')[1] || '', 'base64url').toString('utf8'));
    return Number.isFinite(payload?.exp) ? payload.exp * 1000 : null;
  } catch {
    return null;
  }
}

export function tokenExpired(token, aheadMs = 0) {
  const expiry = tokenExpiry(token);
  return expiry != null && expiry - aheadMs <= Date.now();
}

export function isConfigured() {
  const { url, anon } = env();
  return !!(url && anon);
}

export function config() {
  const { url, anon } = env();
  return { url, anonKey: anon, configured: !!(url && anon) };
}

// Verify a user access token and return the auth user ({ id, email, ... }) or
// null. This is how the backend learns *who* a request is from: RLS does the
// enforcing, this just resolves identity for namespacing local data + sync.
export async function getUser(accessToken) {
  const { user } = await verifyUser(accessToken);
  return user || null;
}

// Like getUser, but the caller can tell a rejected token from a Supabase we
// could not reach. The difference decides whether the client should burn its
// stored session: "invalid" means the token is dead, "unreachable" means we
// simply do not know yet (offline at launch, a Supabase hiccup) and nothing
// should be torn down over it.
export async function verifyUser(accessToken) {
  if (!accessToken) return { invalid: true };
  if (!isConfigured()) return { unreachable: true };
  const { url, anon } = env();
  try {
    const res = await fetch(`${url}/auth/v1/user`, {
      headers: { apikey: anon, Authorization: `Bearer ${accessToken}` },
      signal: AbortSignal.timeout(8_000),
    });
    if (res.status === 401 || res.status === 403) return { invalid: true };
    if (!res.ok) return { unreachable: true };
    return { user: await res.json() };
  } catch {
    return { unreachable: true };
  }
}

// Thin PostgREST call. `token` is the user's access token (RLS-scoped); falls
// back to anon (only useful for public reads, of which we have none).
// Returns parsed JSON (array/object) or null on empty; throws on HTTP error.
// How long an upload may take before it is given up: 30s plus a second per
// 40KB, capped at three minutes. A 4MB workstream gets about two minutes.
// The flat 15s used to cut those off on an ordinary connection, and a push
// that is cut off is a cloud copy that stays stale (2026-10-05: one message
// landed six times after such a timeout).
export function uploadTimeoutMs(bytes) {
  return Math.min(180_000, 30_000 + Math.ceil((Number(bytes) || 0) / 40_000) * 1000);
}

export async function rest(pathAndQuery, { method = 'GET', token, body, rawBody, prefer, timeoutMs } = {}) {
  if (!isConfigured()) throw new Error('supabase not configured');
  const { url, anon } = env();
  const headers = {
    apikey: anon,
    Authorization: `Bearer ${token || anon}`,
    'Content-Type': 'application/json',
  };
  if (prefer) headers.Prefer = prefer;
  const payload = rawBody != null ? rawBody : body != null ? JSON.stringify(body) : undefined;
  // A read gets a minute: one workstream row can be 4MB, and 15s cut
  // those off on an ordinary connection too.
  const limit = timeoutMs ?? (payload ? uploadTimeoutMs(payload.length) : 60_000);
  const res = await fetch(`${url}/rest/v1/${pathAndQuery}`, {
    method,
    headers,
    body: payload,
    signal: AbortSignal.timeout(limit),
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    const error = new Error(`supabase ${method} ${pathAndQuery} → ${res.status} ${detail}`);
    error.status = res.status;
    try { error.code = JSON.parse(detail).code || null; } catch { error.code = null; }
    throw error;
  }
  const text = await res.text();
  return text ? JSON.parse(text) : null;
}

// Convenience: upsert a row (Prefer: resolution=merge-duplicates). With
// `select`, the named columns of the written row come back (the caller
// learns the cloud's updated_at without downloading the row again).
export function upsert(table, row, { token, select } = {}) {
  const rawBody = JSON.stringify(Array.isArray(row) ? row : [row]);
  return rest(select ? `${table}?select=${select}` : `${table}`, {
    method: 'POST',
    token,
    rawBody,
    prefer: `resolution=merge-duplicates,return=${select ? 'representation' : 'minimal'}`,
  });
}
