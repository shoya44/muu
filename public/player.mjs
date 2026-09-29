// 再生キュー。項目は曲とは別のキーを持つので、同じ曲を複数回入れても個別に動かせる。
import { mediaURL, coverURL } from './library.mjs';

let counter = 0;
const entry = track => ({ key: `q${Date.now().toString(36)}${(counter++).toString(36)}`, track });

export class Player {
  constructor(audio, { changed, message, persist, played = () => {} }) {
    this.audio = audio; this.changed = changed; this.message = message; this.persist = persist;
    this.listened = 0; this.counted = false; this.lastTime = 0; this.lastWall = 0; this.played = played;
    this.queue = []; this.order = []; this.history = [];
    this.index = -1; this.pendingPosition = 0; this.failed = new Set(); this.wantsPlayback = false;
    this.shuffle = false; this.repeat = false;
    audio.addEventListener('loadedmetadata', () => {
      if (this.pendingPosition) audio.currentTime = Math.min(this.pendingPosition, Math.max(0, audio.duration - 0.2));
      this.pendingPosition = 0; changed();
    });
    for (const type of ['play', 'pause', 'durationchange']) audio.addEventListener(type, () => { if (type === 'play') this.configureMediaSession(); changed(); this.save(); });
    audio.addEventListener('timeupdate', () => { this.tally(); changed(); if (Date.now() - (this.lastSave || 0) > 3000) this.save(); });
    audio.addEventListener('play', () => this.mark());
    audio.addEventListener('pause', () => this.tally());
    audio.addEventListener('seeked', () => { this.mark(); this.save(); });
    audio.addEventListener('ended', () => { this.tally(); this.next(); });
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

  configureMediaSession() {
    if (!('mediaSession' in navigator)) return;
    const handlers = {
      play: () => this.play(), pause: () => this.pause(),
      nexttrack: () => this.next(), previoustrack: () => this.previousTrack(),
      seekto: detail => this.seek(detail.seekTime),
      // iOS はスキップの handler があるとロック画面の前/次をスキップに置き換える。曲送りを残すため登録しない。
      seekbackward: null, seekforward: null,
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
    this.shuffle = Boolean(state.shuffle); this.repeat = Boolean(state.repeat);
    this.history = Array.isArray(state.history) ? state.history : [];
    this.load(autoplay, state.position || 0);
  }
  // 一覧に無くなった曲の情報を最新に置き換える（gone フラグなど）。
  refreshTracks(lookup) {
    let touched = false;
    for (const item of this.queue) { const fresh = lookup(item.track.id); if (fresh && fresh !== item.track) { item.track = fresh; touched = true; } }
    if (touched) { this.changed(); this.save(); }
  }
  // 改名・移動された曲を新しい key に付け替える。今の曲なら同じ位置・同じ再生状態で新しい URL から読み直す。
  followMoves(moves, lookup) {
    let current = false, touched = false;
    for (const item of this.queue) {
      const fresh = moves.has(item.track.id) && lookup(moves.get(item.track.id));
      if (!fresh) continue;
      if (item === this.item) current = true;
      item.track = fresh; touched = true;
    }
    if (current) this.load(!this.audio.paused, this.pendingPosition || this.audio.currentTime || 0);
    else if (touched) { this.changed(); this.save(); }
  }
  // 再生数: 30 秒、または曲の半分を聴いたら 1 回。
  // 聴いた時間は再生位置の進みで測る。ただし実時間より大きく進んだ分（シーク）は入れない。
  // 画面ロック中などでイベントの間隔が空いても、実時間も同じだけ進んでいるので取りこぼさない。
  mark(position = this.audio.currentTime) { this.lastTime = position; this.lastWall = performance.now(); }
  tally() {
    const now = this.audio.currentTime, wall = performance.now();
    const step = now - this.lastTime, elapsed = (wall - this.lastWall) / 1000;
    this.lastTime = now; this.lastWall = wall;
    if (!this.track || this.counted || step <= 0 || step > elapsed * (this.audio.playbackRate || 1) + 1) return;
    this.listened += step;
    if (this.listened >= Math.min(30, (this.track.duration || this.audio.duration || 60) / 2)) { this.counted = true; this.played(this.track); }
  }
  start(tracks, id) {
    this.failed.clear(); this.history = [];
    this.queue = tracks.map(entry);
    this.order = this.queue.map(item => item.key);
    this.index = Math.max(0, this.queue.findIndex(item => item.track.id === id));
    if (this.shuffle) this.applyOrder();
    this.load(true);
  }
  // シャッフル ON は現在曲を先頭にして、残り全部（再生済みも含む）を並べ替える。
  // OFF は元の並び（order）に戻し、現在曲はそのまま。
  applyOrder() {
    const current = this.item;
    if (this.shuffle) {
      const rest = this.queue.filter(item => item !== current);
      for (let i = rest.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [rest[i], rest[j]] = [rest[j], rest[i]]; }
      this.queue = current ? [current, ...rest] : rest;
    } else {
      this.queue = [...this.queue].sort((a, b) => this.order.indexOf(a.key) - this.order.indexOf(b.key));
    }
    this.index = current ? this.queue.indexOf(current) : -1;
    this.history = [];
    this.changed(); this.save();
  }
  setShuffle(value) { this.shuffle = value; this.applyOrder(); }
  setRepeat(value) { this.repeat = value; this.changed(); this.save(); }

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
    this.listened = 0; this.counted = false; this.mark(position);
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
  // キューの末尾に来たら止まる。リピート中は先頭へ戻り、シャッフル中なら並べ直す。
  next() {
    let next = this.index + 1;
    while (next < this.queue.length && this.failed.has(this.queue[next].track.id)) next++;
    if (next >= this.queue.length) {
      if (!this.repeat || !this.queue.some(item => !this.failed.has(item.track.id))) { this.pause(); this.save(); return; }
      this.index = -1; this.history = [];
      if (this.shuffle) this.applyOrder();
      next = 0;
      while (this.failed.has(this.queue[next].track.id)) next++;
    } else if (this.item) this.history.push(this.item.key);
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
    return this.persist({ queue: this.queue, order: this.order, index: this.index, position, shuffle: this.shuffle, repeat: this.repeat, history: this.history.slice(-100) });
  }
}
