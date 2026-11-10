
type Env = {
  SUPABASE_URL: string;
  SUPABASE_SERVICE_ROLE_KEY: string;
  RESEND_API_KEY: string;
  RESEND_WEBHOOK_SECRET: string;
  RESEND_API_BASE?: string;
  INBOUND_DOMAIN?: string;
  SENDER_ALIASES?: string;
  DEAL_REPLY_SECRET?: string;
};

export function signInAddressFor(env: Env, address: string): string {
  for (const pair of String(env.SENDER_ALIASES || '').split(',')) {
    const [alias, account] = pair.split('=').map((part) => part.trim().toLowerCase());
    if (alias && account && alias === address) return account;
  }
  return address;
}

const TOLERANCE_S = 5 * 60;

function b64ToBytes(value: string): Uint8Array {
  const bin = atob(value);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i += 1) out[i] = bin.charCodeAt(i);
  return out;
}
function bytesToB64(bytes: ArrayBuffer): string {
  let bin = '';
  for (const byte of new Uint8Array(bytes)) bin += String.fromCharCode(byte);
  return btoa(bin);
}

// Resend signs with Svix: HMAC-SHA256 over "id.timestamp.body", keyed by the
// base64 part of the whsec_ secret; the header lists "v1,<sig>" entries.
export async function verifySignature(secret: string, headers: Headers, body: string, now = Date.now()): Promise<boolean> {
  const id = headers.get('svix-id') || '';
  const stamp = headers.get('svix-timestamp') || '';
  const signatures = headers.get('svix-signature') || '';
  if (!secret || !id || !stamp || !signatures) return false;
  const seconds = Number(stamp);
  if (!Number.isFinite(seconds) || Math.abs(now / 1000 - seconds) > TOLERANCE_S) return false;
  const key = await crypto.subtle.importKey('raw', b64ToBytes(secret.replace(/^whsec_/, '')), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const expected = bytesToB64(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(`${id}.${stamp}.${body}`)));
  return signatures.split(' ').some((entry) => entry.split(',')[1] === expected);
}

export function bareAddress(value: unknown): string {
  const text = String(Array.isArray(value) ? value[0] || '' : value || '');
  return (text.match(/<([^>]+)>/)?.[1] || text).trim().toLowerCase();
}

function headerValue(headers: unknown, name: string): string {
  if (!headers || typeof headers !== 'object') return '';
  for (const [key, value] of Object.entries(headers as Record<string, unknown>)) {
    if (key.toLowerCase() === name) return String(Array.isArray(value) ? value.join(' ') : value || '');
  }
  return '';
}

async function ownerOf(env: Env, address: string): Promise<string | null> {
  const auth = { apikey: env.SUPABASE_SERVICE_ROLE_KEY, Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}` };
  for (let page = 1; page <= 10; page += 1) {
    const response = await fetch(`${env.SUPABASE_URL}/auth/v1/admin/users?page=${page}&per_page=200`, { headers: auth });
    if (!response.ok) return null;
    const users = ((await response.json()) as { users?: { id: string; email?: string }[] }).users || [];
    const hit = users.find((user) => String(user.email || '').toLowerCase() === address);
    if (hit) return hit.id;
    if (users.length < 200) return null;
  }
  return null;
}

// The Resend key, the hook secret and the aliases live in Supabase Vault,
// read through public.inbound_email_config() (service role only), so no
// secret is set by hand; an env value, as in the smoke, wins.
async function withConfig(env: Env): Promise<Env> {
  if (env.RESEND_API_KEY && env.RESEND_WEBHOOK_SECRET) return env;
  const response = await fetch(`${env.SUPABASE_URL}/rest/v1/rpc/inbound_email_config`, {
    method: 'POST',
    headers: { apikey: env.SUPABASE_SERVICE_ROLE_KEY, Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`, 'Content-Type': 'application/json' },
    body: '{}',
  });
  if (!response.ok) return env;
  const row = (await response.json()) as { resend_api_key?: string; webhook_secret?: string; sender_aliases?: string };
  return { ...env, RESEND_API_KEY: env.RESEND_API_KEY || row.resend_api_key || '', RESEND_WEBHOOK_SECRET: env.RESEND_WEBHOOK_SECRET || row.webhook_secret || '', SENDER_ALIASES: env.SENDER_ALIASES || row.sender_aliases || '' };
}

