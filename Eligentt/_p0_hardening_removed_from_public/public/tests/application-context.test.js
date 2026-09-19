import { describe, it, expect } from 'vitest';
import {
  resolveApplicationContext,
  applicationIdentity,
  applicationMode,
  sanitizeToken,
  APPLICATION_DEFAULTS,
  KNOWN_APPLICATIONS,
} from '../functions/api/application-context.mjs';

describe('Multi-Application — application context resolver', () => {
  it('applies defaults ELLIGENT / default / 1 when nothing is sent (backward compat)', () => {
    const ctx = resolveApplicationContext(undefined, undefined, undefined);
    expect(ctx.application).toBe('ELLIGENT');
    expect(ctx.client).toBe('default');
    expect(ctx.version).toBe('1');
    expect(ctx.environment).toBe('production');
    expect(ctx.known).toBe(true);
  });

  it('defaults exported match ELLIGENT / default / 1', () => {
    expect(APPLICATION_DEFAULTS.application).toBe('ELLIGENT');
    expect(APPLICATION_DEFAULTS.client).toBe('default');
    expect(APPLICATION_DEFAULTS.version).toBe('1');
    expect(KNOWN_APPLICATIONS).toContain('EXECDAAT');
  });

  it('reads explicit flat fields', () => {
    const ctx = resolveApplicationContext({ applicationId: 'execdaat', clientId: 'acme', version: '2' });
    expect(ctx.application).toBe('EXECDAAT');
    expect(ctx.client).toBe('acme');
    expect(ctx.version).toBe('2');
    expect(ctx.known).toBe(true);
  });

  it('reads a nested application object', () => {
    const ctx = resolveApplicationContext({ application: { id: 'ExecDaat', client: 'partner', version: '3' } });
    expect(ctx.application).toBe('EXECDAAT');
    expect(ctx.client).toBe('partner');
    expect(ctx.version).toBe('3');
  });

  it('accepts an unknown future application but marks known=false', () => {
    const ctx = resolveApplicationContext({ applicationId: 'some_new_app' });
    expect(ctx.application).toBe('SOME_NEW_APP');
    expect(ctx.known).toBe(false);
  });

  it('sanitizes the memo delimiter and control characters out of tokens', () => {
    const ctx = resolveApplicationContext({ applicationId: 'EX|EC\u0000DAAT', clientId: 'a|b c' });
    expect(ctx.application.includes('|')).toBe(false);
    expect(ctx.client.includes('|')).toBe(false);
    expect(ctx.client).toBe('ab_c');
  });

  it('caps very long tokens to the configured length', () => {
    const long = 'X'.repeat(200);
    const out = sanitizeToken(long, 'FALLBACK');
    expect(out.length).toBeLessThanOrEqual(32);
  });

  it('falls back when a value is empty/whitespace', () => {
    expect(sanitizeToken('   ', 'FB')).toBe('FB');
    expect(sanitizeToken(null, 'FB')).toBe('FB');
  });

  it('derives origin from the request Origin header when not in body', () => {
    const request = new Request('https://app.local/api/relayer', {
      method: 'POST',
      headers: { Origin: 'https://elligente.pages.dev' },
    });
    const ctx = resolveApplicationContext({}, {}, request);
    expect(ctx.origin).toBe('https://elligente.pages.dev');
  });

  it('honors env overrides for id/client/version', () => {
    const ctx = resolveApplicationContext({}, { APPLICATION_ID: 'EXECDAAT', CLIENT_ID: 'kv', APPLICATION_VERSION: '9' });
    expect(ctx.application).toBe('EXECDAAT');
    expect(ctx.client).toBe('kv');
    expect(ctx.version).toBe('9');
  });

  it('reports CORE mode by default and honors env override', () => {
    expect(applicationMode({})).toBe('CORE');
    expect(applicationMode({ APPLICATION_MODE: 'satellite' })).toBe('SATELLITE');
  });

  it('applicationIdentity returns only the identity triple', () => {
    const id = applicationIdentity(resolveApplicationContext({ applicationId: 'EXECDAAT' }));
    expect(id).toEqual({ application: 'EXECDAAT', client: 'default', version: '1' });
  });
});
