// My Playlist のデータ。端末内だけに保存し、曲は R2 の key で参照する。
// 形: { folders: [{id, name}], playlists: [{id, name, folder: id|null, trackIds: []}] }
// 配列の並びがそのまま表示順。フォルダは 1 階層。
const uid = () => `p${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;

export function emptyStore() { return { folders: [], playlists: [] }; }

export function normalise(store) {
  const clean = emptyStore();
  if (!store || typeof store !== 'object') return clean;
  clean.folders = (Array.isArray(store.folders) ? store.folders : []).filter(f => f && f.id && f.name).map(f => ({ id: String(f.id), name: String(f.name) }));
  const folderIDs = new Set(clean.folders.map(f => f.id));
  clean.playlists = (Array.isArray(store.playlists) ? store.playlists : []).filter(p => p && p.id && p.name).map(p => ({
    id: String(p.id), name: String(p.name),
    folder: folderIDs.has(p.folder) ? p.folder : null,
    trackIds: [...new Set((Array.isArray(p.trackIds) ? p.trackIds : []).filter(id => typeof id === 'string'))],
  }));
  return clean;
}

export function createPlaylist(store, name, folder = null) {
  const playlist = { id: uid(), name: name.trim() || 'Playlist', folder, trackIds: [] };
  store.playlists.push(playlist);
  return playlist;
}
export function createFolder(store, name) {
  const folder = { id: uid(), name: name.trim() || 'Folder' };
  store.folders.push(folder);
  return folder;
}
export function rename(item, name) { if (name.trim()) item.name = name.trim(); }
export function removePlaylist(store, id) { store.playlists = store.playlists.filter(p => p.id !== id); }
export function removeFolder(store, id) {
  // フォルダを消してもプレイリストは消えない。外に出るだけ。
  for (const p of store.playlists) if (p.folder === id) p.folder = null;
  store.folders = store.folders.filter(f => f.id !== id);
}
export function addTracks(playlist, ids) {
  let added = 0;
  for (const id of ids) if (!playlist.trackIds.includes(id)) { playlist.trackIds.push(id); added++; }
  return added;
}
export function removeTrack(playlist, id) { playlist.trackIds = playlist.trackIds.filter(t => t !== id); }
export function moveTrack(playlist, from, to) {
  if (from === to || !playlist.trackIds[from] || to < 0 || to >= playlist.trackIds.length) return;
  const [moved] = playlist.trackIds.splice(from, 1);
  playlist.trackIds.splice(to, 0, moved);
}
// カード一覧（フォルダ内/外）の並べ替え。同じ入れ物の中でだけ動かす。
export function moveCard(list, from, to) {
  if (from === to || !list[from] || to < 0 || to >= list.length) return;
  const [moved] = list.splice(from, 1);
  list.splice(to, 0, moved);
}
export function reorderPlaylists(store, folder, orderedIDs) {
  const inside = store.playlists.filter(p => p.folder === folder);
  const byID = new Map(inside.map(p => [p.id, p]));
  const ordered = orderedIDs.map(id => byID.get(id)).filter(Boolean);
  if (ordered.length !== inside.length) return;
  let cursor = 0;
  store.playlists = store.playlists.map(p => (p.folder === folder ? ordered[cursor++] : p));
}
// 表示用: プレイリストの曲を一覧と突き合わせる。一覧に無い曲は端末保存済みならグレー、無ければ隠す。
export function resolveTracks(playlist, lookup, savedIDs) {
  const rows = [];
  for (const id of playlist.trackIds) {
    const track = lookup(id);
    if (track) rows.push(track);
    else if (savedIDs.has(id)) rows.push({ id, folder: id.split('/')[0] || '', title: id.split('/').pop().replace(/\.mp3$/i, ''), duration: 0, size: savedIDs.get?.(id) || 0, cover: false, gone: true, orphan: true });
  }
  return rows;
}
