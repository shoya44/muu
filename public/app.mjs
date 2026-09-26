import { readState, writeState, savedTracks, removeSaved, clearSaved, estimate, COVER_CACHE } from './storage.mjs';
import { saveTrack } from './downloads.mjs';
import { Player } from './player.mjs';
import { icon } from './icons.mjs';
import { setupSheet } from './sheet.mjs';
import { setupPopover } from './popover.mjs';
import { makeSortable } from './drag.mjs';
import { arrange, nextSort, SORT_LABEL, mediaURL, coverURL, megabytes, time, saveControl, mergeLibrary, safeFileName, titleOf } from './library.mjs';
import * as PL from './playlists.mjs';
import { VERSION } from './version.mjs';

const $ = id => document.getElementById(id);
let tracks = [], saved = new Map(), store = PL.emptyStore();
let settings = { sort: 'new', autosave: false, resume: true, password: '' };
let downloading = false, controller, savingID, registration, toastTimer, libraryEtag = '';
let currentPlaylist = null, openView = 'home', adminOK = false, announcedUpdate = false;
let activeKey, queueShape;
const known = new Set();

// ---- 共通 UI ----
function toast(text, action) {
  if (!action) announcedUpdate = false;
  $('toast-text').textContent = text;
  $('toast-action').hidden = !action;
  if (action) { $('toast-action').textContent = action.label; $('toast-action').onclick = () => { $('toast').hidden = true; action.run(); }; }
  $('toast').hidden = false;
  clearTimeout(toastTimer);
  if (!action) toastTimer = setTimeout(() => { $('toast').hidden = true; }, 4000);
}
function confirm(text, { danger = true, ok = 'OK' } = {}) {
  return new Promise(resolve => {
    $('confirm-text').textContent = text;
    $('confirm-ok').textContent = ok;
    $('confirm-ok').classList.toggle('danger', danger);
    const dialog = $('confirm');
    dialog.onclose = () => resolve(dialog.returnValue === 'ok');
    dialog.showModal();
  });
}
$('confirm-cancel').onclick = () => $('confirm').close('cancel');
$('confirm-ok').onclick = () => $('confirm').close('ok');
function prompt(title, value = '') {
  return new Promise(resolve => {
    $('prompt-title').textContent = title;
    $('prompt-input').value = value;
    const dialog = $('prompt');
    dialog.onclose = () => resolve(dialog.returnValue === 'ok' ? $('prompt-input').value.trim() : null);
    dialog.showModal();
    $('prompt-input').focus();
  });
}
$('prompt-form').onsubmit = event => { event.preventDefault(); $('prompt').close('ok'); };
$('prompt-cancel').onclick = () => $('prompt').close('cancel');
for (const element of document.querySelectorAll('[data-icon]')) element.innerHTML = icon(element.dataset.icon);
for (const type of ['gesturestart', 'gesturechange', 'gestureend']) document.addEventListener(type, e => e.preventDefault(), { passive: false });
const popover = setupPopover($('popover'));
const persistSettings = () => writeState('settings', settings).catch(() => {});
const persistStore = () => writeState('playlists', store).catch(() => toast("Couldn't save playlists"));
const trackByID = id => tracks.find(track => track.id === id);
const savedIDs = () => new Set(saved.keys());
const playableNow = track => saved.has(track.id) || (navigator.onLine && !track.gone);

// ---- ナビゲーション ----
function show(view) {
  openView = view;
  for (const section of document.querySelectorAll('.view')) section.hidden = section.dataset.view !== view;
  for (const button of document.querySelectorAll('.nav-item')) button.classList.toggle('on', button.dataset.nav === view);
  $('fab-add').hidden = !(view === 'playlists' && currentPlaylist);
  popover.close();
  if (view === 'settings') renderSettings();
  if (view === 'playlists') renderPlaylists();
  window.scrollTo(0, 0);
}
for (const button of document.querySelectorAll('.nav-item')) button.onclick = () => {
  if (button.dataset.nav === 'playlists' && openView === 'playlists' && currentPlaylist) { currentPlaylist = null; renderPlaylists(); }
  show(button.dataset.nav);
};

