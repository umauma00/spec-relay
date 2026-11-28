#!/usr/bin/env node
// The orchestrator's bookkeeping around subagent work, one command per moment,
// so that it does not spend a model turn on each step (save the guard, list
// git's changes, compare both, merge each part file, save the guard again).
//
//   node wave.mjs start <name> [--root DIR]
//       before the first task: saves the guard snapshot (gate.mjs guard --save)
//       and the paths git reports as changed or untracked. Refuses a name
//       whose wave is still open (end it first, or check it).
//   node wave.mjs check <name> [--root DIR]
//       any time: what changed since the snapshot that nobody assigned, the
//       guarded files by hash and, in a git repository, the paths outside the
//       places subagents write (openspec/changes/, the work folder, the guide,
//       the target root) that git now reports and did not at the start
//   node wave.mjs merge <name> --into <artifact> --parts <file> [--into ... --parts ...] [--root DIR]
//       while other tasks still run: checks, merges the part files of the
//       tasks that returned with merge.mjs --clean, and takes the merged
//       artifacts into the snapshot. Parts are files, never a folder (another
//       task may still be writing there), except for walkthrough.md: its parts
//       go in one call as their folder, once every walkthrough task of that
//       change has returned, because the rows of one merge for an entry point
//       replace the rows it had (two checkers of a shared handler add up only
//       within one merge).
//   node wave.mjs accept <name> <path> [<path> ...] [--root DIR]
//       right after the orchestrator wrote guarded files itself while tasks
//       still run (a tick, a question, an archive, a script that writes one):
//       takes those paths into the snapshot (a folder covers what is under it;
//       a change folder also covers its archived copy). Never the source code,
//       the config or a folder that holds more than one change. Run check right
//       before such a write: a path that changed before it was someone else's.
//   node wave.mjs keep <name> <path> [<path> ...] [--root DIR]
//       after the person decided to keep a change nobody assigned (they edited
//       openspec/config.yaml, a source file, a review.md outside the canvas):
//       takes those paths into the snapshot, source and config too
//   node wave.mjs end <name> [--into <artifact> --parts <file-or-folder> ...] [--root DIR]
//       when every task has returned: checks, merges (folders allowed) and
//       removes the snapshot
//
// The canvas edits the person makes in review.md meanwhile are theirs (listed
// under `canvas`, never a problem), as with gate.mjs guard. A path that changed
// and that nobody named stops merge and end: nothing is merged then, the
// snapshot stays, and the orchestrator asks the person. accept and keep take
// the paths they name in any case and list the others, which stay reported.
//
// Known limit, as with comparing git status by hand: a file outside the
// assigned places that git already reported at the start can change unseen.
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
const badName = (name) => ({ ok: false, problems: [`not a wave name: ${name} (letters, digits and hyphens)`] });
// A repository path as the guard writes it, from what the person or a task typed.
const repoPath = (root, p) => rel(path.relative(path.resolve(root), path.resolve(root, String(p))).split(path.sep).join('/'));

function git(root, args) {
  return execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 64 * 1024 * 1024 });
}

// The paths git reports as changed or untracked under `root` (relative to it,
// also when the repository's top is above it), or null outside a git
// repository (or without git).
export function gitChanges(root) {
  let out;
  let prefix;
  try {
    prefix = git(root, ['rev-parse', '--show-prefix']).trim();
    out = git(root, ['status', '--porcelain', '--untracked-files=all', '-z', '--', '.']);
  } catch { return null; }
  const paths = new Set();
  const parts = out.split('\0');
  for (let i = 0; i < parts.length; i += 1) {
    const entry = parts[i];
    if (entry.length < 4) continue;
    const p = rel(entry.slice(3));
    if (p.startsWith(prefix)) paths.add(p.slice(prefix.length));
    // A rename or copy is followed by its old path.
    if (/^(?:[RC].|.[RC])/.test(entry)) i += 1;
  }
  return [...paths].sort();
}

// Where subagents write by assignment: the active changes' folders, the work
// folder, the guide, the local records and the target root. With the target
// root "." (or none), every path outside openspec/ and the top-level dot
// folders (.github, .vscode, .agents...) counts as the target's. Guarded files
// are compared by hash, not here.
function assigned(root) {
  const target = fold(rel(cleanValue(configValue(root, 'Target root', '') ?? '')));
  const places = ['openspec/changes/', 'openspec/spec-relay/work/', 'openspec/spec-relay/local/', 'openspec/spec-relay/guide/'];
  return (p) => {
    const f = fold(p);
    if (places.some((d) => f.startsWith(d)) && !f.startsWith('openspec/changes/archive/')) return true;
    if (target === '' || target === '.') return !f.startsWith('openspec/') && !f.startsWith('.');
    return f === target || f.startsWith(`${target}/`);
  };
}

