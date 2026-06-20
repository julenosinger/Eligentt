import { ethers } from 'ethers';

const AUTH_WINDOW_MS = 300000;

export async function verifyRelayerAuth(body, kv) {
  const { auth } = body || {};
  if (!auth || typeof auth !== 'object') {
    return { valid: false, error: 'Missing auth object' };
  }

  const { address, message, signature, timestamp, nonce } = auth;

  if (!address || !message || !signature || !timestamp || !nonce) {
    return { valid: false, error: 'Incomplete auth: address, message, signature, timestamp, nonce required' };
  }

  if (typeof address !== 'string' || !/^0x[0-9a-fA-F]{40}$/.test(address)) {
    return { valid: false, error: 'Invalid address format' };
  }

  if (typeof timestamp !== 'number' || !Number.isFinite(timestamp)) {
    return { valid: false, error: 'Invalid timestamp' };
  }

  const now = Date.now();
  const diff = Math.abs(now - timestamp);
  if (diff > AUTH_WINDOW_MS) {
    return { valid: false, error: 'Timestamp expired (max ' + (AUTH_WINDOW_MS / 1000) + 's)' };
  }

  const expectedPrefix = 'Elligentt Relayer Authorization';
  if (typeof message !== 'string' || !message.startsWith(expectedPrefix)) {
    return { valid: false, error: 'Invalid message format' };
  }

  let recovered;
  try {
    recovered = ethers.verifyMessage(message, signature);
  } catch (e) {
    return { valid: false, error: 'Signature verification failed: ' + (e.message || '') };
  }

  if (recovered.toLowerCase() !== address.toLowerCase()) {
    return { valid: false, error: 'Signature does not match address' };
  }

  if (kv && typeof nonce === 'string' && nonce.length > 0) {
    const nonceKey = 'nonce:relayer:' + nonce;
    try {
      const used = await kv.get(nonceKey);
      if (used) {
        return { valid: false, error: 'Nonce already used (replay attack)' };
      }
      await kv.put(nonceKey, '1', { expirationTtl: 600 });
    } catch (_) {}
  }

  return { valid: true, address: recovered };
}
