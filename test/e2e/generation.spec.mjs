import { test, expect } from '@playwright/test';
import { readFile } from 'node:fs/promises';

const catalog = {
  enabled: true,
  catalog: {
    voices: [
      { id: 'voice-a', label: 'Voice A', convert_presets: [{ id: 'recommended', label: 'Recommended' }, { id: 'bright', label: 'Bright' }] },
      { id: 'voice-b', label: 'Voice B', convert_presets: [{ id: 'warm', label: 'Warm' }] },
    ],
    mix_presets: [{ id: 'standard', label: 'Standard' }, { id: 'wide', label: 'Wide' }],
    default_voice: 'voice-a',
  },
  worker: { online: false, last_seen: null }, jobs: [],
};
const emptyCatalog = { enabled: true, catalog: { voices: [], mix_presets: [], default_voice: '' }, worker: { online: false, last_seen: null }, jobs: [] };

async function assertGenerateClearOfNavbar(page, card) {
  const button = card.getByRole('button', { name: 'Generate' });
  await button.evaluate(node => node.scrollIntoView({ block: 'center', inline: 'nearest' }));
  await expect.poll(() => page.evaluate(() => {
    const buttonRect = document.querySelector('.generation-submit').getBoundingClientRect();
    const navRect = document.querySelector('.navbar').getBoundingClientRect();
    const center = document.elementFromPoint(buttonRect.left + buttonRect.width / 2, buttonRect.top + buttonRect.height / 2);
    return buttonRect.bottom <= navRect.top && (center === document.querySelector('.generation-submit') || document.querySelector('.generation-submit').contains(center));
  })).toBe(true);
  await button.click({ trial: true });
}

async function unlock(page) {
  await page.goto('/');
  await page.getByRole('button', { name: 'Settings' }).click();
  const library = page.locator('#view-settings details[data-section="library"]');
  await library.locator('summary').click();
  await page.locator('#password').fill('devpass');
  await page.getByRole('button', { name: 'Save password' }).click();
}

test('generation is admin only and a disabled feature leaves app controls intact', async ({ page }) => {
  await page.route('**/api/auth', route => route.fulfill({ status: 200, body: '{}' }));
  await page.route('**/api/generation', route => route.fulfill({ status: 404, body: '{}' }));
  await unlock(page);
  await expect(page.locator('.generation-card')).toHaveCount(1);
  await expect(page.locator('.generation-card')).toBeHidden();
  await expect(page.locator('#password-state')).toContainText('Unlocked');
  await expect(page.getByRole('button', { name: 'All Songs' })).toBeVisible();
});

