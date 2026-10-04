// muu Worker: 静的 PWA と API を同一オリジンで配信する。API の一覧は docs/design.md 4 章。
import { buildLibrary, etagFor, validName, isTrackKey, lyricsKeyFor, previousAfterMove, COVER_NAME } from './library.mjs';
import { authorize, sameOrigin } from './auth.mjs';
import { readPlays, updateStats, validReport, addReport, moveCount } from './stats.mjs';
import { VERSION, BUILT } from '../public/version.mjs';

const LIBRARY_TTL = 30; // 秒。一覧は R2 の list() を叩き直すより短く保つ。
const MAX_UPLOAD = 95 * 1024 * 1024;
const MAX_LYRICS = 64 * 1024; // 歌詞はテキストだけ。数十 KB あれば足りる。

const json = (body, status = 200, headers = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...headers } });
const fail = (status, error) => json({ error }, status);

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const [, root, ...rest] = url.pathname.split('/');
    try {
      if (root === 'api') return api(request, env, ctx, rest, url);
      if (root === 'media' && rest.length === 1) return media(request, env, decodeURIComponent(rest[0]));
      if (root === 'covers' && rest.length === 1) return cover(request, env, decodeURIComponent(rest[0]));
      if (root === 'lyrics' && rest.length === 1) return lyrics(request, env, decodeURIComponent(rest[0]));
      if (url.pathname === '/version.json') return json({ version: VERSION, built: BUILT }, 200, { 'cache-control': 'no-cache' });
      return env.ASSETS.fetch(request);
    } catch (error) {
      console.error(error);
      return fail(500, 'internal');
    }
  },
};

async function api(request, env, ctx, rest, url) {
  const [resource, ...path] = rest;
  if (resource === 'library' && !path.length) {
    if (request.method !== 'GET') return fail(405, 'method_not_allowed');
    return library(request, env, ctx, url);
  }
  if (resource === 'tracks' && path.length === 1) {
    const key = decodeURIComponent(path[0]);
    if (request.method === 'PUT') return withAuth(request, env, () => uploadTrack(request, env, ctx, key, url));
    if (request.method === 'DELETE') return withAuth(request, env, () => deleteTrack(env, ctx, key, url));
    if (request.method === 'PATCH') return withAuth(request, env, () => editTrack(request, env, ctx, key, url));
    return fail(405, 'method_not_allowed');
  }
  if (resource === 'covers' && path.length === 1) {
    const folder = decodeURIComponent(path[0]);
    if (request.method === 'PUT') return withAuth(request, env, () => uploadCover(request, env, ctx, folder, url));
    return fail(405, 'method_not_allowed');
  }
  if (resource === 'lyrics' && path.length === 1) {
    const key = decodeURIComponent(path[0]);
    if (request.method === 'PUT') return withAuth(request, env, () => uploadLyrics(request, env, ctx, key, url));
    if (request.method === 'DELETE') return withAuth(request, env, () => deleteLyrics(env, ctx, key, url));
    return fail(405, 'method_not_allowed');
  }
  if (resource === 'stats' && !path.length) {
    // 再生数。読むのも数えるのも誰でも（Details で使う）。
    if (request.method !== 'GET') return fail(405, 'method_not_allowed');
    return json(await readPlays(env.MEDIA));
  }
  if (resource === 'plays' && !path.length) {
    if (request.method !== 'POST') return fail(405, 'method_not_allowed');
    return reportPlays(request, env);
  }
  if (resource === 'auth' && !path.length) {
    // パスワードの確認だけ。何も変更しない。
    if (request.method !== 'POST') return fail(405, 'method_not_allowed');
    return withAuth(request, env, () => json({ ok: true }));
  }
  return fail(404, 'not_found');
}

function withAuth(request, env, handler) {
  const result = authorize(request, env.ADMIN_PASSWORD);
  if (!result.ok) return fail(result.status, result.error);
  return handler();
}

// ---- 一覧 ----

const libraryCacheKey = url => new Request(new URL('/api/library', url.origin), { method: 'GET' });

async function listAll(bucket) {
  const objects = [];
  let cursor;
  do {
    const page = await bucket.list({ cursor, include: ['customMetadata'] });
    objects.push(...page.objects);
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);
  return objects;
}

async function library(request, env, ctx, url) {
  const cache = caches.default;
  const cacheKey = libraryCacheKey(url);
  let response = await cache.match(cacheKey);
  if (!response) {
    const tracks = buildLibrary(await listAll(env.MEDIA));
    const etag = await etagFor(tracks);
    response = json({ etag, tracks, used: tracks.reduce((sum, track) => sum + track.size, 0), limit: Number(env.MAX_BUCKET_BYTES) || 0 }, 200, { etag, 'cache-control': `public, max-age=${LIBRARY_TTL}` });
    ctx.waitUntil(cache.put(cacheKey, response.clone()));
  }
  if (request.headers.get('if-none-match') === response.headers.get('etag')) {
    return new Response(null, { status: 304, headers: { etag: response.headers.get('etag') } });
  }
  return response;
}

