import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './e2e',
  timeout: 30_000,
  use: { ...devices['iPhone 13'], browserName: 'chromium', baseURL: 'http://127.0.0.1:8790' },
  webServer: {
    command: 'npm run dev',
    url: 'http://127.0.0.1:8790/version.json',
    reuseExistingServer: true,
    timeout: 120_000,
  },
});
