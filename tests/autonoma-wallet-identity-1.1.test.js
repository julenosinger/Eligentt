/**
 * Autonoma Wallet Identity 1.1 — Clean Release & Legacy Signer Isolation.
 * ═══════════════════════════════════════════════════════════════════════════════
 * Locks in the corrections for the 1.1 phase:
 *   I1. `activateFromAuth()` never activates the legacy custodial wallet as the
 *       app-wide "internal" wallet identity (no window.walletAddress / signer /
 *       activeWalletType mutation).
 *   I2. The x402/relayer flow still resolves the custodial remote signer
 *       on-demand from AuthManager (signing mechanism preserved), and never
 *       overrides an external wallet.
 *   I3. Provisioning uses a durable state machine (provisioning/done/ambiguous)
 *       with reconciliation — no blind re-create on an ambiguous Circle outcome.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(__dirname, '..');
function src(rel) { return fs.readFileSync(path.join(ROOT, rel), 'utf8'); }

describe('I1 — activateFromAuth no longer activates the internal wallet', () => {
  it('returns false without mutating global wallet state', () => {
    const s = src('shared/walletManager.js');
    const fn = s.slice(s.indexOf('function activateFromAuth()'), s.indexOf('function registerExternalWallet'));
    expect(fn).toContain('return false');
    expect(fn).not.toContain("window.walletAddress = walletAddr");
    expect(fn).not.toContain("window.signer = remoteSigner");
    expect(fn).not.toContain("activeWalletType = 'intelligent'");
  });
});

describe('I2 — x402/relayer signing preserved (on-demand remote signer)', () => {
  it('AuthManager still exposes the remote signer + server signing (x402 compat)', () => {
    const a = src('shared/auth.js');
    expect(a).toContain('function getRemoteSigner()');
    expect(a).toContain('getRemoteSigner,');
    expect(a).toContain('signOnServer,');
    expect(a).toContain('_buildRemoteSigner');
  });

  it('_signRelayerAuth resolves the remote signer from AuthManager when no other signer', () => {
    const s = src('index.html');
    const fn = s.slice(s.indexOf('async function _signRelayerAuth'), s.indexOf('function _signRelayerAuth') + s.slice(s.indexOf('async function _signRelayerAuth')).indexOf('FulfillerEngine'));
    expect(fn).toContain('AuthManager.getRemoteSigner()');
    expect(fn).toContain('let isRemote');
    // Fallback must be gated on the absence of any signer (never override external).
    expect(fn).toContain('if (!signer && typeof AuthManager !== \'undefined\'');
  });

  it('_signRelayerAuth never overrides an external wallet with the remote signer', () => {
    const s = src('index.html');
    // The fallback is `if (!signer ...)`, i.e. only when no signer at all.
    expect(s).toContain("if (!signer && typeof AuthManager !== 'undefined' && typeof AuthManager.getRemoteSigner === 'function')");
  });
});

describe('I3 — provisioning state machine (no duplicate on ambiguous outcome)', () => {
  it('reconciles a durable done state before provisioning', () => {
    const s = src('functions/api/agent/provision.js');
    expect(s).toContain("const stateKey = 'provision_state:' + user.id");
    expect(s).toContain("st.status === 'done' && st.walletId && st.address");
    expect(s).toContain('alreadyProvisioned: true, walletId: st.walletId');
  });

  it('returns 409 while a fresh provisioning is in flight', () => {
    const s = src('functions/api/agent/provision.js');
    expect(s).toContain("st.status === 'provisioning'");
    expect(s).toContain('120000');
  });

  it('records ambiguous (never blindly re-creates) when Circle creation fails', () => {
    const s = src('functions/api/agent/provision.js');
    expect(s).toContain("status: 'ambiguous'");
    expect(s).toContain('reconcile: true');
    // Must NOT fall through to create a replacement wallet on failure.
    const catchBlock = s.slice(s.indexOf('} catch (e) {', s.indexOf("circleWallet = await createUserWallet")), s.indexOf('return json({ ok: false, error: \'Circle wallet provisioning failed'));
    expect(catchBlock).not.toContain('await createUserWallet');
  });

  it('deterministic idempotency keys remain the authoritative dedupe', () => {
    const c = src('functions/api/agent-signer/_circle.js');
    expect(c).toContain("idempotencyKey: await deterministicUUID('elligentt:provision-wallet:' + userId)");
  });
});
