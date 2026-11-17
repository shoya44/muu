import test from 'node:test';
import assert from 'node:assert/strict';
import { handleGeneration } from '../../worker/generation.mjs';

function env(enabled = '1') {
  const objects = new Map(); let version = 0;
  let failNextConditional = false;
  const bucket = {
    async get(key) { const item = objects.get(key); if (!item) return null; return { etag: item.etag, httpEtag: `"${item.etag}"`, json: async () => JSON.parse(item.body), text: async () => item.body }; },
    async head(key) { return objects.get(key)?.info || null; },
    async put(key, body, opts = {}) {
      if (failNextConditional && opts.onlyIf) { failNextConditional = false; return null; }
      const old = objects.get(key);
      const condition = opts.onlyIf;
      if (condition?.etagMatches?.startsWith('"')) throw new TypeError('Conditional ETag should not be wrapped in quotes');
      if (condition?.etagMatches && old?.etag !== condition.etagMatches) return null;
      if (condition?.etagDoesNotMatch === '*' && old) return null;
      const data = typeof body === 'string' ? body : body;
      const meta = opts.customMetadata || {};
      const size = typeof data === 'string' ? new TextEncoder().encode(data).length : 100;
      const etag = `e${++version}`;
      objects.set(key, { body: data, etag, info: { size, customMetadata: meta } });
      return { etag };
    },
    async list() { return { objects: [...objects.entries()].map(([key, value]) => ({ key, size: value.info.size })), truncated: false }; },
  };
  return { MEDIA: bucket, ADMIN_PASSWORD: 'secret', VOICE_GENERATION_ENABLED: enabled, MAX_BUCKET_BYTES: '100000', objects, forceConflict: () => { failNextConditional = true; } };
}
const cat = { voices: [{ id: 'v1', label: 'Voice', convert_presets: [{ id: 'recommended', label: 'Recommended' }] }], mix_presets: [{ id: 'standard', label: 'Standard' }], default_voice: 'v1' };
const auth = { authorization: 'Bearer secret' };
const request = (url, method = 'GET', body, headers = {}) => new Request(`https://muu.test${url}`, { method, headers: { ...auth, ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...headers }, body: body === undefined ? undefined : (typeof body === 'string' ? body : JSON.stringify(body)) });
const call = (req, e) => handleGeneration(req, e, { waitUntil() {} }, new URL(req.url));
const json = async res => ({ status: res.status, body: await res.json() });
const id = '123e4567-e89b-42d3-a456-426614174000';
async function signedWorkerToken(payload) {
  const encoded = btoa(JSON.stringify(payload)).replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode('secret'), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const signature = new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(`muw1.${encoded}`)));
  const encodedSignature = btoa(String.fromCharCode(...signature)).replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
  return `muw1.${encoded}.${encodedSignature}`;
}

test('feature off and auth failures are closed', async () => {
  assert.equal((await call(request('/api/generation'), env('0'))).status, 404);
  assert.equal((await call(request('/api/generation/pair/start', 'POST', { worker_id: 'bridge-1' }), env('0'))).status, 404);
  assert.equal((await call(new Request('https://muu.test/api/generation'), env())).status, 401);
  assert.equal((await call(request('/api/generation', 'GET', undefined, { 'sec-fetch-site': 'cross-site' }), env())).status, 403);
});

test('catalog sync, validated idempotent enqueue, and public status', async () => {
  const e = env();
  await call(request('/api/generation/worker/poll', 'POST', { worker_id: 'bridge-1', catalog: cat }), e);
  const payload = { id, url: 'https://example.com/song', voice: 'v1', key: 'auto', preset: 'recommended', mix_preset: 'standard' };
  assert.equal((await json(await call(request('/api/generation', 'POST', payload), e))).status, 201);
  assert.equal((await json(await call(request('/api/generation', 'POST', payload), e))).status, 200);
  assert.equal((await json(await call(request('/api/generation', 'POST', { ...payload, url: 'https://example.com/other' }), e))).status, 409);
  const uppercase = { ...payload, id: id.toUpperCase() };
  assert.equal((await json(await call(request('/api/generation', 'POST', uppercase), e))).status, 200);
  assert.equal((await json(await call(request('/api/generation', 'POST', { ...payload, id: id.replaceAll('-', '') }), e))).status, 400);
  e.forceConflict();
  const second = { ...payload, id: '123e4567-e89b-42d3-a456-426614174001' };
  assert.equal((await json(await call(request('/api/generation', 'POST', second), e))).status, 201);
  assert.equal((await json(await call(request('/api/generation', 'GET'), e))).body.jobs[0].status, 'queued');
});

