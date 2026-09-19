/**
 * Treasury Core API — Application Registry (Phase 2)
 * ═══════════════════════════════════════════════════
 * Internal registry describing each application that may consume the Treasury
 * Core. It is PREPARED in this phase (only ELLIGENT is active; EXECDAAT is seeded
 * as "prepared" for Phase 3). A registered application record:
 *
 *   { applicationId, displayName, status, environment, createdAt, updatedAt,
 *     permissions, rateLimits, authMode, version, secret? }
 *
 * The registry is a KV overlay on top of built-in defaults: seeds always exist
 * even with no KV, and KV records (Phase 3) take precedence. Secrets are stored
 * ONLY as hashed records (see application-secret.mjs) and are never returned in
 * plaintext.
 */
import { coreKv, kvGetJSON, kvPutJSON, kvListJSON, REGISTRY_PREFIX } from './store.mjs';
import { publicSecretView } from './application-secret.mjs';

export const APP_STATUS = Object.freeze({ ACTIVE: 'active', PREPARED: 'prepared', SUSPENDED: 'suspended' });
export const AUTH_MODES = Object.freeze(['internal', 'apikey', 'jwt', 'hmac', 'mtls', 'bearer']);

export const DEFAULT_PERMISSIONS = Object.freeze(['intents:create', 'intents:read', 'quote:read', 'history:read', 'metrics:read', 'health:read']);
export const CORE_PERMISSIONS = Object.freeze([...DEFAULT_PERMISSIONS, 'execute:write', 'registry:admin']);

export const DEFAULT_RATE_LIMITS = Object.freeze({ requestsPerMin: 120, intentsPerMin: 30, bridgePerMin: 10 });

const _EPOCH = '2026-01-01T00:00:00.000Z';

// Built-in seeds. ELLIGENT is the core operator (active/internal). EXECDAAT is
// prepared but NOT active — it cannot be authenticated until Phase 3 enables it.
const SEED = {
  ELLIGENT: {
    applicationId: 'ELLIGENT',
    displayName: 'Elligent',
    status: APP_STATUS.ACTIVE,
    environment: 'production',
    createdAt: _EPOCH,
    updatedAt: _EPOCH,
    permissions: [...CORE_PERMISSIONS],
    rateLimits: { requestsPerMin: 600, intentsPerMin: 120, bridgePerMin: 60 },
    authMode: 'internal',
    version: '1',
    core: true,
    allowedOrigins: ['https://elligentt.xyz', 'https://elligente.pages.dev'],
    allowedIps: [],
    lastRotation: null,
    secret: null,
  },
  EXECDAAT: {
    applicationId: 'EXECDAAT',
    displayName: 'ExecDaat',
    status: APP_STATUS.ACTIVE,
    environment: 'production',
    createdAt: _EPOCH,
    updatedAt: '2026-07-05T00:00:00.000Z',
    permissions: ['quote:read', 'intents:create', 'intents:read', 'execute:write', 'history:read', 'metrics:read', 'health:read'],
    rateLimits: { requestsPerMin: 300, intentsPerMin: 60, quotePerMin: 120, bridgePerMin: 30, historyPerMin: 120, metricsPerMin: 60, healthPerMin: 120 },
    authMode: 'hmac',
    version: 'v1',
    core: false,
    allowedOrigins: ['https://execdaat.xyz', 'https://elligentt.xyz'],
    allowedIps: [],
    lastRotation: '2026-07-05T00:00:00.000Z',
    // Secret lives ONLY as a Cloudflare Secret (EXECDAAT_APP_SECRET). We store just
    // its non-reversible fingerprint here for display/audit — never the secret.
    secret: {
      source: 'cloudflare_secret',
      envVar: 'EXECDAAT_APP_SECRET',
      fingerprint: 'fp_a63d8098\u2026b23a',
      status: 'active',
      rotationDate: null,
      lastRotation: '2026-07-05T00:00:00.000Z',
    },
  },
  FUTURE_APP: {
    applicationId: 'FUTURE_APP',
    displayName: 'Future Apps',
    status: APP_STATUS.PREPARED,
    environment: 'production',
    createdAt: _EPOCH,
    updatedAt: _EPOCH,
    permissions: [...DEFAULT_PERMISSIONS],
    rateLimits: { ...DEFAULT_RATE_LIMITS },
    authMode: 'apikey',
    version: '1',
    core: false,
    allowedOrigins: [],
    allowedIps: [],
    lastRotation: null,
    secret: null,
  },
};

