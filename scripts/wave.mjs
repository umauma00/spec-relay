#!/usr/bin/env node
// The orchestrator's bookkeeping around subagent work, one command per moment,
// so that it does not spend a model turn on each step (save the guard, list
// git's changes, compare both, merge each part file, save the guard again).
//
//   node wave.mjs start <name> [--root DIR]
//       before the first task: saves the guard snapshot (gate.mjs guard --save)
//       and the list of paths git reports as changed or untracked
//   node wave.mjs check <name> [--root DIR]
//       any time: what changed since the snapshot that nobody assigned, the
//       guarded files by hash and, in a git repository, the paths outside the
//       places subagents write (openspec/changes/, the work folder, the target
//       root) that git now reports and did not at the start
//   node wave.mjs merge <name> --into <artifact> --parts <file> [--into ... --parts ...] [--root DIR]
//       while other tasks still run: checks, merges the part files of the tasks
//       that finished (files, never a folder: another task may still be
//       writing there) with merge.mjs --clean, and takes the merged artifacts
//       into the snapshot, so the rest of the wave is compared from here
//   node wave.mjs accept <name> <path> [<path> ...] [--root DIR]
//       right after the orchestrator wrote guarded files itself while tasks
//       still run (a tick, a question, an archive): every path that changed
//       must be one of these (a folder covers what is under it); then they are
//       taken into the snapshot. Run check right before such a write: a path
//       that changed before it was a subagent's.
//   node wave.mjs end <name> [--into <artifact> --parts <file-or-folder> ...] [--root DIR]
//       when every task has returned: checks, merges (folders allowed now) and
//       removes the snapshot
//
// The canvas edits the person makes in review.md meanwhile are theirs (listed
// under `canvas`, never a problem), as with gate.mjs guard. A path that changed
// and that nobody named stops merge, accept and end: nothing is merged or taken
// then, the snapshot stays, and the orchestrator asks the person.
//
// Prints { ok, ... , next } as JSON; exit code 0 when ok, 1 when something
// changed or a merge failed, 2 on bad usage.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { guardSave, guardTake, guardDrop, guardSnapshot, configValue, cleanValue, sourceFiles, nextSteps, language } from './gate.mjs';
import { merge } from './merge.mjs';

const NAME = /^[a-z0-9][a-z0-9-]{0,63}$/i;
const FOLD = process.platform === 'win32' || process.platform === 'darwin';
const fold = (p) => (FOLD ? p.toLowerCase() : p);
const rel = (p) => String(p).replace(/\\/g, '/').replace(/^(\.\/)+/, '').replace(/\/+$/, '');
const gitFile = (root, name) => guardSnapshot(root, name).replace(/\.json$/, '.git.json');

// The paths git reports as changed or untracked, as "XY path" lines, or null
// outside a git repository (or without git).
export function gitChanges(root) {
  let out;
  try {
    out = execFileSync('git', ['status', '--porcelain', '--untracked-files=all', '-z'], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 64 * 1024 * 1024 });
  } catch { return null; }
  const entries = [];
  const parts = out.split('\0');
  for (let i = 0; i < parts.length; i += 1) {
    const entry = parts[i];
    if (entry.length < 4) continue;
    entries.push(`${entry.slice(0, 2)} ${rel(entry.slice(3))}`);
    // A rename or copy is followed by its old path.
    if (/^[RC]/.test(entry)) i += 1;
  }
  return entries.sort();
}

// Where subagents write by assignment: the active changes' folders, the work
// folder, the local records and the target root. With the target root ".",
// every path outside openspec/ and the top-level dot folders (.github, .vscode,
// .agents...) counts as the target's. Guarded files are compared by hash, not here.
function assigned(root) {
  const target = rel(cleanValue(configValue(root, 'Target root', '') ?? ''));
  const places = ['openspec/changes/', 'openspec/spec-relay/work/', 'openspec/spec-relay/local/'];
  return (p) => {
    const f = fold(p);
    if (places.some((d) => f.startsWith(d)) && !f.startsWith('openspec/changes/archive/')) return true;
    if (target === '' || target === '.') return !f.startsWith('openspec/') && !f.startsWith('.');
    return f === fold(target) || f.startsWith(`${fold(target)}/`);
  };
}

// The git entries that are new since the start and lie outside the assigned places.
function outside(root, name, alsoGuarded = []) {
  let before;
  try { before = JSON.parse(fs.readFileSync(gitFile(root, name), 'utf8')); } catch { return { list: [], git: false }; }
  if (!Array.isArray(before)) return { list: [], git: false };
  const now = gitChanges(root);
  if (now === null) return { list: [], git: false };
  const had = new Set(before);
  const ok = assigned(root);
  // The snapshot's paths (and the guarded files added since) are compared by hash already.
  const guarded = new Set([...Object.keys(readSnapshot(root, name)), ...alsoGuarded].map(fold));
  const list = now.filter((e) => !had.has(e)).map((e) => e.slice(3)).filter((p) => !ok(p) && !guarded.has(fold(p)));
  return { list: [...new Set(list)].sort(), git: true, now };
}

