import { describe, it, expect } from 'vitest';
import { createSecretRecord, verifySecret, fingerprintOf, publicSecretView } from '../../functions/api/core/application-secret.mjs';

describe('Core API — application secret (hashed, never plaintext)', () => {
  it('creates a record that never contains the plaintext', async () => {
    const rec = await createSecretRecord('super-secret-value');
    expect(rec.hash).toBeTruthy();
    expect(rec.salt).toBeTruthy();
    expect(JSON.stringify(rec).includes('super-secret-value')).toBe(false);
    expect(rec.fingerprint.startsWith('fp_')).toBe(true);
    expect(rec.status).toBe('active');
  });

  it('verifies the correct secret and rejects wrong ones', async () => {
    const rec = await createSecretRecord('correct-horse-battery');
    expect(await verifySecret('correct-horse-battery', rec)).toBe(true);
    expect(await verifySecret('wrong', rec)).toBe(false);
    expect(await verifySecret('', rec)).toBe(false);
  });

  it('fails closed on malformed records', async () => {
    expect(await verifySecret('x', null)).toBe(false);
    expect(await verifySecret('x', { hash: 'a' })).toBe(false);
  });

  it('rejects short secrets at creation', async () => {
    await expect(createSecretRecord('short')).rejects.toThrow();
  });

  it('rejects verification when status is not active', async () => {
    const rec = await createSecretRecord('another-secret-value', { status: 'revoked' });
    expect(await verifySecret('another-secret-value', rec)).toBe(false);
  });

  it('publicSecretView exposes only fingerprint/status/dates (no hash/salt)', async () => {
    const rec = await createSecretRecord('another-secret-value');
    const view = publicSecretView(rec);
    expect(view.hash).toBeUndefined();
    expect(view.salt).toBeUndefined();
    expect(view.fingerprint).toBe(rec.fingerprint);
  });

  it('fingerprintOf is deterministic', () => {
    expect(fingerprintOf('abcdef0123456789')).toBe(fingerprintOf('abcdef0123456789'));
  });
});
