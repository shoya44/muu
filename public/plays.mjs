// 再生数の送信待ち。数えた回数は端末に貯め、通信できるときにまとめて送る（オフラインで聴いた分も後で届く）。
// 形: { pending: { <曲の key>: 回数 }, sending: { batch, plays } | null }。
// 送る分は送信 ID を付けて sending に移してから送る。応答を受け取れなければ同じ ID で送り直し、サーバーが重複を捨てる。
import { readState, writeState } from './storage.mjs';

const KEY = 'plays';
let state = { pending: {}, sending: null };
let flushing;

const uid = () => `b${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`;
const persist = () => writeState(KEY, state).catch(() => {});

export async function loadPlays() {
  try {
    const saved = await readState(KEY);
    if (saved && typeof saved.pending === 'object') state = { pending: saved.pending || {}, sending: saved.sending?.batch ? saved.sending : null };
  } catch { /* 無ければ空から */ }
}
// まだサーバーに届いていない、この端末の回数。表示ではサーバーの回数に足す。
export function unsent(id) { return (state.pending[id] || 0) + (state.sending?.plays[id] || 0); }

export async function recordPlay(id) {
  state.pending = { ...state.pending, [id]: (state.pending[id] || 0) + 1 };
  await persist();
}

// 送れた分があれば true。通信できなければ貯めたまま次の機会を待つ。
export function flushPlays() {
  if (!flushing) flushing = (async () => {
    let sent = false;
    try {
      for (;;) {
        if (!state.sending) {
          if (!Object.keys(state.pending).length) break;
          state = { pending: {}, sending: { batch: uid(), plays: state.pending } };
          await persist();
        }
        const r = await fetch('/api/plays', { method: 'POST', body: JSON.stringify(state.sending), headers: { 'content-type': 'application/json' } });
        // 400 は送り直しても通らない（壊れた記録）。捨てて先へ進む。
        if (r.status !== 204 && r.status !== 400) break;
        state = { ...state, sending: null }; sent = sent || r.status === 204;
        await persist();
      }
    } catch { /* オフライン: 貯めたまま */ }
    return sent;
  })().finally(() => { flushing = undefined; });
  return flushing;
}

// 改名・移動された曲の、送信待ちの回数も付け替える。
export function followMoves(moves) {
  const remap = plays => {
    const out = {};
    for (const [id, count] of Object.entries(plays)) { const to = moves.get(id) || id; out[to] = (out[to] || 0) + count; }
    return out;
  };
  state = { pending: remap(state.pending), sending: state.sending && { ...state.sending, plays: remap(state.sending.plays) } };
  persist();
}