test('claim, lease ownership, upload and done verification', async () => {
  const e = env();
  await call(request('/api/generation/worker/poll', 'POST', { worker_id: 'bridge-1', catalog: cat }), e);
  const payload = { id, url: 'https://example.com/song', voice: 'v1', key: -2, preset: 'recommended', mix_preset: 'standard' };
  await call(request('/api/generation', 'POST', payload), e);
  const claimed = await json(await call(request('/api/generation/worker/poll', 'POST', { worker_id: 'bridge-1' }), e));
  assert.equal(claimed.body.job.status, 'running');
  assert.equal(claimed.body.job.owner, 'bridge-1');
  assert.equal((await json(await call(request(`/api/generation/worker/${id}`, 'POST', { worker_id: 'other', status: 'failed' }), e))).status, 409);
  const up = await call(request(`/api/generation/worker/${id}/audio`, 'PUT', 'audio-bytes', { 'content-type': 'audio/mpeg', 'content-length': '11', 'x-worker-id': 'bridge-1', 'x-duration': '18', 'x-title': 'Test%20song' }), e);
  assert.equal(up.status, 201);
  assert.equal((await call(request(`/api/generation/worker/${id}/audio`, 'PUT', 'audio-bytes', { 'content-type': 'audio/mpeg', 'content-length': '11', 'x-worker-id': 'bridge-1', 'x-duration': '18', 'x-title': 'Test%20song' }), e)).status, 200);
  const done = await json(await call(request(`/api/generation/worker/${id}`, 'POST', { worker_id: 'bridge-1', status: 'done', track_id: `v1/generation-${id}.mp3` }), e));
  assert.equal(done.body.status, 'done');
  assert.equal((await call(request(`/api/generation/worker/${id.toUpperCase()}`, 'POST', { worker_id: 'bridge-1', status: 'done', track_id: `v1/generation-${id}.mp3` }), e)).status, 200);
  assert.equal((await json(await call(request(`/api/generation/worker/${id}`, 'POST', { worker_id: 'bridge-1', status: 'running' }), e))).status, 409);
  const failedId = '123e4567-e89b-42d3-a456-426614174002';
  await call(request('/api/generation', 'POST', { ...payload, id: failedId }), e);
  await call(request('/api/generation/worker/poll', 'POST', { worker_id: 'bridge-1' }), e);
  assert.equal((await call(request(`/api/generation/worker/${failedId}`, 'POST', { worker_id: 'bridge-1', status: 'failed', error: 'source unavailable' }), e)).status, 200);
  assert.equal((await call(request(`/api/generation/worker/${failedId}`, 'POST', { worker_id: 'bridge-1', status: 'running' }), e)).status, 409);
});

test('invalid body and missing catalogue fail predictably', async () => {
  const e = env();
  assert.equal((await call(request('/api/generation', 'POST', '{'), e)).status, 400);
  assert.deepEqual((await json(await call(request('/api/generation', 'GET'), e))).body.catalog, { voices: [], mix_presets: [], default_voice: '' });
});

test('corrupt state fails closed and preserves the original R2 bytes', async () => {
  const e = env();
  e.objects.set('_generation/state.json', { body: '{bad json', etag: 'broken', info: { size: 9, customMetadata: {} } });
  assert.equal((await call(request('/api/generation', 'POST', { id, url: 'https://example.com/song', voice: 'v1', key: 'auto', preset: 'recommended', mix_preset: 'standard' }), e)).status, 503);
  assert.equal(e.objects.get('_generation/state.json').body, '{bad json');
});

test('expired leases can be reclaimed, and the previous worker cannot update or upload', async () => {
  const e = env();
  await call(request('/api/generation/worker/poll', 'POST', { worker_id: 'worker-a', catalog: cat }), e);
  await call(request('/api/generation', 'POST', { id, url: 'https://example.com/song', voice: 'v1', key: 'auto', preset: 'recommended', mix_preset: 'standard' }), e);
  await call(request('/api/generation/worker/poll', 'POST', { worker_id: 'worker-a' }), e);
  const stored = e.objects.get('_generation/state.json');
  const state = JSON.parse(stored.body);
  state.jobs[0].lease_until = '2000-01-01T00:00:00.000Z';
  e.objects.set('_generation/state.json', { ...stored, body: JSON.stringify(state) });
  const reclaimed = await json(await call(request('/api/generation/worker/poll', 'POST', { worker_id: 'worker-b' }), e));
  assert.equal(reclaimed.body.job.owner, 'worker-b');
  assert.equal((await call(request(`/api/generation/worker/${id}`, 'POST', { worker_id: 'worker-a', status: 'failed' }), e)).status, 409);
  assert.equal((await call(request(`/api/generation/worker/${id}/audio`, 'PUT', 'audio-bytes', { 'content-type': 'audio/mpeg', 'content-length': '11', 'x-worker-id': 'worker-a', 'x-duration': '18', 'x-title': 'Test' }), e)).status, 409);
});

