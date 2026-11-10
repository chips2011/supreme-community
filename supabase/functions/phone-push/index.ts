// Section 33, the phone buzzes when a scheduled task lands (2026-09-26).
// A signed-in Mac posts { title, body, threadId, tabId, kind } with its
// user's access token; this sends an APNs alert to that same account's
// phones and nobody else's. The APNs key lives only here, as a function
// secret: a Mac never holds it, so no desktop install can push to a phone.
//
// Env: SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY (Supabase sets both),
// APNS_KEY (the .p8 file's text), APNS_KEY_ID, APNS_TEAM_ID, and optionally
// APNS_TOPIC (default com.supreme.remote). APNS_BASE / APNS_SANDBOX_BASE
// only exist so scripts/phone-push-smoke.mjs can stand in for Apple.
// No imports, so the same file runs under Deno and under Node's type
// stripping in that smoke.

type Env = {
  SUPABASE_URL: string;
  SUPABASE_SERVICE_ROLE_KEY: string;
  APNS_KEY: string;
  APNS_KEY_ID: string;
  APNS_TEAM_ID: string;
  APNS_TOPIC?: string;
  APNS_BASE?: string;
  APNS_SANDBOX_BASE?: string;
};

type Device = { device_id: string; push_token: string; push_env: string | null; push_at: string | null };

const KINDS = new Set(['done', 'waiting', 'failed', 'missed']);

function b64url(bytes: Uint8Array): string {
  let bin = '';
  for (const byte of bytes) bin += String.fromCharCode(byte);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function pemBytes(pem: string): Uint8Array {
  const body = pem.replace(/\\n/g, '\n').replace(/-----[A-Z ]+-----/g, '').replace(/\s+/g, '');
  const bin = atob(body);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i += 1) out[i] = bin.charCodeAt(i);
  return out;
}

// Apple refuses a provider token refreshed more than about every 20 minutes
// (TooManyProviderTokenUpdates) and one older than an hour, so one token is
// kept per warm instance for 40 minutes.
let cachedToken: { jwt: string; at: number; keyId: string } | null = null;

