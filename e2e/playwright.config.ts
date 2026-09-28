import { defineConfig, devices } from '@playwright/test';

/**
 * E2E del flujo del cliente en celulares emulados (Android e iPhone, motor Chromium).
 * Requiere API + web corriendo (pnpm dev) o E2E_BASE_URL apuntando a otro entorno.
 */
const executablePath = process.env.PW_CHROMIUM_PATH || undefined;

export default defineConfig({
  testDir: '.',
  timeout: 60_000,
  retries: 0,
  reporter: [['list']],
  outputDir: './artifacts/results',
  use: {
    baseURL: process.env.E2E_BASE_URL ?? 'http://localhost:5173',
    locale: 'es-PE',
    timezoneId: 'America/Lima',
    trace: 'retain-on-failure',
    launchOptions: executablePath ? { executablePath } : {},
  },
  projects: [
    { name: 'android', use: { ...devices['Pixel 7'] } },
    {
      name: 'iphone',
      use: { ...devices['iPhone 14'], browserName: 'chromium', defaultBrowserType: 'chromium' },
    },
  ],
});