const forgetLibrary = (ctx, url) => ctx.waitUntil(caches.default.delete(libraryCacheKey(url)));

// ---- 配信 ----

async function media(request, env, key) {
  if (request.method !== 'GET' && request.method !== 'HEAD') return fail(405, 'method_not_allowed');
  if (!isTrackKey(key)) return fail(404, 'not_found');
  const options = { onlyIf: request.headers };
  if (request.headers.has('range')) options.range = request.headers;
  const object = await env.MEDIA.get(key, options);
  if (!object) return fail(404, 'not_found');
  const headers = new Headers();
  object.writeHttpMetadata(headers);
  headers.set('content-type', 'audio/mpeg');
  headers.set('etag', object.httpEtag);
  headers.set('accept-ranges', 'bytes');
  headers.set('cache-control', 'public, max-age=31536000, immutable');
  if (!('body' in object)) return new Response(null, { status: 304, headers });
  if (options.range && object.range) {
    const { offset = 0, length = object.size - offset } = object.range;
    const end = offset + length - 1;
    headers.set('content-range', `bytes ${offset}-${end}/${object.size}`);
    headers.set('content-length', String(length));
    return new Response(request.method === 'HEAD' ? null : object.body, { status: 206, headers });
  }
  headers.set('content-length', String(object.size));
  return new Response(request.method === 'HEAD' ? null : object.body, { status: 200, headers });
}

async function cover(request, env, folder) {
  if (request.method !== 'GET') return fail(405, 'method_not_allowed');
  if (!validName(folder)) return fail(404, 'not_found');
  const object = await env.MEDIA.get(`${folder}/${COVER_NAME}`, { onlyIf: request.headers });
  if (!object) return fail(404, 'not_found');
  const headers = new Headers({ 'content-type': 'image/jpeg', etag: object.httpEtag, 'cache-control': 'public, max-age=3600' });
  if (!('body' in object)) return new Response(null, { status: 304, headers });
  return new Response(object.body, { headers });
}

// 歌詞。曲の ID で引く。無ければ 404。
async function lyrics(request, env, key) {
  if (request.method !== 'GET') return fail(405, 'method_not_allowed');
  const lyricsKey = lyricsKeyFor(key);
  if (!lyricsKey) return fail(404, 'not_found');
  const object = await env.MEDIA.get(lyricsKey, { onlyIf: request.headers });
  if (!object) return fail(404, 'not_found');
  const headers = new Headers({ 'content-type': 'text/plain; charset=utf-8', etag: object.httpEtag, 'cache-control': 'public, max-age=60' });
  if (!('body' in object)) return new Response(null, { status: 304, headers });
  return new Response(object.body, { headers });
}

// ---- 再生数 ----

// 端末が数えた再生回数を受け取る。読み取りと同じく認証なし（聴く人は誰でも数える）。越境要求だけ拒む。
// オフラインで貯めた分もまとめて届く。同じ送信 ID の送り直しは一度だけ数える。
async function reportPlays(request, env) {
  if (!sameOrigin(request)) return fail(403, 'cross_site');
  if (Number(request.headers.get('content-length')) > 64 * 1024) return fail(413, 'too_large');
  let body;
  try { body = await request.json(); } catch { return fail(400, 'invalid_body'); }
  const report = validReport(body);
  if (!report) return fail(400, 'invalid_body');
  await updateStats(env.MEDIA, stats => addReport(stats, report));
  return new Response(null, { status: 204 });
}
// 曲の改名・移動・削除に回数を付いて行かせる。失敗しても曲の操作は取り消さない。
const followStats = async (env, from, to) => { try { await updateStats(env.MEDIA, stats => moveCount(stats, from, to)); } catch (error) { console.error(error); } };

// ---- 書き込み ----

async function uploadTrack(request, env, ctx, key, url) {
  if (!isTrackKey(key)) return fail(400, 'invalid_key');
  const [folder, file] = key.split('/');
  if (!validName(folder) || !validName(file, { extension: 'mp3' })) return fail(400, 'invalid_key');
  // ヘッダは ASCII に限られるため、クライアントは title を URL エンコードして送る。
  let title = '';
  try { title = decodeURIComponent(request.headers.get('x-title') || '').trim(); } catch { return fail(400, 'invalid_title'); }
  const duration = Number(request.headers.get('x-duration'));
  const size = Number(request.headers.get('content-length'));
  if (!title || title.length > 200) return fail(400, 'invalid_title');
  if (!Number.isFinite(duration) || duration <= 0) return fail(400, 'invalid_duration');
  if (!size || size > MAX_UPLOAD) return fail(413, 'too_large');
  if (await env.MEDIA.head(key)) return fail(409, 'exists');
  const limit = Number(env.MAX_BUCKET_BYTES);
  if (limit) {
    const used = (await listAll(env.MEDIA)).reduce((sum, object) => sum + object.size, 0);
    if (used + size > limit) return json({ error: 'storage_full', used, limit }, 507);
  }
  const uploadedAt = new Date().toISOString();
  await env.MEDIA.put(key, request.body, {
    httpMetadata: { contentType: 'audio/mpeg' },
    customMetadata: { title, duration: String(Math.round(duration)), uploadedAt },
  });
  forgetLibrary(ctx, url);
  return json({ id: key, folder, title, duration: Math.round(duration), size, uploadedAt }, 201);
}

