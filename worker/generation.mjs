import { authorize, sameOrigin, constantTimeEqual } from './auth.mjs';
import { validName } from './library.mjs';

const STATE_KEY = '_generation/state.json';
const LEASE_SECONDS = 120;
const MAX_BODY = 16 * 1024;
const MAX_AUDIO = 95 * 1024 * 1024;
const response = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' } });
const fail = (status, error) => response({ error }, status);
const now = () => new Date().toISOString();
const clone = value => JSON.parse(JSON.stringify(value));
const publicJob = job => Object.fromEntries(Object.entries(job).filter(([key]) => !['owner', 'lease_until', 'payload'].includes(key)));
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PAIR_TTL_MS = 10 * 60 * 1000;
const TOKEN_TTL_MS = 30 * 24 * 60 * 60 * 1000;
class GenerationStateError extends Error {}

function bytesToHex(bytes) { return [...bytes].map(value => value.toString(16).padStart(2, '0')).join(''); }
function hexToBytes(hex) { return Uint8Array.from(hex.match(/.{2}/g) || [], byte => Number.parseInt(byte, 16)); }
function base64url(bytes) { return btoa(String.fromCharCode(...bytes)).replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_'); }
function base64urlText(text) { return base64url(new TextEncoder().encode(text)); }
async function digestHex(text) { return bytesToHex(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)))); }
async function signToken(env, payload) {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(env.ADMIN_PASSWORD), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const encoded = base64urlText(JSON.stringify(payload));
  const signature = new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(`muw1.${encoded}`)));
  return `muw1.${encoded}.${base64url(signature)}`;
}
async function verifyToken(env, token) {
  const parts = token.split('.');
  if (parts.length !== 3 || parts[0] !== 'muw1') return null;
  let payload;
  try {
    const encoded = parts[1].replace(/-/g, '+').replace(/_/g, '/');
    payload = JSON.parse(atob(encoded + '='.repeat((4 - encoded.length % 4) % 4)));
  } catch { return null; }
  const expected = await signToken(env, payload);
  const expectedSignature = expected.slice(expected.lastIndexOf('.') + 1);
  if (!constantTimeEqual(parts[2], expectedSignature)) return null;
  const timestamp = Math.floor(Date.now() / 1000);
  if (payload?.role !== 'generation-worker' || typeof payload.worker_id !== 'string' || !Number.isInteger(payload.exp) || payload.exp <= timestamp || !Number.isInteger(payload.iat) || payload.iat > timestamp + 60) return null;
  return payload;
}
async function authorizeWorker(request, env) {
  const admin = authorize(request, env.ADMIN_PASSWORD);
  if (admin.ok) return { ok: true, admin: true, worker_id: null };
  const authorization = request.headers.get('authorization') || '';
  const match = /^Bearer\s+(muw1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)$/i.exec(authorization);
  if (!match) return { ok: false, status: admin.status, error: admin.error };
  const token = await verifyToken(env, match[1]);
  return token ? { ok: true, admin: false, worker_id: token.worker_id } : { ok: false, status: 401, error: 'unauthorized' };
}

