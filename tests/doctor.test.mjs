import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
  main, parseVersion, compareVersions, telemetryOff, toolchainFor, checkNode, checkOpenspec,
  checkGit, checkTarget, checkClient, checkPowershell, TRIAL_RECORD, TRIAL_DIR, KIT_ROOT,
} from '../scripts/doctor.mjs';
import { main as setup } from '../scripts/setup.mjs';
import { findCommand } from '../scripts/openspec.mjs';
import { tempDir, write, quiet, isolateOpenspec, crlf } from './helpers.mjs';

isolateOpenspec();

const en = { lang: 'en', t: (ja, english) => english };
const ja = { lang: 'ja', t: (japanese) => japanese };

// A machine where every tool is present and current, unless a test says otherwise.
const tools = (answers = {}) => (name, args) => {
  const key = `${name} ${args.join(' ')}`;
  if (key in answers) return answers[key];
  const defaults = {
    'git --version': { found: true, status: 0, stdout: 'git version 2.47.0\n' },
    'git rev-parse --show-toplevel': { found: true, status: 0, stdout: '' },
    'git status --porcelain': { found: true, status: 0, stdout: '' },
    'copilot --version': { found: true, status: 0, stdout: 'GitHub Copilot CLI 1.0.109\n' },
    'npm --version': { found: true, status: 0, stdout: '10.9.0\n' },
  };
  return defaults[key] || { found: false, status: null, stdout: '', stderr: '' };
};

function machine(dir, extra = {}) {
  return {
    probeOpenspec: () => ({ ok: true, version: '1.17.0' }),
    exec: tools(),
    samePath: () => true,
    machine: 'test-machine',
    ...extra,
  };
}

// Runs doctor and returns its exit code and parsed JSON (or text).
async function doctor(argv, overrides) {
  const out = [];
  const { log, error } = console;
  console.log = (line) => out.push(String(line)); console.error = (line) => out.push(String(line));
  try {
    const code = await main(argv, overrides);
    const text = out.join('\n');
    let json = null;
    try { json = JSON.parse(text); } catch { /* text output */ }
    return { code, text, json };
  } finally { console.log = log; console.error = error; }
}

const byId = (json, id) => json.checks.find((c) => c.id === id);
const SETUP = ['--source-language', 'C#', '--target-language', 'TypeScript', '--source-root', 'src', '--target-root', 'ts', '--skip-init', '--apply'];

function setUpRepo(args = SETUP) {
  const dir = tempDir();
  write(dir, 'src/Invoice.cs', 'class Invoice {}\n');
  assert.equal(quiet(() => setup(['--target', dir, ...args])), 0);
  return dir;
}

test('versions compare numerically', () => {
  assert.deepEqual(parseVersion('v22.12.0'), [22, 12, 0]);
  assert.deepEqual(parseVersion('GitHub Copilot CLI 1.0.109.'), [1, 0, 109]);
  assert.deepEqual(parseVersion('1.143'), [1, 143, 0]);
  assert.equal(parseVersion('none'), null);
  assert.equal(compareVersions('1.0.99', '1.0.109'), -1);
  assert.equal(compareVersions('22.12.0', 'v22.12.0'), 0);
  assert.equal(compareVersions('24.0.0', '22.12.0'), 1);
});

test('an old Node.js gets one clear failure, before any other module loads', async () => {
  assert.equal(checkNode({ ...en, nodeVersion: 'v22.11.0' }).level, 'fail');
  assert.equal(checkNode({ ...en, nodeVersion: 'v22.12.0' }).level, 'ok');
  const { code, json } = await doctor(['--target', tempDir(), '--json', '--lang', 'en'], { nodeVersion: 'v18.19.0' });
  assert.equal(code, 1);
  assert.deepEqual(json.checks.map((c) => c.id), ['node']);
  assert.match(json.checks[0].fix, /winget install OpenJS\.NodeJS\.LTS/);
});

