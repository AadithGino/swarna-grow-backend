/** @type {import('@playwright/test').PlaywrightTestConfig} */
export default {
  testDir: "./scripts",
  testMatch: "phase1-customer-identity.browser.spec.js",
  timeout: 120_000,
  expect: { timeout: 45_000 },
  use: {
    headless: true,
    viewport: { width: 390, height: 844 },
    actionTimeout: 30_000,
  },
  workers: 1,
};
