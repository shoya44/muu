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
  const generateButton = card.getByRole('button', { name: 'Generate' });
  await generateButton.scrollIntoViewIfNeeded();
  const mobileControlsClearNav = await page.evaluate(() => {
    const button = document.querySelector('.generation-submit').getBoundingClientRect();
    const nav = document.querySelector('.navbar').getBoundingClientRect();
    return button.bottom <= nav.top;
  });
  expect(mobileControlsClearNav).toBe(true);
  await page.setViewportSize({ width: 1280, height: 900 });
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
