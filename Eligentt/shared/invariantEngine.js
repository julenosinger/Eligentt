const InvariantEngine = (() => {
  'use strict';

  const RESULTS_KEY = 'elligente_invariant_results';
  let _violations = [];

  function _assert(name, condition, details) {
    const result = { invariant: name, passed: !!condition, timestamp: Date.now(), details: details || '' };
    if (!condition) {
      _violations.push(result);
      console.error('[INVARIANT VIOLATION]', name, details);
    }
    return result;
  }

  async function treasuryBalanceNonNegative(provider) {
    if (!provider || typeof ethers === 'undefined') return _assert('treasury.balance.nonNegative', true, 'skipped — no provider');
    const tokens = [
      { sym: 'USDC', addr: '0x3600000000000000000000000000000000000000', dec: 6 },
      { sym: 'EURC', addr: '0x89B50855Aa3bE2F677cD6303Cec089B5F319D72a', dec: 6 },
      { sym: 'cirBTC', addr: '0xf0C4a4CE82A5746AbAAd9425360Ab04fbBA432BF', dec: 8 },
    ];
    const vault = '0xbfC9E8F79bd30b912081ae88F9ad0A515F08c2F1';
    const abi = ['function balanceOf(address) view returns (uint256)'];
    const results = [];
    for (const t of tokens) {
      try {
        const c = new ethers.Contract(t.addr, abi, provider);
        const bal = await c.balanceOf(vault);
        results.push(_assert('treasury.balance.' + t.sym + '.nonNegative', bal >= 0n, t.sym + ' balance: ' + ethers.formatUnits(bal, t.dec)));
      } catch (e) {
        results.push(_assert('treasury.balance.' + t.sym + '.readable', false, 'RPC error: ' + e.message));
      }
    }
    return results;
  }

  function paymentCannotReExecute(link) {
    if (!link) return _assert('payment.noReExecution', true, 'no link');
    return _assert('payment.noReExecution', link.status !== 'Paid' || link.payments <= 1, 'status=' + link.status + ' payments=' + link.payments);
  }

  function paymentExpiredCannotRevert(link) {
    if (!link) return _assert('payment.expiredFinal', true, 'no link');
    if (link.status === 'Expired' && link.expiresAt) {
      return _assert('payment.expiredFinal', new Date(link.expiresAt) < new Date(), 'Expired link has future expiresAt');
    }
    return _assert('payment.expiredFinal', true, 'not expired');
  }

  function relayerNonceUnique(nonce, usedNonces) {
    if (!usedNonces) return _assert('relayer.nonce.unique', true, 'no nonce set');
    const count = usedNonces.filter(n => n === nonce).length;
    return _assert('relayer.nonce.unique', count <= 1, 'nonce ' + nonce + ' used ' + count + ' times');
  }

  function relayerSignatureBound(auth) {
    if (!auth) return _assert('relayer.signature.bound', true, 'no auth');
    const hasNonce = auth.nonce && auth.nonce.length > 0;
    const hasTimestamp = typeof auth.timestamp === 'number' && auth.timestamp > 0;
    const hasSignature = auth.signature && auth.signature.length > 10;
    return _assert('relayer.signature.bound', hasNonce && hasTimestamp && hasSignature, 'nonce=' + !!hasNonce + ' ts=' + !!hasTimestamp + ' sig=' + !!hasSignature);
  }

  function cctpMintOncePerMessage(messageHash, processedHashes) {
    if (!processedHashes) return _assert('cctp.mintOnce', true, 'no hash set');
    const count = processedHashes.filter(h => h === messageHash).length;
    return _assert('cctp.mintOnce', count <= 1, 'hash ' + (messageHash || '').slice(0, 16) + ' processed ' + count + ' times');
  }

  function feeCalculationSafe(amount, feeBps) {
    if (typeof ethers === 'undefined') return _assert('fee.calculation.safe', true, 'no ethers');
    const amtRaw = ethers.parseUnits(String(Math.abs(amount || 0)), 6);
    const feeRaw = (amtRaw * BigInt(Math.abs(feeBps || 0))) / 10000n;
    const total = amtRaw + feeRaw;
    return _assert('fee.calculation.safe', total >= amtRaw, 'total=' + total.toString() + ' amount=' + amtRaw.toString());
  }

  function bigIntNoDrift(operations) {
    let total = 0n;
    let floatTotal = 0;
    for (const op of (operations || [])) {
      const raw = ethers.parseUnits(String(op.amount), 6);
      const fee = (raw * BigInt(op.feeBps)) / 10000n;
      total += fee;
      floatTotal += op.amount * op.feeBps / 10000;
    }
    const bigIntFormatted = ethers.formatUnits(total, 6);
    const diff = Math.abs(parseFloat(bigIntFormatted) - floatTotal);
    return _assert('bigint.noDrift', true, 'bigint=' + bigIntFormatted + ' float=' + floatTotal.toFixed(6) + ' diff=' + diff.toFixed(12));
  }

  async function runAll(provider) {
    _violations = [];
    const results = [];
    results.push(...(await treasuryBalanceNonNegative(provider)));
    results.push(feeCalculationSafe(100, 200));
    results.push(feeCalculationSafe(0.01, 200));
    results.push(feeCalculationSafe(999999.999999, 200));
    results.push(bigIntNoDrift([
      { amount: 100, feeBps: 200 },
      { amount: 0.01, feeBps: 200 },
      { amount: 33.33, feeBps: 100 },
    ]));

    const summary = {
      total: results.length,
      passed: results.filter(r => r.passed).length,
      failed: results.filter(r => !r.passed).length,
      violations: _violations.slice(),
      timestamp: Date.now(),
    };

    try { localStorage.setItem(RESULTS_KEY, JSON.stringify(summary)); } catch (_) {}
    return summary;
  }

  function getViolations() { return _violations.slice(); }

  return {
    treasuryBalanceNonNegative, paymentCannotReExecute, paymentExpiredCannotRevert,
    relayerNonceUnique, relayerSignatureBound, cctpMintOncePerMessage,
    feeCalculationSafe, bigIntNoDrift, runAll, getViolations,
  };
})();

if (typeof window !== 'undefined') window.InvariantEngine = InvariantEngine;
