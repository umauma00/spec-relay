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
// They stop at the first failure. Progress goes to stderr. Then writes
// openspec/changes/<change>/verify.json:
//   { kit, version, change, capability, ranAt, ok,
//     target: { count, sha256, sameCode: [<sha256>], files: { <path>: <sha256> } },
//     runs: [{ level, command, exitCode, seconds, timedOut }] }
// `target.sha256` is one hash over the target root's files after the run
// (gate.mjs targetHash); port-done fails, naming the files, when the code
// changed since. A timeout stops the command and every process it started. The
// commands' output is never written to the file, because it can hold secrets;
// the last lines of each failing command are printed instead.
//
// On Windows the commands run in Windows PowerShell (`powershell.exe
// -NoProfile -NonInteractive -ExecutionPolicy Bypass`), because conventions.md
// writes them for PowerShell; the Bypass applies to that one process only, so
// `npm test` works where the execution policy blocks npm.ps1, and changes no
// setting. Elsewhere they run in /bin/sh.
//
// Commands must be one command each (gate.mjs chainProblem): PowerShell would
// report only the last part of `a; b`.
//
// Prints { ok, receipt, runs, problems } as JSON and exits 0 when every command
// passed, 1 when one failed or nothing could run, 2 on bad usage.
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { changeSchema, cleanValue, configValue, portCapability, targetFiles, targetHash, targetHashes, verifyPlan, VERIFY_RECEIPT } from './gate.mjs';

const KIT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TAIL_LINES = 40;
const KEEP_BYTES = 256 * 1024;

const tail = (text) => (text ?? '').replace(/\s+$/, '').split(/\r?\n/).slice(-TAIL_LINES).join('\n');

// Stops a command and everything it started: a test runner's own children
// (dotnet, java, node) would otherwise keep running and hold files open.
function killTree(child, platform) {
  if (platform === 'win32') spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true });
  else { try { process.kill(-child.pid, 'SIGKILL'); } catch { try { child.kill('SIGKILL'); } catch { /* gone */ } } }
}

// The longest timeout setTimeout can wait (about 24.8 days).
export const MAX_TIMEOUT_MS = 2 ** 31 - 1;
// After the command's own process ended (or was killed), how long to wait for
// the output of what it left behind before going on.
const GRACE_MS = 2000;
const running = new Set();

// Runs one command line in the target root and resolves to
// { exitCode, timedOut, seconds, output } (only the last part of the output).
export function runCommand(command, cwd, { timeoutMs, platform = process.platform, exec = spawn } = {}) {
  // UTF-8 output, so the printed tail of a failure is readable on a Japanese
  // (CP932) console too; the command itself is the last statement, so its
  // status is the run's.
  const [file, args, extra] = platform === 'win32'
    ? ['powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', `[Console]::OutputEncoding = [Text.Encoding]::UTF8; ${command}`], {}]
    : ['/bin/sh', ['-c', command], { detached: true }];
  const started = Date.now();
  return new Promise((resolve) => {
    const chunks = [];
    let size = 0;
    let timedOut = false;
    let settled = false;
    let exitCode = null;
    let child;
    let timer = null;
    let grace = null;
    const keep = (chunk) => {
      chunks.push(chunk); size += chunk.length;
      while (size > KEEP_BYTES && chunks.length > 1) size -= chunks.shift().length;
    };
    const done = (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer); clearTimeout(grace);
      running.delete(child);
      child?.stdout?.destroy?.(); child?.stderr?.destroy?.();
      const output = Buffer.concat(chunks).toString('utf8');
      resolve({ exitCode: timedOut || typeof exitCode !== 'number' ? -1 : exitCode, timedOut, seconds: Math.round((Date.now() - started) / 100) / 10, output: error ? `${output}\n${error.message}` : output });
    };
    try {
      child = exec(file, args, { cwd, env: process.env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], ...extra });
    } catch (error) { resolve({ exitCode: -1, timedOut: false, seconds: 0, output: error.message }); return; }
    running.add(child);
    if (timeoutMs) {
      timer = setTimeout(() => {
        timedOut = true;
        killTree(child, platform);
        grace = setTimeout(() => done(), GRACE_MS);
      }, Math.min(timeoutMs, MAX_TIMEOUT_MS));
    }
    child.stdout?.on('data', keep);
    child.stderr?.on('data', keep);
    child.on('error', (error) => done(error));
    // A process the command left behind may hold the output open: the command's
    // own exit decides, and its output is read for a short while after.
    child.on('exit', (code) => { exitCode = code; clearTimeout(grace); grace = setTimeout(() => done(), GRACE_MS); });
    child.on('close', () => done());
  });
}

// Ctrl+C on verify.mjs stops the command it is running too (on POSIX the
// command runs in its own process group, which the terminal does not signal).
function stopAll(signal) {
  for (const child of running) killTree(child, process.platform);
  process.exit(signal === 'SIGINT' ? 130 : 143);
}

