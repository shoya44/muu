import { readState, writeState, savedTracks, removeSaved, clearSaved, estimate, AUDIO_CACHE, COVER_CACHE } from './storage.mjs';
import { saveTrack } from './downloads.mjs';
import { Player } from './player.mjs';
import { icon } from './icons.mjs';
import { setupSheet } from './sheet.mjs';
import { setupPopover } from './popover.mjs';
import { makeSortable } from './drag.mjs';
import { arrange, nextSort, SORT_LABEL, mediaURL, coverURL, megabytes, bytesLabel, time, durationLabel, saveControl, mergeLibrary, safeFileName, titleOf, isMP3, groupUploads, groupByFolder, tracksLabel } from './library.mjs';
import * as PL from './playlists.mjs';
import { VERSION, BUILT } from './version.mjs';

const $ = id => document.getElementById(id);
let tracks = [], saved = new Map(), store = PL.emptyStore();
let settings = { sort: 'folder', sortChosen: false, autosave: false, resume: true, password: '', open: { storage: true, playback: false, library: false, app: false }, collapsed: [] };
let downloading = false, controller, savingID, registration, toastTimer, libraryEtag = '', cloud = { used: 0, limit: 0 };
let currentPlaylist = null, openView = 'home', adminOK = false, announcedUpdate = false;
let activeKey, queueShape, selecting = null;
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
    // Escape や Android の戻るは引数なしで閉じ、前回の returnValue が残る。必ず空に戻してから開く。
    dialog.returnValue = '';
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
    dialog.returnValue = '';
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
// ミニプレイヤーを上へスワイプしても開く。シークバーの上で始まった指は除く。
let swipe;
$('mini').addEventListener('pointerdown', e => { if (e.target !== $('mini-seek')) swipe = { y: e.clientY, id: e.pointerId }; });
$('mini').addEventListener('pointermove', e => { if (swipe && e.pointerId === swipe.id && swipe.y - e.clientY > 40) { swipe = undefined; sheet.open(); } });
$('mini').addEventListener('pointerup', () => { swipe = undefined; });
for (const button of document.querySelectorAll('[data-player]')) button.onclick = () => player[button.dataset.player]();
$('shuffle').onclick = () => player.setShuffle(!player.shuffle);
$('repeat').onclick = () => player.setRepeat(!player.repeat);
$('sheet-save').onclick = () => { const track = player.track; if (track) (saved.has(track.id) ? unsave(track) : download([track])); };
$('sheet-menu').onclick = () => { const track = player.track; if (track) popover.open($('sheet-menu'), trackMenu(track)); };
const seeks = [$('sheet-seek'), $('mini-seek')];
for (const seek of seeks) {
  seek.addEventListener('pointerdown', () => { seek.dataset.dragging = 'true'; });
  seek.addEventListener('input', () => { $('sheet-elapsed').textContent = time(Number(seek.value)); seek.style.setProperty('--p', `${(Number(seek.value) / Number(seek.max)) * 100}%`); });
  seek.addEventListener('change', () => { player.seek(Number(seek.value)); seek.dataset.dragging = 'false'; });
  seek.addEventListener('pointerup', () => { seek.dataset.dragging = 'false'; });
}

