/**
 * coordinator-util.js — server-side canonical hashing helpers for the
 * GatewayExecutionCoordinator Durable Object.
 *
 * Phase 1.0.1C (isolated development — NOT active in production).
 *
 * PURPOSE
 *   The per-salt GatewayOpLock deduplicates only the SAME salt. Two concurrent
 *   submissions of the SAME financial intent (same depositor, token, value,
 *   recipient, domains) with DIFFERENT salts would each reserve successfully and
 *   both be forwarded — a cross-salt double-submission.
 *
 *   The GatewayExecutionCoordinator closes that gap by deduplicating on a
 *   server-side canonical fingerprint that does NOT include the salt. This module
 *   is the single source of truth for that fingerprint.
 *
 * TWO-LEVEL IDENTITY (both computed server-side, deterministic, salt-independent)
 *   1. canonicalPayloadHash(burnIntent)
 *        SHA-256 of the FULL immutable financial terms:
 *          maxBlockHeight, maxFee, and every spec field EXCEPT `salt`
 *          (version, sourceDomain, destinationDomain, sourceContract,
 *           destinationContract, sourceToken, destinationToken, sourceDepositor,
 *           destinationRecipient, sourceSigner, destinationCaller, value, hookData).
 *        Two intents with the same fingerprint are the SAME financial operation
 *        regardless of salt.
 *
 *   2. idempotencyKeyFor(burnIntent)
 *        SHA-256 of the COARSE financial identity ("payment slot"):
 *          sourceDepositor, sourceDomain, destinationDomain, sourceToken,
 *          destinationToken, destinationRecipient.
 *        A depositor has ONE in-flight slot per (from-domain, to-domain,
 *        token-pair, recipient). Two genuinely-independent payments (different
 *        recipient, different chain, different token) map to DIFFERENT slots and
 *        are never conflated.
 *
 *   Dedup semantics (enforced by the DO, keyed by depositor:environment):
 *     same key + same hash          → RECOVER existing operation (duplicate)
 *     same key + different hash     → CONFLICT (slot reused with mutated terms)
 *     terminal record under the key → allow a NEW operation (slot freed)
 *
 * ENVIRONMENT DETECTION
 *   environmentFor(burnIntent) derives `mainnet` | `testnet` from
 *   spec.sourceContract (the GatewayWallet bytes32). The mainnet and testnet
 *   GatewayWallet deployments have DIFFERENT addresses (see constants below,
 *   sourced from Circle's published contract addresses). An UNKNOWN sourceContract
 *   returns `null` so the caller fails closed (never coordinates an unrecognized
 *   environment).
 *
 * SECURITY / PORTABILITY
 *   - Uses `crypto.subtle.digest('SHA-256', …)` — available in both Cloudflare
 *     Workers and Node 18+ (Vitest). No Node-only imports.
 *   - Never stores or returns private keys, signatures, or attestation payloads.
 *   - `canon` normalizes BigInt/Number/hex so the hash is stable across JSON
 *     round-trips and casing.
 */

// ── GatewayWallet addresses (sourceContract) ─────────────────────────────────
// Mainnet (Circle official, Oct 2026): 0x77777777Dcc4d5A8B6E418Fd04D8997ef11000eE
// Testnet  (Circle official, Oct 2026): 0x0077777d7EBA4688BDeF3E311b846F25870A19B9
export const MAINNET_GATEWAY_WALLET = '0x77777777dcc4d5a8b6e418fd04d8997ef11000ee';
export const TESTNET_GATEWAY_WALLET  = '0x0077777d7eba4688bdef3e311b846f25870a19b9';

export const ENV_MAINNET = 'mainnet';
export const ENV_TESTNET = 'testnet';

// ── Canonical value normalization ────────────────────────────────────────────
// BigInt → decimal string, Number → string, hex/address → lowercase. Stable and
// deterministic regardless of input casing or JSON serialization.
export function canon(v) {
  if (v == null) return '';
  if (typeof v === 'bigint') return v.toString();
  if (typeof v === 'number') return String(v);
  return String(v).toLowerCase();
}

