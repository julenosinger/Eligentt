export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === '/register-inbound' && request.method === 'POST') {
      const data = await request.json();
      const id = data.burnTxHash.toLowerCase();
      const record = { ...data, status: 'PENDING_ATTESTATION', createdAt: Date.now() };
      await env.ARC_INBOUND_KV.put('transfer:' + id, JSON.stringify(record), { expirationTtl: 604800 });
      return new Response(JSON.stringify({ success: true }));
    }
    if (url.pathname.startsWith('/transfer/')) {
      const id = url.pathname.split('/')[2];
      const data = await env.ARC_INBOUND_KV.get('transfer:' + id);
      return data ? new Response(data) : new Response('Not found', { status: 404 });
    }
    return new Response('Arc Inbound Relayer');
  },
  async scheduled(event, env) {
    // TODO: poll pending transfers and execute receiveMessage when attestation is ready
    console.log('Relayer tick');
  }
};
