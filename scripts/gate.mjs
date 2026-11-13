#!/usr/bin/env node
// Mechanical checks the orchestrator runs before the steps a person must approve.
// OpenSpec itself does not stop `archive --yes` on unticked or missing items.
//
//   node gate.mjs review --change <change>                 before archiving a reviewed change
//                                                          (survey, target-design, extract-*, amend-*)
//   node gate.mjs port-ready --capability <capability>     before creating a port change
//   node gate.mjs port-done --change port-<capability>     before archiving a port change
//   node gate.mjs baseline --capability <capability>       the baseline hash a port records
//   node gate.mjs guard --save <name>                      before a wave: snapshot the hashes of the files no
//                                                          subagent may write (active review.md and questions.md,
//                                                          plan.md, lessons.md, openspec/specs/, openspec/config.yaml,
//                                                          source files)
//   node gate.mjs guard --compare <name>                   after the wave: list the paths that changed since
//                                                          (exit 1 when any did: read the lists)
//   node gate.mjs guard                                    one hash over the same files
//
// Prints { ok, problems, next } as JSON (guard --compare: { ok, changed, added, removed, next })
// and exits 0 when ok, 1 when not, 2 on bad usage. `next.person` holds sentences in
// the person's language (--lang ja|en, else the artifact language) for what only the
// person can do; `next.agent` holds the problems the agent fixes itself.
// Run it from the repository root (or pass --root DIR). Files may use CRLF line
// endings and a UTF-8 BOM; UTF-16 files are rejected.
import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
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