test('request retries keep id and model changes update conversion presets', async ({ page }) => {
  const bodies = [];
  let first = true;
  await page.route('**/api/auth', route => route.fulfill({ status: 200, body: '{}' }));
  await page.route('**/api/generation', async route => {
    if (route.request().method() === 'GET') return route.fulfill({ json: catalog });
    bodies.push(route.request().postDataJSON());
    if (first) { first = false; return route.abort('failed'); }
    return route.fulfill({ status: 202, json: { id: 'job-id', status: 'queued' } });
  });
  await unlock(page);
  const card = page.locator('.generation-card');
  await expect(card).toBeVisible();
  await expect(card.locator('.generation-worker')).toContainText('PC offline');
  await expect(page.locator('#toast')).toBeHidden();
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
  await card.screenshot({ path: 'test-results/generation-mobile.png' });
  await page.setViewportSize({ width: 390, height: 664 });
  await assertGenerateClearOfNavbar(page, card);
  await page.setViewportSize({ width: 390, height: 844 });
  await assertGenerateClearOfNavbar(page, card);
  await page.setViewportSize({ width: 1280, height: 900 });
  await assertGenerateClearOfNavbar(page, card);
  await card.screenshot({ path: 'test-results/generation-desktop.png' });
  await card.getByLabel('URL').fill('https://example.com/video');
  await card.locator('.generation-advanced summary').click();
  await card.getByLabel('Voice').selectOption('voice-b');
  await expect(card.getByLabel('Conversion preset').locator('option')).toHaveText(['Warm']);
  await card.getByLabel('Voice').selectOption('voice-a');
  await card.getByLabel('Conversion preset').selectOption('bright');
  await card.getByLabel('Mix finish').selectOption('wide');
  await page.waitForTimeout(4500);
  await expect(card.getByLabel('Voice')).toHaveValue('voice-a');
  await expect(card.getByLabel('Conversion preset')).toHaveValue('bright');
  await expect(card.getByLabel('Mix finish')).toHaveValue('wide');
  await card.getByRole('button', { name: 'Generate' }).click();
  await expect(card.locator('.generation-message')).toContainText('same request');
  await page.waitForTimeout(4500);
  await expect(card.getByLabel('Conversion preset')).toHaveValue('bright');
  await card.getByRole('button', { name: 'Generate' }).click();
  await expect.poll(() => bodies.length).toBe(2);
  expect(bodies[0].id).toBe(bodies[1].id);
  expect(bodies[1]).toMatchObject({ url: 'https://example.com/video', voice: 'voice-a', preset: 'bright', mix_preset: 'wide', key: 'auto' });
  await expect(card.locator('.generation-message')).toContainText('queued');
});

test('leaving Settings aborts a pending request without late UI updates', async ({ page }) => {
  await page.route('**/api/auth', route => route.fulfill({ status: 200, body: '{}' }));
  await page.route('**/api/generation', async route => {
    if (route.request().method() === 'GET') return route.fulfill({ json: catalog });
    await new Promise(resolve => setTimeout(resolve, 700));
    return route.fulfill({ status: 202, json: { id: 'job-id', status: 'queued' } });
  });
  await unlock(page);
  const card = page.locator('.generation-card');
  await expect(card).toBeVisible();
  await card.getByLabel('URL').fill('https://example.com/pending');
  await card.getByRole('button', { name: 'Generate' }).click();
  await page.getByRole('button', { name: 'All Songs' }).click();
  await page.waitForTimeout(900);
  await expect(page.locator('#toast')).toBeHidden();
  await page.getByRole('button', { name: 'Settings' }).click();
  await expect(card).toBeVisible();
  await expect(card.locator('.generation-message')).toContainText('not confirmed');
});

test('PC code pairing works before catalog sync, hides code after submit, and cancels stale approval UI', async ({ page }) => {
  let paired = false;
  const approvals = [];
  await page.route('**/api/auth', route => route.fulfill({ status: 200, body: '{}' }));
  await page.route('**/api/generation/pair/approve', async route => {
    const body = route.request().postDataJSON();
    approvals.push({ body, authorization: route.request().headers().authorization });
    if (body.code === '111111') return route.fulfill({ status: 404, json: { error: 'pair_not_found' } });
    await new Promise(resolve => setTimeout(resolve, body.code === '222222' ? 700 : 20));
    paired = body.code === '333333';
    return paired ? route.fulfill({ status: 200, json: { ok: true, worker_id: 'worker-id' } }) : route.fulfill({ status: 404, json: { error: 'pair_not_found' } });
  });
  await page.route('**/api/generation', route => route.fulfill({ json: paired ? catalog : emptyCatalog }));
  await unlock(page);
  const card = page.locator('.generation-card');
  await expect(card).toBeVisible();
  await expect(card.getByLabel('PC connection code')).toBeVisible();
  await expect(card.getByRole('button', { name: 'Generate' })).toBeDisabled();

  const codeInput = card.getByLabel('PC connection code');
  await codeInput.fill('111111');
  await card.getByRole('button', { name: 'Connect PC' }).click();
  await expect(card.locator('.generation-pair-message')).toContainText('invalid or expired');
  await expect(codeInput).toHaveValue('');

  await codeInput.fill('222222');
  await card.getByRole('button', { name: 'Connect PC' }).click();
  await page.getByRole('button', { name: 'All Songs' }).click();
  await page.waitForTimeout(850);
  await expect(page.locator('#toast')).toBeHidden();
  await page.getByRole('button', { name: 'Settings' }).click();
  await expect(card).toBeVisible();
  await expect(card.locator('.generation-pair-message')).toContainText('not confirmed');
  await expect(codeInput).toHaveValue('');

  await codeInput.fill('333333');
  await card.getByRole('button', { name: 'Connect PC' }).click();
  await expect(card.locator('.generation-pair-message')).toContainText('PC connected');
  await expect(card.getByRole('button', { name: 'Generate' })).toBeEnabled();
  await expect(card.getByLabel('Voice')).toHaveValue('voice-a');
  expect(approvals).toHaveLength(3);
  expect(approvals.map(item => item.body)).toEqual([{ code: '111111' }, { code: '222222' }, { code: '333333' }]);
  expect(approvals.every(item => item.authorization === 'Bearer devpass')).toBe(true);
});