// ---- プレイヤー ----
const player = new Player($('audio'), { changed: renderPlayer, message: toast, persist: state => writeState('player', state).catch(() => {}) });
const sheet = setupSheet($('now'), { opening: renderQueue });
$('mini-open').onclick = () => sheet.open();
$('sheet-close').onclick = () => $('now').close();
// ミニプレイヤーを上へスワイプしても開く。
let swipe;
$('mini').addEventListener('pointerdown', e => { swipe = { y: e.clientY, id: e.pointerId }; });
$('mini').addEventListener('pointermove', e => { if (swipe && e.pointerId === swipe.id && swipe.y - e.clientY > 40) { swipe = undefined; sheet.open(); } });
$('mini').addEventListener('pointerup', () => { swipe = undefined; });
for (const button of document.querySelectorAll('[data-player]')) button.onclick = () => player[button.dataset.player]();
$('shuffle').onclick = () => player.setShuffle(!player.shuffle);
const seek = $('sheet-seek');
seek.addEventListener('pointerdown', () => { seek.dataset.dragging = 'true'; });
seek.addEventListener('input', () => { $('sheet-elapsed').textContent = time(Number(seek.value)); });
seek.addEventListener('change', () => { player.seek(Number(seek.value)); seek.dataset.dragging = 'false'; });
seek.addEventListener('pointerup', () => { seek.dataset.dragging = 'false'; });

function renderPlayer() {
  const track = player.track;
  document.body.classList.toggle('no-mini', !track);
  $('mini').hidden = !track;
  if (!track) return;
  $('mini-title').textContent = $('now-title').textContent = track.title;
  const cover = coverURL(track) || '/icon-512.png';
  for (const image of [$('mini-cover'), $('sheet-cover')]) if (image.dataset.source !== cover) { image.dataset.source = cover; image.src = cover; image.onerror = () => { image.src = '/icon-512.png'; }; }
  const paused = player.audio.paused;
  for (const button of document.querySelectorAll('[data-player="toggle"]')) {
    const state = paused ? 'play_arrow' : 'pause';
    if (button.dataset.state !== state) { button.innerHTML = icon(state); button.dataset.state = state; }
    button.setAttribute('aria-label', paused ? 'Play' : 'Pause');
  }
  const duration = Number.isFinite(player.audio.duration) ? player.audio.duration : track.duration;
  const position = player.pendingPosition || player.audio.currentTime || 0;
  seek.max = duration || 1;
  if (seek.dataset.dragging !== 'true') { seek.value = position; $('sheet-elapsed').textContent = time(position); }
  $('sheet-duration').textContent = time(duration);
  $('mini-bar').style.width = duration ? `${(position / duration) * 100}%` : '0';
  $('now-subtitle').textContent = `${player.index + 1} / ${player.queue.length}${track.gone ? ' · offline copy' : ''}`;
  $('shuffle').setAttribute('aria-pressed', String(player.shuffle));
  $('shuffle').classList.toggle('on', player.shuffle);
  if ('mediaSession' in navigator) navigator.mediaSession.playbackState = paused ? 'paused' : 'playing';
  const shape = player.queue.map(item => item.key).join(' ');
  if (activeKey !== player.item?.key || queueShape !== shape) {
    activeKey = player.item?.key; queueShape = shape;
    renderAll(); renderQueue();
  }
}

function renderQueue() {
  $('queue').replaceChildren(...player.queue.map((item, index) => {
    const li = document.createElement('li');
    li.dataset.key = item.key;
    if (index === player.index) { li.className = 'current'; li.setAttribute('aria-current', 'true'); }
    const play = document.createElement('button'); play.className = 'queue-play';
    play.setAttribute('aria-label', `Play ${item.track.title}`);
    play.onclick = () => player.playAt(index);
    const number = document.createElement('span'); number.className = 'queue-number'; number.textContent = String(index + 1).padStart(2, '0');
    const title = document.createElement('span'); title.className = 'queue-title'; title.textContent = item.track.title;
    play.append(number, title);
    const remove = document.createElement('button'); remove.className = 'icon'; remove.innerHTML = icon('remove');
    remove.setAttribute('aria-label', `Remove ${item.track.title} from queue`);
    remove.disabled = index === player.index;
    remove.onclick = () => { if (player.removeAt(index)) renderQueue(); };
    const handle = document.createElement('span'); handle.className = 'icon track-handle'; handle.innerHTML = icon('drag_handle');
    li.append(handle, play, remove);
    return li;
  }));
}
makeSortable($('queue'), { itemSelector: 'li', handleSelector: '.track-handle', onMove: (from, to) => { player.moveItem(from, to); renderQueue(); } });