async function startPair(request, env) {
  if (!env.ADMIN_PASSWORD) return fail(503, 'password_not_configured');
  const parsed = await parseBody(request); if (parsed.error) return parsed.error;
  const workerId = parsed.body?.worker_id;
  if (typeof workerId !== 'string' || !/^[a-zA-Z0-9._:-]{1,100}$/.test(workerId)) return fail(400, 'invalid_body');
  const id = crypto.randomUUID();
  const secretBytes = crypto.getRandomValues(new Uint8Array(16));
  const claimSecret = bytesToHex(secretBytes);
  const claimHash = await digestHex(claimSecret);
  const expiresAt = new Date(Date.now() + PAIR_TTL_MS).toISOString();
  const result = await mutate(env, async state => {
    const timestamp = Date.now();
    state.pairings = state.pairings.filter(pair => Date.parse(pair.expires_at) > timestamp - 60 * 60 * 1000);
    state.pair_rate = state.pair_rate.filter(value => timestamp - value < 60_000);
    if (state.pair_rate.length >= 5) return { noWrite: true, value: { error: 'rate_limited', status: 429 } };
    if (state.pairings.filter(pair => pair.status === 'pending' && Date.parse(pair.expires_at) > timestamp).length >= 5) return { noWrite: true, value: { error: 'too_many_pending', status: 429 } };
    let code, codeHash;
    for (let attempt = 0; attempt < 20; attempt++) {
      const codeBytes = new Uint32Array(1); crypto.getRandomValues(codeBytes);
      code = String(codeBytes[0] % 1_000_000).padStart(6, '0');
      codeHash = await digestHex(code);
      if (!state.pairings.some(pair => pair.status === 'pending' && Date.parse(pair.expires_at) > timestamp && constantTimeEqual(pair.code_hash, codeHash))) break;
      code = null;
    }
    if (!code) return { noWrite: true, value: { error: 'pair_code_unavailable', status: 503 } };
    state.pair_rate.push(timestamp);
    state.pairings.push({ id, worker_id: workerId, code_hash: codeHash, claim_hash: claimHash, status: 'pending', created: now(), expires_at: expiresAt, token: null, token_expires_at: null });
    return { value: { id, code, claim_secret: claimSecret, expires_at: expiresAt } };
  });
  return result.error ? fail(result.status, result.error) : response(result, 201);
}
async function pollPair(request, env) {
  const parsed = await parseBody(request); if (parsed.error) return parsed.error;
  const { id, worker_id: workerId, claim_secret: claimSecret } = parsed.body || {};
  if (!uuidPattern.test(id || '') || typeof workerId !== 'string' || typeof claimSecret !== 'string' || !/^[0-9a-f]{32}$/i.test(claimSecret)) return fail(401, 'unauthorized');
  const { state } = await readState(env);
  const pair = (state.pairings || []).find(item => item.id === id.toLowerCase());
  if (!pair || pair.worker_id !== workerId || !constantTimeEqual(pair.claim_hash, await digestHex(claimSecret))) return fail(401, 'unauthorized');
  if (Date.parse(pair.expires_at) <= Date.now()) return response({ status: 'expired', expires_at: pair.expires_at });
  return pair.status === 'approved'
    ? response({ status: 'approved', token: pair.token, expires_at: pair.expires_at })
    : response({ status: 'pending', expires_at: pair.expires_at });
}
async function approvePair(request, env) {
  const parsed = await parseBody(request); if (parsed.error) return parsed.error;
  const code = parsed.body?.code;
  if (typeof code !== 'string' || !/^\d{6}$/.test(code)) return fail(404, 'pair_not_found');
  const codeHash = await digestHex(code);
  const result = await mutate(env, async state => {
    const pair = state.pairings.find(item => item.status === 'pending' && Date.parse(item.expires_at) > Date.now() && constantTimeEqual(item.code_hash, codeHash));
    if (!pair) return { noWrite: true, value: { error: 'pair_not_found', status: 404 } };
    const issued = Math.floor(Date.now() / 1000);
    pair.token_expires_at = new Date((issued + TOKEN_TTL_MS / 1000) * 1000).toISOString();
    pair.token = await signToken(env, { role: 'generation-worker', worker_id: pair.worker_id, iat: issued, exp: issued + TOKEN_TTL_MS / 1000 });
    pair.status = 'approved';
    pair.approved_at = now();
    return { value: { ok: true, worker_id: pair.worker_id } };
  });
  return result.error ? fail(result.status, result.error) : response(result);
}

