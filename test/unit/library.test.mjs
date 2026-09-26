import test from 'node:test';
import assert from 'node:assert/strict';
import { buildLibrary, isTrackKey, isCoverKey, validName, etagFor } from '../../worker/library.mjs';

const obj = (key, size, customMetadata, uploaded = new Date('2026-01-01')) => ({ key, size, customMetadata, uploaded });

test('keys: one folder level, mp3 tracks and cover.jpg', () => {
  assert.ok(isTrackKey('album/song.mp3'));
  assert.ok(isTrackKey('album/Song.MP3'));
  assert.ok(!isTrackKey('song.mp3'));
  assert.ok(!isTrackKey('a/b/song.mp3'));
  assert.ok(!isTrackKey('album/cover.jpg'));
  assert.ok(isCoverKey('album/cover.jpg'));
});

test('library hides broken objects and marks folder covers', () => {
  const tracks = buildLibrary([
    obj('a/one.mp3', 100, { title: 'One', duration: '61.4', uploadedAt: '2026-02-01T00:00:00.000Z' }),
    obj('a/cover.jpg', 10),
    obj('a/empty.mp3', 0, { title: 'Empty', duration: '10' }),
    obj('a/nometa.mp3', 50, {}),
    obj('b/two.mp3', 200, { title: 'Two', duration: '120', uploadedAt: '2026-03-01T00:00:00.000Z' }),
    obj('b/notes.txt', 5),
  ]);
  assert.deepEqual(tracks.map(t => t.id), ['b/two.mp3', 'a/one.mp3']);
  assert.equal(tracks[1].cover, true);
  assert.equal(tracks[0].cover, false);
  assert.equal(tracks[1].duration, 61);
  assert.equal(tracks[1].folder, 'a');
});

test('etag changes with content', async () => {
  const a = await etagFor(buildLibrary([obj('a/one.mp3', 1, { title: 'x', duration: '1', uploadedAt: '1' })]));
  const b = await etagFor(buildLibrary([obj('a/one.mp3', 2, { title: 'x', duration: '1', uploadedAt: '1' })]));
  assert.notEqual(a, b);
  assert.match(a, /^"[0-9a-f]{20}"$/);
});

test('names reject path tricks', () => {
  assert.ok(validName('My Album'));
  assert.ok(validName('song.mp3', { extension: 'mp3' }));
  assert.ok(!validName('song.wav', { extension: 'mp3' }));
  assert.ok(!validName('..'));
  assert.ok(!validName('a/b'));
  assert.ok(!validName('a\b'));
  assert.ok(!validName(''));
});