// ---- 楽曲の行 ----
function makeRow(track, { list, playlist } = {}) {
  const row = document.createElement('div');
  row.className = `track${player.track?.id === track.id ? ' active' : ''}${track.gone ? ' gone' : ''}`;
  row.dataset.id = track.id; row.setAttribute('role', 'listitem');
  const play = document.createElement('button'); play.className = 'track-play'; play.setAttribute('aria-label', `Play ${track.title}`);
  const info = document.createElement('span'); info.className = 'track-info';
  const title = document.createElement('span'); title.className = 'track-title'; title.textContent = track.title;
  const meta = document.createElement('span'); meta.className = 'track-meta';
  meta.textContent = track.duration ? time(track.duration) : '--:--';
  info.append(title, meta); play.append(info);
  play.onclick = () => {
    const candidates = list.filter(item => playableNow(item) || item.id === track.id);
    player.start(candidates, track.id);
    if (navigator.onLine) void refresh();
  };
  const control = saveControl({ saved: saved.has(track.id), saving: savingID === track.id, gone: track.gone, playing: player.track?.id === track.id && !player.audio.paused });
  const save = document.createElement('button');
  save.className = `track-save icon${control.saved ? ' on' : ''}${control.busy ? ' busy' : ''}`;
  save.innerHTML = icon(control.icon); save.disabled = Boolean(control.disabled);
  save.setAttribute('aria-label', control.label);
  save.onclick = () => (control.saved ? unsave(track) : download([track]));
  const menu = document.createElement('button'); menu.className = 'track-menu icon'; menu.innerHTML = icon('more_horiz');
  menu.setAttribute('aria-label', 'More');
  menu.onclick = () => popover.open(menu, [
    { icon: 'playlist_play', label: 'Play next', run: () => { player.playNext(track); toast('Added to queue'); }, disabled: !playableNow(track) },
    { icon: 'playlist_add', label: 'Add to playlist', run: () => pickPlaylist([track.id]) },
    { icon: 'info', label: 'Details', run: () => showDetails(track) },
    playlist && { icon: 'remove', label: 'Remove', danger: true, run: () => removeFromPlaylist(playlist, track) },
  ]);
  row.append(play, save, menu);
  if (playlist) { const handle = document.createElement('span'); handle.className = 'icon track-handle'; handle.innerHTML = icon('drag_handle'); row.prepend(handle); }
  return row;
}
function showDetails(track) {
  $('detail-title').textContent = track.title;
  const rows = [['Folder', track.folder], ['Length', track.duration ? time(track.duration) : '-'], ['Size', megabytes(track.size)], ['Added', track.uploadedAt ? new Date(track.uploadedAt).toLocaleDateString() : '-'], ['Saved', saved.has(track.id) ? 'Yes' : 'No'], ['Cloud', track.gone ? 'Removed' : 'Available'], ['File', track.id]];
  $('detail-list').replaceChildren(...rows.flatMap(([k, v]) => { const dt = document.createElement('dt'); dt.textContent = k; const dd = document.createElement('dd'); dd.textContent = v; return [dt, dd]; }));
  $('detail').showModal();
}
$('detail-close').onclick = () => $('detail').close();

