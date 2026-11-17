import { authorize, sameOrigin } from './auth.mjs';
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
class GenerationStateError extends Error {}

export async function handleGeneration(request, env, ctx, url, { forgetLibrary = () => {} } = {}) {
  if (env.VOICE_GENERATION_ENABLED !== '1') return fail(404, 'not_found');
  const auth = authorize(request, env.ADMIN_PASSWORD);
  if (!auth.ok) return fail(auth.status, auth.error);
  if (!sameOrigin(request)) return fail(403, 'cross_site');
  const path = url.pathname.split('/').filter(Boolean).slice(2);
  try {
    if (url.pathname === '/api/generation' && request.method === 'GET') return await getQueue(env);
    if (url.pathname === '/api/generation' && request.method === 'POST') return await enqueue(request, env);
    if (url.pathname === '/api/generation/worker/poll' && request.method === 'POST') return await poll(request, env);
    const audioMatch = /^\/api\/generation\/worker\/([0-9a-f-]{36})\/audio$/.exec(url.pathname);
    if (audioMatch && request.method === 'PUT') return await uploadAudio(request, env, audioMatch[1].toLowerCase(), ctx, url, forgetLibrary);
    if (path[0] === 'worker' && path.length === 2 && path[1] !== 'poll' && request.method === 'POST') return await updateJob(request, env, path[1].toLowerCase());
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
  return { state, etag: object.etag };
}
async function mutate(env, fn) {
  for (let attempt = 0; attempt < 8; attempt++) {
    const { state, etag } = await readState(env);
    const next = clone(state);
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
  if (!validCatalog(state.catalog)) return fail(503, 'catalog_unavailable');
  const worker = state.worker;
  return response({ enabled: true, catalog: state.catalog, worker: { last_seen: worker?.last_seen || null, online: Boolean(worker && Date.now() - Date.parse(worker.last_seen) < 180_000) }, jobs: state.jobs.slice().sort((a, b) => b.created.localeCompare(a.created)).slice(0, 50).map(publicJob) });
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
async function poll(request, env) {
  const parsed = await parseBody(request); if (parsed.error) return parsed.error;
  const { worker_id, catalog } = parsed.body || {};
  if (typeof worker_id !== 'string' || !/^[a-zA-Z0-9._:-]{1,100}$/.test(worker_id) || (catalog !== undefined && !validCatalog(catalog))) return fail(400, 'invalid_body');
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
async function updateJob(request, env, id) {
  const parsed = await parseBody(request); if (parsed.error) return parsed.error;
  const b = parsed.body || {};
  if (!uuidPattern.test(id) || typeof b.worker_id !== 'string' || !['running', 'uploading', 'done', 'failed'].includes(b.status)) return fail(400, 'invalid_body');
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
async function uploadAudio(request, env, id, ctx, url, forgetLibrary) {
  const workerId = request.headers.get('x-worker-id') || '';
  if (!uuidPattern.test(id) || !workerId || request.headers.get('content-type')?.split(';')[0] !== 'audio/mpeg') return fail(400, 'invalid_body');
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