const say = (line) => process.stderr.write(`verify: ${line}\n`);

export async function verify(root, change, { timeoutMs = 60 * 60 * 1000, run = runCommand, progress = say } = {}) {
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

  const before = targetHash(root, files);
  const runs = [];
  const shown = [];
  // The levels run in order and stop at the first failure: a comparison of code
  // whose own tests fail tells nothing, and B2 or C can take long.
  for (const { level, command, from } of plan.runs) {
    progress(`${level} (${from}): ${command}`);
    const result = await run(command, cwd, { timeoutMs });
    progress(`${level}: ${result.exitCode === 0 ? 'passed' : result.timedOut ? 'timed out' : `failed, exit code ${result.exitCode}`} in ${result.seconds}s`);
    runs.push({ level, command, exitCode: result.exitCode, seconds: result.seconds, timedOut: result.timedOut });
    shown.push({ level, command, from, exitCode: result.exitCode, seconds: result.seconds, ...(result.timedOut ? { timedOut: true } : {}), ...(result.exitCode !== 0 ? { tail: tail(result.output) } : {}) });
    if (result.exitCode !== 0) break;
  }
  const ok = runs.length === plan.runs.length && runs.every((r) => r.exitCode === 0);
  const after = targetFiles(root) ?? [];
  const hashes = targetHashes(root, after);
  const sha256 = targetHash(root, after, hashes);
  // The code states that differ from this one only by what verify runs wrote
  // (test reports, recorded output): the state before this run, and, when
  // nothing else changed since the last run, the states that run counted.
  // port-done takes a crosscheck merged on any of them.
  let previous = null;
  try { previous = JSON.parse(fs.readFileSync(path.join(dir, VERIFY_RECEIPT), 'utf8')); } catch { /* first run */ }
  const carried = previous?.change === change && previous?.target?.sha256 === before && Array.isArray(previous.target.sameCode) ? previous.target.sameCode : [];
  const sameCode = [...new Set([...carried, before].filter((h) => h !== sha256))].slice(-20);
  let version = 'unknown';
  try { version = JSON.parse(fs.readFileSync(path.join(KIT, 'package.json'), 'utf8')).version; } catch { /* kit without package.json */ }
  const receipt = {
    kit: 'spec-relay', version, change, capability, ranAt: new Date().toISOString(), ok,
    target: { count: after.length, sha256, sameCode, files: hashes },
    runs,
  };
  const problems = shown.filter((r) => r.exitCode !== 0).map((r) => `${r.level === 'boundary' ? 'the boundary check' : `level ${r.level}`} failed (${r.timedOut ? 'timed out' : `exit code ${r.exitCode}`}): ${r.command}`);
  const skipped = plan.runs.slice(runs.length).map((r) => r.level);
  if (skipped.length) problems.push(`not run after that failure: ${skipped.join(', ')}`);
  try { fs.writeFileSync(path.join(dir, VERIFY_RECEIPT), `${JSON.stringify(receipt, null, 2)}\n`); } catch (error) {
    problems.push(`could not write ${VERIFY_RECEIPT}: ${error.message}`);
  }
  return { ok: ok && problems.length === 0, receipt: `openspec/changes/${change}/${VERIFY_RECEIPT}`, runs: shown, problems };
}

export function main(argv) {
  // Returns the exit code, or a promise of it once the commands ran.
  const opts = { root: process.cwd(), timeout: 60 };
  for (let i = 0; i < argv.length; i += 2) {
    const key = { '--change': 'change', '--root': 'root', '--timeout-minutes': 'timeout' }[argv[i]];
    if (!key || argv[i + 1] === undefined) return usage();
    opts[key] = argv[i + 1];
  }
  const minutes = Number(opts.timeout);
  if (!opts.change || !(minutes > 0) || minutes * 60 * 1000 > MAX_TIMEOUT_MS) return usage();
  process.once('SIGINT', stopAll);
  process.once('SIGTERM', stopAll);
  if (!fs.existsSync(path.join(opts.root, 'openspec'))) {
    console.error(`verify: no openspec/ folder in ${path.resolve(opts.root)}. Run this from the repository root or pass --root DIR.`);
    return 2;
  }
  return verify(opts.root, opts.change, { timeoutMs: minutes * 60 * 1000 }).then((result) => {
    console.log(JSON.stringify(result, null, 2));
    return result.ok ? 0 : 1;
  });
}

function usage() {
  console.error('Usage: node verify.mjs --change port-<capability> [--root DIR] [--timeout-minutes N (at most 35000)]');
  return 2;
}

function invokedDirectly() {
  if (!process.argv[1]) return false;
  try { return fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url)); } catch { return false; }
}

if (invokedDirectly()) Promise.resolve(main(process.argv.slice(2))).then((code) => { process.exitCode = code; });