async function uploadCover(request, env, ctx, folder, url) {
  if (!validName(folder)) return fail(400, 'invalid_key');
  const type = request.headers.get('content-type') || '';
  const size = Number(request.headers.get('content-length'));
  if (!/^image\/jpe?g$/.test(type)) return fail(415, 'jpeg_only');
  if (!size || size > 5 * 1024 * 1024) return fail(413, 'too_large');
  await env.MEDIA.put(`${folder}/${COVER_NAME}`, request.body, { httpMetadata: { contentType: 'image/jpeg' } });
  forgetLibrary(ctx, url);
  return json({ folder }, 201);
}

// 歌詞の登録。本文はプレーンテキスト。空なら削除と同じ。曲が無い歌詞は置かない。
async function uploadLyrics(request, env, ctx, key, url) {
  const lyricsKey = lyricsKeyFor(key);
  if (!lyricsKey) return fail(400, 'invalid_key');
  const size = Number(request.headers.get('content-length'));
  if (size > MAX_LYRICS) return fail(413, 'too_large');
  const text = (await request.text()).replace(/\r\n?/g, '\n').trim();
  if (text.length > MAX_LYRICS) return fail(413, 'too_large');
  if (!text) return deleteLyrics(env, ctx, key, url);
  if (!(await env.MEDIA.head(key))) return fail(404, 'not_found');
  await env.MEDIA.put(lyricsKey, text, { httpMetadata: { contentType: 'text/plain; charset=utf-8' } });
  forgetLibrary(ctx, url);
  return json({ id: key, lyrics: true }, 201);
}

async function deleteLyrics(env, ctx, key, url) {
  const lyricsKey = lyricsKeyFor(key);
  if (!lyricsKey) return fail(400, 'invalid_key');
  await env.MEDIA.delete(lyricsKey);
  forgetLibrary(ctx, url);
  return new Response(null, { status: 204 });
}

// 曲名の変更とフォルダの移動。本文 = { to: 新しい key, title }。
// R2 に移動は無いので、写してから元を消す。歌詞（.txt）も一緒に移す。uploadedAt は保つ。
// 新しい曲の customMetadata.previous に元の key を残し、端末が保存・プレイリスト・キューを付け替えられるようにする。
async function editTrack(request, env, ctx, key, url) {
  if (!isTrackKey(key)) return fail(400, 'invalid_key');
  let body;
  try { body = await request.json(); } catch { return fail(400, 'invalid_body'); }
  const to = String(body?.to || '');
  const title = String(body?.title || '').trim();
  if (!isTrackKey(to)) return fail(400, 'invalid_key');
  const [folder, file] = to.split('/');
  if (!validName(folder) || !validName(file, { extension: 'mp3' })) return fail(400, 'invalid_key');
  if (!title || title.length > 200) return fail(400, 'invalid_title');
  const moved = to !== key;
  if (moved && (await env.MEDIA.head(to))) return fail(409, 'exists');
  const source = await env.MEDIA.get(key);
  if (!source) return fail(404, 'not_found');
  const meta = source.customMetadata || {};
  if (!moved && meta.title === title) { await source.body.cancel(); return json({ id: key, folder, title }); }
  const customMetadata = { ...meta, title };
  if (moved) customMetadata.previous = previousAfterMove(key, meta.previous, to);
  await env.MEDIA.put(to, source.body.pipeThrough(new FixedLengthStream(source.size)), { httpMetadata: source.httpMetadata, customMetadata });
  if (moved) {
    const words = await env.MEDIA.get(lyricsKeyFor(key));
    if (words) await env.MEDIA.put(lyricsKeyFor(to), await words.text(), { httpMetadata: words.httpMetadata });
    await env.MEDIA.delete([key, lyricsKeyFor(key)]);
    await followStats(env, key, to);
  }
  forgetLibrary(ctx, url);
  return json({ id: to, folder, title });
}

async function deleteTrack(env, ctx, key, url) {
  if (!isTrackKey(key)) return fail(400, 'invalid_key');
  // 歌詞は曲の付随物。曲と一緒に消す。
  await env.MEDIA.delete([key, lyricsKeyFor(key)]);
  await followStats(env, key, null);
  forgetLibrary(ctx, url);
  return new Response(null, { status: 204 });
}