// Returns the file's text, or null when it is missing. A file that is not UTF-8
// (Windows PowerShell 5.1 writes UTF-16 with `>` and Out-File) would read as
// text with nothing in it, so it is reported in `problems` instead of trusted.
export function readIf(file, problems) {
  let buffer;
  try { if (!fs.statSync(file).isFile()) return null; buffer = fs.readFileSync(file); } catch { return null; }
  const utf16 = (buffer[0] === 0xff && buffer[1] === 0xfe) || (buffer[0] === 0xfe && buffer[1] === 0xff);
  if (utf16 || buffer.includes(0)) {
    problems.push(`${path.basename(file)} is not UTF-8 (it looks like UTF-16); save it again as UTF-8`);
    return '';
  }
  return buffer.toString('utf8').replace(/^\uFEFF/, '');
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
export const plain = (s) => s.replace(/<!--|-->/g, ' ').replace(/[*_`[\]()]/g, '').replace(/\s+/g, ' ').trim();
export const norm = (s) => plain(s).toLowerCase();

// A change's schema from its .openspec.yaml; a change without one is read as an
// extract change, the only kind the first version of the kit had.
export function changeSchema(dir) {
  const meta = readIf(path.join(dir, '.openspec.yaml'), []) ?? '';
  return meta.match(/^schema:\s*["']?([^"'\s#]+)/m)?.[1] ?? 'spec-relay-extract';
}

// A rerun of a change gets a `-v<n>` suffix (`survey-v2`), because OpenSpec
// cannot archive two changes of the same name on the same day.
export const baseName = (change) => change.replace(/-v\d+$/, '');

// The newest archived change named `name` (or `name-v<n>`): its folder, or null.
export function archivedChange(root, name) {
  const dir = path.join(root, 'openspec/changes/archive');
  let entries = [];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name); } catch { return null; }
  const found = entries.map((entry) => {
    const m = entry.match(/^(\d{4}-\d{2}-\d{2})-(.+?)(?:-v(\d+))?$/);
    return m && m[2] === name ? { entry, date: m[1], version: Number(m[3] ?? 1) } : null;
  }).filter(Boolean).sort((a, b) => a.date.localeCompare(b.date) || a.version - b.version);
  return found.length ? path.join(dir, found[found.length - 1].entry) : null;
}

// Rows of every Markdown table in the text (header and separator rows dropped).
export function tableRows(text) {
  const rows = [];
  const lines = unfencedLines(stripComments(text ?? ''));
  for (let i = 0; i < lines.length; i += 1) {
    if (!/^\s*\|/.test(lines[i]) || !/^\s*\|?\s*:?-{2,}/.test(lines[i + 1] ?? '')) continue;
    for (i += 2; i < lines.length && /^\s*\|/.test(lines[i]); i += 1) {
      rows.push(lines[i].trim().replace(/^\|/, '').replace(/\|$/, '').split(/(?<!\\)\|/).map((c) => c.trim()));
    }
  }
  return rows;
}

const withoutId = (s, letter) => norm(plain(s).replace(new RegExp(`^${letter}\\d+\\s*[.:)-]?\\s*`, 'i'), ''));

function commonReview(dir, problems) {
  const review = readIf(path.join(dir, 'review.md'), problems);
  if (review === null) return null;
  const reviewer = stripComments(review).match(/^Reviewer:[ \t]*(.*)$/m);
  if (!reviewer || PLACEHOLDER.test(reviewer[1].trim())) problems.push('review.md names no reviewer ("Reviewer: <name>")');
  const boxes = checkboxes(review);
  if (boxes.length === 0) problems.push('review.md has no checklist items');
  for (const box of boxes.filter((b) => !b.done)) problems.push(`not ticked: ${box.body}`);
  return boxes;
}

// Each named item needs exactly one review box `<letter><n> <name>`.
function requireItems(boxes, letter, names, what, where) {
  const items = boxes.filter((b) => new RegExp(`^${letter}\\d+\\b`, 'i').test(b.plain)).map((b) => withoutId(b.plain, letter));
  const problems = [];
  for (const name of names) {
    const count = items.filter((item) => item === norm(name)).length;
    if (count !== 1) problems.push(`${what} has ${count === 0 ? 'no' : 'more than one'} review item: "${name}"${where ? ` (${where})` : ''}`);
  }
  return problems;
}

export function screenNames(text) {
  return unfencedLines(stripComments(text ?? '')).map((line) => line.match(/^###\s*Screen:\s*(.+?)\s*$/i)).filter(Boolean).map((m) => m[1]);
}

// Every requirement and screen needs a crosscheck row whose verdict is
// `confirmed` or `question Q<n>`.
// `questions` is the set of question ids with a review item, or null when the
// change has no questions (an amendment), where only `confirmed` passes. The
// whole verdict cell must be the verdict, and an item may have one row only.
function checkCrosscheck(dir, requirements, screens, problems, questions = null) {
  const text = readIf(path.join(dir, 'crosscheck.md'), problems);
  if (text === null) { problems.push('crosscheck.md is missing'); return; }
  const rows = tableRows(text).map(([item = '', verdict = '']) => ({ item: plain(item), verdict: norm(verdict).replace(/[.。]$/, '') }));
  const fix = questions ? 'fix and check again, or move it to questions.md as "question Q<n>"' : 'fix and check again';
  for (const [letter, names, what] of [['R', requirements, 'requirement'], ['S', screens, 'screen']]) {
    for (const name of names) {
      const found = rows.filter((r) => withoutId(r.item, letter) === norm(name));
      if (found.length === 0) { problems.push(`${what} has no crosscheck row: "${name}"`); continue; }
      if (found.length > 1) { problems.push(`${what} has more than one crosscheck row: "${name}"; keep only the current verdict`); continue; }
      const { verdict } = found[0];
      const q = verdict.match(/^question (q\d+)$/);
      if (q && questions) {
        const id = `Q${Number(q[1].slice(1))}`;
        if (!questions.has(id)) problems.push(`crosscheck of ${what} "${name}" points to ${id}, which is not in questions.md with a review item`);
      } else if (verdict !== 'confirmed') problems.push(`crosscheck of ${what} "${name}" is "${verdict || 'blank'}"; resolve it (${fix})`);
    }
  }
}

function specRequirements(dir, problems) {
  const specs = walk(path.join(dir, 'specs')).filter((f) => f.endsWith('.md'));
  if (specs.length === 0) problems.push('the change has no spec files');
  const found = [];
  for (const file of specs) {
    const where = path.relative(dir, file).replace(/\\/g, '/');
    const names = requirementNames(readIf(file, problems) ?? '');
    if (names.length === 0) problems.push(`no requirements found in ${where}`);
    found.push(...names.map((name) => ({ name, where })));
  }
  return found;
}

function checkExtract(dir, boxes, problems) {
  const requirements = specRequirements(dir, problems);
  for (const { name, where } of requirements) problems.push(...requireItems(boxes, 'R', [name], 'requirement', where));
  const screensText = readIf(path.join(dir, 'screens.md'), problems);
  if (screensText === null) problems.push('screens.md is missing (write "None" when the capability has no screens)');
  const screens = screenNames(screensText);
  // A heading the gate does not read (## Screen:, ### 画面:) would need no review.
  if (screensText && screens.length === 0 && !/^none\.?$/i.test(stripComments(screensText).replace(/^#.*$/gm, '').trim())) {
    problems.push('screens.md has no "### Screen: <name>" heading; write each screen under one, or only "None" when there are no screens');
  }
  problems.push(...requireItems(boxes, 'S', screens, 'screen', 'screens.md'));

  const questions = readIf(path.join(dir, 'questions.md'), problems);
  if (questions === null) problems.push('questions.md is missing');
  const qItems = new Map();
  for (const box of boxes) {
    const m = box.plain.match(/^Q(\d+)\b/i);
    if (m) qItems.set(`Q${Number(m[1])}`, box.plain);
  }
  const asked = new Set((questions === null ? [] : questionIds(questions)).filter((id) => qItems.has(id)));
  checkCrosscheck(dir, requirements.map((r) => r.name), screens, problems, asked);
  for (const id of questions === null ? [] : questionIds(questions)) {
    const item = qItems.get(id);
    if (!item) { problems.push(`question has no review item: ${id}`); continue; }
    const decision = item.match(/decision:\s*(.*)$/i);
    if (!decision || PLACEHOLDER.test(decision[1].trim())) problems.push(`question has no recorded decision: ${id}`);
  }
}

function checkAmend(dir, boxes, problems) {
  const reason = readIf(path.join(dir, 'reason.md'), problems);
  const said = stripComments(reason ?? '').replace(/^#.*$/gm, '').replace(/^\s*(?:[-*+]|\d+[.)])\s*(?:(?:MODIFIED|ADDED|REMOVED)\s*\/?\s*)*:?\s*$/gim, '').trim();
  if (reason === null || !said) problems.push('reason.md gives no reason');
  const requirements = specRequirements(dir, problems);
  for (const { name, where } of requirements) problems.push(...requireItems(boxes, 'R', [name], 'requirement', where));
  // REMOVED requirements have no behavior left to check.
  const removed = new Set();
  for (const file of walk(path.join(dir, 'specs')).filter((f) => f.endsWith('.md'))) {
    let inRemoved = false;
    for (const line of unfencedLines(readIf(file, []) ?? '')) {
      const h2 = line.match(/^##\s+(.*)$/);
      if (h2) inRemoved = /^removed\b/i.test(h2[1].trim());
      const r = line.match(REQUIREMENT);
      if (r && inRemoved) removed.add(r[1]);
    }
  }
  checkCrosscheck(dir, requirements.map((r) => r.name).filter((n) => !removed.has(n)), [], problems);
}

const CONTEXT = /^###\s*Context:\s*([a-z0-9]+(?:-[a-z0-9]+)*)\s*$/;
export function contextIds(text) {
  return unfencedLines(stripComments(text ?? '')).map((line) => line.trim().match(CONTEXT)).filter(Boolean).map((m) => m[1]);
}

// The value after "<label>:" in openspec/config.yaml's context, or the fallback.
export function configValue(root, label, fallback) {
  const config = readIf(path.join(root, 'openspec/config.yaml'), []) ?? '';
  const m = config.match(new RegExp(`^\\s*${label}[^:\\n]*:[ \\t]*(.+?)\\s*$`, 'm'));
  return m && !/\{\{/.test(m[1]) ? m[1] : fallback;
}

const relPath = (p) => p.replace(/\\/g, '/').replace(/^\.\//, '').replace(/^\/+/, '');

// Files under the source root the inventory must cover. Kit and tool folders are
// not source code: .git, openspec/, the target root and OpenSpec's generated
// Copilot files.
export const cleanValue = (v) => v.replace(/\s+#.*$/, '').trim().replace(/^(["'`])(.*)\1$/, '$2').trim();

