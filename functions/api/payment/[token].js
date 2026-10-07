import { ethers } from 'ethers';
import { RELAYER_CONFIG } from '../shared-config.mjs';
import { checkPaymentLimit } from '../rate-limit.mjs';

function getCorsHeaders(request, env) {
  const allowed = (env.ALLOWED_ORIGINS || 'https://elligente.pages.dev').split(',').map(s => s.trim());
  const origin = request.headers.get('Origin') || '';
  const corsOrigin = allowed.includes(origin) ? origin : allowed[0];
  return {
    'Access-Control-Allow-Origin': corsOrigin,
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Content-Type': 'application/json',
  };
}

const TRANSFER_TOPIC = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';

// Resolve RPC and token address/decimals from the server-side registry.
// Returns null when chain or token is unsupported (payment must be rejected).
function resolveChainToken(chainId, tokenSymbol) {
  const registry = RELAYER_CONFIG.CHAIN_REGISTRY;
  if (!registry) return null;
  const chain = registry[Number(chainId)];
  if (!chain) return null;
  const sym = (tokenSymbol || 'USDC').toUpperCase();
  const tokenEntry = chain.tokens[sym];
  if (!tokenEntry) return null;
  return { rpc: chain.rpc, tokenAddress: tokenEntry.address.toLowerCase(), decimals: tokenEntry.decimals };
}

function toRaw(amount, decimals) {
  return ethers.parseUnits(String(amount), decimals || 6);
}

function addrMatch(a, b) {
  if (!a || !b) return false;
  return a.toLowerCase().replace(/^0x0+/, '0x') === b.toLowerCase().replace(/^0x0+/, '0x');
}

function findTransfer(receipt, tokenAddr, toAddr, expectedRaw, toleranceUnits) {
  toleranceUnits = toleranceUnits || 1n;
  const token = tokenAddr.toLowerCase();
  const to = toAddr.toLowerCase();
  for (const log of (receipt.logs || [])) {
    if (log.address.toLowerCase() !== token) continue;
    if (!log.topics || log.topics.length < 3) continue;
    if (log.topics[0] !== TRANSFER_TOPIC) continue;
    const logTo = '0x' + log.topics[2].slice(26).toLowerCase();
    if (!addrMatch(logTo, to)) continue;
    const value = BigInt(log.data);
    const diff = value > expectedRaw ? value - expectedRaw : expectedRaw - value;
    if (diff <= toleranceUnits) return { from: '0x' + log.topics[1].slice(26), to: logTo, value };
  }
  return null;
}

export async function onRequestOptions(context) {
  return new Response(null, { status: 204, headers: getCorsHeaders(context.request, context.env) });
}

// Strip server-side ownership fields before returning to any client.
function publicView(link) {
  const { ownerEmail, ownerWallet, userId: _uid, ...pub } = link;
  return pub;
}

export async function onRequestGet(context) {
  const headers = getCorsHeaders(context.request, context.env);
  try {
    const token = context.params.token;
    if (!token) return new Response(JSON.stringify({ error: 'Token required' }), { status: 400, headers });

    const KV = context.env.PAYMENT_LINKS;
    if (!KV) return new Response(JSON.stringify({ error: 'Storage unavailable' }), { status: 503, headers });

    const raw = await KV.get(token);
    if (!raw) return new Response(JSON.stringify({ error: 'Payment link not found' }), { status: 404, headers });

    const link = JSON.parse(raw);

    if (link.expiresAt && new Date(link.expiresAt) < new Date() && link.status === 'Active') {
      link.status = 'Expired';
      await KV.put(token, JSON.stringify(link));
      return new Response(JSON.stringify({ ok: true, link: publicView(link), expired: true }), { status: 200, headers });
    }

    if (link.status === 'Expired') {
      return new Response(JSON.stringify({ ok: true, link: publicView(link), expired: true }), { status: 200, headers });
    }

    link.scans = (link.scans || 0) + 1;
    await KV.put(token, JSON.stringify(link));

    link.feeReceiver = RELAYER_CONFIG.TREASURY_VAULT;
    link.feeBps = RELAYER_CONFIG.PAYLINK_FEE_BPS || 200;

    return new Response(JSON.stringify({ ok: true, link: publicView(link) }), { status: 200, headers });
  } catch (e) {
    return new Response(JSON.stringify({ error: 'Server error: ' + (e.message || '') }), { status: 500, headers });
  }
}