// ---- Home ----
const homeTracks = () => arrange(tracks.filter(track => !track.gone), settings.sort);
function renderHome() {
  const visible = homeTracks();
  $('sort-label').textContent = SORT_LABEL[settings.sort];
  $('home-empty').hidden = visible.length > 0;
  $('tracks').replaceChildren(...visible.map(track => makeRow(track, { list: visible })));
  const pending = visible.filter(track => !saved.has(track.id));
  $('save-all').checked = visible.length > 0 && !pending.length;
  $('save-all').indeterminate = pending.length > 0 && pending.length < visible.length;
  $('save-all').disabled = downloading || !visible.length;
}
$('sort').onclick = () => { settings.sort = nextSort(settings.sort); persistSettings(); renderHome(); };
$('save-all').onchange = async () => {
  const visible = homeTracks();
  const pending = visible.filter(track => !saved.has(track.id));
  if (pending.length) { download(pending); return; }
  if (await confirm(`Remove ${visible.length} saved tracks from this device?`, { ok: 'Remove' })) {
    for (const track of visible) if (player.track?.id !== track.id) await removeSaved(track.id);
    await refreshSaved(); toast('Removed');
  } else renderHome();
};
function renderAll() { renderHome(); if (openView === 'playlists') renderPlaylists(); if (openView === 'settings') renderSettings(); }

// ---- 保存 ----
async function refreshSaved() { saved = await savedTracks(); renderAll(); }
async function unsave(track) {
  if (player.track?.id === track.id && !player.audio.paused) { toast('Playing now'); return; }
  if (track.gone && !(await confirm(`"${track.title}" is no longer in the cloud. Removing the local copy cannot be undone.`, { ok: 'Remove' }))) return;
  await removeSaved(track.id); await refreshSaved();
}
async function download(items) {
  if (downloading || !items.length) return;
  downloading = true; controller = new AbortController(); renderHome();
  let completed = 0, failure = '';
  try {
    try { await navigator.storage?.persist?.(); } catch { /* optional */ }
    for (const track of items) {
      if (controller.signal.aborted) break;
      savingID = track.id; renderAll();
      $('save-status').textContent = `${completed + 1} / ${items.length} · ${track.title}`;
      try {
        await saveTrack(track, controller.signal, received => { $('save-status').textContent = `${completed + 1} / ${items.length} · ${track.title} · ${megabytes(received)} / ${megabytes(track.size)}`; });
        completed++;
      } catch (error) {
        if (controller.signal.aborted) break;
        failure = error.name === 'QuotaExceededError' ? 'Storage full' : error.message;
        if (error.name === 'QuotaExceededError') break;
      }
      savingID = undefined; saved = await savedTracks();
    }
    $('save-status').textContent = '';
    if (failure) toast(failure); else if (items.length > 1) toast(`Saved ${completed} tracks`);
  } finally { downloading = false; savingID = undefined; await refreshSaved(); }
}

