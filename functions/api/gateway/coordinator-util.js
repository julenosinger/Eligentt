/**
 * coordinator-util.js — server-side canonical helpers for the
 * GatewayExecutionCoordinator Durable Object.
 *
 * Phase 1.0.1C.1 (isolated development — NOT active in production).
 *
 * PURPOSE
 *   The per-salt GatewayOpLock deduplicates only the SAME salt. The
 *   GatewayExecutionCoordinator adds cross-salt dedup and quantitative balance
 *   reservation, keyed by (depositor, environment).
 *
 * IDENTITY MODEL (Phase 1.0.1C.1 — corrected)
 *   The idempotency key is a CALLER-PROVIDED, explicit, stable identifier — it is
 *   NOT derived from payment characteristics. Deriving it from the payment "slot"
 *   (depositor + domains + token + recipient) conflates two independent payments
 *   that happen to share the same recipient/network/asset/amount. Instead:
 *
 *     idempotencyKey  — caller-generated once per logical intent, reused across
 *                       retries/recovery (even with different salts). This is the
 *                       dedup key: same key + same payload → recover; same key +
 *                       different payload → conflict; new key → independent.
 *
 *     payloadHash     — SHA-256 of the full immutable financial terms EXCLUDING
 *                       `salt`, computed server-side. It is the conflict-detection
 *                       fingerprint (detects a key reused with mutated terms). It
 *                       is NOT used as a dedup key on its own (that would conflate
 *                       independent identical payments).
 *
 *   Two independent payments to the same recipient with the same amount MUST use
 *   two different idempotency keys; a retry of the same intent MUST reuse its key.
 *   This is the caller's contract, and it is what keeps "same intent across
 *   modules/refresh/retry" distinct from "a new explicitly-authorized intent".
 *
 * BALANCE SCOPE
 *   Circle Gateway balance is per (token, domain, depositor). A transfer debits the
 *   balance of its source token on its source domain. `scopeKeyFor` derives the
 *   balance scope `sourceToken:sourceDomain` (lowercased, unpadded) used by the DO's
 *   quantitative reservation. `tokenSymbolFor` maps a known Circle token address to
 *   its symbol (for the server-side balance fetch against /v1/balances).
 *
 * ENVIRONMENT DETECTION
 *   `environmentFor` derives `mainnet` | `testnet` from spec.sourceContract (the
 *   GatewayWallet bytes32). Mainnet and testnet GatewayWallet deployments have
 *   DIFFERENT addresses. An UNKNOWN sourceContract returns `null` → caller fails
 *   closed.
 */

// ── GatewayWallet addresses (sourceContract) ─────────────────────────────────
// Mainnet (Circle official, Oct 2026): 0x77777777Dcc4d5A8B6E418Fd04D8997ef11000eE
// Testnet  (Circle official, Oct 2026): 0x0077777d7EBA4688BDeF3E311b846F25870A19B9
export const MAINNET_GATEWAY_WALLET = '0x77777777dcc4d5a8b6e418fd04d8997ef11000ee';
export const TESTNET_GATEWAY_WALLET  = '0x0077777d7eba4688bdef3e311b846f25870a19b9';

export const ENV_MAINNET = 'mainnet';
export const ENV_TESTNET = 'testnet';

// ── Idempotency key format (caller-provided) ────────────────────────────────
// Printable, no whitespace/control chars, bounded length — mirrors the x402
// idempotency-key contract. The caller generates it once per logical intent.
export const IDEMPOTENCY_KEY_RE = /^[A-Za-z0-9._-]{8,128}$/;

export function isValidIdempotencyKey(key) {
  return typeof key === 'string' && IDEMPOTENCY_KEY_RE.test(key);
}

// ── Canonical value normalization ────────────────────────────────────────────
export function canon(v) {
  if (v == null) return '';
  if (typeof v === 'bigint') return v.toString();
  if (typeof v === 'number') return String(v);
  return String(v).toLowerCase();
}

// ── bytes32 helpers ──────────────────────────────────────────────────────────
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
 * salt. Used for conflict detection (same idempotency key + mutated terms).
 */
export async function canonicalPayloadHash(burnIntent) {
  const parts = PAYLOAD_FIELDS.map(([name, get]) => name + '=' + canon(get(burnIntent)));
  return sha256Hex(parts.join('|'));
}

// ── Depositor + environment + balance scope ──────────────────────────────────
export function depositorOf(burnIntent) {
  if (!burnIntent || !burnIntent.spec) return null;
  return unpadAddress(burnIntent.spec.sourceDepositor);
}

