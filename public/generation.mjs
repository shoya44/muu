export function makeSubmission(url, voice, key, preset = 'recommended', mix_preset = 'standard', id = crypto.randomUUID()) {
  return { id, url: url.trim(), voice, key, preset, mix_preset };
}
export function getOrCreateSubmission(state, version, ...fields) {
  if (!state.current || state.current.version !== version) state.current = { version, body: makeSubmission(...fields) };
  return state.current.body;
}

const text = (tag, className, value) => { const node = document.createElement(tag); if (className) node.className = className; if (value != null) node.textContent = value; return node; };
const option = (value, label) => { const node = document.createElement('option'); node.value = value; node.textContent = label; return node; };
const JOB_LABELS = { queued: 'Queued', running: 'Generating', uploading: 'Uploading', done: 'Ready', failed: 'Failed' };
const STAGE_LABELS = { queued: 'Queued', downloading: 'Getting audio', voicelab: 'Generating', converting: 'Converting', mixing: 'Finishing mix', uploading: 'Uploading', done: 'Ready' };

export function mountGeneration({ root, authHeaders, onComplete, toast, icon }) {
  if (!document.querySelector('link[data-generation-css]')) {
    const stylesheet = document.createElement('link'); stylesheet.rel = 'stylesheet'; stylesheet.href = '/generation.css'; stylesheet.dataset.generationCss = 'true'; document.head.append(stylesheet);
  }
  const card = text('section', 'generation-card');
  card.hidden = true;
  card.setAttribute('aria-label', 'Generate');
  const heading = text('h2', 'generation-heading', 'Generate');
  const worker = text('p', 'generation-worker');
  const pairDetails = text('details', 'generation-pair');
  const pairSummary = text('summary', '', 'Connect PC');
  const pairHelp = text('p', 'generation-pair-help', 'Enter the code shown on your PC.');
  const pairForm = text('form', 'generation-pair-form');
  const pairCode = text('input', 'generation-pair-code');
  pairCode.type = 'text'; pairCode.inputMode = 'numeric'; pairCode.pattern = '[0-9]{6}'; pairCode.maxLength = 6; pairCode.required = true; pairCode.autocomplete = 'one-time-code'; pairCode.placeholder = '6-digit code'; pairCode.setAttribute('aria-label', 'PC connection code');
  const pairSubmit = text('button', 'generation-pair-submit', 'Connect PC'); pairSubmit.type = 'submit'; pairSubmit.disabled = true;
  const pairMessage = text('p', 'generation-pair-message'); pairMessage.setAttribute('role', 'status');
  pairForm.append(pairCode, pairSubmit);
  pairDetails.append(pairSummary, pairHelp, pairForm, pairMessage);
  const form = text('form', 'generation-form');
  const url = text('input', 'generation-url'); url.type = 'url'; url.required = true; url.placeholder = 'Video or audio URL'; url.setAttribute('aria-label', 'URL');
  const voice = text('select', 'generation-voice'); voice.setAttribute('aria-label', 'Voice');
  const key = text('select', 'generation-key'); key.setAttribute('aria-label', 'Key');
  key.append(option('auto', 'Key · Auto'));
  for (let n = -12; n <= 12; n++) key.append(option(String(n), n === 0 ? 'Key · 0 (original)' : `Key · ${n > 0 ? '+' : ''}${n}`));
  const advanced = text('details', 'generation-advanced');
  const advancedSummary = text('summary', '', 'Advanced');
  const preset = text('select', 'generation-preset'); preset.setAttribute('aria-label', 'Conversion preset');
  const mixPreset = text('select', 'generation-mix'); mixPreset.setAttribute('aria-label', 'Mix finish');
  advanced.append(advancedSummary, preset, mixPreset);
  const submit = text('button', 'generation-submit', 'Generate'); submit.type = 'submit'; submit.disabled = true;
  const message = text('p', 'generation-message'); message.setAttribute('role', 'status');
  const jobs = text('div', 'generation-jobs');
  form.append(url, voice, key, advanced, submit);
  card.append(heading, worker, pairDetails, form, message, jobs);
  const anchor = root.querySelector('#recent-card') || root.querySelector('#admin');
  root.insertBefore(card, anchor);

  let enabled = false, busy = false, timer = null, controller = null, submitController = null, pairController = null, epoch = 0, catalog = null;
  let formVersion = 0, requestState = {}, initializedJobs = false;
  let catalogReady = false, submitPending = false, pairPending = false, pollAgain = false;
  const completed = new Set();
  const abort = () => { epoch++; controller?.abort(); controller = null; submitController?.abort(); submitController = null; pairController?.abort(); pairController = null; submitPending = false; pairPending = false; submit.disabled = true; pairSubmit.disabled = true; clearTimeout(timer); timer = null; pollAgain = false; };
  const active = () => enabled && !card.hidden && !document.hidden;
  const updateCard = () => { card.hidden = !enabled; };
  const refreshChoices = body => {
    catalog = body.catalog;
    const previousVoice = voice.value;
    const previousPreset = preset.value;
    const previousMix = mixPreset.value;
    const hadCatalog = catalogReady;
    voice.replaceChildren(...catalog.voices.map(item => option(item.id, item.label)));
    voice.value = hadCatalog && catalog.voices.some(item => item.id === previousVoice)
      ? previousVoice
      : (catalog.voices.some(item => item.id === catalog.default_voice) ? catalog.default_voice : catalog.voices[0]?.id || '');
    const voiceChanged = hadCatalog && voice.value !== previousVoice;
    const validPresets = catalog.voices.find(item => item.id === voice.value)?.convert_presets || [];
    preset.replaceChildren(...validPresets.map(item => option(item.id, item.label)));
    preset.value = !voiceChanged && hadCatalog && validPresets.some(item => item.id === previousPreset)
      ? previousPreset
      : (validPresets.some(item => item.id === 'recommended') ? 'recommended' : validPresets[0]?.id || '');
    mixPreset.replaceChildren(...catalog.mix_presets.map(item => option(item.id, item.label)));
    mixPreset.value = hadCatalog && catalog.mix_presets.some(item => item.id === previousMix)
      ? previousMix
      : (catalog.mix_presets.some(item => item.id === 'standard') ? 'standard' : catalog.mix_presets[0]?.id || '');
    catalogReady = true;
    submit.disabled = submitPending || !catalog.voices.length || !validPresets.length || !catalog.mix_presets.length;
      pairDetails.hidden = Boolean(body.worker?.online);
      if (!hadCatalog && !catalog.voices.length) pairDetails.open = true;
    if (hadCatalog && (voiceChanged || preset.value !== previousPreset || mixPreset.value !== previousMix)) changed();
  };
  const updateModelPresets = () => {
    const voiceEntry = catalog?.voices.find(item => item.id === voice.value);
    preset.replaceChildren(...(voiceEntry?.convert_presets || []).map(item => option(item.id, item.label)));
    preset.value = voiceEntry?.convert_presets?.some(item => item.id === 'recommended') ? 'recommended' : voiceEntry?.convert_presets?.[0]?.id || '';
    changed();
  };
  const changed = () => { formVersion++; requestState.current = null; };
  const renderJobs = list => {
    jobs.replaceChildren(...list.slice(0, 8).map(job => {
      const row = text('div', `generation-job generation-${job.status}`);
      const label = text('span', 'generation-job-title', job.url || job.track_id || 'Request');
      const stateLabel = job.status === 'failed' ? 'Failed · Could not generate. Try again.' : (JOB_LABELS[job.status] || 'In progress');
      const stageLabel = STAGE_LABELS[job.stage];
      const state = text('span', 'generation-job-state', stageLabel && stageLabel !== stateLabel && job.status !== 'done' && job.status !== 'failed' ? `${stateLabel} · ${stageLabel}` : stateLabel);
      row.append(label, state); return row;
    }));
  };
  const poll = async token => {
    if (!active() || token !== epoch) return;
    if (busy) { pollAgain = true; return; }
    busy = true;
    const local = new AbortController(); controller = local;
    try {
      const response = await fetch('/api/generation', { headers: authHeaders(), cache: 'no-store', signal: local.signal });
      if (token !== epoch) return;
      if (response.status === 404) { enabled = false; updateCard(); abort(); return; }
      if (response.status === 401) { enabled = false; updateCard(); abort(); return; }
      if (!response.ok) throw new Error('Unable to check requests.');
      const body = await response.json();
      if (token !== epoch) return;
      if (!body.enabled) { enabled = false; updateCard(); abort(); return; }
      refreshChoices(body);
      if (message.textContent.startsWith('Unable to check requests.')) message.textContent = '';
      worker.textContent = body.worker?.online ? 'PC online' : 'PC offline · requests wait until it starts';
      renderJobs(body.jobs || []);
      if (!initializedJobs) { for (const job of body.jobs || []) if (job.status === 'done') completed.add(job.id); initializedJobs = true; }
      else for (const job of body.jobs || []) if (job.status === 'done' && !completed.has(job.id)) { completed.add(job.id); onComplete(); }
    } catch (error) { if (error.name !== 'AbortError' && token === epoch) message.textContent = 'Unable to check requests. Reconnecting…'; }
    finally {
      if (controller === local) controller = null;
      busy = false;
      if (active()) {
        clearTimeout(timer);
        const nextToken = epoch;
        timer = setTimeout(() => poll(nextToken), token !== epoch || pollAgain ? 0 : 4000);
        pollAgain = false;
      }
    }
  };
  const setActive = value => {
    const next = Boolean(value);
    if (next === enabled) return;
    if (!next && submitPending) message.textContent = 'Request not confirmed. Retry to use the same request.';
    if (!next && pairPending) pairMessage.textContent = 'Connection not confirmed. Get a new code from your PC and retry.';
    enabled = next; updateCard();
    if (!enabled) {
      abort();
      pairCode.value = '';
      pairSubmit.disabled = true;
      return;
    }
    void poll(epoch);
  };
  voice.addEventListener('change', updateModelPresets);
  pairCode.addEventListener('input', () => {
    pairCode.value = pairCode.value.replace(/\D/g, '').slice(0, 6);
    pairSubmit.disabled = pairCode.value.length !== 6 || pairPending;
  });
  pairForm.addEventListener('submit', async event => {
    event.preventDefault();
    if (!/^\d{6}$/.test(pairCode.value) || pairSubmit.disabled || !active()) return;
    const code = pairCode.value;
    pairCode.value = '';
    pairSubmit.disabled = true; pairPending = true; pairMessage.textContent = 'Connecting…';
    const token = epoch;
    const local = new AbortController(); pairController = local;
    try {
      const response = await fetch('/api/generation/pair/approve', {
        method: 'POST', headers: { ...authHeaders(), 'content-type': 'application/json' },
        body: JSON.stringify({ code }), signal: local.signal,
      });
      if (token !== epoch || !active()) return;
      if (response.status === 401) { enabled = false; updateCard(); abort(); return; }
      const result = await response.json().catch(() => ({}));
      if (token !== epoch || !active()) return;
      if (response.status === 404 && result.error === 'pair_not_found') {
        pairMessage.textContent = 'That code is invalid or expired. Get a new code from your PC.';
        return;
      }
      if (response.status === 404) { enabled = false; updateCard(); abort(); return; }
      if (!response.ok) { pairMessage.textContent = 'Could not connect PC. Try again with a new code.'; return; }
      pairDetails.open = false;
      pairMessage.textContent = 'PC connected. Waiting for voices…';
      toast('PC connected');
      void poll(epoch);
    } catch {
      if (token === epoch && active()) pairMessage.textContent = 'Could not connect PC. Try again with a new code.';
    } finally {
      if (pairController === local) pairController = null;
      if (token === epoch) { pairPending = false; pairSubmit.disabled = pairCode.value.length !== 6; }
    }
  });
  for (const field of [url, key, preset, mixPreset]) field.addEventListener('change', changed);
  form.addEventListener('input', event => { if (event.target === url) changed(); });
  form.addEventListener('submit', async event => {
    event.preventDefault();
    if (!catalogReady || !catalog || !url.value.trim() || !voice.value || submit.disabled) return;
    const version = formVersion;
    const body = getOrCreateSubmission(requestState, version, url.value, voice.value, key.value === 'auto' ? 'auto' : Number(key.value), preset.value, mixPreset.value);
    const token = epoch;
    submitPending = true; submit.disabled = true; message.textContent = 'Sending request…';
    const local = new AbortController(); submitController = local;
    try {
      const response = await fetch('/api/generation', { method: 'POST', headers: { ...authHeaders(), 'content-type': 'application/json' }, body: JSON.stringify(body), signal: local.signal });
      if (token !== epoch || !active()) return;
      if (response.status === 404) { enabled = false; updateCard(); abort(); return; }
      if (response.status === 401) { enabled = false; updateCard(); abort(); return; }
      if (!response.ok) throw new Error('Request could not be sent. Retry to use the same request.');
      const result = await response.json();
      if (token !== epoch || !active()) return;
      message.textContent = result.status === 'queued' ? 'Request queued.' : 'Request received.';
      toast('Generation request sent');
      void poll(epoch);
    } catch { if (token === epoch && active()) message.textContent = 'Request could not be sent. Retry to use the same request.'; }
    finally {
      if (submitController === local) submitController = null;
      if (token === epoch) { submitPending = false; submit.disabled = !catalogReady; }
    }
  });
  return { card, setActive };
}

export function setGenerationActive(handle, active) { handle?.setActive(active); }
