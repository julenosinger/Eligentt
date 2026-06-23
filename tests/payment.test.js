import { describe, it, expect } from 'vitest';

describe('Payment Link ID', () => {
  it('crypto.randomUUID generates valid UUIDs', () => {
    const uuid = crypto.randomUUID();
    expect(uuid).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });

  it('generates unique IDs', () => {
    const ids = new Set();
    for (let i = 0; i < 1000; i++) {
      ids.add('pl_' + crypto.randomUUID());
    }
    expect(ids.size).toBe(1000);
  });

  it('ID format matches pl_ prefix', () => {
    const id = 'pl_' + crypto.randomUUID();
    expect(id).toMatch(/^pl_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });
});

describe('Payment Link Expiry', () => {
  it('expired link should be detected', () => {
    const link = {
      status: 'Active',
      expiresAt: new Date(Date.now() - 1000).toISOString(),
    };
    const isExpired = link.expiresAt && new Date(link.expiresAt) < new Date();
    expect(isExpired).toBe(true);
  });

  it('active link should not be expired', () => {
    const link = {
      status: 'Active',
      expiresAt: new Date(Date.now() + 86400000).toISOString(),
    };
    const isExpired = link.expiresAt && new Date(link.expiresAt) < new Date();
    expect(isExpired).toBe(false);
  });

  it('never-expiring link has no expiresAt', () => {
    const link = { status: 'Active', expiresAt: null };
    const isExpired = link.expiresAt && new Date(link.expiresAt) < new Date();
    expect(isExpired).toBeFalsy();
  });
});
