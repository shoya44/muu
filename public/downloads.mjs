import { AUDIO_CACHE, COVER_CACHE, LYRICS_CACHE } from './storage.mjs';
import { mediaURL, coverURL, lyricsURL } from './library.mjs';

// 歌詞も付随物。無ければ何もしない。失敗しても保存済みを取り消さない。
export async function saveLyrics(track, signal) {
  if (!track.lyrics) return false;
  try {
    const cache = await caches.open(LYRICS_CACHE);
    const response = await fetch(lyricsURL(track), { signal, cache: 'no-store' });
    if (!response.ok) return false;
    await cache.put(lyricsURL(track), response);
    return true;
  } catch { return false; }
}

// カバーは付随物。音声の後に取り、失敗しても保存済みを取り消さない。
export async function saveCover(track, signal) {
  const url = coverURL(track);
  if (!url) return false;
  try {
    const cache = await caches.open(COVER_CACHE);
    if (await cache.match(url)) return true;
    const response = await fetch(url, { signal, cache: 'no-store' });
    if (!response.ok || !response.headers.get('content-type')?.startsWith('image/')) return false;
    await cache.put(url, response);
    return true;
  } catch { return false; }
}

// 完全に受信できたときだけ Cache に入る。途中で切れた応答が保存済みになることはない。
export async function saveTrack(track, signal, progress = () => {}) {
  const cache = await caches.open(AUDIO_CACHE);
  const url = mediaURL(track);
  if (await cache.match(url)) { await saveCover(track, signal); await saveLyrics(track, signal); return; }
  // 利用者の中止と無通信タイムアウトのどちらでも止める。AbortSignal.any は iOS 17.4 以降なので使わない。
  const stalled = new AbortController();
  const stop = () => stalled.abort(signal.reason);
  signal.addEventListener('abort', stop, { once: true });
  let timer;
  const touch = () => { clearTimeout(timer); timer = setTimeout(() => stalled.abort(), 30000); };
  touch();
  try {
    // ?download=1 で Service Worker を素通りさせ、部分応答が混ざらないようにする。
    const response = await fetch(`${url}?download=1`, { signal: stalled.signal, cache: 'no-store' });
    if (response.status === 404) throw new Error('Track is no longer available');
    if (response.status !== 200) throw new Error(`Download failed (${response.status})`);
    if (Number(response.headers.get('content-length')) !== track.size) throw new Error('Size mismatch');
    let received = 0;
    const stream = response.body.pipeThrough(new TransformStream({
      transform(chunk, controller) {
        touch(); received += chunk.byteLength;
        if (received > track.size) throw new Error('Size mismatch');
        controller.enqueue(chunk); progress(received);
      },
      flush() { if (received !== track.size) throw new Error('Download incomplete'); },
    }));
    const headers = new Headers({ 'content-type': 'audio/mpeg', 'content-length': String(track.size), 'accept-ranges': 'bytes' });
    await cache.put(url, new Response(stream, { headers }));
    await saveCover(track, signal);
    await saveLyrics(track, signal);
  } catch (error) {
    if (signal.aborted || error.name === 'QuotaExceededError') throw error;
    if (stalled.signal.aborted) throw new Error('Connection stalled');
    if (error instanceof TypeError) throw new Error('Connection lost');
    throw error;
  } finally { clearTimeout(timer); signal.removeEventListener('abort', stop); }
}
