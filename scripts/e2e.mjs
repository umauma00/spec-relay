#!/usr/bin/env node
// Levels B2 and C of a port: the screen scenarios as Playwright tests, run
// first against the old system, then, unchanged, against the new one.
//
//   node e2e.mjs init [--root DIR]
//        copies the kit's template to <target root>/tests/e2e/ (package.json
//        with the pinned @playwright/test, playwright.config.mjs, support.mjs)
//        when it is not there yet; then run `npm ci` in that folder once
//   node e2e.mjs old --change port-<capability> --base URL [--reset "<command>"]
//                    [--allow-host HOST] [--root DIR] [--timeout-minutes N]
//        runs the capability's tests against the RUNNING old system (a test
//        copy the person started) and, when every test passed, writes
//        openspec/changes/<change>/e2e-old.json: the tests that passed and the
//        hash of tests/e2e/ after the run. Screenshots (`toHaveScreenshot`,
//        level C) are taken here, from the old system.
//   node e2e.mjs new --capability CAP --base URL --start "<command>" [--reset "<command>"]
//                    [--wait-seconds N] [--root DIR] [--timeout-minutes N]
//        the same run as a port's command, by hand or for the finish step:
//        against the old run of the active port of CAP, else of its newest
//        archived port.
//
// In a port's design.md, the B2 (and C) command is written without the kit's path:
//   spec-relay-e2e --base http://localhost:3000 --start 'npm --silent start' [--reset '<command>']
// verify.mjs runs it with this script, in the target root: it refuses to run
// when tests/e2e/ changed after the old run (a test must pass on the old
// system before it may judge the new one), starts the new system, runs the
// same tests with the screenshots of the old run (never updated), stops the
// system, and fails unless exactly the tests that passed on the old system
// passed on the new one. Its result goes into verify.json:
//   e2e: { sha256, tests, titles: [...], screenshots, oldRanAt }
//
// The tests: tests/e2e/<capability with - for />/**/*.e2e.mjs (or .js, .ts).
// Each test's title is the tag of the scenario it checks,
// `spec-relay: <capability> | <requirement> | <scenario>`, exactly as in the
// baseline spec. The kit's e2e-config.mjs runs them on top of the target's
// playwright.config.mjs with what both runs must share (one worker, no
// retries, the screenshots' place, no trace). The old and the new system use
// different ids and classes, so tests find elements the way a user does:
// getByRole, getByLabel, getByText. An id, class, test-id or XPath selector is
// refused.
//
// Exits 0 when every test passed, 1 when not, 2 on bad usage.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runCommand, MAX_TIMEOUT_MS, stopAllOnSignal } from './run.mjs';
import { answers, baseUrl, startSystem } from './http.mjs';
import { words } from './compare.mjs';
import { chainProblem, changeSchema, cleanValue, configValue, portCapability, readIf, scenarioList, tagMatches, titleTag } from './gate.mjs';
import { ignoreLocal } from './metrics.mjs';

const KIT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const E2E_COMMAND = 'spec-relay-e2e';
export const E2E_DIR = 'tests/e2e';
export const OLD_RECEIPT = 'e2e-old.json';
export const isE2eCommand = (command) => new RegExp(`^\\s*${E2E_COMMAND}(\\s|$)`).test(command ?? '');
const TEST_FILE = /\.e2e\.(mjs|js|ts)$/i;
const SKIP_DIRS = new Set(['node_modules', '.git']);
const SHOW = 20;

const kitVersion = () => { try { return JSON.parse(fs.readFileSync(path.join(KIT, 'package.json'), 'utf8')).version; } catch { return 'unknown'; } };
export const capabilityFolder = (capability) => capability.split('/').filter(Boolean).join('-');
const targetDir = (root) => {
  const target = cleanValue(configValue(root, 'Target root', '')).replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/+$/, '');
  return target ? path.resolve(root, target) : null;
};

// --- options -------------------------------------------------------------------

const OPTIONS = {
  old: { '--change': 'change', '--base': 'base', '--reset': 'reset', '--allow-host': 'allow', '--root': 'root', '--timeout-minutes': 'timeout' },
  new: { '--capability': 'capability', '--base': 'base', '--start': 'start', '--reset': 'reset', '--wait-seconds': 'wait', '--root': 'root', '--timeout-minutes': 'timeout' },
  port: { '--base': 'base', '--start': 'start', '--reset': 'reset', '--wait-seconds': 'wait' },
};

