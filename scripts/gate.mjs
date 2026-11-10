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

const CHECKBOX = /^\s*[-*]\s+\[(.?)\]\s*(.*)$/;
const ticked = (mark) => mark.trim().toLowerCase() === 'x';
const stripComments = (text) => text.replace(/<!--[\s\S]*?-->/g, '');

function readIf(file) {
  try { return fs.readFileSync(file, 'utf8'); } catch { return null; }
}

function walk(dir) {
  let entries = [];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return []; }
  return entries.flatMap((e) => (e.isDirectory() ? walk(path.join(dir, e.name)) : [path.join(dir, e.name)]));
}

export function checkboxes(text) {
  return stripComments(text).split(/\r?\n/).map((line) => line.match(CHECKBOX)).filter(Boolean)
    .map(([, mark, body]) => ({ done: ticked(mark), body: body.trim() }));
}

export function requirementNames(text) {
  return [...stripComments(text).matchAll(/^###\s+Requirement:\s*(.+?)\s*$/gm)].map((m) => m[1]);
}

export function questionIds(text) {
  const ids = new Set();
  for (const m of stripComments(text).matchAll(/^\s*(?:[-*]\s+|#+\s+)?\**(Q\d+)\b/gm)) ids.add(m[1]);
  return [...ids];
}

const norm = (s) => s.toLowerCase().replace(/\s+/g, ' ').trim();

export function checkReview(root, change) {
  const problems = [];
  const dir = path.join(root, 'openspec/changes', change);
  if (!fs.existsSync(dir)) return { ok: false, problems: [`change not found: ${change} (an archived change cannot be checked)`] };
  const review = readIf(path.join(dir, 'review.md'));
  if (review === null) return { ok: false, problems: ['review.md is missing'] };

  const reviewer = stripComments(review).match(/^Reviewer:[ \t]*(.*)$/m);
  if (!reviewer || !reviewer[1].trim()) problems.push('review.md names no reviewer ("Reviewer: <name>")');

  const boxes = checkboxes(review);
  if (boxes.length === 0) problems.push('review.md has no checklist items');
  for (const box of boxes.filter((b) => !b.done)) problems.push(`not ticked: ${box.body}`);

  const specs = walk(path.join(dir, 'specs')).filter((f) => f.endsWith('.md'));
  if (specs.length === 0) problems.push('the change has no spec files');
  const rLines = boxes.filter((b) => /^R\d+\b/.test(b.body)).map((b) => norm(b.body.replace(/^R\d+\s*/, '')));
  for (const file of specs) {
    for (const name of requirementNames(fs.readFileSync(file, 'utf8'))) {
      if (!rLines.some((line) => line.startsWith(norm(name)))) {
        problems.push(`requirement has no review item: "${name}" (${path.relative(dir, file)})`);
      }
    }
  }

  const questions = readIf(path.join(dir, 'questions.md'));
  const qLines = new Map(boxes.filter((b) => /^Q\d+\b/.test(b.body)).map((b) => [b.body.match(/^(Q\d+)/)[1], b.body]));
  for (const id of questions === null ? [] : questionIds(questions)) {
    const line = qLines.get(id);
    if (!line) { problems.push(`question has no review item: ${id}`); continue; }
    const decision = line.match(/decision:\s*(.*)$/i);
    if (!decision || !decision[1].trim()) problems.push(`question has no recorded decision: ${id}`);
  }
  return { ok: problems.length === 0, problems };
}

export function checkPortReady(root, capability) {
  const problems = [];
  if (!readIf(path.join(root, 'openspec/specs', capability, 'spec.md'))) {
    problems.push(`no baseline spec at openspec/specs/${capability}/spec.md; archive its reviewed extract change first`);
  }
  const extract = `extract-${capability.replace(/\//g, '-')}`;
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