function renderPlayer() {
  const track = player.track;
  document.body.classList.toggle('no-mini', !track);
  $('mini').hidden = !track;
  if (!track) return;
  $('mini-title').textContent = $('now-title').textContent = track.title;
  const paused = player.audio.paused;
  const cover = coverURL(track) || '/icon-512.png';
  const image = $('sheet-cover');
  if (image.dataset.source !== cover) { image.dataset.source = cover; image.src = cover; image.onerror = () => { image.src = '/icon-512.png'; image.classList.add('placeholder'); }; }
  image.classList.toggle('placeholder', !coverURL(track));
  const control = saveControl({ saved: saved.has(track.id), saving: savingID === track.id, gone: track.gone, playing: !paused });
  const sheetSave = $('sheet-save');
  sheetSave.className = `icon${control.saved ? ' on' : ''}${control.busy ? ' busy' : ''}`;
  if (sheetSave.dataset.state !== control.icon) { sheetSave.innerHTML = icon(control.icon); sheetSave.dataset.state = control.icon; }
  sheetSave.disabled = Boolean(control.disabled); sheetSave.setAttribute('aria-label', control.label);
  for (const button of document.querySelectorAll('[data-player="toggle"]')) {
    const state = paused ? 'play_arrow' : 'pause';
    if (button.dataset.state !== state) { button.innerHTML = icon(state); button.dataset.state = state; }
    button.setAttribute('aria-label', paused ? 'Play' : 'Pause');
  }
  const duration = Number.isFinite(player.audio.duration) ? player.audio.duration : track.duration;
  const position = player.pendingPosition || player.audio.currentTime || 0;
  for (const seek of seeks) {
    seek.max = duration || 1;
    if (seek.dataset.dragging !== 'true') seek.value = position;
    seek.style.setProperty('--p', `${duration ? (Number(seek.value) / duration) * 100 : 0}%`);
  }
  if (seeks.every(seek => seek.dataset.dragging !== 'true')) $('sheet-elapsed').textContent = time(position);
  $('sheet-duration').textContent = time(duration);
  $('now-subtitle').textContent = `${track.folder}${track.gone ? ' · offline copy' : ''}`;
  $('shuffle').setAttribute('aria-pressed', String(player.shuffle));
  $('shuffle').classList.toggle('on', player.shuffle);
  $('repeat').setAttribute('aria-pressed', String(player.repeat));
  $('repeat').classList.toggle('on', player.repeat);
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
function makeRow(track, { list, playlist, select, grouped } = {}) {
  const row = document.createElement('div');
  row.className = `track${player.track?.id === track.id ? ' active' : ''}${track.gone ? ' gone' : ''}${select?.has(track.id) ? ' selected' : ''}`;
  row.dataset.id = track.id; row.setAttribute('role', 'listitem');
  const play = document.createElement('button'); play.className = 'track-play'; play.setAttribute('aria-label', `Play ${track.title}`);
  const info = document.createElement('span'); info.className = 'track-info';
  const title = document.createElement('span'); title.className = 'track-title'; title.textContent = track.title;
  const meta = document.createElement('span'); meta.className = 'track-meta';
  // フォルダ見出しの下ではフォルダ名を繰り返さない。
  meta.textContent = `${track.duration ? time(track.duration) : '--:--'}${grouped ? '' : ` · ${track.folder}`}`;
  info.append(title, meta); play.append(info);
  play.onclick = () => {
    if (select) { toggleSelect(track.id); return; }
    // 再生中の曲をもう一度タップしたら、頭出しではなく一時停止 / 再開。
    if (player.track?.id === track.id) { player.toggle(); return; }
    const candidates = list.filter(item => playableNow(item) || item.id === track.id);
    player.start(candidates, track.id);
    if (navigator.onLine) void refresh();
  };
  if (select) {
    // 選択中は行全体が選ぶ操作。右端は選択の印だけ。
    const check = document.createElement('span'); check.className = 'icon track-check'; check.innerHTML = icon(select.has(track.id) ? 'check_circle' : 'radio_button_unchecked');
    row.append(play, check);
    return row;
  }
  if (!playlist) longPress(play, () => startSelect(track.id));
  const control = saveControl({ saved: saved.has(track.id), saving: savingID === track.id, gone: track.gone, playing: player.track?.id === track.id && !player.audio.paused });
  const save = document.createElement('button');
  save.className = `track-save icon${control.saved ? ' on' : ''}${control.busy ? ' busy' : ''}`;
  save.innerHTML = icon(control.icon); save.disabled = Boolean(control.disabled);
  save.setAttribute('aria-label', control.label);
  save.onclick = () => (control.saved ? unsave(track) : download([track]));
  const menu = document.createElement('button'); menu.className = 'track-menu icon'; menu.innerHTML = icon('more_horiz');
  menu.setAttribute('aria-label', 'More');
  menu.onclick = () => popover.open(menu, trackMenu(track, playlist));
  row.append(play, save, menu);
  if (playlist) { const handle = document.createElement('span'); handle.className = 'icon track-handle'; handle.innerHTML = icon('drag_handle'); row.prepend(handle); }
  return row;
}
// 曲の「…」メニュー。行でも再生画面でも同じ項目。
function trackMenu(track, playlist) {
  return [
    { icon: 'playlist_play', label: 'Play next', run: () => { player.playNext(track); toast('Added to queue'); }, disabled: !playableNow(track) || player.track?.id === track.id },
    { icon: 'playlist_add', label: 'Add to playlist', run: () => pickPlaylist([track.id]) },
    { icon: 'share', label: 'Share', run: () => shareTrack(track), disabled: track.gone && !saved.has(track.id) },
    { icon: 'info', label: 'Details', run: () => showDetails(track) },
    playlist && { icon: 'remove', label: 'Remove', danger: true, run: () => removeFromPlaylist(playlist, track) },
  ];
}
// 共有。読み取りは無認証なので、リンクは配信 URL そのもの。
// 端末に保存済みなら Cache から本体を渡す（Files に保存、AirDrop）。未保存ならリンク。
// ネットワークから取ってから share を呼ぶと Safari はユーザー操作の期限切れで拒むので、取りに行かない。
let sharing = false;
async function shareTrack(track) {
  if (sharing) return;
  const url = new URL(mediaURL(track), location.href).href;
  const copy = async () => { try { await navigator.clipboard.writeText(url); toast('Link copied'); } catch { toast(url); } };
  if (!navigator.share) { await copy(); return; }
  sharing = true;
  try {
    let data = { title: track.title, url };
    if (navigator.canShare && saved.has(track.id)) {
      const cached = await (await caches.open(AUDIO_CACHE)).match(mediaURL(track));
      if (cached) {
        const file = new File([await cached.blob()], safeFileName(track.title), { type: 'audio/mpeg' });
        if (navigator.canShare({ files: [file] })) data = { title: track.title, files: [file] };
      }
    }
    await navigator.share(data);
  } catch (error) {
    if (error.name !== 'AbortError') await copy();
  } finally { sharing = false; }
}
function showDetails(track) {
  $('detail-title').textContent = track.title;
  const rows = [['Folder', track.folder], ['Length', track.duration ? time(track.duration) : '-'], ['Size', megabytes(track.size)], ['Added', track.uploadedAt ? new Date(track.uploadedAt).toLocaleDateString() : '-'], ['Saved', saved.has(track.id) ? 'Yes' : 'No'], ['Cloud', track.gone ? 'Removed' : 'Available'], ['File', track.id]];
  $('detail-list').replaceChildren(...rows.flatMap(([k, v]) => { const dt = document.createElement('dt'); dt.textContent = k; const dd = document.createElement('dd'); dd.textContent = v; return [dt, dd]; }));
  $('detail').showModal();
}
$('detail-close').onclick = () => $('detail').close();

// 長押しで複数選択に入る。動いたらスクロール、離したら通常のタップ。
function longPress(element, run) {
  let timer, x, y;
  const clear = () => clearTimeout(timer);
  element.addEventListener('pointerdown', e => {
    if (!e.isPrimary) return;
    x = e.clientX; y = e.clientY;
    timer = setTimeout(() => { element.dataset.held = '1'; run(); }, 400);
  });
  element.addEventListener('pointermove', e => { if (Math.abs(e.clientX - x) > 8 || Math.abs(e.clientY - y) > 8) clear(); });
  element.addEventListener('pointerup', clear); element.addEventListener('pointercancel', clear);
  element.addEventListener('click', e => { if (element.dataset.held) { delete element.dataset.held; e.stopImmediatePropagation(); e.preventDefault(); } }, true);
}
function startSelect(id) { selecting = new Set([id]); if (navigator.vibrate) navigator.vibrate(10); renderHome(); }
function toggleSelect(id) { if (selecting.has(id)) selecting.delete(id); else selecting.add(id); renderHome(); }
function endSelect() { selecting = null; renderHome(); }
$('select-close').onclick = endSelect;
$('select-all').onclick = () => { const all = homeTracks(); selecting = new Set(selecting.size === all.length ? [] : all.map(t => t.id)); renderHome(); };
$('select-add').onclick = () => { if (selecting.size) pickPlaylist([...selecting], endSelect); };

// ---- Home ----
const homeTracks = () => arrange(tracks.filter(track => !track.gone), settings.sort);
function renderHome() {
  const visible = homeTracks();
  $('sort-label').textContent = SORT_LABEL[settings.sort];
  $('home-empty').hidden = visible.length > 0;
  $('select-bar').hidden = !selecting; $('home-bar').hidden = Boolean(selecting);
  if (selecting) { $('select-count').textContent = `${selecting.size} selected`; $('select-add').disabled = !selecting.size; }
  // Folder ソートのときだけ見出しで区切る。折りたたんだフォルダは行を出さないが、キュー・一括保存の対象には残る。
  const rows = settings.sort === 'folder'
    ? groupByFolder(visible).flatMap(group => {
      const open = !settings.collapsed.includes(group.folder);
      return [folderHead(group, open), ...(open ? group.tracks.map(track => makeRow(track, { list: visible, select: selecting, grouped: true })) : [])];
    })
    : visible.map(track => makeRow(track, { list: visible, select: selecting }));
  $('tracks').replaceChildren(...rows);
  const pending = visible.filter(track => !saved.has(track.id));
  // ON = 全曲保存済み。途中の状態は OFF として見せ、次のタップで残りを保存する。
  $('save-all').checked = visible.length > 0 && !pending.length;
  $('save-all').disabled = downloading || !visible.length;
  $('shuffle-all').disabled = !visible.length;
}
// フォルダ見出し。タップで折りたたみ、右端でそのフォルダを再生。
function folderHead({ folder, tracks: members }, open) {
  const head = document.createElement('div'); head.className = `folder-head${open ? ' open' : ''}`;
  const toggle = document.createElement('button'); toggle.className = 'folder-toggle';
  toggle.setAttribute('aria-expanded', String(open)); toggle.setAttribute('aria-label', `${open ? 'Collapse' : 'Expand'} ${folder}`);
  const chevron = document.createElement('span'); chevron.className = 'icon chevron'; chevron.innerHTML = icon('keyboard_arrow_down');
  const name = document.createElement('span'); name.className = 'folder-name'; name.textContent = folder;
  const count = document.createElement('span'); count.className = 'track-meta'; count.textContent = `${tracksLabel(members.length)} / ${durationLabel(members.reduce((sum, track) => sum + (track.duration || 0), 0))}`;
  toggle.append(chevron, name, count);
  toggle.onclick = () => {
    settings.collapsed = open ? [...settings.collapsed, folder] : settings.collapsed.filter(name => name !== folder);
    persistSettings(); renderHome();
  };
  const play = document.createElement('button'); play.className = 'icon'; play.innerHTML = icon('play_arrow'); play.setAttribute('aria-label', `Play ${folder}`);
  play.onclick = () => { const c = members.filter(playableNow); if (c.length) { player.setShuffle(false); player.start(c, c[0].id); } else toast('Nothing to play'); };
  head.append(toggle, play);
  return head;
}
$('sort').onclick = () => { settings.sort = nextSort(settings.sort); settings.sortChosen = true; persistSettings(); renderHome(); };
// 一覧をシャッフル再生。開始曲も無作為に選ぶ。
function shufflePlay(list) {
  const candidates = list.filter(playableNow);
  if (!candidates.length) { toast('Nothing to play'); return; }
  player.setShuffle(true);
  player.start(candidates, candidates[Math.floor(Math.random() * candidates.length)].id);
}
$('shuffle-all').onclick = () => shufflePlay(homeTracks());
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
  const rows = PL.resolveTracks(playlist, trackByID, saved);
  const count = document.createElement('span'); count.className = 'card-count';
  count.textContent = `${tracksLabel(playlist.trackIds.length)}${rows.length ? ` / ${durationLabel(rows.reduce((sum, track) => sum + (track.duration || 0), 0))}` : ''}`;
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
    $('playlist-play').disabled = $('playlist-shuffle').disabled = !rows.length;
    $('playlist-tracks').replaceChildren(...rows.map(track => makeRow(track, { list: rows, playlist })));
    return;
  }
  $('playlist-cards').replaceChildren(...store.playlists.map(cardFor));
  $('playlists-empty').hidden = store.playlists.length > 0;
}
makeSortable($('playlist-cards'), { itemSelector: '.card-item', onMove: () => {
  PL.reorder(store, [...$('playlist-cards').querySelectorAll('.card-item')].map(el => el.dataset.id));
  persistStore();
} });
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
const openPlaylistRows = () => { const playlist = store.playlists.find(p => p.id === currentPlaylist); return playlist ? PL.resolveTracks(playlist, trackByID, saved) : []; };
$('playlist-play').onclick = () => { const c = openPlaylistRows().filter(playableNow); if (c.length) { player.setShuffle(false); player.start(c, c[0].id); } else toast('Nothing to play'); };
$('playlist-shuffle').onclick = () => shufflePlay(openPlaylistRows());
$('playlist-menu').onclick = () => {
  const playlist = store.playlists.find(p => p.id === currentPlaylist);
  if (!playlist) return;
  popover.open($('playlist-menu'), [
    { icon: 'queue_music', label: 'Rename', run: async () => { const n = await prompt('Playlist name', playlist.name); if (n) { PL.rename(playlist, n); persistStore(); renderPlaylists(); } } },
    { icon: 'delete', label: 'Delete playlist', danger: true, run: async () => { if (await confirm(`Delete "${playlist.name}"? Saved audio stays on this device.`, { ok: 'Delete' })) { PL.removePlaylist(store, playlist.id); currentPlaylist = null; persistStore(); renderPlaylists(); } } },
  ]);
};
function pickPlaylist(ids, done = () => {}) {
  $('picker-title').textContent = ids.length > 1 ? `Add ${ids.length} tracks to` : 'Add to playlist';
  $('picker-name').value = '';
  const finish = (playlist, added) => { persistStore(); $('picker').close(); toast(added ? `Added ${added} to ${playlist.name}` : 'Already in playlist'); if (openView === 'playlists') renderPlaylists(); done(); };
  $('picker-list').replaceChildren(...store.playlists.map(playlist => {
    const b = document.createElement('button'); b.innerHTML = icon('queue_music');
    const name = document.createElement('span'); name.className = 'picker-name'; name.textContent = playlist.name; b.append(name);
    b.onclick = () => finish(playlist, PL.addTracks(playlist, ids));
    return b;
  }));
  $('picker-new').onsubmit = event => {
    event.preventDefault();
    const name = $('picker-name').value.trim(); if (!name) return;
    const playlist = PL.createPlaylist(store, name); finish(playlist, PL.addTracks(playlist, ids));
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
  const picked = new Set();
  const draw = () => {
    $('chooser-count').textContent = picked.size ? `${picked.size} selected` : 'Add tracks';
    $('chooser-ok').disabled = !picked.size;
    $('chooser-list').replaceChildren(...visible.map(track => {
      const inside = playlist.trackIds.includes(track.id);
      const row = document.createElement('div'); row.className = `track${inside ? ' in' : picked.has(track.id) ? ' selected' : ''}`; row.dataset.id = track.id;
      const button = document.createElement('button'); button.className = 'track-play'; button.disabled = inside;
      button.setAttribute('aria-label', inside ? `${track.title} already added` : `Select ${track.title}`);
      const info = document.createElement('span'); info.className = 'track-info';
      const title = document.createElement('span'); title.className = 'track-title'; title.textContent = track.title;
      const meta = document.createElement('span'); meta.className = 'track-meta'; meta.textContent = time(track.duration);
      info.append(title, meta); button.append(info);
      button.onclick = () => { if (picked.has(track.id)) picked.delete(track.id); else picked.add(track.id); draw(); };
      const check = document.createElement('span'); check.className = 'icon track-check'; check.innerHTML = icon(inside ? 'check' : picked.has(track.id) ? 'check_circle' : 'radio_button_unchecked');
      row.append(button, check); return row;
    }));
  };
  draw();
  $('chooser-ok').onclick = () => {
    const n = PL.addTracks(playlist, [...picked]); persistStore(); $('chooser').close(); renderPlaylists(); if (n) toast(`Added ${n}`);
  };
  $('chooser').showModal();
};
$('chooser-cancel').onclick = () => $('chooser').close();

// ---- Settings ----
async function renderSettings() {
  $('version').textContent = VERSION;
  $('built').textContent = BUILT ? new Date(BUILT).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }) : 'dev';
  for (const card of document.querySelectorAll('#view-settings details')) card.open = settings.open?.[card.dataset.section] ?? card.open;
  $('opt-autosave').checked = settings.autosave; $('opt-resume').checked = settings.resume;
  const savedList = tracks.filter(track => saved.has(track.id));
  const orphanIDs = [...saved.keys()].filter(id => !trackByID(id));
  const used = [...saved.values()].reduce((a, b) => a + b, 0);
  const est = await estimate();
  const percent = est?.quota ? Math.min(100, Math.round(((est.usage || used) / est.quota) * 100)) : 0;
  $('gauge-fill').style.width = `${percent}%`;
  $('gauge').setAttribute('aria-valuenow', String(percent));
  $('storage-line').textContent = `${tracksLabel(saved.size)} / ${bytesLabel(used)}${est?.quota ? ` / ${percent}% of ${bytesLabel(est.quota)}` : ''}`;
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
for (const card of document.querySelectorAll('#view-settings details')) card.addEventListener('toggle', () => { settings.open = { ...settings.open, [card.dataset.section]: card.open }; persistSettings(); });

