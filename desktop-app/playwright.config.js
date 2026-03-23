// @ts-check
const { defineConfig } = require('@playwright/test');
const path = require('path');

const PORT = 5055;

module.exports = defineConfig({
  testDir: './tests',
  timeout: 60_000,
  expect: { timeout: 10_000 },
  retries: 0,
  workers: 1,
  reporter: 'list',
  globalSetup: path.join(__dirname, 'tests', 'global-setup.js'),
  globalTeardown: path.join(__dirname, 'tests', 'global-teardown.js'),
  use: {
    baseURL: `http://127.0.0.1:${PORT}`,
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
  },
});