function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')) ?? fallback; } catch { return fallback; }
}

// The git paths that are new since the start and lie outside the assigned places.
function outside(root, name, alsoGuarded = []) {
  const before = readJson(gitFile(root, name), null);
  if (!Array.isArray(before)) return { list: [], git: false };
  const now = gitChanges(root);
  if (now === null) return { list: [], git: true, problem: 'git status worked when the wave started and fails now: the files outside the guarded ones were not compared; run git status yourself' };
  const had = new Set(before.map((e) => fold(e)));
  const ok = assigned(root);
  // The snapshot's paths (and the guarded files added since) are compared by hash already.
  const guarded = new Set([...Object.keys(readJson(guardSnapshot(root, name), {})), ...alsoGuarded].map(fold));
  const list = now.filter((p) => !had.has(fold(p)) && !ok(p) && !guarded.has(fold(p)));
  return { list, git: true, now };
}

const saveGit = (root, name, paths) => fs.writeFileSync(gitFile(root, name), `${JSON.stringify(paths)}\n`);

export function start(root, name) {
  if (!NAME.test(name)) return badName(name);
  if (fs.existsSync(guardSnapshot(root, name))) {
    return { ok: false, problems: [`wave ${name} is still open: run wave.mjs check ${name} or end ${name}, or start a wave with another name; a task you start now joins the open wave`] };
  }
  const saved = guardSave(root, name);
  if (!saved.ok) return saved;
  const paths = gitChanges(root);
  try { if (paths) saveGit(root, name, paths); else fs.rmSync(gitFile(root, name), { force: true }); } catch (error) { return { ok: false, problems: [`could not write the git list: ${error.message}`] }; }
  return { ...saved, git: paths !== null };
}

// Folders too wide to name as one's own write: each holds the config or many changes.
const WIDE = new Set(['openspec', 'openspec/changes', 'openspec/changes/archive', 'openspec/specs', 'openspec/spec-relay']);

