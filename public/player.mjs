// 再生キュー。項目は曲とは別のキーを持つので、同じ曲を複数回入れても個別に動かせる。
import { mediaURL, coverURL } from './library.mjs';

let counter = 0;
const entry = track => ({ key: `q${Date.now().toString(36)}${(counter++).toString(36)}`, track });

export class Player {
  constructor(audio, { changed, message, persist }) {
    this.audio = audio; this.changed = changed; this.message = message; this.persist = persist;
    this.queue = []; this.order = []; this.history = [];
    this.index = -1; this.pendingPosition = 0; this.failed = new Set(); this.wantsPlayback = false;
    this.shuffle = false;
    audio.addEventListener('loadedmetadata', () => {
      if (this.pendingPosition) audio.currentTime = Math.min(this.pendingPosition, Math.max(0, audio.duration - 0.2));
      this.pendingPosition = 0; changed();
    });
    for (const type of ['play', 'pause', 'durationchange']) audio.addEventListener(type, () => { if (type === 'play') this.configureMediaSession(); changed(); this.save(); });
    audio.addEventListener('timeupdate', () => { changed(); if (Date.now() - (this.lastSave || 0) > 3000) this.save(); });
    audio.addEventListener('seeked', () => this.save());
    audio.addEventListener('ended', () => this.next(true));
    audio.addEventListener('error', () => {
      if (!this.track) return;
      if (!this.failed.has(this.track.id)) { this.failed.add(this.track.id); message(`Can't play: ${this.track.title}`); }
      if (this.wantsPlayback) this.next();
    });
    this.configureMediaSession();
    document.addEventListener('visibilitychange', () => { if (document.hidden) this.save(); });
  }
  get item() { return this.queue[this.index]; }
  get track() { return this.queue[this.index]?.track; }
  get playable() { return this.queue.filter(item => !this.failed.has(item.track.id)); }

  configureMediaSession() {
    if (!('mediaSession' in navigator)) return;
    const handlers = {
      play: () => this.play(), pause: () => this.pause(),
      nexttrack: () => this.next(), previoustrack: () => this.previousTrack(),
      seekto: detail => this.seek(detail.seekTime),
      seekbackward: detail => this.seek(this.audio.currentTime - (detail.seekOffset || this.skip || 10)),
      seekforward: detail => this.seek(this.audio.currentTime + (detail.seekOffset || this.skip || 10)),
    };
    for (const [action, handler] of Object.entries(handlers)) {
      try { navigator.mediaSession.setActionHandler(action, handler); } catch { /* unsupported */ }
    }
  }
  restore(state, autoplay = false) {
    if (!state?.queue?.length) return;
    this.queue = state.queue.map(value => (value?.track ? value : entry(value)));
    this.index = Number.isInteger(state.index) ? state.index : 0;
    if (!this.queue[this.index]) return;
    this.order = state.order?.length === this.queue.length ? state.order : this.queue.map(item => item.key);
    this.shuffle = Boolean(state.shuffle);
    this.history = Array.isArray(state.history) ? state.history : [];
    this.load(autoplay, state.position || 0);
  }
  // 一覧に無くなった曲の情報を最新に置き換える（gone フラグなど）。
  refreshTracks(lookup) {
    let touched = false;
    for (const item of this.queue) { const fresh = lookup(item.track.id); if (fresh && fresh !== item.track) { item.track = fresh; touched = true; } }
    if (touched) { this.changed(); this.save(); }
  }
  start(tracks, id) {
    this.failed.clear(); this.history = [];
    this.queue = tracks.map(entry);
    this.order = this.queue.map(item => item.key);
    this.index = Math.max(0, this.queue.findIndex(item => item.track.id === id));
    if (this.shuffle) this.applyOrder();
    this.load(true);
  }
  // シャッフルは現在曲を維持し、未再生部分だけを並べ替える。
  applyOrder() {
    const upcoming = this.queue.slice(this.index + 1);
    if (this.shuffle) {
      for (let i = upcoming.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [upcoming[i], upcoming[j]] = [upcoming[j], upcoming[i]]; }
    } else {
      upcoming.sort((a, b) => this.order.indexOf(a.key) - this.order.indexOf(b.key));
    }
    this.queue = [...this.queue.slice(0, this.index + 1), ...upcoming];
    this.changed(); this.save();
  }
  setShuffle(value) { this.shuffle = value; this.applyOrder(); }

