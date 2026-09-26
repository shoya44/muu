// 一覧の整形と表示用の純粋関数。ブラウザなしで検証できる。
// 標準はフォルダ表示。巡回は Folder → New → Old → A-Z → Z-A。
export const SORTS = ['folder', 'new', 'old', 'az', 'za'];
export const SORT_LABEL = { folder: 'Folder', new: 'New', old: 'Old', az: 'A-Z', za: 'Z-A' };
const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });

export function nextSort(sort) { return SORTS[(SORTS.indexOf(sort) + 1) % SORTS.length]; }

export function arrange(tracks, sort = 'folder') {
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
// 曲数の表示。単位を必ず付ける。
export const tracksLabel = n => `${n} ${n === 1 ? 'track' : 'tracks'}`;
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

// フォルダごとに区切る。入力の並びを保ち、同じフォルダの曲が続く前提（sort = 'folder'）。
export function groupByFolder(tracks) {
  const groups = [];
  for (const track of tracks) {
    const last = groups[groups.length - 1];
    if (last && last.folder === track.folder) last.tracks.push(track);
    else groups.push({ folder: track.folder, tracks: [track] });
  }
  return groups;
}

// アップロードするファイル名を key に使える形へ。
export function safeFileName(name) {
  let base = String(name).replace(/\.[^.]*$/, '').replace(/[\u0000-\u001f\u007f/\\]/g, '').trim();
  if (!base || base === '.' || base === '..') base = `track-${Date.now()}`;
  return `${base.slice(0, 150)}.mp3`;
}
export const titleOf = fileName => String(fileName).replace(/\.[^.]*$/, '').trim() || 'Untitled';

// まとめてアップロードする入力を、フォルダごとの仕事に分ける。
// entries = [{ file, path }]。path の親ディレクトリ名がフォルダ。親が無ければ fallback（入力欄）。cover.jpg はそのフォルダのカバー。
export const isMP3 = name => /\.mp3$/i.test(name);
export function groupUploads(entries, fallback = '') {
  const jobs = new Map();
  const jobFor = folder => { if (!jobs.has(folder)) jobs.set(folder, { folder, files: [], cover: undefined }); return jobs.get(folder); };
  for (const { file, path } of entries) {
    const parts = String(path).split('/').filter(Boolean);
    const folder = parts.length > 1 ? parts[parts.length - 2] : fallback;
    if (!folder) continue;
    if (isMP3(file.name)) jobFor(folder).files.push(file);
    else if (/^cover\.jpe?g$/i.test(file.name)) jobFor(folder).cover = file;
  }
  return [...jobs.values()].filter(job => job.files.length || job.cover);
}