// The options of a mode (old, new, or the port command), or { problem }.
export function parseE2eOptions(argv, mode) {
  const opts = { allow: [] };
  for (let i = 0; i < argv.length; i += 2) {
    const key = OPTIONS[mode][argv[i]];
    if (!key || argv[i + 1] === undefined) {
      if (mode === 'port' && argv[i] === '--allow-host') return { problem: '--allow-host is not allowed in a port command: the verify run starts the new system on this machine and tests it only there' };
      return { problem: `unknown or incomplete option ${argv[i]}` };
    }
    if (key === 'allow') opts.allow.push(argv[i + 1].toLowerCase()); else opts[key] = argv[i + 1];
  }
  if (!opts.base) return { problem: 'no --base URL (such as http://localhost:3000)' };
  const base = baseUrl(opts.base, opts.allow);
  if (base.problem) return base;
  if (mode !== 'old' && !opts.start) return { problem: `${mode === 'port' ? 'a port command' : 'new'} needs --start '<command>': the run starts the new system itself, so it tests the code as it is now` };
  if (mode === 'old' && !opts.change) return { problem: 'old needs --change port-<capability>' };
  if (mode === 'new' && !opts.capability) return { problem: 'new needs --capability <capability>' };
  for (const key of ['start', 'reset']) {
    const chained = opts[key] !== undefined && chainProblem(opts[key]);
    if (chained) return { problem: `the --${key} command ${chained}` };
  }
  if (opts.wait !== undefined && !(Number(opts.wait) > 0 && Number(opts.wait) <= 3600)) return { problem: `--wait-seconds ${opts.wait} is not a number of seconds (at most 3600)` };
  if (opts.timeout !== undefined && !(Number(opts.timeout) > 0 && Number(opts.timeout) * 60000 <= MAX_TIMEOUT_MS)) return { problem: `--timeout-minutes ${opts.timeout} is not a number of minutes` };
  return { ...opts, url: base.url };
}

// The options of a `spec-relay-e2e ...` command line, or { problem }.
export function e2eCommandOptions(command) {
  const argv = words(String(command).trim().slice(E2E_COMMAND.length));
  return argv ? parseE2eOptions(argv, 'port') : { problem: `an unclosed quote in \`${command}\`` };
}

// --- files -----------------------------------------------------------------------

function listFiles(dir, rel = '') {
  let entries = [];
  try { entries = fs.readdirSync(path.join(dir, rel), { withFileTypes: true }); } catch { return []; }
  const out = [];
  for (const e of entries) {
    const child = rel ? `${rel}/${e.name}` : e.name;
    if (e.isDirectory()) { if (!SKIP_DIRS.has(e.name)) out.push(...listFiles(dir, child)); } else if (e.isFile()) out.push(child);
  }
  return out.sort();
}

// The hash of everything under tests/e2e/ but installed packages: the tests,
// their helpers and settings, and the screenshots taken from the old system.
// Text is read with CRLF as LF, so a Windows checkout hashes the same.
// { sha256, files: { path: sha256 }, screenshots } (screenshots of one capability).
export function e2eDigest(target, capability) {
  const dir = path.join(target, E2E_DIR);
  const files = {};
  for (const f of listFiles(dir)) {
    let bytes;
    try { bytes = fs.readFileSync(path.join(dir, f)); } catch { continue; }
    const text = !bytes.includes(0) && !/\.(png|jpe?g|gif|webp)$/i.test(f);
    files[f] = crypto.createHash('sha256').update(text ? Buffer.from(bytes.toString('utf8').replace(/^﻿/, '').replace(/\r\n?/g, '\n')) : bytes).digest('hex');
  }
  const hash = crypto.createHash('sha256');
  for (const f of Object.keys(files)) hash.update(`${f}\0${files[f]}\n`);
  const own = `${capabilityFolder(capability ?? '')}/screenshots/`;
  return { sha256: hash.digest('hex'), files, screenshots: Object.keys(files).filter((f) => f.startsWith(own) && /\.png$/i.test(f)).length };
}