// ── bytes32 helpers ──────────────────────────────────────────────────────────
// A bytes32 field is 64 hex chars; the 20-byte EVM address is the low 40 chars.
export function unpadAddress(bytes32) {
  if (typeof bytes32 !== 'string') return null;
  const raw = bytes32.replace(/^0x/, '');
  if (!/^[0-9a-fA-F]{64}$/.test(raw)) return null;
  return '0x' + raw.slice(-40).toLowerCase();
}

export function padAddress(addr) {
  const raw = String(addr || '').toLowerCase().replace(/^0x/, '');
  return '0x' + raw.padStart(64, '0');
}

// ── SHA-256 (hex) ────────────────────────────────────────────────────────────
async function sha256Hex(input) {
  const data = new TextEncoder().encode(input);
  const digest = await crypto.subtle.digest('SHA-256', data);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

// ── Full-payload fingerprint (excludes salt) ─────────────────────────────────
const PAYLOAD_FIELDS = [
  ['maxBlockHeight', (bi) => bi.maxBlockHeight],
  ['maxFee',         (bi) => bi.maxFee],
  ['version',               (bi) => bi.spec.version],
  ['sourceDomain',          (bi) => bi.spec.sourceDomain],
  ['destinationDomain',     (bi) => bi.spec.destinationDomain],
  ['sourceContract',        (bi) => bi.spec.sourceContract],
  ['destinationContract',   (bi) => bi.spec.destinationContract],
  ['sourceToken',           (bi) => bi.spec.sourceToken],
  ['destinationToken',      (bi) => bi.spec.destinationToken],
  ['sourceDepositor',       (bi) => bi.spec.sourceDepositor],
  ['destinationRecipient',  (bi) => bi.spec.destinationRecipient],
  ['sourceSigner',          (bi) => bi.spec.sourceSigner],
  ['destinationCaller',     (bi) => bi.spec.destinationCaller],
  ['value',                 (bi) => bi.spec.value],
  ['hookData',              (bi) => bi.spec.hookData],
];

/**
 * SHA-256 of the full immutable financial terms, EXCLUDING `spec.salt`.
 * Two intents with the same hash are the same financial operation regardless of
 * salt. Returns a 64-char lowercase hex digest.
 */
export async function canonicalPayloadHash(burnIntent) {
  const parts = PAYLOAD_FIELDS.map(([name, get]) => name + '=' + canon(get(burnIntent)));
  return sha256Hex(parts.join('|'));
}

// ── Coarse identity ("payment slot") key ─────────────────────────────────────
const IDENTITY_FIELDS = [
  ['sourceDepositor',      (bi) => bi.spec.sourceDepositor],
  ['sourceDomain',         (bi) => bi.spec.sourceDomain],
  ['destinationDomain',    (bi) => bi.spec.destinationDomain],
  ['sourceToken',          (bi) => bi.spec.sourceToken],
  ['destinationToken',     (bi) => bi.spec.destinationToken],
  ['destinationRecipient', (bi) => bi.spec.destinationRecipient],
];

/**
 * Stable idempotency key per financial intent (salt-independent). Coarser than
 * `canonicalPayloadHash`: it identifies the "payment slot" so a depositor cannot
 * hold two conflicting in-flight intents in the same slot. Returns `gw:` + 64 hex.
 */
export async function idempotencyKeyFor(burnIntent) {
  const parts = IDENTITY_FIELDS.map(([name, get]) => name + '=' + canon(get(burnIntent)));
  return 'gw:' + (await sha256Hex(parts.join('|')));
}

// ── Depositor + environment ──────────────────────────────────────────────────
/**
 * The 20-byte depositor address (unpadded sourceDepositor), lowercase.
 * Returns null when the bytes32 field is malformed.
 */
export function depositorOf(burnIntent) {
  if (!burnIntent || !burnIntent.spec) return null;
  return unpadAddress(burnIntent.spec.sourceDepositor);
}

/**
 * `mainnet` | `testnet` | `null` — derived from spec.sourceContract
 * (the GatewayWallet). `null` means the wallet is not a recognized GatewayWallet,
 * and callers MUST fail closed.
 */
export function environmentFor(burnIntent) {
  if (!burnIntent || !burnIntent.spec) return null;
  const wallet = unpadAddress(burnIntent.spec.sourceContract);
  if (wallet === MAINNET_GATEWAY_WALLET) return ENV_MAINNET;
  if (wallet === TESTNET_GATEWAY_WALLET)  return ENV_TESTNET;
  return null;
}
