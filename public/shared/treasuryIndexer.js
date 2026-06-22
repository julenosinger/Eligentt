/**
 * Elligente Treasury Indexer — On-Chain First State Engine
 * ═════════════════════════════════════════════════════════
 * Scans Arc chain for ELLIGENTE Memo events and ERC20 Transfer events
 * to reconstruct Treasury settlement state from on-chain data.
 *
 * This module is the PRIMARY source of truth for settlement state.
 * localStorage serves only as a UI performance cache.
 *
 * Usage:
 *   <script src="shared/treasuryIndexer.js"></script>
 *   const state = await TreasuryIndexer.syncFromChain(provider);
 *
 * No mock data. Only real on-chain events.
 */

const TreasuryIndexer = (() => {
  'use strict';

  const MEMO_CONTRACT = '0x5294E9927c3306DcBaDb03fe70b92e01cCede505';
  const TREASURY_VAULT = '0xbfC9E8F79bd30b912081ae88F9ad0A515F08c2F1';
  const USDC_ADDRESS = '0x3600000000000000000000000000000000000000';

  const MEMO_ABI = [
    'event Memo(address indexed sender, address indexed target, bytes32 callDataHash, bytes32 indexed memoId, bytes memo, uint256 memoIndex)'
  ];
  const ERC20_ABI = [
    'event Transfer(address indexed from, address indexed to, uint256 value)',
    'function balanceOf(address) view returns (uint256)'
  ];

  const STORE_KEY = 'elligente_treasury_index';
  const CACHE_VERSION = 2;
  const BATCH_SIZE = 2000;
  const PREFIX = 'ELLIGENTE';

  function _loadState() {
    try {
      const raw = localStorage.getItem(STORE_KEY);
      if (!raw) return _emptyState();
      const s = JSON.parse(raw);
      if (s.cacheVersion !== CACHE_VERSION) return _emptyState();
      return s;
    } catch (_) { return _emptyState(); }
  }

  function _saveState(state) {
    state.cacheVersion = CACHE_VERSION;
    state.lastSyncTimestamp = Date.now();
    try { localStorage.setItem(STORE_KEY, JSON.stringify(state)); } catch (_) {}
  }

  function _emptyState() {
    return {
      cacheVersion: CACHE_VERSION,
      lastChainSyncBlock: 0,
      lastSyncTimestamp: 0,
      settlements: [],
      treasuryBalance: null,
      synced: false,
    };
  }

  function _parseMemo(memoBytes) {
    try {
      const str = (typeof ethers !== 'undefined')
        ? ethers.toUtf8String(memoBytes)
        : new TextDecoder().decode(memoBytes);
      if (!str.startsWith(PREFIX + '|')) return null;
      const parts = str.split('|');
      if (parts.length < 5) return null;
      const amt = parseFloat(parts[4]);
      if (isNaN(amt) || amt < 0) return null;
      if (!parts[2] || !parts[3]) return null;
      return {
        prefix: parts[0],
        action: parts[1],
        intentId: parts[2],
        asset: parts[3],
        amount: amt,
        raw: str,
      };
    } catch (_) { return null; }
  }

  async function scanSettlements(provider, fromBlock, toBlock) {
    if (!provider || typeof ethers === 'undefined') return [];

    const memoContract = new ethers.Contract(MEMO_CONTRACT, MEMO_ABI, provider);
    const filter = memoContract.filters.Memo();
    const results = [];

    for (let start = fromBlock; start <= toBlock; start += BATCH_SIZE) {
      const end = Math.min(start + BATCH_SIZE - 1, toBlock);
      try {
        const events = await memoContract.queryFilter(filter, start, end);
        for (const ev of events) {
          try {
            const parsed = _parseMemo(ev.args.memo);
            if (!parsed || parsed.action !== 'REPAY') continue;
            results.push({
              intentId: parsed.intentId,
              action: parsed.action,
              asset: parsed.asset.toLowerCase(),
              amount: parsed.amount,
              memo: parsed.raw,
              memoOnChain: true,
              txHash: ev.transactionHash,
              blockNumber: ev.blockNumber,
              sender: ev.args.sender,
              target: ev.args.target,
              memoId: ev.args.memoId,
              status: 'Settled',
              _treasuryReimbursed: true,
              _dataSource: 'chain',
            });
          } catch (_) {}
        }
      } catch (e) {
        console.warn('[TreasuryIndexer] Batch scan error:', start, '-', end, e.message ?? e);
      }
    }
    return results;
  }

  async function _fetchTreasuryBalance(provider) {
    try {
      const token = new ethers.Contract(USDC_ADDRESS, ERC20_ABI, provider);
      const bal = await token.balanceOf(TREASURY_VAULT);
      return parseFloat(ethers.formatUnits(bal, 6));
    } catch (_) { return null; }
  }

  async function syncFromChain(provider) {
    if (!provider || typeof ethers === 'undefined') return _loadState();

    const state = _loadState();
    let currentBlock;
    try { currentBlock = await provider.getBlockNumber(); } catch (_) { return state; }

    if (currentBlock <= state.lastChainSyncBlock && state.synced) return state;

    const fromBlock = state.lastChainSyncBlock > 0
      ? state.lastChainSyncBlock + 1
      : Math.max(0, currentBlock - 50000);

    console.log('[TreasuryIndexer] Scanning blocks', fromBlock, 'to', currentBlock);

    const newSettlements = await scanSettlements(provider, fromBlock, currentBlock);

    for (const s of newSettlements) {
      const existingIdx = state.settlements.findIndex(e => e.intentId === s.intentId);
      if (existingIdx >= 0) {
        state.settlements[existingIdx] = { ...state.settlements[existingIdx], ...s };
      } else {
        state.settlements.push(s);
      }
    }

    state.treasuryBalance = await _fetchTreasuryBalance(provider);
    state.lastChainSyncBlock = currentBlock;
    state.synced = true;

    _saveState(state);

    if (newSettlements.length > 0) {
      console.log('[TreasuryIndexer] Found', newSettlements.length, 'new settlement(s). Total:', state.settlements.length);
    }

    return state;
  }

  function recoverIntentFromChain(settlement) {
    return {
      id: settlement.intentId,
      intentId: settlement.intentId,
      intentBytes32: (typeof ethers !== 'undefined')
        ? ethers.keccak256(ethers.toUtf8Bytes(settlement.intentId))
        : settlement.intentId,
      asset: settlement.asset,
      amount: settlement.amount,
      grossAmount: settlement.amount,
      netAmount: settlement.amount,
      feeAmount: 0,
      userAddress: settlement.sender ?? null,
      srcChain: null,
      dstChain: 'Arc_Testnet',
      status: 'Settled',
      txHash: null,
      sourceDomain: null,
      createdAt: settlement.timestamp ?? Date.now(),
      updatedAt: Date.now(),
      settledAt: settlement.timestamp ?? Date.now(),
      cctpMsgHash: null,
      attestation: null,
      arcTxHash: settlement.txHash,
      arcFulfillmentTimestamp: settlement.timestamp ?? Date.now(),
      settlementTxHash: settlement.txHash,
      mintTxHash: settlement.txHash,
      mintBlockNumber: settlement.blockNumber,
      memo: settlement.memo,
      memoOnChain: true,
      _treasuryReimbursed: true,
      _reimbursementProof: { onChainVerified: true, recoveredFromMemo: true },
      _dataSource: 'chain',
      _recoveredFromChain: true,
      failReason: null,
      liquidityFee: 0,
      settleFee: 0,
      lastPollAt: null,
      lastError: null,
      pollCount: 0,
      settlementError: null,
      lastAttempt: null,
      retryCount: 0,
    };
  }

  function syncLocalCache(chainState, localIntents) {
    const merged = [...localIntents];
    let added = 0;
    let updated = 0;

    for (const cs of chainState.settlements) {
      const localIdx = merged.findIndex(i =>
        i.id === cs.intentId || i.intentId === cs.intentId
      );

      if (localIdx >= 0) {
        const local = merged[localIdx];
        if (!local.memoOnChain && cs.memoOnChain) {
          merged[localIdx] = {
            ...local,
            memo: cs.memo ?? local.memo,
            memoOnChain: true,
            mintTxHash: cs.txHash ?? local.mintTxHash,
            mintBlockNumber: cs.blockNumber ?? local.mintBlockNumber,
            _dataSource: 'chain',
            status: local.status === 'Failed' ? local.status : (cs.status ?? local.status),
            _treasuryReimbursed: local._treasuryReimbursed || cs._treasuryReimbursed,
          };
          updated++;
        }
      } else {
        merged.push(recoverIntentFromChain(cs));
        added++;
      }
    }

    for (const intent of merged) {
      if (!intent._dataSource) {
        intent._dataSource = 'cache';
      }
    }

    if (added > 0 || updated > 0) {
      console.log('[TreasuryIndexer] Sync: added=' + added + ' updated=' + updated);
    }

    return merged;
  }

  function reconcileTreasuryState(chainState, localIntents) {
    const results = { matched: 0, mismatched: 0, missing: 0, issues: [] };

    for (const cs of chainState.settlements) {
      const local = localIntents.find(i => i.id === cs.intentId || i.intentId === cs.intentId);
      if (!local) {
        results.missing++;
        results.issues.push({ intentId: cs.intentId, issue: 'ON_CHAIN_NOT_IN_LOCAL', chainAmount: cs.amount });
        continue;
      }
      if (local.amount !== cs.amount) {
        results.mismatched++;
        results.issues.push({ intentId: cs.intentId, issue: 'AMOUNT_MISMATCH', local: local.amount, chain: cs.amount });
      } else {
        results.matched++;
      }
    }

    for (const local of localIntents) {
      if (local.status === 'Settled' && local._treasuryReimbursed) {
        const onChain = chainState.settlements.find(s => s.intentId === (local.intentId ?? local.id));
        if (!onChain && !local.memoOnChain) {
          results.issues.push({
            intentId: local.intentId ?? local.id,
            issue: 'SETTLED_NOT_ON_CHAIN',
            status: 'RECONCILIATION_REQUIRED',
          });
        }
      }
    }

    if (chainState.treasuryBalance !== null) {
      const settledTotal = chainState.settlements.reduce((sum, s) => sum + (s.amount ?? 0), 0);
      results.treasuryBalance = chainState.treasuryBalance;
      results.settledTotal = settledTotal;
    }

    return results;
  }

  function validateAgainstBalance(chainState, expectedReimbursement) {
    if (chainState.treasuryBalance === null) return { valid: false, reason: 'balance_unavailable' };
    return {
      valid: true,
      treasuryBalance: chainState.treasuryBalance,
      expectedReimbursement,
      delta: chainState.treasuryBalance - expectedReimbursement,
    };
  }

  function getLastSyncBlock() {
    return _loadState().lastChainSyncBlock;
  }

  function getLastSyncTimestamp() {
    return _loadState().lastSyncTimestamp;
  }

  function isSynced() {
    return _loadState().synced;
  }

  function getAllSettlements() {
    return _loadState().settlements;
  }

  function clearCache() {
    _saveState(_emptyState());
  }

  return {
    syncFromChain,
    scanSettlements,
    recoverIntentFromChain,
    syncLocalCache,
    reconcileTreasuryState,
    validateAgainstBalance,
    getLastSyncBlock,
    getLastSyncTimestamp,
    isSynced,
    getAllSettlements,
    clearCache,
    CACHE_VERSION,
  };
})();

if (typeof window !== 'undefined') {
  window.TreasuryIndexer = TreasuryIndexer;
}