// ---- Playlists ----
function cardFor(playlist) {
  const card = document.createElement('button'); card.className = 'card-item'; card.dataset.id = playlist.id;
  card.innerHTML = icon('queue_music');
  const name = document.createElement('span'); name.className = 'card-name'; name.textContent = playlist.name;
  const count = document.createElement('span'); count.className = 'card-count'; count.textContent = `${playlist.trackIds.length} tracks`;
  card.append(name, count);
  card.onclick = () => { currentPlaylist = playlist.id; renderPlaylists(); $('fab-add').hidden = false; };
  return card;
}
function renderPlaylists() {
  const playlist = currentPlaylist && store.playlists.find(p => p.id === currentPlaylist);
  if (currentPlaylist && !playlist) currentPlaylist = null;
  $('playlists-root').hidden = Boolean(playlist);
  $('playlist-detail').hidden = !playlist;
  $('fab-add').hidden = !(openView === 'playlists' && playlist);
  if (playlist) {
    $('playlist-title').textContent = playlist.name;
    const rows = PL.resolveTracks(playlist, trackByID, saved);
    $('playlist-empty').hidden = rows.length > 0;
    $('playlist-tracks').replaceChildren(...rows.map(track => makeRow(track, { list: rows, playlist })));
    return;
  }
  const loose = store.playlists.filter(p => !p.folder);
  const nodes = loose.map(cardFor);
  for (const folder of store.folders) {
    const group = document.createElement('div'); group.className = 'folder-group'; group.dataset.folder = folder.id;
    const head = document.createElement('div'); head.className = 'folder-head';
    head.innerHTML = icon('folder');
    const name = document.createElement('span'); name.className = 'folder-name'; name.textContent = folder.name;
    const menu = document.createElement('button'); menu.className = 'icon'; menu.innerHTML = icon('more_horiz'); menu.setAttribute('aria-label', 'Folder options');
    menu.onclick = () => popover.open(menu, [
      { icon: 'playlist_add', label: 'New playlist here', run: async () => { const n = await prompt('Playlist name'); if (n) { PL.createPlaylist(store, n, folder.id); persistStore(); renderPlaylists(); } } },
      { icon: 'folder', label: 'Rename', run: async () => { const n = await prompt('Folder name', folder.name); if (n) { PL.rename(folder, n); persistStore(); renderPlaylists(); } } },
      { icon: 'delete', label: 'Delete folder', danger: true, run: () => { PL.removeFolder(store, folder.id); persistStore(); renderPlaylists(); } },
    ]);
    head.append(name, menu);
    const body = document.createElement('div'); body.className = 'folder-body cards'; body.dataset.folder = folder.id;
    body.append(...store.playlists.filter(p => p.folder === folder.id).map(cardFor));
    group.append(head, body); nodes.push(group);
  }
  $('playlist-cards').replaceChildren(...nodes);
  $('playlists-empty').hidden = store.playlists.length > 0 || store.folders.length > 0;
  for (const container of [$('playlist-cards'), ...$('playlist-cards').querySelectorAll('.folder-body')]) {
    if (container.dataset.sortable) continue;
    container.dataset.sortable = '1';
    makeSortable(container, { itemSelector: '.card-item', onMove: () => {
      const folder = container.dataset.folder || null;
      PL.reorderPlaylists(store, folder, [...container.querySelectorAll('.card-item')].map(el => el.dataset.id));
      persistStore();
    } });
  }
}
makeSortable($('playlist-tracks'), { itemSelector: '.track', handleSelector: '.track-handle', onMove: (from, to) => {
  const playlist = store.playlists.find(p => p.id === currentPlaylist);
  if (!playlist) return;
  // 表示行と trackIds の並びは同じ順（隠れた曲は末尾に無い前提で、表示 ID の並びを正とする）。
  const shown = [...$('playlist-tracks').querySelectorAll('.track')].map(el => el.dataset.id);
  const hidden = playlist.trackIds.filter(id => !shown.includes(id));
  playlist.trackIds = [...shown, ...hidden];
  persistStore();
} });
$('playlist-back').onclick = () => { currentPlaylist = null; renderPlaylists(); };
$('playlist-new').onclick = async () => { const n = await prompt('Playlist name'); if (n) { PL.createPlaylist(store, n); persistStore(); renderPlaylists(); } };
$('folder-new').onclick = async () => { const n = await prompt('Folder name'); if (n) { PL.createFolder(store, n); persistStore(); renderPlaylists(); } };
$('playlist-menu').onclick = () => {
  const playlist = store.playlists.find(p => p.id === currentPlaylist);
  if (!playlist) return;
  const rows = PL.resolveTracks(playlist, trackByID, saved);
  popover.open($('playlist-menu'), [
    { icon: 'play_arrow', label: 'Play all', disabled: !rows.length, run: () => { const c = rows.filter(playableNow); if (c.length) player.start(c, c[0].id); } },
    { icon: 'shuffle', label: 'Shuffle', disabled: !rows.length, run: () => { const c = rows.filter(playableNow); if (c.length) { player.setShuffle(true); player.start(c, c[Math.floor(Math.random() * c.length)].id); } } },
    { icon: 'folder', label: 'Move to folder', disabled: !store.folders.length, run: () => moveToFolder(playlist) },
    { icon: 'queue_music', label: 'Rename', run: async () => { const n = await prompt('Playlist name', playlist.name); if (n) { PL.rename(playlist, n); persistStore(); renderPlaylists(); } } },
    { icon: 'delete', label: 'Delete playlist', danger: true, run: async () => { if (await confirm(`Delete "${playlist.name}"? Saved audio stays on this device.`, { ok: 'Delete' })) { PL.removePlaylist(store, playlist.id); currentPlaylist = null; persistStore(); renderPlaylists(); } } },
  ]);
};
function moveToFolder(playlist) {
  $('picker-title').textContent = 'Move to folder';
  $('picker-new').hidden = true;
  const options = [{ id: null, name: 'No folder' }, ...store.folders];
  $('picker-list').replaceChildren(...options.map(folder => {
    const b = document.createElement('button'); b.innerHTML = icon('folder'); b.append(folder.name);
    b.onclick = () => { playlist.folder = folder.id; persistStore(); $('picker').close(); renderPlaylists(); };
    return b;
  }));
  $('picker').showModal();
}
function pickPlaylist(ids) {
  $('picker-title').textContent = 'Add to playlist';
  $('picker-new').hidden = false; $('picker-name').value = '';
  $('picker-list').replaceChildren(...store.playlists.map(playlist => {
    const b = document.createElement('button'); b.innerHTML = icon('queue_music'); b.append(playlist.name);
    b.onclick = () => { const n = PL.addTracks(playlist, ids); persistStore(); $('picker').close(); toast(n ? `Added to ${playlist.name}` : 'Already in playlist'); if (openView === 'playlists') renderPlaylists(); };
    return b;
  }));
  $('picker-new').onsubmit = event => {
    event.preventDefault();
    const name = $('picker-name').value.trim(); if (!name) return;
    const playlist = PL.createPlaylist(store, name); PL.addTracks(playlist, ids); persistStore();
    $('picker').close(); toast(`Added to ${playlist.name}`); if (openView === 'playlists') renderPlaylists();
  };
  $('picker').showModal();
}
$('picker-cancel').onclick = () => $('picker').close();
function removeFromPlaylist(playlist, track) {
  PL.removeTrack(playlist, track.id); persistStore(); renderPlaylists();
  toast('Removed', { label: 'Undo', run: () => { PL.addTracks(playlist, [track.id]); persistStore(); renderPlaylists(); } });
}
$('fab-add').onclick = () => {
  const playlist = store.playlists.find(p => p.id === currentPlaylist);
  if (!playlist) return;
  const visible = homeTracks();
  $('chooser-list').replaceChildren(...visible.map(track => {
    const label = document.createElement('label'); const box = document.createElement('input'); box.type = 'checkbox'; box.value = track.id;
    const inside = playlist.trackIds.includes(track.id); box.checked = inside; box.disabled = inside; label.classList.toggle('in', inside);
    const span = document.createElement('span'); span.textContent = track.title; label.append(box, span); return label;
  }));
  $('chooser-ok').onclick = () => {
    const ids = [...$('chooser-list').querySelectorAll('input:checked:not(:disabled)')].map(i => i.value);
    const n = PL.addTracks(playlist, ids); persistStore(); $('chooser').close(); renderPlaylists(); if (n) toast(`Added ${n}`);
  };
  $('chooser').showModal();
};
$('chooser-cancel').onclick = () => $('chooser').close();

