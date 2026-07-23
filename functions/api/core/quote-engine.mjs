/**
 * Treasury Core API — Quote Engine (Phase 2)
 * ═══════════════════════════════════════════
 * Produces a route quote using the EXISTING fee/route parameters (RELAYER_CONFIG,
 * mirrored from public/config). It does NOT recalculate or re-implement financial
 * logic and it performs NO on-chain calls — it is a deterministic projection over
 * the current configuration, mirroring how the frontend selects Turbo vs Standard
 * and computes the liquidity fee.
 */
import { RELAYER_CONFIG } from '../shared-config.mjs';

const DOMAINS = RELAYER_CONFIG.CCTP_DOMAINS || {};
const ARC_CHAIN_ID = String(RELAYER_CONFIG.ARC_CHAIN_ID || 5042002);

// Turbo Bridge liquidity threshold: below this the Treasury fronts liquidity for
// an instant payout (Turbo); above it we fall back to Standard CCTP settlement.
const TURBO_MAX_AMOUNT = 50000;

function decimalsFor(token) {
  return token === 'cirbtc' ? 8 : 6;
}

function round(n, dp) {
  const f = Math.pow(10, dp);
  return Math.round((n + Number.EPSILON) * f) / f;
}

function resolveChain(idOrName) {
  if (idOrName == null) return null;
  const key = String(idOrName);
  if (DOMAINS[key]) return { chainId: key, ...DOMAINS[key] };
  // Allow lookup by symbolic name.
  for (const [chainId, meta] of Object.entries(DOMAINS)) {
    if (meta.name && meta.name.toLowerCase() === key.toLowerCase()) return { chainId, ...meta };
  }
  return null;
}

/**
 * @param {{token:string, amount:number, sourceChain?:string, destChain?:string}} req
 * @returns {{ bestRoute, bridge, eta, fee, receive, provider, slippage,
 *   liquidityAvailable, feeBps, sourceChain, destChain, asset, amount }}
 */
export function getQuote(req) {
  const token = String(req.token || req.asset || 'usdc').toLowerCase();
  const amount = Number(req.amount);
  const dp = decimalsFor(token);

  const dest = resolveChain(req.destChain) || resolveChain(ARC_CHAIN_ID);
  const source = resolveChain(req.sourceChain);

  // Bridge selection mirrors the frontend engine: Turbo for amounts the Treasury
  // can front instantly, Standard CCTP otherwise.
  const useTurbo = amount > 0 && amount <= TURBO_MAX_AMOUNT;
  const bridge = useTurbo ? 'Turbo' : 'Standard';

  const feeBps = useTurbo
    ? (RELAYER_CONFIG.TURBO_FEE_BPS ?? 100)
    : Math.round((RELAYER_CONFIG.STANDARD_BRIDGE_FEE_RATE ?? 0.0005) * 10000);

  const fee = round((amount * feeBps) / 10000, dp);
  const receive = round(Math.max(0, amount - fee), dp);

  // ETA: Turbo pays instantly then reimburses via CCTP; Standard waits for CCTP
  // attestation. Values mirror the configured polling envelopes (seconds).
  const eta = useTurbo
    ? { paymentSeconds: 20, settlementSeconds: 900, display: '~20s payout · ~15m settlement' }
    : { paymentSeconds: 900, settlementSeconds: 900, display: '~15m settlement' };

  // Available liquidity reference from the rebalancing target (config), NOT an RPC
  // read (Phase 2 avoids extra RPC round-trips in the quote path).
  const liquidityAvailable = RELAYER_CONFIG.REBAL_TARGET || 50000;

  return {
    asset: token,
    amount,
    bestRoute: {
      from: source ? source.name : (req.sourceChain != null ? String(req.sourceChain) : 'external'),
      to: dest ? dest.name : 'Arc_Testnet',
      via: 'Circle CCTP v2',
    },
    bridge,
    provider: 'Circle CCTP',
    feeBps,
    fee,
    receive,
    slippage: 0,                  // stable-asset settlement — no slippage
    eta,
    liquidityAvailable,
    sourceChain: source ? source.name : (req.sourceChain != null ? String(req.sourceChain) : null),
    destChain: dest ? dest.name : 'Arc_Testnet',
  };
}