// Files under the source root the inventory must cover, or null when the source
// root is not a folder inside the repository. In a git repository these are the
// files git tracks or would track (so .vs/, desktop.ini and other ignored local
// files do not count); otherwise every file on disk. Kit and tool folders are
// never source code: .git, openspec/, the target root and OpenSpec's generated
// Copilot files.
export function sourceFiles(root) {
  const source = relPath(cleanValue(configValue(root, 'Source root', '.'))).replace(/\/$/, '');
  const target = relPath(cleanValue(configValue(root, 'Target root', ''))).replace(/\/$/, '');
  const base = path.resolve(root);
  const sourceDir = path.resolve(base, source || '.');
  const rel = path.relative(base, sourceDir);
  if (rel.startsWith('..') || path.isAbsolute(rel)) return null;
  try { if (!fs.statSync(sourceDir).isDirectory()) return null; } catch { return null; }
  const prefix = rel ? `${rel.split(path.sep).join('/')}/` : '';
  const skip = (file) => file === '.git' || file.startsWith('.git/') || file === 'openspec' || file.startsWith('openspec/')
    || (target && (file === target || file.startsWith(`${target}/`)))
    || /^\.github\/(skills\/openspec-|prompts\/opsx-)/.test(file);

  const git = spawnSync('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard', '--', prefix || '.'], { cwd: base, encoding: 'buffer', windowsHide: true, maxBuffer: Infinity });
  if (git.status === 0 && git.stdout) {
    const listed = git.stdout.toString('utf8').split('\0').filter(Boolean);
    // Use git's list only when this folder is the repository top. `--show-cdup` is empty there.
    // Comparing paths instead breaks on Windows (8.3 short names, drive letter case, slashes).
    const top = spawnSync('git', ['rev-parse', '--show-cdup'], { cwd: base, encoding: 'utf8', windowsHide: true });
    if (top.status === 0 && top.stdout.trim() === '') {
      return [...new Set(listed.filter((f) => !skip(f) && fs.existsSync(path.join(base, f))))].sort();
    }
  }
  const out = [];
  const visit = (dirRel) => {
    let entries = [];
    try { entries = fs.readdirSync(path.join(base, dirRel), { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const child = dirRel ? `${dirRel}/${e.name}` : e.name;
      if (skip(child)) continue;
      if (e.isDirectory()) visit(child);
      else if (e.isFile()) out.push(child);
    }
  };
  visit(prefix.replace(/\/$/, ''));
  return out.sort();
}

function checkSurvey(root, dir, boxes, problems) {
  const map = readIf(path.join(dir, 'context-map.md'), problems);
  const contexts = contextIds(map);
  if (contexts.length === 0) problems.push('context-map.md defines no context ("### Context: <id>", lowercase kebab-case)');
  for (const id of contexts) {
    if (!boxes.some((b) => new RegExp(`^K\\d+\\s*[.:)-]?\\s*${id}(?![\\w-])`, 'i').test(b.plain))) problems.push(`context has no review item: ${id}`);
  }
  const known = new Set([...contexts, 'excluded']);
  // Paths keep every character (my_module, Copy (1).php, [id].php); only code marks go.
  const rows = tableRows(readIf(path.join(dir, 'inventory.md'), problems)).map(([p = '', context = '']) => ({ path: relPath(p.trim().replace(/^`(.*)`$/, '$1').trim()), context: plain(context).toLowerCase() })).filter((r) => r.path);
  for (const row of rows.filter((r) => !known.has(r.context))) problems.push(`inventory row "${row.path}" names an unknown context "${row.context}"`);
  const files = sourceFiles(root);
  if (files === null) {
    problems.push(`the source root "${configValue(root, 'Source root', '.')}" in openspec/config.yaml is not a folder inside the repository`);
  } else if (files.length === 0) problems.push('the source root holds no files');
  const uncovered = (files ?? []).filter((file) => !rows.some((r) => r.path === file || (r.path.endsWith('/') && file.startsWith(r.path))));
  for (const file of uncovered.slice(0, 20)) problems.push(`source file not in the inventory: ${file}`);
  if (uncovered.length > 20) problems.push(`...and ${uncovered.length - 20} more source files not in the inventory`);

  const caps = capabilityList(readIf(path.join(dir, 'capabilities.md'), problems));
  if (caps.length === 0) problems.push('capabilities.md lists no capability ("1. `billing/invoice` ...")');
  const keys = new Map();
  for (const cap of caps) {
    if (!/^[a-z0-9]+(?:-[a-z0-9]+)*(?:\/[a-z0-9]+(?:-[a-z0-9]+)*)+$/.test(cap)) { problems.push(`capability "${cap}" is not <context>/<name> in lowercase kebab-case`); continue; }
    if (!contexts.includes(cap.split('/')[0])) problems.push(`capability "${cap}" starts with an unknown context`);
    const key = cap.split('/').join('-');
    if (/-v\d+$/.test(key)) problems.push(`capability "${cap}" gives the change name extract-${key}, which ends like a rerun suffix (-v<n>); rename it`);
    if (keys.has(key)) problems.push(`capabilities ${keys.get(key)} and ${cap} get the same change name`);
    keys.set(key, cap);
  }
}

// Capability paths listed as top-level items that start with a backticked path
// ("1. `billing/invoice` ..."), as in the survey's capabilities.md and the plan.
export function capabilityList(text) {
  const caps = [];
  for (const line of unfencedLines(stripComments(text ?? ''))) {
    const m = line.match(/^ ?(?:[-*+]|\d+[.)])\s+`([^`]+)`/);
    if (m) caps.push(m[1]);
  }
  return caps;
}

export const PLAN = 'openspec/spec-relay/plan.md';
// What the person's corrections taught; only the orchestrator writes it.
export const LESSONS = 'openspec/spec-relay/lessons.md';

// The capabilities of the plan's capability list: top-level items under the
// "## Capabilities" heading (as status.mjs reads it), not follow-up notes.
export function planCapabilities(text) {
  const lines = [];
  let inList = false;
  for (const line of unfencedLines(stripComments(text ?? ''))) {
    const h2 = line.match(/^##\s+(.*)$/);
    if (h2) inList = /^(?:\d+[.)]?\s*)?(?:capabilit(?:y|ies)\b|機能|ケイパビリティ)/i.test(h2[1].trim());
    else if (inList) lines.push(line);
  }
  return capabilityList(lines.join('\n'));
}

// The capability path of every spec file in a change (specs/<capability>/spec.md).
function specCapabilities(dir) {
  return [...new Set(walk(path.join(dir, 'specs')).filter((f) => f.endsWith('.md'))
    .map((f) => path.relative(path.join(dir, 'specs'), path.dirname(f)).split(path.sep).join('/'))
    .filter((cap) => cap && cap !== '.'))];
}

// An extract or amend change needs the reviewed capability list: the archived
// survey, a capability from its list (or the plan), and the change name that
// belongs to that capability. An amendment also needs the baseline it corrects.
function checkSurveyed(root, change, dir, kind, problems) {
  const survey = archivedChange(root, 'survey');
  if (!survey) problems.push(`no archived survey change: ${kind} changes need the reviewed capability list; finish the survey review and archive it first`);
  const listed = new Set([
    ...(survey ? capabilityList(readIf(path.join(survey, 'capabilities.md'), problems)) : []),
    ...planCapabilities(readIf(path.join(root, PLAN), problems)),
  ]);
  for (const cap of specCapabilities(dir)) {
    if (survey && !listed.has(cap)) problems.push(`capability ${cap} is not in the archived survey's capabilities.md or in ${PLAN}; add it to the plan's capability list before this review`);
    if (/-v\d+$/.test(cap.split('/').join('-'))) { problems.push(`capability ${cap} ends like a rerun suffix (-v<n>), so its change cannot be told from a rerun; rename it in the plan`); continue; }
    const expected = `${kind}-${cap.split('/').join('-')}`;
    if (baseName(change) !== expected) problems.push(`change ${change} holds the spec of ${cap}; a ${kind} change of ${cap} is named ${expected}`);
    if (kind === 'amend' && !readIf(path.join(root, 'openspec/specs', ...cap.split('/'), 'spec.md'), problems)) {
      problems.push(`no baseline spec at openspec/specs/${cap}/spec.md to amend; an amendment corrects an archived extract change`);
    }
  }
}

function checkTarget(root, dir, boxes, problems) {
  const survey = archivedChange(root, 'survey');
  if (!survey) { problems.push('no archived survey change; review and archive the survey first'); return; }
  const contexts = contextIds(readIf(path.join(survey, 'context-map.md'), problems));
  for (const [file, what] of [['architecture.md', 'module'], ['verification.md', 'verification levels']]) {
    const firsts = tableRows(readIf(path.join(dir, file), problems)).map(([first = '']) => plain(first).toLowerCase());
    for (const id of contexts.filter((c) => !firsts.includes(c))) problems.push(`${file} has no ${what} row for context ${id}`);
  }
  // One review item per module (A<n>) and per context's verification levels (E<n>).
  for (const [letter, what] of [['A', 'module'], ['E', 'verification levels']]) {
    for (const id of contexts) {
      if (!boxes.some((b) => new RegExp(`^${letter}\\d+\\s*[.:)-]?\\s*\\W*${id}(?![\\w-])`, 'i').test(b.plain))) problems.push(`the ${what} of context ${id} has no review item (${letter}<n> ${id})`);
    }
  }
}

export function checkReview(root, change) {
  const problems = [];
  const dir = path.join(root, 'openspec/changes', change);
  if (!fs.existsSync(dir)) return { ok: false, problems: [`change not found: ${change} (an archived change cannot be checked)`] };
  const boxes = commonReview(dir, problems);
  if (boxes === null) return { ok: false, problems: ['review.md is missing'] };
  const schema = changeSchema(dir);
  if (schema === 'spec-relay-extract') { checkSurveyed(root, change, dir, 'extract', problems); checkExtract(dir, boxes, problems); }
  else if (schema === 'spec-relay-amend') { checkSurveyed(root, change, dir, 'amend', problems); checkAmend(dir, boxes, problems); }
  else if (schema === 'spec-relay-survey') checkSurvey(root, dir, boxes, problems);
  else if (schema === 'spec-relay-target') checkTarget(root, dir, boxes, problems);
  else problems.push(`schema ${schema} has no review gate`);
  return { ok: problems.length === 0, problems };
}

// sha256 of the baseline spec with line endings and BOM normalised, so a Windows
// checkout (CRLF) gives the same hash.
export function baselineHash(root, capability) {
  const parts = capabilitySegments(capability);
  if (parts.length === 0 || parts.includes('..')) return null;
  const text = readIf(path.join(root, 'openspec/specs', ...parts, 'spec.md'), []);
  if (!text) return null;
  return crypto.createHash('sha256').update(text.replace(/\r\n?/g, '\n')).digest('hex');
}

export const capabilitySegments = (capability) => capability.split(/[\\/]+/).filter((part) => part && part !== '.');

// The files subagents must never write: every active change's review.md and
// questions.md, the plan, the lessons, the baseline specs, the config and the
// source files.
// The orchestrator saves a snapshot of their hashes before a wave and compares
// after it. Git cannot show a tick in an untracked or already modified
// review.md, nor an edit to an already modified or untracked source file; this
// can. Files git ignores (bin/, obj/, .vs/) are not source files and not hashed.
export function guardFiles(root, warnings = []) {
  const changes = path.join(root, 'openspec/changes');
  const files = [];
  try {
    for (const e of fs.readdirSync(changes, { withFileTypes: true })) {
      if (e.isDirectory() && e.name !== 'archive') files.push(path.join(changes, e.name, 'review.md'), path.join(changes, e.name, 'questions.md'));
    }
  } catch { /* no changes yet */ }
  files.push(path.join(root, PLAN), path.join(root, LESSONS), ...walk(path.join(root, 'openspec/specs')), path.join(root, 'openspec/config.yaml'));
  const out = {};
  for (const f of files) {
    try { if (fs.statSync(f).isFile()) out[path.relative(root, f).split(path.sep).join('/')] = crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex'); } catch { /* gone */ }
  }
  const source = sourceFiles(root);
  if (source === null) warnings.push(`the source root "${configValue(root, 'Source root', '.')}" is not a folder inside the repository, so source files are not guarded`);
  for (const f of source ?? []) {
    try { out[f] = crypto.createHash('sha256').update(fs.readFileSync(path.join(root, f))).digest('hex'); } catch (error) {
      if (fs.existsSync(path.join(root, f))) warnings.push(`could not read ${f} (${error.code ?? error.message}); it is not guarded`);
    }
  }
  return out;
}

export function guardHash(root) {
  const files = guardFiles(root);
  const lines = Object.keys(files).sort().map((f) => `${f}\0${files[f]}`);
  return { ok: true, sha256: crypto.createHash('sha256').update(lines.join('\n')).digest('hex'), files: lines.length };
}

const GUARD_DIR = 'openspec/spec-relay/work/guard';
const snapshotFile = (root, name) => path.join(root, GUARD_DIR, `${name}.json`);

export function guardSave(root, name) {
  if (!/^[a-z0-9][a-z0-9-]{0,63}$/i.test(name)) return { ok: false, problems: [`not a snapshot name: ${name} (letters, digits and hyphens)`] };
  const warnings = [];
  const files = guardFiles(root, warnings);
  const file = snapshotFile(root, name);
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, `${JSON.stringify(files, null, 1)}\n`);
  } catch (error) { return { ok: false, problems: [`could not write ${GUARD_DIR}/${name}.json: ${error.message}`] }; }
  return { ok: true, snapshot: `${GUARD_DIR}/${name}.json`, files: Object.keys(files).length, ...(warnings.length ? { warnings } : {}) };
}

// Lists only the paths that differ, so a large source tree never floods the
// orchestrator's context. The orchestrator ignores the paths it changed itself.
export function guardCompare(root, name) {
  if (!/^[a-z0-9][a-z0-9-]{0,63}$/i.test(name)) return { ok: false, problems: [`not a snapshot name: ${name} (letters, digits and hyphens)`] };
  let before;
  try { before = JSON.parse(fs.readFileSync(snapshotFile(root, name), 'utf8')); } catch {
    return { ok: false, problems: [`no snapshot ${GUARD_DIR}/${name}.json; run gate.mjs guard --save ${name} before the wave`] };
  }
  const now = guardFiles(root);
  const changed = Object.keys(now).filter((f) => f in before && before[f] !== now[f]).sort();
  const added = Object.keys(now).filter((f) => !(f in before)).sort();
  const removed = Object.keys(before).filter((f) => !(f in now)).sort();
  const cap = (list) => (list.length > 50 ? [...list.slice(0, 50), `...and ${list.length - 50} more`] : list);
  return { ok: changed.length + added.length + removed.length === 0, changed: cap(changed), added: cap(added), removed: cap(removed) };
}

export function checkPortReady(root, capability) {
  const problems = [];
  const parts = capabilitySegments(capability);
  if (parts.length === 0 || parts.includes('..')) return { ok: false, problems: [`not a capability path: ${capability}`] };
  if (!readIf(path.join(root, 'openspec/specs', ...parts, 'spec.md'), problems)) {
    problems.push(`no baseline spec at openspec/specs/${parts.join('/')}/spec.md; archive its reviewed extract change first`);
  }
  const key = parts.join('-');
  const active = (() => { try { return fs.readdirSync(path.join(root, 'openspec/changes')); } catch { return []; } })();
  for (const kind of ['extract', 'amend']) {
    for (const name of active.filter((n) => baseName(n) === `${kind}-${key}`)) {
      problems.push(`${kind} change ${name} is still active; finish its review and archive it first`);
    }
  }
  if (!archivedChange(root, 'survey')) problems.push('no archived survey change: map the bounded contexts and have them reviewed first');
  if (!archivedChange(root, 'target-design')) problems.push('no archived target-design change: decide the target design and have it reviewed first');
  return { ok: problems.length === 0, problems };
}

export function checkPortDone(root, change) {
  const dir = path.join(root, 'openspec/changes', change);
  const problems = [];
  const tasks = readIf(path.join(dir, 'tasks.md'), problems);
  if (tasks === null) return { ok: false, problems: [`tasks.md not found for change ${change}`] };
  const boxes = checkboxes(tasks);
  problems.push(...boxes.filter((b) => !b.done).map((b) => `not done: ${b.body}`));
  if (boxes.length === 0) problems.push('tasks.md has no tasks');
  const proposal = readIf(path.join(dir, 'proposal.md'), problems) ?? '';
  const recorded = [...stripComments(proposal).matchAll(/`([^`]+)`\s*sha256:\s*([0-9a-f]{64})/gi)];
  if (recorded.length === 0) problems.push('proposal.md records no baseline hash ("- `<capability>` sha256:<hash>" under ## Baseline; get it with gate.mjs baseline)');
  const own = baseName(change).replace(/^port-/, '');
  if (recorded.length && !recorded.some(([, capability]) => capabilitySegments(capability).join('-') === own)) {
    problems.push(`proposal.md records no baseline hash for this change's own capability (${own.replace(/-/g, '/')} or similar); add it with gate.mjs baseline`);
  }
  for (const [, capability, hash] of recorded) {
    const now = baselineHash(root, capability);
    if (now === null) problems.push(`no baseline spec for ${capability}`);
    else if (now !== hash.toLowerCase()) problems.push(`the baseline of ${capability} changed after this port started (an amendment was archived); update the port to it, then record the new hash`);
  }
  return { ok: problems.length === 0, problems };
}

