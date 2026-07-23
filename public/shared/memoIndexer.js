/**
 * Elligente Arc Transaction Memo Indexer
 * ═══════════════════════════════════════
 * Scans Arc chain for ELLIGENTE transaction memos emitted via the
 * Memo contract (0x5294E9927c3306DcBaDb03fe70b92e01cCede505).
 *
 * Returns structured memo entries for reconciliation, audit trail,
 * and recovery of settlement state from on-chain data.
 *
 * Usage (browser):
 *   <script src="shared/memoIndexer.js"></script>
 *   const entries = await MemoIndexer.scanArcMemos(provider, fromBlock, toBlock);
 *
 * No mock data. Only real on-chain events.
 */

const MemoIndexer = (() => {
  'use strict';

  const MEMO_CONTRACT_ADDRESS = '0x5294E9927c3306DcBaDb03fe70b92e01cCede505';
  const MEMO_ABI = [
    'function memo(address target, bytes calldata data, bytes32 memoId, bytes calldata memoData) external',
    'event BeforeMemo(uint256 indexed memoIndex)',
    'event Memo(address indexed sender, address indexed target, bytes32 callDataHash, bytes32 indexed memoId, bytes memo, uint256 memoIndex)'
  ];

  const PREFIX = 'ELLIGENTE';
  const VALID_ACTIONS = ['REPAY', 'BRIDGE', 'INVOICE', 'BATCH'];
  const STORE_KEY = 'elligente_memo_indexer';
  const BATCH_SIZE = 2000;

  function _loadState() {
    try {
      const raw = localStorage.getItem(STORE_KEY);
      return raw ? JSON.parse(raw) : { lastScannedBlock: 0, entries: [] };
    } catch (_) { return { lastScannedBlock: 0, entries: [] }; }
  }

  function _saveState(state) {
    try { localStorage.setItem(STORE_KEY, JSON.stringify(state)); } catch (_) {}
  }

  function generate(action, intentId, asset, amount, application, client) {
    const base = `${PREFIX}|${action}|${intentId}|${(asset ?? 'USDC').toUpperCase()}|${amount}`;
    // Multi-application (Phase 1): append Application + Client, keeping the first
    // five positional fields byte-identical to the legacy format. Only appended
    // when provided so legacy call sites emit the exact same string as before.
    if (application === undefined && client === undefined) return base;
    const app = String(application ?? 'ELLIGENT').toUpperCase();
    const cli = String(client ?? 'default');
    return `${base}|${app}|${cli}`;
  }

  function parse(memoStr) {
    if (!memoStr || typeof memoStr !== 'string') return null;
    if (!memoStr.startsWith(PREFIX + '|')) return null;
    const parts = memoStr.split('|');
    if (parts.length < 4) return null;
    return {
      prefix: parts[0],
      action: parts[1],
      intentId: parts[2],
      asset: parts[3] ?? null,
      amount: parts[4] ? parseFloat(parts[4]) : null,
      // Optional multi-application fields (backward compatible: legacy memos omit
      // them and fall back to the ELLIGENT / default attribution).
      application: parts[5] ? parts[5].toUpperCase() : 'ELLIGENT',
      client: parts[6] ?? 'default',
    };
  }

  function validate(memoStr) {
    if (!memoStr || typeof memoStr !== 'string') return false;
    if (!memoStr.startsWith(PREFIX + '|')) return false;
    const parts = memoStr.split('|');
    if (parts.length < 5) return false;
    if (!VALID_ACTIONS.includes(parts[1])) return false;
    if (!parts[2] || parts[2].trim().length === 0) return false;
    if (!parts[3] || parts[3].trim().length === 0) return false;
    const amt = parseFloat(parts[4]);
    if (isNaN(amt) || amt < 0) return false;
    return true;
  }

  function decodeMemoBytes(memoBytes) {
    if (typeof ethers !== 'undefined') return ethers.toUtf8String(memoBytes);
    return new TextDecoder().decode(
      typeof memoBytes === 'string'
        ? Uint8Array.from(memoBytes.slice(2).match(/.{2}/g).map(h => parseInt(h, 16)))
        : memoBytes
    );
  }

  async function scanArcMemos(provider, fromBlock, toBlock) {
    if (!provider || typeof ethers === 'undefined') return [];

    const memoContract = new ethers.Contract(MEMO_CONTRACT_ADDRESS, MEMO_ABI, provider);
    const filter = memoContract.filters.Memo();
    const results = [];

    for (let start = fromBlock; start <= toBlock; start += BATCH_SIZE) {
      const end = Math.min(start + BATCH_SIZE - 1, toBlock);
      try {
        const events = await memoContract.queryFilter(filter, start, end);
        for (const ev of events) {
          try {
            const memoStr = decodeMemoBytes(ev.args.memo);
            if (!validate(memoStr)) continue;
            const parsed = parse(memoStr);
            if (!parsed) continue;

            let blockTimestamp = null;
            try {
              const block = await provider.getBlock(ev.blockNumber);
              blockTimestamp = block ? block.timestamp * 1000 : null;
            } catch (_) {}

            results.push({
              intentId: parsed.intentId,
              action: parsed.action,
              asset: parsed.asset,
              amount: parsed.amount,
              application: parsed.application,
              client: parsed.client,
              memo: memoStr,
              txHash: ev.transactionHash,
              blockNumber: ev.blockNumber,
              sender: ev.args.sender,
              target: ev.args.target,
              memoId: ev.args.memoId,
              memoIndex: Number(ev.args.memoIndex),
              timestamp: blockTimestamp ?? Date.now(),
            });
          } catch (_) {}
        }
      } catch (e) {
        console.warn('[MemoIndexer] Batch scan error:', start, '-', end, e.message ?? e);
      }
    }

    return results;
  }

  async function incrementalScan(provider) {
    if (!provider) return [];

    const state = _loadState();
    let currentBlock;
    try { currentBlock = await provider.getBlockNumber(); } catch (_) { return []; }

    if (currentBlock <= state.lastScannedBlock) return [];

    const fromBlock = state.lastScannedBlock > 0
      ? state.lastScannedBlock + 1
      : Math.max(0, currentBlock - 10000);

    const results = await scanArcMemos(provider, fromBlock, currentBlock);

    for (const entry of results) {
      const existingIdx = state.entries.findIndex(e => e.intentId === entry.intentId);
      if (existingIdx >= 0) {
        state.entries[existingIdx] = { ...state.entries[existingIdx], ...entry, updatedAt: Date.now() };
      } else {
        state.entries.push({ ...entry, indexedAt: Date.now() });
      }
    }

    state.lastScannedBlock = currentBlock;
    _saveState(state);

    return results;
  }

  function getAll() {
    return _loadState().entries;
  }

  function getByIntentId(intentId) {
    return _loadState().entries.find(e => e.intentId === intentId) ?? null;
  }

  function getByAction(action) {
    return _loadState().entries.filter(e => e.action === action);
  }

  function getLastScannedBlock() {
    return _loadState().lastScannedBlock;
  }

  function clearCache() {
    _saveState({ lastScannedBlock: 0, entries: [] });
  }

  return {
    MEMO_CONTRACT_ADDRESS,
    PREFIX,
    VALID_ACTIONS,
    generate,
    parse,
    validate,
    decodeMemoBytes,
    scanArcMemos,
    incrementalScan,
    getAll,
    getByIntentId,
    getByAction,
    getLastScannedBlock,
    clearCache,
  };
})();

if (typeof window !== 'undefined') {
  window.MemoIndexer = MemoIndexer;
}
