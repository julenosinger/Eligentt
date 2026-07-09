/**
 * Treasury Core API — WAF-style Request Sanity (Phase 4)
 * ═══════════════════════════════════════════════════════
 * In-Worker complement to Cloudflare WAF. Performs cheap, deterministic checks to
 * reject obviously malformed/abusive requests BEFORE business logic:
 *   - unsupported methods
 *   - oversized bodies (Content-Length)
 *   - malformed / non-JSON content-type on write methods
 *   - malformed correlation / auth headers
 * The authoritative WAF (bots, scanning, flood, geo) is configured at the
 * Cloudflare edge — see documentos/TREASURY_CORE_API_HARDENING.md.
 */

const MAX_BODY_BYTES = 256 * 1024;      // 256 KB
const ALLOWED_METHODS = ['GET', 'POST', 'OPTIONS'];
const HEADER_MAX = 1024;

export function inspectRequest(request) {
  try {
    if (!ALLOWED_METHODS.includes(request.method)) {
      return { ok: false, code: 'WAF_METHOD', message: 'Method not allowed', status: 405 };
    }

    const cl = request.headers.get('Content-Length');
    if (cl && Number(cl) > MAX_BODY_BYTES) {
      return { ok: false, code: 'WAF_PAYLOAD_TOO_LARGE', message: 'Payload too large', status: 413 };
    }

    if (request.method === 'POST' || request.method === 'PUT') {
      const ct = (request.headers.get('Content-Type') || '').toLowerCase();
      if (ct && !ct.includes('application/json')) {
        return { ok: false, code: 'WAF_CONTENT_TYPE', message: 'Content-Type must be application/json', status: 415 };
      }
    }

    // Reject absurdly long / control-char-laden security headers.
    for (const h of ['X-Application-Id', 'X-Nonce', 'X-Signature', 'X-Correlation-ID', 'Correlation-ID']) {
      const v = request.headers.get(h);
      if (v && (v.length > HEADER_MAX || /[\u0000-\u001F\u007F]/.test(v))) {
        return { ok: false, code: 'WAF_BAD_HEADER', message: 'Malformed header: ' + h, status: 400 };
      }
    }

    return { ok: true };
  } catch (e) {
    return { ok: false, code: 'WAF_ERROR', message: 'Request inspection failed', status: 400 };
  }
}

// Cloudflare WAF ruleset blueprint (documentation/reference — applied at edge).
export const CLOUDFLARE_WAF_RULES = Object.freeze([
  { id: 'block-bots', description: 'Block known bots & scanners', expression: '(cf.client.bot) or (cf.threat_score gt 10)', action: 'block' },
  { id: 'rate-flood', description: 'Rate limit floods on /api/core/*', expression: 'starts_with(http.request.uri.path, "/api/core/")', action: 'rate_limit', limit: '600/min' },
  { id: 'require-json', description: 'Reject non-JSON POST bodies', expression: '(http.request.method eq "POST") and not (http.request.headers["content-type"][0] contains "application/json")', action: 'block' },
  { id: 'block-malformed', description: 'Block malformed / missing security headers on signed calls', expression: 'starts_with(http.request.uri.path, "/api/core/") and http.request.headers["x-signature"][0] eq ""', action: 'managed_challenge' },
]);