// The addresses a person may be mailed at: their sign-in, and the aliases
// that stand for it.
export function ownAddresses(env: Env, signIn: string): string[] {
  const out = new Set([signIn.toLowerCase()]);
  for (const pair of String(env.SENDER_ALIASES || '').split(',')) {
    const [alias, account] = pair.split('=').map((part) => part.trim().toLowerCase());
    if (alias && account === signIn.toLowerCase()) out.add(alias);
  }
  return [...out].filter(Boolean);
}

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

export async function verifyDealSignature(secret: string, headers: Headers, body: string, now = Date.now()): Promise<boolean> {
  const stamp = headers.get('x-supreme-timestamp') || '';
  const given = (headers.get('x-supreme-signature') || '').replace(/^v1=/, '').trim().toLowerCase();
  if (!secret || !stamp || !/^[0-9a-f]{64}$/.test(given)) return false;
  const seconds = Number(stamp);
  if (!Number.isFinite(seconds) || Math.abs(now / 1000 - seconds) > TOLERANCE_S) return false;
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const mac = new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(`${stamp}.${body}`)));
  const expected = [...mac].map((byte) => byte.toString(16).padStart(2, '0')).join('');
  let diff = 0;
  for (let i = 0; i < expected.length; i += 1) diff |= expected.charCodeAt(i) ^ given.charCodeAt(i);
  return diff === 0;
}

const clip = (value: unknown, max: number) => String(value ?? '').slice(0, max);
const person = (value: unknown) => {
  const row = (value && typeof value === 'object' ? value : {}) as Record<string, unknown>;
  return { name: clip(row.name, 200), email: bareAddress(row.email) };
};
const addresses = (value: unknown) => (Array.isArray(value) ? value : []).slice(0, 40).map(bareAddress).filter(Boolean);

// Only the fields the Mac uses, each one bounded.
export function dealReplyFrom(payload: Record<string, unknown>): { reply: Record<string, unknown>; deal: Record<string, unknown>; dryRun: boolean } | null {
  const reply = (payload.reply && typeof payload.reply === 'object' ? payload.reply : null) as Record<string, unknown> | null;
  const deal = (payload.deal && typeof payload.deal === 'object' ? payload.deal : null) as Record<string, unknown> | null;
  if (!reply || !deal) return null;
  const mailbox = bareAddress(reply.mailbox);
  const messageId = clip(reply.gmail_message_id, 200).trim();
  const threadId = clip(reply.gmail_thread_id, 200).trim();
  const from = person(reply.from);
  if (!mailbox.includes('@') || !messageId || !threadId || !from.email || !String(reply.text || '').trim()) return null;
  const numbers: Record<string, string> = {};
  for (const [label, value] of Object.entries((deal.numbers && typeof deal.numbers === 'object' ? deal.numbers : {}) as Record<string, unknown>).slice(0, 40)) {
    if (value !== null && value !== undefined && String(value).trim()) numbers[clip(label, 80)] = clip(value, 200);
  }
  const broker = deal.broker && typeof deal.broker === 'object' ? deal.broker as Record<string, unknown> : null;
  return {
    reply: {
      mailbox,
      gmail_thread_id: threadId,
      gmail_message_id: messageId,
      rfc822_message_id: clip(reply.rfc822_message_id, 500) || null,
      subject: clip(reply.subject, 300),
      from,
      to: addresses(reply.to),
      cc: addresses(reply.cc),
      sent_at: clip(reply.sent_at, 40) || null,
      text: clip(reply.text, 20_000),
      sender_role: ['lender', 'broker'].includes(String(reply.sender_role)) ? String(reply.sender_role) : 'unknown',
      firm: reply.firm && typeof reply.firm === 'object' ? { id: clip((reply.firm as Record<string, unknown>).id, 200), name: clip((reply.firm as Record<string, unknown>).name, 200) } : null,
    },
    deal: {
      id: clip(deal.id, 200),
      name: clip(deal.name, 300),
      url: clip(deal.url, 1_000),
      room_url: clip(deal.room_url, 1_000),
      room_files: (Array.isArray(deal.room_files) ? deal.room_files : []).slice(0, 100).map((file) => {
        const row = (file && typeof file === 'object' ? file : { name: file }) as Record<string, unknown>;
        return { name: clip(row.name, 300), kind: clip(row.kind, 60) };
      }).filter((file) => file.name),
      numbers,
      broker: broker ? { ...person(broker), firm: clip(broker.firm, 200), gmail_thread_id: clip(broker.gmail_thread_id, 200) || null } : null,
    },
    dryRun: payload.dry_run === true,
  };
}

