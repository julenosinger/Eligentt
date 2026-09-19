/**
 * Treasury Core API — Application Secret (Phase 2)
 * ═════════════════════════════════════════════════
 * Support for per-application secrets used by the (prepared, not-yet-enabled)
 * external auth schemes. The plaintext secret is NEVER stored or returned — only
 * a salted SHA-256 hash plus a short fingerprint are persisted.
 *
 * A secret record:
 *   { hash, salt, fingerprint, status, rotationDate, createdAt, updatedAt }
 *
 * Nothing here is activated in Phase 2; it exists so the Registry can carry
 * secret metadata and Phase 3 can verify credentials without schema changes.
 */

function toHex(buf) {
  return Array.from(new Uint8Array(buf), b => b.toString(16).padStart(2, '0')).join('');
}

function randomHex(bytes) {
  const a = new Uint8Array(bytes);
  crypto.getRandomValues(a);
  return toHex(a);
}

async function sha256Hex(input) {
  const data = new TextEncoder().encode(input);
  const digest = await crypto.subtle.digest('SHA-256', data);
  return toHex(digest);
}

// Deterministic, non-reversible fingerprint of the secret's hash (safe to show).
export function fingerprintOf(hashHex) {
  if (!hashHex || typeof hashHex !== 'string') return null;
  return 'fp_' + hashHex.slice(0, 8) + '…' + hashHex.slice(-4);
}

/**
 * Create a secret record from a plaintext secret. The plaintext is consumed here
 * and never leaves this function.
 */
export async function createSecretRecord(secret, opts) {
  if (typeof secret !== 'string' || secret.length < 8) {
    throw new Error('secret must be a string of at least 8 characters');
  }
  const o = opts || {};
  const salt = randomHex(16);
  const hash = await sha256Hex(salt + ':' + secret);
  const now = new Date().toISOString();
  return {
    hash,
    salt,
    fingerprint: fingerprintOf(hash),
    status: o.status || 'active',
    rotationDate: o.rotationDate || null,
    createdAt: now,
    updatedAt: now,
  };
}

/**
 * Verify a presented secret against a stored record. Constant-ish comparison via
 * hash equality. Returns false on any malformed input (fails closed).
 */
export async function verifySecret(secret, record) {
  if (!record || typeof record.hash !== 'string' || typeof record.salt !== 'string') return false;
  if (typeof secret !== 'string' || secret.length === 0) return false;
  if (record.status && record.status !== 'active') return false;
  const candidate = await sha256Hex(record.salt + ':' + secret);
  if (candidate.length !== record.hash.length) return false;
  let diff = 0;
  for (let i = 0; i < candidate.length; i++) diff |= candidate.charCodeAt(i) ^ record.hash.charCodeAt(i);
  return diff === 0;
}

/**
 * Public projection of a secret record — the hash, salt and any sealed material
 * are stripped; only the fingerprint/status/dates are exposed. Used everywhere a
 * secret record could be serialized into a response.
 */
export function publicSecretView(record) {
  if (!record) return null;
  return {
    fingerprint: record.fingerprint || (record.hash ? fingerprintOf(record.hash) : null),
    status: record.status || 'active',
    rotationDate: record.rotationDate || null,
    lastRotation: record.lastRotation || null,
    hasPrevious: !!(record.previous && (record.previous.sealed || record.previous.hash)),
    createdAt: record.createdAt || null,
    updatedAt: record.updatedAt || null,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// SERVICE SECRETS (Phase 4) — sealed at rest for HMAC request signing.
//
// HMAC verification requires the shared secret, so it CANNOT be a one-way hash.
// The secret is therefore ENCRYPTED at rest (AES-256-GCM) with a master key from
// the environment (CORE_SECRET_KEY). Plaintext is never persisted or returned.
// A non-reversible fingerprint is stored alongside for display/identification.
// ─────────────────────────────────────────────────────────────────────────────

function hexToBytes(hex) {
  const clean = hex.replace(/^0x/, '');
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(clean.substr(i * 2, 2), 16);
  return out;
}

async function deriveAesKey(master) {
  if (!master || typeof master !== 'string') throw new Error('CORE_SECRET_KEY (master key) is required for sealed secrets');
  let raw;
  if (/^(0x)?[0-9a-fA-F]{64}$/.test(master)) {
    raw = hexToBytes(master);
  } else {
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(master));
    raw = new Uint8Array(digest);
  }
  return crypto.subtle.importKey('raw', raw, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
}

/**
 * Seal a plaintext service secret. Returns a record with ciphertext + iv +
 * fingerprint — never the plaintext.
 */
export async function sealSecret(secret, master, opts) {
  if (typeof secret !== 'string' || secret.length < 8) throw new Error('secret must be a string of at least 8 characters');
  const key = await deriveAesKey(master);
  const iv = new Uint8Array(12);
  crypto.getRandomValues(iv);
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, new TextEncoder().encode(secret));
  const hash = await sha256Hex(secret);
  const now = new Date().toISOString();
  const o = opts || {};
  return {
    alg: 'AES-256-GCM',
    iv: toHex(iv),
    ciphertext: toHex(new Uint8Array(ct)),
    fingerprint: fingerprintOf(hash),
    status: o.status || 'active',
    rotationDate: o.rotationDate || null,
    lastRotation: o.lastRotation || null,
    createdAt: now,
    updatedAt: now,
  };
}

/** Open (decrypt) a sealed secret record back to plaintext (server-side only). */
export async function openSecret(record, master) {
  if (!record || !record.ciphertext || !record.iv) return null;
  try {
    const key = await deriveAesKey(master);
    const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: hexToBytes(record.iv) }, key, hexToBytes(record.ciphertext));
    return new TextDecoder().decode(pt);
  } catch (_) { return null; }
}

/**
 * Rotate a service secret without downtime: the current sealed secret becomes
 * `previous` (kept until now + gracePeriodMs), and the new one becomes current.
 */
export async function rotateServiceSecret(currentRecord, newSecret, master, opts) {
  const o = opts || {};
  const graceMs = o.gracePeriodMs != null ? o.gracePeriodMs : 24 * 60 * 60 * 1000; // 24h default
  const now = Date.now();
  const fresh = await sealSecret(newSecret, master, { status: 'active' });
  fresh.lastRotation = new Date(now).toISOString();
  if (currentRecord && (currentRecord.ciphertext || currentRecord.sealed)) {
    fresh.previous = {
      alg: currentRecord.alg,
      iv: currentRecord.iv,
      ciphertext: currentRecord.ciphertext,
      fingerprint: currentRecord.fingerprint,
      expiresAt: now + graceMs,
    };
  }
  return fresh;
}

/**
 * Compute an HMAC-SHA256 (hex) of `message` using `secretPlaintext`.
 */
export async function hmacSha256Hex(secretPlaintext, message) {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secretPlaintext), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(message));
  return toHex(new Uint8Array(sig));
}

// Constant-time-ish hex string comparison.
export function timingSafeEqualHex(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