export async function handleGeneration(request, env, ctx, url, { forgetLibrary = () => {} } = {}) {
  if (env.VOICE_GENERATION_ENABLED !== '1') return fail(404, 'not_found');
  if (!sameOrigin(request)) return fail(403, 'cross_site');
  const path = url.pathname.split('/').filter(Boolean).slice(2);
  try {
    if (url.pathname === '/api/generation/pair/start' && request.method === 'POST') return await startPair(request, env);
    if (url.pathname === '/api/generation/pair/poll' && request.method === 'POST') return await pollPair(request, env);
    if (url.pathname === '/api/generation/pair/approve' && request.method === 'POST') {
      const admin = authorize(request, env.ADMIN_PASSWORD);
      if (!admin.ok) return fail(admin.status, admin.error);
      return await approvePair(request, env);
    }
    const workerPoll = url.pathname === '/api/generation/worker/poll' && request.method === 'POST';
    const audioMatch = /^\/api\/generation\/worker\/([0-9a-f-]{36})\/audio$/.exec(url.pathname);
    const workerUpdate = path[0] === 'worker' && path.length === 2 && path[1] !== 'poll' && request.method === 'POST';
    let workerAuth = null;
    if (workerPoll || audioMatch && request.method === 'PUT' || workerUpdate) {
      workerAuth = await authorizeWorker(request, env);
      if (!workerAuth.ok) return fail(workerAuth.status, workerAuth.error);
    } else {
      const auth = authorize(request, env.ADMIN_PASSWORD);
      if (!auth.ok) return fail(auth.status, auth.error);
    }
    if (url.pathname === '/api/generation' && request.method === 'GET') return await getQueue(env);
    if (url.pathname === '/api/generation' && request.method === 'POST') return await enqueue(request, env);
    if (workerPoll) return await poll(request, env, workerAuth.worker_id);
    if (audioMatch && request.method === 'PUT') return await uploadAudio(request, env, audioMatch[1].toLowerCase(), ctx, url, forgetLibrary, workerAuth.worker_id);
    if (workerUpdate) return await updateJob(request, env, path[1].toLowerCase(), workerAuth.worker_id);
    return fail(404, 'not_found');
  } catch (error) {
    console.error(error);
    return fail(503, error instanceof GenerationStateError ? 'state_unavailable' : 'storage_unavailable');
  }
}

async function readState(env) {
  const object = await env.MEDIA.get(STATE_KEY);
  if (!object) return { state: { catalog: null, worker: null, jobs: [] }, etag: null };
  let state;
  try { state = typeof object.json === 'function' ? await object.json() : JSON.parse(await object.text()); }
  catch { throw new GenerationStateError('invalid_generation_state'); }
  if (!state || typeof state !== 'object' || !Array.isArray(state.jobs) || !('catalog' in state) || !('worker' in state)) throw new GenerationStateError('invalid_generation_state');
  if (state.pairings !== undefined && !Array.isArray(state.pairings)) throw new GenerationStateError('invalid_generation_state');
  return { state, etag: object.etag };
}
async function mutate(env, fn) {
  for (let attempt = 0; attempt < 8; attempt++) {
    const { state, etag } = await readState(env);
    const next = clone(state);
    next.pairings ||= [];
    next.pair_rate ||= [];
    const result = await fn(next);
    if (result?.noWrite) return result.value;
    try {
      const options = { httpMetadata: { contentType: 'application/json' } };
      options.onlyIf = etag ? { etagMatches: etag } : { etagDoesNotMatch: '*' };
      const saved = await env.MEDIA.put(STATE_KEY, JSON.stringify(next), options);
      if (saved) return result?.value;
      // R2 reports a failed conditional put as null; only that is retryable.
    } catch (error) { throw error; }
  }
  throw new Error('generation_state_conflict');
}
async function parseBody(request, max = MAX_BODY) {
  const length = Number(request.headers.get('content-length'));
  if (length > max) return { error: fail(413, 'too_large') };
  let text;
  try { text = await request.text(); } catch { return { error: fail(400, 'invalid_body') }; }
  if (new TextEncoder().encode(text).length > max) return { error: fail(413, 'too_large') };
  try { return { body: JSON.parse(text) }; } catch { return { error: fail(400, 'invalid_body') }; }
}
function validCatalog(catalog) {
  if (!catalog || !Array.isArray(catalog.voices) || !Array.isArray(catalog.mix_presets) || typeof catalog.default_voice !== 'string') return false;
  if (!catalog.voices.length || !catalog.mix_presets.length) return false;
  return catalog.voices.every(v => typeof v.id === 'string' && v.id && Array.isArray(v.convert_presets) && v.convert_presets.every(p => typeof p.id === 'string'));
}
function catalogKey(value) { return value === 'auto' || (Number.isInteger(value) && value >= -12 && value <= 12); }
function safeText(value, max = 300) { return typeof value === 'string' ? value.replace(/[\u0000-\u001f\u007f]/g, '').slice(0, max) : ''; }