function readSnapshot(root, name) {
  try { return JSON.parse(fs.readFileSync(guardSnapshot(root, name), 'utf8')) ?? {}; } catch { return {}; }
}

function saveGit(root, name, entries) {
  if (entries) fs.writeFileSync(gitFile(root, name), `${JSON.stringify(entries)}\n`);
}

export function start(root, name) {
  if (!NAME.test(name)) return { ok: false, problems: [`not a wave name: ${name} (letters, digits and hyphens)`] };
  const saved = guardSave(root, name);
  if (!saved.ok) return saved;
  const entries = gitChanges(root);
  try { if (entries) saveGit(root, name, entries); else fs.rmSync(gitFile(root, name), { force: true }); } catch (error) { return { ok: false, problems: [`could not write the git list: ${error.message}`] }; }
  return { ...saved, git: entries !== null };
}

// The paths an own write may cover: a file or a folder named, never the source
// code, the config or the whole repository.
function ownPaths(root, list) {
  const problems = [];
  const sources = new Set((sourceFiles(root) ?? []).map(fold));
  const named = [];
  for (const raw of list) {
    const p = rel(raw);
    if (!p || p === '.' || p.split('/').includes('..') || path.isAbsolute(raw)) { problems.push(`not a repository path: ${raw}`); continue; }
    const f = fold(p);
    if (f === 'openspec/config.yaml' || sources.has(f) || [...sources].some((s) => s.startsWith(`${f}/`))) {
      problems.push(`${p} holds the source code or the person's settings, which the orchestrator never writes`);
      continue;
    }
    named.push(f);
  }
  return { problems, own: (file) => named.some((n) => fold(file) === n || fold(file).startsWith(`${n}/`)) };
}

// Checks against the snapshot and git; `own` names the paths the orchestrator
// wrote itself (none for a plain check).
function compare(root, name, own = () => false, take = false) {
  const guard = guardTake(root, name, own, { dry: !take });
  if (guard.problems) return guard;
  const out = outside(root, name, [...(guard.added ?? []), ...(guard.taken ?? [])]);
  const strangers = out.list.filter((p) => !own(p));
  const ok = guard.ok && strangers.length === 0;
  return { ok, guard, outside: strangers, git: out.git, gitNow: out.now };
}

function report(root, result, extra = {}) {
  const { guard, outside: strangers } = result;
  const body = {
    ok: result.ok,
    ...(guard.ok ? {} : { changed: guard.changed, added: guard.added, removed: guard.removed }),
    ...(strangers.length ? { outside: strangers } : {}),
    ...(guard.canvas?.length ? { canvas: guard.canvas } : {}),
    ...(result.git ? {} : { note: 'not a git repository (or no git): only the guarded files were compared' }),
    ...extra,
  };
  const forNext = { ok: result.ok, changed: [...(guard.changed ?? []), ...strangers], added: guard.added ?? [], removed: guard.removed ?? [], canvas: guard.canvas };
  return { ...body, next: nextSteps('guard', forNext, language(root)) };
}

export function check(root, name) {
  if (!NAME.test(name)) return { ok: false, problems: [`not a wave name: ${name} (letters, digits and hyphens)`] };
  const result = compare(root, name);
  if (result.problems) return result;
  return report(root, result);
}

// Runs the merges; returns their results and whether all went through.
function runMerges(root, pairs, { files }) {
  const merged = [];
  for (const { into, parts } of pairs) {
    if (files) {
      const folder = parts.find((p) => { try { return fs.statSync(path.resolve(root, p)).isDirectory(); } catch { return false; } });
      if (folder) { merged.push({ ok: false, into, problems: [`${folder} is a folder: while tasks still run, merge the part files of the tasks that finished, by name (wave.mjs end merges folders)`] }); continue; }
    }
    merged.push(merge(root, { into, parts, clean: true }));
  }
  return merged;
}

const intoPaths = (pairs) => pairs.map((p) => rel(p.into));

