import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import {
  main, parseVersion, compareVersions, telemetryOff, checkTelemetry, toolchainFor, checkNode, checkOpenspec,
  checkGit, checkTarget, checkClient, checkPowershell, TRIAL_RECORD, TRIAL_DIR, KIT_ROOT, OPENSPEC_TESTED,
} from '../scripts/doctor.mjs';
import { main as setup } from '../scripts/setup.mjs';
import { findCommand, openspecEnv } from '../scripts/openspec.mjs';
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
    probeOpenspec: () => ({ ok: true, version: OPENSPEC_TESTED }),
    exec: tools(),
    // An empty home folder: no personal OpenSpec skills.
    home: tempDir('spec-relay-home-'),
    samePath: () => true,
    machine: 'test-machine',
    // No PowerShell processes per test on Windows CI.
    executionPolicy: () => [],
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
  // OpenSpec 2.1 (and its skills package) need 22.20.0.
  for (const version of ['v22.11.0', 'v22.12.0', 'v22.19.9']) assert.equal(checkNode({ ...en, nodeVersion: version }).level, 'fail', version);
  // Its @inquirer packages ask for ^22.13.0 || >=23.5.0.
  for (const [version, level] of [['v22.20.0', 'ok'], ['v22.23.5', 'ok'], ['v23.4.0', 'warn'], ['v23.5.0', 'ok'], ['v24.0.0', 'ok'], ['v25.1.0', 'ok'], ['v26.0.0', 'ok']]) {
    assert.equal(checkNode({ ...en, nodeVersion: version }).level, level, version);
  }
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

