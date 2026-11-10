// Ephemeral credential handoff for cloud handoff (Phase B). Moves the user's CLI
// session tokens (~/.claude/.credentials.json, ~/.codex/auth.json) from the
// desktop to a throwaway cloud worker so it can run the agent as them — without
// any plaintext ever touching Supabase/the relay.
//
// Scheme (ECIES-style, zero-dep via node:crypto):
//   worker: generates an X25519 keypair, publishes the PUBLIC key.
//   desktop: makes an ephemeral X25519 keypair, ECDH with the worker's public key
//            -> HKDF-SHA256 -> AES-256-GCM, encrypts the creds, sends the envelope.
//   worker: ECDH with the ephemeral public key in the envelope -> same key ->
//           decrypts in memory. Only the worker's private key (held in RAM on the
//           throwaway machine) can open it.
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const INFO = Buffer.from('conductor-cred-handoff-v1');
const CRED_FILES = [
  ['claude', path.join('.claude', '.credentials.json')],
  ['codex', path.join('.codex', 'auth.json')],
];

function deriveKey(shared) {
  return Buffer.from(crypto.hkdfSync('sha256', shared, Buffer.alloc(0), INFO, 32));
}
function spkiB64(publicKey) {
  return publicKey.export({ type: 'spki', format: 'der' }).toString('base64');
}
function pubFromB64(b64) {
  return crypto.createPublicKey({ key: Buffer.from(b64, 'base64'), type: 'spki', format: 'der' });
}

// --- worker side ---
export function newKeypair() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('x25519');
  return { privateKey, publicKeyB64: spkiB64(publicKey) };
}

export function decrypt(privateKey, envelope) {
  const shared = crypto.diffieHellman({ privateKey, publicKey: pubFromB64(envelope.epk) });
  const key = deriveKey(shared);
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(envelope.iv, 'base64'));
  decipher.setAuthTag(Buffer.from(envelope.tag, 'base64'));
  const plain = Buffer.concat([decipher.update(Buffer.from(envelope.ct, 'base64')), decipher.final()]);
  return JSON.parse(plain.toString('utf8'));
}

// --- desktop side ---
export function encrypt(recipientPublicKeyB64, payload) {
  const eph = crypto.generateKeyPairSync('x25519');
  const shared = crypto.diffieHellman({ privateKey: eph.privateKey, publicKey: pubFromB64(recipientPublicKeyB64) });
  const key = deriveKey(shared);
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const ct = Buffer.concat([cipher.update(Buffer.from(JSON.stringify(payload), 'utf8')), cipher.final()]);
  return {
    epk: spkiB64(eph.publicKey),
    iv: iv.toString('base64'),
    ct: ct.toString('base64'),
    tag: cipher.getAuthTag().toString('base64'),
  };
}

// --- filesystem helpers ---
// Read the local model credentials to hand off (desktop side).
export function readLocalCreds(home = os.homedir()) {
  const out = {};
  for (const [name, rel] of CRED_FILES) {
    try { out[name] = fs.readFileSync(path.join(home, rel), 'utf8'); } catch { /* provider not signed in */ }
  }
  return out;
}

// Write received creds into the worker's (ephemeral, tmpfs) HOME so the CLIs find
// them. On a Fly Machine this filesystem is destroyed with the machine.
export function writeCreds(creds, home) {
  for (const [name, rel] of CRED_FILES) {
    if (creds[name] == null) continue;
    const dest = path.join(home, rel);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, creds[name], { mode: 0o600 });
  }
}

// Best-effort scrub of injected creds (called on flip-back before exit; the
// machine teardown is the real guarantee).
export function purgeCreds(home) {
  for (const [, rel] of CRED_FILES) {
    try { fs.rmSync(path.join(home, rel), { force: true }); } catch { /* ignore */ }
  }
}