export async function providerToken(env: Env, now = Date.now()): Promise<string> {
  if (cachedToken && cachedToken.keyId === env.APNS_KEY_ID && now - cachedToken.at < 40 * 60_000) return cachedToken.jwt;
  const key = await crypto.subtle.importKey('pkcs8', pemBytes(env.APNS_KEY), { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']);
  const enc = new TextEncoder();
  const head = b64url(enc.encode(JSON.stringify({ alg: 'ES256', kid: env.APNS_KEY_ID })));
  const claims = b64url(enc.encode(JSON.stringify({ iss: env.APNS_TEAM_ID, iat: Math.floor(now / 1000) })));
  const signature = new Uint8Array(await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, key, enc.encode(`${head}.${claims}`)));
  const jwt = `${head}.${claims}.${b64url(signature)}`;
  cachedToken = { jwt, at: now, keyId: env.APNS_KEY_ID };
  return jwt;
}

function clip(value: unknown, max: number): string {
  const text = String(value ?? '').replace(/\s+/g, ' ').trim();
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

function service(env: Env): Record<string, string> {
  return { apikey: env.SUPABASE_SERVICE_ROLE_KEY, Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`, 'Content-Type': 'application/json' };
}

async function callerId(env: Env, req: Request): Promise<string | null> {
  const token = String(req.headers.get('authorization') || '').replace(/^Bearer\s+/i, '');
  if (!token) return null;
  const who = await fetch(`${env.SUPABASE_URL}/auth/v1/user`, { headers: { apikey: env.SUPABASE_SERVICE_ROLE_KEY, Authorization: `Bearer ${token}` } });
  if (!who.ok) return null;
  const user = await who.json().catch(() => null) as { id?: string } | null;
  return user?.id ? String(user.id) : null;
}

async function devicesOf(env: Env, userId: string): Promise<Device[]> {
  const res = await fetch(`${env.SUPABASE_URL}/rest/v1/mobile_devices?user_id=eq.${encodeURIComponent(userId)}&push_token=not.is.null&select=device_id,push_token,push_env,push_at`, { headers: service(env) });
  if (!res.ok) return [];
  return await res.json() as Device[];
}

// Two accounts on one handset leave the same token on two rows; it belongs
// to whichever registered it last.
async function ownsToken(env: Env, userId: string, token: string): Promise<boolean> {
  const res = await fetch(`${env.SUPABASE_URL}/rest/v1/mobile_devices?push_token=eq.${encodeURIComponent(token)}&select=user_id&order=push_at.desc.nullslast&limit=1`, { headers: service(env) });
  if (!res.ok) return false;
  const rows = await res.json() as { user_id: string }[];
  return rows[0]?.user_id === userId;
}

async function forget(env: Env, userId: string, deviceId: string): Promise<void> {
  await fetch(`${env.SUPABASE_URL}/rest/v1/mobile_devices?user_id=eq.${encodeURIComponent(userId)}&device_id=eq.${encodeURIComponent(deviceId)}`, {
    method: 'PATCH',
    headers: { ...service(env), Prefer: 'return=minimal' },
    body: JSON.stringify({ push_token: null }),
  }).catch(() => {});
}

export async function handle(req: Request, env: Env): Promise<Response> {
  if (req.method !== 'POST') return new Response('method not allowed', { status: 405 });
  if (!env.APNS_KEY || !env.APNS_KEY_ID || !env.APNS_TEAM_ID) return Response.json({ error: 'APNs is not configured' }, { status: 503 });
  const userId = await callerId(env, req);
  if (!userId) return Response.json({ error: 'sign in first' }, { status: 401 });
  const input = await req.json().catch(() => null) as Record<string, unknown> | null;
  const title = clip(input?.title, 120);
  if (!title) return Response.json({ error: 'title is required' }, { status: 400 });
  const body = clip(input?.body, 300);
  const threadId = clip(input?.threadId, 64);
  const tabId = clip(input?.tabId, 64);
  const kind = KINDS.has(String(input?.kind)) ? String(input?.kind) : 'done';

  const payload = JSON.stringify({
    aps: { alert: body ? { title, body } : { title }, sound: 'default', ...(threadId ? { 'thread-id': threadId } : {}) },
    ...(threadId ? { threadId } : {}),
    ...(tabId ? { tabId } : {}),
    kind,
  });
  const jwt = await providerToken(env);
  const topic = env.APNS_TOPIC || 'com.supreme.remote';
  let sent = 0;
  const devices = await devicesOf(env, userId);
  for (const device of devices) {
    if (!(await ownsToken(env, userId, device.push_token))) continue;
    const base = device.push_env === 'sandbox'
      ? (env.APNS_SANDBOX_BASE || 'https://api.sandbox.push.apple.com')
      : (env.APNS_BASE || 'https://api.push.apple.com');
    const res = await fetch(`${base}/3/device/${encodeURIComponent(device.push_token)}`, {
      method: 'POST',
      headers: {
        authorization: `bearer ${jwt}`,
        'apns-topic': topic,
        'apns-push-type': 'alert',
        'apns-priority': '10',
        ...(threadId && tabId ? { 'apns-collapse-id': clip(`${tabId}:${kind}`, 64) } : {}),
      },
      body: payload,
    }).catch(() => null);
    if (res?.ok) { sent += 1; continue; }
    const reason = res ? String((await res.json().catch(() => ({})) as { reason?: string }).reason || '') : '';
    if (res?.status === 410 || reason === 'BadDeviceToken' || reason === 'Unregistered') await forget(env, userId, device.device_id);
  }
  return Response.json({ sent, devices: devices.length });
}

const runtime = (globalThis as { Deno?: { serve: (fn: (req: Request) => Promise<Response>) => void; env: { toObject: () => Record<string, string> } } }).Deno;
if (runtime) runtime.serve((req) => handle(req, runtime.env.toObject() as unknown as Env));