export function environmentFor(burnIntent) {
  if (!burnIntent || !burnIntent.spec) return null;
  const wallet = unpadAddress(burnIntent.spec.sourceContract);
  if (wallet === MAINNET_GATEWAY_WALLET) return ENV_MAINNET;
  if (wallet === TESTNET_GATEWAY_WALLET)  return ENV_TESTNET;
  return null;
}

/**
 * Balance scope key for the quantitative reservation: `sourceToken:sourceDomain`
 * (token address lowercased + unpadded, joined to the numeric domain). Two intents
 * that debit the same source token on the same source domain share a scope.
 */
export function scopeKeyFor(burnIntent) {
  if (!burnIntent || !burnIntent.spec) return null;
  const token = unpadAddress(burnIntent.spec.sourceToken);
  if (!token) return null;
  const domain = burnIntent.spec.sourceDomain;
  if (domain == null) return null;
  return token + ':' + String(domain);
}

// ── Token address → symbol (for the server-side /v1/balances fetch) ──────────
// Sourced from shared/GatewaySpendService.js TOKEN_ADDR (Circle-published mainnet
// token addresses). Used only to map a burnIntent's sourceToken address back to a
// Circle balance symbol; an unknown address returns null → caller fails closed.
const TOKEN_SYMBOLS = {
  // USDC
  '0x3600000000000000000000000000000000000000': 'USDC', // Arc
  '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48': 'USDC', // Ethereum
  '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913': 'USDC', // Base
  '0xaf88d065e77c8cc2239327c5edb3a432268e5831': 'USDC', // Arbitrum
  '0x0b2c639c533813f4aa9d7837caf62653d097ff85': 'USDC', // Optimism
  '0x3c499c542cef5e3811e1192ce70d8cc03d5c3359': 'USDC', // Polygon
  '0xb97ef9ef8734c71904d8002f8b6bc66dd9c48a6e': 'USDC', // Avalanche
  '0x3894085ef7ff0f0aedf52e2a2704928d1ec074f1': 'USDC', // Sei
  // EURC
  '0xbef5f6d51cb62b58e6a8f77868681825c6fe21c1': 'EURC', // Arc
  '0x1abaea1f7c830bd89acc67ec4af516284b1bc33c': 'EURC', // Ethereum
  '0x60a3e35cc302bfa44cb288bc5a4f316fdb1adb42': 'EURC', // Base
  '0xc891eb4cbdeff6e073e859e987815ed1505c2acd': 'EURC', // Avalanche
  // cirBTC
  '0x171a4217b86a807a64eb94757db6849fb4bdbaa0': 'cirBTC', // Arc
  '0x72dfb2e44f59c5ad2bafe84314e5b99a7cd5075e': 'cirBTC', // Ethereum
};

export function tokenSymbolFor(sourceToken) {
  const addr = unpadAddress(sourceToken);
  if (!addr) return null;
  return TOKEN_SYMBOLS[addr] || null;
}

// ── Asset decimals (Circle official) ────────────────────────────────────────
// https://developers.circle.com/gateway/concepts/non-usdc-assets — USDC 6, EURC 6,
// cirBTC 8. Amounts in burn intents are atomic; the /v1/balances `balance` field
// is a DECIMAL string and must be normalized to atomic with this count.
const TOKEN_DECIMALS = { USDC: 6, EURC: 6, cirBTC: 8 };

export function tokenDecimalsFor(symbol) {
  if (typeof symbol !== 'string') return null;
  return TOKEN_DECIMALS[symbol] ?? null;
}

/**
 * Strict decimal-string → atomic BigInt (no float, no scientific notation, no
 * sign). Rejects excess precision. Returns a canonical unsigned-integer string,
 * or `null` on invalid input. Used to normalize the Circle /v1/balances balance
 * (a decimal string, e.g. "10.000000") into atomic units.
 */
export function decimalToAtomic(str, dec) {
  if (typeof str !== 'string' || typeof dec !== 'number' || !Number.isInteger(dec) || dec < 0 || dec > 77) return null;
  const s = str.trim();
  if (!/^\d+(\.\d+)?$/.test(s)) return null;
  const parts = s.split('.');
  const intPart = parts[0] || '0';
  const fracPart = parts[1] || '';
  if (fracPart.length > dec) return null; // excess precision — never truncate silently
  const fracPadded = fracPart.padEnd(dec, '0');
  try {
    return (BigInt(intPart) * (10n ** BigInt(dec)) + BigInt(fracPadded || '0')).toString();
  } catch(_) {
    return null;
  }
}
