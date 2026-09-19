import { describe, it, expect } from 'vitest';
import { onRequest as relayerOnRequest } from '../functions/api/relayer.js';
import { onRequest as mintOnRequest } from '../functions/api/relayer/mint.js';

function postReq(body = {}) {
  return new Request('https://app.local/api/relayer', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

describe('Commit E — relayer kill switch', () => {
  it('relayer returns 503 when RELAYER_KILL_SWITCH=true', async () => {
    const res = await relayerOnRequest({ request: postReq(), env: { RELAYER_KILL_SWITCH: 'true' } });
    expect(res.status).toBe(503);
  });

  it('mint returns 503 when RELAYER_KILL_SWITCH=true', async () => {
    const res = await mintOnRequest({ request: postReq(), env: { RELAYER_KILL_SWITCH: 'true' } });
    expect(res.status).toBe(503);
  });

  it('relayer does NOT return 503 when kill switch is off (config/key path)', async () => {
    // No kill switch, no key -> should be 500 (key missing), proving the switch is the cause of 503.
    const res = await relayerOnRequest({ request: postReq(), env: {} });
    expect(res.status).not.toBe(503);
  });
});