test('newly completed generation refreshes library while current audio keeps playing', async ({ page }) => {
  const audio = await readFile(new URL('./fixtures/tone2.mp3', import.meta.url));
  let libraryReads = 0;
  let jobs = [];
  await page.route('**/api/library', route => {
    libraryReads++;
    return route.fulfill({ json: { tracks: [{ id: 'E2E/playing.mp3', title: 'Playing', folder: 'E2E', duration: 12, size: audio.length, uploadedAt: '2026-01-01T00:00:00.000Z' }], etag: `lib-${libraryReads}`, used: audio.length, limit: 10000000 } });
  });
  await page.route('**/media/**', route => route.fulfill({ body: audio, contentType: 'audio/mpeg' }));
  await page.route('**/api/auth', route => route.fulfill({ status: 200, body: '{}' }));
  await page.route('**/api/generation', async route => {
    if (route.request().method() === 'GET') return route.fulfill({ json: { ...catalog, jobs } });
    jobs = [{ id: 'job-completed', url: 'https://example.com/finished', voice: 'voice-a', key: 'auto', preset: 'recommended', mix_preset: 'standard', folder: 'voice-a', status: 'done', stage: 'done', track_id: 'voice-a/generation-job-completed.mp3', created: '2026-01-01T00:00:00.000Z', updated: '2026-01-01T00:00:01.000Z' }];
    return route.fulfill({ status: 202, json: { ...jobs[0], status: 'queued' } });
  });

  await page.goto('/');
  await expect(page.getByRole('button', { name: 'Play Playing' })).toBeVisible();
  await page.evaluate(() => { document.getElementById('audio').loop = true; });
  await page.getByRole('button', { name: 'Play Playing' }).click();
  await expect.poll(() => page.evaluate(() => !document.getElementById('audio').paused && document.getElementById('audio').currentTime > 0)).toBe(true);
  const initialReads = libraryReads;

  await page.getByRole('button', { name: 'Settings' }).click();
  const library = page.locator('#view-settings details[data-section="library"]');
  await library.locator('summary').click();
  await page.locator('#password').fill('devpass');
  await page.getByRole('button', { name: 'Save password' }).click();
  const card = page.locator('.generation-card');
  await expect(card).toBeVisible();
  await card.getByLabel('URL').fill('https://example.com/finished');
  await card.getByRole('button', { name: 'Generate' }).click();
  await expect(card.locator('.generation-message')).toContainText('Request queued.');
  await expect.poll(() => libraryReads).toBeGreaterThan(initialReads);
  await expect(card.locator('.generation-job-state')).toContainText('Ready');
  await expect.poll(() => page.evaluate(() => !document.getElementById('audio').paused && document.getElementById('audio').currentTime > 0)).toBe(true);
});
