#!/usr/bin/env node
// Runs a port change's verification and records the result, so that
// `gate.mjs port-done` can tell the tests passed on the code as it is now,
// instead of trusting a ticked task.
//
//   node verify.mjs --change port-<capability> [--root DIR] [--timeout-minutes N]
//
// Runs these commands in the target root, one after another:
// - level A, the tests from the spec scenarios: the command design.md's
//   Verification table gives for A, else the Test command of the archived target
//   design's conventions.md;
// - the boundary check: the Boundary check command of conventions.md;
// - each comparison level (B1, B2, C) that the archived verification.md chose for
//   the capability's context: the command design.md's Verification table gives it.
// Then writes openspec/changes/<change>/verify.json:
//   { kit, version, change, capability, ranAt, ok,
//     target: { files, sha256 }, runs: [{ level, command, exitCode, seconds, timedOut }] }
// `target.sha256` is one hash over the target root's files after the run
// (gate.mjs targetHash); port-done fails when the code changed since. The
// commands' output is never written to the file, because it can hold secrets;
// the last lines of each failing command are printed instead.
//
// On Windows the commands run in Windows PowerShell (`powershell.exe
// -NoProfile -NonInteractive -ExecutionPolicy Bypass`), because conventions.md
// writes them for PowerShell; the Bypass applies to that one process only, so
// `npm test` works where the execution policy blocks npm.ps1, and changes no
// setting. Elsewhere they run in /bin/sh.
//
// Prints { ok, receipt, runs, problems } as JSON and exits 0 when every command
// passed, 1 when one failed or nothing could run, 2 on bad usage.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { changeSchema, cleanValue, configValue, portCapability, targetFiles, targetHash, verifyPlan, VERIFY_RECEIPT } from './gate.mjs';

const KIT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TAIL_LINES = 40;

const tail = (text) => (text ?? '').replace(/\s+$/, '').split(/\r?\n/).slice(-TAIL_LINES).join('\n');

// Runs one command line in the target root. `exec` is replaceable for tests.
export function runCommand(command, cwd, { timeoutMs, platform = process.platform, exec = spawnSync } = {}) {
  const options = { cwd, encoding: 'utf8', windowsHide: true, maxBuffer: 256 * 1024 * 1024, timeout: timeoutMs, env: process.env };
  const started = Date.now();
  const result = platform === 'win32'
    ? exec('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', command], options)
    : exec(command, { ...options, shell: '/bin/sh' });
  const timedOut = result.error?.code === 'ETIMEDOUT' || (result.signal != null && timeoutMs != null && Date.now() - started >= timeoutMs);
  const exitCode = typeof result.status === 'number' ? result.status : -1;
  const output = [result.stdout, result.stderr, result.error && !timedOut ? String(result.error.message) : ''].filter(Boolean).join('\n');
  return { exitCode, timedOut, seconds: Math.round((Date.now() - started) / 100) / 10, output };
}

export function verify(root, change, { timeoutMs = 60 * 60 * 1000, run = runCommand } = {}) {
  const dir = path.join(root, 'openspec/changes', change);
  if (!fs.existsSync(dir)) return { ok: false, problems: [`change not found: ${change}`] };
  if (changeSchema(dir) !== 'spec-relay-port') return { ok: false, problems: [`${change} is not a port change (schema spec-relay-port)`] };
  const capability = portCapability(root, change);
  const plan = verifyPlan(root, change, capability ?? undefined);
  if (plan.problems.length) return { ok: false, problems: plan.problems };
  const files = targetFiles(root);
  const target = cleanValue(configValue(root, 'Target root', ''));
  if (files === null) return { ok: false, problems: ['openspec/config.yaml names no target root inside the repository ("Target root ...:")'] };
  const cwd = path.resolve(root, target);
  if (!fs.existsSync(cwd)) return { ok: false, problems: [`the target root ${target} does not exist yet`] };

  const runs = [];
  const shown = [];
  for (const { level, command } of plan.runs) {
    const result = run(command, cwd, { timeoutMs });
    runs.push({ level, command, exitCode: result.exitCode, seconds: result.seconds, timedOut: result.timedOut });
    shown.push({ level, command, exitCode: result.exitCode, seconds: result.seconds, ...(result.timedOut ? { timedOut: true } : {}), ...(result.exitCode !== 0 ? { tail: tail(result.output) } : {}) });
  }
  const ok = runs.every((r) => r.exitCode === 0);
  const after = targetFiles(root) ?? [];
  let version = 'unknown';
  try { version = JSON.parse(fs.readFileSync(path.join(KIT, 'package.json'), 'utf8')).version; } catch { /* kit without package.json */ }
  const receipt = {
    kit: 'spec-relay', version, change, capability, ranAt: new Date().toISOString(), ok,
    target: { files: after.length, sha256: targetHash(root, after) },
    runs,
  };
  const problems = shown.filter((r) => r.exitCode !== 0).map((r) => `${r.level === 'boundary' ? 'the boundary check' : `level ${r.level}`} failed (${r.timedOut ? 'timed out' : `exit code ${r.exitCode}`}): ${r.command}`);
  try { fs.writeFileSync(path.join(dir, VERIFY_RECEIPT), `${JSON.stringify(receipt, null, 2)}\n`); } catch (error) {
    problems.push(`could not write ${VERIFY_RECEIPT}: ${error.message}`);
  }
  return { ok: ok && problems.length === 0, receipt: `openspec/changes/${change}/${VERIFY_RECEIPT}`, runs: shown, problems };
}

export function main(argv) {
  const opts = { root: process.cwd(), timeout: 60 };
  for (let i = 0; i < argv.length; i += 2) {
    const key = { '--change': 'change', '--root': 'root', '--timeout-minutes': 'timeout' }[argv[i]];
    if (!key || argv[i + 1] === undefined) return usage();
    opts[key] = argv[i + 1];
  }
  const minutes = Number(opts.timeout);
  if (!opts.change || !(minutes > 0)) return usage();
  if (!fs.existsSync(path.join(opts.root, 'openspec'))) {
    console.error(`verify: no openspec/ folder in ${path.resolve(opts.root)}. Run this from the repository root or pass --root DIR.`);
    return 2;
  }
  const result = verify(opts.root, opts.change, { timeoutMs: minutes * 60 * 1000 });
  console.log(JSON.stringify(result, null, 2));
  return result.ok ? 0 : 1;
}

function usage() {
  console.error('Usage: node verify.mjs --change port-<capability> [--root DIR] [--timeout-minutes N]');
  return 2;
}

function invokedDirectly() {
  if (!process.argv[1]) return false;
  try { return fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url)); } catch { return false; }
}

if (invokedDirectly()) process.exitCode = main(process.argv.slice(2));
