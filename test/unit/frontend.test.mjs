import test from 'node:test';
import assert from 'node:assert/strict';
import { arrange, nextSort, mergeLibrary, saveControl, safeFileName, titleOf, time } from '../../public/library.mjs';
import * as PL from '../../public/playlists.mjs';

const t = (id, title, uploadedAt) => ({ id, title, uploadedAt, folder: 'f', duration: 10, size: 1, cover: false });

test('sort cycles and orders', () => {
  assert.equal(nextSort('new'), 'old'); assert.equal(nextSort('za'), 'new');
  const list = [t('a', 'Banana', '2'), t('b', 'apple', '3'), t('c', 'Cherry', '1')];
  assert.deepEqual(arrange(list, 'new').map(x => x.id), ['b', 'a', 'c']);
  assert.deepEqual(arrange(list, 'old').map(x => x.id), ['c', 'a', 'b']);
  assert.deepEqual(arrange(list, 'az').map(x => x.id), ['b', 'a', 'c']);
  assert.deepEqual(arrange(list, 'za').map(x => x.id), ['c', 'a', 'b']);
});

test('merge keeps saved tracks that left the cloud, drops unsaved ones', () => {
  const previous = [t('a', 'A', '1'), t('b', 'B', '1'), t('c', 'C', '1')];
  const merged = mergeLibrary([t('a', 'A', '1')], previous, new Set(['b']));
  assert.deepEqual(merged.map(x => [x.id, x.gone]), [['a', false], ['b', true]]);
});

test('save control states', () => {
  assert.equal(saveControl({ saving: true }).busy, true);
  assert.equal(saveControl({ saved: true, playing: true }).disabled, true);
  assert.equal(saveControl({ saved: true }).saved, true);
  assert.equal(saveControl({ gone: true }).disabled, true);
  assert.equal(saveControl({}).icon, 'download');
});

test('file names', () => {
  assert.equal(safeFileName('My Song.MP3'), 'My Song.mp3');
  assert.equal(safeFileName('a/b\\c.mp3'), 'abc.mp3');
  assert.equal(titleOf('track.mp3'), 'track');
  assert.equal(time(125), '2:05');
});

test('playlists: order, resolve, normalise', () => {
  const store = PL.emptyStore();
  const p1 = PL.createPlaylist(store, 'One'); const p2 = PL.createPlaylist(store, 'Two');
  assert.equal(PL.addTracks(p1, ['x/1.mp3', 'x/2.mp3', 'x/1.mp3']), 2);
  PL.moveTrack(p1, 0, 1);
  assert.deepEqual(p1.trackIds, ['x/2.mp3', 'x/1.mp3']);
  PL.reorder(store, [p2.id, p1.id]);
  assert.deepEqual(store.playlists.map(p => p.id), [p2.id, p1.id]);
  const rows = PL.resolveTracks(p1, id => (id === 'x/1.mp3' ? { id, title: 'One' } : null), new Map([['x/2.mp3', 5]]));
  assert.deepEqual(rows.map(r => [r.id, Boolean(r.gone)]), [['x/2.mp3', true], ['x/1.mp3', false]]);
  const clean = PL.normalise({ folders: [{ id: 'z' }], playlists: [{ id: 'q', name: 'Q', folder: 'missing', trackIds: ['a', 'a', 3] }] });
  assert.deepEqual(clean, { playlists: [{ id: 'q', name: 'Q', trackIds: ['a'] }] });
});