const authHeaders = () => ({ authorization: `Bearer ${settings.password}` });
async function verifyPassword() {
  if (!settings.password) { adminOK = false; return; }
  try {
    const r = await fetch('/api/auth', { method: 'POST', headers: authHeaders() }); adminOK = r.ok;
    // 変更された古いパスワードは捨てる。起動のたびに警告しない。
    if (r.status === 401) { settings.password = ''; persistSettings(); toast('Wrong password'); }
  } catch { adminOK = false; }
  if (openView === 'settings') renderSettings();
}
$('password-form').onsubmit = async event => {
  event.preventDefault();
  settings.password = $('password').value; $('password').value = ''; persistSettings();
  await verifyPassword();
  if (adminOK) toast('Unlocked');
};
function renderAdmin() {
  $('cloud-line').textContent = cloud.limit ? `Cloud ${bytesLabel(cloud.used)} / ${bytesLabel(cloud.limit)}` : `Cloud ${bytesLabel(cloud.used)}`;
  $('folders').replaceChildren(...[...new Set(tracks.map(t => t.folder))].sort().map(name => { const o = document.createElement('option'); o.value = name; return o; }));
  // R2 と同じ構造で、フォルダごとに折りたたむ。開閉は再描画をまたいで保つ。
  const wasOpen = new Set([...$('admin-tracks').querySelectorAll('details[open]')].map(el => el.dataset.folder));
  const groups = groupByFolder(arrange(tracks.filter(t => !t.gone), 'folder'));
  $('admin-tracks').replaceChildren(...groups.map(({ folder, tracks: members }) => {
    const details = document.createElement('details'); details.className = 'folder'; details.dataset.folder = folder; details.open = wasOpen.has(folder);
    const summary = document.createElement('summary');
    const chevron = document.createElement('span'); chevron.className = 'icon chevron'; chevron.innerHTML = icon('keyboard_arrow_down');
    const name = document.createElement('span'); name.className = 'folder-name'; name.textContent = folder;
    const count = document.createElement('span'); count.className = 'track-meta'; count.textContent = `${tracksLabel(members.length)} / ${megabytes(members.reduce((sum, track) => sum + track.size, 0))}`;
    summary.append(chevron, name, count);
    const list = document.createElement('div'); list.className = 'saved-list';
    list.append(...members.map(track => {
      const row = document.createElement('div'); row.className = 'track';
      const info = document.createElement('span'); info.className = 'track-info'; info.style.padding = '0 12px';
      const title = document.createElement('span'); title.className = 'track-title'; title.textContent = track.title;
      const meta = document.createElement('span'); meta.className = 'track-meta'; meta.textContent = `${time(track.duration)} · ${megabytes(track.size)}`;
      info.append(title, meta);
      const remove = document.createElement('button'); remove.className = 'icon'; remove.innerHTML = icon('delete'); remove.setAttribute('aria-label', `Delete ${track.title} from cloud`);
      remove.onclick = async () => {
        if (!(await confirm(`Delete "${track.title}" from the cloud for everyone?`, { ok: 'Delete' }))) return;
        const r = await fetch(`/api/tracks/${encodeURIComponent(track.id)}`, { method: 'DELETE', headers: authHeaders() });
        if (r.status === 204) { toast('Deleted'); await refresh(true); } else toast(`Delete failed (${r.status})`);
      };
      row.append(info, remove); return row;
    }));
    details.append(summary, list);
    return details;
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
async function putCover(folder, file) {
  const r = await fetch(`/api/covers/${encodeURIComponent(folder)}`, { method: 'PUT', body: file, headers: { ...authHeaders(), 'content-type': 'image/jpeg' } });
  if (r.status === 201) await (await caches.open(COVER_CACHE)).delete(`/covers/${encodeURIComponent(folder)}`);
  return r.status;
}
// まとめてアップロード。jobs = [{ folder, files, cover }]。1 つずつ順に送り、既存は飛ばし、満杯なら止める。
let uploading = false;
async function uploadJobs(jobs) {
  if (uploading) { toast('Upload in progress'); return; }
  uploading = true;
  const total = jobs.reduce((sum, job) => sum + job.files.length, 0);
  let done = 0, exists = 0, failed = 0, index = 0;
  try {
    for (const { folder, files, cover } of jobs) {
      if (cover && (await putCover(folder, cover)) !== 201) failed++;
      for (const file of files) {
        $('upload-status').textContent = `${++index} / ${total} · ${folder} / ${file.name}`;
        const duration = await durationOf(file);
        if (!duration) { failed++; toast(`Can't read ${file.name}`); continue; }
        const key = `${folder}/${safeFileName(file.name)}`;
        const r = await fetch(`/api/tracks/${encodeURIComponent(key)}`, { method: 'PUT', body: file, headers: { ...authHeaders(), 'content-type': 'audio/mpeg', 'x-title': encodeURIComponent(titleOf(file.name)), 'x-duration': String(duration) } });
        if (r.status === 201) done++;
        else if (r.status === 409) exists++;
        else if (r.status === 507) { toast('Cloud storage is full'); return; }
        else { failed++; toast(`Upload failed (${r.status}): ${file.name}`); }
      }
    }
  } finally {
    uploading = false; $('upload-status').textContent = '';
    const parts = [done && `Uploaded ${done}`, exists && `${exists} already there`, failed && `${failed} failed`].filter(Boolean);
    if (parts.length) toast(parts.join(' · '));
    if (done || jobs.some(job => job.cover)) await refresh(true);
  }
}
// ファイル選択（フォルダ名は入力欄）。
$('upload-files').onchange = () => {
  const folder = $('upload-folder').value.trim();
  const files = [...$('upload-files').files].filter(file => isMP3(file.name)); $('upload-files').value = '';
  if (!folder) { toast('Enter a folder name'); return; }
  if (files.length) uploadJobs([{ folder, files }]);
};
$('upload-cover').onchange = async () => {
  const folder = $('upload-folder').value.trim(); const file = $('upload-cover').files[0]; $('upload-cover').value = '';
  if (!folder || !file) { toast('Enter a folder name'); return; }
  const status = await putCover(folder, file);
  if (status === 201) { toast('Cover updated'); await refresh(true); } else toast(`Upload failed (${status})`);
};
// フォルダ選択とドロップ。直下のフォルダ名を R2 のフォルダにする。フォルダ直下でないファイルは入力欄のフォルダへ。
const uploadJobsFor = entries => groupUploads(entries, $('upload-folder').value.trim());
$('upload-dir').onchange = () => {
  const entries = [...$('upload-dir').files].map(file => ({ file, path: file.webkitRelativePath || file.name })); $('upload-dir').value = '';
  const jobs = uploadJobsFor(entries);
  if (jobs.length) uploadJobs(jobs); else toast('No MP3 found');
};
async function readDropped(items) {
  const entries = [];
  async function walk(entry, prefix) {
    if (entry.isFile) { const file = await new Promise((ok, no) => entry.file(ok, no)); entries.push({ file, path: prefix + file.name }); return; }
    if (!entry.isDirectory) return;
    const reader = entry.createReader();
    // readEntries は一度に全部返さない。空になるまで繰り返す。
    for (;;) { const batch = await new Promise((ok, no) => reader.readEntries(ok, no)); if (!batch.length) break; for (const child of batch) await walk(child, `${prefix}${entry.name}/`); }
  }
  for (const item of items) { const entry = item.webkitGetAsEntry?.(); if (entry) await walk(entry, ''); }
  return entries;
}
for (const type of ['dragenter', 'dragover']) $('admin').addEventListener(type, e => { e.preventDefault(); $('admin').classList.add('over'); });
$('admin').addEventListener('dragleave', e => { if (!$('admin').contains(e.relatedTarget)) $('admin').classList.remove('over'); });
$('admin').addEventListener('drop', async e => {
  e.preventDefault(); $('admin').classList.remove('over');
  const jobs = uploadJobsFor(await readDropped([...e.dataTransfer.items]));
  if (jobs.length) uploadJobs(jobs); else toast($('upload-folder').value.trim() ? 'No MP3 found' : 'Drop a folder, or enter a folder name');
});

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
      cloud = { used: body.used || 0, limit: body.limit || 0 };
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
// 新しい Service Worker がインストールを終えるのを待ってから切り替え、制御が移ったら読み込み直す。
// 途中で待たされないよう、一定時間で必ず読み込み直す。
let updating = false;
function activate(worker) {
  if (!worker) return false;
  navigator.serviceWorker.addEventListener('controllerchange', () => location.reload(), { once: true });
  const tell = () => worker.postMessage('activate-update');
  if (worker.state === 'installed') tell();
  else worker.addEventListener('statechange', () => { if (worker.state === 'installed') tell(); if (worker.state === 'activated') location.reload(); });
  return true;
}
async function applyUpdate() {
  if (updating) return;
  updating = true;
  toast('Updating…');
  const fallback = setTimeout(() => location.reload(), 8000);
  try {
    if (!registration) { location.reload(); return; }
    await registration.update();
    if (!activate(registration.waiting || registration.installing)) {
      // 既に新しい版が動いているか、取得できなかった。読み込み直して確かめる。
      clearTimeout(fallback); location.reload();
    }
  } catch { clearTimeout(fallback); location.reload(); }
}
// 起動時に待機中の新版があれば、再生前なので黙って切り替える。
function adoptWaiting(reg) {
  if (reg.waiting && !sessionStorage.getItem('muu-adopted')) {
    sessionStorage.setItem('muu-adopted', '1');
    activate(reg.waiting);
  } else sessionStorage.removeItem('muu-adopted');
}

// ---- ホーム画面追加の案内（ブラウザで開いたときだけ） ----
let installPrompt;
window.addEventListener('beforeinstallprompt', event => { event.preventDefault(); installPrompt = event; $('install-go').hidden = false; });
function offerInstall() {
  const standalone = matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
  if (standalone || settings.installDismissed) return;
  const ios = /iphone|ipad|ipod/i.test(navigator.userAgent);
  $('install-text').textContent = ios ? 'Share → Add to Home Screen for offline play' : 'Add to Home Screen for offline play';
  $('install').hidden = false;
}
$('install-go').onclick = async () => { if (!installPrompt) return; installPrompt.prompt(); await installPrompt.userChoice.catch(() => {}); installPrompt = undefined; $('install').hidden = true; };
$('install-close').onclick = () => { $('install').hidden = true; settings.installDismissed = true; persistSettings(); };

// ---- 起動 ----
async function start() {
  const [library, savedSettings, playlists, playerState] = await Promise.all([readState('library'), readState('settings'), readState('playlists'), readState('player')]).catch(() => []);
  settings = { ...settings, ...(savedSettings || {}) };
  // 自分でソートを変えたことが無い端末は、標準のフォルダ表示へ。
  if (!settings.sortChosen) settings.sort = 'folder';
  store = PL.normalise(playlists);
  saved = await savedTracks();
  if (library?.tracks) { tracks = library.tracks; libraryEtag = library.etag || ''; for (const t of tracks) known.add(t.id); }
  else $('loading').hidden = false;
  renderAll(); offerInstall();
  if (settings.resume && playerState) player.restore(playerState);
  renderPlayer();
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('/sw.mjs', { type: 'module', updateViaCache: 'none' }).then(r => { registration = r; adoptWaiting(r); }).catch(() => {});
  }
  await refresh(true);
  $('loading').hidden = true;
  void verifyPassword();
  void checkUpdate();
  window.addEventListener('online', () => refresh());
  document.addEventListener('visibilitychange', () => { if (!document.hidden) { refresh(); checkUpdate(); } });
}
start();
