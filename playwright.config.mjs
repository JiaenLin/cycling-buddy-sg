import { defineConfig, devices } from '@playwright/test';

const executablePath = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE;

export default defineConfig({
  testDir: './tests',
  outputDir: 'test-results',
  timeout: 45_000,
  expect: { timeout: 12_000 },
  fullyParallel: false,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 1 : 0,
  workers: 1,
  reporter: process.env.CI
    ? [['line'], ['html', { outputFolder: 'playwright-report', open: 'never' }]]
    : [['line']],
  use: {
    baseURL: 'http://127.0.0.1:4173',
    colorScheme: 'light',
    geolocation: { longitude: 103.85, latitude: 1.30 },
    permissions: ['geolocation'],
    serviceWorkers: 'block',
    screenshot: 'only-on-failure',
    trace: 'retain-on-failure'
  },
  projects: [
    {
      name: 'desktop-chromium',
      testMatch: 'browser/regression.spec.mjs',
      use: {
        ...devices['Desktop Chrome'], viewport: { width: 1280, height: 800 },
        launchOptions: executablePath ? { executablePath } : {}
      }
    },
    {
      name: 'mobile-chromium',
      testMatch: 'browser/regression.spec.mjs',
      use: { ...devices['Pixel 7'], launchOptions: executablePath ? { executablePath } : {} }
    },
    {
      name: 'desktop-firefox',
      testMatch: 'browser/regression.spec.mjs',
      use: {
        ...devices['Desktop Firefox'],
        viewport: { width: 1280, height: 800 },
        launchOptions: { firefoxUserPrefs: { 'webgl.force-enabled': true } }
      }
    },
    {
      name: 'mobile-webkit',
      testMatch: 'browser/regression.spec.mjs',
      use: { ...devices['iPhone 13'] }
    },
    {
      name: 'accessibility-desktop',
      testMatch: 'accessibility/accessibility.spec.mjs',
      use: {
        ...devices['Desktop Chrome'], viewport: { width: 1280, height: 800 },
        launchOptions: executablePath ? { executablePath } : {}
      }
    },
    {
      name: 'accessibility-mobile',
      testMatch: 'accessibility/accessibility.spec.mjs',
      use: { ...devices['Pixel 7'], launchOptions: executablePath ? { executablePath } : {} }
    },
    {
      name: 'performance-chromium',
      testMatch: 'performance/performance.spec.mjs',
      use: {
        ...devices['Pixel 7'], launchOptions: executablePath ? { executablePath } : {},
        screenshot: 'only-on-failure', trace: 'retain-on-failure'
      }
    },
    {
      name: 'recovery-chromium',
      testMatch: 'browser/sw-recovery.spec.mjs',
      use: {
        ...devices['Desktop Chrome'], serviceWorkers: 'allow',
        launchOptions: executablePath ? { executablePath } : {}
      }
    }
  ],
  webServer: {
    command: 'node scripts/serve.mjs 4173',
    url: 'http://127.0.0.1:4173/',
    reuseExistingServer: !process.env.CI,
    timeout: 30_000
  }
});