test('upload validates size, media type, quota and storage errors', async () => {
  const e = env();
  await call(request('/api/generation/worker/poll', 'POST', { worker_id: 'worker-a', catalog: cat }), e);
  await call(request('/api/generation', 'POST', { id, url: 'https://example.com/song', voice: 'v1', key: 'auto', preset: 'recommended', mix_preset: 'standard' }), e);
  await call(request('/api/generation/worker/poll', 'POST', { worker_id: 'worker-a' }), e);
  const headers = { 'content-type': 'audio/mpeg', 'x-worker-id': 'worker-a', 'x-duration': '18', 'x-title': 'Test' };
  assert.equal((await call(request(`/api/generation/worker/${id}/audio`, 'PUT', 'audio', { ...headers, 'content-length': '-1' }), e)).status, 413);
  assert.equal((await call(request(`/api/generation/worker/${id}/audio`, 'PUT', 'audio', { ...headers, 'content-length': 'NaN' }), e)).status, 413);
  assert.equal((await call(request(`/api/generation/worker/${id}/audio`, 'PUT', 'audio', { ...headers, 'content-length': '4', 'content-type': 'text/plain' }), e)).status, 400);
  e.MAX_BUCKET_BYTES = '1';
  assert.equal((await call(request(`/api/generation/worker/${id}/audio`, 'PUT', 'audio', { ...headers, 'content-length': '4' }), e)).status, 507);
  e.MAX_BUCKET_BYTES = '100000';
  const originalStatePut = e.MEDIA.put;
  e.MEDIA.put = async (key, ...args) => { if (key === '_generation/state.json') throw new Error('R2 down'); return originalStatePut(key, ...args); };
  assert.equal((await call(request('/api/generation/worker/poll', 'POST', { worker_id: 'worker-z' }), e)).status, 503);
  e.MEDIA.put = originalStatePut;
  const originalPut = e.MEDIA.put;
  e.MEDIA.put = async (...args) => { if (args[0] !== '_generation/state.json') throw new Error('R2 down'); return originalPut(...args); };
  assert.equal((await call(request(`/api/generation/worker/${id}/audio`, 'PUT', 'audio', { ...headers, 'content-length': '4' }), e)).status, 503);
});

test('PC pairing authorizes only its worker using a replayable signed token', async () => {
  const e = env();
  const started = (await json(await call(request('/api/generation/pair/start', 'POST', { worker_id: 'bridge-1' }), e))).body;
  assert.match(started.code, /^\d{6}$/);
  assert.match(started.claim_secret, /^[a-f0-9]{32}$/);
  const persisted = JSON.stringify(JSON.parse(e.objects.get('_generation/state.json').body));
  assert.equal(persisted.includes(started.code), false);
  assert.equal(persisted.includes(started.claim_secret), false);
  assert.equal((await call(request('/api/generation/pair/approve', 'POST', { code: '000000' }), e)).status, 404);
  const pending = await json(await call(request('/api/generation/pair/poll', 'POST', { id: started.id, worker_id: 'bridge-1', claim_secret: started.claim_secret }), e));
  assert.equal(pending.body.status, 'pending');
  assert.equal((await call(request('/api/generation/pair/approve', 'POST', { code: started.code }), e)).status, 200);
  const approved1 = await json(await call(request('/api/generation/pair/poll', 'POST', { id: started.id, worker_id: 'bridge-1', claim_secret: started.claim_secret }), e));
  const approved2 = await json(await call(request('/api/generation/pair/poll', 'POST', { id: started.id, worker_id: 'bridge-1', claim_secret: started.claim_secret }), e));
  assert.match(approved1.body.token, /^muw1\./);
  assert.equal(approved2.body.token, approved1.body.token);

  const tokenHeaders = { authorization: `Bearer ${approved1.body.token}` };
  assert.equal((await call(request('/api/generation', 'GET', undefined, tokenHeaders), e)).status, 401);
  assert.equal((await call(request('/api/generation', 'POST', { id, url: 'https://example.com/song', voice: 'v1', key: 'auto', preset: 'recommended', mix_preset: 'standard' }, tokenHeaders), e)).status, 401);
  assert.equal((await call(request('/api/generation/pair/approve', 'POST', { code: started.code }, tokenHeaders), e)).status, 401);
  assert.equal((await call(request('/api/generation/worker/poll', 'POST', { worker_id: 'other', catalog: cat }, tokenHeaders), e)).status, 403);
  const workerPoll = await json(await call(request('/api/generation/worker/poll', 'POST', { worker_id: 'bridge-1', catalog: cat }, tokenHeaders), e));
  assert.equal(workerPoll.body.lease_seconds, 120);
  await call(request('/api/generation', 'POST', { id, url: 'https://example.com/song', voice: 'v1', key: 'auto', preset: 'recommended', mix_preset: 'standard' }, auth), e);
  const claimed = await json(await call(request('/api/generation/worker/poll', 'POST', { worker_id: 'bridge-1' }, tokenHeaders), e));
  assert.equal(claimed.body.job.id, id);
  assert.equal((await call(request(`/api/generation/worker/${id}`, 'POST', { worker_id: 'bridge-1', status: 'uploading' }, tokenHeaders), e)).status, 200);
  assert.equal((await call(request(`/api/generation/worker/${id}/audio`, 'PUT', 'mp3', { ...tokenHeaders, 'content-type': 'audio/mpeg', 'content-length': '3', 'x-worker-id': 'bridge-1', 'x-duration': '5', 'x-title': 'Track' }), e)).status, 201);
  assert.equal((await call(request('/api/generation/worker/poll', 'POST', { worker_id: 'bridge-1' }, { authorization: `Bearer ${approved1.body.token.slice(0, -1)}x` }), e)).status, 401);
  const expiredToken = await signedWorkerToken({ role: 'generation-worker', worker_id: 'bridge-1', iat: Math.floor(Date.now() / 1000) - 10, exp: Math.floor(Date.now() / 1000) - 1 });
  assert.equal((await call(request('/api/generation/worker/poll', 'POST', { worker_id: 'bridge-1' }, { authorization: `Bearer ${expiredToken}` }), e)).status, 401);
  assert.equal((await call(request('/api/generation/worker/poll', 'POST', { worker_id: 'bridge-1' }, auth), e)).status, 200);
});

