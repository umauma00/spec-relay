// The settings both the old and the new system are tested with (spec-relay
// levels B2 and C). The kit's e2e.mjs runs the tests with its own
// configuration on top of this one, and always sets: the address (the old
// system, then the new one), the test folder of one capability, one worker, no
// retries, no trace, where the screenshots live, and the report. The rest is
// decided here, once, for every capability.
import { defineConfig } from '@playwright/test';

export default defineConfig({
  timeout: 60_000,
  use: {
    // Windows 11 comes with Edge, so no browser has to be downloaded. Elsewhere
    // run `npx playwright install chromium` in this folder once, or set
    // SPEC_RELAY_E2E_CHANNEL (chrome, msedge) to use an installed browser.
    channel: process.env.SPEC_RELAY_E2E_CHANNEL || (process.platform === 'win32' ? 'msedge' : undefined),
    // The language, time zone and window of the people who use the screens.
    // Screenshots (level C) depend on them, so keep them for the whole migration.
    locale: 'ja-JP',
    timezoneId: 'Asia/Tokyo',
    viewport: { width: 1280, height: 800 },
  },
  expect: {
    // Screenshots without moving parts. Loosening the comparison (threshold,
    // maxDiffPixels) lets differences through: write why under Decisions in
    // the port's design.md.
    toHaveScreenshot: { animations: 'disabled', caret: 'hide' },
  },
});