// Section 33: a deal reply, for the Supreme user the mailbox belongs to.
async function handleDealReply(env: Env, payload: Record<string, unknown>): Promise<Response> {
  const parsed = dealReplyFrom(payload);
  if (!parsed) return json(400, { error: 'a deal reply needs reply.mailbox, reply.gmail_thread_id, reply.gmail_message_id, reply.from.email, reply.text and a deal' });
  const { reply, deal, dryRun } = parsed;
  const owner = await ownerOf(env, signInAddressFor(env, String(reply.mailbox)));
  if (!owner) return json(200, { ok: true, stored: false, reason: 'no Supreme account for that mailbox' });
  const auth = { apikey: env.SUPABASE_SERVICE_ROLE_KEY, Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}` };
  const messageId = `gmail:${reply.gmail_message_id}`;
  const seen = await fetch(`${env.SUPABASE_URL}/rest/v1/inbound_emails?select=id&owner=eq.${owner}&message_id=eq.${encodeURIComponent(messageId)}&limit=1`, { headers: auth });
  if (seen.ok && ((await seen.json()) as unknown[]).length) return json(200, { ok: true, duplicate: true });
  const domain = (env.INBOUND_DOMAIN || 'in.example.com').toLowerCase();
  const from = reply.from as { email: string };
  const row = {
    owner,
    to_addr: `vime@${domain}`,
    from_addr: from.email,
    subject: String(reply.subject || deal.name || ''),
    text: String(reply.text || ''),
    message_id: messageId,
    in_reply_to: reply.rfc822_message_id || null,
    raw_headers: { kind: 'deal_reply', deal_reply: { reply, deal, dry_run: dryRun } },
  };
  const insert = await fetch(`${env.SUPABASE_URL}/rest/v1/inbound_emails`, {
    method: 'POST',
    headers: { ...auth, 'Content-Type': 'application/json', Prefer: 'return=minimal' },
    body: JSON.stringify(row),
  });
  if (!insert.ok) return json(500, { error: 'could not store' });
  return json(200, { ok: true, stored: true });
}

// A Mac's reply to a forward, sent from here so nobody keeps a mail key:
// signed in as the person (their Supabase access token), from
// <prefix>@in.example.com, and only ever to that person's own addresses.
async function handleSend(env: Env, token: string, mail: Record<string, unknown>): Promise<Response> {
  const who = await fetch(`${env.SUPABASE_URL}/auth/v1/user`, { headers: { apikey: env.SUPABASE_SERVICE_ROLE_KEY, Authorization: `Bearer ${token}` } });
  if (!who.ok) return json(401, { error: 'not signed in' });
  const user = (await who.json()) as { id?: string; email?: string };
  const signIn = String(user.email || '').toLowerCase();
  if (!user.id || !signIn) return json(401, { error: 'not signed in' });
  const domain = (env.INBOUND_DOMAIN || 'in.example.com').toLowerCase();
  const from = String(mail.from || '');
  const fromAddress = bareAddress(from);
  if (!new RegExp(`^[a-z0-9][a-z0-9._-]{0,63}@${domain.replace(/\./g, '\\.')}$`).test(fromAddress)) return json(400, { error: 'from must be a Supreme address' });
  const to = (Array.isArray(mail.to) ? mail.to : [mail.to]).map(bareAddress).filter(Boolean);
  const allowed = new Set(ownAddresses(env, signIn));
  if (!to.length || to.some((address) => !allowed.has(address))) return json(403, { error: 'Supreme only emails you' });
  const headers: Record<string, string> = {};
  const given = (mail.headers || {}) as Record<string, unknown>;
  for (const name of ['Message-ID', 'In-Reply-To', 'References']) if (given[name]) headers[name] = String(given[name]).slice(0, 2_000);
  const out = {
    from: `Supreme <${fromAddress}>`,
    to,
    subject: String(mail.subject || '').slice(0, 300),
    text: String(mail.text || '').slice(0, 50_000),
    ...(mail.html ? { html: String(mail.html).slice(0, 100_000) } : {}),
    headers,
  };
  const base = env.RESEND_API_BASE || 'https://api.resend.com';
  const sent = await fetch(`${base}/emails`, { method: 'POST', headers: { Authorization: `Bearer ${env.RESEND_API_KEY}`, 'Content-Type': 'application/json' }, body: JSON.stringify(out) });
  const result = (await sent.json().catch(() => ({}))) as { id?: string; message?: string };
  if (!sent.ok) return json(502, { error: result.message || `Resend said ${sent.status}` });
  return json(200, { ok: true, id: result.id || null });
}

export async function handle(req: Request, baseEnv: Env): Promise<Response> {
  if (req.method !== 'POST') return new Response('POST only', { status: 405 });
  const env = await withConfig(baseEnv);
  const body = await req.text();
  if (!req.headers.get('svix-id') && req.headers.get('x-supreme-signature')) {
    if (!(await verifyDealSignature(env.DEAL_REPLY_SECRET || '', req.headers, body))) return json(401, { error: 'bad signature' });
    let payload: Record<string, unknown> = {};
    try { payload = JSON.parse(body); } catch { return json(400, { error: 'bad json' }); }
    if (payload.action !== 'deal_reply') return json(400, { error: 'unknown action' });
    return handleDealReply(env, payload);
  }
  // A signed-in Mac sending a reply (no Svix headers; its own access token).
  if (!req.headers.get('svix-id')) {
    let asked: { action?: string; mail?: Record<string, unknown> } = {};
    try { asked = JSON.parse(body); } catch { /* falls through to the signature check */ }
    const token = String(req.headers.get('authorization') || '').replace(/^Bearer\s+/i, '');
    if (asked.action === 'send' && asked.mail && token) return handleSend(env, token, asked.mail);
  }
  if (!(await verifySignature(env.RESEND_WEBHOOK_SECRET, req.headers, body))) return new Response('bad signature', { status: 401 });
  let event: { type?: string; data?: Record<string, unknown> };
  try { event = JSON.parse(body); } catch { return new Response('bad json', { status: 400 }); }
  if (event.type !== 'email.received') return new Response('ignored', { status: 200 });
  const data = event.data || {};
  const emailId = String(data.email_id || data.id || '');
  // The hook carries the envelope; the body is read back from Resend.
  let email: Record<string, unknown> = data;
  if (emailId) {
    const base = env.RESEND_API_BASE || 'https://api.resend.com';
    const response = await fetch(`${base}/emails/receiving/${encodeURIComponent(emailId)}`, { headers: { Authorization: `Bearer ${env.RESEND_API_KEY}` } });
    if (response.ok) email = { ...data, ...((await response.json()) as Record<string, unknown>) };
  }
  const domain = (env.INBOUND_DOMAIN || 'in.example.com').toLowerCase();
  const toList = (Array.isArray(email.to) ? email.to : [email.to]).map(bareAddress);
  const to = toList.find((address) => address.endsWith(`@${domain}`)) || '';
  const from = bareAddress(email.from);
  if (!to || !from) return new Response('not for Supreme', { status: 200 });
  const owner = await ownerOf(env, signInAddressFor(env, from));
  // A stranger's mail is dropped quietly: a 200 so Resend does not retry it.
  if (!owner) return new Response('unknown sender', { status: 200 });
  const headers = email.headers || {};
  const row = {
    owner,
    to_addr: to,
    from_addr: from,
    subject: String(email.subject || ''),
    text: String(email.text || '').slice(0, 200_000),
    message_id: String(email.message_id || headerValue(headers, 'message-id') || '') || null,
    in_reply_to: headerValue(headers, 'in-reply-to') || null,
    raw_headers: { references: headerValue(headers, 'references'), resend_id: emailId },
  };
  const insert = await fetch(`${env.SUPABASE_URL}/rest/v1/inbound_emails`, {
    method: 'POST',
    headers: { apikey: env.SUPABASE_SERVICE_ROLE_KEY, Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`, 'Content-Type': 'application/json', Prefer: 'return=minimal' },
    body: JSON.stringify(row),
  });
  if (!insert.ok) return new Response('could not store', { status: 500 });
  return new Response('stored', { status: 200 });
}

const runtime = (globalThis as { Deno?: { serve: (fn: (req: Request) => Promise<Response>) => void; env: { toObject: () => Record<string, string> } } }).Deno;
if (runtime) runtime.serve((req) => handle(req, runtime.env.toObject() as unknown as Env));