test('OpenSpec: npm before setup, the pinned version after it', () => {
  // Before setup only npm is needed; setup installs OpenSpec into the repository.
  const before = (answers) => checkOpenspec({ ...en, target: '.', setUp: false, exec: tools(answers), probeOpenspec: () => { throw new Error('not probed before setup'); } });
  assert.equal(before({}).level, 'ok');
  assert.match(before({}).message, new RegExp(`installs OpenSpec ${OPENSPEC_TESTED.replace(/\./g, '\\.')} into this repository`));
  const noNpm = before({ 'npm --version': { found: false } });
  assert.equal(noNpm.level, 'fail');
  assert.match(noNpm.fix, /winget install OpenJS\.NodeJS\.LTS/);
  assert.equal(before({ 'npm --version': { found: true, status: 1, stdout: '' } }).level, 'fail');

  const after = (probe) => checkOpenspec({ ...en, target: '.', setUp: true, probeOpenspec: () => probe });
  assert.equal(after({ ok: true, version: OPENSPEC_TESTED }).level, 'ok');
  // Any other version is not what the kit pins: someone changed the package files.
  for (const version of ['1.17.0', '2.0.1', '3.0.0']) {
    const other = after({ ok: true, version });
    assert.equal(other.level, 'fail', version);
    assert.match(other.fix, /setup again/);
  }
  // Right after a clone: pinned, not installed.
  const clone = after({ ok: false, notInstalled: true, pinned: true, reason: 'x' });
  assert.equal(clone.level, 'fail');
  assert.match(clone.message, /right after a clone/);
  assert.match(clone.fix, /npm ci/);
  // A repository set up with 0.6.0 has no pinned OpenSpec.
  assert.match(after({ ok: false, notInstalled: true, pinned: false, reason: 'x' }).fix, /0\.6\.0/);
  assert.equal(after({ ok: false, reason: 'does not run' }).level, 'fail');
  assert.equal(after({ ok: true, version: 'garbage' }).level, 'warn');
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

test('the kit runs OpenSpec with telemetry off unless the person set OPENSPEC_TELEMETRY', () => {
  assert.equal(openspecEnv({ PATH: 'x' }).OPENSPEC_TELEMETRY, '0');
  assert.equal(openspecEnv({ PATH: 'x' }).OPENSPEC_NO_UPDATE_CHECK, '1');
  assert.equal(openspecEnv({ OPENSPEC_TELEMETRY: '1' }).OPENSPEC_TELEMETRY, '1');
  // Windows names are case-insensitive: a person's own value is kept, not doubled.
  const mixed = openspecEnv({ OpenSpec_Telemetry: '1' }, 'win32');
  assert.equal(mixed.OpenSpec_Telemetry, '1');
  assert.equal(mixed.OPENSPEC_TELEMETRY, undefined);
  // Elsewhere OpenSpec reads only the upper-case name, so the kit default still applies.
  assert.equal(openspecEnv({ openspec_telemetry: '1' }, 'linux').OPENSPEC_TELEMETRY, '0');
  const none = () => null;
  const check = (env) => checkTelemetry({ ...en, env, platform: 'linux', readFile: none });
  assert.equal(check({}).level, 'ok');
  assert.match(check({}).message, /by default/);
  assert.equal(check({ OPENSPEC_TELEMETRY: '0' }).level, 'ok');
  assert.equal(check({ OPENSPEC_TELEMETRY: '1' }).level, 'info');
  assert.equal(check({ OPENSPEC_TELEMETRY: '1', DO_NOT_TRACK: '1' }).level, 'ok');
  assert.match(check({ openspec_telemetry: '1' }).message, /by default/);
  const win = (env) => checkTelemetry({ ...en, env, platform: 'win32', readFile: none });
  assert.equal(win({ OpenSpec_Telemetry: '1' }).level, 'info');
  assert.match(win({}).message, /by default/);
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

test('PowerShell: a policy that blocks npm.ps1 is mentioned, never changed', () => {
  const ctx = (policies, platform = 'win32') => ({ ...ja, platform, findInPath: () => 'C:\\Program Files\\nodejs\\npm.ps1', executionPolicy: () => policies });
  const both = checkPowershell(ctx([{ shell: 'PowerShell 7', policy: 'RemoteSigned' }, { shell: 'Windows PowerShell', policy: 'Restricted' }]));
  assert.match(both.fix, /npm\.cmd/);
  assert.match(both.message, /Windows PowerShell Restricted/);
  assert.doesNotMatch(both.message, /PowerShell 7/);
  assert.equal(checkPowershell(ctx([{ shell: 'PowerShell 7', policy: 'RemoteSigned' }])), null);
  assert.equal(checkPowershell(ctx([])), null);
  assert.equal(checkPowershell(ctx([{ shell: 'Windows PowerShell', policy: 'Restricted' }], 'linux')), null);
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

  write(dir, '.agents/skills/openspec-archive-change/SKILL.md', '---\nname: openspec-archive-change\nmetadata:\n  generatedBy: "2.0.0"\n---\nRun openspec archive.\n');
  assert.equal(byId(await run(), 'workflows').level, 'fail');
  assert.equal(byId(await run(), 'legacy'), undefined);
  write(dir, '.github/prompts/opsx-apply.prompt.md', 'Run openspec instructions apply\n');
  assert.equal(byId(await run(), 'legacy').level, 'fail');
  fs.rmSync(path.join(dir, '.github/prompts'), { recursive: true });

  fs.rmSync(path.join(dir, 'src'), { recursive: true });
  assert.equal(byId(await run(), 'source-root').level, 'fail');

  assert.equal(byId(await run({ exec: tools({ 'npm --version': { found: false } }) }), 'toolchain').level, 'warn');
});

test('the skills stay in the repository: skillsScope, and OpenSpec skills in the home folder', async () => {
  const dir = setUpRepo();
  const file = path.join(dir, 'openspec/config.yaml');
  const home = tempDir('spec-relay-home-');
  const run = async () => (await doctor(['--target', dir, '--json', '--lang', 'en'], machine(dir, { home }))).json;
  let json = await run();
  assert.equal(byId(json, 'skills-scope'), undefined);
  assert.equal(byId(json, 'personal-skills'), undefined);

  // Set up with 0.21.0 or earlier: no skillsScope line.
  const config = fs.readFileSync(file, 'utf8');
  fs.writeFileSync(file, config.replace(/^skillsScope:.*\n/m, ''));
  json = await run();
  assert.equal(byId(json, 'skills-scope').level, 'fail');
  assert.match(byId(json, 'skills-scope').fix, /setup\.mjs/);
  assert.equal(json.ok, false);
  fs.writeFileSync(file, config.replace(/^skillsScope:.*$/m, 'skillsScope: global'));
  assert.match(byId(await run(), 'skills-scope').message, /is global/);
  fs.writeFileSync(file, crlf(config.replace(/^skillsScope:.*$/m, "skillsScope: 'project' # kept")));
  assert.equal(byId(await run(), 'skills-scope'), undefined);
  fs.writeFileSync(file, config);

  // `openspec init` in another project (2.1 default) left live skills in the home folder.
  write(home, '.agents/skills/openspec-archive-change/SKILL.md', '---\nname: openspec-archive-change\nmetadata:\n  generatedBy: "2.1.1"\n---\nRun openspec archive.\n');
  write(home, '.copilot/skills/openspec-apply-change/SKILL.md', '---\nname: openspec-apply-change\nmetadata:\n  generatedBy: "2.1.1"\n---\n');
  write(home, '.agents/skills/my-own-skill/SKILL.md', '---\nname: my-own-skill\n---\n');
  json = await run();
  const personal = byId(json, 'personal-skills');
  assert.equal(personal.level, 'warn');
  assert.match(personal.message, /openspec-archive-change, openspec-apply-change/);
  assert.doesNotMatch(personal.message, /my-own-skill/);
  assert.match(personal.fix, /Hook enforcement/);
  assert.equal(json.ok, true, 'a warning, not a failure');
  // With the hooks on, the gate still stops an archive.
  fs.writeFileSync(file, config.replace(/^(\s*Hook enforcement[^:\n]*:[ \t]*)off/m, '$1on'));
  assert.equal(byId(await run(), 'personal-skills').level, 'info');
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
  assert.equal(fs.existsSync(path.join(dir, `${TRIAL_DIR}/analyst.md`)), false);
  const tasks = plan.json.tasks;
  assert.deepEqual(tasks.map((t) => [t.agent, t.model]), [['spec-relay-analyst', 'session'], ['spec-relay-checker', 'claude-opus-5.5'], ['spec-relay-implementer', 'session']]);
  // The implementer writes where it writes during a port, and runs a command.
  assert.equal(tasks[2].file, 'ts/spec-relay-trial.md');
  assert.match(tasks[2].task, /node --version/);
  for (const t of tasks) assert.ok(t.task.startsWith('spec-relay environment trial') && t.task.includes(t.file) && t.task.includes(t.line));

  const check = (client = 'cli', extra) => doctor(['--target', dir, '--trial-check', '--client', client, '--json', '--lang', 'en'], machine(dir, extra));
  write(dir, tasks[0].file, `${tasks[0].line}\n`);
  write(dir, tasks[2].file, `${tasks[2].line}\r\n`);
  let result = await check();
  assert.equal(result.code, 1);
  assert.deepEqual(result.json.checks.map((c) => c.level), ['ok', 'fail', 'fail']);
  assert.match(result.json.checks[1].fix, /Checker model/);
  assert.match(result.json.checks[2].message, /node --version/);
  assert.equal(fs.existsSync(path.join(dir, TRIAL_RECORD)), false);
  // A failed trial is cleaned up too; the next one starts with --trial.
  assert.equal(fs.existsSync(path.join(dir, 'ts')), false);

  await doctor(['--target', dir, '--trial'], machine(dir));
  write(dir, tasks[0].file, `${tasks[0].line}\n`);
  write(dir, tasks[1].file, `${tasks[1].line}\n`);
  write(dir, tasks[2].file, `${tasks[2].line}\r\nv22.12.0\r\n`);
  result = await check();
  assert.equal(result.code, 0, JSON.stringify(result.json));
  const runs = JSON.parse(fs.readFileSync(path.join(dir, TRIAL_RECORD), 'utf8')).runs;
  assert.deepEqual(Object.keys(runs), ['test-machine/cli']);
  assert.equal(runs['test-machine/cli'].models.checker, 'claude-opus-5.5');
  assert.equal(fs.readFileSync(path.join(dir, path.dirname(TRIAL_RECORD), '.gitignore'), 'utf8').trim().split('\n').pop(), '*');
  // The trial leaves nothing behind, not even the target root it created.
  assert.equal(fs.existsSync(path.join(dir, TRIAL_DIR)), false);
  assert.equal(fs.existsSync(path.join(dir, 'ts')), false);
  // Checking again (after a compaction, say) still passes.
  assert.equal((await check()).code, 0);

  const trial = async (argv, extra) => byId((await doctor(['--target', dir, '--json', '--lang', 'en', ...argv], machine(dir, extra))).json, 'trial').level;
  assert.equal(await trial(['--client', 'cli']), 'ok');
  assert.equal(await trial([]), 'ok');
  assert.equal(await trial(['--client', 'vscode']), 'warn');
  assert.equal(await trial(['--client', 'cli'], { machine: 'other-machine' }), 'warn');
  // A second client on the same machine keeps the first one's result.
  await doctor(['--target', dir, '--trial'], machine(dir));
  for (const t of tasks) write(dir, t.file, `${t.line}\nv24.1.0\n`);
  assert.equal((await check('vscode')).code, 0);
  assert.equal(await trial(['--client', 'vscode']), 'ok');
  assert.equal(await trial(['--client', 'cli']), 'ok');
  // Leftovers of an unfinished trial ask for the check.
  await doctor(['--target', dir, '--trial'], machine(dir));
  assert.equal(await trial(['--client', 'cli']), 'warn');
  await check();
  const config = path.join(dir, 'openspec/config.yaml');
  fs.writeFileSync(config, fs.readFileSync(config, 'utf8').replace('Checker model: claude-opus-5.5', 'Checker model: session'));
  assert.equal(await trial(['--client', 'cli']), 'warn');
});

test('the trial removes only the folders it created', async () => {
  const dir = setUpRepo(['--source-language', 'PHP', '--target-language', 'Java', '--target-root', 'apps/new', '--skip-init', '--apply']);
  const java = { 'java -version': { found: true, status: 0, stderr: 'openjdk version "21.0.2"' }, 'javac -version': { found: true, status: 0, stdout: 'javac 21.0.2' } };
  const plan = await doctor(['--target', dir, '--trial'], machine(dir, { exec: tools(java) }));
  for (const t of plan.json.tasks) write(dir, t.file, `${t.line}\nv22.12.0\n`);
  assert.equal(plan.json.tasks[2].file, 'apps/new/spec-relay-trial.md');
  assert.equal((await doctor(['--target', dir, '--trial-check', '--json'], machine(dir))).code, 0);
  assert.equal(fs.existsSync(path.join(dir, 'apps')), false);

  // A target root the person already made stays.
  fs.mkdirSync(path.join(dir, 'apps/new'), { recursive: true });
  const again = await doctor(['--target', dir, '--trial'], machine(dir));
  for (const t of again.json.tasks) write(dir, t.file, `${t.line}\nv22.12.0\n`);
  await doctor(['--target', dir, '--trial-check', '--json'], machine(dir, { machine: 'second' }));
  assert.ok(fs.existsSync(path.join(dir, 'apps/new')));
  assert.equal(fs.existsSync(path.join(dir, 'apps/new/spec-relay-trial.md')), false);
  const json = (await doctor(['--target', dir, '--json', '--lang', 'en'], machine(dir, { exec: tools(java) }))).json;
  assert.match(byId(json, 'toolchain').message, /javac 21/);
});

test('review findings: git status, safe.directory, Box, network folders', async () => {
  const dir = tempDir();
  const ctx = (answers) => ({ ...en, target: '/work/proj', platform: 'linux', exec: tools(answers), samePath: () => true });
  assert.equal(checkGit(ctx({ 'git --version': { found: true, status: 1, stdout: '' } })).length, 1);
  // A timeout or a full buffer says nothing about the changes.
  assert.equal(checkGit(ctx({ 'git status --porcelain': { found: true, status: null, stdout: '' } }))[1].level, 'ok');
  const share = checkGit(ctx({ 'git rev-parse --show-toplevel': { found: true, status: 128, stderr: "fatal: detected dubious ownership in repository at '//server/share/proj'\nTo add an exception for this directory, call:\n\n\tgit config --global --add safe.directory '%(prefix)///server/share/proj'\n" } }));
  assert.match(share[1].fix, /safe\.directory '%\(prefix\)\/\/\/server\/share\/proj'/);
  // After setup, uncommitted changes are normal.
  assert.equal(checkGit({ ...ctx({ 'git status --porcelain': { found: true, status: 0, stdout: '?? openspec/\n' } }), setUp: true })[1].level, 'ok');

  const folder = (target, extra = {}) => checkTarget({ ...en, target, env: {}, home: 'C:\\Users\\a', platform: 'win32', isDir: () => true, tryWrite: () => null, ...extra }).map((c) => c.id);
  assert.deepEqual(folder('C:\\Users\\a\\Box\\proj'), ['target', 'sync-folder']);
  assert.deepEqual(folder('C:\\work\\box\\proj'), ['target']);
  assert.deepEqual(folder('\\\\server\\share\\proj'), ['target', 'network-folder']);
});

test('the text report: one line per check and the fix under each problem', async () => {
  const dir = tempDir();
  const { code, text } = await doctor(['--target', dir, '--lang', 'ja'], machine(dir, { exec: tools({ 'npm --version': { found: false } }) }));
  assert.equal(code, 1);
  assert.match(text, /^FAIL  npm が見つかりません。/m);
  assert.match(text, /^ {6}-> npm は Node\.js に含まれています。/m);
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
test('the real machine runs every check without an error', { timeout: 300000 }, async () => {
  // In CI, a full setup: npm ci installs the pinned OpenSpec, so the openspec check can pass.
  const dir = setUpRepo(process.env.CI ? SETUP.filter((a) => a !== '--skip-init') : SETUP);
  // A git repository, so the real path comparison (git's C:/... against a short 8.3 temp path) runs.
  const git = spawnSync('git', ['init', '-q'], { cwd: dir });
  const { code, json } = await doctor(['--target', dir, '--client', 'cli', '--json', '--lang', 'en']);
  assert.ok(json, 'JSON output');
  for (const id of ['node', 'kit', 'target', 'schemas', 'toolchain']) assert.equal(byId(json, id).level, 'ok', `${id}: ${JSON.stringify(byId(json, id))}`);
  if (git.status === 0) assert.equal(byId(json, 'git-repo').level, 'ok', JSON.stringify(byId(json, 'git-repo')));
  if (process.env.CI) {
    assert.equal(byId(json, 'openspec').level, 'ok', JSON.stringify(byId(json, 'openspec')));
    assert.equal(byId(json, 'git').level, 'ok');
    assert.equal(code, 0, JSON.stringify(json.checks.filter((c) => c.level === 'fail')));
  }
});
