// GatewayOpLock — Worker entry.
// Re-exports the Durable Object class from the shared source so this Worker and the
// Pages Functions stay in lock-step (no duplicated class definition).

export { GatewayOpLock } from '../../functions/api/gateway/gateway-op-lock.do.js';

export default {
  async fetch() {
    return new Response('GatewayOpLock worker — DO only (no public HTTP route).', { status: 404 });
  },
};
