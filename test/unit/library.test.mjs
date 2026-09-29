import test from 'node:test';
import assert from 'node:assert/strict';
import { buildLibrary, isTrackKey, isCoverKey, isLyricsKey, lyricsKeyFor, validName, etagFor, previousAfterMove, parsePrevious, PREVIOUS_BYTES } from '../../worker/library.mjs';

const obj = (key, size, customMetadata, uploaded = new Date('2026-01-01')) => ({ key, size, customMetadata, uploaded });

test('keys: one folder level, mp3 tracks and cover.jpg', () => {
  assert.ok(isTrackKey('album/song.mp3'));
  assert.ok(isTrackKey('album/Song.MP3'));
  assert.ok(!isTrackKey('song.mp3'));
  assert.ok(!isTrackKey('a/b/song.mp3'));
  assert.ok(!isTrackKey('album/cover.jpg'));
  assert.ok(isCoverKey('album/cover.jpg'));
  assert.ok(isLyricsKey('album/song.txt'));
  assert.ok(!isLyricsKey('song.txt'));
  assert.equal(lyricsKeyFor('album/song.mp3'), 'album/song.txt');
  assert.equal(lyricsKeyFor('album/Song.MP3'), 'album/Song.txt');
  assert.equal(lyricsKeyFor('album/cover.jpg'), null);
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
  assert.equal(tracks[0].lyrics, false);
  assert.equal(tracks[1].lyrics, false);
});

test('lyrics: a .txt beside the mp3 marks the track, and never becomes a track itself', () => {
  const tracks = buildLibrary([
    obj('a/one.mp3', 100, { title: 'One', duration: '61', uploadedAt: '2' }),
    obj('a/one.txt', 20),
    obj('a/Two.MP3', 100, { title: 'Two', duration: '61', uploadedAt: '1' }),
    obj('a/two.txt', 20),
    obj('a/empty.mp3', 100, { title: 'Empty', duration: '61', uploadedAt: '0' }),
    obj('a/empty.txt', 0),
    obj('a/orphan.txt', 20),
  ]);
  assert.deepEqual(tracks.map(t => [t.id, t.lyrics]), [['a/one.mp3', true], ['a/Two.MP3', true], ['a/empty.mp3', false]]);
});

test('etag changes when lyrics appear', async () => {
  const a = await etagFor(buildLibrary([obj('a/one.mp3', 1, { title: 'x', duration: '1', uploadedAt: '1' })]));
  const b = await etagFor(buildLibrary([obj('a/one.mp3', 1, { title: 'x', duration: '1', uploadedAt: '1' }), obj('a/one.txt', 5)]));
  assert.notEqual(a, b);
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

test('moves: previous keys ride along in metadata, newest first, within the size budget', () => {
  assert.deepEqual(JSON.parse(previousAfterMove('a/1.mp3', '')), ['a/1.mp3']);
  assert.deepEqual(JSON.parse(previousAfterMove('b/1.mp3', '["a/1.mp3"]')), ['b/1.mp3', 'a/1.mp3']);
  assert.deepEqual(JSON.parse(previousAfterMove('a/1.mp3', '["b/1.mp3","a/1.mp3"]')), ['a/1.mp3', 'b/1.mp3']);
  const long = Array.from({ length: 30 }, (_, i) => `folder/${'x'.repeat(60)}${i}.mp3`);
  const kept = previousAfterMove('n/new.mp3', JSON.stringify(long));
  assert.ok(new TextEncoder().encode(kept).length <= PREVIOUS_BYTES);
  assert.equal(JSON.parse(kept)[0], 'n/new.mp3');
  assert.deepEqual(JSON.parse(previousAfterMove('b/1.mp3', '["a/1.mp3"]', 'a/1.mp3')), ['b/1.mp3']);
  assert.deepEqual(parsePrevious('not json'), []);
  const [track] = buildLibrary([obj('b/1.mp3', 1, { title: 'x', duration: '1', uploadedAt: '1', previous: '["a/1.mp3","bad"]' })]);
  assert.deepEqual(track.previous, ['a/1.mp3']);
});

test('etag changes when only the title changes', async () => {
  const a = await etagFor(buildLibrary([obj('a/one.mp3', 1, { title: 'x', duration: '1', uploadedAt: '1' })]));
  const b = await etagFor(buildLibrary([obj('a/one.mp3', 1, { title: 'y', duration: '1', uploadedAt: '1' })]));
  assert.notEqual(a, b);
});