// ---- Settings ----
async function renderSettings() {
  $('version').textContent = VERSION;
  $('opt-autosave').checked = settings.autosave; $('opt-resume').checked = settings.resume;
  const savedList = tracks.filter(track => saved.has(track.id));
  const orphanIDs = [...saved.keys()].filter(id => !trackByID(id));
  const used = [...saved.values()].reduce((a, b) => a + b, 0);
  const est = await estimate();
  const percent = est?.quota ? Math.min(100, Math.round(((est.usage || used) / est.quota) * 100)) : 0;
  $('gauge-fill').style.width = `${percent}%`;
  $('gauge').setAttribute('aria-valuenow', String(percent));
  $('storage-line').textContent = `${saved.size} tracks · ${megabytes(used)}${est?.quota ? ` · ${percent}% of ${megabytes(est.quota)}` : ''}`;
  const rows = [...savedList, ...orphanIDs.map(id => ({ id, folder: id.split('/')[0], title: id.split('/').pop().replace(/\.mp3$/i, ''), duration: 0, size: saved.get(id), gone: true }))];
  $('saved-list').replaceChildren(...rows.map(track => {
    const row = document.createElement('div'); row.className = `track${track.gone ? ' gone' : ''}`;
    const info = document.createElement('span'); info.className = 'track-info'; info.style.padding = '0 12px';
    const title = document.createElement('span'); title.className = 'track-title'; title.textContent = track.title;
    const meta = document.createElement('span'); meta.className = 'track-meta'; meta.textContent = megabytes(track.size || 0);
    info.append(title, meta);
    const remove = document.createElement('button'); remove.className = 'icon'; remove.innerHTML = icon('delete'); remove.setAttribute('aria-label', `Remove ${track.title}`);
    remove.onclick = () => unsave(track);
    row.append(info, remove); return row;
  }));
  $('clear-saved').hidden = !saved.size;
  $('password-state').textContent = adminOK ? 'Unlocked' : settings.password ? 'Checking…' : 'Enter the password to upload or delete.';
  $('admin').hidden = !adminOK;
  if (adminOK) renderAdmin();
}
$('clear-saved').onclick = async () => {
  if (!(await confirm(`Remove all ${saved.size} saved tracks from this device?`, { ok: 'Remove all' }))) return;
  player.pause(); await clearSaved(); await refreshSaved(); toast('Removed all');
};
$('opt-autosave').onchange = () => { settings.autosave = $('opt-autosave').checked; persistSettings(); };
$('opt-resume').onchange = () => { settings.resume = $('opt-resume').checked; persistSettings(); };
$('check-update').onclick = () => checkUpdate(true);

