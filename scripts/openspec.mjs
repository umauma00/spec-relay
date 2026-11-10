// Finds and runs the OpenSpec CLI without a shell.
//
// On Windows, `npm install -g @fission-ai/openspec` puts an openspec.cmd shim on
// PATH. Node cannot start a .cmd without a shell, and a shell brings three
// problems: cmd.exe looks in the current directory (the repository being
// migrated) before PATH, it cannot use a UNC path as the working directory, and
// Node 24 warns about arguments passed with shell: true. So a shim npm wrote is
// run as `node <package>/bin/openspec.js`, and the standalone openspec.exe is
// run directly. Any other shim (pnpm, yarn, a wrapper) runs through cmd.exe with
// arguments checked against a safe character set.
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

// Returns { command, prefixArgs, batch? } or null when the CLI is not found.
export function findOpenspec({ platform = process.platform, env = process.env, exists = fs.existsSync } = {}) {
  if (platform !== 'win32') return { command: 'openspec', prefixArgs: [] };
  const win = path.win32;
  const appData = envValue(env, 'APPDATA');
  const dirs = [
    ...envValue(env, 'PATH').split(';'),
    envValue(env, 'npm_config_prefix'),
    appData && win.join(appData, 'npm'),
  ].map((dir) => (dir || '').trim().replace(/^"(.*)"$/, '$1'))
    // Relative PATH entries would resolve inside the repository being migrated.
    .filter((dir) => dir && win.isAbsolute(dir));
  let batch = null;
  for (const dir of dirs) {
    const exe = win.join(dir, 'openspec.exe');
    if (exists(exe)) return { command: exe, prefixArgs: [] };
    const cmd = win.join(dir, 'openspec.cmd');
    if (!exists(cmd)) continue;
    const script = win.join(dir, 'node_modules', '@fission-ai', 'openspec', 'bin', 'openspec.js');
    if (exists(script)) return { command: process.execPath, prefixArgs: [script] };
    batch ??= cmd;
  }
  if (batch) return { command: envValue(env, 'ComSpec') || 'cmd.exe', prefixArgs: [], batch };
  return null;
}

const SAFE_BATCH_ARG = /^[A-Za-z0-9_.@=:\\/-]+$/;

// Runs `openspec <args>` and returns spawnSync's result, or { notFound: true }.
export function runOpenspec(args, options = {}, launch = findOpenspec({ env: options.env ?? process.env })) {
  if (!launch) return { notFound: true, status: null, stdout: '', stderr: '' };
  const base = { encoding: 'utf8', windowsHide: true, ...options, shell: false };
  if (launch.batch) {
    if (/^\\\\/.test(path.resolve(options.cwd ?? process.cwd()))) {
      return { status: null, stdout: '', stderr: '', error: new Error(`cmd.exe cannot run ${launch.batch} in a network (UNC) folder. Install OpenSpec with "${INSTALL_HINT}", or work from a drive letter.`) };
    }
    const unsafe = /[%^&!"<>|]/.test(launch.batch) ? launch.batch : args.find((arg) => !SAFE_BATCH_ARG.test(arg));
    if (unsafe !== undefined) {
      return { status: null, stdout: '', stderr: '', error: new Error(`cannot pass "${unsafe}" to ${launch.batch} safely. Install OpenSpec with "${INSTALL_HINT}".`) };
    }
    const line = `"${[`"${launch.batch}"`, ...args].join(' ')}"`;
    return spawnSync(launch.command, ['/d', '/s', '/c', line], { ...base, windowsVerbatimArguments: true });
  }
  const result = spawnSync(launch.command, [...launch.prefixArgs, ...args], base);
  if (result.error?.code === 'ENOENT') return { ...result, notFound: true };
  return result;
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
