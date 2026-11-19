/**
 * Autonoma Wallet Identity 1.0 — Circle-only agent wallet regression guards.
 * ═══════════════════════════════════════════════════════════════════════════════
 * Locks in the corrections:
 *   L1. Password login returns the per-user Circle wallet identity (parity with
 *       verify.js) and persists circleWalletId/Address in the session.
 *   L2. Circle wallet provisioning uses a DETERMINISTIC idempotency key derived
 *       from the user id (no randomUUID → no duplicate wallets on retry/race).
 *   L3. The provision endpoint serializes concurrent provisioning with a KV
 *       lock and fails closed (409) while in flight.
 *   L4. The auth-success modal presents the Circle wallet identity and never
 *       falls back to an "Internal Smart Wallet" label.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(__dirname, '..');
function src(rel) { return fs.readFileSync(path.join(ROOT, rel), 'utf8'); }

describe('L1 — login.js returns Circle identity (parity with verify.js)', () => {
  it('persists circleWalletId + circleWalletAddress in the session', () => {
    const s = src('functions/api/auth/login.js');
    const sessionBlock = s.slice(s.indexOf('KV.put(`session:${sessionToken}`'), s.indexOf('console.log(\'[AUTH] password login successful\')'));
    expect(sessionBlock).toContain('circleWalletId: user.circleWalletId || null');
    expect(sessionBlock).toContain('circleWalletAddress: user.circleWalletAddress || null');
  });

  it('returns profile.circleWallet { id, address }', () => {
    const s = src('functions/api/auth/login.js');
    expect(s).toContain('circleWallet: user.circleWalletId ? {');
    expect(s).toContain('id: user.circleWalletId');
    expect(s).toContain('address: user.circleWalletAddress');
  });
});

describe('L2 — createUserWallet uses deterministic idempotency key', () => {
  it('wallet creation idempotencyKey derives from user id (no randomUUID)', () => {
    const s = src('functions/api/agent-signer/_circle.js');
    expect(s).toContain("idempotencyKey: await deterministicUUID('elligentt:provision-wallet:' + userId)");
    // The wallet-body idempotencyKey must NOT be a fresh random UUID anymore.
    const walletBody = s.slice(s.indexOf('// ── Step 2: Create wallet'), s.indexOf('const resp = await fetch(W3S_BASE + \'/developer/wallets\''));
    expect(walletBody).not.toMatch(/idempotencyKey:\s*randomUUID\(\)/);
  });

  it('wallet-set creation idempotencyKey derives from user id', () => {
    const s = src('functions/api/agent-signer/_circle.js');
    expect(s).toContain("idempotencyKey: await deterministicUUID('elligentt:provision-walletset:' + userId)");
  });
});

describe('L3 — provision.js serializes concurrent provisioning', () => {
  it('uses a per-user KV lock and fails closed while in flight', () => {
    const s = src('functions/api/agent/provision.js');
    expect(s).toContain("const lockKey = 'provision_lock:' + user.id");
    expect(s).toContain("'Wallet provisioning already in progress'");
    expect(s).toContain('inProgress: true');
    expect(s).toContain('expirationTtl: 60');
  });

  it('releases the lock on success and on every failure path', () => {
    const s = src('functions/api/agent/provision.js');
    // Three release sites: create failure, KV-save failure, success.
    expect(s.match(/KV\.delete\(lockKey\)/g).length).toBeGreaterThanOrEqual(3);
  });
});

describe('L4 — auth-success modal prefers Circle identity', () => {
  it('reads profile.circleWallet.address as the authoritative address', () => {
    const s = src('index.html');
    expect(s).toContain('profile.circleWallet && profile.circleWallet.address');
  });

  it('assigns a Circle label, never a legacy "Internal Smart Wallet" fallback', () => {
    const s = src('index.html');
    const fn = s.slice(s.indexOf('function _authCompleteLogin'), s.indexOf('function authFinish'));
    expect(fn).toContain("'Circle Developer-Controlled'");
    expect(fn).toContain("'Not provisioned'");
    // The legacy fallback expression must be gone from the runtime assignment.
    expect(fn).not.toContain("profile.wallet.type || 'Internal Smart Wallet'");
  });

  it('removes the static "Internal Smart Wallet" placeholder from the modal HTML', () => {
    const s = src('index.html');
    expect(s).not.toContain('<span class="value purple">Internal Smart Wallet</span>');
  });
});
