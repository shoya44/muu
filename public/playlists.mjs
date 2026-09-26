// My Playlist のデータ。端末内だけに保存し、曲は R2 の key で参照する。
// 形: { playlists: [{id, name, trackIds: []}] }。配列の並びがそのまま表示順。
const uid = () => `p${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;

export function emptyStore() { return { playlists: [] }; }

export function normalise(store) {
  const clean = emptyStore();
  if (!store || typeof store !== 'object') return clean;
  clean.playlists = (Array.isArray(store.playlists) ? store.playlists : []).filter(p => p && p.id && p.name).map(p => ({
    id: String(p.id), name: String(p.name),
    trackIds: [...new Set((Array.isArray(p.trackIds) ? p.trackIds : []).filter(id => typeof id === 'string'))],
  }));
  return clean;
}

export function createPlaylist(store, name) {
  const playlist = { id: uid(), name: name.trim() || 'Playlist', trackIds: [] };
  store.playlists.push(playlist);
  return playlist;
}
export function rename(item, name) { if (name.trim()) item.name = name.trim(); }
export function removePlaylist(store, id) { store.playlists = store.playlists.filter(p => p.id !== id); }
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
// カードの並べ替え。表示中の ID の並びを正とする。
export function reorder(store, orderedIDs) {
  const byID = new Map(store.playlists.map(p => [p.id, p]));
  const ordered = orderedIDs.map(id => byID.get(id)).filter(Boolean);
  if (ordered.length === store.playlists.length) store.playlists = ordered;
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