test('pair claim secrets, pair expiry, and pending limits are enforced', async () => {
  const e = env();
  const started = (await json(await call(request('/api/generation/pair/start', 'POST', { worker_id: 'bridge-1' }), e))).body;
  assert.equal((await call(request('/api/generation/pair/poll', 'POST', { id: started.id, worker_id: 'bridge-1', claim_secret: '0'.repeat(32) }), e)).status, 401);
  const stored = e.objects.get('_generation/state.json');
  const state = JSON.parse(stored.body);
  state.pairings[0].expires_at = '2000-01-01T00:00:00.000Z';
  e.objects.set('_generation/state.json', { ...stored, body: JSON.stringify(state) });
  const expired = await json(await call(request('/api/generation/pair/poll', 'POST', { id: started.id, worker_id: 'bridge-1', claim_secret: started.claim_secret }), e));
  assert.equal(expired.body.status, 'expired');
  assert.equal((await call(request('/api/generation/pair/approve', 'POST', { code: started.code }), e)).status, 404);
});

test('pair start rate and pending limits are bounded', async () => {
  const e = env();
  const codes = new Set();
  for (let index = 0; index < 5; index++) {
    const result = await json(await call(request('/api/generation/pair/start', 'POST', { worker_id: `bridge-${index}` }), e));
    assert.equal(result.status, 201);
    codes.add(result.body.code);
  }
  assert.equal(codes.size, 5);
  assert.equal((await call(request('/api/generation/pair/start', 'POST', { worker_id: 'bridge-rate' }), e)).status, 429);
  const stored = e.objects.get('_generation/state.json');
  const state = JSON.parse(stored.body);
  state.pair_rate = [];
  e.objects.set('_generation/state.json', { ...stored, body: JSON.stringify(state) });
  assert.equal((await call(request('/api/generation/pair/start', 'POST', { worker_id: 'bridge-pending' }), e)).status, 429);
});

test('pair start regenerates a code that collides with an active approval code', async () => {
  const e = env();
  const first = (await json(await call(request('/api/generation/pair/start', 'POST', { worker_id: 'bridge-first' }), e))).body;
  const originalRandom = crypto.getRandomValues.bind(crypto);
  const values = [Number(first.code), (Number(first.code) + 1) % 1_000_000];
  let at = 0;
  crypto.getRandomValues = array => {
    if (array instanceof Uint32Array) { array[0] = values[Math.min(at++, values.length - 1)]; return array; }
    return originalRandom(array);
  };
  try {
    const second = (await json(await call(request('/api/generation/pair/start', 'POST', { worker_id: 'bridge-second' }), e))).body;
    assert.notEqual(second.code, first.code);
    assert.equal(second.code, String(values[1]).padStart(6, '0'));
  } finally { crypto.getRandomValues = originalRandom; }
});

test('pairing is unavailable without the existing admin secret', async () => {
  const e = env(); e.ADMIN_PASSWORD = '';
  assert.equal((await call(request('/api/generation/pair/start', 'POST', { worker_id: 'bridge-1' }), e)).status, 503);
});