function mergeAndTake(root, name, pairs, { files, end }) {
  if (!NAME.test(name)) return { ok: false, problems: [`not a wave name: ${name} (letters, digits and hyphens)`] };
  // Nothing is written while something nobody assigned changed: the person decides first.
  const first = compare(root, name);
  if (first.problems) return first;
  if (!first.ok) return report(root, first, { merged: [], note: 'nothing merged: decide about the changes listed first' });
  const merged = runMerges(root, pairs, { files });
  const targets = intoPaths(pairs).map(fold);
  const own = (f) => targets.includes(fold(f));
  const taken = compare(root, name, own, true);
  if (taken.problems) return taken;
  if (taken.ok && taken.git) saveGit(root, name, taken.gitNow);
  const allMerged = merged.every((m) => m.ok);
  const ok = taken.ok && allMerged;
  if (end && ok) { guardDrop(root, name); fs.rmSync(gitFile(root, name), { force: true }); }
  const brief = merged.map((m) => ({ ok: m.ok, ...(m.into ? { into: m.into } : {}), ...(m.rows !== undefined ? { rows: m.rows, added: m.added, replaced: m.replaced } : {}), ...(m.dropped ? { dropped: m.dropped, droppedNote: m.note } : {}), ...(m.problems?.length ? { problems: m.problems } : {}) }));
  return { ...report(root, { ...taken, ok }, { merged: brief }), ...(end && ok ? { ended: true } : {}) };
}

export function mergeParts(root, name, pairs) {
  return mergeAndTake(root, name, pairs, { files: true, end: false });
}

export function end(root, name, pairs = []) {
  if (pairs.length === 0) {
    if (!NAME.test(name)) return { ok: false, problems: [`not a wave name: ${name} (letters, digits and hyphens)`] };
    const result = compare(root, name);
    if (result.problems) return result;
    if (result.ok) { guardDrop(root, name); fs.rmSync(gitFile(root, name), { force: true }); }
    return { ...report(root, result), ...(result.ok ? { ended: true } : {}) };
  }
  return mergeAndTake(root, name, pairs, { files: false, end: true });
}

export function accept(root, name, list) {
  if (!NAME.test(name)) return { ok: false, problems: [`not a wave name: ${name} (letters, digits and hyphens)`] };
  if (list.length === 0) return { ok: false, problems: ['name the paths you wrote yourself'] };
  const { problems, own } = ownPaths(root, list);
  if (problems.length) return { ok: false, problems };
  const taken = compare(root, name, own, true);
  if (taken.problems) return taken;
  if (taken.ok && taken.git) saveGit(root, name, taken.gitNow);
  return report(root, taken, taken.ok ? { taken: taken.guard.taken } : {});
}

export function main(argv) {
  const [command, name, ...rest] = argv;
  let root = process.cwd();
  const pairs = [];
  const paths = [];
  for (let i = 0; i < rest.length; i += 1) {
    const arg = rest[i];
    const value = rest[i + 1];
    if (arg === '--root' && value !== undefined) { root = value; i += 1; continue; }
    if (arg === '--into' && value !== undefined) { pairs.push({ into: value, parts: [] }); i += 1; continue; }
    if (arg === '--parts' && value !== undefined && pairs.length) { pairs.at(-1).parts.push(value); i += 1; continue; }
    if (arg.startsWith('--')) return usage();
    paths.push(arg);
  }
  if (!name || name.startsWith('--')) return usage();
  if (pairs.some((p) => p.parts.length === 0)) return usage();
  if (!fs.existsSync(path.join(root, 'openspec'))) {
    console.error(`wave: no openspec/ folder in ${path.resolve(root)}. Run this from the repository root or pass --root DIR.`);
    return 2;
  }
  let result;
  if (command === 'start' && !pairs.length && !paths.length) result = start(root, name);
  else if (command === 'check' && !pairs.length && !paths.length) result = check(root, name);
  else if (command === 'merge' && pairs.length && !paths.length) result = mergeParts(root, name, pairs);
  else if (command === 'accept' && !pairs.length && paths.length) result = accept(root, name, paths);
  else if (command === 'end' && !paths.length) result = end(root, name, pairs);
  else return usage();
  console.log(JSON.stringify(result, null, 2));
  return result.ok ? 0 : 1;
}

function usage() {
  console.error([
    'Usage: node wave.mjs start NAME',
    '       node wave.mjs check NAME',
    '       node wave.mjs merge NAME --into ARTIFACT --parts PART_FILE [--parts ...] [--into ... --parts ...]',
    '       node wave.mjs accept NAME PATH [PATH ...]',
    '       node wave.mjs end NAME [--into ARTIFACT --parts PART_FILE_OR_FOLDER ...]',
    '       (each also takes --root DIR)',
  ].join('\n'));
  return 2;
}

function invokedDirectly() {
  if (!process.argv[1]) return false;
  try { return fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url)); } catch { return false; }
}

if (invokedDirectly()) process.exitCode = main(process.argv.slice(2));
