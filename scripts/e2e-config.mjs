// The Playwright configuration e2e.mjs runs the screen tests with (levels B2
// and C). It loads the target's own tests/e2e/playwright.config.mjs (browser,
// language, window, timeouts) and sets on top what must be the same for the old
// and the new run, so that no setting there can make the two runs test
// different things:
//   - the address of the system under test (SPEC_RELAY_BASE_URL);
//   - the test folder of one capability, and only *.e2e.mjs / .js / .ts files;
//   - one worker and no retries (tests share the test database, and a retry
//     would pass a test that fails half the time);
//   - no `only`, no grep, no ignored files, no web server of its own;
//   - screenshots under <capability folder>/screenshots/, without the platform
//     or the browser in their names, taken from the old system and compared on
//     the new one (updateSnapshots: all for the old run, none for the new);
//   - no trace (it records what is typed, passwords included) and results
//     under openspec/spec-relay/local/, which git ignores;
//   - the JSON report e2e.mjs reads.
// It imports nothing from Playwright, so it works from the kit's folder.
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const env = process.env;
const userFile = env.SPEC_RELAY_E2E_USER_CONFIG;
let user = {};
if (userFile && fs.existsSync(userFile)) user = (await import(pathToFileURL(userFile).href)).default ?? {};
// Paths in the target's configuration are relative to its folder, not to this one.
const fromUser = (value) => (typeof value === 'string' && !path.isAbsolute(value) ? path.resolve(path.dirname(userFile), value) : value);
for (const key of ['globalSetup', 'globalTeardown']) {
  if (user[key] !== undefined) user = { ...user, [key]: Array.isArray(user[key]) ? user[key].map(fromUser) : fromUser(user[key]) };
}

const fixedUse = { baseURL: env.SPEC_RELAY_BASE_URL, trace: 'off' };
const projects = Array.isArray(user.projects) ? user.projects : [];
if (projects.length > 1) {
  throw new Error('tests/e2e/playwright.config.mjs defines more than one project: keep one browser, so the old and the new system are compared in the same one');
}
const without = (object, keys) => Object.fromEntries(Object.entries(object ?? {}).filter(([key]) => !keys.includes(key)));
const LOOSE = ['testDir', 'testMatch', 'testIgnore', 'grep', 'grepInvert', 'retries', 'repeatEach', 'snapshotDir', 'snapshotPathTemplate', 'outputDir', 'dependencies', 'teardown', 'fullyParallel'];

export default {
  ...without(user, ['projects', 'webServer', 'shard', 'reporter', ...LOOSE, 'workers', 'forbidOnly', 'updateSnapshots', 'ignoreSnapshots', 'maxFailures']),
  testDir: env.SPEC_RELAY_E2E_TEST_DIR,
  testMatch: '**/*.e2e.@(mjs|js|ts)',
  outputDir: env.SPEC_RELAY_E2E_OUTPUT_DIR,
  snapshotPathTemplate: '{testDir}/screenshots/{testFilePath}/{arg}{ext}',
  workers: 1,
  fullyParallel: false,
  retries: 0,
  repeatEach: 1,
  forbidOnly: true,
  ignoreSnapshots: false,
  updateSnapshots: env.SPEC_RELAY_E2E_UPDATE === 'all' ? 'all' : 'none',
  reporter: [['json', { outputFile: env.SPEC_RELAY_E2E_REPORT }]],
  use: { ...user.use, ...fixedUse },
  ...(projects.length ? { projects: [{ ...without(projects[0], LOOSE), use: { ...projects[0].use, ...fixedUse } }] } : {}),
};
