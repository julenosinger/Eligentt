/**
 * Treasury Core API — Validation Layer (Phase 2)
 * ═══════════════════════════════════════════════
 * Pure request validators. They NEVER touch the chain, the Vault or the Treasury
 * Engine — they only shape and sanity-check input before it reaches the engine.
 * Each validator returns { valid, errors, value } where errors are the standard
 * { code, message, field } objects.
 */
import { RELAYER_CONFIG } from '../shared-config.mjs';

const ASSETS = Object.keys(RELAYER_CONFIG.ASSETS || { usdc: 1, eurc: 1, cirbtc: 1 });
const HEX_ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const BYTES32 = /^0x[0-9a-fA-F]{64}$/;

export function isAddress(v) { return typeof v === 'string' && HEX_ADDRESS.test(v); }
export function isBytes32(v) { return typeof v === 'string' && BYTES32.test(v); }
export function isAsset(v) { return typeof v === 'string' && ASSETS.includes(v.toLowerCase()); }
export function isPositiveNumber(v) { return typeof v === 'number' && isFinite(v) && v > 0; }
export function isNonNegativeNumber(v) { return typeof v === 'number' && isFinite(v) && v >= 0; }

function err(code, message, field) { return { code, message, field: field || null }; }

// POST /api/core/v1/intents
export function validateCreateIntent(body) {
  const b = body && typeof body === 'object' ? body : {};
  const errors = [];
  if (!isAsset(b.asset)) errors.push(err('INVALID_ASSET', 'asset must be one of: ' + ASSETS.join(', '), 'asset'));
  if (!isPositiveNumber(b.amount)) errors.push(err('INVALID_AMOUNT', 'amount must be a positive number', 'amount'));
  if (!isAddress(b.wallet || b.userAddress)) errors.push(err('INVALID_WALLET', 'wallet must be a valid address', 'wallet'));
  if (b.sourceChain != null && typeof b.sourceChain !== 'string' && typeof b.sourceChain !== 'number') {
    errors.push(err('INVALID_SOURCE_CHAIN', 'sourceChain must be a string or number', 'sourceChain'));
  }
  if (b.destChain != null && typeof b.destChain !== 'string' && typeof b.destChain !== 'number') {
    errors.push(err('INVALID_DEST_CHAIN', 'destChain must be a string or number', 'destChain'));
  }
  const value = {
    asset: isAsset(b.asset) ? b.asset.toLowerCase() : null,
    amount: b.amount,
    wallet: b.wallet || b.userAddress || null,
    sourceChain: b.sourceChain != null ? String(b.sourceChain) : null,
    destChain: b.destChain != null ? String(b.destChain) : 'Arc_Testnet',
    reference: typeof b.reference === 'string' ? b.reference.slice(0, 128) : null,
    // Optional: source-chain CCTP burn tx + domain, when the caller already
    // performed the burn. Enables the shared server-side settlement pipeline.
    burnTxHash: (typeof b.burnTxHash === 'string' && BYTES32.test(b.burnTxHash)) ? b.burnTxHash : null,
    sourceDomain: (typeof b.sourceDomain === 'number' && Number.isFinite(b.sourceDomain)) ? b.sourceDomain : null,
  };
  return { valid: errors.length === 0, errors, value };
}

// POST /api/core/v1/quote
export function validateQuote(body) {
  const b = body && typeof body === 'object' ? body : {};
  const errors = [];
  if (!isAsset(b.token || b.asset)) errors.push(err('INVALID_TOKEN', 'token must be one of: ' + ASSETS.join(', '), 'token'));
  if (!isPositiveNumber(b.amount)) errors.push(err('INVALID_AMOUNT', 'amount must be a positive number', 'amount'));
  const value = {
    token: (b.token || b.asset || '').toLowerCase() || null,
    amount: b.amount,
    sourceChain: b.sourceChain != null ? String(b.sourceChain) : (b.origin != null ? String(b.origin) : null),
    destChain: b.destChain != null ? String(b.destChain) : (b.destination != null ? String(b.destination) : 'Arc_Testnet'),
  };
  return { valid: errors.length === 0, errors, value };
}

