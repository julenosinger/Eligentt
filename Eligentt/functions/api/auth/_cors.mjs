// SECURITY: CORS allowlist for /api/auth/* — replaces the previous wildcard '*'.
// Allowed origins come from env (APP_ORIGINS or ALLOWED_ORIGINS, comma-separated)
// and default to the production app origin. localhost is allowed only in dev,
// gated behind env.ALLOW_LOCALHOST === 'true'.
//
// Note: same-origin requests (the app itself, served from the app origin) are
// unaffected — CORS only restricts cross-origin browsers.

const DEFAULT_ORIGINS = ['https://elligente.pages.dev'];

function isLocalhost(origin) {
  return /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin);
}

export function getAuthCors(request, env) {
  const configured = ((env && (env.APP_ORIGINS || env.ALLOWED_ORIGINS)) || '')
    .split(',').map(s => s.trim()).filter(Boolean);
  const allowed = configured.length ? configured : DEFAULT_ORIGINS.slice();

  const origin = (request && request.headers && request.headers.get('Origin')) || '';

  let allowOrigin = allowed[0];
  if (origin && allowed.includes(origin)) {
    allowOrigin = origin;
  } else if (origin && env && env.ALLOW_LOCALHOST === 'true' && isLocalhost(origin)) {
    allowOrigin = origin;
  }

  return {
    'Access-Control-Allow-Origin': allowOrigin,
    'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Content-Type': 'application/json',
    'Vary': 'Origin',
  };
}
