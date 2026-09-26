// 一覧の整形と表示用の純粋関数。ブラウザなしで検証できる。
export const SORTS = ['new', 'old', 'az', 'za', 'folder'];
export const SORT_LABEL = { new: 'New', old: 'Old', az: 'A-Z', za: 'Z-A', folder: 'Folder' };
const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });

export function nextSort(sort) { return SORTS[(SORTS.indexOf(sort) + 1) % SORTS.length]; }

export function arrange(tracks, sort = 'new') {
  const list = [...tracks];
  if (sort === 'az') return list.sort((a, b) => collator.compare(a.title, b.title));
  if (sort === 'za') return list.sort((a, b) => collator.compare(b.title, a.title));
  if (sort === 'folder') return list.sort((a, b) => collator.compare(a.folder, b.folder) || collator.compare(a.title, b.title));
  list.sort((a, b) => (a.uploadedAt < b.uploadedAt ? 1 : a.uploadedAt > b.uploadedAt ? -1 : collator.compare(a.title, b.title)));
  return sort === 'old' ? list.reverse() : list;
}

export const mediaURL = track => `/media/${encodeURIComponent(track.id)}`;
export const coverURL = track => (track?.cover ? `/covers/${encodeURIComponent(track.folder)}` : '');

export const megabytes = bytes => `${(bytes / 1024 / 1024).toFixed(1)} MB`;
// 容量の表示。1 GB 以上は GB で、それ未満は MB で。
export const bytesLabel = bytes => (bytes >= 1024 ** 3 ? `${(bytes / 1024 ** 3).toFixed(1)} GB` : megabytes(bytes));
export const time = seconds => `${Math.floor((seconds || 0) / 60)}:${String(Math.floor((seconds || 0) % 60)).padStart(2, '0')}`;
// 合計時間の表示。1 時間以上は "1h 05m"、それ未満は "12 min"。
export function durationLabel(seconds) {
  const minutes = Math.round((seconds || 0) / 60);
  if (minutes < 1) return '< 1 min';
  if (minutes < 60) return `${minutes} min`;
  return `${Math.floor(minutes / 60)}h ${String(minutes % 60).padStart(2, '0')}m`;
}

// 行の保存ボタンが示す状態と、押したときの意味。
export function saveControl({ saved, saving, gone, playing }) {
  if (saving) return { icon: 'progress_activity', label: 'Saving', busy: true, disabled: true };
  if (saved) return playing ? { icon: 'download_done', label: 'Playing now', saved: true, disabled: true } : { icon: 'download_done', label: 'Remove from device', saved: true };
  if (gone) return { icon: 'cloud_off', label: 'Not available', disabled: true };
  return { icon: 'download', label: 'Save to device' };
}

// 一覧同期の結果を端末の知識と合わせる。R2 に無くなった曲は保存済みなら残す（gone）。
export function mergeLibrary(remote, previous, savedIDs) {
  const ids = new Set(remote.map(track => track.id));
  const kept = previous.filter(track => !ids.has(track.id) && savedIDs.has(track.id)).map(track => ({ ...track, gone: true }));
  return [...remote.map(track => ({ ...track, gone: false })), ...kept];
}

// アップロードするファイル名を key に使える形へ。
export function safeFileName(name) {
  let base = String(name).replace(/\.[^.]*$/, '').replace(/[\u0000-\u001f\u007f/\\]/g, '').trim();
  if (!base || base === '.' || base === '..') base = `track-${Date.now()}`;
  return `${base.slice(0, 150)}.mp3`;
}
export const titleOf = fileName => String(fileName).replace(/\.[^.]*$/, '').trim() || 'Untitled';