// Selectors that name what only one system's markup has. The old and the new
// system keep what a user sees (texts, labels, roles), not their ids and classes.
const SELECTORS = [
  [/\bgetByTestId\s*\(/, 'getByTestId (the old system has no test ids)'],
  [/\blocator\s*\(\s*(['"`])\s*(?:css\s*=\s*)?[#.]/, 'an id or class selector'],
  [/\blocator\s*\(\s*(['"`])[^'"`]*\[\s*(?:id|class|data-test(?:-?id)?)\s*[~|^$*]?=/, 'an id, class or test-id attribute selector'],
  [/\blocator\s*\(\s*(['"`])\s*(?:xpath\s*=|\/\/|\(\s*\/\/)/, 'an XPath selector'],
  [/\.\$\$?\s*\(|\$\$?eval\s*\(/, 'page.$ / $$ / $eval (CSS selectors)'],
];

// The selector problems of a capability's test files, as "file:line: what".
export function selectorProblems(dir) {
  const out = [];
  for (const f of listFiles(dir).filter((file) => TEST_FILE.test(file))) {
    let text = '';
    try { text = fs.readFileSync(path.join(dir, f), 'utf8'); } catch { continue; }
    text.split(/\r?\n/).forEach((line, i) => {
      if (/^\s*(\/\/|\*)/.test(line)) return;
      for (const [pattern, what] of SELECTORS) {
        if (pattern.test(line)) { out.push(`${f}:${i + 1} uses ${what}; find the element as a user does (getByRole, getByLabel, getByText), since the new system's markup differs`); break; }
      }
    });
  }
  return out;
}

// What keeps the tests of a capability from running: { problems, cli, testDir }.
export function setupProblems(target, capability) {
  const dir = path.join(target, E2E_DIR);
  const problems = [];
  const testDir = path.join(dir, capabilityFolder(capability));
  const cli = path.join(dir, 'node_modules', '@playwright', 'test', 'cli.js');
  if (!fs.existsSync(path.join(dir, 'package.json'))) problems.push(`${E2E_DIR}/ has no package.json: run node "<kit>/scripts/e2e.mjs" init, then npm ci in ${E2E_DIR}`);
  else if (!fs.existsSync(cli)) problems.push(`@playwright/test is not installed in ${E2E_DIR}/: run npm ci there`);
  const tests = listFiles(testDir).filter((f) => TEST_FILE.test(f));
  if (!tests.length) problems.push(`no screen tests in ${E2E_DIR}/${capabilityFolder(capability)}/ (files named *.e2e.mjs)`);
  problems.push(...selectorProblems(testDir));
  return { problems, cli, testDir };
}

// --- running Playwright -----------------------------------------------------------

const ANSI = /\u001b\[[0-9;]*m/g;

// The tests of a JSON report: [{ title, file, line, project, passed, status, error }].
export function reportTests(report) {
  const out = [];
  const visit = (suite) => {
    for (const spec of suite.specs ?? []) {
      for (const t of spec.tests ?? []) {
        const results = t.results ?? [];
        const last = results[results.length - 1];
        const error = last?.error?.message ?? last?.errors?.[0]?.message ?? '';
        out.push({
          title: spec.title, file: (spec.file ?? '').replace(/\\/g, '/'), line: spec.line, project: t.projectName ?? '',
          passed: t.status === 'expected' && results.length === 1 && last?.status === 'passed',
          status: last?.status ?? t.status ?? 'unknown',
          error: error.replace(ANSI, '').split('\n').filter((l) => l.trim()).slice(0, 6).join('\n'),
        });
      }
    }
    for (const child of suite.suites ?? []) visit(child);
  };
  for (const suite of report.suites ?? []) visit(suite);
  return out;
}

// Runs the capability's tests against base: { exitCode, timedOut, seconds,
// output, tests, problems, results }. `update` is 'all' for the old run (the
// screenshots are taken), 'none' for the new one.
export async function runSuite({ root, target, capability, base, side, update, timeoutMs, run = runCommand }) {
  const { problems, cli, testDir } = setupProblems(target, capability);
  if (problems.length) return { exitCode: 1, timedOut: false, seconds: 0, output: '', tests: [], problems };
  ignoreLocal(root);
  const results = path.join(root, 'openspec/spec-relay/local/e2e', capabilityFolder(capability), side);
  fs.rmSync(results, { recursive: true, force: true });
  fs.mkdirSync(results, { recursive: true });
  const reportFile = path.join(results, 'report.json');
  const env = {
    SPEC_RELAY_SIDE: side,
    SPEC_RELAY_BASE_URL: base.href.replace(/\/$/, ''),
    SPEC_RELAY_E2E_TEST_DIR: testDir,
    SPEC_RELAY_E2E_USER_CONFIG: path.join(target, E2E_DIR, 'playwright.config.mjs'),
    SPEC_RELAY_E2E_OUTPUT_DIR: path.join(results, 'results'),
    SPEC_RELAY_E2E_REPORT: reportFile,
    SPEC_RELAY_E2E_UPDATE: update,
  };
  const argv = [process.execPath, cli, 'test', '--config', path.join(KIT, 'scripts', 'e2e-config.mjs'), '--workers=1', '--retries=0', '--forbid-only', `--update-snapshots=${update}`];
  const ran = await run(argv, path.join(target, E2E_DIR), { timeoutMs, env });
  let report = null;
  try { report = JSON.parse(fs.readFileSync(reportFile, 'utf8')); } catch { /* reported below */ }
  if (!report) {
    return { exitCode: ran.exitCode || 1, timedOut: ran.timedOut, seconds: ran.seconds, output: ran.output, tests: [], problems: [`Playwright wrote no report (${ran.timedOut ? 'timed out' : `exit code ${ran.exitCode}`}); its output is below`] };
  }
  const tests = reportTests(report);
  const out = [];
  for (const e of report.errors ?? []) out.push(`Playwright: ${String(e.message ?? e).replace(ANSI, '').split('\n')[0]}`);
  if ((report.config?.projects ?? []).length > 1) out.push('more than one Playwright project ran; keep one browser in tests/e2e/playwright.config.mjs');
  return { exitCode: ran.exitCode, timedOut: ran.timedOut, seconds: ran.seconds, output: ran.output, tests, problems: out, results: path.relative(root, results).split(path.sep).join('/') };
}

// What is wrong with the tests of a run, for the scenarios of the baseline spec.
export function testProblems(tests, capability, scenarios) {
  const problems = [];
  if (!tests.length) problems.push('no test ran');
  for (const t of tests) {
    const tag = titleTag(t.title);
    const where = `${t.file}:${t.line}`;
    if (!tag) problems.push(`${where} "${t.title}": a screen test's title is the tag of its scenario (spec-relay: ${capability} | <requirement> | <scenario>)`);
    else if (!scenarios.some((s) => tagMatches(tag, capability, s))) problems.push(`${where} "${t.title}" names no scenario of the baseline of ${capability}`);
  }
  return problems;
}

const failures = (tests) => tests.filter((t) => !t.passed).slice(0, SHOW).map((t) => `${t.file}:${t.line} "${t.title}": ${t.status}${t.error ? `\n    ${t.error.replace(/\n/g, '\n    ')}` : ''}`);

// --- the old run --------------------------------------------------------------------

function spec(root, capability) {
  return scenarioList(readIf(path.join(root, 'openspec/specs', ...capability.split('/'), 'spec.md'), []) ?? '');
}

// Runs the tests against the running old system and writes the receipt:
// { ok, problems, lines }.
export async function recordOld(root, opts, { run = runCommand, send = fetch } = {}) {
  const dir = path.join(root, 'openspec/changes', opts.change);
  const fail = (problems, lines = []) => ({ ok: false, problems, lines });
  if (!fs.existsSync(dir)) return fail([`change not found: ${opts.change}`]);
  if (changeSchema(dir) !== 'spec-relay-port') return fail([`${opts.change} is not a port change (schema spec-relay-port)`]);
  const capability = portCapability(root, opts.change);
  if (!capability) return fail(['proposal.md records no baseline hash for this change\'s own capability; add it with gate.mjs baseline']);
  const target = targetDir(root);
  if (!target) return fail(['openspec/config.yaml names no target root ("Target root ...:")']);
  const scenarios = spec(root, capability);
  if (!scenarios.length) return fail([`the baseline spec of ${capability} has no scenarios`]);
  const setup = setupProblems(target, capability);
  if (setup.problems.length) return fail(setup.problems);
  if (!await answers(opts.url, send)) return fail([`nothing answers at ${opts.url.origin}: ask the person to start the test copy of the old system there (verification.md says how)`]);
  const timeoutMs = Number(opts.timeout ?? 60) * 60000;
  if (opts.reset) {
    const reset = await run(opts.reset, target, { timeoutMs });
    if (reset.exitCode !== 0) return fail([`the --reset command failed (${reset.timedOut ? 'timed out' : `exit code ${reset.exitCode}`}): ${opts.reset}`], [reset.output.trim().split('\n').slice(-20).join('\n')]);
  }
  const ran = await runSuite({ root, target, capability, base: opts.url, side: 'old', update: 'all', timeoutMs, run });
  const problems = [...ran.problems, ...testProblems(ran.tests, capability, scenarios)];
  const failed = failures(ran.tests);
  const receiptFile = path.join(dir, OLD_RECEIPT);
  if (problems.length || failed.length || ran.exitCode !== 0) {
    // A receipt of an earlier run would no longer match the screenshots this run rewrote.
    fs.rmSync(receiptFile, { force: true });
    const lines = failed.length ? ['failed on the old system (a test that fails on the old system is wrong, not the old system):', ...failed] : [];
    if (!ran.tests.length && ran.output) lines.push(ran.output.trim().split('\n').slice(-30).join('\n'));
    if (ran.results) lines.push(`details: ${ran.results}/results`);
    return fail(problems.length ? problems : [`${failed.length || 'some'} of ${ran.tests.length} tests did not pass on the old system`], lines);
  }
  const digest = e2eDigest(target, capability);
  const receipt = {
    kit: 'spec-relay', version: kitVersion(), change: opts.change, capability, ranAt: new Date().toISOString(), side: 'old', origin: opts.url.origin,
    sha256: digest.sha256, files: digest.files, screenshots: digest.screenshots,
    tests: ran.tests.map((t) => ({ title: t.title, file: t.file, project: t.project })),
  };
  fs.writeFileSync(receiptFile, `${JSON.stringify(receipt, null, 2)}\n`);
  const titles = new Set(ran.tests.map((t) => t.title));
  return { ok: true, problems: [], lines: [`e2e: ${ran.tests.length} tests passed on the old system at ${opts.url.origin} (${titles.size} scenarios, ${digest.screenshots} screenshots taken), recorded in openspec/changes/${opts.change}/${OLD_RECEIPT}`] };
}

// --- the new run --------------------------------------------------------------------

// The old run of a capability: the active port's receipt, else the newest
// archived port's. { receipt, file } or { problem }.
export function oldReceipt(root, capability, change = null) {
  const folder = capabilityFolder(capability);
  const candidates = [];
  if (change) candidates.push(path.join(root, 'openspec/changes', change));
  else {
    const changes = path.join(root, 'openspec/changes');
    try { for (const e of fs.readdirSync(changes)) if (e === `port-${folder}` || new RegExp(`^port-${folder}-v\\d+$`).test(e)) candidates.push(path.join(changes, e)); } catch { /* none */ }
    try {
      const archived = fs.readdirSync(path.join(changes, 'archive')).filter((e) => new RegExp(`^\\d{4}-\\d{2}-\\d{2}-port-${folder}(-v\\d+)?$`).test(e)).sort().reverse();
      candidates.push(...archived.map((e) => path.join(changes, 'archive', e)));
    } catch { /* none */ }
  }
  const again = `run node "<kit>/scripts/e2e.mjs" old --change ${change ?? `port-${folder}`} --base <old system> with the old system running`;
  for (const dir of candidates) {
    const file = path.join(dir, OLD_RECEIPT);
    if (!fs.existsSync(file)) continue;
    let receipt = null;
    try { receipt = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { /* below */ }
    const valid = receipt && typeof receipt === 'object' && typeof receipt.sha256 === 'string' && Array.isArray(receipt.tests) && receipt.tests.every((t) => t && typeof t.title === 'string');
    if (!valid || receipt.capability !== capability) return { problem: `${path.relative(root, file).split(path.sep).join('/')} is not an old run of ${capability}: ${again}` };
    return { receipt, file: path.relative(root, file).split(path.sep).join('/') };
  }
  return { problem: `the screen tests never passed on the old system (no ${OLD_RECEIPT}): ${again}` };
}

const testKey = (t) => `${t.file}\0${t.title}\0${t.project ?? ''}`;

// Runs the tests against the new system, after checking they are the tests that
// passed on the old one: { exitCode, timedOut, seconds, output, e2e }.
export async function runNew(root, opts, { change = null, capability, timeoutMs, run = runCommand, send = fetch, platform = process.platform } = {}) {
  const started = Date.now();
  const done = (exitCode, lines, extra = {}) => ({ exitCode, timedOut: false, seconds: Math.round((Date.now() - started) / 100) / 10, output: lines.join('\n'), ...extra });
  const target = targetDir(root);
  if (!target) return done(1, ['e2e: openspec/config.yaml names no target root']);
  const old = oldReceipt(root, capability, change);
  if (old.problem) return done(1, [`e2e: ${old.problem}`]);
  const digest = e2eDigest(target, capability);
  if (digest.sha256 !== old.receipt.sha256) {
    const before = old.receipt.files && typeof old.receipt.files === 'object' ? old.receipt.files : {};
    const changed = [...new Set([...Object.keys(before), ...Object.keys(digest.files)])].filter((f) => before[f] !== digest.files[f]).sort();
    return done(1, [`e2e: ${E2E_DIR}/ changed after the tests passed on the old system (${changed.slice(0, 10).join(', ')}${changed.length > 10 ? ', ...' : ''}): run e2e.mjs old again with the old system running, so every test is proven on the old system first`]);
  }
  const setup = setupProblems(target, capability);
  if (setup.problems.length) return done(1, setup.problems.map((p) => `e2e: ${p}`));
  const limit = timeoutMs ?? Number(opts.timeout ?? 60) * 60000;
  if (opts.reset) {
    const reset = await run(opts.reset, target, { timeoutMs: limit });
    if (reset.exitCode !== 0) return done(1, [`e2e: the --reset command failed (${reset.timedOut ? 'timed out' : `exit code ${reset.exitCode}`}): ${opts.reset}`, reset.output.trim().split('\n').slice(-20).join('\n')], { timedOut: reset.timedOut });
  }
  const system = await startSystem(opts.start, target, opts.url, { waitMs: Number(opts.wait ?? 60) * 1000, platform, send });
  if (system.problem) return done(1, [`e2e: ${system.problem}`, system.output ?? ''].filter(Boolean));
  let ran;
  let survives = false;
  try {
    ran = await runSuite({ root, target, capability, base: opts.url, side: 'new', update: 'none', timeoutMs: Math.max(1000, limit - (Date.now() - started)), run });
  } finally { survives = await system.stop(); }
  const lines = [];
  const problems = [...ran.problems];
  if (survives) problems.push(`${opts.url.origin} still answers after the --start command was stopped (it started the system outside its own process tree); use a command that runs the system in the foreground, and stop the one that is running`);
  const oldKeys = new Set(old.receipt.tests.map(testKey));
  const newKeys = new Set(ran.tests.map(testKey));
  const missing = old.receipt.tests.filter((t) => !newKeys.has(testKey(t)));
  const extra = ran.tests.filter((t) => !oldKeys.has(testKey(t)));
  for (const t of missing.slice(0, SHOW)) problems.push(`"${t.title}" (${t.file}) passed on the old system but did not run on the new one`);
  for (const t of extra.slice(0, SHOW)) problems.push(`"${t.title}" (${t.file}) ran on the new system but not in the old run`);
  const failed = failures(ran.tests);
  const passed = ran.tests.filter((t) => t.passed).length;
  lines.push(`e2e: ${ran.tests.length} tests, ${passed} passed on the new system at ${opts.url.origin} (the same tests passed on the old system on ${old.receipt.ranAt ?? 'an earlier run'}; ${digest.screenshots} screenshots from it)`);
  for (const p of problems) lines.push(`problem: ${p}`);
  if (failed.length) lines.push('failed on the new system (fix the new code, never the test or the screenshots):', ...failed);
  if (ran.results && (failed.length || problems.length)) lines.push(`details and screenshot differences: ${ran.results}/results`);
  if (!ran.tests.length && ran.output) lines.push(ran.output.trim().split('\n').slice(-30).join('\n'));
  const ok = !problems.length && !failed.length && ran.tests.length > 0 && ran.exitCode === 0;
  return {
    exitCode: ok ? 0 : ran.timedOut ? -1 : 1, timedOut: ran.timedOut, seconds: Math.round((Date.now() - started) / 100) / 10, output: lines.join('\n'),
    e2e: { sha256: digest.sha256, tests: ran.tests.length, passed, titles: [...new Set(ran.tests.filter((t) => t.passed).map((t) => t.title))], screenshots: digest.screenshots, oldRanAt: old.receipt.ranAt ?? null },
  };
}

// Runs a `spec-relay-e2e ...` command line of a port, as verify.mjs does for a
// level: { exitCode, timedOut, seconds, output, e2e }.
export async function runE2eCommand(command, cwd, { timeoutMs, root, change, capability, run, send } = {}) {
  const opts = e2eCommandOptions(command);
  if (opts.problem) return { exitCode: 2, timedOut: false, seconds: 0, output: `e2e: ${opts.problem}` };
  if (!root || !capability) return { exitCode: 2, timedOut: false, seconds: 0, output: 'e2e: a spec-relay-e2e command runs in a port\'s verify run (verify.mjs)' };
  return runNew(root, opts, { change, capability, timeoutMs, ...(run ? { run } : {}), ...(send ? { send } : {}) });
}

// --- init -------------------------------------------------------------------------------

const TEMPLATE = path.join(KIT, 'templates', 'e2e');

// Copies the template into the target root's tests/e2e/ (never over a file).
export function init(root) {
  const target = targetDir(root);
  if (!target) return { ok: false, problems: ['openspec/config.yaml names no target root ("Target root ...:")'] };
  const dir = path.join(target, E2E_DIR);
  const written = [];
  for (const f of listFiles(TEMPLATE)) {
    const to = path.join(dir, f);
    if (fs.existsSync(to)) continue;
    fs.mkdirSync(path.dirname(to), { recursive: true });
    fs.copyFileSync(path.join(TEMPLATE, f), to);
    written.push(path.relative(root, to).split(path.sep).join('/'));
  }
  return { ok: true, problems: [], written, next: `npm ci in ${path.relative(root, dir).split(path.sep).join('/') || '.'}` };
}

// --- command line -----------------------------------------------------------------------

export async function main(argv) {
  const usage = () => {
    console.error('Usage: node e2e.mjs init [--root DIR]');
    console.error('       node e2e.mjs old --change port-<capability> --base URL [--reset "<command>"] [--allow-host HOST] [--root DIR] [--timeout-minutes N]');
    console.error('       node e2e.mjs new --capability CAP --base URL --start "<command>" [--reset "<command>"] [--wait-seconds N] [--root DIR] [--timeout-minutes N]');
    return 2;
  };
  const [mode, ...rest] = argv;
  if (mode === 'init') {
    if (rest.length && !(rest.length === 2 && rest[0] === '--root')) return usage();
    const result = init(rest[1] ?? process.cwd());
    for (const p of result.problems) console.error(`e2e: ${p}`);
    if (result.ok) console.log(result.written.length ? `e2e: wrote ${result.written.join(', ')}; next: ${result.next}` : `e2e: the screen test folder is already there; next: ${result.next} if node_modules is missing`);
    return result.ok ? 0 : 1;
  }
  if (mode !== 'old' && mode !== 'new') return usage();
  const opts = parseE2eOptions(rest, mode);
  if (opts.problem) { console.error(`e2e: ${opts.problem}`); return usage(); }
  const root = path.resolve(opts.root ?? process.cwd());
  if (!fs.existsSync(path.join(root, 'openspec'))) { console.error(`e2e: no openspec/ folder in ${root}. Run this from the repository root or pass --root DIR.`); return 2; }
  stopAllOnSignal();
  if (mode === 'old') {
    const result = await recordOld(root, opts);
    for (const p of result.problems) console.error(`e2e: ${p}`);
    for (const l of result.lines) (result.ok ? console.log : console.error)(l);
    return result.ok ? 0 : 1;
  }
  const result = await runNew(root, opts, { capability: opts.capability });
  (result.exitCode === 0 ? console.log : console.error)(result.output);
  return result.exitCode === 0 ? 0 : 1;
}

function invokedDirectly() {
  if (!process.argv[1]) return false;
  try { return fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url)); } catch { return false; }
}

if (invokedDirectly()) Promise.resolve(main(process.argv.slice(2))).then((code) => { process.exitCode = code; });
