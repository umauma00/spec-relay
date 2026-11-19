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
//   A command `spec-relay-compare --cases <dir> --driver "<command>"` runs the
//   kit's compare.mjs (B1 against cases recorded from the source program), and
//   its run records { cases: { count, passed, sha256 } }. A command
//   `spec-relay-e2e --base <url> --start '<command>'` runs the kit's e2e.mjs:
//   the screen tests (B2, and the screenshots of C), which must have passed on
//   the old system first (e2e-old.json), against the new system it starts; its
//   run records { e2e: { sha256, tests, titles, screenshots } }. When C has the
//   same command as B2, the one run counts for both.
// They stop at the first failure. Progress goes to stderr. Then writes
// openspec/changes/<change>/verify.json:
//   { kit, version, change, capability, ranAt, ok,
//     target: { count, sha256, sameCode: [<sha256>], files: { <path>: <sha256> } },
//     runs: [{ level, command, exitCode, seconds, timedOut, cases?, e2e?, sameAs? }] }
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
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { changeSchema, cleanValue, configValue, portCapability, targetFiles, targetHash, targetHashes, verifyPlan, VERIFY_RECEIPT } from './gate.mjs';
import { runCommand, MAX_TIMEOUT_MS, stopAllOnSignal } from './run.mjs';
import { isCompareCommand, runCompareCommand } from './compare.mjs';
import { isE2eCommand, runE2eCommand } from './e2e.mjs';

export { runCommand, windowsScript, MAX_TIMEOUT_MS } from './run.mjs';

const KIT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TAIL_LINES = 40;

const tail = (text) => (text ?? '').replace(/\s+$/, '').split(/\r?\n/).slice(-TAIL_LINES).join('\n');

// Runs one level: a `spec-relay-compare ...` command with compare.mjs (level
// B1 against recorded cases), a `spec-relay-e2e ...` command with e2e.mjs (the
// screen tests of B2 and C, which passed on the old system first), anything
// else as a command line.
export const runLevel = (command, cwd, options) => (isCompareCommand(command) ? runCompareCommand(command, cwd, options)
  : isE2eCommand(command) ? runE2eCommand(command, cwd, options) : runCommand(command, cwd, { timeoutMs: options?.timeoutMs }));

const say = (line) => process.stderr.write(`verify: ${line}\n`);

export async function verify(root, change, { timeoutMs = 60 * 60 * 1000, run = runLevel, progress = say } = {}) {
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
  const done = new Map();
  for (const { level, command, from } of plan.runs) {
    // B2 and C of web screens are one run of the screen tests: a level whose
    // command an earlier level already ran takes that run's result.
    const earlier = done.get(command);
    if (earlier) progress(`${level} (${from}): the same command as ${earlier.level}, not run again`);
    else progress(`${level} (${from}): ${command}`);
    const result = earlier ? { ...earlier.result, seconds: 0 } : await run(command, cwd, { timeoutMs, root, change, capability });
    if (!earlier) done.set(command, { level, result });
    if (!earlier) progress(`${level}: ${result.exitCode === 0 ? 'passed' : result.timedOut ? 'timed out' : `failed, exit code ${result.exitCode}`} in ${result.seconds}s`);
    const cases = result.cases ? { cases: result.cases } : {};
    const e2e = result.e2e ? { e2e: result.e2e } : {};
    runs.push({ level, command, exitCode: result.exitCode, seconds: result.seconds, timedOut: result.timedOut, ...cases, ...e2e, ...(earlier ? { sameAs: earlier.level } : {}) });
    shown.push({ level, command, from, exitCode: result.exitCode, seconds: result.seconds, ...cases, ...e2e, ...(result.timedOut ? { timedOut: true } : {}), ...(result.exitCode !== 0 ? { tail: tail(result.output) } : {}) });
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
  stopAllOnSignal();
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
