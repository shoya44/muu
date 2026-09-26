import { test, expect } from '@playwright/test';
import { readFile } from 'node:fs/promises';

// ローカル R2 に 2 曲を置き、一覧・再生・保存・Service Worker・オフライン再生を通しで確かめる。
const PASSWORD = process.env.MUU_TEST_PASSWORD || 'devpass';
const DEMO = new URL('./fixtures/', import.meta.url);

async function upload(request, baseURL, key, title, duration, file) {
  const body = await readFile(new URL(file, DEMO));
  const res = await request.put(`${baseURL}/api/tracks/${encodeURIComponent(key)}`, {
    headers: { authorization: `Bearer ${PASSWORD}`, 'content-type': 'audio/mpeg', 'x-title': encodeURIComponent(title), 'x-duration': String(duration) },
    data: body,
  });
  expect([201, 409]).toContain(res.status());
}

test.beforeAll(async ({ request }, config) => {
  const baseURL = config.project.use.baseURL;
  await upload(request, baseURL, 'E2E/alpha.mp3', 'Alpha', 6, 'tone1.mp3');
  await upload(request, baseURL, 'E2E/beta.mp3', 'Beta', 12, 'tone2.mp3');
});

test('library lists uploaded tracks and hides broken ones', async ({ request, baseURL }) => {
  const res = await request.get(`${baseURL}/api/library`);
  const body = await res.json();
  const ids = body.tracks.map(t => t.id);
  expect(ids).toEqual(expect.arrayContaining(['E2E/alpha.mp3', 'E2E/beta.mp3']));
  const again = await request.get(`${baseURL}/api/library`, { headers: { 'if-none-match': body.etag } });
  expect(again.status()).toBe(304);
});

test('write APIs need the password', async ({ request, baseURL }) => {
  expect((await request.delete(`${baseURL}/api/tracks/E2E%2Falpha.mp3`)).status()).toBe(401);
  expect((await request.delete(`${baseURL}/api/tracks/E2E%2Falpha.mp3`, { headers: { authorization: 'Bearer wrong' } })).status()).toBe(401);
});

test('plays, saves, and keeps playing offline', async ({ page, context }) => {
  await page.goto('/');
  await expect(page.getByRole('button', { name: 'Play Alpha' })).toBeVisible();
  await page.getByRole('button', { name: 'Play Alpha' }).click();
  await expect(page.locator('#mini')).toBeVisible();
  await expect.poll(() => page.evaluate(() => !document.getElementById('audio').paused)).toBe(true);

  // Service Worker が有効になる。
  await expect.poll(() => page.evaluate(() => navigator.serviceWorker.getRegistration().then(r => Boolean(r?.active)))).toBe(true);

  // 保存し、Cache Storage に完全な音声が入る。
  const row = page.locator('.track', { hasText: 'Beta' });
  await row.getByRole('button', { name: 'Save to device' }).click();
  await expect(row.getByRole('button', { name: 'Remove from device' })).toBeVisible({ timeout: 15000 });
  const cachedSize = await page.evaluate(async () => {
    const cache = await caches.open('muu-media-v1');
    const res = await cache.match('/media/E2E%2Fbeta.mp3');
    return Number(res?.headers.get('content-length'));
  });
  expect(cachedSize).toBeGreaterThan(1000);

  // オフラインでも保存済みの曲は再生できる。
  await context.setOffline(true);
  await page.locator('.track', { hasText: 'Beta' }).getByRole('button', { name: 'Play Beta' }).click();
  await expect.poll(() => page.evaluate(() => { const a = document.getElementById('audio'); return !a.paused && a.currentTime > 0 && !a.error; }), { timeout: 10000 }).toBe(true);
  await context.setOffline(false);
});

test('playlist survives reload', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'Playlists' }).click();
  await page.getByRole('button', { name: 'New playlist' }).click();
  await page.locator('#prompt-input').fill('Road');
  await page.locator('#prompt-form button[type=submit]').click();
  await page.getByRole('button', { name: /Road/ }).click();
  await page.getByRole('button', { name: 'Add tracks' }).click();
  await page.locator('#chooser-list input').first().check();
  await page.locator('#chooser-ok').click();
  await expect(page.locator('#playlist-tracks .track')).toHaveCount(1);
  await page.reload();
  await page.getByRole('button', { name: 'Playlists' }).click();
  await expect(page.getByRole('button', { name: /Road/ })).toContainText('1 tracks');
});