async function getQueue(env) {
  const { state } = await readState(env);
  const catalog = validCatalog(state.catalog) ? state.catalog : { voices: [], mix_presets: [], default_voice: '' };
  const worker = state.worker;
  return response({ enabled: true, catalog, worker: { last_seen: worker?.last_seen || null, online: Boolean(worker && Date.now() - Date.parse(worker.last_seen) < 180_000) }, jobs: state.jobs.slice().sort((a, b) => b.created.localeCompare(a.created)).slice(0, 50).map(publicJob) });
}
async function enqueue(request, env) {
  const parsed = await parseBody(request); if (parsed.error) return parsed.error;
  const b = parsed.body;
  if (!b || !uuidPattern.test(b.id || '') || typeof b.url !== 'string' || b.url.length > 2048 || !['http:', 'https:'].includes((() => { try { return new URL(b.url).protocol; } catch { return ''; } })()) || new URL(b.url).username || new URL(b.url).password || !catalogKey(b.key)) return fail(400, 'invalid_body');
  const id = b.id.toLowerCase();
  const out = await mutate(env, state => {
    if (!validCatalog(state.catalog)) return { noWrite: true, value: { error: 'catalog_unavailable', status: 503 } };
    const voice = state.catalog.voices.find(v => v.id === b.voice);
    const preset = voice?.convert_presets.find(p => p.id === b.preset);
    const mix = state.catalog.mix_presets.find(p => p.id === b.mix_preset);
    if (!voice || !preset || !mix) return { noWrite: true, value: { error: 'invalid_body', status: 400 } };
    const folder = safeText(b.folder || b.voice, 200);
    if (!validName(folder)) return { noWrite: true, value: { error: 'invalid_body', status: 400 } };
    const payload = { url: b.url, voice: b.voice, key: b.key, preset: b.preset, mix_preset: b.mix_preset, folder };
    const old = state.jobs.find(j => j.id === id);
    if (old) return { noWrite: true, value: old.payload && JSON.stringify(old.payload) === JSON.stringify(payload) ? { job: publicJob(old), status: 200 } : { error: 'id_conflict', status: 409 } };
    const stamp = now();
    const job = { id, ...payload, status: 'queued', stage: 'queued', error: '', track_id: null, created: stamp, updated: stamp, owner: null, lease_until: null, payload };
    state.jobs.push(job); return { value: { job: publicJob(job), status: 201 } };
  });
  return out.error ? fail(out.status, out.error) : response(out.job, out.status);
}
async function poll(request, env, tokenWorkerId = null) {
  const parsed = await parseBody(request); if (parsed.error) return parsed.error;
  const { worker_id, catalog } = parsed.body || {};
  if (typeof worker_id !== 'string' || !/^[a-zA-Z0-9._:-]{1,100}$/.test(worker_id) || (catalog !== undefined && !validCatalog(catalog))) return fail(400, 'invalid_body');
  if (tokenWorkerId && worker_id !== tokenWorkerId) return fail(403, 'worker_mismatch');
  const result = await mutate(env, state => {
    if (catalog) state.catalog = catalog;
    state.worker = { id: worker_id, last_seen: now() };
    let job = state.jobs.find(j => j.owner === worker_id && ['running', 'uploading'].includes(j.status));
    if (job) job.lease_until = new Date(Date.now() + LEASE_SECONDS * 1000).toISOString();
    else {
      const stamp = now();
      job = state.jobs.filter(j => j.status === 'queued' || (['running', 'uploading'].includes(j.status) && Date.parse(j.lease_until) < Date.now())).sort((a, b) => a.created.localeCompare(b.created))[0];
      if (job) { job.owner = worker_id; job.status = 'running'; job.stage = 'running'; job.updated = stamp; job.lease_until = new Date(Date.now() + LEASE_SECONDS * 1000).toISOString(); }
    }
    return { value: { job: job ? clone(job) : null, lease_seconds: LEASE_SECONDS } };
  });
  return response(result);
}
async function updateJob(request, env, id, tokenWorkerId = null) {
  const parsed = await parseBody(request); if (parsed.error) return parsed.error;
  const b = parsed.body || {};
  if (!uuidPattern.test(id) || typeof b.worker_id !== 'string' || !['running', 'uploading', 'done', 'failed'].includes(b.status)) return fail(400, 'invalid_body');
  if (tokenWorkerId && b.worker_id !== tokenWorkerId) return fail(403, 'worker_mismatch');
  const result = await mutate(env, async state => {
    const job = state.jobs.find(j => j.id === id);
    if (!job) return { noWrite: true, value: { error: 'not_found', status: 404 } };
    if ((job.owner !== b.worker_id || Date.parse(job.lease_until) < Date.now()) && !(b.status === 'done' && job.owner === b.worker_id && job.status === 'done' && job.track_id === b.track_id)) return { noWrite: true, value: { error: 'lease_lost', status: 409 } };
    if (['done', 'failed'].includes(job.status)) return { noWrite: true, value: b.status === job.status ? { job: clone(job), status: 200 } : { error: 'terminal', status: 409 } };
    if (b.status === 'done') {
      const expected = `${job.folder}/generation-${job.id}.mp3`;
      const audio = await env.MEDIA.head(expected);
      if (b.track_id !== expected || audio?.customMetadata?.generationRequest !== job.id) return { noWrite: true, value: { error: 'audio_missing', status: 409 } };
    }
    job.status = b.status; job.stage = safeText(b.stage || b.status, 120); job.error = b.status === 'failed' ? safeText(b.error, 300) : ''; job.updated = now();
    job.lease_until = new Date(Date.now() + LEASE_SECONDS * 1000).toISOString();
    if (b.status === 'done') job.track_id = b.track_id;
    if (b.lab_project) job.lab_project = safeText(b.lab_project, 200);
    if (b.lab_job) job.lab_job = safeText(b.lab_job, 200);
    return { value: { job: clone(job), status: 200 } };
  });
  return result.error ? fail(result.status, result.error) : response(result.job, result.status);
}
async function uploadAudio(request, env, id, ctx, url, forgetLibrary, tokenWorkerId = null) {
  const workerId = request.headers.get('x-worker-id') || '';
  if (!uuidPattern.test(id) || !workerId || request.headers.get('content-type')?.split(';')[0] !== 'audio/mpeg') return fail(400, 'invalid_body');
  if (tokenWorkerId && workerId !== tokenWorkerId) return fail(403, 'worker_mismatch');
  const size = Number(request.headers.get('content-length'));
  if (!Number.isSafeInteger(size) || size <= 0 || size > MAX_AUDIO) return fail(413, 'too_large');
  let title;
  try { title = decodeURIComponent(request.headers.get('x-title') || '').trim(); } catch { return fail(400, 'invalid_title'); }
  const duration = Number(request.headers.get('x-duration'));
  if (!title || title.length > 200 || !Number.isFinite(duration) || duration <= 0) return fail(400, 'invalid_metadata');
  const state = await readState(env);
  const job = state.state.jobs.find(j => j.id === id);
  if (!job || job.owner !== workerId || !['running', 'uploading'].includes(job.status) || Date.parse(job.lease_until) < Date.now()) return fail(409, 'lease_lost');
  const key = `${job.folder}/generation-${id}.mp3`;
  const existing = await env.MEDIA.head(key);
  if (existing) {
    const meta = existing.customMetadata || {};
    return meta.generationRequest === id && meta.title === title && meta.duration === String(Math.round(duration)) ? response({ id: key, idempotent: true }) : fail(409, 'exists');
  }
  const limit = Number(env.MAX_BUCKET_BYTES);
  if (limit) {
    let used = 0, cursor;
    do { const page = await env.MEDIA.list({ cursor }); used += page.objects.reduce((sum, object) => sum + object.size, 0); cursor = page.truncated ? page.cursor : undefined; } while (cursor);
    if (used + size > limit) return fail(507, 'storage_full');
  }
  const uploadedAt = now();
  const saved = await env.MEDIA.put(key, request.body, { onlyIf: { etagDoesNotMatch: '*' }, httpMetadata: { contentType: 'audio/mpeg' }, customMetadata: { title, duration: String(Math.round(duration)), uploadedAt, generationRequest: id } });
  if (!saved) {
    const raced = await env.MEDIA.head(key);
    const meta = raced?.customMetadata || {};
    return meta.generationRequest === id && meta.title === title && meta.duration === String(Math.round(duration)) ? response({ id: key, idempotent: true }) : fail(409, 'exists');
  }
  forgetLibrary(ctx, url);
  return response({ id: key, title, duration: Math.round(duration), size, uploadedAt }, 201);
}