// The paths an own write may cover. `kept`: the person decided, so the source
// code and the config may be named too (never the whole repository).
function ownPaths(root, list, { kept = false } = {}) {
  const problems = [];
  const sources = kept ? [] : (sourceFiles(root) ?? []).map(fold);
  const named = [];
  for (const raw of list) {
    const p = repoPath(root, raw);
    if (!p || p === '.' || p.split('/').includes('..')) { problems.push(`not a path inside the repository: ${raw}`); continue; }
    const f = fold(p);
    if (!kept && (WIDE.has(f) || 'openspec/config.yaml'.startsWith(`${f}/`))) { problems.push(`${p} holds the config or many changes: name the files or the one change folder you wrote`); continue; }
    if (!kept && (f === 'openspec/config.yaml' || sources.some((s) => s === f || s.startsWith(`${f}/`)))) {
      problems.push(`${p} holds the source code or the person's settings, which the orchestrator never writes; when the person decided to keep a change there, run wave.mjs keep`);
      continue;
    }
    named.push(f);
  }
  // A change folder also covers its archived copy (openspec/changes/archive/<date>-<change>/).
  const archived = named.map((n) => n.match(/^openspec\/changes\/([^/]+)$/)?.[1]).filter((c) => c && c !== 'archive');
  const own = (file) => {
    const f = fold(file);
    if (named.some((n) => f === n || f.startsWith(`${n}/`))) return true;
    const m = f.match(/^openspec\/changes\/archive\/\d{4}-\d{2}-\d{2}-([^/]+)\//);
    return Boolean(m && archived.includes(m[1]));
  };
  return { problems, own };
}

// Compares with the snapshot and git; `own` names the paths the orchestrator
// wrote itself (none for a plain check). With `take`, those move into the snapshot.
function compare(root, name, own = () => false, take = false) {
  const guard = guardTake(root, name, own, { dry: !take });
  if (guard.problems) return guard;
  const out = outside(root, name, [...(guard.added ?? []), ...(guard.taken ?? [])]);
  const strangers = out.list.filter((p) => !own(p));
  if (take && out.now && strangers.length === 0) saveGit(root, name, out.now);
  const ok = guard.ok && strangers.length === 0 && !out.problem;
  return { ok, guard, outside: strangers, git: out.git, gitProblem: out.problem };
}

function report(root, result, extra = {}, agent = []) {
  const { guard, outside: strangers } = result;
  const body = {
    ok: result.ok,
    ...(guard.changed.length + guard.added.length + guard.removed.length ? { changed: guard.changed, added: guard.added, removed: guard.removed } : {}),
    ...(strangers.length ? { outside: strangers } : {}),
    ...(guard.canvas?.length ? { canvas: guard.canvas } : {}),
    ...(result.gitProblem ? { problems: [result.gitProblem] } : {}),
    ...(result.git ? {} : { note: 'not a git repository (or no git): only the guarded files were compared' }),
    ...extra,
  };
  // The person hears only about paths nobody assigned; a merge's own problems are the agent's.
  const strangersOk = guard.ok && strangers.length === 0;
  const forNext = { ok: strangersOk, ...(strangersOk ? {} : { changed: [...guard.changed, ...strangers], added: guard.added, removed: guard.removed }), canvas: guard.canvas, problems: [...(result.gitProblem ? [result.gitProblem] : []), ...agent] };
  return { ...body, next: nextSteps('guard', forNext, language(root)) };
}

export function check(root, name) {
  if (!NAME.test(name)) return badName(name);
  const result = compare(root, name);
  if (result.problems) return result;
  return report(root, result);
}

const isFolder = (root, p) => { try { return fs.statSync(path.resolve(root, p)).isDirectory(); } catch { return false; } };
const isWalkthrough = (into) => /(^|[\\/])walkthrough\.md$/i.test(into);

function runMerges(root, pairs, { midWave }) {
  return pairs.map(({ into, parts }) => {
    if (midWave && isWalkthrough(into) && !parts.every((p) => isFolder(root, p))) {
      return { ok: false, into, problems: [`${into}: merge the walkthrough parts of this change in one call, as their folder, once every walkthrough task of it has returned (the rows of one merge for an entry point replace the rows it had)`] };
    }
    const folder = midWave && !isWalkthrough(into) && parts.find((p) => isFolder(root, p));
    if (folder) return { ok: false, into, problems: [`${folder} is a folder: while tasks still run, merge the part files of the tasks that returned, by name (wave.mjs end merges folders)`] };
    return merge(root, { into, parts, clean: true });
  });
}

function mergeAndTake(root, name, pairs, { midWave, end }) {
  if (!NAME.test(name)) return badName(name);
  // Nothing is written while something nobody assigned changed: the person decides first.
  const first = compare(root, name);
  if (first.problems) return first;
  if (!first.ok) return report(root, first, { merged: [], note: 'nothing merged: decide about the changes listed first' });
  const merged = runMerges(root, pairs, { midWave });
  const targets = pairs.map((p) => fold(repoPath(root, p.into)));
  const taken = compare(root, name, (f) => targets.includes(fold(f)), true);
  if (taken.problems) return taken;
  const ok = taken.ok && merged.every((m) => m.ok);
  if (end && ok) { guardDrop(root, name); fs.rmSync(gitFile(root, name), { force: true }); }
  const brief = merged.map((m) => ({ ok: m.ok, ...(m.into ? { into: m.into } : {}), ...(m.rows !== undefined ? { rows: m.rows, added: m.added, replaced: m.replaced } : {}), ...(m.dropped ? { dropped: m.dropped, droppedNote: m.note } : {}), ...(m.problems?.length ? { problems: m.problems } : {}) }));
  const failed = merged.filter((m) => !m.ok).flatMap((m) => (m.problems ?? []).map((p) => `merge ${m.into ?? ''}: ${p}`));
  return { ...report(root, { ...taken, ok }, { merged: brief }, failed), ...(end && ok ? { ended: true } : {}) };
}

export function mergeParts(root, name, pairs) {
  return mergeAndTake(root, name, pairs, { midWave: true, end: false });
}

export function end(root, name, pairs = []) {
  if (pairs.length === 0) {
    if (!NAME.test(name)) return badName(name);
    const result = compare(root, name);
    if (result.problems) return result;
    if (result.ok) { guardDrop(root, name); fs.rmSync(gitFile(root, name), { force: true }); }
    return { ...report(root, result), ...(result.ok ? { ended: true } : {}) };
  }
  return mergeAndTake(root, name, pairs, { midWave: false, end: true });
}

function take(root, name, list, kept) {
  if (!NAME.test(name)) return badName(name);
  if (list.length === 0) return { ok: false, problems: [kept ? 'name the paths the person decided to keep' : 'name the paths you wrote yourself'] };
  const { problems, own } = ownPaths(root, list, { kept });
  if (problems.length) return { ok: false, problems };
  const taken = compare(root, name, own, true);
  if (taken.problems) return taken;
  return report(root, taken, { taken: taken.guard.taken });
}

export const accept = (root, name, list) => take(root, name, list, false);
export const keep = (root, name, list) => take(root, name, list, true);

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
  else if (command === 'keep' && !pairs.length && paths.length) result = keep(root, name, paths);
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
    '       node wave.mjs keep NAME PATH [PATH ...]',
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
