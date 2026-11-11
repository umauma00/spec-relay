// Finds and runs the OpenSpec CLI (and other command line tools) without a shell.
//
// On Windows, `npm install -g @fission-ai/openspec` puts an openspec.cmd shim on
// PATH. Node cannot start a .cmd without a shell, and a shell brings three
// problems: cmd.exe looks in the current directory (the repository being
// migrated) before PATH, it cannot use a UNC path as the working directory, and
// Node 24 warns about arguments passed with shell: true. So a shim npm wrote is
// run as `node <package>/bin/openspec.js`, and the standalone openspec.exe is
// run directly. Any other shim (pnpm, yarn, a wrapper) runs through cmd.exe with
// arguments checked against a safe character set. findCommand and runCommand do
// the same for other tools (git, the Copilot CLI, toolchains) for doctor.mjs.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

export const OPENSPEC_VERSION = '1.17.0';
export const INSTALL_HINT = `npm install -g @fission-ai/openspec@${OPENSPEC_VERSION}`;

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

// Returns { command, prefixArgs, batch? } or null when the CLI is not found.
export function findOpenspec({ platform = process.platform, env = process.env, exists = fs.existsSync } = {}) {
  const appData = envValue(env, 'APPDATA');
  return findCommand('openspec', {
    npmScript: '@fission-ai/openspec/bin/openspec.js',
    extraDirs: [envValue(env, 'npm_config_prefix'), appData && path.win32.join(appData, 'npm')],
    platform, env, exists,
  });
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

// Runs `openspec <args>` and returns spawnSync's result, or { notFound: true }.
export function runOpenspec(args, options = {}, launch = findOpenspec({ env: options.env ?? process.env })) {
  return runCommand(launch, args, options, INSTALL_HINT);
}

// { ok, version } or { ok: false, reason } with a message a person can act on.
export function probeOpenspec(options = {}) {
  const result = runOpenspec(['--version'], options);
  if (result.notFound) {
    return { ok: false, reason: `the openspec CLI was not found. Install it with "${INSTALL_HINT}" and open a new terminal so PATH is refreshed.` };
  }
  if (result.error || result.status !== 0) {
    const detail = (result.error?.message || result.stderr || result.stdout || '').trim().split(/\r?\n/).slice(0, 3).join(' ');
    return { ok: false, reason: `the openspec CLI was found but "openspec --version" failed (Node.js 22.12 or later is required; this is ${process.version}). ${detail}`.trim() };
  }
  return { ok: true, version: result.stdout.trim() };
}