test('doctor.mjs uses no syntax newer than Node.js 14 reads', () => {
  const text = fs.readFileSync(path.join(KIT_ROOT, 'scripts/doctor.mjs'), 'utf8');
  for (const newer of [/\?\?=/, /\|\|=/, /&&=/, /\.replaceAll\(/, /\.at\(/, /Object\.hasOwn/, /^await /m, /\bstatic \{/, /#[a-z]\w*\s*[=;(]/]) {
    assert.doesNotMatch(text, newer);
  }
  // The modules that need Node.js 22 are loaded only after the check.
  assert.doesNotMatch(text, /^import .* from '\.\/(setup|gate|openspec)\.mjs'/m);
});

test('a fresh machine and folder: ready, with what is still to do', async () => {
  const dir = tempDir();
  const { code, json } = await doctor(['--target', dir, '--client', 'cli', '--json', '--lang', 'en'], machine(dir));
  assert.equal(code, 0, JSON.stringify(json, null, 2));
  assert.equal(json.ok, true);
  for (const id of ['node', 'kit', 'openspec', 'client', 'git', 'git-repo', 'target']) assert.equal(byId(json, id).level, 'ok', id);
  assert.equal(byId(json, 'setup').level, 'info');
  // The test environment turns telemetry off.
  assert.equal(byId(json, 'telemetry').level, 'ok');
  assert.ok(json.checks.every((c) => c.level === 'ok' || c.fix), 'every problem says what to do');
});

test('OpenSpec: missing or older blocks, newer warns', () => {
  const ctx = (probe) => ({ ...en, target: '.', probeOpenspec: () => probe });
  assert.equal(checkOpenspec(ctx({ ok: false, reason: 'the openspec CLI was not found. Install it' })).level, 'fail');
  assert.match(checkOpenspec(ctx({ ok: false, reason: 'the openspec CLI was not found.' })).fix, /npm install -g @fission-ai\/openspec@1\.17\.0/);
  assert.equal(checkOpenspec(ctx({ ok: false, reason: '"openspec --version" failed' })).level, 'fail');
  assert.equal(checkOpenspec(ctx({ ok: true, version: '1.16.2' })).level, 'fail');
  assert.equal(checkOpenspec(ctx({ ok: true, version: '1.18.0' })).level, 'warn');
  assert.equal(checkOpenspec(ctx({ ok: true, version: '1.17.0' })).level, 'ok');
});

test('telemetry follows the same opt-outs as OpenSpec', () => {
  const none = () => null;
  assert.equal(telemetryOff({}, 'linux', none), null);
  assert.equal(telemetryOff({ OPENSPEC_TELEMETRY: '0' }, 'linux', none), 'OPENSPEC_TELEMETRY');
  assert.equal(telemetryOff({ OPENSPEC_TELEMETRY: '1' }, 'linux', none), null);
  assert.equal(telemetryOff({ DO_NOT_TRACK: '1' }, 'linux', none), 'DO_NOT_TRACK');
  assert.equal(telemetryOff({ DO_NOT_TRACK: '0' }, 'linux', none), null);
  assert.equal(telemetryOff({ CI: 'true' }, 'linux', none), 'CI');
  const config = (text) => (file) => (file.replace(/\\/g, '/').endsWith('Roaming/openspec/config.json') ? text : null);
  assert.equal(telemetryOff({ APPDATA: 'C:\\Users\\a\\AppData\\Roaming' }, 'win32', config('{"telemetry":{"enabled":false}}')), 'config');
  assert.equal(telemetryOff({ APPDATA: 'C:\\Users\\a\\AppData\\Roaming' }, 'win32', config('{"telemetry":{"noticeSeen":true}}')), null);
});

test('git: missing, refused, not a repository, a subfolder, long paths', () => {
  const ctx = (answers, extra = {}) => ({ ...en, target: '/work/proj', platform: 'linux', exec: tools(answers), samePath: () => true, ...extra });
  assert.equal(checkGit(ctx({ 'git --version': { found: false } }))[0].level, 'warn');
  const refused = checkGit(ctx({ 'git rev-parse --show-toplevel': { found: true, status: 128, stderr: "fatal: detected dubious ownership in repository at '/work/proj'" } }));
  assert.match(refused[1].fix, /safe\.directory/);
  const notRepo = checkGit(ctx({ 'git rev-parse --show-toplevel': { found: true, status: 128, stderr: 'fatal: not a git repository' } }));
  assert.equal(notRepo[1].level, 'warn');
  assert.match(notRepo[1].fix, /git init/);
  assert.equal(checkGit(ctx({}, { samePath: () => false }))[1].level, 'warn');
  assert.equal(checkGit(ctx({ 'git status --porcelain': { found: true, status: 0, stdout: ' M a.cs\n' } }))[1].level, 'info');
  const long = `C:\\${'x'.repeat(120)}`;
  assert.ok(checkGit(ctx({}, { platform: 'win32', target: long })).some((c) => c.id === 'long-paths'));
  assert.ok(!checkGit(ctx({ 'git config --get core.longpaths': { found: true, status: 0, stdout: 'true\n' } }, { platform: 'win32', target: long })).some((c) => c.id === 'long-paths'));
});

test('the folder: must be writable, should not be synchronised', () => {
  const ctx = (extra) => ({ ...en, target: 'C:\\Users\\a\\OneDrive\\proj', env: {}, isDir: () => true, tryWrite: () => null, ...extra });
  assert.equal(checkTarget(ctx({ tryWrite: () => 'EPERM' }))[0].level, 'fail');
  assert.match(checkTarget(ctx({ tryWrite: () => 'EPERM' }))[0].fix, /Controlled folder access/);
  assert.equal(checkTarget(ctx({}))[1].id, 'sync-folder');
  assert.equal(checkTarget(ctx({ target: 'D:\\Sync\\proj', env: { OneDriveCommercial: 'D:\\Sync' } }))[1].id, 'sync-folder');
  assert.equal(checkTarget(ctx({ target: 'C:\\work\\proj' })).length, 1);
  assert.equal(checkTarget(ctx({ isDir: () => false }))[0].level, 'fail');
});

test('a folder that does not exist fails without running tools in it', async () => {
  const missing = path.join(tempDir(), 'nope');
  let ran = false;
  const { code, json } = await doctor(['--target', missing, '--json', '--lang', 'en'], machine(missing, { exec: () => { ran = true; return { found: false }; } }));
  assert.equal(code, 1);
  assert.equal(byId(json, 'target').level, 'fail');
  assert.equal(ran, false);
});

test('clients: Copilot CLI and VS Code versions, nothing to read for the app', () => {
  const ctx = (client, answers = {}, env = {}) => ({ ...en, client, target: '.', env, exec: tools(answers) });
  assert.equal(checkClient(ctx('cli')).level, 'ok');
  assert.equal(checkClient(ctx('cli', { 'copilot --version': { found: true, status: 0, stdout: '1.0.100' } })).level, 'warn');
  assert.equal(checkClient(ctx('cli', { 'copilot --version': { found: false } })).level, 'info');
  assert.equal(checkClient(ctx('vscode', {}, { TERM_PROGRAM: 'vscode', TERM_PROGRAM_VERSION: '1.140.2' })).level, 'warn');
  assert.equal(checkClient(ctx(undefined, {}, { TERM_PROGRAM: 'vscode', TERM_PROGRAM_VERSION: '1.146.0' })).level, 'ok');
  assert.equal(checkClient(ctx('app')).level, 'info');
  assert.equal(checkClient(ctx(undefined)).level, 'info');
});

test('PowerShell: a policy that blocks openspec.ps1 is mentioned, never changed', () => {
  const ctx = (policy, platform = 'win32') => ({ ...ja, platform, findInPath: () => 'C:\\npm\\openspec.ps1', executionPolicy: () => policy });
  assert.match(checkPowershell(ctx('Restricted')).fix, /openspec\.cmd/);
  assert.equal(checkPowershell(ctx('RemoteSigned')), null);
  assert.equal(checkPowershell(ctx('Restricted', 'linux')), null);
});

test('toolchains follow the target language', () => {
  assert.equal(toolchainFor('Java').name, 'JDK');
  assert.equal(toolchainFor('JavaScript').name, 'npm');
  assert.equal(toolchainFor('TypeScript').name, 'npm');
  assert.equal(toolchainFor('Python 3').name, 'Python');
  assert.equal(toolchainFor('C#').name, '.NET SDK');
  assert.equal(toolchainFor('COBOL'), null);
});

test('after setup: schemas, restored workflows, source root, toolchain and the trial', async () => {
  const dir = setUpRepo();
  const run = async (extra) => (await doctor(['--target', dir, '--json', '--lang', 'en'], machine(dir, extra))).json;
  let json = await run();
  assert.equal(byId(json, 'schemas').level, 'ok');
  assert.equal(byId(json, 'toolchain').level, 'ok');
  assert.equal(byId(json, 'trial').level, 'warn');
  assert.equal(json.ok, true);

  // A Windows checkout turns the schemas into CRLF: still the same.
  const schema = path.join(dir, 'openspec/schemas/spec-relay-extract/schema.yaml');
  fs.writeFileSync(schema, crlf(fs.readFileSync(schema, 'utf8')));
  assert.equal(byId(await run(), 'schemas').level, 'ok');
  fs.appendFileSync(schema, '# edited\n');
  json = await run();
  assert.equal(byId(json, 'schemas').level, 'fail');
  assert.equal(json.ok, false);

  write(dir, '.github/skills/openspec-archive-change/SKILL.md', '---\nname: openspec-archive-change\nmetadata:\n  generatedBy: "1.17.0"\n---\nRun openspec archive.\n');
  assert.equal(byId(await run(), 'workflows').level, 'fail');

  fs.rmSync(path.join(dir, 'src'), { recursive: true });
  assert.equal(byId(await run(), 'source-root').level, 'fail');

  assert.equal(byId(await run({ exec: tools({ 'npm --version': { found: false } }) }), 'toolchain').level, 'warn');
});

test('a config from 0.2.0 has no parallel settings', async () => {
  const dir = setUpRepo();
  const file = path.join(dir, 'openspec/config.yaml');
  fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace(/^  Parallel subagents.*\n/m, ''));
  const { json } = await doctor(['--target', dir, '--json', '--lang', 'en'], machine(dir));
  assert.equal(byId(json, 'config').level, 'warn');
});

test('the subagent trial: tasks, check, record, and when to run it again', async () => {
  const dir = setUpRepo([...SETUP, '--checker-model', 'claude-opus-5.5']);
  assert.equal((await doctor(['--target', tempDir(), '--trial'], machine(dir))).code, 1, 'not set up: no trial');

  // A file left by an earlier trial must not count.
  write(dir, `${TRIAL_DIR}/analyst.md`, 'spec-relay trial: analyst\n');
  const plan = await doctor(['--target', dir, '--trial'], machine(dir));
  assert.equal(plan.code, 0);
  assert.equal(fs.existsSync(path.join(dir, TRIAL_DIR)), false);
  const tasks = plan.json.tasks;
  assert.deepEqual(tasks.map((t) => [t.agent, t.model]), [['spec-relay-analyst', 'session'], ['spec-relay-checker', 'claude-opus-5.5'], ['spec-relay-implementer', 'session']]);
  // The implementer writes where it writes during a port.
  assert.equal(tasks[2].file, 'ts/spec-relay-trial.md');
  for (const t of tasks) assert.ok(t.task.startsWith('spec-relay environment trial') && t.task.includes(t.file) && t.task.includes(t.line));

  write(dir, tasks[0].file, `${tasks[0].line}\n`);
  write(dir, tasks[2].file, `${tasks[2].line}\r\n`);
  let check = await doctor(['--target', dir, '--trial-check', '--client', 'cli', '--json', '--lang', 'en'], machine(dir));
  assert.equal(check.code, 1);
  assert.deepEqual(check.json.checks.map((c) => c.level), ['ok', 'fail', 'ok']);
  assert.match(check.json.checks[1].fix, /Checker model/);
  assert.equal(fs.existsSync(path.join(dir, TRIAL_RECORD)), false);

  write(dir, tasks[1].file, `${tasks[1].line}\n`);
  check = await doctor(['--target', dir, '--trial-check', '--client', 'cli', '--json', '--lang', 'en'], machine(dir));
  assert.equal(check.code, 0);
  const record = JSON.parse(fs.readFileSync(path.join(dir, TRIAL_RECORD), 'utf8'));
  assert.deepEqual([record.client, record.machine, record.models.checker], ['cli', 'test-machine', 'claude-opus-5.5']);
  // The trial leaves nothing behind, not even the target root it created.
  assert.equal(fs.existsSync(path.join(dir, TRIAL_DIR)), false);
  assert.equal(fs.existsSync(path.join(dir, 'ts')), false);

  const trial = async (argv, extra) => byId((await doctor(['--target', dir, '--json', '--lang', 'en', ...argv], machine(dir, extra))).json, 'trial').level;
  assert.equal(await trial(['--client', 'cli']), 'ok');
  assert.equal(await trial([]), 'ok');
  assert.equal(await trial(['--client', 'vscode']), 'warn');
  assert.equal(await trial(['--client', 'cli'], { machine: 'other-machine' }), 'warn');
  const config = path.join(dir, 'openspec/config.yaml');
  fs.writeFileSync(config, fs.readFileSync(config, 'utf8').replace('Checker model: claude-opus-5.5', 'Checker model: session'));
  assert.equal(await trial(['--client', 'cli']), 'warn');
});

test('the text report: one line per check and the fix under each problem', async () => {
  const dir = tempDir();
  const { code, text } = await doctor(['--target', dir, '--lang', 'ja'], machine(dir, { probeOpenspec: () => ({ ok: false, reason: 'the openspec CLI was not found.' }) }));
  assert.equal(code, 1);
  assert.match(text, /^FAIL  OpenSpec CLI が見つかりません。$/m);
  assert.match(text, /^ {6}-> `npm install -g @fission-ai\/openspec@1\.17\.0`/m);
  assert.match(text, /止まります: FAIL の 1 件/);
});

test('--json is ASCII only and bad options are usage errors', async () => {
  const dir = tempDir();
  const { text } = await doctor(['--target', dir, '--json', '--lang', 'ja'], machine(dir));
  assert.match(text, /^[\x00-\x7f]*$/);
  assert.match(JSON.parse(text).checks[0].message, /Node\.js/);
  assert.equal((await doctor(['--client', 'jetbrains'])).code, 2);
  assert.equal((await doctor(['--bogus'])).code, 2);
  assert.equal((await doctor(['--lang'])).code, 2);
});

test('on Windows a tool installed by npm runs as node + its script', () => {
  const npm = 'C:\\Users\\Taro Yamada\\AppData\\Roaming\\npm';
  const loader = `${npm}\\node_modules\\@github\\copilot\\npm-loader.js`;
  const find = (files, PATH) => findCommand('copilot', { npmScript: '@github/copilot/npm-loader.js', platform: 'win32', env: { PATH }, exists: (f) => files.includes(f) });
  assert.deepEqual(find([`${npm}\\copilot.cmd`, loader], npm), { command: process.execPath, prefixArgs: [loader] });
  assert.deepEqual(find(['C:\\WinGet\\Links\\copilot.exe'], `C:\\WinGet\\Links;${npm}`), { command: 'C:\\WinGet\\Links\\copilot.exe', prefixArgs: [] });
  assert.equal(find(['.\\copilot.exe'], '.'), null);
});

// The real machine, nothing replaced: in CI (Windows and Ubuntu) every tool the kit needs is installed.
test('the real machine runs every check without an error', async () => {
  const dir = setUpRepo();
  const { code, json } = await doctor(['--target', dir, '--client', 'cli', '--json', '--lang', 'en']);
  assert.ok(json, 'JSON output');
  for (const id of ['node', 'kit', 'target', 'schemas', 'toolchain']) assert.equal(byId(json, id).level, 'ok', `${id}: ${JSON.stringify(byId(json, id))}`);
  if (process.env.CI) {
    assert.equal(byId(json, 'openspec').level, 'ok', JSON.stringify(byId(json, 'openspec')));
    assert.equal(byId(json, 'git').level, 'ok');
    assert.equal(code, 0, JSON.stringify(json.checks.filter((c) => c.level === 'fail')));
  }
});
