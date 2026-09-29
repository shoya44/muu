import { parseRange, sliceStream } from './range.mjs';
import { VERSION, BUILT } from './version.mjs';
// アプリ本体はバージョンとデプロイ時刻の名前のキャッシュに入れ、新版が有効になると旧版だけ捨てる。音声・カバーには触れない。
// 同じバージョン番号で出し直しても BUILT が変わるので、古い本体が残らない。
const SHELL = `muu-shell-${VERSION}-${BUILT.replace(/[^0-9]/g, '') || 'dev'}`;
const AUDIO = 'muu-media-v1';
const COVERS = 'muu-covers-v1';
const LYRICS = 'muu-lyrics-v1';
const FILES = ['/', '/index.html', '/styles.css', '/theme.css', '/app.mjs', '/player.mjs', '/storage.mjs', '/downloads.mjs', '/library.mjs', '/playlists.mjs', '/plays.mjs', '/popover.mjs', '/drag.mjs', '/sheet.mjs', '/range.mjs', '/icons.mjs', '/version.mjs', '/manifest.webmanifest', '/icon.svg', '/icon-192.png', '/icon-512.png', '/cover-placeholder.svg'];

// 新版はインストールが済んだら待たずに引き継ぐ。ページ側は制御が移ったのを見て読み込み直す。
// 音声・カバーのキャッシュは別名前空間なので、引き継ぎで失われない。
self.addEventListener('install', event => event.waitUntil(caches.open(SHELL).then(cache => cache.addAll(FILES)).then(() => self.skipWaiting())));
self.addEventListener('activate', event => event.waitUntil((async () => {
  for (const name of await caches.keys()) if (name.startsWith('muu-shell-') && name !== SHELL) await caches.delete(name);
  await self.clients.claim();
})()));
self.addEventListener('message', event => { if (event.data === 'activate-update') self.skipWaiting(); });

self.addEventListener('fetch', event => {
  const url = new URL(event.request.url);
  if (url.origin !== self.location.origin || event.request.method !== 'GET') return;
  if (url.pathname.startsWith('/media/') && !url.searchParams.has('download')) { event.respondWith(media(event.request)); return; }
  if (url.pathname.startsWith('/covers/')) {
    event.respondWith(caches.open(COVERS).then(async cache => (await cache.match(url.pathname)) || fetch(event.request)));
    return;
  }
  // 歌詞はネットワーク優先（管理者が直した歌詞を拾う）。通信できなければ Cache。
  if (url.pathname.startsWith('/lyrics/')) { event.respondWith(lyrics(event.request)); return; }
  if (url.pathname.startsWith('/api/') || url.pathname === '/version.json') return;
  if (event.request.mode === 'navigate') {
    event.respondWith(caches.open(SHELL).then(async cache => (await cache.match('/')) || fetch(event.request)));
    return;
  }
  if (FILES.includes(url.pathname)) {
    event.respondWith(caches.open(SHELL).then(async cache => (await cache.match(url.pathname)) || fetch(event.request)));
  }
});

async function lyrics(request) {
  const cache = await caches.open(LYRICS);
  const path = new URL(request.url).pathname;
  try {
    const response = await fetch(request);
    // 曲が保存済みなら歌詞も端末に置く。後から登録された歌詞も、一度見れば通信なしで読める。
    const wanted = (await cache.match(path)) || (await (await caches.open(AUDIO)).match(path.replace('/lyrics/', '/media/')));
    if (response.ok && wanted) await cache.put(path, response.clone());
    else if (response.status === 404) await cache.delete(path);
    return response;
  } catch {
    return (await cache.match(path)) || new Response('Not saved', { status: 503 });
  }
}

// 保存済みなら Cache から Range 付きで返す。無ければネットワーク（R2 が Range を返す）。
async function media(request) {
  const cached = await (await caches.open(AUDIO)).match(new URL(request.url).pathname);
  if (!cached) {
    try { return await fetch(request); } catch { return new Response('Not saved', { status: 503 }); }
  }
  const size = Number(cached.headers.get('Content-Length'));
  const range = parseRange(request.headers.get('Range'), size);
  if (range?.invalid) return new Response(null, { status: 416, headers: { 'Content-Range': `bytes */${size}` } });
  if (!range) return cached;
  const headers = new Headers(cached.headers);
  headers.set('Content-Range', `bytes ${range.start}-${range.end}/${size}`);
  headers.set('Content-Length', range.end - range.start + 1);
  headers.set('Accept-Ranges', 'bytes');
  return new Response(sliceStream(cached.body, range.start, range.end), { status: 206, headers });
}
