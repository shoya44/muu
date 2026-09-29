import test from 'node:test';
import assert from 'node:assert/strict';
import { parseStats, validReport, addReport, moveCount, updateStats, STATS_KEY } from '../../worker/stats.mjs';
import { buildLibrary, etagFor } from '../../worker/library.mjs';

test('stats: broken or missing data reads as zero plays', () => {
  assert.deepEqual(parseStats(''), { plays: {}, batches: [] });
  assert.deepEqual(parseStats('{oops'), { plays: {}, batches: [] });
  assert.deepEqual(parseStats('{"plays":{"a/1.mp3":3,"bad":2,"a/2.mp3":-1,"a/3.mp3":1.5},"batches":["x",1]}'), { plays: { 'a/1.mp3': 3 }, batches: ['x'] });
});

test('stats: reports are checked strictly', () => {
  assert.ok(validReport({ batch: 'abcdefgh', plays: { 'a/1.mp3': 2 } }));
  assert.equal(validReport({ batch: 'short', plays: { 'a/1.mp3': 2 } }), null);
  assert.equal(validReport({ batch: 'abcdefgh', plays: {} }), null);
  assert.equal(validReport({ batch: 'abcdefgh', plays: { 'a/1.mp3': 0 } }), null);
  assert.equal(validReport({ batch: 'abcdefgh', plays: { 'a/1.mp3': 1001 } }), null);
  assert.equal(validReport({ batch: 'abcdefgh', plays: { '../x': 1 } }), null);
});

test('stats: a resent batch counts once; moves and deletes carry the count', () => {
  const report = validReport({ batch: 'batch-0001', plays: { 'a/1.mp3': 2, 'a/2.mp3': 1 } });
  let stats = addReport(parseStats(''), report);
  assert.equal(addReport(stats, report), stats);
  stats = addReport(stats, validReport({ batch: 'batch-0002', plays: { 'a/1.mp3': 1 } }));
  assert.deepEqual(stats.plays, { 'a/1.mp3': 3, 'a/2.mp3': 1 });
  stats = moveCount(stats, 'a/1.mp3', 'b/1.mp3');
  assert.deepEqual(stats.plays, { 'a/2.mp3': 1, 'b/1.mp3': 3 });
  stats = moveCount(stats, 'a/2.mp3', null);
  assert.deepEqual(stats.plays, { 'b/1.mp3': 3 });
  assert.equal(moveCount(stats, 'z/9.mp3', 'y/9.mp3'), stats);
});

test('stats: a conflicting write is retried on fresh data', async () => {
  let stored = JSON.stringify({ plays: { 'a/1.mp3': 1 }, batches: [] }), etag = 'e1', collide = true;
  const bucket = {
    async get() { return { etag, text: async () => stored }; },
    async put(key, body, { onlyIf }) {
      assert.equal(key, STATS_KEY);
      if (collide) { collide = false; stored = JSON.stringify({ plays: { 'a/1.mp3': 5 }, batches: [] }); etag = 'e2'; return null; }
      assert.equal(onlyIf.etagMatches, etag);
      stored = body; return {};
    },
  };
  await updateStats(bucket, stats => addReport(stats, validReport({ batch: 'batch-0003', plays: { 'a/1.mp3': 1 } })));
  assert.equal(JSON.parse(stored).plays['a/1.mp3'], 6);
});

test('library carries play counts, and the etag moves with them', async () => {
  const obj = [{ key: 'a/1.mp3', size: 1, customMetadata: { title: 'x', duration: '1', uploadedAt: '1' } }, { key: STATS_KEY, size: 10 }];
  const [track] = buildLibrary(obj, { 'a/1.mp3': 4 });
  assert.equal(track.plays, 4);
  assert.equal(buildLibrary(obj).length, 1);
  assert.notEqual(await etagFor(buildLibrary(obj, { 'a/1.mp3': 4 })), await etagFor(buildLibrary(obj, { 'a/1.mp3': 5 })));
});
