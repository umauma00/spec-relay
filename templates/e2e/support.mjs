// Helpers for the screen tests. The same test runs against the old system and
// against the new one, so it never names anything only one of them has.
import fs from 'node:fs';
import path from 'node:path';

// The system this run tests: 'old' or 'new' (set by the kit's e2e.mjs). Never
// branch a test on it: a test that checks something else on each side proves
// nothing.
export const side = process.env.SPEC_RELAY_SIDE;

// A sign-in value from an environment variable the person set in the terminal.
// Passwords and tokens are never written in a test or a file.
export function secret(name) {
  const value = process.env[name];
  if (!value) throw new Error(`the environment variable ${name} is not set; ask the person to set it in this terminal`);
  return value;
}

// The path of a page on the system under test. Write the old system's path;
// paths.json in the capability's folder maps it to the new system's path where
// the port changed it on purpose ({ "/order_list.php": "/orders" }). Each line
// lets a difference through, so the port's design.md says why under
// Decisions. A system under a folder of its server (--base
// http://localhost/MyApp) keeps that folder in front.
let paths = {};
try {
  paths = JSON.parse(fs.readFileSync(path.join(process.env.SPEC_RELAY_E2E_TEST_DIR ?? '', 'paths.json'), 'utf8').replace(/^\uFEFF/, ''));
} catch { /* no paths.json: the paths are the same */ }
let prefix = '';
try { prefix = new URL(process.env.SPEC_RELAY_BASE_URL).pathname.replace(/\/+$/, ''); } catch { /* no address: Playwright reports it */ }

export function at(oldPath) {
  const cut = oldPath.search(/[?#]/);
  const [pathname, rest] = cut < 0 ? [oldPath, ''] : [oldPath.slice(0, cut), oldPath.slice(cut)];
  const mapped = side === 'new' ? paths[pathname] ?? pathname : pathname;
  return prefix + mapped + rest;
}
