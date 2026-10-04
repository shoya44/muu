// 再生数。R2 の 1 オブジェクト（STATS_KEY）に { plays: { <曲の key>: 回数 }, last: { <曲の key>: 最後に聴かれた時刻(ms) }, batches: [最近受け付けた送信 ID] } を置く。
// last は Recently Played の並び。誰が聴いたかは持たない。
// フォルダ直下ではない key なので、一覧（buildLibrary）には曲として出ない。
// 無くても壊れても再生・保存には影響しない。読めなければ全曲 0 回として扱う。
import { isTrackKey } from './library.mjs';

export const STATS_KEY = '_stats.json';
const KEEP_BATCHES = 1000;  // 送り直しを重複して数えないために覚えておく送信 ID の数。
const MAX_TRACKS = 1000;    // 1 回の送信に含められる曲数。
const MAX_COUNT = 1000;     // 1 曲あたり 1 回の送信で足せる回数。

export function parseStats(text) {
  try {
    const value = JSON.parse(text || '{}');
    const plays = value && typeof value.plays === 'object' && value.plays ? value.plays : {};
    const clean = {};
    for (const [key, count] of Object.entries(plays)) if (isTrackKey(key) && Number.isInteger(count) && count > 0) clean[key] = count;
    const last = {};
    for (const [key, at] of Object.entries(value?.last && typeof value.last === 'object' ? value.last : {})) if (clean[key] && validTime(at)) last[key] = at;
    return { plays: clean, last, batches: Array.isArray(value?.batches) ? value.batches.filter(id => typeof id === 'string').slice(-KEEP_BATCHES) : [] };
  } catch { return { plays: {}, last: {}, batches: [] }; }
}
const validTime = at => Number.isSafeInteger(at) && at > 0;

// 端末からの送信を検める。{ batch: 送信 ID, plays: { key: 回数 }, last?: { key: 時刻 } }。不正なら null。
// last は古い端末からは来ない。来ても plays に無い曲、数でない時刻は捨てる。未来の時刻は受け取った時刻に丸める。
export function validReport(body, now = Date.now()) {
  if (!body || typeof body.batch !== 'string' || !/^[A-Za-z0-9_-]{8,64}$/.test(body.batch)) return null;
  if (!body.plays || typeof body.plays !== 'object') return null;
  const entries = Object.entries(body.plays);
  if (!entries.length || entries.length > MAX_TRACKS) return null;
  const plays = {};
  for (const [key, count] of entries) {
    if (!isTrackKey(key) || !Number.isInteger(count) || count < 1 || count > MAX_COUNT) return null;
    plays[key] = count;
  }
  const last = {};
  for (const [key, at] of Object.entries(body.last && typeof body.last === 'object' ? body.last : {})) if (plays[key] && validTime(at)) last[key] = Math.min(at, now);
  return { batch: body.batch, plays, last };
}

// 送信を足し込む。同じ送信 ID は一度だけ数える（端末は応答を受け取れなければ同じ ID で送り直す）。
export function addReport(stats, report) {
  if (stats.batches.includes(report.batch)) return stats;
  const plays = { ...stats.plays }, last = { ...stats.last };
  for (const [key, count] of Object.entries(report.plays)) plays[key] = (plays[key] || 0) + count;
  for (const [key, at] of Object.entries(report.last || {})) last[key] = Math.max(last[key] || 0, at);
  return { plays, last, batches: [...stats.batches, report.batch].slice(-KEEP_BATCHES) };
}

// 曲の改名・移動と削除に回数を付いて行かせる。
export function moveCount(stats, from, to) {
  if (!stats.plays[from]) return stats;
  const plays = { ...stats.plays }, last = { ...stats.last };
  if (to) plays[to] = (plays[to] || 0) + plays[from];
  if (to && last[from]) last[to] = Math.max(last[to] || 0, last[from]);
  delete plays[from]; delete last[from];
  return { ...stats, plays, last };
}

// 読んで、変えて、読んだときから変わっていなければ書く。ぶつかったら読み直してやり直す。
export async function updateStats(bucket, change) {
  for (let attempt = 0; attempt < 5; attempt++) {
    const object = await bucket.get(STATS_KEY);
    const before = parseStats(object ? await object.text() : '');
    const after = change(before);
    if (after === before) return after;
    const onlyIf = object ? { etagMatches: object.etag } : new Headers({ 'if-none-match': '*' });
    const written = await bucket.put(STATS_KEY, JSON.stringify(after), { httpMetadata: { contentType: 'application/json' }, onlyIf });
    if (written) return after;
  }
  throw new Error('stats_conflict');
}

export async function readPlays(bucket) {
  try {
    const object = await bucket.get(STATS_KEY);
    const { plays, last } = parseStats(object ? await object.text() : '');
    return { plays, last };
  } catch { return { plays: {}, last: {} }; }
}
