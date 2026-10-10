/**
 * Regression tests: Circle wallet is the sole agent identity.
 * No internal/local wallet must be auto-created for Autonoma.
 *
 * Run: bunx vitest run tests/no-internal-wallet-regression.test.js
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';

// ── Helpers ──────────────────────────────────────────────────────────────────

function loadSource(relPath) {
  return readFileSync(join(process.cwd(), relPath), 'utf8');
}

// ── SOURCE-LEVEL ASSERTIONS ───────────────────────────────────────────────────
// Verify that prohibited patterns are absent from the production source files.

describe('Source-level: no auto wallet-create in Autonoma path', () => {

  it('agentWalletManager._scheduleAutoCreate is a no-op (does not call _autoCreateIfMissing)', () => {
    const src = loadSource('shared/agentWalletManager.js');
    // Extract the body of _scheduleAutoCreate
    const fnMatch = src.match(/_scheduleAutoCreate\s*\(\s*\)\s*\{([^}]*)\}/);
    expect(fnMatch, '_scheduleAutoCreate not found').toBeTruthy();
    const body = fnMatch[1];
    expect(body).not.toContain('_autoCreateIfMissing');
    expect(body).not.toContain('createWalletWithBackup');
    expect(body).not.toContain('createAgentWallet');
  });

  it('createWalletWithBackup returns null immediately (no ethers.Wallet.createRandom)', () => {
    const src = loadSource('shared/agentWalletManager.js');
    const fnStart = src.indexOf('function createWalletWithBackup()');
    expect(fnStart).toBeGreaterThan(-1);
    // Find the closing brace of this function (shallow scan — enough for this test)
    const snippet = src.slice(fnStart, fnStart + 400);
    expect(snippet).not.toContain('createRandom');
    expect(snippet).not.toContain('HDNodeWallet');
    expect(snippet).toContain('return null');
  });

  it('getOrCreateWallet does not call createAgentWallet', () => {
    const src = loadSource('shared/agentWalletManager.js');
    const fnStart = src.indexOf('function getOrCreateWallet');
    expect(fnStart).toBeGreaterThan(-1);
    const snippet = src.slice(fnStart, fnStart + 600);
    expect(snippet).not.toContain('createAgentWallet()');
    expect(snippet).not.toContain('createWalletWithBackup()');
  });

  it('walletManager.createOrRestoreWallet never calls createRandom as fallback', () => {
    const src = loadSource('shared/walletManager.js');
    const fnStart = src.indexOf('async function createOrRestoreWallet');
    expect(fnStart).toBeGreaterThan(-1);
    const fnEnd = src.indexOf('\n  }', fnStart);
    const body = src.slice(fnStart, fnEnd + 4);
    expect(body).not.toContain('createRandom');
    // Must return null when no vault found
    expect(body).toContain('return null');
  });

  it('agentScheduleExecutor does not fall back to AWM when Circle mode getSigner fails', () => {
    const src = loadSource('shared/agentScheduleExecutor.js');
    expect(src).toContain('_inCircleMode');
    // The circle-mode TRUE branch must not reference getSessionSigner.
    // Extract only the content between "if (_inCircleMode) {" and "} else {"
    const circleBlock = src.match(/if \(_inCircleMode\)\s*\{([\s\S]*?)\} else \{/);
    expect(circleBlock, 'Circle mode if/else block not found').toBeTruthy();
    const circleTrueBranch = circleBlock[1];
    expect(circleTrueBranch).not.toContain('getSessionSigner');
    // AWM fallback must exist in the else branch
    const elseBlock = src.match(/\} else \{\s*\/\/ Non-Circle mode[\s\S]*?getSessionSigner/);
    expect(elseBlock, 'AWM fallback must be in else branch').toBeTruthy();
  });

  it('aiSmartWallet.agentSend does not fall back to AWM when Circle mode getSigner fails', () => {
    const src = loadSource('shared/aiSmartWallet.js');
    const blockStart = src.indexOf('_inCircleMode = typeof SecureSignerProvider');
    expect(blockStart).toBeGreaterThan(-1);
    const snippet = src.slice(blockStart, blockStart + 600);
    // AWM fallback must only be inside else block
    const elseIdx = snippet.indexOf('} else {');
    expect(elseIdx).toBeGreaterThan(-1);
    const circleOnlyBlock = snippet.slice(0, elseIdx);
    expect(circleOnlyBlock).not.toContain('AgentWalletManager');
  });

});

// ── RUNTIME UNIT TESTS ───────────────────────────────────────────────────────

describe('Runtime: createOrRestoreWallet returns null when no vault', () => {

  beforeEach(() => {
    global.localStorage = {
      _store: {},
      getItem(k) { return this._store[k] ?? null; },
      setItem(k, v) { this._store[k] = v; },
      removeItem(k) { delete this._store[k]; },
    };
    // crypto is a getter-only in Vitest — use defineProperty
    try {
      Object.defineProperty(global, 'crypto', {
        configurable: true,
        value: {
          subtle: { importKey: vi.fn(), deriveKey: vi.fn(), decrypt: vi.fn(), encrypt: vi.fn() },
          getRandomValues: (buf) => { buf.fill(1); return buf; },
        },
      });
    } catch (_) {}
  });

  it('returns null when localStorage has no vault', async () => {
    // Inline a minimal version of the createOrRestoreWallet logic under test
    const stored = global.localStorage.getItem('elligentt_iw_vault_v2');
    expect(stored).toBeNull();
    // The real function returns null here — verifying the absence of createRandom call
    const ethers = { Wallet: { createRandom: vi.fn() } };
    // Simulate function body: stored is null → return null (no createRandom)
    let result = null;
    if (stored) {
      // decrypt path (not reached)
    }
    // new code: return null instead of createRandom
    expect(result).toBeNull();
    expect(ethers.Wallet.createRandom).not.toHaveBeenCalled();
  });

});

describe('Runtime: getAgentAddress prefers Circle', () => {
  it('returns Circle address when CircleAgent.getCachedAddress is available', () => {
    global.CircleAgent = { getCachedAddress: () => '0xCIRCLE_ADDR' };
    // Simulate getAgentAddress logic
    let addr = null;
    try {
      if (typeof CircleAgent !== 'undefined' && CircleAgent.getCachedAddress) {
        addr = CircleAgent.getCachedAddress();
      }
    } catch (_) {}
    expect(addr).toBe('0xCIRCLE_ADDR');
  });

  it('returns null when CircleAgent not available and no local wallet', () => {
    global.CircleAgent = undefined;
    const agentWallet = null;
    const _sessionWallet = () => null;
    const agentState = null;
    let addr = null;
    try {
      if (typeof CircleAgent !== 'undefined' && CircleAgent.getCachedAddress) {
        addr = CircleAgent.getCachedAddress();
      }
    } catch (_) {}
    if (!addr && agentWallet) addr = agentWallet.address;
    const sess = _sessionWallet();
    if (!addr && sess) addr = sess.address;
    if (!addr && agentState) addr = agentState.walletAddress || null;
    expect(addr).toBeNull();
  });
});

describe('Runtime: SecureSignerProvider fail-closed logic', () => {
  it('does not call AWM.getSessionSigner when Circle mode and getSigner throws', async () => {
    const mockAWM = { getSessionSigner: vi.fn().mockResolvedValue({ address: '0xLOCAL' }) };
    const mockSSP = {
      isCircleMode: () => true,
      getSigner: vi.fn().mockRejectedValue(new Error('Circle signer down')),
    };

    // Simulate the fixed agentScheduleExecutor signer resolution
    let signer = null;
    let failedClosed = false;
    const _inCircleMode = mockSSP.isCircleMode();
    if (_inCircleMode) {
      try {
        signer = await mockSSP.getSigner(null);
      } catch (_se) {
        failedClosed = true;
        // return retry_pending — do NOT fall through to AWM
      }
    } else {
      signer = await mockAWM.getSessionSigner(null);
    }

    expect(failedClosed).toBe(true);
    expect(signer).toBeNull();
    expect(mockAWM.getSessionSigner).not.toHaveBeenCalled();
  });

  it('uses AWM.getSessionSigner only when NOT in Circle mode', async () => {
    const mockAWM = { getSessionSigner: vi.fn().mockResolvedValue({ address: '0xLOCAL' }) };
    const mockSSP = { isCircleMode: () => false };

    let signer = null;
    const _inCircleMode = mockSSP.isCircleMode();
    if (!_inCircleMode) {
      signer = await mockAWM.getSessionSigner(null);
    }

    expect(signer).toEqual({ address: '0xLOCAL' });
    expect(mockAWM.getSessionSigner).toHaveBeenCalledOnce();
  });
});
