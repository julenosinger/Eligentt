/**
 * Cloudflare Pages Function — /api/x402/*  (catch-all)
 * ═══════════════════════════════════════════════════════════════════════
 * Pages Functions route `functions/api/x402/index.js` only to the EXACT path
 * `/api/x402`. This catch-all routes every sub-path (`/api/x402/status`,
 * `/api/x402/discover`, `/api/x402/prepare`, `/api/x402/pay`) to the same
 * handler, mirroring the existing `functions/api/agent/[[path]].js` pattern.
 *
 * Without this file, `/api/x402/*` falls through to the SPA `_redirects`
 * rewrite (`/* → /index.html`) and returns HTML instead of JSON.
 */

export { onRequest } from './index.js';
