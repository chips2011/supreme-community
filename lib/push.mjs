// Web Push without dependencies: VAPID (RFC 8292) + aes128gcm payload
// encryption (RFC 8291) via node:crypto. Keys and subscriptions persist in
// DATA_DIR/push.json so notifications survive restarts. Send failures are
// swallowed — a push is never allowed to break a run.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR } from './store.mjs';

const PUSH_FILE = path.join(DATA_DIR, 'push.json');
const VAPID_SUBJECT = process.env.VAPID_SUBJECT || 'mailto:admin@example.com';

function b64u(buf) {
  return Buffer.from(buf).toString('base64url');
}

function readState() {
  try {
    return JSON.parse(fs.readFileSync(PUSH_FILE, 'utf8'));
  } catch {
    return { vapid: null, subscriptions: [] };
  }
}

function writeState(state) {
  fs.mkdirSync(path.dirname(PUSH_FILE), { recursive: true });
  const tmp = PUSH_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2));
  fs.renameSync(tmp, PUSH_FILE);
}

function ensureVapid(state) {
  if (state.vapid?.publicJwk && state.vapid?.privateJwk) return state.vapid;
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  state.vapid = {
    publicJwk: publicKey.export({ format: 'jwk' }),
    privateJwk: privateKey.export({ format: 'jwk' }),
  };
  writeState(state);
  return state.vapid;
}

// Uncompressed P-256 point (65 bytes, 0x04 || x || y) — the applicationServerKey
// format the browser's pushManager.subscribe expects.
function vapidPublicKey(vapid) {
  return b64u(Buffer.concat([
    Buffer.from([4]),
    Buffer.from(vapid.publicJwk.x, 'base64url'),
    Buffer.from(vapid.publicJwk.y, 'base64url'),
  ]));
}

export function pushPublicKey() {
  const state = readState();
  return vapidPublicKey(ensureVapid(state));
}

export function pushCount() {
  return readState().subscriptions.length;
}

export function pushSubscribe(sub) {
  if (!sub?.endpoint || !sub?.keys?.p256dh || !sub?.keys?.auth) throw new Error('invalid subscription');
  let endpoint;
  try { endpoint = new URL(sub.endpoint); } catch { throw new Error('invalid subscription'); }
  if (endpoint.protocol !== 'https:') throw new Error('invalid subscription');
  const state = readState();
  state.subscriptions = state.subscriptions.filter((s) => s.endpoint !== sub.endpoint);
  state.subscriptions.push({ endpoint: sub.endpoint, keys: { p256dh: sub.keys.p256dh, auth: sub.keys.auth }, addedAt: new Date().toISOString() });
  writeState(state);
  return state.subscriptions.length;
}

export function pushUnsubscribe(endpoint) {
  const state = readState();
  state.subscriptions = state.subscriptions.filter((s) => s.endpoint !== endpoint);
  writeState(state);
  return state.subscriptions.length;
}

// RFC 8291 aes128gcm: ECDH over P-256 with the subscription keys, HKDF to a
// content key + nonce, single record with 0x02 delimiter (last record).
export function encryptPayload(payload, keys) {
  const clientPub = Buffer.from(keys.p256dh, 'base64url');
  const authSecret = Buffer.from(keys.auth, 'base64url');
  const local = crypto.createECDH('prime256v1');
  local.generateKeys();
  const localPub = local.getPublicKey();
  const shared = local.computeSecret(clientPub);
  const ikm = Buffer.from(crypto.hkdfSync('sha256', shared, authSecret,
    Buffer.concat([Buffer.from('WebPush: info\0'), clientPub, localPub]), 32));
  const salt = crypto.randomBytes(16);
  const cek = Buffer.from(crypto.hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: aes128gcm\0'), 16));
  const nonce = Buffer.from(crypto.hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: nonce\0'), 12));
  const cipher = crypto.createCipheriv('aes-128-gcm', cek, nonce);
  const sealed = Buffer.concat([cipher.update(Buffer.concat([Buffer.from(payload), Buffer.from([2])])), cipher.final(), cipher.getAuthTag()]);
  const recordSize = Buffer.alloc(4);
  recordSize.writeUInt32BE(4096);
  return Buffer.concat([salt, recordSize, Buffer.from([localPub.length]), localPub, sealed]);
}

function vapidAuthHeader(endpoint, vapid) {
  const token = [
    b64u(JSON.stringify({ typ: 'JWT', alg: 'ES256' })),
    b64u(JSON.stringify({ aud: new URL(endpoint).origin, exp: Math.floor(Date.now() / 1000) + 12 * 3600, sub: VAPID_SUBJECT })),
  ].join('.');
  const key = crypto.createPrivateKey({ key: vapid.privateJwk, format: 'jwk' });
  const sig = crypto.sign('sha256', Buffer.from(token), { key, dsaEncoding: 'ieee-p1363' });
  return `vapid t=${token}.${b64u(sig)}, k=${vapidPublicKey(vapid)}`;
}

async function sendOne(sub, body, vapid) {
  const res = await fetch(sub.endpoint, {
    method: 'POST',
    headers: {
      Authorization: vapidAuthHeader(sub.endpoint, vapid),
      'Content-Encoding': 'aes128gcm',
      'Content-Type': 'application/octet-stream',
      TTL: '86400',
      Urgency: 'normal',
    },
    body: encryptPayload(body, sub.keys),
    signal: AbortSignal.timeout(15_000),
  });
  // The push service says this subscription is dead — stop paying for it.
  if (res.status === 404 || res.status === 410) pushUnsubscribe(sub.endpoint);
  return res.status;
}

// Fire-and-forget fan-out to every registered device. Never throws.
export function pushNotify({ title, body = '', tag = 'workbench', url = '/?view=remote' }) {
  try {
    const state = readState();
    if (!state.subscriptions.length) return;
    const vapid = ensureVapid(state);
    const payload = JSON.stringify({ title: String(title || 'Workbench').slice(0, 120), body: String(body).slice(0, 240), tag, url });
    for (const sub of state.subscriptions) {
      sendOne(sub, payload, vapid).catch(() => {});
    }
  } catch {}
}
