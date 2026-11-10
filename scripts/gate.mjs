#!/usr/bin/env node
// Mechanical checks the orchestrator runs before the steps a person must approve.
// OpenSpec itself does not stop `archive --yes` on unticked or missing items.
//
//   node gate.mjs review --change extract-<capability>     before archiving an extract change
//   node gate.mjs port-ready --capability <capability>     before creating a port change
//   node gate.mjs port-done --change port-<capability>     before archiving a port change
//
// Prints { ok, problems } as JSON and exits 0 when ok, 1 when not, 2 on bad usage.
// Run it from the repository root (or pass --root DIR).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Same shapes OpenSpec 1.17.0 counts as tasks and requirements, so the gate never
// sees fewer items than `openspec instructions apply` or `openspec archive` do.
const CHECKBOX = /^\s*(?:[-*+]|\d+[.)])\s+\[(.?)\]\s*(.*)$/;
const REQUIREMENT = /^###\s*Requirement:\s*(.+?)\s*$/i;
const FENCE = /^\s*(```|~~~)/;
const PLACEHOLDER = /^(<.*>|tbd|todo|tba|n\/a|-|\.\.\.|…)?$/i;
const ticked = (mark) => mark.trim().toLowerCase() === 'x';
const stripComments = (text) => text.replace(/<!--[\s\S]*?-->/g, '');

function readIf(file) {
  try { return fs.statSync(file).isFile() ? fs.readFileSync(file, 'utf8') : null; } catch { return null; }
}

function walk(dir) {
  let entries = [];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return []; }
  return entries.flatMap((e) => (e.isDirectory() ? walk(path.join(dir, e.name)) : [path.join(dir, e.name)]));
}

// Lines outside fenced code blocks. HTML comments are kept on purpose: OpenSpec
// counts boxes and requirements inside them too.
function unfencedLines(text) {
  let fenced = false;
  return text.split(/\r?\n/).filter((line) => {
    if (FENCE.test(line)) { fenced = !fenced; return false; }
    return !fenced;
  });
}

export function checkboxes(text) {
  return unfencedLines(text).map((line) => line.match(CHECKBOX)).filter(Boolean)
    .map(([, mark, body]) => ({ done: ticked(mark), body: body.trim(), plain: plain(body) }));
}

export function requirementNames(text) {
  return unfencedLines(text).map((line) => line.match(REQUIREMENT)).filter(Boolean).map((m) => m[1]);
}

export function questionIds(text) {
  const ids = new Set();
  for (const line of unfencedLines(stripComments(text))) {
    for (const m of line.matchAll(/\bQ(\d+)\b/gi)) ids.add(`Q${Number(m[1])}`);
  }
  return [...ids];
}

// Drops Markdown emphasis, brackets and comment markers so "**Q1**" and "[Q1]" read as "Q1".
const plain = (s) => s.replace(/<!--|-->/g, ' ').replace(/[*_`[\]()]/g, '').replace(/\s+/g, ' ').trim();
const norm = (s) => plain(s).toLowerCase();

