// 再生キュー。項目は曲とは別のキーを持つので、同じ曲を複数回入れても個別に動かせる。
import { mediaURL, coverURL } from './library.mjs';

let counter = 0;
const entry = track => ({ key: `q${Date.now().toString(36)}${(counter++).toString(36)}`, track });
// これより長く止めていた曲は、再開のとき音声を読み直す。iOS は止まっている間に音声の経路を手放し、
// そのまま play() すると「再生中なのに無音」になることがある。保存済みなら Cache から読むので一瞬で済む。
const STALE_AFTER = 60 * 1000;

export class Player {
  constructor(audio, { changed, message, persist, played = () => {} }) {
    this.audio = audio; this.changed = changed; this.message = message; this.persist = persist;
    this.listened = 0; this.counted = false; this.lastTime = 0; this.lastWall = 0; this.played = played;
    this.queue = []; this.order = []; this.history = [];
    this.index = -1; this.pendingPosition = 0; this.failed = new Set(); this.wantsPlayback = false;
    this.shuffle = false; this.repeat = false;
    // switching: 曲を差し替えて鳴り始めるまで。この間は止まって見えても「再生中」として扱う（ロック画面が一時停止に戻らない）。
    // stale: 次の再開で音声を読み直す。外から止められた（他のアプリ、着信、Siri）か、長く止めていたとき。
    this.switching = false; this.stale = false; this.pausedAt = 0;
    audio.addEventListener('loadedmetadata', () => {
      if (this.pendingPosition) audio.currentTime = Math.min(this.pendingPosition, Math.max(0, audio.duration - 0.2));
      this.pendingPosition = 0; changed(); this.updatePosition();
    });
    for (const type of ['play', 'pause', 'durationchange']) audio.addEventListener(type, () => { if (type === 'play') this.configureMediaSession(); changed(); this.save(); this.updatePosition(); });
    audio.addEventListener('timeupdate', () => { this.tally(); changed(); if (Date.now() - (this.lastSave || 0) > 3000) this.save(); });
    audio.addEventListener('play', () => this.mark());
    audio.addEventListener('playing', () => { this.switching = false; this.stale = false; changed(); });
    audio.addEventListener('pause', () => {
      this.tally(); this.pausedAt = Date.now();
      // 自分で止めていないのに止まった（曲の終わりを除く）。iOS の割り込みなど。再開のときに読み直す。
      if (this.wantsPlayback && !this.switching && !audio.ended) this.stale = true;
    });
    // 差し替え直後の play() が通らなかったとき（バックグラウンドで読み込みが間に合わない等）、読めた時点でもう一度。
    audio.addEventListener('canplay', () => { if (this.switching && this.wantsPlayback && audio.paused) audio.play().catch(() => {}); });
    audio.addEventListener('seeked', () => { this.mark(); this.save(); this.updatePosition(); });
    audio.addEventListener('ratechange', () => this.updatePosition());
    audio.addEventListener('ended', () => { this.tally(); this.next(); });
    audio.addEventListener('error', () => {
      this.switching = false;
      if (!this.track) return;
      if (!this.failed.has(this.track.id)) { this.failed.add(this.track.id); message(`Can't play: ${this.track.title}`); }
      if (this.wantsPlayback) this.next();
    });
    this.configureMediaSession();
    this.configureAudioSession();
    document.addEventListener('visibilitychange', () => { if (document.hidden) this.save(); });
  }
  get item() { return this.queue[this.index]; }
  get track() { return this.queue[this.index]?.track; }
  // 曲の差し替え中も含めて、鳴っている（鳴らそうとしている）か。表示とロック画面はこちらを見る。
  get playing() { return !this.audio.paused || (this.switching && this.wantsPlayback); }

  // iOS（Safari 17 以降）の Audio Session。音楽として扱わせ、他のアプリに割り込まれて終わったら続きから戻る。
  // 利用者が自分で止めていなければ（wantsPlayback のまま）再開する。止めていたら何もしない。
  configureAudioSession() {
    const session = navigator.audioSession;
    if (!session) return;
    try { session.type = 'playback'; } catch { /* unsupported */ }
    // 戻すのは割り込みが明けたときだけ。イヤホンを外したとき（経路の変更）は止まったままにする。
    let interrupted = false;
    session.addEventListener?.('statechange', () => {
      if (session.state === 'interrupted') { interrupted = true; this.stale = true; return; }
      if (!interrupted) return;
      interrupted = false;
      if (this.wantsPlayback && this.audio.paused && this.track) this.play();
    });
  }
  // ロック画面・通知のシークバーと経過時間。
  updatePosition() {
    if (!navigator.mediaSession?.setPositionState) return;
    const duration = this.audio.duration;
    if (!Number.isFinite(duration) || duration <= 0) return;
    try { navigator.mediaSession.setPositionState({ duration, position: Math.min(this.audio.currentTime || 0, duration), playbackRate: this.audio.playbackRate || 1 }); } catch { /* unsupported */ }
  }

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

  // 曲を読み込む。先に pause() を呼ばない。iOS はロック画面からの曲送りの途中で一度でも止まると、
  // 音声の経路を手放して次の play() が無音になることがある。src の差し替えだけで前の曲は止まる。
  // keepCount: 同じ曲の読み直し（再開）。再生数の途中経過を捨てない。
  load(autoplay, position = 0, { keepCount = false } = {}) {
    if (!this.track) return;
    this.wantsPlayback = autoplay; this.switching = autoplay; this.stale = false;
    if (!keepCount) { this.listened = 0; this.counted = false; }
    this.mark(position);
    this.pendingPosition = position;
    if (!autoplay) this.audio.pause();
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
    // 割り込まれた後や長く止めていた後は、今の位置から読み直して鳴らす（無音で進むのを避ける）。
    const stale = this.audio.paused && !this.switching && this.audio.currentSrc
      && (this.stale || (this.pausedAt && Date.now() - this.pausedAt > STALE_AFTER));
    // 曲の終わりで止まっていたなら頭から（play() と同じ）。
    if (stale) { this.load(true, this.audio.ended ? 0 : this.audio.currentTime || 0, { keepCount: !this.audio.ended }); return; }
    this.wantsPlayback = true;
    try { await this.audio.play(); }
    catch (error) { if (error.name !== 'AbortError') { this.switching = false; this.changed(); this.message('Tap play to start'); } }
  }
  pause() { this.wantsPlayback = false; this.switching = false; this.audio.pause(); }
  toggle() { if (this.playing) this.pause(); else this.play(); }
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