  playNext(track) {
    if (!this.queue.length) {
      this.queue = [entry(track)]; this.order = [this.queue[0].key]; this.index = 0;
      this.load(false); return;
    }
    const added = entry(track);
    this.queue.splice(this.index + 1, 0, added);
    this.order.splice(Math.max(0, this.order.indexOf(this.item.key)) + 1, 0, added.key);
    this.changed(); this.save();
  }
  removeAt(index) {
    if (index === this.index || !this.queue[index]) return false;
    const [removed] = this.queue.splice(index, 1);
    const listed = this.order.indexOf(removed.key);
    if (listed >= 0) this.order.splice(listed, 1);
    if (index < this.index) this.index--;
    this.changed(); this.save();
    return true;
  }
  moveItem(from, to) {
    if (from === to || !this.queue[from] || to < 0 || to >= this.queue.length) return false;
    const currentKey = this.item?.key;
    const [moved] = this.queue.splice(from, 1);
    this.queue.splice(to, 0, moved);
    this.order = this.queue.map(item => item.key);
    const current = this.queue.findIndex(item => item.key === currentKey);
    if (current >= 0) this.index = current;
    this.changed(); this.save();
    return true;
  }
  playAt(index) {
    if (!this.queue[index]) return;
    if (this.item) this.history.push(this.item.key);
    this.index = index; this.load(true);
  }

  load(autoplay, position = 0) {
    if (!this.track) return;
    this.wantsPlayback = autoplay;
    this.audio.pause(); this.pendingPosition = position;
    this.audio.src = mediaURL(this.track); this.audio.load();
    if ('mediaSession' in navigator) {
      const cover = coverURL(this.track);
      navigator.mediaSession.metadata = new MediaMetadata({
        title: this.track.title, artist: this.track.folder || 'muu', album: this.track.folder || '',
        artwork: [{ src: cover || '/icon-512.png', sizes: '512x512', type: cover ? 'image/jpeg' : 'image/png' }],
      });
    }
    this.changed(); this.save(position);
    if (autoplay) this.play();
  }
  async play() {
    if (!this.track) return;
    this.wantsPlayback = true;
    try { await this.audio.play(); }
    catch (error) { if (error.name !== 'AbortError') this.message('Tap play to start'); }
  }
  pause() { this.wantsPlayback = false; this.audio.pause(); }
  toggle() { if (this.audio.paused) this.play(); else this.pause(); }
  next() {
    let next = this.index + 1;
    while (next < this.queue.length && this.failed.has(this.queue[next].track.id)) next++;
    if (next >= this.queue.length) { this.pause(); this.save(); return; }
    if (this.item) this.history.push(this.item.key);
    this.index = next; this.load(true);
  }
  previous() { if (this.audio.currentTime > 3) this.seek(0); else this.previousTrack(); }
  previousTrack() {
    const key = this.history.pop();
    const at = key ? this.queue.findIndex(item => item.key === key) : -1;
    if (at >= 0) { this.index = at; this.load(true); return; }
    if (this.index > 0) { this.index--; this.load(true); return; }
    this.seek(0);
  }
  seek(time) {
    if (Number.isFinite(this.audio.duration)) this.audio.currentTime = Math.max(0, Math.min(time, this.audio.duration));
  }
  save(position = this.pendingPosition || this.audio.currentTime || 0) {
    if (!this.track) return Promise.resolve();
    this.lastSave = Date.now();
    return this.persist({ queue: this.queue, order: this.order, index: this.index, position, shuffle: this.shuffle, history: this.history.slice(-100) });
  }
}