// The person's language for `next`: --lang, else the artifact language in openspec/config.yaml.
export function language(root, requested) {
  let value = requested;
  if (!value) {
    const config = readIf(path.join(root, 'openspec/config.yaml'), []) ?? '';
    value = config.match(/^\s*Artifact language:\s*(.+?)\s*$/m)?.[1] ?? 'en';
  }
  return /^["']?(ja|jp|japanese|日本語)/i.test(value.trim()) ? 'ja' : 'en';
}

const NEXT = {
  en: {
    unticked: (n, list) => `${n} review item${n === 1 ? ' is' : 's are'} not approved yet (${list}). Approve them in the chat, or tick them in review.md yourself.`,
    reviewer: 'review.md has no reviewer name ("Reviewer:"). Tell me the name to record.',
    decision: (list) => `These questions have no decision yet: ${list}. Decide what the new system should do.`,
    archive: 'Everything is reviewed. Answer whether this change may be archived (that makes it final).',
    portArchive: 'Every task is done and checked. Answer whether the port may be archived.',
    activeReview: (name) => `${name} is still under review. Finish that review first.`,
    foundation: (name) => (name === 'survey'
      ? 'The survey (the map of contexts and the capability list) is not reviewed and archived yet. I prepare it; its review is yours, and this step waits for it.'
      : 'The target design is not reviewed and archived yet. I prepare it; its review is yours, and implementation waits for it.'),
    guard: (list) => `Files outside the subagents' assignments changed (${list}). Decide: undo the change, or keep it. The results of this wave are not used until you decide.`,
  },
  ja: {
    unticked: (n, list) => `レビューで未承認の項目が ${n} 件あります（${list}）。チャットで承認を伝えるか、review.md で自分でチェックしてください。`,
    reviewer: 'review.md に承認者の名前（Reviewer:）がありません。記録する名前を教えてください。',
    decision: (list) => `判断がまだの質問があります（${list}）。新しいシステムでどうするかを決めてください。`,
    archive: 'すべてレビュー済みです。この change を archive（確定）してよいかを答えてください。',
    portArchive: 'すべてのタスクが完了し、確認も済みました。実装を archive してよいかを答えてください。',
    activeReview: (name) => `${name} のレビューがまだ終わっていません。先にそのレビューを終えてください。`,
    foundation: (name) => (name === 'survey'
      ? '調査（コンテキストの地図と capability の一覧）がまだレビュー・archive されていません。AI が用意するので、そのレビューをお願いします。この工程はそれを待ちます。'
      : '移行先の設計がまだレビュー・archive されていません。AI が用意するので、そのレビューをお願いします。実装はそれを待ちます。'),
    guard: (list) => `割り当て外のファイルが変わりました（${list}）。元に戻すか、そのまま受け入れるかを決めてください。決まるまで、この波の結果は使いません。`,
  },
};

const shortList = (items, max = 3) => `${items.slice(0, max).join(', ')}${items.length > max ? ', ...' : ''}`;

// What a stop needs from whom: `person` holds sentences in the person's language
// to pass on as they are; `agent` holds the problems the agent fixes itself
// (in English, for the agent). A passing review or port-done still needs the
// person's answer before the archive.
export function nextSteps(command, result, lang = 'en') {
  const words = NEXT[lang] ?? NEXT.en;
  const person = [];
  let agent = [];
  if (command === 'guard') {
    if (!result.ok && result.changed) person.push(words.guard(shortList([...result.changed, ...result.added, ...result.removed])));
    return { person, agent: result.problems ?? [] };
  }
  const problems = result.problems ?? [];
  const unticked = problems.filter((p) => p.startsWith('not ticked: ')).map((p) => plain(p.slice('not ticked: '.length)).split(' ')[0]);
  const undecided = problems.filter((p) => p.startsWith('question has no recorded decision: ')).map((p) => p.slice('question has no recorded decision: '.length));
  const active = problems.map((p) => p.match(/^(?:extract|amend) change (\S+) is still active/)?.[1]).filter(Boolean);
  const foundation = ['survey', 'target-design'].filter((name) => problems.some((p) => p.startsWith(`no archived ${name} change`)));
  if (unticked.length) person.push(words.unticked(unticked.length, shortList(unticked)));
  if (problems.some((p) => p.startsWith('review.md names no reviewer'))) person.push(words.reviewer);
  if (undecided.length) person.push(words.decision(shortList(undecided)));
  for (const name of active) person.push(words.activeReview(name));
  for (const name of foundation) person.push(words.foundation(name));
  agent = problems.filter((p) => !/^(not ticked: |review\.md names no reviewer|question has no recorded decision: |(?:extract|amend) change \S+ is still active|no archived (?:survey|target-design) change)/.test(p));
  if (result.ok && command === 'review') person.push(words.archive);
  if (result.ok && command === 'port-done') person.push(words.portArchive);
  return { person, agent };
}

export function main(argv) {
  const [command, ...rest] = argv;
  const opts = { root: process.cwd() };
  for (let i = 0; i < rest.length; i += 2) {
    const key = { '--change': 'change', '--capability': 'capability', '--root': 'root', '--save': 'save', '--compare': 'compare', '--lang': 'lang' }[rest[i]];
    if (!key || rest[i + 1] === undefined) return usage();
    opts[key] = rest[i + 1];
  }
  if (!fs.existsSync(path.join(opts.root, 'openspec'))) {
    console.error(`gate: no openspec/ folder in ${path.resolve(opts.root)}. Run this from the repository root or pass --root DIR.`);
    return 2;
  }
  let result;
  if (command === 'review' && opts.change) result = checkReview(opts.root, opts.change);
  else if (command === 'port-ready' && opts.capability) result = checkPortReady(opts.root, opts.capability);
  else if (command === 'port-done' && opts.change) result = checkPortDone(opts.root, opts.change);
  else if (command === 'guard' && opts.save !== undefined && opts.compare === undefined) result = guardSave(opts.root, opts.save);
  else if (command === 'guard' && opts.compare !== undefined && opts.save === undefined) result = guardCompare(opts.root, opts.compare);
  else if (command === 'guard' && opts.save === undefined && opts.compare === undefined) result = guardHash(opts.root);
  else if (command === 'baseline' && opts.capability) {
    const sha256 = baselineHash(opts.root, opts.capability);
    result = sha256 ? { ok: true, capability: opts.capability, sha256 } : { ok: false, problems: [`no baseline spec for ${opts.capability}`] };
  }
  else return usage();
  if (command !== 'baseline' && !(command === 'guard' && opts.compare === undefined)) {
    result.next = nextSteps(command, result, language(opts.root, opts.lang));
  }
  console.log(JSON.stringify(result, null, 2));
  return result.ok ? 0 : 1;
}

function usage() {
  console.error('Usage: node gate.mjs review --change NAME | port-ready --capability PATH | port-done --change NAME | baseline --capability PATH | guard [--save NAME | --compare NAME] [--root DIR] [--lang ja|en]');
  return 2;
}

function invokedDirectly() {
  if (!process.argv[1]) return false;
  try { return fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url)); } catch { return false; }
}

if (invokedDirectly()) process.exitCode = main(process.argv.slice(2));
