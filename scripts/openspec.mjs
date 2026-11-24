#!/usr/bin/env node
// Finds and runs the OpenSpec CLI (and other command line tools) without a shell.
//
// spec-relay pins OpenSpec per repository: setup.mjs installs the version the
// kit is tested with into openspec/spec-relay/tools/ with `npm ci`, from the
// package.json and package-lock.json in the kit's templates/openspec-tools/.
// Every OpenSpec call of the kit, and of the agent, goes through here as
// `node <kit>/scripts/openspec.mjs <args>` and runs
// `node <that folder>/node_modules/@fission-ai/openspec/bin/openspec.js`. A
// global `openspec` on PATH is never used: it may be any version, or none.
// Running the script with node also avoids Windows' openspec.cmd shim, which
// needs a shell (cmd.exe looks in the current directory before PATH, cannot use
// a UNC working directory, and Node 24 warns about shell: true).
//
// findCommand and runCommand find and run other tools (npm, git, the Copilot
// CLI, toolchains) the same way for setup.mjs and doctor.mjs.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export const OPENSPEC_VERSION = '2.1.1';
// Where setup installs OpenSpec, relative to the repository being migrated.
export const TOOLS_DIR = 'openspec/spec-relay/tools';
const BIN = 'node_modules/@fission-ai/openspec/bin/openspec.js';
const SETUP = path.join(path.dirname(fileURLToPath(import.meta.url)), 'setup.mjs');
const SETUP_HINT = `run setup again (node "${SETUP}" --target . --apply in the repository); it installs OpenSpec into ${TOOLS_DIR} with npm ci`;

// Windows environment names are case-insensitive.
function envValue(env, name) {
  const key = Object.keys(env).find((k) => k.toUpperCase() === name.toUpperCase());
  return key === undefined ? '' : env[key] ?? '';
}

// Finds a command line tool without a shell. Returns { command, prefixArgs,
// batch? } or null when it is not found on Windows (elsewhere the plain name is
// returned and a missing tool shows as notFound when it runs). On Windows,
// `<name>.exe` runs directly, and an npm shim `<name>.cmd` runs as
// `node <dir>/node_modules/<npmScript>` when `npmScript` names the package's
// script. `extraDirs` are searched after PATH.
export function findCommand(name, { npmScript, extraDirs = [], platform = process.platform, env = process.env, exists = fs.existsSync } = {}) {
  if (platform !== 'win32') return { command: name, prefixArgs: [] };
  const win = path.win32;
  const dirs = [...envValue(env, 'PATH').split(';'), ...extraDirs]
    .map((dir) => (dir || '').trim().replace(/^"(.*)"$/, '$1'))
    // Relative PATH entries would resolve inside the repository being migrated.
    .filter((dir) => dir && win.isAbsolute(dir));
  let batch = null;
  for (const dir of dirs) {
    const exe = win.join(dir, `${name}.exe`);
    if (exists(exe)) return { command: exe, prefixArgs: [] };
    const cmd = win.join(dir, `${name}.cmd`);
    if (!exists(cmd)) continue;
    const script = npmScript && win.join(dir, 'node_modules', ...npmScript.split('/'));
    if (script && exists(script)) return { command: process.execPath, prefixArgs: [script] };
    batch ??= cmd;
  }
  if (batch) return { command: envValue(env, 'ComSpec') || 'cmd.exe', prefixArgs: [], batch };
  return null;
}

// The OpenSpec pinned in `root` (the repository being migrated):
// { launch, version } when installed, { launch: null, pinned, reason } when not.
export function findOpenspec(root, { exists = fs.existsSync, readFile = (f) => fs.readFileSync(f, 'utf8') } = {}) {
  const tools = path.join(root, TOOLS_DIR);
  const pinned = exists(path.join(tools, 'package.json'));
  const script = path.join(tools, ...BIN.split('/'));
  if (!exists(script)) {
    const reason = pinned
      ? `OpenSpec is pinned in ${TOOLS_DIR} but not installed there (usual right after a clone): ${SETUP_HINT}.`
      : `this repository has no OpenSpec of its own (${TOOLS_DIR}): ${SETUP_HINT}.`;
    return { launch: null, pinned, reason };
  }
  let version = null;
  try { version = JSON.parse(readFile(path.join(tools, 'node_modules/@fission-ai/openspec/package.json'))).version || null; } catch { /* unreadable */ }
  return { launch: { command: process.execPath, prefixArgs: [script] }, pinned, version };
}

const SAFE_BATCH_ARG = /^[A-Za-z0-9_.@=:\\/-]+$/;

