/**
 * Cloudflare Pages Function — Key Injection
 * Intercepts all requests to "/" and serves index.html
 * with API keys injected from Cloudflare environment secrets.
 *
 * Environment Variables required (set in CF Dashboard):
 *   TEST_API_KEY  — Circle API key
 *   KIT_KEY       — Circle App Kit key
 */
export async function onRequest(context) {
  const { request, env, next } = context;
  const url = new URL(request.url);

  // Only intercept root path — everything else falls through to static assets
  if (url.pathname !== '/') {
    return next();
  }

  // Fetch the static index.html from Pages assets
  const response = await next();
  let html = await response.text();

  // Read keys from environment (secrets set in CF Dashboard)
  const kitKey     = env.KIT_KEY     || '';
  const testApiKey = env.TEST_API_KEY || '';

  // Replace placeholders with actual key values
  html = html.replaceAll('__KIT_KEY_PLACEHOLDER__',     kitKey);
  html = html.replaceAll('__TEST_API_KEY_PLACEHOLDER__', testApiKey);

  return new Response(html, {
    status: response.status,
    headers: {
      ...Object.fromEntries(response.headers),
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-cache, no-store, must-revalidate',
    },
  });
}
