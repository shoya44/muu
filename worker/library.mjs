// R2 の一覧を曲一覧へ整形する純粋関数。Worker からもテストからも同じ入力で同じ答えになる。
// key = "<folder>/<file>.mp3" が曲、"<folder>/cover.jpg" がフォルダのカバー。
// "<folder>/<file>.txt" は同名の曲の歌詞。曲が無ければ無視する。
// 属性（title, duration）が欠ける曲や空ファイルは「壊れたデータ」として一覧に出さない。
// 改名・移動した曲は customMetadata.previous に元の key（JSON 配列、新しい順）を持つ。端末はそれで保存やプレイリストを付け替える。

export const COVER_NAME = 'cover.jpg';

export function splitKey(key) {
  const at = key.indexOf('/');
  if (at <= 0 || at === key.length - 1 || key.indexOf('/', at + 1) >= 0) return null;
  return { folder: key.slice(0, at), file: key.slice(at + 1) };
}

export function isTrackKey(key) {
  const parts = splitKey(key);
  return Boolean(parts) && /\.mp3$/i.test(parts.file);
}

export function isCoverKey(key) {
  const parts = splitKey(key);
  return Boolean(parts) && parts.file === COVER_NAME;
}

// 歌詞の key。曲 "<folder>/<file>.mp3" に対して "<folder>/<file>.txt"。
export function lyricsKeyFor(trackKey) {
  return isTrackKey(trackKey) ? trackKey.replace(/\.mp3$/i, '.txt') : null;
}
export function isLyricsKey(key) {
  const parts = splitKey(key);
  return Boolean(parts) && /\.txt$/i.test(parts.file);
}

// 改名・移動の履歴。customMetadata は合計 2 KB までなので、古いものから落として収める。
export const PREVIOUS_BYTES = 1000;
export function parsePrevious(value) {
  try { const list = JSON.parse(value || '[]'); return Array.isArray(list) ? list.filter(isTrackKey) : []; } catch { return []; }
}
export function previousAfterMove(from, value) {
  const list = [from, ...parsePrevious(value).filter(key => key !== from)];
  while (list.length > 1 && new TextEncoder().encode(JSON.stringify(list)).length > PREVIOUS_BYTES) list.pop();
  return JSON.stringify(list);
}

export function buildLibrary(objects) {
  const covers = new Set();
  const lyrics = new Set();
  for (const object of objects) {
    if (isCoverKey(object.key)) covers.add(splitKey(object.key).folder);
    else if (isLyricsKey(object.key) && object.size) lyrics.add(object.key.toLowerCase());
  }
  const tracks = [];
  for (const object of objects) {
    if (!isTrackKey(object.key) || !object.size) continue;
    const meta = object.customMetadata || {};
    const duration = Number(meta.duration);
    if (!meta.title || !Number.isFinite(duration) || duration <= 0) continue;
    const { folder } = splitKey(object.key);
    const previous = parsePrevious(meta.previous);
    tracks.push({
      id: object.key,
      folder,
      title: meta.title,
      duration: Math.round(duration),
      size: object.size,
      uploadedAt: meta.uploadedAt || (object.uploaded instanceof Date ? object.uploaded.toISOString() : String(object.uploaded || '')),
      cover: covers.has(folder),
      lyrics: lyrics.has(lyricsKeyFor(object.key).toLowerCase()),
      ...(previous.length ? { previous } : {}),
    });
  }
  tracks.sort((a, b) => (a.uploadedAt < b.uploadedAt ? 1 : a.uploadedAt > b.uploadedAt ? -1 : a.id.localeCompare(b.id)));
  return tracks;
}

export async function etagFor(tracks) {
  const text = tracks.map(track => `${track.id}:${track.title}:${track.size}:${track.uploadedAt}:${track.cover ? 1 : 0}:${track.lyrics ? 1 : 0}`).join('\n');
  const digest = await crypto.subtle.digest('SHA-1', new TextEncoder().encode(text));
  return `"${[...new Uint8Array(digest)].slice(0, 10).map(byte => byte.toString(16).padStart(2, '0')).join('')}"`;
}

// フォルダ名・ファイル名として受け付ける文字。パス区切りと制御文字を拒む。
export function validName(value, { extension } = {}) {
  if (typeof value !== 'string' || !value.length || value.length > 200) return false;
  if (/[\u0000-\u001f\u007f/\\]/.test(value) || value === '.' || value === '..') return false;
  if (extension && !new RegExp(`\\.${extension}$`, 'i').test(value)) return false;
  return true;
}
