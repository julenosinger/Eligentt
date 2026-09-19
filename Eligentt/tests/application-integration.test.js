import { describe, it, expect } from 'vitest';
import { onRequest as relayerOnRequest } from '../functions/api/relayer.js';
import { onRequest as mintOnRequest } from '../functions/api/relayer/mint.js';

function post(url, body = {}) {
  return new Request(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

// A truthy dummy key gets past the "key not set" guard; the request is rejected
// earlier by field validation, so no real signer/RPC is ever used.
const ENV = { TURBO_RELAYER_PRIVATE_KEY: '0xdummy' };

describe('Multi-Application — endpoint backward compatibility', () => {
  it('relayer: legacy body (no app fields) still validates the same way', async () => {
    const res = await relayerOnRequest({ request: post('https://app.local/api/relayer', {}), env: ENV });
    const data = await res.json();
    expect(res.status).toBe(400);
    expect(data.error).toContain('Missing fields');
  });

  it('relayer: optional applicationId/clientId/version are accepted (no new rejection)', async () => {
    const res = await relayerOnRequest({
      request: post('https://app.local/api/relayer', { applicationId: 'EXECDAAT', clientId: 'acme', version: '2' }),
      env: ENV,
    });
    const data = await res.json();
    // Still the SAME validation outcome as the legacy body — proving the new
    // fields flow through without changing control flow.
    expect(res.status).toBe(400);
    expect(data.error).toContain('Missing fields');
  });

  it('relayer: kill switch still wins regardless of app fields', async () => {
    const res = await relayerOnRequest({
      request: post('https://app.local/api/relayer', { applicationId: 'EXECDAAT' }),
      env: { RELAYER_KILL_SWITCH: 'true' },
    });
    expect(res.status).toBe(503);
  });

  it('mint: legacy body (no app fields) still validates the same way', async () => {
    const res = await mintOnRequest({ request: post('https://app.local/api/relayer/mint', {}), env: ENV });
    const data = await res.json();
    expect(res.status).toBe(400);
    expect(data.error).toContain('messageBytes');
  });

  it('mint: optional applicationId/clientId/version are accepted (no new rejection)', async () => {
    const res = await mintOnRequest({
      request: post('https://app.local/api/relayer/mint', { applicationId: 'EXECDAAT', clientId: 'acme', version: '2' }),
      env: ENV,
    });
    const data = await res.json();
    expect(res.status).toBe(400);
    expect(data.error).toContain('messageBytes');
  });
});