// POST /api/core/v1/execute
export function validateExecute(body) {
  const b = body && typeof body === 'object' ? body : {};
  const errors = [];
  if (typeof b.intentId !== 'string' || b.intentId.trim().length === 0) {
    errors.push(err('INVALID_INTENT', 'intentId is required', 'intentId'));
  }
  // intentBytes32 / asset / amounts are OPTIONAL here: when the referenced core
  // intent already carries them, execute reuses the stored values.
  if (b.intentBytes32 != null && !isBytes32(b.intentBytes32)) {
    errors.push(err('INVALID_INTENT_BYTES32', 'intentBytes32 must be 0x-prefixed bytes32', 'intentBytes32'));
  }
  if (b.asset != null && !isAsset(b.asset)) {
    errors.push(err('INVALID_ASSET', 'asset must be a supported asset', 'asset'));
  }
  if (b.grossAmount != null && !isPositiveNumber(b.grossAmount)) {
    errors.push(err('INVALID_AMOUNT', 'grossAmount must be a positive number', 'grossAmount'));
  }
  if (b.userAddress != null && !isAddress(b.userAddress)) {
    errors.push(err('INVALID_WALLET', 'userAddress must be a valid address', 'userAddress'));
  }
  // Optional: the source-chain CCTP burn tx + source chain/domain let the server
  // continue the SHARED Turbo Bridge pipeline (attestation → settlement →
  // reimbursement) after Fulfill. All optional so existing callers are unaffected.
  if (b.burnTxHash != null && !isBytes32(b.burnTxHash)) {
    errors.push(err('INVALID_BURN_TX', 'burnTxHash must be 0x-prefixed bytes32', 'burnTxHash'));
  }
  if (b.sourceChain != null && typeof b.sourceChain !== 'string' && typeof b.sourceChain !== 'number') {
    errors.push(err('INVALID_SOURCE_CHAIN', 'sourceChain must be a string or number', 'sourceChain'));
  }
  if (b.sourceDomain != null && (typeof b.sourceDomain !== 'number' || !Number.isFinite(b.sourceDomain))) {
    errors.push(err('INVALID_SOURCE_DOMAIN', 'sourceDomain must be a number', 'sourceDomain'));
  }
  const value = {
    intentId: typeof b.intentId === 'string' ? b.intentId.trim() : null,
    intentBytes32: b.intentBytes32 || null,
    asset: b.asset ? b.asset.toLowerCase() : null,
    grossAmount: b.grossAmount ?? null,
    feeAmount: b.feeAmount ?? null,
    userAddress: b.userAddress || null,
    burnTxHash: b.burnTxHash || null,
    sourceChain: b.sourceChain != null ? String(b.sourceChain) : null,
    sourceDomain: b.sourceDomain != null ? Number(b.sourceDomain) : null,
    dryRun: b.dryRun === true,
  };
  return { valid: errors.length === 0, errors, value };
}

// GET /api/core/v1/history — query params (URLSearchParams or plain object)
export function validateHistoryQuery(params) {
  const get = (k) => {
    if (!params) return null;
    if (typeof params.get === 'function') return params.get(k);
    return params[k] ?? null;
  };
  const toInt = (v, def) => {
    const n = parseInt(v, 10);
    return Number.isFinite(n) ? n : def;
  };
  const page = Math.max(1, toInt(get('page'), 1));
  const rawLimit = toInt(get('limit') || get('pageSize'), 25);
  const limit = Math.min(200, Math.max(1, rawLimit));
  const sort = (get('sort') || 'createdAt').toString();
  const order = (get('order') || 'desc').toString().toLowerCase() === 'asc' ? 'asc' : 'desc';
  const value = {
    application: get('application') ? String(get('application')).toUpperCase() : null,
    client: get('client') || null,
    status: get('status') || null,
    asset: get('asset') ? String(get('asset')).toLowerCase() : null,
    sourceChain: get('sourceChain') || null,
    destChain: get('destChain') || null,
    wallet: get('wallet') ? String(get('wallet')).toLowerCase() : null,
    intentId: get('intentId') || get('intent') || null,
    dateFrom: get('dateFrom') || get('from') || null,
    dateTo: get('dateTo') || get('to') || null,
    page, limit, sort, order,
  };
  return { valid: true, errors: [], value };
}