// Runs `<launch> <args>` and returns spawnSync's result, or { notFound: true }.
// `hint` says how to install a version that needs no cmd.exe.
export function runCommand(launch, args, options = {}, hint = '') {
  if (!launch) return { notFound: true, status: null, stdout: '', stderr: '' };
  const base = { encoding: 'utf8', windowsHide: true, ...options, shell: false };
  const instead = hint ? ` Install it with "${hint}".` : '';
  if (launch.batch) {
    if (/^\\\\/.test(path.resolve(options.cwd ?? process.cwd()))) {
      return { status: null, stdout: '', stderr: '', error: new Error(`cmd.exe cannot run ${launch.batch} in a network (UNC) folder.${instead} Or work from a drive letter.`) };
    }
    const unsafe = /[%^&!"<>|]/.test(launch.batch) ? launch.batch : args.find((arg) => !SAFE_BATCH_ARG.test(arg));
    if (unsafe !== undefined) {
      return { status: null, stdout: '', stderr: '', error: new Error(`cannot pass "${unsafe}" to ${launch.batch} safely.${instead}`) };
    }
    const line = `"${[`"${launch.batch}"`, ...args].join(' ')}"`;
    return spawnSync(launch.command, ['/d', '/s', '/c', line], { ...base, windowsVerbatimArguments: true });
  }
  const result = spawnSync(launch.command, [...launch.prefixArgs, ...args], base);
  if (result.error?.code === 'ENOENT') return { ...result, notFound: true };
  return result;
}

// The environment the kit runs OpenSpec with. OpenSpec sends anonymous usage
// statistics by default; the kit turns them off with OPENSPEC_TELEMETRY=0
// unless the person set OPENSPEC_TELEMETRY themselves. OpenSpec does not see
// the pinned folder as a project install, so its update notice would tell
// people to `npm install -g` a newer version; the kit pins the version and a
// newer one comes with a kit update. OPENSPEC_SKILLS_SCOPE=project: from 2.1.0,
// init puts the skills in the home folder (~/.agents/skills, for every
// project) unless told otherwise, and the kit can disable the gate-bypassing
// skills only in the repository; setup also passes --scope project and records
// skillsScope: project in openspec/config.yaml, which update reads. Names are
// case-insensitive only on Windows, so there another spelling is dropped first.
export function openspecEnv(env = process.env, platform = process.platform) {
  const own = platform === 'win32'
    ? Object.keys(env).some((k) => k.toUpperCase() === 'OPENSPEC_TELEMETRY' && env[k] !== undefined)
    : env.OPENSPEC_TELEMETRY !== undefined;
  const forced = ['OPENSPEC_NO_UPDATE_CHECK', 'OPENSPEC_SKILLS_SCOPE'];
  const rest = platform === 'win32'
    ? Object.fromEntries(Object.entries(env).filter(([k]) => !forced.includes(k.toUpperCase())))
    : env;
  return { ...rest, ...(own ? {} : { OPENSPEC_TELEMETRY: '0' }), OPENSPEC_NO_UPDATE_CHECK: '1', OPENSPEC_SKILLS_SCOPE: 'project' };
}

// Runs the OpenSpec pinned in the working directory (`options.cwd`, or
// `root` when the two differ) and returns spawnSync's result, or
// { notInstalled: true, reason } when it is not installed there.
export function runOpenspec(args, options = {}, root = options.cwd ?? process.cwd()) {
  const found = findOpenspec(root);
  if (!found.launch) return { notInstalled: true, pinned: found.pinned, reason: found.reason, status: null, stdout: '', stderr: '' };
  const env = openspecEnv(options.env ?? process.env);
  // init and update are the commands that ask where the skills go (2.1+); in a
  // terminal a "Switch to global" answer would move them out of the repository,
  // where the kit cannot disable them, so they never ask (OpenSpec's isInteractive).
  if (['init', 'update'].includes(args.find((arg) => !arg.startsWith('-')))) {
    for (const key of Object.keys(env)) if (key.toUpperCase() === 'OPEN_SPEC_INTERACTIVE') delete env[key];
    env.OPEN_SPEC_INTERACTIVE = '0';
  }
  return runCommand(found.launch, args, { ...options, env });
}

// { ok, version } or { ok: false, notInstalled, pinned, reason } with a message a person can act on.
export function probeOpenspec(options = {}) {
  const result = runOpenspec(['--version'], options);
  if (result.notInstalled) return { ok: false, notInstalled: true, pinned: result.pinned, reason: result.reason };
  if (result.error || result.status !== 0) {
    const detail = (result.error?.message || result.stderr || result.stdout || '').trim().split(/\r?\n/).slice(0, 3).join(' ');
    return { ok: false, reason: `"openspec --version" failed (Node.js ${process.version}): ${detail || 'no output'}` };
  }
  return { ok: true, version: result.stdout.trim() };
}

// npm, which setup uses to install OpenSpec. On Windows npm.cmd runs as
// `node <dir>/node_modules/npm/bin/npm-cli.js`.
export function findNpm(options = {}) {
  // Node's own folder holds npm.cmd and node_modules/npm, also when PATH lacks it.
  return findCommand('npm', { npmScript: 'npm/bin/npm-cli.js', extraDirs: [path.dirname(process.execPath)], ...options });
}

// Files under the tools folder's node_modules that git tracks. setup and
// doctor run the pinned OpenSpec from there, so in a repository that ships its
// own node_modules they refuse instead of running someone else's code.
export function trackedModules(root) {
  const result = spawnSync('git', ['ls-files', '-z', '--', `${TOOLS_DIR}/node_modules`], { cwd: root, encoding: 'utf8', windowsHide: true });
  if (result.status !== 0 || !result.stdout) return [];
  return result.stdout.split('\0').filter(Boolean);
}

function invokedDirectly() {
  if (!process.argv[1]) return false;
  try { return fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url)); } catch { return false; }
}

// `node <kit>/scripts/openspec.mjs <args>`, run in the repository being
// migrated: the agent's and the person's way to call OpenSpec.
// From a subfolder, the nearest folder above with a pinned OpenSpec counts.
export function findRoot(start) {
  for (let dir = path.resolve(start); ; dir = path.dirname(dir)) {
    if (fs.existsSync(path.join(dir, TOOLS_DIR, 'package.json'))) return dir;
    if (path.dirname(dir) === dir) return path.resolve(start);
  }
}

if (invokedDirectly()) {
  const result = runOpenspec(process.argv.slice(2), { stdio: 'inherit' }, findRoot(process.cwd()));
  if (result.notInstalled) {
    console.error(`spec-relay: ${result.reason}`);
    process.exitCode = 1;
  } else if (result.error) {
    console.error(`spec-relay: ${result.error.message}`);
    process.exitCode = 1;
  } else {
    process.exitCode = result.status ?? 1;
  }
}
