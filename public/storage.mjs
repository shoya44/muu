// 端末内の保存先。IndexedDB は 1 ストア（キー: library, player, playlists, settings）。
// 音声・カバーは Cache Storage。アプリ更新で音声を消さないため、名前にバージョンを含めない。
export const AUDIO_CACHE = 'muu-media-v1';
export const COVER_CACHE = 'muu-covers-v1';
export const LYRICS_CACHE = 'muu-lyrics-v1';
let database;

function openDB() {
  if (!database) database = new Promise((resolve, reject) => {
    const request = indexedDB.open('muu', 1);
    request.onupgradeneeded = () => request.result.createObjectStore('state');
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  return database;
}
export async function readState(key) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const request = db.transaction('state').objectStore('state').get(key);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}
export async function writeState(key, value) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction('state', 'readwrite');
    tx.objectStore('state').put(value, key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error || new Error('Write aborted'));
  });
}

// 保存済みの曲 ID とサイズ。Cache のキーは /media/<encoded id>。
export async function savedTracks() {
  const cache = await caches.open(AUDIO_CACHE);
  const map = new Map();
  for (const request of await cache.keys()) {
    const path = new URL(request.url).pathname;
    if (!path.startsWith('/media/')) continue;
    const id = decodeURIComponent(path.slice('/media/'.length));
    const response = await cache.match(request);
    map.set(id, Number(response?.headers.get('content-length')) || 0);
  }
  return map;
}
// 歌詞は曲の付随物。曲と一緒に消す。
export async function removeSaved(id) {
  await (await caches.open(LYRICS_CACHE)).delete(`/lyrics/${encodeURIComponent(id)}`);
  const cache = await caches.open(AUDIO_CACHE);
  return cache.delete(`/media/${encodeURIComponent(id)}`);
}
// 改名・移動された曲の保存を新しい key へ写す（元は呼び出し側が removeSaved で消す）。
// 写せなければ false。そのときは元を残し、未保存扱いにはしない。
export async function copySaved(from, to) {
  try {
    for (const [name, prefix] of [[AUDIO_CACHE, '/media/'], [LYRICS_CACHE, '/lyrics/']]) {
      const cache = await caches.open(name);
      const response = await cache.match(prefix + encodeURIComponent(from));
      if (response && !(await cache.match(prefix + encodeURIComponent(to)))) await cache.put(prefix + encodeURIComponent(to), response);
    }
    return true;
  } catch { return false; }
}
export async function clearSaved() {
  await caches.delete(LYRICS_CACHE);
  await caches.delete(AUDIO_CACHE);
}
export async function estimate() {
  try { return await navigator.storage?.estimate?.(); } catch { return undefined; }
}
