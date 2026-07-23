// Public Elligentt Pay checkout route: /pay/:token
// Served by a Pages Function (not a static rewrite) so Cloudflare Pages'
// automatic .html redirect does not strip the dynamic token from the URL.
// Returns the standalone pay.html asset with HTTP 200; the page reads the
// token from window.location.pathname and loads real data from /api/payment/:token.
export async function onRequestGet(context) {
  const origin = new URL(context.request.url).origin;
  let res = await context.env.ASSETS.fetch(origin + '/pay.html');

  // If asset routing returns an HTML auto-redirect, follow it to the canonical path.
  if (res.status >= 300 && res.status < 400) {
    const loc = res.headers.get('Location');
    if (loc) res = await context.env.ASSETS.fetch(new URL(loc, origin).toString());
  }

  return new Response(res.body, {
    status: 200,
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-cache, no-store, must-revalidate',
    },
  });
}