const authHeaders = () => ({ authorization: `Bearer ${settings.password}` });
async function verifyPassword() {
  if (!settings.password) { adminOK = false; return; }
  try { const r = await fetch('/api/auth', { method: 'POST', headers: authHeaders() }); adminOK = r.ok; if (!r.ok && r.status === 401) toast('Wrong password'); }
  catch { adminOK = false; }
  if (openView === 'settings') renderSettings();
}
$('password-form').onsubmit = async event => {
  event.preventDefault();
  settings.password = $('password').value; $('password').value = ''; persistSettings();
  await verifyPassword();
  if (adminOK) toast('Unlocked');
};
function renderAdmin() {
  $('folders').replaceChildren(...[...new Set(tracks.map(t => t.folder))].sort().map(name => { const o = document.createElement('option'); o.value = name; return o; }));
  const list = arrange(tracks.filter(t => !t.gone), 'new');
  $('admin-tracks').replaceChildren(...list.map(track => {
    const row = document.createElement('div'); row.className = 'track';
    const info = document.createElement('span'); info.className = 'track-info'; info.style.padding = '0 12px';
    const title = document.createElement('span'); title.className = 'track-title'; title.textContent = track.title;
    const meta = document.createElement('span'); meta.className = 'track-meta'; meta.textContent = `${track.folder} · ${megabytes(track.size)}`;
    info.append(title, meta);
    const remove = document.createElement('button'); remove.className = 'icon'; remove.innerHTML = icon('delete'); remove.setAttribute('aria-label', `Delete ${track.title} from cloud`);
    remove.onclick = async () => {
      if (!(await confirm(`Delete "${track.title}" from the cloud for everyone?`, { ok: 'Delete' }))) return;
      const r = await fetch(`/api/tracks/${encodeURIComponent(track.id)}`, { method: 'DELETE', headers: authHeaders() });
      if (r.status === 204) { toast('Deleted'); await refresh(true); } else toast(`Delete failed (${r.status})`);
    };
    row.append(info, remove); return row;
  }));
}
function durationOf(file) {
  return new Promise(resolve => {
    const url = URL.createObjectURL(file); const audio = new Audio();
    const done = value => { URL.revokeObjectURL(url); resolve(value); };
    audio.onloadedmetadata = () => done(Number.isFinite(audio.duration) ? audio.duration : 0);
    audio.onerror = () => done(0);
    audio.src = url;
  });
}
$('upload-files').onchange = async () => {
  const folder = $('upload-folder').value.trim();
  const files = [...$('upload-files').files]; $('upload-files').value = '';
  if (!folder) { toast('Enter a folder name'); return; }
  let done = 0;
  for (const file of files) {
    $('upload-status').textContent = `${done + 1} / ${files.length} · ${file.name}`;
    const duration = await durationOf(file);
    if (!duration) { toast(`Can't read ${file.name}`); continue; }
    const key = `${folder}/${safeFileName(file.name)}`;
    const r = await fetch(`/api/tracks/${encodeURIComponent(key)}`, { method: 'PUT', body: file, headers: { ...authHeaders(), 'content-type': 'audio/mpeg', 'x-title': encodeURIComponent(titleOf(file.name)), 'x-duration': String(duration) } });
    if (r.status === 201) done++; else if (r.status === 409) toast(`Exists: ${file.name}`); else toast(`Upload failed (${r.status})`);
  }
  $('upload-status').textContent = '';
  if (done) { toast(`Uploaded ${done}`); await refresh(true); }
};
$('upload-cover').onchange = async () => {
  const folder = $('upload-folder').value.trim(); const file = $('upload-cover').files[0]; $('upload-cover').value = '';
  if (!folder || !file) { toast('Enter a folder name'); return; }
  const r = await fetch(`/api/covers/${encodeURIComponent(folder)}`, { method: 'PUT', body: file, headers: { ...authHeaders(), 'content-type': 'image/jpeg' } });
  if (r.status === 201) { await (await caches.open(COVER_CACHE)).delete(`/covers/${encodeURIComponent(folder)}`); toast('Cover updated'); await refresh(true); } else toast(`Upload failed (${r.status})`);
};

