/**
 * Regression tests: email login must NOT create an internal wallet.
 *
 * Root cause fixed: functions/api/auth/verify.js was calling
 * ethers.Wallet.createRandom() for every new user, storing the private key
 * encrypted in KV and returning the address as profile.wallet.address.
 * This caused the "Internal Smart Wallet" modal on first login.
 *
 * After fix: new users are created with wallet: { address: null, type: 'none' }.
 * Circle wallet is provisioned separately via POST /api/agent/provision.
 */

import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(__dirname, '..');

function loadSource(rel) {
  return fs.readFileSync(path.join(ROOT, rel), 'utf8');
}

// ─────────────────────────────────────────────────────────────────────────────
describe('verify.js: new user created without internal wallet', () => {

  it('does not call ethers.Wallet() or createRandom() for new user registration', () => {
    const src = loadSource('functions/api/auth/verify.js');
    // The new-user block must not contain ethers.Wallet or createRandom
    // Extract the else block (new user path)
    const elseBlock = src.match(/\} else \{[\s\S]*?step:new_user_no_internal_wallet[\s\S]*?\n  \}/);
    expect(elseBlock, 'new user else block not found').toBeTruthy();
    const elseBody = elseBlock[0];
    expect(elseBody).not.toContain('ethers.Wallet');
    expect(elseBody).not.toContain('createRandom');
    expect(elseBody).not.toContain('getRandomValues(new Uint8Array(20))'); // old fake address gen
    expect(elseBody).not.toContain('privKeyBytes');
  });

  it('new user wallet object has address: null and type: none', () => {
    const src = loadSource('functions/api/auth/verify.js');
    // The user object in the new-user block must set address: null
    expect(src).toContain("address: null");
    expect(src).toContain("type: 'none'");
  });

  it('new user block logs step:new_user_no_internal_wallet (not wallet_create_start)', () => {
    const src = loadSource('functions/api/auth/verify.js');
    expect(src).toContain('step:new_user_no_internal_wallet');
    // The old wallet creation step must not exist in the new-user path
    // (it was removed; it may still appear in comments but not in active code)
    const elseBlock = src.match(/\} else \{[\s\S]*?step:new_user_no_internal_wallet[\s\S]*?\n  \}/);
    expect(elseBlock[0]).not.toContain('step:wallet_create_start');
  });

  it('Circle provision block still present and unchanged', () => {
    const src = loadSource('functions/api/auth/verify.js');
    // Auto-provision block must still be there for Circle wallet
    expect(src).toContain('step:circle_create_start');
    expect(src).toContain('createUserWallet');
    expect(src).toContain('circleWalletId');
    expect(src).toContain('circleWalletAddress');
  });

  it('response profile includes circleWallet field', () => {
    const src = loadSource('functions/api/auth/verify.js');
    expect(src).toContain('circleWallet: user.circleWalletId');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('auth.js: _buildRemoteSigner safe when wallet.address is null', () => {

  it('_buildRemoteSigner returns early when wallet.address is falsy', () => {
    const src = loadSource('shared/auth.js');
    // Guard must be present before using the address
    expect(src).toContain("if (!_profile || !_profile.wallet || !_profile.wallet.address) return");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('walletManager.js: activateFromAuth safe when no remote signer', () => {

  it('activateFromAuth returns false when remoteSigner or walletAddr is missing', () => {
    const src = loadSource('shared/walletManager.js');
    expect(src).toContain('if (!remoteSigner || !walletAddr) return false');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('index.html: auth complete flow does not force-create wallet', () => {

  it('_authCompleteLogin calls activateFromAuth (not createOrRestoreWallet)', () => {
    const src = loadSource('index.html');
    // Find the _authCompleteLogin function body
    const fnMatch = src.match(/function _authCompleteLogin\(profile\)\s*\{([\s\S]*?)^\}/m);
    // If not found as standalone function, find inline
    const block = fnMatch ? fnMatch[1] : src.slice(
      src.indexOf('function _authCompleteLogin'),
      src.indexOf('function _authCompleteLogin') + 800
    );
    expect(block).toContain('activateFromAuth');
    expect(block).not.toContain('createOrRestoreWallet');
  });

  it('auto-restore DOMContentLoaded block does not create wallet when Circle active', () => {
    const src = loadSource('index.html');
    // The auto-restore block must check for Circle address before activating local wallet
    expect(src).toContain('CircleAgent.getCachedAddress');
    expect(src).toContain('if (!circleAddr)');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('agentWalletManager.js: no auto-create on init', () => {

  it('_scheduleAutoCreate is a no-op', () => {
    const src = loadSource('shared/agentWalletManager.js');
    const fnMatch = src.match(/function _scheduleAutoCreate\(\)\s*\{([\s\S]*?)\n  \}/);
    expect(fnMatch, '_scheduleAutoCreate not found').toBeTruthy();
    const body = fnMatch[1];
    expect(body).not.toContain('_autoCreateIfMissing');
    expect(body).toContain('no-op');
  });

  it('createWalletWithBackup returns null immediately', () => {
    const src = loadSource('shared/agentWalletManager.js');
    const fnMatch = src.match(/function createWalletWithBackup\(\)\s*\{([\s\S]*?)\n  \}/);
    expect(fnMatch, 'createWalletWithBackup not found').toBeTruthy();
    const body = fnMatch[1];
    expect(body).not.toContain('ethers.Wallet.createRandom');
    expect(body).toContain('return null');
  });

  it('getOrCreateWallet does not call createAgentWallet', () => {
    const src = loadSource('shared/agentWalletManager.js');
    const lines = src.split('\n');
    const start = lines.findIndex(l => l.includes('function getOrCreateWallet'));
    expect(start).toBeGreaterThan(-1);
    // Find the matching closing brace (same indent level)
    let depth = 0, end = start;
    for (let i = start; i < lines.length; i++) {
      depth += (lines[i].match(/\{/g) || []).length;
      depth -= (lines[i].match(/\}/g) || []).length;
      if (i > start && depth <= 0) { end = i; break; }
    }
    const body = lines.slice(start, end + 1).join('\n');
    expect(body).not.toContain('createAgentWallet()');
    // Must have the sentinel added in the fix
    expect(body).toContain('Do NOT auto-create');
    expect(body).toContain('return null');
  });
});