function normalizeId(id) {
  return String(id || '').trim().toUpperCase().replace(/[^A-Z0-9_]/g, '').slice(0, 32);
}

function seedFor(id) {
  const key = normalizeId(id);
  if (SEED[key]) return { ...SEED[key], permissions: [...SEED[key].permissions], rateLimits: { ...SEED[key].rateLimits } };
  // Unknown application → a conservative, PREPARED default (never active).
  return {
    applicationId: key || 'UNKNOWN',
    displayName: key || 'Unknown',
    status: APP_STATUS.PREPARED,
    environment: 'production',
    createdAt: _EPOCH,
    updatedAt: _EPOCH,
    permissions: [...DEFAULT_PERMISSIONS],
    rateLimits: { ...DEFAULT_RATE_LIMITS },
    authMode: 'apikey',
    version: '1',
    core: false,
    allowedOrigins: [],
    allowedIps: [],
    lastRotation: null,
    secret: null,
  };
}

// Public projection: strips the raw secret record down to its safe view.
export function publicApplication(record) {
  if (!record) return null;
  return { ...record, secret: publicSecretView(record.secret) };
}

/**
 * Resolve an application record: KV overlay on top of the built-in seed.
 */
export async function getApplication(env, id) {
  const key = normalizeId(id);
  const stored = await kvGetJSON(coreKv(env), REGISTRY_PREFIX + key);
  const base = seedFor(key);
  return stored ? { ...base, ...stored } : base;
}

/**
 * List all applications (seeds merged with any KV records).
 */
export async function listApplications(env) {
  const stored = await kvListJSON(coreKv(env), REGISTRY_PREFIX);
  const byId = {};
  for (const id of Object.keys(SEED)) byId[id] = seedFor(id);
  for (const rec of stored) {
    const id = normalizeId(rec.applicationId);
    byId[id] = { ...(byId[id] || seedFor(id)), ...rec };
  }
  return Object.values(byId);
}

/**
 * Register (or overwrite) an application record. PREPARED-only in this phase —
 * persistence requires a KV binding. Returns the public projection.
 */
export async function registerApplication(env, input) {
  const id = normalizeId(input && input.applicationId);
  if (!id) throw new Error('applicationId required');
  const base = seedFor(id);
  const now = new Date().toISOString();
  const record = {
    ...base,
    applicationId: id,
    displayName: input.displayName || base.displayName,
    status: APP_STATUS[String(input.status || '').toUpperCase()] || base.status,
    environment: input.environment || base.environment,
    permissions: Array.isArray(input.permissions) ? input.permissions : base.permissions,
    rateLimits: { ...base.rateLimits, ...(input.rateLimits || {}) },
    authMode: AUTH_MODES.includes(input.authMode) ? input.authMode : base.authMode,
    version: input.version ? String(input.version) : base.version,
    allowedOrigins: Array.isArray(input.allowedOrigins) ? input.allowedOrigins : base.allowedOrigins,
    allowedIps: Array.isArray(input.allowedIps) ? input.allowedIps : base.allowedIps,
    secret: input.secret || base.secret,
    lastRotation: input.lastRotation || base.lastRotation,
    createdAt: base.createdAt || now,
    updatedAt: now,
  };
  await kvPutJSON(coreKv(env), REGISTRY_PREFIX + id, record);
  return publicApplication(record);
}

export async function updateApplication(env, id, patch) {
  const existing = await getApplication(env, id);
  const updated = { ...existing, ...(patch || {}), applicationId: existing.applicationId, updatedAt: new Date().toISOString() };
  await kvPutJSON(coreKv(env), REGISTRY_PREFIX + normalizeId(id), updated);
  return publicApplication(updated);
}

/**
 * Persist a rotated secret record (current + previous within grace) for an
 * application. Stores ONLY sealed material; returns the public projection.
 */
export async function setApplicationSecret(env, id, secretRecord) {
  const existing = await getApplication(env, id);
  const updated = {
    ...existing,
    secret: secretRecord,
    lastRotation: (secretRecord && secretRecord.lastRotation) || new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  await kvPutJSON(coreKv(env), REGISTRY_PREFIX + normalizeId(id), updated);
  return publicApplication(updated);
}
