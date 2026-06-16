/**
 * Simple in-memory rate limiter for Cloudflare Pages Functions.
 * Tracks requests per IP using a sliding window.
 * Not persistent across cold starts — provides basic DoS protection.
 */
export class RateLimiter {
  constructor(maxRequests = 30, windowMs = 60000) {
    this.maxRequests = maxRequests;
    this.windowMs = windowMs;
    this.clients = new Map();
  }

  check(ip) {
    const now = Date.now();
    const key = ip || 'unknown';

    if (!this.clients.has(key)) {
      this.clients.set(key, []);
    }

    const timestamps = this.clients.get(key);
    const windowStart = now - this.windowMs;

    while (timestamps.length > 0 && timestamps[0] < windowStart) {
      timestamps.shift();
    }

    if (timestamps.length >= this.maxRequests) {
      return { allowed: false, remaining: 0, reset: Math.ceil((timestamps[0] + this.windowMs - now) / 1000) };
    }

    timestamps.push(now);
    return { allowed: true, remaining: this.maxRequests - timestamps.length, reset: Math.ceil(this.windowMs / 1000) };
  }
}

const relayLimiter = new RateLimiter(20, 60000);
const mintLimiter = new RateLimiter(20, 60000);

export function checkRelayLimit(ip) { return relayLimiter.check(ip); }
export function checkMintLimit(ip)  { return mintLimiter.check(ip); }