export function checkReview(root, change) {
  const problems = [];
  const dir = path.join(root, 'openspec/changes', change);
  if (!fs.existsSync(dir)) return { ok: false, problems: [`change not found: ${change} (an archived change cannot be checked)`] };
  const review = readIf(path.join(dir, 'review.md'));
  if (review === null) return { ok: false, problems: ['review.md is missing'] };

  const reviewer = stripComments(review).match(/^Reviewer:[ \t]*(.*)$/m);
  if (!reviewer || PLACEHOLDER.test(reviewer[1].trim())) problems.push('review.md names no reviewer ("Reviewer: <name>")');

  const boxes = checkboxes(review);
  if (boxes.length === 0) problems.push('review.md has no checklist items');
  for (const box of boxes.filter((b) => !b.done)) problems.push(`not ticked: ${box.body}`);

  const specs = walk(path.join(dir, 'specs')).filter((f) => f.endsWith('.md'));
  if (specs.length === 0) problems.push('the change has no spec files');
  const rItems = boxes.filter((b) => /^R\d+\b/i.test(b.plain)).map((b) => norm(b.plain.replace(/^R\d+\s*[.:)-]?\s*/i, '')));
  for (const file of specs) {
    for (const name of requirementNames(fs.readFileSync(file, 'utf8'))) {
      const count = rItems.filter((item) => item === norm(name)).length;
      if (count !== 1) {
        problems.push(`requirement has ${count === 0 ? 'no' : 'more than one'} review item: "${name}" (${path.relative(dir, file)})`);
      }
    }
  }

  const questions = readIf(path.join(dir, 'questions.md'));
  if (questions === null) problems.push('questions.md is missing');
  const qItems = new Map();
  for (const box of boxes) {
    const m = box.plain.match(/^Q(\d+)\b/i);
    if (m) qItems.set(`Q${Number(m[1])}`, box.plain);
  }
  for (const id of questions === null ? [] : questionIds(questions)) {
    const item = qItems.get(id);
    if (!item) { problems.push(`question has no review item: ${id}`); continue; }
    const decision = item.match(/decision:\s*(.*)$/i);
    if (!decision || PLACEHOLDER.test(decision[1].trim())) problems.push(`question has no recorded decision: ${id}`);
  }
  return { ok: problems.length === 0, problems };
}

export const capabilitySegments = (capability) => capability.split(/[\\/]+/).filter((part) => part && part !== '.');

export function checkPortReady(root, capability) {
  const problems = [];
  const parts = capabilitySegments(capability);
  if (parts.length === 0 || parts.includes('..')) return { ok: false, problems: [`not a capability path: ${capability}`] };
  if (!readIf(path.join(root, 'openspec/specs', ...parts, 'spec.md'))) {
    problems.push(`no baseline spec at openspec/specs/${parts.join('/')}/spec.md; archive its reviewed extract change first`);
  }
  const extract = `extract-${parts.join('-')}`;
  if (fs.existsSync(path.join(root, 'openspec/changes', extract))) {
    problems.push(`extract change ${extract} is still active; finish its review and archive it first`);
  }
  return { ok: problems.length === 0, problems };
}

export function checkPortDone(root, change) {
  const dir = path.join(root, 'openspec/changes', change);
  const tasks = readIf(path.join(dir, 'tasks.md'));
  if (tasks === null) return { ok: false, problems: [`tasks.md not found for change ${change}`] };
  const boxes = checkboxes(tasks);
  const problems = boxes.filter((b) => !b.done).map((b) => `not done: ${b.body}`);
  if (boxes.length === 0) problems.push('tasks.md has no tasks');
  return { ok: problems.length === 0, problems };
}

export function main(argv) {
  const [command, ...rest] = argv;
  const opts = { root: process.cwd() };
  for (let i = 0; i < rest.length; i += 2) {
    const key = { '--change': 'change', '--capability': 'capability', '--root': 'root' }[rest[i]];
    if (!key || rest[i + 1] === undefined) return usage();
    opts[key] = rest[i + 1];
  }
  let result;
  if (command === 'review' && opts.change) result = checkReview(opts.root, opts.change);
  else if (command === 'port-ready' && opts.capability) result = checkPortReady(opts.root, opts.capability);
  else if (command === 'port-done' && opts.change) result = checkPortDone(opts.root, opts.change);
  else return usage();
  console.log(JSON.stringify(result, null, 2));
  return result.ok ? 0 : 1;
}

function usage() {
  console.error('Usage: node gate.mjs review --change NAME | port-ready --capability PATH | port-done --change NAME [--root DIR]');
  return 2;
}

function invokedDirectly() {
  if (!process.argv[1]) return false;
  try { return fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url)); } catch { return false; }
}

if (invokedDirectly()) process.exitCode = main(process.argv.slice(2));