export async function onRequestPost(context) {
  const headers = getCorsHeaders(context.request, context.env);

  const clientIP = context.request.headers.get('CF-Connecting-IP') || context.request.headers.get('X-Forwarded-For') || 'unknown';
  const rateCheck = await checkPaymentLimit(context.env.RATE_LIMIT_KV, clientIP);
  if (!rateCheck.allowed) {
    return new Response(JSON.stringify({ error: 'Rate limit exceeded' }), { status: 429, headers });
  }

  try {
    const token = context.params.token;
    if (!token) return new Response(JSON.stringify({ error: 'Token required' }), { status: 400, headers });

    const KV = context.env.PAYMENT_LINKS;
    if (!KV) return new Response(JSON.stringify({ error: 'Storage unavailable' }), { status: 503, headers });

    const raw = await KV.get(token);
    if (!raw) return new Response(JSON.stringify({ error: 'Payment link not found' }), { status: 404, headers });

    const link = JSON.parse(raw);

    if (link.status === 'Paid') {
      return new Response(JSON.stringify({ error: 'Payment already completed' }), { status: 409, headers });
    }
    if (link.status === 'Expired' || (link.expiresAt && new Date(link.expiresAt) < new Date())) {
      if (link.status !== 'Expired') {
        link.status = 'Expired';
        await KV.put(token, JSON.stringify(link));
      }
      return new Response(JSON.stringify({ error: 'Payment link expired' }), { status: 410, headers });
    }
    if (link.status === 'Disabled') {
      return new Response(JSON.stringify({ error: 'Payment link disabled' }), { status: 403, headers });
    }

    const body = await context.request.json();
    const { txHash, feeTxHash, paidBy } = body;

    if (!txHash || !/^0x[0-9a-fA-F]{64}$/.test(txHash)) {
      return new Response(JSON.stringify({ error: 'Invalid transaction hash' }), { status: 400, headers });
    }

    // IDEMPOTENCY — true atomic serialization via Durable Object (preferred)
    // with graceful KV-sentinel fallback for local dev (PAYMENT_LOCK not bound).
    //
    // Durable Objects (production): Cloudflare guarantees a single active DO
    // instance per key, serializing all concurrent requests.  Two simultaneous
    // POST requests for the same chainId+txHash both enter the DO and the second
    // one sees the first's "processing" claim — returning 409 immediately without
    // reaching the RPC call.  On success the claim is "committed" (permanent);
    // on failure or timeout it auto-releases via a 60-second DO alarm so the
    // payment can be retried.
    //
    // KV fallback (dev/local): same sentinel strategy as before — strong
    // protection for sequential/retried requests, best-effort for truly
    // concurrent requests within KV propagation window (~1–5 s).
    const destChainIdEarly = link.chainId || RELAYER_CONFIG.ARC_CHAIN_ID;
    const idempotencyKey   = `txused:${destChainIdEarly}:${txHash.toLowerCase()}`;

    // ── Durable Object path (production) ────────────────────────────────────
    const useDO = !!context.env.PAYMENT_LOCK;
    let doId, doStub;

    if (useDO) {
      doId   = context.env.PAYMENT_LOCK.idFromName(idempotencyKey);
      doStub = context.env.PAYMENT_LOCK.get(doId);

      const claimRes  = await doStub.fetch('https://do/lock', {
        method: 'POST',
        body: JSON.stringify({ action: 'claim', token }),
        headers: { 'Content-Type': 'application/json' },
      });
      const claimBody = await claimRes.json();

      if (claimBody.claimed === false) {
        // Different token already holds this txHash — hard reject.
        return new Response(JSON.stringify({ error: 'Transaction already used for a different payment' }), { status: 409, headers });
      }
      if (claimBody.claimed === 'same') {
        // Same token retry — idempotent: return current state.
        const freshRaw = await KV.get(token);
        const fresh = freshRaw ? JSON.parse(freshRaw) : link;
        return new Response(JSON.stringify({ ok: true, link: publicView(fresh) }), { status: 200, headers });
      }
      // claimed === true → this request won the lock; proceed to RPC verification.

    } else {
      // ── KV-sentinel fallback (dev / PAYMENT_LOCK not bound) ───────────────
      const existingClaim = await KV.get(idempotencyKey);
      if (existingClaim && !existingClaim.startsWith('processing:') && existingClaim !== token) {
        return new Response(JSON.stringify({ error: 'Transaction already used for a different payment' }), { status: 409, headers });
      }
      if (existingClaim === token) {
        const freshRaw = await KV.get(token);
        const fresh = freshRaw ? JSON.parse(freshRaw) : link;
        return new Response(JSON.stringify({ ok: true, link: publicView(fresh) }), { status: 200, headers });
      }
      const processingValue = `processing:${token}`;
      await KV.put(idempotencyKey, processingValue, { expirationTtl: 60 });
      const raceCheck = await KV.get(idempotencyKey);
      if (raceCheck && raceCheck !== processingValue && raceCheck !== token) {
        return new Response(JSON.stringify({ error: 'Transaction already used for a different payment' }), { status: 409, headers });
      }
    }

    // Resolve destination chain + token from the stored link (never trust frontend).
    // If chain or token is unsupported, reject without marking Paid.
    const destChainId = link.chainId || RELAYER_CONFIG.ARC_CHAIN_ID;
    const destToken   = link.token || 'USDC';
    const chainToken  = resolveChainToken(destChainId, destToken);
    if (!chainToken) {
      return new Response(JSON.stringify({
        error: 'Unsupported destination chain or token: chainId=' + destChainId + ' token=' + destToken
      }), { status: 422, headers });
    }

    // Arc allows env override; all other chains use the registry RPC.
    const rpcUrl = (destChainId === RELAYER_CONFIG.ARC_CHAIN_ID && context.env.ARC_RPC_URL)
      ? context.env.ARC_RPC_URL
      : chainToken.rpc;
    const provider = new ethers.JsonRpcProvider(rpcUrl);

    const receipt = await provider.getTransactionReceipt(txHash);
    if (!receipt) {
      return new Response(JSON.stringify({ error: 'Transaction not found on-chain. It may still be pending.' }), { status: 422, headers });
    }
    if (receipt.status !== 1) {
      return new Response(JSON.stringify({ error: 'Transaction failed on-chain (reverted)' }), { status: 422, headers });
    }

    const expectedAmount = toRaw(link.amount, chainToken.decimals);
    const transfer = findTransfer(receipt, chainToken.tokenAddress, link.recipient, expectedAmount, 2n);
    if (!transfer) {
      // Release DO lock on validation failure so payment can be retried with correct data.
      if (useDO && doStub) {
        await doStub.fetch('https://do/lock', {
          method: 'POST', body: JSON.stringify({ action: 'release', token }),
          headers: { 'Content-Type': 'application/json' },
        }).catch(() => {});
      }
      return new Response(JSON.stringify({
        error: 'On-chain validation failed: no matching ' + destToken + ' transfer to recipient for the expected amount',
        expected: { recipient: link.recipient, amount: link.amount, rawAmount: expectedAmount.toString(), chain: destChainId }
      }), { status: 422, headers });
    }

    const feeAmount = parseFloat(link.feeAmount) || 0;
    let feeVerified = feeAmount <= 0;

    if (feeAmount > 0) {
      if (!feeTxHash || !/^0x[0-9a-fA-F]{64}$/.test(feeTxHash)) {
        if (useDO && doStub) {
          await doStub.fetch('https://do/lock', {
            method: 'POST', body: JSON.stringify({ action: 'release', token }),
            headers: { 'Content-Type': 'application/json' },
          }).catch(() => {});
        }
        return new Response(JSON.stringify({ error: 'Fee transaction hash required for paid links with protocol fee' }), { status: 400, headers });
      }

      const feeReceipt = await provider.getTransactionReceipt(feeTxHash);
      if (!feeReceipt) {
        if (useDO && doStub) {
          await doStub.fetch('https://do/lock', {
            method: 'POST', body: JSON.stringify({ action: 'release', token }),
            headers: { 'Content-Type': 'application/json' },
          }).catch(() => {});
        }
        return new Response(JSON.stringify({ error: 'Fee transaction not found on-chain' }), { status: 422, headers });
      }
      if (feeReceipt.status !== 1) {
        if (useDO && doStub) {
          await doStub.fetch('https://do/lock', {
            method: 'POST', body: JSON.stringify({ action: 'release', token }),
            headers: { 'Content-Type': 'application/json' },
          }).catch(() => {});
        }
        return new Response(JSON.stringify({ error: 'Fee transaction failed on-chain (reverted)' }), { status: 422, headers });
      }

      const expectedFee = toRaw(feeAmount, chainToken.decimals);
      const feeTransfer = findTransfer(feeReceipt, chainToken.tokenAddress, RELAYER_CONFIG.TREASURY_VAULT, expectedFee, 2n);
      if (!feeTransfer) {
        if (useDO && doStub) {
          await doStub.fetch('https://do/lock', {
            method: 'POST', body: JSON.stringify({ action: 'release', token }),
            headers: { 'Content-Type': 'application/json' },
          }).catch(() => {});
        }
        return new Response(JSON.stringify({
          error: 'On-chain validation failed: no matching ' + destToken + ' fee transfer to TreasuryVault',
          expected: { treasury: RELAYER_CONFIG.TREASURY_VAULT, feeAmount, rawFee: expectedFee.toString(), chain: destChainId }
        }), { status: 422, headers });
      }
      feeVerified = true;
    }

    // All verifications passed. Commit the idempotency claim permanently.
    if (useDO && doStub) {
      // DO: upgrade "processing" to "committed" — cancels the 60-second alarm.
      await doStub.fetch('https://do/lock', {
        method: 'POST', body: JSON.stringify({ action: 'commit', token }),
        headers: { 'Content-Type': 'application/json' },
      });
    } else {
      // KV fallback: overwrite sentinel with permanent 7-day claim.
      await KV.put(idempotencyKey, token, { expirationTtl: 604800 });
    }

    link.status = 'Paid';
    link.paidTx = txHash;
    link.feeTxHash = feeTxHash || null;
    link.paidBy = paidBy || null; // informational only — never used for authorization
    link.paidAt = new Date().toISOString();
    link.payments = (link.payments || 0) + 1;
    link.verification = {
      recipientTransfer: { to: transfer.to, value: transfer.value.toString() },
      feeVerified,
      verifiedAt: new Date().toISOString(),
      chainId: destChainId,
    };

    await KV.put(token, JSON.stringify(link));

    return new Response(JSON.stringify({ ok: true, link: publicView(link) }), { status: 200, headers });
  } catch (e) {
    return new Response(JSON.stringify({ error: 'Server error: ' + (e.message || '') }), { status: 500, headers });
  }
}