// ---- 同期・更新 ----
let refreshing;
async function refresh(force = false) {
  if (refreshing) return refreshing;
  refreshing = (async () => {
    try {
      const response = await fetch('/api/library', { headers: force || !libraryEtag ? {} : { 'if-none-match': libraryEtag }, cache: force ? 'reload' : 'default' });
      if (response.status === 304) return;
      if (!response.ok) throw new Error(String(response.status));
      const body = await response.json();
      if (!Array.isArray(body.tracks)) throw new Error('invalid');
      libraryEtag = body.etag || '';
      tracks = mergeLibrary(body.tracks, tracks, savedIDs());
      writeState('library', { etag: libraryEtag, tracks }).catch(() => {});
      player.refreshTracks(trackByID);
      const fresh = body.tracks.filter(track => !known.has(track.id) && !saved.has(track.id));
      for (const track of body.tracks) known.add(track.id);
      if (settings.autosave && fresh.length && known.size > fresh.length) void download(fresh);
    } catch { /* offline: 前回の一覧のまま */ }
    finally { renderAll(); }
  })();
  try { await refreshing; } finally { refreshing = undefined; }
}
async function checkUpdate(manual = false) {
  try {
    const { version } = await (await fetch('/version.json', { cache: 'no-store' })).json();
    if (version && version !== VERSION) {
      if (announcedUpdate && !manual) return;
      announcedUpdate = true;
      toast(`Update ${version} available`, { label: 'Update', run: applyUpdate });
    } else if (manual) toast('Up to date');
  } catch { if (manual) toast('Offline'); }
}
async function applyUpdate() {
  try {
    await registration?.update();
    const waiting = registration?.waiting || registration?.installing;
    if (waiting) {
      waiting.postMessage('activate-update');
      navigator.serviceWorker.addEventListener('controllerchange', () => location.reload(), { once: true });
      setTimeout(() => location.reload(), 3000);
    } else location.reload();
  } catch { location.reload(); }
}

// ---- 起動 ----
async function start() {
  const [library, savedSettings, playlists, playerState] = await Promise.all([readState('library'), readState('settings'), readState('playlists'), readState('player')]).catch(() => []);
  settings = { ...settings, ...(savedSettings || {}) };
  store = PL.normalise(playlists);
  saved = await savedTracks();
  if (library?.tracks) { tracks = library.tracks; libraryEtag = library.etag || ''; for (const t of tracks) known.add(t.id); }
  else $('loading').hidden = false;
  renderAll();
  if (settings.resume && playerState) player.restore(playerState);
  renderPlayer();
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('/sw.mjs', { type: 'module' }).then(r => { registration = r; }).catch(() => {});
  }
  await refresh(true);
  $('loading').hidden = true;
  void verifyPassword();
  void checkUpdate();
  window.addEventListener('online', () => refresh());
  document.addEventListener('visibilitychange', () => { if (!document.hidden) { refresh(); checkUpdate(); } });
}
start();
