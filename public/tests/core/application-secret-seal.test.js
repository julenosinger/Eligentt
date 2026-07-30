import { describe, it, expect } from 'vitest';
import { sealSecret, openSecret, rotateServiceSecret, hmacSha256Hex, timingSafeEqualHex, publicSecretView } from '../../functions/api/core/application-secret.mjs';

const MASTER = '0x' + 'ab'.repeat(32); // 32-byte hex key

describe('Core hardening — sealed service secrets (AES-GCM)', () => {
  it('seals a secret without exposing plaintext', async () => {
    const rec = await sealSecret('execdaat-shared-secret', MASTER);
    expect(rec.alg).toBe('AES-256-GCM');
    expect(rec.ciphertext).toBeTruthy();
    expect(rec.iv).toBeTruthy();
    expect(JSON.stringify(rec).includes('execdaat-shared-secret')).toBe(false);
    expect(rec.fingerprint.startsWith('fp_')).toBe(true);
  });

  it('opens (decrypts) the sealed secret with the master key', async () => {
    const rec = await sealSecret('my-strong-secret-1', MASTER);
    expect(await openSecret(rec, MASTER)).toBe('my-strong-secret-1');
  });

  it('cannot open with the wrong master key', async () => {
    const rec = await sealSecret('my-strong-secret-1', MASTER);
    expect(await openSecret(rec, '0x' + 'cd'.repeat(32))).toBeNull();
  });

  it('public view strips ciphertext/iv/hash/salt', async () => {
    const rec = await sealSecret('my-strong-secret-1', MASTER);
    const view = publicSecretView(rec);
    expect(view.ciphertext).toBeUndefined();
    expect(view.iv).toBeUndefined();
    expect(view.hash).toBeUndefined();
    expect(view.fingerprint).toBe(rec.fingerprint);
  });

  it('rotates keeping previous within grace, both verifiable', async () => {
    const cur = await sealSecret('secret-v1-value', MASTER);
    const rotated = await rotateServiceSecret(cur, 'secret-v2-value', MASTER, { gracePeriodMs: 60000 });
    expect(await openSecret(rotated, MASTER)).toBe('secret-v2-value');
    expect(rotated.previous).toBeTruthy();
    expect(await openSecret(rotated.previous, MASTER)).toBe('secret-v1-value');
    expect(rotated.lastRotation).toBeTruthy();
  });

  it('HMAC-SHA256 is deterministic and timing-safe comparison works', async () => {
    const a = await hmacSha256Hex('key', 'message');
    const b = await hmacSha256Hex('key', 'message');
    expect(a).toBe(b);
    expect(timingSafeEqualHex(a, b)).toBe(true);
    expect(timingSafeEqualHex(a, a.slice(0, -1) + '0')).toBe(false);
  });
});
