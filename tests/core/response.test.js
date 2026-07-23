import { describe, it, expect } from 'vitest';
import { buildEnvelope, maskSensitive, ok, fail, CoreError, coreCors, CORE_API_VERSION } from '../../functions/api/core/response.mjs';

describe('Core API — response envelope', () => {
  const meta = { requestId: 'req_1', correlationId: 'cid_1', version: 'v1' };

  it('builds a consistent success envelope', () => {
    const env = buildEnvelope({ success: true, data: { a: 1 }, meta });
    expect(env.success).toBe(true);
    expect(env.requestId).toBe('req_1');
    expect(env.correlationId).toBe('cid_1');
    expect(env.version).toBe('v1');
    expect(env.data).toEqual({ a: 1 });
    expect(env.errors).toEqual([]);
    expect(typeof env.timestamp).toBe('string');
  });

  it('builds a consistent error envelope with data=null', () => {
    const env = buildEnvelope({ success: false, errors: [{ code: 'X', message: 'y' }], meta });
    expect(env.success).toBe(false);
    expect(env.data).toBeNull();
    expect(env.errors[0].code).toBe('X');
  });

  it('defaults an error when none supplied', () => {
    const env = buildEnvelope({ success: false, meta });
    expect(env.errors.length).toBe(1);
    expect(env.errors[0].code).toBe('ERROR');
  });

  it('masks sensitive keys deeply', () => {
    const masked = maskSensitive({
      ok: 1,
      privateKey: '0xdead',
      nested: { secret: 'abc', token: 't', fine: 'visible', signature: 'sig' },
      arr: [{ apiKey: 'k' }],
    });
    expect(masked.ok).toBe(1);
    expect(masked.privateKey).toBe('***REDACTED***');
    expect(masked.nested.secret).toBe('***REDACTED***');
    expect(masked.nested.token).toBe('***REDACTED***');
    expect(masked.nested.signature).toBe('***REDACTED***');
    expect(masked.nested.fine).toBe('visible');
    expect(masked.arr[0].apiKey).toBe('***REDACTED***');
  });

  it('success envelope masks sensitive data automatically', () => {
    const env = buildEnvelope({ success: true, data: { privateKey: '0xabc', amount: 10 }, meta });
    expect(env.data.privateKey).toBe('***REDACTED***');
    expect(env.data.amount).toBe(10);
  });

  it('ok() and fail() return Response with correlation headers', async () => {
    const r1 = ok({ x: 1 }, meta, 201);
    expect(r1.status).toBe(201);
    expect(r1.headers.get('X-Correlation-ID')).toBe('cid_1');
    const body = await r1.json();
    expect(body.success).toBe(true);

    const r2 = fail([{ code: 'BAD', message: 'no' }], meta, 400);
    expect(r2.status).toBe(400);
    const b2 = await r2.json();
    expect(b2.success).toBe(false);
    expect(b2.errors[0].code).toBe('BAD');
  });

  it('CoreError carries code/status/field and projects to error object', () => {
    const e = new CoreError('INVALID', 'bad field', 422, 'amount');
    expect(e.status).toBe(422);
    expect(e.toError()).toEqual({ code: 'INVALID', message: 'bad field', field: 'amount' });
  });

  it('coreCors echoes allowed origin', () => {
    const req = new Request('https://x/y', { headers: { Origin: 'https://elligente.pages.dev' } });
    const cors = coreCors(req, { ALLOWED_ORIGINS: 'https://elligente.pages.dev' });
    expect(cors['Access-Control-Allow-Origin']).toBe('https://elligente.pages.dev');
    expect(cors['Access-Control-Allow-Headers']).toContain('X-Correlation-ID');
  });

  it('exposes API version v1', () => {
    expect(CORE_API_VERSION).toBe('v1');
  });
});
