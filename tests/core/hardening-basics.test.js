import { describe, it, expect } from 'vitest';
import { getFlags, isStrictAuth } from '../../functions/api/core/flags.mjs';
import { allowedOrigins, isOriginAllowed, resolveCors } from '../../functions/api/core/cors.mjs';
import { withTimeout, withRetry, timeoutFor, TIMEOUTS } from '../../functions/api/core/timeout.mjs';

describe('Core hardening — feature flags', () => {
  it('defaults are safe/backward-compatible', () => {
    const f = getFlags({});
    expect(f.authMode).toBe('internal');
    expect(f.rateLimitMode).toBe('enforce');
    expect(f.circuitBreaker).toBe(true);
    expect(f.observability).toBe(true);
    expect(f.audit).toBe(true);
  });
  it('honors env overrides', () => {
    const f = getFlags({ AUTH_MODE: 'strict', RATE_LIMIT_MODE: 'off', CIRCUIT_BREAKER: 'off', OBSERVABILITY: 'off', AUDIT: 'off' });
    expect(f.authMode).toBe('strict');
    expect(f.rateLimitMode).toBe('off');
    expect(f.circuitBreaker).toBe(false);
    expect(f.observability).toBe(false);
    expect(f.audit).toBe(false);
    expect(isStrictAuth({ AUTH_MODE: 'strict' })).toBe(true);
  });
});

describe('Core hardening — restricted CORS', () => {
  it('never returns "*" and echoes only allowlisted origins', () => {
    const env = { ALLOWED_ORIGINS: 'https://elligente.pages.dev' };
    const req = new Request('https://x/y', { headers: { Origin: 'https://elligente.pages.dev' } });
    const cors = resolveCors(req, env);
    expect(cors['Access-Control-Allow-Origin']).toBe('https://elligente.pages.dev');
    expect(cors['Access-Control-Allow-Origin']).not.toBe('*');
  });
  it('falls back to a first allowlisted origin for unknown origins (never echoes attacker origin)', () => {
    const env = { ALLOWED_ORIGINS: 'https://elligente.pages.dev' };
    const req = new Request('https://x/y', { headers: { Origin: 'https://evil.example' } });
    const cors = resolveCors(req, env);
    expect(cors['Access-Control-Allow-Origin']).not.toBe('https://evil.example');
    expect(cors['Access-Control-Allow-Origin']).not.toBe('*');
  });
  it('includes first-party production domains', () => {
    const list = allowedOrigins({});
    expect(list).toContain('https://execdaat.xyz');
    expect(list).toContain('https://elligentt.xyz');
  });
  it('treats no-Origin (server-to-server) as allowed', () => {
    expect(isOriginAllowed('', {})).toBe(true);
    expect(isOriginAllowed('https://execdaat.xyz', {})).toBe(true);
    expect(isOriginAllowed('https://nope.example', {})).toBe(false);
  });
});

describe('Core hardening — timeouts & safe retry', () => {
  it('resolves per-op timeouts', () => {
    expect(timeoutFor('quote')).toBe(TIMEOUTS.quote);
    expect(timeoutFor('unknown')).toBe(TIMEOUTS.default);
  });
  it('withTimeout resolves fast work', async () => {
    const v = await withTimeout(async () => 7, 1000);
    expect(v).toBe(7);
  });
  it('withTimeout rejects slow work', async () => {
    await expect(withTimeout(() => new Promise(r => setTimeout(() => r(1), 50)), 10, 'slow')).rejects.toThrow(/TIMEOUT/);
  });
  it('withRetry retries then succeeds', async () => {
    let n = 0;
    const r = await withRetry(async () => { n++; if (n < 2) throw new Error('x'); return 'ok'; }, { retries: 3, baseMs: 1 });
    expect(r.ok).toBe(true);
    expect(r.value).toBe('ok');
    expect(r.attempts).toBe(2);
  });
  it('withRetry gives up after retries', async () => {
    const r = await withRetry(async () => { throw new Error('always'); }, { retries: 1, baseMs: 1 });
    expect(r.ok).toBe(false);
    expect(r.attempts).toBe(2);
  });
});
