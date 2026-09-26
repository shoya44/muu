// muu Worker: 静的 PWA と API を同一オリジンで配信する。API は design.md 4 章。
export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/media/') || url.pathname.startsWith('/covers/')) {
      return new Response(JSON.stringify({ error: 'not_implemented' }), {
        status: 501,
        headers: { 'content-type': 'application/json' },
      });
    }
    return env.ASSETS.fetch(request);
  },
};
