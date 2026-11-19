// Helpers for the screen tests. The same test runs against the old system and
// against the new one, so it never names anything only one of them has.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

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
// paths.json maps it to the new system's path where the port changed it on
// purpose ({ "/order_list.php": "/orders" }). Each line lets a difference
// through, so the port's design.md says why under Decisions.
const here = path.dirname(fileURLToPath(import.meta.url));
let paths = {};
try { paths = JSON.parse(fs.readFileSync(path.join(here, 'paths.json'), 'utf8').replace(/^﻿/, '')); } catch { /* no paths.json: the paths are the same */ }

export function at(oldPath) {
  if (side !== 'new') return oldPath;
  const [pathname, rest = ''] = oldPath.split(/(?=[?#])/);
  return (paths[pathname] ?? pathname) + rest;
}
