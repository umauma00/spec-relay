#!/usr/bin/env node
// Mechanical checks the orchestrator runs before the steps a person must approve.
// OpenSpec itself does not stop `archive --yes` on unticked or missing items.
//
//   node gate.mjs review --change <change>                 before archiving a reviewed change
//                                                          (survey, target-design, extract-*, amend-*, finish)
//   node gate.mjs port-ready --capability <capability>     before creating a port change
//   node gate.mjs port-done --change port-<capability>     before archiving a port change (tasks, baseline, the
//                                                          verify.mjs run on the current code, a tagged test per
//                                                          scenario, no TODO(port) left, the port crosscheck)
//   node gate.mjs baseline --capability <capability>       the baseline hash a port records
//   node gate.mjs coverage                                 every kept source file has a capability in the plan, and
//                                                          every analyzed capability's source map holds its files
//   node gate.mjs db-hash                                  the hash of the exported database definitions
//                                                          (openspec/spec-relay/db/) the survey records
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
import { checkFinish } from './finish.mjs';
import { COMPARE_COMMAND, casesDigest, isCompareCommand, parseOptions, portOptionProblem, readCases, words as commandWords } from './compare.mjs';
import { checkSurveyCoverage, checkSourceMap, checkTrace, checkAmendSourceMap, checkCoverage, assignment } from './coverage.mjs';
import { checkLedger } from './sites.mjs';
import { E2E_DIR, OLD_RECEIPT, e2eCommandOptions, e2eDigest, isE2eCommand, oldReceipt } from './e2e.mjs';

// Same shapes OpenSpec 2.1.1 (and 1.17.0, 2.0.0) counts as tasks and requirements, so the gate never
// sees fewer items than `openspec instructions apply` or `openspec archive` do.
const CHECKBOX = /^\s*(?:[-*+]|\d+[.)])\s+\[(.?)\]\s*(.*)$/;
const REQUIREMENT = /^###\s*Requirement:\s*(.+?)\s*$/i;
const FENCE = /^\s*(```|~~~)/;
export const PLACEHOLDER = /^(<.*>|tbd|todo|tba|n\/a|-|\.\.\.|…)?$/i;
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

// Notes under a review item, one per sub-list line: "  - fix: ..." (the
// reviewer wants a change), "  - hold: ..." (the reviewer cannot decide yet)
// and "  - fixed: ..." (the agent's answer to the fix above it). The person
// writes fix and hold, in the file or with the canvas; the agent writes fixed.
// Comments and fenced code are left out, so a template's example is no note.
// The line may also stand unindented right under the item (a browser shows the
// example without its spaces) and use a full-width colon (a Japanese IME).
export const REMARK = /^\s*(?:[-*+]|\d+[.)])\s+(?:\*\*|__)?(fix|hold|fixed)(?:\*\*|__)?\s*[:：]\s*(.*)$/i;
const ITEM_ID = /^([A-Za-z])(\d+)\b/;

// Each review item that has an id, with its notes in file order:
// [{ id, done, remarks: [{ kind, text }], openFix }]. A fix is open until a
// fixed line follows it.
export function reviewRemarks(text) {
  const lines = String(text ?? '').replace(/<!--[\s\S]*?-->/g, (m) => m.replace(/[^\r\n]/g, ' ')).split(/\r?\n/);
  const items = [];
  let item = null;
  let fenced = false;
  for (const line of lines) {
    if (FENCE.test(line)) { fenced = !fenced; item = null; continue; }
    if (fenced) continue;
    const box = line.match(CHECKBOX);
    if (box) {
      const k = plain(box[2]).match(ITEM_ID);
      item = k ? { id: `${k[1].toUpperCase()}${Number(k[2])}`, done: ticked(box[1]), remarks: [] } : null;
      if (item) items.push(item);
      continue;
    }
    if (/^#{1,6}\s/.test(line)) { item = null; continue; }
    const r = item ? line.match(REMARK) : null;
    if (r) item.remarks.push({ kind: r[1].toLowerCase(), text: r[2].trim() });
    else if (line.trim() && !/^\s/.test(line)) item = null;
  }
  for (const it of items) {
    it.openFix = openFix(it.remarks);
    it.state = noteState(it.done, it.remarks);
  }
  return items;
}

// How far the person's part of a review is, from review.md alone: what is not
// ticked, the change requests the agent has not answered, the items on hold, the
// questions without a decision, and whether a reviewer is named. `ready` when
// nothing is left: the page then offers "review complete". The gate still checks
// everything else (the artifacts) before an archive.
export function reviewProgress(text) {
  const review = String(text ?? '');
  const boxes = checkboxes(review);
  const idOf = (b) => { const k = b.plain.match(ITEM_ID); return k ? `${k[1].toUpperCase()}${Number(k[2])}` : b.plain.slice(0, 40); };
  const notes = reviewRemarks(review);
  const reviewer = stripComments(review).match(/^Reviewer:[ \t]*(.*)$/m);
  const undecided = boxes.filter((b) => /^Q\d+\b/i.test(b.plain)).filter((b) => {
    const decision = b.plain.match(/decision:\s*(.*)$/i);
    return !decision || PLACEHOLDER.test(decision[1].trim());
  }).map(idOf);
  const left = {
    unticked: boxes.filter((b) => !b.done).map(idOf),
    fix: notes.filter((i) => i.openFix).map((i) => i.id),
    hold: notes.filter((i) => i.state === 'hold').map((i) => i.id),
    undecided,
    reviewer: !reviewer || PLACEHOLDER.test(reviewer[1].trim()),
  };
  const total = boxes.length;
  const ready = total > 0 && !left.unticked.length && !left.fix.length && !left.hold.length && !left.undecided.length && !left.reviewer;
  return { ready, total, left, reviewer: left.reviewer ? '' : reviewer[1].trim() };
}

// A fix is open until a fixed line follows it.
export function openFix(remarks) {
  const kinds = (remarks ?? []).map((r) => r.kind);
  const last = kinds.lastIndexOf('fix');
  return last >= 0 && !kinds.slice(last + 1).includes('fixed');
}

// Where an item stands, the same for the gate, the page and the canvas:
// fix (a change asked for and not answered, even on a ticked line), done
// (ticked), hold or fixed (whichever of the two comes last), or open.
export function noteState(done, remarks) {
  if (openFix(remarks)) return 'fix';
  if (done) return 'done';
  return (remarks ?? []).filter((r) => r.kind === 'hold' || r.kind === 'fixed').pop()?.kind ?? 'open';
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

// The answer the agent recommends for each question of questions.md, and why:
// Map id -> { recommended, why }. Written as two list lines under the question,
// "  - Recommended: ..." and "  - Why: ..." (推奨 / 理由 are read too), or as the
// Recommended and Why columns of a table that lists the questions. The person
// still decides; the review shows the recommendation beside the decision.
export const ADVICE = /^\s*(?:[-*+]|\d+[.)])\s+(?:\*\*|__)?(recommended|recommendation|推奨|why|reason|理由)(?:\*\*|__)?\s*[:：](?:\*\*|__)?\s*(.*)$/i;
const adviceKind = (word) => (/^(recommended|recommendation|推奨)$/i.test(word) ? 'recommended' : 'why');
export function questionAdvice(text) {
  const map = new Map();
  let current = null;
  let header = null;
  for (const line of unfencedLines(stripComments(text ?? ''))) {
    const advice = line.match(ADVICE);
    if (advice) {
      if (current) {
        const entry = map.get(current);
        const kind = adviceKind(advice[1]);
        entry[kind] ||= advice[2].trim();
      }
      continue;
    }
    if (/^\s*\|/.test(line)) {
      const cells = line.trim().replace(/^\|/, '').replace(/\|$/, '').split(/(?<!\\)\|/).map((c) => c.trim());
      if (/^\s*\|?\s*:?-{2,}/.test(line)) continue;
      const id = cells.map((c) => plain(c).match(/^Q(\d+)\b/i)).find(Boolean);
      if (!id) { header = cells.map((c) => norm(c)); current = null; continue; }
      current = `Q${Number(id[1])}`;
      if (!map.has(current)) map.set(current, { recommended: '', why: '' });
      const entry = map.get(current);
      (header ?? []).forEach((h, i) => {
        if (/^(recommended|recommendation|推奨)/.test(h)) entry.recommended ||= cells[i] ?? '';
        else if (/^(why|reason|理由)/.test(h)) entry.why ||= cells[i] ?? '';
      });
      continue;
    }
    header = null;
    // A question starts on a heading or an unindented line that names it, or a
    // line that begins with its id; an indented line that only mentions another
    // question ("see Q1") does not move the advice to that one.
    const id = line.match(/\bQ(\d+)\b/i);
    const starts = id && (/^(?:#{1,6}\s|\S)/.test(line) || /^Q\d/i.test(plain(line.replace(/^\s*(?:[-*+]|\d+[.)])\s+/, ''))));
    if (starts) {
      current = `Q${Number(id[1])}`;
      if (!map.has(current)) map.set(current, { recommended: '', why: '' });
    } else if (/^#{1,6}\s/.test(line)) current = null;
  }
  for (const entry of map.values()) {
    entry.recommended = entry.recommended.trim();
    entry.why = entry.why.trim();
  }
  return map;
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

// Rows of every Markdown table, each with its table's header cells (lowercase,
// plain), so a column can be found by name.
export function headedRows(text) {
  const rows = [];
  const lines = unfencedLines(stripComments(text ?? ''));
  const cells = (line) => line.trim().replace(/^\|/, '').replace(/\|$/, '').split(/(?<!\\)\|/).map((c) => c.trim());
  for (let i = 0; i < lines.length; i += 1) {
    if (!/^\s*\|/.test(lines[i]) || !/^\s*\|?\s*:?-{2,}/.test(lines[i + 1] ?? '')) continue;
    const header = cells(lines[i]).map((c) => plain(c).toLowerCase());
    for (i += 2; i < lines.length && /^\s*\|/.test(lines[i]); i += 1) rows.push({ header, cells: cells(lines[i]) });
  }
  return rows;
}

// The lines under the `## <heading>` that matches, up to the next `## ` heading.
// null when no such heading. Comments are dropped first, so a "## " line inside a
// comment ends nothing; a closing "##" and a leading number are ignored.
export function section(text, heading) {
  const out = [];
  let inside = false;
  let found = false;
  for (const line of unfencedLines(stripComments(text ?? ''))) {
    const h2 = line.match(/^##\s+(.*?)(?:\s+#+)?\s*$/);
    if (h2) { inside = heading.test(plain(h2[1].trim()).replace(/^\d+[.)]?\s+/, '')); found ||= inside; continue; }
    if (inside) out.push(line);
  }
  return found ? out.join('\n') : null;
}

// The index of the first header cell that matches, or -1.
export const column = (header, pattern) => header.findIndex((cell) => pattern.test(cell));
// Table cells that say there is nothing: None, なし, -, N/A, or blank.
const NOTHING = /^(?:(?:none|なし|無し|n\/a)\.?|-|—|)$/i;
const HANDLING_COLUMN = /^(handling|扱い)(?![a-z0-9_])/i;
const POLICY_COLUMN = /^(policy|方針)(?![a-z0-9_])/i;
const NOTES_COLUMN = /^(notes?|備考|メモ|理由)(?![a-z0-9_])/i;

const withoutId = (s, letter) => norm(plain(s).replace(new RegExp(`^${letter}\\d+\\b(?:[.:)-]|\\s+(?:[:)]|[.-](?=\\s|$)))?\\s*`, 'i'), ''));

function commonReview(dir, problems) {
  const review = readIf(path.join(dir, 'review.md'), problems);
  if (review === null) return null;
  const reviewer = stripComments(review).match(/^Reviewer:[ \t]*(.*)$/m);
  if (!reviewer || PLACEHOLDER.test(reviewer[1].trim())) problems.push('review.md names no reviewer ("Reviewer: <name>")');
  const boxes = checkboxes(review);
  if (boxes.length === 0) problems.push('review.md has no checklist items');
  for (const box of boxes.filter((b) => !b.done)) problems.push(`not ticked: ${box.body}`);
  // A change the reviewer asked for under an item ("  - fix: ...") that has no
  // "  - fixed: ..." after it yet: the agent still owes it.
  for (const item of reviewRemarks(review).filter((i) => i.openFix)) {
    problems.push(`fix requested and not answered: ${item.id} — ${item.remarks.filter((r) => r.kind === 'fix').pop().text}`);
  }
  // An open item the reviewer put on hold ("  - hold: ...") waits for the reviewer, not the agent.
  for (const item of reviewRemarks(review).filter((i) => i.state === 'hold')) {
    problems.push(`on hold: ${item.id} — ${item.remarks.filter((r) => r.kind === 'hold').pop().text}`);
  }
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

export function specRequirements(dir, problems) {
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

function checkExtract(root, dir, boxes, problems) {
  const requirements = specRequirements(dir, problems);
  for (const capability of specCapabilities(dir)) checkSourceMap(root, dir, capability, problems);
  checkTrace(root, dir, requirements.map((r) => r.name), problems);
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
  checkLedger(root, dir, { requirements: requirements.map((r) => r.name), screens, asked, assignment: assignment(root).map, own: specCapabilities(dir)[0] ?? '', boxes }, problems);
  const advice = questionAdvice(questions);
  for (const id of questions === null ? [] : questionIds(questions)) {
    // The person decides; the agent gives the answer it recommends, and why, so the person can take it.
    const given = advice.get(id);
    if (!given || PLACEHOLDER.test(plain(given.recommended)) || PLACEHOLDER.test(plain(given.why))) {
      problems.push(`question has no recommended answer and reason: ${id} (write "  - Recommended: <answer>" and "  - Why: <reason>" under it in questions.md)`);
    }
    const item = qItems.get(id);
    if (!item) { problems.push(`question has no review item: ${id}`); continue; }
    const decision = item.match(/decision:\s*(.*)$/i);
    if (!decision || PLACEHOLDER.test(decision[1].trim())) problems.push(`question has no recorded decision: ${id}`);
  }
}

function checkAmend(root, dir, boxes, problems) {
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
  const kept = requirements.map((r) => r.name).filter((n) => !removed.has(n));
  checkTrace(root, dir, kept, problems);
  checkAmendSourceMap(root, dir, kept, problems);
  checkCrosscheck(dir, kept, [], problems);
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

// Files under the source root the inventory must cover, and the exported
// database definitions (openspec/spec-relay/db/), or null when the source
// root is not a folder inside the repository. In a git repository these are the
// files git tracks or would track (so .vs/, desktop.ini and other ignored local
// files do not count); otherwise every file on disk. Kit and tool folders are
// never source code: .git, openspec/, the target root and OpenSpec's generated
// Copilot files.
export function sourceFiles(root) {
  const code = repositoryFiles(root);
  return code === null ? null : [...new Set([...code, ...databaseFiles(root)])].sort();
}

function repositoryFiles(root) {
  const source = relPath(cleanValue(configValue(root, 'Source root', '.'))).replace(/\/$/, '');
  const target = relPath(cleanValue(configValue(root, 'Target root', ''))).replace(/\/$/, '');
  const base = path.resolve(root);
  const sourceDir = path.resolve(base, source || '.');
  const rel = path.relative(base, sourceDir);
  if (rel.startsWith('..') || path.isAbsolute(rel)) return null;
  try { if (!fs.statSync(sourceDir).isDirectory()) return null; } catch { return null; }
  const prefix = rel ? `${rel.split(path.sep).join('/')}/` : '';
  const skip = (file) => file === '.git' || file.startsWith('.git/') || file === 'openspec' || file.startsWith('openspec/')
    || (target && target !== '.' && (file.toLowerCase() === target.toLowerCase() || file.toLowerCase().startsWith(`${target.toLowerCase()}/`)))
    || /^\.agents\/skills\/(openspec-|\.openspec-target$)/.test(file);

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

// The database definitions the person exported from the database (DDL of tables,
// views, procedures, triggers, jobs...), for databases whose definitions are not
// in the repository. They are source code like the files under the source root:
// read-only, in the inventory, cited by trace.md.
export const DATABASE_DIR = 'openspec/spec-relay/db';
// The kinds of database objects that hold logic, as database.md and data.md name them.
export const DB_KINDS = ['view', 'procedure', 'function', 'trigger', 'constraint', 'sequence', 'job', 'other'];
const JUNK = /^(desktop\.ini|thumbs\.db|\.ds_store)$/i;

// Repository-relative paths of the files under openspec/spec-relay/db/. In a git
// repository only the files git tracks or would track count, as for source files,
// so a local file a .gitignore rule hides never makes clones disagree.
export function databaseFiles(root) {
  const onDisk = walk(path.join(root, DATABASE_DIR)).filter((f) => !JUNK.test(path.basename(f)))
    .filter((f) => { try { return fs.statSync(f).isFile(); } catch { return false; } })
    .map((f) => path.relative(root, f).split(path.sep).join('/')).sort();
  if (onDisk.length === 0) return onDisk;
  const top = spawnSync('git', ['rev-parse', '--show-cdup'], { cwd: root, encoding: 'utf8', windowsHide: true });
  if (top.status !== 0 || top.stdout.trim() !== '') return onDisk;
  const git = spawnSync('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard', '--', DATABASE_DIR], { cwd: root, encoding: 'buffer', windowsHide: true, maxBuffer: Infinity });
  if (git.status !== 0 || !git.stdout) return onDisk;
  const listed = new Set(git.stdout.toString('utf8').split('\0').filter(Boolean).map((f) => f.toLowerCase()));
  return onDisk.filter((f) => listed.has(f.toLowerCase()));
}

const hasBom16 = (buffer) => (buffer[0] === 0xff && buffer[1] === 0xfe) || (buffer[0] === 0xfe && buffer[1] === 0xff);
const isUtf16 = (buffer, file) => hasBom16(buffer) || (/\.(sql|ddl|txt|csv|tsv|md)$/i.test(file) && buffer.includes(0));

// Definition files saved as UTF-16 (SSMS "Unicode text", `>` in Windows PowerShell 5.1),
// which analysts and the gate cannot read as text.
export function databaseUtf16(root) {
  return databaseFiles(root).filter((f) => { try { return isUtf16(fs.readFileSync(path.join(root, f)), f); } catch { return false; } });
}

// A text file's bytes without a UTF-8 BOM and with CRLF and CR as LF. It works on
// bytes, so Shift_JIS or EUC-JP definitions hash by what they hold.
function normalisedBytes(buffer) {
  const start = buffer[0] === 0xef && buffer[1] === 0xbb && buffer[2] === 0xbf ? 3 : 0;
  const out = Buffer.alloc(buffer.length - start);
  let n = 0;
  for (let i = start; i < buffer.length; i += 1) {
    if (buffer[i] === 0x0d) { out[n++] = 0x0a; if (buffer[i + 1] === 0x0a) i += 1; } else out[n++] = buffer[i];
  }
  return out.subarray(0, n);
}

// sha256 over the definition files (paths relative to openspec/spec-relay/db/ in
// lowercase, because Windows folders ignore case; text with line endings and BOM
// normalised so a Windows checkout gives the same hash), or null when the folder
// holds no file.
export function databaseHash(root) {
  const files = databaseFiles(root);
  if (files.length === 0) return null;
  const lines = files.map((f) => {
    let buffer;
    try { buffer = fs.readFileSync(path.join(root, f)); } catch { buffer = Buffer.from(`unreadable ${f}`); }
    if (!isUtf16(buffer, f) && !buffer.includes(0)) buffer = normalisedBytes(buffer);
    return `${f.slice(DATABASE_DIR.length + 1).toLowerCase()}\0${crypto.createHash('sha256').update(buffer).digest('hex')}`;
  }).sort();
  return crypto.createHash('sha256').update(lines.join('\n')).digest('hex');
}

// The body of the `## <title>` section (up to the next `##` heading), or null.
const sectionNamed = (text, title) => section(text, new RegExp(`^${title.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'i'));

const isNone = (text) => /^(none|なし|該当なし)[.。]?$/i.test(plain(stripComments(text ?? '').replace(/^#.*$/gm, '')));
// The review boxes `<letter><n> <name>` or `<letter><n> <name>: <note>` for this name.
const itemsFor = (boxes, letter, name) => boxes.filter((b) => new RegExp(`^${letter}\\d+\\b`, 'i').test(b.plain))
  .filter((b) => withoutId(b.plain, letter).split(/[:：]/)[0].trim() === norm(name));
// The note after the name: `D1 trigger: keep` gives "keep".
const itemNote = (box) => norm(box.plain.split(/[:：]/).slice(1).join(':'));
const hasId = (boxes, id) => boxes.some((b) => new RegExp(`^${id}\\b`, 'i').test(b.plain));
// The snapshot hash in `## Snapshot` (or anywhere when that heading is gone).
const recordedDbHash = (text) => stripComments(sectionNamed(text, 'Snapshot') ?? text ?? '').match(/sha-?256[^0-9a-f\n]*([0-9a-f]{64})(?![0-9a-f])/i)?.[1].toLowerCase() ?? null;

// The rows of the first table in the text as objects keyed by the lowercase header cells.
function firstTable(text) {
  const lines = unfencedLines(stripComments(text ?? ''));
  const cells = (line) => line.trim().replace(/^\|/, '').replace(/\|$/, '').split(/(?<!\\)\|/).map((c) => c.trim());
  for (let i = 0; i < lines.length; i += 1) {
    if (!/^\s*\|/.test(lines[i]) || !/^\s*\|?\s*:?-{2,}/.test(lines[i + 1] ?? '')) continue;
    const header = cells(lines[i]).map((c) => norm(c));
    const rows = [];
    for (i += 2; i < lines.length && /^\s*\|/.test(lines[i]); i += 1) {
      const row = cells(lines[i]);
      rows.push(Object.fromEntries(header.map((h, n) => [h, row[n] ?? ''])));
    }
    return { header, rows };
  }
  return { header: [], rows: [] };
}

// A section's text with comments dropped but fenced blocks kept, or '' when missing.
function rawSection(text, title) {
  const out = [];
  let inside = false;
  for (const line of stripComments(text ?? '').split(/\r?\n/)) {
    const h2 = line.match(/^##\s+(.*?)(?:\s+#+)?\s*$/);
    if (h2) { inside = norm(h2[1]).replace(/^\d+[.)]?\s+/, '') === norm(title); continue; }
    if (inside) out.push(line);
  }
  return out.join('\n');
}

// The databases database.md lists under ## Databases: [] when it says None, or null when unreadable.
function listedDatabases(text) {
  const body = sectionNamed(text, 'Databases');
  if (body === null) return null;
  return firstTable(body).rows.map((row) => ({ ...row, name: plain(row.database ?? Object.values(row)[0] ?? '') })).filter((row) => row.name);
}

function checkDatabases(root, dir, boxes, problems) {
  const text = readIf(path.join(dir, 'database.md'), problems);
  if (text === null) { problems.push('database.md is missing (write "None" under ## Databases when the system uses no database)'); return; }
  const files = databaseFiles(root);
  const databases = listedDatabases(text);
  if (databases === null) { problems.push('database.md has no "## Databases" section (keep the template\'s English headings)'); return; }
  if (databases.length === 0) {
    if (!isNone(sectionNamed(text, 'Databases'))) problems.push('database.md lists no database in the ## Databases table; write only "None" there when the system uses none');
    else if (files.length) problems.push(`database.md says the system uses no database, but ${DATABASE_DIR}/ holds ${files.length} file${files.length === 1 ? '' : 's'}`);
    return;
  }
  const missing = [];
  for (const db of databases) {
    const items = itemsFor(boxes, 'D', db.name).length;
    if (items !== 1) problems.push(`database has ${items ? 'more than one' : 'no'} review item: ${db.name} (D<n> ${db.name})`);
    const key = Object.keys(db).find((k) => k.startsWith('definition'));
    if (!key) { problems.push('the ## Databases table of database.md has no Definitions column'); break; }
    if (isNone(db[key])) { missing.push(db.name); continue; }
    const paths = [...db[key].matchAll(/`([^`]+)`/g)].map((m) => relPath(m[1].trim()));
    if (paths.length === 0) problems.push(`database ${db.name} names no definitions path (in backticks) and does not say "none"`);
    for (const p of paths) {
      if (p.split('/').includes('..') || path.isAbsolute(p) || !fs.existsSync(path.join(root, p))) problems.push(`database ${db.name}: the definitions path ${p} does not exist in the repository`);
    }
  }
  const missingText = sectionNamed(text, 'Missing definitions') ?? '';
  if (missing.length && (isNone(missingText) || !plain(missingText))) {
    problems.push(`database ${missing.join(', ')} has no definitions; say under ## Missing definitions what is missing and why`);
  }
  if (!hasId(boxes, 'D90')) problems.push('review.md has no D90 item for the missing definitions');
  const logic = sectionNamed(text, 'Logic in the database');
  if (logic === null) problems.push('database.md has no "## Logic in the database" section');
  for (const [kind = ''] of tableRows(logic ?? '')) {
    if (plain(kind) && !DB_KINDS.includes(norm(kind))) problems.push(`database.md: unknown kind "${plain(kind)}" under ## Logic in the database (use ${DB_KINDS.join(', ')})`);
  }
  const recorded = recordedDbHash(text);
  const now = databaseHash(root);
  if (now && !recorded) problems.push('database.md records no snapshot hash ("sha256: <hash>" under ## Snapshot; get it with gate.mjs db-hash)');
  else if (now && recorded !== now) problems.push(`the database definitions under ${DATABASE_DIR}/ differ from the hash database.md records; check what changed, then record the hash gate.mjs db-hash prints`);
  else if (!now && recorded) problems.push(`database.md records a snapshot hash, but ${DATABASE_DIR}/ holds no files`);
  const wide = databaseUtf16(root);
  for (const f of wide.slice(0, 20)) problems.push(`database definition is UTF-16: ${f}`);
  if (wide.length > 20) problems.push(`...and ${wide.length - 20} more UTF-16 database definitions`);
}

// After the survey is archived, specs and ports rest on the definitions it
// reviewed. A survey from kit 0.9.0 or earlier has no database.md: nothing to compare.
export function checkDatabaseDrift(root, problems) {
  const survey = archivedChange(root, 'survey');
  if (!survey) return;
  const text = readIf(path.join(survey, 'database.md'), problems);
  if (text === null) return;
  const recorded = recordedDbHash(text);
  const now = databaseHash(root);
  if (recorded !== now) {
    problems.push(`database definitions changed after the survey: ${DATABASE_DIR}/ no longer matches the hash in the archived survey's database.md (${recorded ? recorded.slice(0, 12) : 'none'} recorded, ${now ? now.slice(0, 12) : 'none'} now)`);
  }
}

// The target design decides once how the database is used, from the survey's database.md.
function checkData(survey, dir, boxes, problems) {
  const dbText = readIf(path.join(survey, 'database.md'), problems);
  if (dbText === null) return;
  const data = readIf(path.join(dir, 'data.md'), problems);
  if (data === null) { problems.push('data.md is missing (write "None" when the survey found no database)'); return; }
  if (!(listedDatabases(dbText) ?? []).length) return;
  for (const title of ['Schema policy', 'Database logic', 'Data access mapping', 'Schema changes', 'Test database']) {
    const body = rawSection(data, title).trim();
    if (!body || PLACEHOLDER.test(plain(body))) problems.push(`data.md has no "## ${title}" section, or it is empty (keep the template's English headings)`);
  }
  for (const [topic = '', , rule = ''] of tableRows(sectionNamed(data, 'Data access mapping') ?? '')) {
    if (plain(topic) && PLACEHOLDER.test(plain(rule))) problems.push(`data.md: the data access mapping of "${plain(topic)}" has no target rule (write "same" when nothing differs)`);
  }
  for (const [id, what] of [['D0', 'the schema policy'], ['D90', 'the exceptions'], ['D91', 'the data access mapping'], ['D92', 'the schema changes and the test database']]) {
    if (!hasId(boxes, id)) problems.push(`review.md has no ${id} item for ${what}`);
  }
  const kinds = [...new Set(tableRows(sectionNamed(dbText, 'Logic in the database') ?? '').map(([kind = '']) => norm(kind)).filter((k) => DB_KINDS.includes(k)))];
  const handling = new Map(tableRows(sectionNamed(data, 'Database logic') ?? '').map(([kind = '', how = '']) => [norm(kind), norm(how)]));
  for (const kind of kinds) {
    const how = handling.get(kind);
    if (how === undefined) problems.push(`data.md has no row for ${kind} under ## Database logic (the survey's database.md lists it)`);
    else if (!/^(keep|move)\b/.test(how)) problems.push(`data.md: the handling of ${kind} is "${how || 'blank'}"; write keep or move, and list objects handled the other way under ## Exceptions`);
    const items = itemsFor(boxes, 'D', kind);
    if (items.length !== 1) problems.push(`the handling of ${kind} has ${items.length ? 'more than one' : 'no'} review item (D<n> ${kind}: <handling>)`);
    else if (/^(keep|move)\b/.test(how ?? '') && /^(keep|move)\b/.test(itemNote(items[0])) && itemNote(items[0]).split(/\W/)[0] !== how.split(/\W/)[0]) {
      problems.push(`the review item of ${kind} says "${itemNote(items[0])}", but data.md says "${how}"`);
    }
  }
}

// The survey's inventory rows: path, context and handling. Handling is `port`
// (the default, also when the cell or the column is missing) or `carry`: the
// file goes to the new system unchanged (CSS, images, fonts, script libraries,
// report templates), copied byte for byte by a port.
export const HANDLINGS = ['port', 'carry'];
export function inventoryRows(text) {
  return headedRows(text).map(({ header, cells }) => {
    const at = (pattern, fallback) => { const i = column(header, pattern); return cells[i >= 0 ? i : fallback] ?? ''; };
    const handling = column(header, HANDLING_COLUMN) >= 0 ? plain(at(HANDLING_COLUMN, -1)).toLowerCase() : '';
    // Paths keep every character (my_module, Copy (1).php, [id].php); only code marks go.
    return { path: cleanPath(at(/^(path|パス)(?![a-z0-9_])/i, 0)), context: plain(at(/^(context|コンテキスト)(?![a-z0-9_])/i, 1)).toLowerCase(), handling: PLACEHOLDER.test(handling) ? '' : handling, notes: plain(stripComments(at(NOTES_COLUMN, 3))) };
  }).filter((r) => r.path);
}

const cleanPath = (p) => relPath(p.trim().replace(/^`(.*)`$/, '$1').trim());

// The row that decides a file: its own row, else the longest folder row above it.
export function inventoryRowFor(rows, file) {
  return rows.find((r) => r.path === file)
    ?? rows.filter((r) => r.path.endsWith('/') && file.startsWith(r.path)).sort((a, b) => b.path.length - a.path.length)[0]
    ?? null;
}

// The review items every survey and target design has, whatever the system: without
// them a decision that is the person's (what is left out, who owns shared data, how
// the code is written) would pass with no tick. Items per context, database or kind
// are checked where their names are known.
const SURVEY_ITEMS = [['M1', 'the relationships between contexts'], ['M2', 'the owners of shared data'], ['M3', 'the glossary conflicts'], ['M4', 'the capability list and its order'], ['M5', 'the files marked carry'], ['C1', 'the files marked excluded']];
const TARGET_ITEMS = [['A0', 'the style'], ['A90', 'data ownership'], ['A91', 'the boundary check'], ['V1', 'runtime and frameworks'], ['V2', 'the language mapping'], ['V3', 'the coding conventions'], ['V4', 'the commands'], ['E90', 'sign-in and recorded data'], ['U90', 'the shared look, carried files and client-side scripts']];
function requireFixedItems(boxes, items, problems) {
  for (const [id, what] of items) if (!hasId(boxes, id)) problems.push(`review.md has no ${id} item for ${what} (keep the template's items)`);
}

function checkSurvey(root, dir, boxes, problems) {
  const map = readIf(path.join(dir, 'context-map.md'), problems);
  const contexts = contextIds(map);
  if (contexts.length === 0) problems.push('context-map.md defines no context ("### Context: <id>", lowercase kebab-case)');
  for (const id of contexts) {
    if (!boxes.some((b) => new RegExp(`^K\\d+\\s*[.:)-]?\\s*${id}(?![\\w-])`, 'i').test(b.plain))) problems.push(`context has no review item: ${id}`);
  }
  const known = new Set([...contexts, 'excluded']);
  const inventoryText = readIf(path.join(dir, 'inventory.md'), problems);
  const tables = headedRows(inventoryText);
  const noHandling = tables.find(({ header }) => column(header, /^(path|パス)(?![a-z0-9_])/i) >= 0 && column(header, HANDLING_COLUMN) < 0);
  if (noHandling) problems.push(`inventory.md has a table without the Handling column (| ${noHandling.header.join(' | ')} |); use | Path | Context | Handling | Notes |`);
  const rows = inventoryRows(inventoryText);
  for (const row of rows.filter((r) => !known.has(r.context))) problems.push(`inventory row "${row.path}" names an unknown context "${row.context}"`);
  for (const row of rows.filter((r) => r.handling && !HANDLINGS.includes(r.handling))) problems.push(`inventory row "${row.path}" has the handling "${row.handling}"; use port or carry`);
  for (const row of rows.filter((r) => r.handling === 'carry' && (r.path === `${DATABASE_DIR}/` || r.path.startsWith(`${DATABASE_DIR}/`)))) problems.push(`inventory row "${row.path}" carries database definitions; they are port (data.md decides what stays in the database)`);
  for (const row of rows.filter((r) => r.context === 'excluded' && r.handling === 'carry')) problems.push(`inventory row "${row.path}" is excluded and carry at once; a carried file belongs to the context whose module receives it`);
  // An excluded file is never specified or ported: the person can only judge it with the reason beside it.
  const unexplained = rows.filter((r) => r.context === 'excluded' && PLACEHOLDER.test(r.notes));
  for (const row of unexplained.slice(0, 20)) problems.push(`inventory row "${row.path}" is excluded with no reason in Notes (generated code, vendored library, build output, dead code...)`);
  if (unexplained.length > 20) problems.push(`...and ${unexplained.length - 20} more excluded rows with no reason`);
  requireFixedItems(boxes, SURVEY_ITEMS, problems);
  const files = sourceFiles(root);
  if (files === null) {
    problems.push(`the source root "${configValue(root, 'Source root', '.')}" in openspec/config.yaml is not a folder inside the repository`);
  } else if (files.length === 0) problems.push('the source root holds no files');
  const uncovered = (files ?? []).filter((file) => !rows.some((r) => r.path === file || (r.path.endsWith('/') && file.startsWith(r.path))));
  for (const file of uncovered.slice(0, 20)) problems.push(`source file not in the inventory: ${file}`);
  if (uncovered.length > 20) problems.push(`...and ${uncovered.length - 20} more source files not in the inventory`);
  checkSurveyCoverage(root, dir, rows, problems);

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
  checkDatabases(root, dir, boxes, problems);
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
// The person's edits of review.md made in the canvas (review-edit.mjs writes it; agents never do).
// One machine's record, like the metrics: under local/, never committed.
export const CANVAS_LOG = 'openspec/spec-relay/local/canvas-log.jsonl';

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
  checkDatabaseDrift(root, problems);
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
  // verify.mjs runs the Test and Boundary check commands at every port and reads
  // the chosen levels, so a table it cannot read fails here, not at the first port.
  const commands = conventionCommands(readIf(path.join(dir, 'conventions.md'), problems));
  if (!commands.test) problems.push('conventions.md names no Test command (## Commands, | Test | <command> |)');
  if (!commands.boundary) problems.push('conventions.md names no Boundary check command (## Commands, | Boundary check | <command> |)');
  for (const [key, command] of Object.entries(commands)) {
    const chained = chainProblem(command);
    if (chained) problems.push(`conventions.md ${key === 'test' ? 'Test' : 'Boundary check'}: ${chained}`);
  }
  const verification = readIf(path.join(dir, 'verification.md'), problems);
  for (const id of contexts) {
    if (verification !== null && chosenLevels(verification, id, problems) === null) problems.push(`verification.md has no row for context ${id} in a table with B1, B2 and C columns`);
  }
  checkUi(root, survey, dir, contexts, problems);
  // One review item per module (A<n>), per context's verification levels (E<n>)
  // and per context's screens (U<n>).
  for (const [letter, what] of [['A', 'module'], ['E', 'verification levels'], ['U', 'screen policy']]) {
    for (const id of contexts) {
      if (!boxes.some((b) => new RegExp(`^${letter}\\d+\\s*[.:)-]?\\s*\\W*${id}(?![\\w-])`, 'i').test(b.plain))) problems.push(`the ${what} of context ${id} has no review item (${letter}<n> ${id})`);
    }
  }
  requireFixedItems(boxes, TARGET_ITEMS, problems);
  checkData(survey, dir, boxes, problems);
}

// How a context's screens look in the new system, decided once in ui.md:
// `same` (the look too), `layout` (layout, wording, order and keys; drawn by the
// new toolkit), `new` (a new look; items, wording and transitions stay) or
// `none` (no screens).
export const POLICIES = ['same', 'layout', 'new', 'none'];

function checkUi(root, survey, dir, contexts, problems) {
  const ui = readIf(path.join(dir, 'ui.md'), problems);
  if (ui === null) { problems.push('ui.md is missing (a context without screens gets the policy none)'); return; }
  const screens = headedRows(section(ui, /^screens$/i) ?? '');
  if (screens.length === 0) problems.push('ui.md has no table under "## Screens"');
  const rows = screens.map(({ header, cells }) => {
    const policyAt = column(header, POLICY_COLUMN);
    return {
      context: plain(cells[Math.max(column(header, /^(context|コンテキスト)(?![a-z0-9_])/i), 0)] ?? '').toLowerCase(),
      policy: policyAt < 0 ? null : plain(cells[policyAt] ?? '').toLowerCase(),
    };
  });
  if (rows.some((r) => r.policy === null)) problems.push('the table under "## Screens" in ui.md has no Policy column');
  for (const id of contexts.filter((c) => !rows.some((r) => r.context === c))) problems.push(`ui.md has no screens row for context ${id}`);
  for (const row of rows.filter((r) => r.policy !== null && !POLICIES.includes(r.policy))) problems.push(`ui.md gives context ${row.context || '(blank)'} the policy "${row.policy || 'blank'}"; use same, layout, new or none`);
  // Every carry row of the inventory needs a place in the new system, and
  // every place must be one a port may write.
  const carry = inventoryRows(readIf(path.join(survey, 'inventory.md'), problems)).filter((r) => r.handling === 'carry');
  const placed = carriedRows(ui);
  if (placed === null) { if (carry.length) problems.push('ui.md has no "## Carried files" section, but the inventory marks files carry'); return; }
  for (const row of carry.filter((r) => !placed.some((p) => p.source === r.path))) problems.push(`ui.md has no "## Carried files" row for the inventory's carry row "${row.path}"`);
  for (const row of placed) {
    if (!carry.some((r) => r.path === row.source)) problems.push(`ui.md's carried files row "${row.source}" is not a carry row of the inventory`);
    const why = badTarget(root, row.source, row.target);
    if (why) problems.push(`ui.md's carried files row "${row.source}": ${why}`);
  }
}

// The rows of a "## Carried files" table (source | target), or null when the
// section is missing. "None" and an untouched template row are no rows.
function carriedRows(text) {
  const body = section(text, /^carried files\b/i);
  if (body === null) return null;
  // Only the first table: a later one ("Not copied | Why") is not a placement.
  const rows = headedRows(body);
  return rows.filter((r) => r.header === rows[0].header).map(({ cells: [source = '', target = ''] }) => ({ source: cleanPath(source), target: cleanPath(target) }))
    .filter((r) => !NOTHING.test(r.source));
}

// Why a carried file may not go to `target`, or null. It must stay in the
// repository, under the target root when one is set, and never in openspec/,
// .git or on a source file.
function badTarget(root, source, target) {
  const inside = (rel) => rel && !rel.split('/').includes('..') && !/^[a-z]:/i.test(rel);
  if (!inside(source) || !inside(target)) return `"${source}" -> "${target || 'blank'}" leaves the repository or has no target`;
  if (source.endsWith('/') && !target.endsWith('/')) return `the source ${source} is a folder, so the target ${target} must end in /`;
  const lower = `${target}/`.toLowerCase();
  if (/^(openspec|\.git)\//.test(lower)) return `the target ${target} is inside openspec/ or .git`;
  const targetRoot = relPath(cleanValue(configValue(root, 'Target root', ''))).replace(/\/$/, '');
  if (targetRoot && targetRoot !== '.' && !lower.startsWith(`${targetRoot.toLowerCase()}/`)) return `the target ${target} is outside the target root ${targetRoot}`;
  return null;
}

export function checkReview(root, change) {
  const problems = [];
  const dir = path.join(root, 'openspec/changes', change);
  if (!fs.existsSync(dir)) return { ok: false, problems: [`change not found: ${change} (an archived change cannot be checked)`] };
  const boxes = commonReview(dir, problems);
  if (boxes === null) return { ok: false, problems: ['review.md is missing'] };
  const schema = changeSchema(dir);
  if (schema === 'spec-relay-extract') { checkSurveyed(root, change, dir, 'extract', problems); checkExtract(root, dir, boxes, problems); }
  else if (schema === 'spec-relay-amend') { checkSurveyed(root, change, dir, 'amend', problems); checkAmend(root, dir, boxes, problems); }
  else if (schema === 'spec-relay-survey') checkSurvey(root, dir, boxes, problems);
  else if (schema === 'spec-relay-target') checkTarget(root, dir, boxes, problems);
  else if (schema === 'spec-relay-finish') checkFinish(root, change, dir, boxes, problems);
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

// The files subagents must never write: every active change's review.md,
// questions.md, crosscheck.md (merge.mjs writes it from the checkers' part
// files) and verify.json (verify.mjs writes it), every active port's
// proposal.md and design.md (where its commands and follow-up live), the
// finish change's checks.md and leftovers.md (finish.mjs writes the results,
// the person decides the classes), the plan, the lessons, the baseline specs,
// the config and the source files.
// The orchestrator saves a snapshot of their hashes before a wave and compares
// after it. Git cannot show a tick in an untracked or already modified
// review.md, nor an edit to an already modified or untracked source file; this
// can. Files git ignores (bin/, obj/, .vs/) are not source files and not hashed.
export function guardFiles(root, warnings = []) {
  const changes = path.join(root, 'openspec/changes');
  const files = [];
  try {
    for (const e of fs.readdirSync(changes, { withFileTypes: true })) {
      if (e.isDirectory() && e.name !== 'archive') files.push(...['review.md', 'questions.md', 'crosscheck.md', VERIFY_RECEIPT, OLD_RECEIPT, ...(/^port-/.test(e.name) ? ['proposal.md', 'design.md'] : []), ...(/^finish(?:-v\d+)?$/.test(e.name) ? ['checks.md', 'leftovers.md'] : [])].map((f) => path.join(changes, e.name, f)));
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
// Where the canvas log ended when the snapshot was taken: only later canvas edits count.
const logMark = (root, name) => path.join(root, GUARD_DIR, `${name}.canvas-log`);
const logSize = (root) => { try { return fs.statSync(path.join(root, CANVAS_LOG)).size; } catch { return 0; } };

export function guardSave(root, name) {
  if (!/^[a-z0-9][a-z0-9-]{0,63}$/i.test(name)) return { ok: false, problems: [`not a snapshot name: ${name} (letters, digits and hyphens)`] };
  const warnings = [];
  // The mark first: a canvas edit made while the files are hashed is then still counted as the person's.
  const mark = logSize(root);
  const files = guardFiles(root, warnings);
  const file = snapshotFile(root, name);
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(logMark(root, name), `${mark}\n`);
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
  // A review.md the person changed in the canvas is theirs, not a subagent's: the
  // canvas edits logged after the snapshot, replayed in order, lead without a gap
  // from the snapshot's hash to today's. Any other change breaks the chain.
  let mark = null;
  try { const text = fs.readFileSync(logMark(root, name), 'utf8').trim(); if (/^\d+$/.test(text)) mark = Number(text); } catch { /* an older snapshot: no canvas edits count */ }
  const chains = new Map();
  if (mark !== null) {
    let entries = [];
    try {
      const buffer = fs.readFileSync(path.join(root, CANVAS_LOG));
      if (buffer.length >= mark) entries = buffer.subarray(mark).toString('utf8').split(/\r?\n/);
    } catch { /* no log */ }
    for (const line of entries) {
      let e;
      try { e = JSON.parse(line); } catch { continue; }
      if (!e || typeof e.file !== 'string' || typeof e.before !== 'string' || typeof e.after !== 'string') continue;
      const chain = chains.get(e.file) ?? { at: before[e.file], broken: false };
      if (chain.at !== e.before) chain.broken = true;
      chain.at = e.after;
      chains.set(e.file, chain);
    }
  }
  const byCanvas = (f) => { const chain = chains.get(f); return Boolean(chain) && !chain.broken && chain.at === now[f]; };
  const touched = Object.keys(now).filter((f) => f in before && before[f] !== now[f]);
  const canvas = touched.filter(byCanvas).sort();
  const changed = touched.filter((f) => !canvas.includes(f)).sort();
  const added = Object.keys(now).filter((f) => !(f in before)).sort();
  const removed = Object.keys(before).filter((f) => !(f in now)).sort();
  const cap = (list) => (list.length > 50 ? [...list.slice(0, 50), `...and ${list.length - 50} more`] : list);
  return { ok: changed.length + added.length + removed.length === 0, changed: cap(changed), added: cap(added), removed: cap(removed), ...(canvas.length ? { canvas } : {}) };
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
  checkDatabaseDrift(root, problems);
  return { ok: problems.length === 0, problems };
}

// The newest archived target design's file, or null.
function targetDesignFile(root, name, problems) {
  const dir = archivedChange(root, 'target-design');
  return dir ? readIf(path.join(dir, name), problems) : null;
}

// The heading row and the body rows of every Markdown table in the text.
function tablesWithHeader(text) {
  const tables = [];
  const lines = unfencedLines(stripComments(text ?? ''));
  const cells = (line) => line.trim().replace(/^\|/, '').replace(/\|$/, '').split(/(?<!\\)\|/).map((c) => c.trim());
  for (let i = 0; i < lines.length; i += 1) {
    if (!/^\s*\|/.test(lines[i]) || !/^\s*\|?\s*:?-{2,}/.test(lines[i + 1] ?? '')) continue;
    const table = { header: cells(lines[i]).map((c) => plain(c).toLowerCase()), rows: [] };
    for (i += 2; i < lines.length && /^\s*\|/.test(lines[i]); i += 1) table.rows.push(cells(lines[i]));
    tables.push(table);
  }
  return tables;
}

// A command written in a table cell, without code marks. A placeholder or a
// note in parentheses ("(conventions.md's Test command)") is no command.
const commandOf = (cell = '') => {
  const text = cell.replace(/<br\s*\/?>/gi, ' ').replace(/\\\|/g, '|').trim().replace(/^`+([\s\S]*?)`+$/, '$1').trim();
  return PLACEHOLDER.test(text) || /^[(（]/.test(text) || /^(none|empty|なし|空)$/i.test(text) ? '' : text;
};

// Why a command line would hide a failure, or null. Windows PowerShell reports
// only the last statement of `a; b`, and a pipe only its last part, so the
// commands verify.mjs runs must be one command each.
export function chainProblem(command) {
  const refuse = (what) => `"${command}" ${what}; a failure before the last part would not fail the run, so write one command (a script or a build tool task can run several steps)`;
  if (/^\s*(?:cmd(?:\.exe)?\s+\/[ck]|(?:ba|z)?sh\s+-c|pwsh(?:\.exe)?\b|powershell(?:\.exe)?\b)/i.test(command)) return refuse('starts another shell');
  let quote = null;
  for (let i = 0; i < command.length; i += 1) {
    const c = command[i];
    if (quote) {
      if (c === quote) quote = null;
      else if ((c === '`' || c === '\\') && quote === '"') i += 1;
      continue;
    }
    if (c === '"' || c === "'") { quote = c; continue; }
    // PowerShell escapes with a backtick, sh with a backslash.
    if (c === '`' || (c === '\\' && /[;&|]/.test(command[i + 1] ?? ''))) { i += 1; continue; }
    // A comment ends the command line.
    if (c === '#' && (i === 0 || /\s/.test(command[i - 1]))) break;
    if (c === ';' || c === '|') return refuse(`chains commands (${command[i + 1] === c ? c + c : c})`);
    if (c === '&') {
      if (command[i + 1] === '&') return refuse('chains commands (&&)');
      // `& "tool.exe" args` (PowerShell's call operator) is one command; a later & runs the part before it in the background.
      if (command.slice(0, i).trim() !== '') return refuse('runs a part in the background (&)');
    }
  }
  return null;
}

// The commands of conventions.md (## Commands: | Purpose | Command |), by purpose.
export function conventionCommands(text) {
  const out = {};
  for (const table of tablesWithHeader(text)) {
    if (table.header.length < 2 || !/purpose|用途|目的/.test(table.header[0])) continue;
    for (const [purpose = '', command = ''] of table.rows) {
      const p = plain(purpose).toLowerCase();
      const key = /boundary|境界/.test(p) ? 'boundary' : /^(test|テスト)/.test(p) ? 'test' : null;
      if (key && commandOf(command) && !out[key]) out[key] = commandOf(command);
    }
  }
  return out;
}

export const LEVELS = ['B1', 'B2', 'C'];
// The words a level cell may hold. Anything else, an empty cell included, is
// reported, so that "yet to decide" is never read as yes or as no.
const YES = /^(yes|y|true|required|はい|あり|有|する|要|必要|✓|✔|✔️|✅|○|◯|〇)$/i;
const NO = /^(no|n|false|none|-|–|—|いいえ|なし|無|しない|不要|×|✗|✘|❌)$/i;
const wide = (s) => s.normalize('NFKC').toLowerCase();
const levelColumn = (header, level) => {
  const pattern = new RegExp(`(^|[^a-z0-9])${level === 'C' ? 'c' : `b[-\\s]?${level[1]}`}([^a-z0-9#+]|$)`);
  return header.findIndex((h) => pattern.test(wide(h)));
};

// The comparison levels (B1, B2, C) verification.md chose for a context, or
// null when no table with level columns has a row for the context. A table
// that lacks one of the three columns, or a cell that is neither yes nor no,
// adds a problem.
export function chosenLevels(text, context, problems = []) {
  for (const table of tablesWithHeader(text)) {
    const columns = LEVELS.map((level) => levelColumn(table.header, level));
    if (columns.every((c) => c < 0)) continue;
    const row = table.rows.find(([first = '']) => plain(first).toLowerCase() === context);
    if (!row) continue;
    const chosen = [];
    LEVELS.forEach((level, i) => {
      if (columns[i] < 0) { problems.push(`verification.md: the levels table has no ${level} column; give it columns B1, B2 and C`); return; }
      const cell = wide(plain(row[columns[i]] ?? '').trim());
      if (YES.test(cell)) chosen.push(level);
      else if (!NO.test(cell)) problems.push(`verification.md: the ${level} cell of context ${context} is ${cell ? `"${cell}"` : 'empty'}; write yes or no`);
    });
    return chosen;
  }
  return null;
}

// The Verification table of a port's design.md (| Level | Covers | Command |):
// the command of each level that names one (A, B1, B2, C, and `boundary` for a
// Boundary check row, which replaces the conventions' command for this port).
export function designCommands(text) {
  const out = {};
  for (const table of tablesWithHeader(text)) {
    if (!/^level|^方式|^比べ方/.test(table.header[0] ?? '')) continue;
    const at = table.header.findIndex((h) => /^command|^コマンド/.test(h));
    for (const row of table.rows) {
      const first = plain(row[0] ?? '');
      const level = /^(boundary|境界)/i.test(first) ? 'boundary' : first.match(/^(A|B1|B2|C)\b/i)?.[1]?.toUpperCase();
      if (level && at >= 0 && commandOf(row[at]) && !out[level]) out[level] = commandOf(row[at]);
    }
  }
  return out;
}

const levelName = (level) => (level === 'boundary' ? 'the boundary check' : `level ${level}`);

// How a scenario is checked: `e2e` (a Playwright screen test that passed on the
// old system and then on the new one), `compare` (a case recorded from the
// source program, B1) or `unit` (a test in the target language).
export const CHECKS = ['e2e', 'compare', 'unit'];
const checkKind = (cell) => {
  const w = wide(plain(cell ?? ''));
  if (/^(e2e|playwright|screen|画面)/.test(w)) return 'e2e';
  if (/^(compare|comparison|b1|比較|記録)/.test(w)) return 'compare';
  if (/^(unit|単体)/.test(w)) return 'unit';
  return null;
};

// The Scenario checks table of a port's design.md (| Requirement | Scenario |
// Check |): [{ requirement, scenario, check, cell }], or null without one.
export function designScenarioChecks(text) {
  for (const table of tablesWithHeader(text)) {
    const at = (pattern) => table.header.findIndex((h) => pattern.test(h));
    const [r, s, c] = [at(/^(requirement|要件)/), at(/^(scenario|シナリオ)/), at(/^(check|確認)/)];
    if (r < 0 || s < 0 || c < 0) continue;
    return table.rows.map((row) => ({ requirement: plain(row[r] ?? ''), scenario: plain(row[s] ?? ''), check: checkKind(row[c]), cell: plain(row[c] ?? '') }))
      .filter((row) => row.requirement || row.scenario || row.cell);
  }
  return null;
}

// What a port's verify run must run, in order: the scenario tests (level A),
// the boundary check, then each comparison level verification.md chose for the
// capability's context. Each run is { level, command, from }, where `from` is
// the file the command came from.
export function verifyPlan(root, change, capability = portCapability(root, change)) {
  const problems = [];
  const dir = path.join(root, 'openspec/changes', change);
  if (!capability) return { runs: [], levels: [], problems: ['proposal.md records no baseline hash for this change\'s own capability; add it with gate.mjs baseline'] };
  const context = capability.split('/')[0];
  const conventions = targetDesignFile(root, 'conventions.md', problems);
  const verification = targetDesignFile(root, 'verification.md', problems);
  if (conventions === null) problems.push('no archived target design with conventions.md');
  if (verification === null) problems.push('no archived target design with verification.md');
  const commands = conventionCommands(conventions);
  const design = designCommands(readIf(path.join(dir, 'design.md'), problems) ?? '');
  const levels = chosenLevels(verification, context, problems);
  if (verification !== null && levels === null) problems.push(`verification.md of the archived target design has no row for context ${context} in a table with B1, B2 and C columns`);
  const runs = [];
  const add = (level, command, from, missing) => {
    if (!command) { problems.push(missing); return; }
    const chained = chainProblem(command);
    if (chained) problems.push(`${levelName(level)}: ${chained}`);
    if (isCompareCommand(command)) {
      const problem = compareCommandProblem(root, command);
      if (problem) problems.push(`${levelName(level)}: ${problem}`);
    }
    if (isE2eCommand(command)) {
      const opts = e2eCommandOptions(command);
      if (opts.problem) problems.push(`${levelName(level)}: ${opts.problem}`);
    } else if (level === 'B2') problems.push(`level B2 is the kit's screen tests: give it \`spec-relay-e2e --base http://localhost:<port> --start '<command>'\` (docs/E2E.md), not \`${command}\``);
    runs.push({ level, command, from });
  };
  add('A', design.A ?? commands.test, design.A ? 'design.md' : 'conventions.md', 'conventions.md of the archived target design names no Test command (## Commands)');
  add('boundary', design.boundary ?? commands.boundary, design.boundary ? 'design.md' : 'conventions.md', 'conventions.md of the archived target design names no Boundary check command (## Commands)');
  for (const level of levels ?? []) add(level, design[level], 'design.md', `verification.md chose ${level} for context ${context}, but design.md's Verification table gives it no command (| ${level} | covers | command |)`);
  return { runs, levels: levels ?? [], problems };
}

// The hash of what a `spec-relay-compare ...` command compares with, as the
// verify run recorded it (cases, rules.json and the HTTP driver's map), or null.
function compareDigest(root, command) {
  const argv = commandWords(command.trim().slice(COMPARE_COMMAND.length));
  const opts = argv ? parseOptions(argv) : {};
  if (!opts.cases) return null;
  const target = path.resolve(root, relPath(cleanValue(configValue(root, 'Target root', ''))) || '.');
  const dir = path.resolve(target, opts.cases);
  return casesDigest(readCases(dir, [], dir).sha256, opts.driver, target);
}

// What is wrong with a `spec-relay-compare ...` command, or null. Its cases
// must be inside the target root; port-done also compares their hash with the
// verify run's, since git may ignore them and keep them out of the target hash.
function compareCommandProblem(root, command) {
  const argv = commandWords(command.trim().slice(COMPARE_COMMAND.length));
  const opts = argv ? parseOptions(argv) : { problem: 'an unclosed quote' };
  if (opts.problem) return `${opts.problem} in \`${command}\``;
  const refused = portOptionProblem(opts);
  if (refused) return refused;
  const target = path.resolve(root, relPath(cleanValue(configValue(root, 'Target root', ''))) || '.');
  const rel = path.relative(target, path.resolve(target, opts.cases));
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return `the cases folder ${opts.cases} is not inside the target root; keep recorded cases under the target root's tests`;
  return null;
}

// Folders that never hold the port's own code: skipped everywhere when the
// repository is not a git repository (in one, .gitignore decides).
const TOOL_DIRS = new Set(['.git', 'node_modules', '.venv', 'venv', '__pycache__', '.gradle', '.pytest_cache', '.mypy_cache', '.tox', '.next', '.idea', '.vs']);
// Usual build output: skipped right under the target root only, because a
// module of the port may be named like one deeper down.
const BUILD_DIRS = new Set(['bin', 'obj', 'target', 'build', 'dist', 'out', 'coverage']);

// The files under the target root, as paths from the repository root, or null
// when openspec/config.yaml names no target root inside the repository. In a
// git repository these are the files git tracks or would track (build output
// git ignores does not count; a nested repository's files are listed from
// disk); otherwise every file outside tool folders and the build folders right
// under the target root. openspec/ and the source root never count.
export function targetFiles(root) {
  const target = relPath(cleanValue(configValue(root, 'Target root', ''))).replace(/\/$/, '');
  const source = relPath(cleanValue(configValue(root, 'Source root', '.'))).replace(/\/$/, '');
  const base = path.resolve(root);
  const dir = path.resolve(base, target || '.');
  const rel = path.relative(base, dir);
  if (!target || rel.startsWith('..') || path.isAbsolute(rel)) return null;
  try { if (!fs.statSync(dir).isDirectory()) return []; } catch { return []; }
  const prefix = rel ? `${rel.split(path.sep).join('/')}/` : '';
  const skip = (file) => file === '.git' || file.startsWith('.git/') || file === 'openspec' || file.startsWith('openspec/')
    || (source && source !== '.' && source !== target && (file === source || file.startsWith(`${source}/`)));
  const out = [];
  const visit = (dirRel, top) => {
    let entries = [];
    try { entries = fs.readdirSync(path.join(base, dirRel), { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const child = dirRel ? `${dirRel}/${e.name}` : e.name;
      if (skip(child)) continue;
      if (e.isDirectory()) { if (!TOOL_DIRS.has(e.name) && !(top && BUILD_DIRS.has(e.name))) visit(child, false); } else if (e.isFile()) out.push(child);
    }
  };
  const nested = (folder) => {
    const inner = spawnSync('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard'], { cwd: path.join(base, folder), encoding: 'buffer', windowsHide: true, maxBuffer: Infinity });
    if (inner.status === 0 && inner.stdout) {
      for (const f of inner.stdout.toString('utf8').split('\0').filter(Boolean)) if (fs.existsSync(path.join(base, folder, f))) out.push(`${folder}/${f}`);
    } else visit(folder, `${folder}/` === prefix);
  };
  const git = spawnSync('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard', '--', prefix || '.'], { cwd: base, encoding: 'buffer', windowsHide: true, maxBuffer: Infinity });
  if (git.status === 0 && git.stdout) {
    const top = spawnSync('git', ['rev-parse', '--show-cdup'], { cwd: base, encoding: 'utf8', windowsHide: true });
    if (top.status === 0 && top.stdout.trim() === '') {
      for (const f of git.stdout.toString('utf8').split('\0').filter(Boolean)) {
        if (skip(f)) continue;
        let stat = null;
        try { stat = fs.statSync(path.join(base, f)); } catch { continue; }
        // A nested repository (or submodule) is listed as its folder: list it
        // with its own git, so its .gitignore holds too.
        if (stat.isDirectory()) nested(f.replace(/\/$/, '')); else out.push(f);
      }
      return [...new Set(out)].sort();
    }
  }
  visit(prefix.replace(/\/$/, ''), true);
  return out.sort();
}

// A target file read as text with CRLF as LF (so a Windows checkout hashes the
// same): { text }, or { utf16: true } or { binary: true }.
function readTarget(file) {
  let buffer;
  try { buffer = fs.readFileSync(file); } catch { return { binary: true, buffer: Buffer.alloc(0) }; }
  if ((buffer[0] === 0xff && buffer[1] === 0xfe) || (buffer[0] === 0xfe && buffer[1] === 0xff)) return { utf16: true, buffer };
  if (buffer.length > 4 * 1024 * 1024 || buffer.includes(0)) return { binary: true, buffer };
  return { text: buffer.toString('utf8').replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n') };
}

// The sha256 of every target file, as verify.mjs records it.
export function targetHashes(root, files = targetFiles(root)) {
  const out = {};
  for (const f of files ?? []) {
    const read = readTarget(path.join(root, f));
    out[f] = crypto.createHash('sha256').update(read.text !== undefined ? Buffer.from(read.text) : read.buffer).digest('hex');
  }
  return out;
}

// One hash over every target file (path and content).
export function targetHash(root, files = targetFiles(root), hashes = targetHashes(root, files)) {
  const hash = crypto.createHash('sha256');
  for (const f of Object.keys(hashes).sort()) hash.update(`${f}\0${hashes[f]}\n`);
  return hash.digest('hex');
}

// The paths that differ between two { path: sha256 } maps, at most `max`.
function changedPaths(before, now, max = 10) {
  const all = [...new Set([...Object.keys(before), ...Object.keys(now)])].sort().filter((f) => before[f] !== now[f]);
  return all.length > max ? [...all.slice(0, max), `...and ${all.length - max} more`] : all;
}

// Every scenario of a spec, with the requirement it belongs to.
export function scenarioList(text) {
  const out = [];
  let requirement = null;
  for (const line of unfencedLines(text ?? '')) {
    const r = line.match(REQUIREMENT);
    if (r) { requirement = r[1]; continue; }
    if (/^#{1,3}\s/.test(line)) { requirement = null; continue; }
    const s = line.match(/^####\s*Scenario:\s*(.+?)\s*$/i);
    if (s && requirement) out.push({ requirement, scenario: s[1] });
  }
  return out;
}

const squash = (s) => s.replace(/\s+/g, ' ').trim().toLowerCase();
// A test names the scenario it checks with a comment or its test name holding
// `spec-relay: <capability> | <requirement> | <scenario>`. In a string (the tag
// right after a quote) the scenario ends at the closing quote; in a comment
// only comment closers may follow it.
const TAG = /^spec-relay:\s*([^|\r\n]+?)\s*\|\s*([^|\r\n]+?)\s*\|\s*([^\r\n]*?)\s*$/i;
const COMMENT_END = /^[\s)\]};,*/#>-]*$/;
// Documentation is not a test: tags there do not count.
const NOT_TESTS = /\.(md|markdown|txt|rst|adoc|html?)$/i;

function readTag(line, at) {
  const before = line.slice(0, at).trimEnd().slice(-1);
  if (['"', "'", '`'].includes(before)) {
    let text = '';
    for (let i = at; i < line.length; i += 1) {
      if (line[i] === '\\' && i + 1 < line.length) { text += line[i + 1]; i += 1; continue; }
      if (line[i] === before) break;
      text += line[i];
    }
    const m = text.match(TAG);
    return m && { capability: squash(m[1]), requirement: squash(m[2]), rest: squash(m[3]), exact: true };
  }
  const m = line.slice(at).match(TAG);
  return m && { capability: squash(m[1]), requirement: squash(m[2]), rest: squash(m[3]), exact: false };
}

// The `spec-relay:` scenario tags and `TODO(port)` marks in the target files,
// and the files that could not be read as UTF-8.
export function scanTarget(root, files = targetFiles(root)) {
  const tags = [];
  const todos = [];
  const utf16 = [];
  for (const f of files ?? []) {
    const read = readTarget(path.join(root, f));
    if (read.utf16) { utf16.push(f); continue; }
    if (read.text === undefined || (!/spec-relay:/i.test(read.text) && !read.text.includes('TODO(port'))) continue;
    read.text.split('\n').forEach((raw, i) => {
      // A JSON line may escape what the tag holds (\u53d7 for 受): read it as JSON.
      let line = raw;
      if (/\.jsonl$/i.test(f) && raw.includes('\\u')) { try { line = JSON.stringify(JSON.parse(raw)); } catch { /* not JSON: as written */ } }
      const at = line.search(/spec-relay:/i);
      const tag = at >= 0 && !NOT_TESTS.test(f) ? readTag(line, at) : null;
      if (tag) tags.push({ file: f, line: i + 1, ...tag });
      if (line.includes('TODO(port')) todos.push({ file: f, line: i + 1, text: line.trim().slice(0, 120) });
    });
  }
  return { tags, todos, utf16 };
}

// The tag a test name holds (a Playwright test's title), or null.
export function titleTag(title) {
  const m = String(title ?? '').trim().match(TAG);
  return m && { capability: squash(m[1]), requirement: squash(m[2]), rest: squash(m[3]), exact: true };
}

export const tagMatches = (tag, capability, { requirement, scenario }) => {
  if (tag.capability !== squash(capability) || tag.requirement !== squash(requirement)) return false;
  const name = squash(scenario);
  return tag.exact ? tag.rest === name : tag.rest.startsWith(name) && COMMENT_END.test(tag.rest.slice(name.length));
};

// Who agreed, from a Follow-up item: "(agreed by Uma)", "（了承: うま）" or
// "（田中さん了承）"; null for a placeholder or a line that says it is not agreed.
export function agreedBy(line) {
  const text = stripComments(line).normalize('NFKC');
  if (/\bnot\b[^()]*\bagreed\b|\bunagreed\b|了承(?:待ち|前|して(?:い)?ない|を得て(?:い)?ない|なし|未)|未了承/i.test(text)) return null;
  const name = text.match(/\bagreed by\s+([^\s(),.;]+(?:\s+[^\s(),.;]+)?)/i)?.[1]
    ?? text.match(/了承\s*[:]\s*([^\s()、,.;]+)/)?.[1]
    ?? text.match(/([^\s()、,.;:]+?)(?:さん|様)?(?:が)?了承(?:済み|済)?(?:\)|$|\s)/)?.[1];
  if (!name || PLACEHOLDER.test(name) || /^<.*>$|^(name|名前|tbd|anyone|nobody|someone|誰か|未定)$/i.test(name.replace(/さん$/, ''))) return null;
  return name;
}

// The target files whose TODO(port) the person agreed to leave for later: list
// items under `## Follow-up` in this port's proposal.md, or an archived port's,
// that name the file in backticks and who agreed (see agreedBy). The value
// tells whether this port's proposal is the one that lists it.
export function followUpFiles(root, dir) {
  const files = new Map();
  const target = relPath(cleanValue(configValue(root, 'Target root', ''))).replace(/\/$/, '');
  const proposals = [path.join(dir, 'proposal.md')];
  try {
    const archive = path.join(root, 'openspec/changes/archive');
    for (const e of fs.readdirSync(archive)) if (/^\d{4}-\d{2}-\d{2}-port-/.test(e)) proposals.push(path.join(archive, e, 'proposal.md'));
  } catch { /* nothing archived */ }
  proposals.forEach((file, index) => {
    let inFollowUp = false;
    for (const line of unfencedLines(stripComments(readIf(file, []) ?? ''))) {
      const h2 = line.match(/^##\s+(.*)$/);
      if (h2) { inFollowUp = /^(?:\d+[.)]?\s*)?(follow[\s-]?ups?\b|後の作業|残す作業)/i.test(h2[1].trim()); continue; }
      if (!inFollowUp || !/^\s*(?:[-*+]|\d+[.)])\s/.test(line) || !agreedBy(line)) continue;
      for (const m of line.matchAll(/`([^`]+)`/g)) {
        const p = relPath(m[1].trim()).replace(/:\d+$/, '');
        for (const key of [p, target && !p.startsWith(`${target}/`) ? `${target}/${p}` : null].filter(Boolean)) if (!files.has(key)) files.set(key, index === 0);
      }
    }
  });
  return files;
}

export const VERIFY_RECEIPT = 'verify.json';
// merge.mjs stamps a port's crosscheck.md with the target hash it was merged on.
export const CODE_STAMP = /spec-relay: code checked sha256:([0-9a-f]{64})/;

// The baseline records of a port's proposal.md, and the one of its own
// capability (the change name without port- and -v<n>).
function baselineRecords(proposal, change) {
  const recorded = [...stripComments(proposal).matchAll(/`([^`]+)`\s*sha256:\s*([0-9a-f]{64})/gi)];
  const own = baseName(change).replace(/^port-/, '');
  return { recorded, own, ownRecord: recorded.find(([, capability]) => capabilitySegments(capability).join('-') === own) };
}

// The capability path a port change implements, from its proposal, or null.
export function portCapability(root, change) {
  const proposal = readIf(path.join(root, 'openspec/changes', change, 'proposal.md'), []) ?? '';
  const { ownRecord } = baselineRecords(proposal, change);
  return ownRecord ? capabilitySegments(ownRecord[1]).join('/') : null;
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
  const { recorded, own, ownRecord } = baselineRecords(proposal, change);
  if (recorded.length === 0) problems.push('proposal.md records no baseline hash ("- `<capability>` sha256:<hash>" under ## Baseline; get it with gate.mjs baseline)');
  if (recorded.length && !ownRecord) {
    problems.push(`proposal.md records no baseline hash for this change's own capability (${own.replace(/-/g, '/')} or similar); add it with gate.mjs baseline`);
  }
  for (const [, capability, hash] of recorded) {
    const now = baselineHash(root, capability);
    if (now === null) problems.push(`no baseline spec for ${capability}`);
    else if (now !== hash.toLowerCase()) problems.push(`the baseline of ${capability} changed after this port started (an amendment was archived); update the port to it, then record the new hash`);
  }
  checkCarried(root, readIf(path.join(dir, 'design.md'), problems) ?? '', problems);
  checkDatabaseDrift(root, problems);
  const capability = ownRecord ? capabilitySegments(ownRecord[1]).join('/') : null;
  const evidence = capability ? checkPortEvidence(root, change, dir, capability, problems) : {};
  return { ok: problems.length === 0, problems, ...evidence };
}

// What proves the port behaves like the source: a passing verify run on the
// code as it is now, a test for every baseline scenario, no unaccepted
// TODO(port), and an independent crosscheck of every requirement and screen
// made on the code as it is now.
function checkPortEvidence(root, change, dir, capability, problems) {
  const spec = readIf(path.join(root, 'openspec/specs', ...capability.split('/'), 'spec.md'), problems) ?? '';
  const files = targetFiles(root);
  if (files === null) problems.push('openspec/config.yaml names no target root inside the repository ("Target root ...:")');
  const hashes = targetHashes(root, files ?? []);
  const now = targetHash(root, files ?? [], hashes);
  const again = `run verify.mjs --change ${change} again`;

  // 1. The verify run.
  const plan = verifyPlan(root, change, capability);
  problems.push(...plan.problems);
  const receiptText = readIf(path.join(dir, VERIFY_RECEIPT), problems);
  let receipt = null;
  if (receiptText === null) problems.push(`no ${VERIFY_RECEIPT}: run the tests with verify.mjs --change ${change}`);
  else {
    try { receipt = JSON.parse(receiptText); } catch { /* reported below */ }
    const valid = receipt && typeof receipt === 'object' && !Array.isArray(receipt) && Array.isArray(receipt.runs)
      && receipt.runs.every((r) => r && typeof r === 'object' && typeof r.level === 'string') && receipt.change === change
      && typeof receipt.target?.sha256 === 'string' && (receipt.target.sameCode === undefined || Array.isArray(receipt.target.sameCode));
    if (!valid) { problems.push(`${VERIFY_RECEIPT} is not a verify run of ${change}: ${again}`); receipt = null; }
  }
  if (receipt) {
    for (const { level, command } of plan.runs) {
      const run = receipt.runs.find((r) => r.level === level);
      if (!run) problems.push(`the last verify run did not run ${levelName(level)}: ${again}`);
      else if (run.command !== command) problems.push(`the ${level === 'boundary' ? 'boundary check' : `level ${level}`} command changed since the last verify run: ${again}`);
      else if (run.exitCode !== 0) problems.push(`${levelName(level)} failed in the last verify run (${run.timedOut ? 'timed out' : `exit code ${run.exitCode}`}): fix it, then ${again}`);
    }
    if (files !== null && receipt.target.sha256 !== now) {
      const before = receipt.target.files && typeof receipt.target.files === 'object' ? receipt.target.files : null;
      problems.push(`the target code changed after the last verify run${before ? ` (${changedPaths(before, hashes).join(', ')})` : ''}: ${again}`);
    }
  }

  // 2. A test for every scenario, and no tag naming a scenario the baseline lacks.
  const { tags, todos, utf16 } = scanTarget(root, files ?? []);
  for (const f of utf16.slice(0, 10)) problems.push(`${f} is UTF-16, so its tags and TODO(port) cannot be read; save it as UTF-8`);
  const scenarios = scenarioList(spec);
  for (const s of scenarios) {
    if (!tags.some((tag) => tagMatches(tag, capability, s))) problems.push(`no test is tagged for scenario "${s.scenario}" of requirement "${s.requirement}" (spec-relay: ${capability} | ${s.requirement} | ${s.scenario})`);
  }
  for (const tag of tags.filter((t) => t.capability === squash(capability))) {
    if (!scenarios.some((s) => tagMatches(tag, capability, s))) problems.push(`${tag.file}:${tag.line} is tagged for a scenario the baseline of ${capability} does not have; rename the tag or the test`);
  }

  // 2b. How each scenario is checked (design.md's Scenario checks), and the
  // evidence for it: a unit test, a recorded case, or a screen test that
  // passed on the old system and then on the new one.
  const scenarioChecks = checkScenarios(root, change, dir, capability, { plan, receipt, tags, scenarios }, problems);

  // 3. TODO(port) left in the target code.
  const accepted = followUpFiles(root, dir);
  const open = todos.filter((t) => !accepted.has(t.file));
  for (const t of open.slice(0, 20)) problems.push(`TODO(port) left at ${t.file}:${t.line}: ${t.text}`);
  if (open.length > 20) problems.push(`...and ${open.length - 20} more TODO(port)`);
  const followUp = [...new Set(todos.filter((t) => accepted.get(t.file) === true).map((t) => t.file))];

  // 4. The independent crosscheck of the port, merged on the code as it is now.
  const extract = archivedChange(root, `extract-${capability.split('/').join('-')}`);
  const screens = extract ? screenNames(readIf(path.join(extract, 'screens.md'), problems)) : [];
  const crosscheck = readIf(path.join(dir, 'crosscheck.md'), []);
  checkCrosscheck(dir, requirementNames(spec), screens, problems);
  if (crosscheck !== null && files !== null) {
    const stamp = crosscheck.match(CODE_STAMP)?.[1];
    // The same code as now: the current state, or one that differs from it only
    // by what verify runs wrote (test reports, recorded output), as the receipt
    // tracks it while the current state is the receipt's.
    const same = new Set([now, ...(receipt && receipt.target.sha256 === now ? receipt.target.sameCode ?? [] : [])]);
    if (!stamp) problems.push('crosscheck.md has no code stamp; merge the checkers\' part files into it with merge.mjs');
    else if (!same.has(stamp)) problems.push('the target code changed after the last crosscheck merge: run verify.mjs, have a checker check again the rows the change touches, and merge with merge.mjs');
  }

  // `compared`: the source program ran (B1, B2 or C); `inferred`: only tests from
  // the spec, which an AI wrote from reading the code.
  // The recorded cases of each compare level: unchanged since the verify run,
  // and how many matched under which rules, for the person.
  const cases = [];
  for (const { level, command } of plan.runs) {
    if (!isCompareCommand(command) || !receipt) continue;
    const ran = receipt.runs.find((r) => r.level === level && r.command === command && r.exitCode === 0);
    if (!ran) continue;
    const now = compareDigest(root, command);
    if (!ran.cases || ran.cases.sha256 !== now) problems.push(`the recorded cases, rules.json or the map of ${levelName(level)} changed after the last verify run: ${again}`);
    else cases.push({ level, count: ran.cases.count, rules: Array.isArray(ran.cases.rules) ? ran.cases.rules : [] });
  }
  // The screen tests of each e2e level: unchanged since they passed on the old
  // system and since the verify run, and how many passed, for the person.
  const screenTests = [];
  const targetRoot = path.resolve(root, relPath(cleanValue(configValue(root, 'Target root', ''))) || '.');
  for (const { level, command } of plan.runs) {
    if (!isE2eCommand(command) || !receipt) continue;
    const ran = receipt.runs.find((r) => r.level === level && r.command === command && r.exitCode === 0);
    if (!ran) continue;
    const now = e2eDigest(targetRoot, capability);
    const old = oldReceipt(root, capability, change);
    if (old.problem) problems.push(`${levelName(level)}: ${old.problem}`);
    else if (old.receipt.sha256 !== now.sha256) problems.push(`the screen tests or their screenshots (${E2E_DIR}/) changed after they passed on the old system: run e2e.mjs old again with the old system running, then ${again}`);
    else if (!old.receipt.origin || old.receipt.origin === e2eCommandOptions(command).url?.origin) problems.push(`${levelName(level)}: the old run did not test the old system (${old.receipt.origin || 'no address'}, the new system's address is the same): run e2e.mjs old against the test copy of the old system`);
    else if (!ran.e2e || ran.e2e.sha256 !== now.sha256) problems.push(`the screen tests or their screenshots (${E2E_DIR}/) changed after the last verify run: ${again}`);
    else if (level === 'C' && !(ran.e2e.screenshots > 0)) problems.push(`level C runs the screen tests, but they took no screenshot from the old system: add expect(page).toHaveScreenshot() to the tests of the screens, run e2e.mjs old again, then ${again}`);
    else screenTests.push({ level, tests: ran.e2e.tests, screenshots: ran.e2e.screenshots, origin: old.receipt.origin, ranAt: old.receipt.ranAt ?? '', loosened: Array.isArray(ran.e2e.loosened) ? ran.e2e.loosened : [] });
  }
  return { levels: ['A', ...plan.levels], equivalence: plan.levels.length ? 'compared' : 'inferred', commands: plan.runs, followUp, cases, screens: screenTests, scenarioChecks };
}

// Checks design.md's Scenario checks against the baseline and the evidence, and
// returns how many scenarios each kind checks. Without the table, every
// scenario counts as `unit`, which is allowed only when no comparison level or
// screen test runs.
function checkScenarios(root, change, dir, capability, { plan, receipt, tags, scenarios }, problems) {
  const counts = { e2e: 0, compare: 0, unit: 0 };
  const design = readIf(path.join(dir, 'design.md'), []) ?? '';
  const e2eLevels = plan.runs.filter((r) => isE2eCommand(r.command));
  const compareLevels = plan.runs.filter((r) => isCompareCommand(r.command));
  const checks = designScenarioChecks(design);
  if (checks === null || checks.length === 0) {
    if (e2eLevels.length || compareLevels.length) problems.push('design.md has no filled "## Scenario checks" table (| Requirement | Scenario | Check |): with screen tests or recorded cases, say for every scenario whether e2e, compare or unit checks it');
    counts.unit = scenarios.length;
    return counts;
  }
  const target = relPath(cleanValue(configValue(root, 'Target root', ''))).replace(/\/$/, '').replace(/^\.$/, '');
  const within = (file, folder) => file.toLowerCase().startsWith(`${(target ? `${target}/${folder}` : folder).replace(/\/+$/, '').toLowerCase()}/`);
  const caseFolders = compareLevels.map((r) => {
    const argv = commandWords(r.command.trim().slice(COMPARE_COMMAND.length));
    return relPath(argv ? parseOptions(argv).cases ?? '' : '').replace(/\/+$/, '');
  }).filter(Boolean);
  // The `scenario` keys of the recorded cases (read as JSON, also where git ignores the folder).
  const caseTags = [];
  const targetAbs = path.resolve(root, target || '.');
  for (const folder of caseFolders) {
    for (const file of walk(path.resolve(targetAbs, folder)).filter((f) => /\.jsonl$/i.test(f))) {
      for (const line of (readIf(file, []) ?? '').split(/\r?\n/)) {
        let value;
        try { value = JSON.parse(line); } catch { continue; }
        const keys = value && typeof value === 'object' ? [value.scenario].flat() : [];
        for (const key of keys) { const tag = typeof key === 'string' ? titleTag(key) : null; if (tag) caseTags.push(tag); }
      }
    }
  }
  // The titles of the screen tests that passed on the old system and in the last verify run.
  const old = e2eLevels.length ? oldReceipt(root, capability, change) : null;
  const oldTitles = old?.receipt ? old.receipt.tests.map((t) => t.title) : [];
  const newTitles = (receipt?.runs ?? []).filter((r) => r.exitCode === 0 && e2eLevels.some((l) => l.level === r.level && l.command === r.command) && Array.isArray(r.e2e?.titles)).flatMap((r) => r.e2e.titles);
  const proven = (titles, s) => titles.some((title) => { const tag = titleTag(title); return tag && tagMatches(tag, capability, s); });
  const sameScenario = (row, s) => squash(row.requirement) === squash(plain(s.requirement)) && squash(row.scenario) === squash(plain(s.scenario));
  for (const row of checks) {
    if (!row.check) problems.push(`design.md's Scenario checks: "${row.cell}" for scenario "${row.scenario}" is not e2e, compare or unit`);
    if (!scenarios.some((s) => sameScenario(row, s))) problems.push(`design.md's Scenario checks names a scenario the baseline of ${capability} does not have: "${row.requirement} | ${row.scenario}"`);
  }
  for (const s of scenarios) {
    const rows = checks.filter((row) => sameScenario(row, s));
    const name = `scenario "${s.scenario}" of requirement "${s.requirement}"`;
    if (rows.length === 0) { problems.push(`design.md's Scenario checks has no row for ${name}`); continue; }
    if (new Set(rows.map((row) => row.check)).size > 1) problems.push(`design.md's Scenario checks gives ${name} more than one check; choose one`);
    const kind = rows[0].check;
    if (!kind) continue;
    counts[kind] += 1;
    const tagged = tags.filter((t) => tagMatches(t, capability, s));
    if (kind === 'unit') {
      if (tagged.length && !tagged.some((t) => !within(t.file, E2E_DIR) && !/\.jsonl?$/i.test(t.file))) problems.push(`${name} is checked by unit, but its only tags are in screen tests or data files; tag a test in the target language`);
    } else if (kind === 'compare') {
      if (!caseFolders.length) problems.push(`${name} is checked by compare, but design.md's Verification has no spec-relay-compare command`);
      else if (!caseTags.some((t) => tagMatches(t, capability, s))) problems.push(`no recorded case in ${caseFolders.join(', ')} carries the tag of ${name} (a "scenario" key holding spec-relay: ${capability} | ${s.requirement} | ${s.scenario})`);
    } else if (!e2eLevels.length) problems.push(`${name} is checked by e2e, but design.md's Verification has no spec-relay-e2e command`);
    else if (!proven(oldTitles, s)) problems.push(`no screen test titled with the tag of ${name} passed on the old system (spec-relay: ${capability} | ${s.requirement} | ${s.scenario})`);
    else if (receipt && !proven(newTitles, s)) problems.push(`the screen test of ${name} did not pass on the new system in the last verify run`);
  }
  return counts;
}

// The same bytes; a text file may differ only in CRLF and LF line endings.
function sameContent(a, b) {
  if (a.equals(b)) return true;
  if (a.includes(0) || b.includes(0)) return false;
  return a.toString('latin1').replace(/\r\n/g, '\n') === b.toString('latin1').replace(/\r\n/g, '\n');
}

// design.md's "## Carried files" (source | target): each row must be a carry
// row of the archived survey's inventory, placed where the archived ui.md says,
// and the target must hold the same content. A folder row (ending in /) covers
// the carry files below it; a target ending in / is a folder that receives the
// file under its own name. When ui.md places carried files, design.md must have
// the section (a table or "None"), so a renamed heading cannot skip the check.
function checkCarried(root, design, problems) {
  const target = archivedChange(root, 'target-design');
  const placed = target ? carriedRows(readIf(path.join(target, 'ui.md'), []) ?? '') ?? [] : [];
  const rows = carriedRows(design);
  if (rows === null) {
    if (placed.length) problems.push('design.md has no "## Carried files" section; ui.md carries files, so list the ones this port copies, or write None');
    return;
  }
  if (rows.length === 0) return;
  const survey = archivedChange(root, 'survey');
  if (!survey) { problems.push('design.md lists carried files, but there is no archived survey whose inventory marks them carry'); return; }
  const inventory = inventoryRows(readIf(path.join(survey, 'inventory.md'), problems));
  const files = sourceFiles(root) ?? [];
  const sources = new Set(files.map((f) => f.toLowerCase()));
  const destOf = (row, file) => (row.source.endsWith('/') ? `${row.target}${file.slice(row.source.length)}` : row.target.endsWith('/') ? `${row.target}${path.posix.basename(file)}` : row.target);
  // The ui.md row that decides a file: its own row, else the longest folder row above it.
  const placeOf = (file) => placed.find((p) => p.source === file)
    ?? placed.filter((p) => p.source.endsWith('/') && file.startsWith(p.source)).sort((a, b) => b.source.length - a.source.length)[0];
  for (const row of rows) {
    const why = badTarget(root, row.source, row.target);
    if (why) { problems.push(`carried file row "${row.source}": ${why}`); continue; }
    const folder = row.source.endsWith('/');
    if (!folder && !files.includes(row.source) && files.some((f) => f.startsWith(`${row.source}/`))) { problems.push(`carried file row "${row.source}" is a folder; end it with /`); continue; }
    const listed = folder ? files.filter((f) => f.startsWith(row.source)) : [row.source];
    const carried = listed.filter((f) => inventoryRowFor(inventory, f)?.handling === 'carry');
    if (!folder && carried.length === 0) { problems.push(`carried file ${row.source} is not a carry row in the inventory; port it, or mark it carry in a new survey`); continue; }
    if (carried.length === 0) { problems.push(`no file under ${row.source} is a carry file in the inventory`); continue; }
    for (const file of carried) {
      const dest = destOf(row, file);
      const place = placeOf(file);
      if (!place) { problems.push(`carried file ${file} has no place in the archived ui.md's carried files`); continue; }
      if (destOf(place, file).toLowerCase() !== dest.toLowerCase()) { problems.push(`carried file ${file} goes to ${dest}, but ui.md places it at ${destOf(place, file)}`); continue; }
      if (dest.toLowerCase() === file.toLowerCase() || (sources.has(dest.toLowerCase()) && inventoryRowFor(inventory, dest))) { problems.push(`carried file ${file} would be copied onto the source file ${dest}`); continue; }
      let from; let to;
      try { from = fs.readFileSync(path.join(root, file)); } catch { problems.push(`carried file ${file} cannot be read`); continue; }
      try { to = fs.readFileSync(path.join(root, dest)); } catch (error) {
        problems.push(error.code === 'EISDIR' ? `carried file target ${dest} is a folder; end the target with /` : `carried file ${file} is missing at ${dest}`);
        continue;
      }
      if (!sameContent(from, to)) problems.push(`carried file ${dest} differs from ${file}; a carried file is copied unchanged (port it instead if it needs an edit)`);
    }
  }
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
    fixing: (n, list) => `You asked for a change on ${n} item${n === 1 ? '' : 's'} (${list}). I correct the artifacts, write what I changed under each ("fixed:"), and ask you to look again.`,
    onHold: (n, list) => `${n} item${n === 1 ? ' is' : 's are'} on hold (${list}). When you have decided, confirm it, or write what should change ("fix:").`,
    decision: (list) => `These questions have no decision yet: ${list}. Decide what the new system should do.`,
    archive: 'Everything is reviewed. Answer whether this change may be archived (that makes it final).',
    portArchive: 'Every task is done, the tests and the boundary check pass on the code as it is, and the independent crosscheck confirmed every requirement and screen. Answer whether the port may be archived.',
    inferred: 'Only level A ran: tests from the spec, which an AI wrote from reading the source code. The source program was not run, so that the new code behaves the same is inferred from the code, not compared.',
    compared: (levels) => `The source program was compared as well (${levels}).`,
    cases: (level, n, rules) => `${level}: all ${n} recorded case${n === 1 ? '' : 's'} match${rules.length ? `, with the rules ${rules.join('; ')} (design.md's Decisions should say why)` : ''}`,
    screens: (e) => (e.level === 'C' ? `C: the new screens match the ${e.screenshots} screenshot${e.screenshots === 1 ? '' : 's'} taken from the source program${e.loosened.length ? `, with the comparison loosened at ${e.loosened.join(', ')} (design.md's Decisions should say why)` : ''}` : `${e.level}: all ${e.tests} screen test${e.tests === 1 ? '' : 's'} passed on the source program first (${e.origin}, ${e.ranAt.slice(0, 10)}), then on the new system`),
    scenarioChecks: (c) => `How the ${c.e2e + c.compare + c.unit} scenarios are checked: ${c.e2e} by screen tests run on both systems, ${c.compare} by cases recorded from the source program, ${c.unit} by unit tests.`,
    commands: (list) => `The verify run ran: ${list}.`,
    overridden: (levels) => `For ${levels}, this port's design.md replaced the command of the reviewed conventions.md; check that it is the right one.`,
    followUp: (files) => `TODO(port) left for later with your agreement (proposal.md, Follow-up): ${files}.`,
    activeReview: (name) => `${name} is still under review. Finish that review first.`,
    foundation: (name) => (name === 'survey'
      ? 'The survey (the map of contexts and the capability list) is not reviewed and archived yet. I prepare it; its review is yours, and this step waits for it.'
      : 'The target design is not reviewed and archived yet. I prepare it; its review is yours, and implementation waits for it.'),
    guard: (list) => `Files outside the subagents' assignments changed (${list}). Decide: undo the change, or keep it. The results of this wave are not used until you decide.`,
    dbDrift: 'The database definitions (openspec/spec-relay/db/) changed after the survey was reviewed. If you exported them again on purpose, the survey is run again (survey-v2) and you review what changed; after its archive, the orchestrator copies the capability paths of the new definitions into plan.md and runs gate.mjs coverage. If not, restore the files from git.',
    dbUtf16: (list) => `Some database definitions are saved as UTF-16 (${list}). Export them again as UTF-8, or convert them as docs/DATABASE.md shows.`,
  },
  ja: {
    unticked: (n, list) => `レビューで未承認の項目が ${n} 件あります（${list}）。チャットで承認を伝えるか、review.md で自分でチェックしてください。`,
    reviewer: 'review.md に承認者の名前（Reviewer:）がありません。記録する名前を教えてください。',
    fixing: (n, list) => `直してほしいと書いた項目が ${n} 件あります（${list}）。AI が成果物を直し、各項目の下に直した内容（fixed:）を書くので、もう一度確認してください。`,
    onHold: (n, list) => `保留中の項目が ${n} 件あります（${list}）。決まったら確認済みにするか、直してほしい点（fix:）を書いてください。`,
    decision: (list) => `判断がまだの質問があります（${list}）。新しいシステムでどうするかを決めてください。`,
    archive: 'すべてレビュー済みです。この change を archive（確定）してよいかを答えてください。',
    portArchive: 'すべてのタスクが完了し、今のコードでテストと境界チェックが通り、別の AI による照合ですべての要件と画面が確認できました。実装を archive してよいかを答えてください。',
    inferred: '比べ方は A（仕様のシナリオから作ったテスト）だけです。仕様は AI が元コードを読んで書いたもので、元のプログラムは動かしていません。同じ動きであることは、比べた結果ではなくコードを読んだうえでの推定です。',
    compared: (levels) => `元のプログラムとの比較（${levels}）も通りました。`,
    cases: (level, n, rules) => `${level}: 記録された ${n} 件がすべて一致${rules.length ? `。比べ方をゆるめる規則 ${rules.join('; ')} を使用（理由は design.md の Decisions に）` : ''}`,
    screens: (e) => (e.level === 'C' ? `C: 元のシステムで撮った ${e.screenshots} 枚のスクリーンショットと新しい画面が一致${e.loosened.length ? `。比べ方をゆるめる設定 ${e.loosened.join(', ')} を使用（理由は design.md の Decisions に）` : ''}` : `${e.level}: 画面のテスト ${e.tests} 件が、元のシステム（${e.origin}、${e.ranAt.slice(0, 10)} の実行）で通ったあと、新しいシステムでも通過`),
    scenarioChecks: (c) => `シナリオ ${c.e2e + c.compare + c.unit} 件の確認方法: 画面のテスト（新旧の両方で実行）${c.e2e} 件、元のプログラムの記録との比較 ${c.compare} 件、単体テスト ${c.unit} 件。`,
    commands: (list) => `実行したコマンド: ${list}。`,
    overridden: (levels) => `${levels} は、レビュー済みの conventions.md ではなく、この port の design.md のコマンドで実行しました。正しいコマンドかを確かめてください。`,
    followUp: (files) => `了承を得て後の作業に回した TODO(port)（proposal.md の Follow-up）: ${files}。`,
    activeReview: (name) => `${name} のレビューがまだ終わっていません。先にそのレビューを終えてください。`,
    foundation: (name) => (name === 'survey'
      ? '調査（コンテキストの地図と capability の一覧）がまだレビュー・archive されていません。AI が用意するので、そのレビューをお願いします。この工程はそれを待ちます。'
      : '移行先の設計がまだレビュー・archive されていません。AI が用意するので、そのレビューをお願いします。実装はそれを待ちます。'),
    guard: (list) => `割り当て外のファイルが変わりました（${list}）。元に戻すか、そのまま受け入れるかを決めてください。決まるまで、この波の結果は使いません。`,
    dbDrift: 'DB の定義（openspec/spec-relay/db/）が、調査のレビューのあとで変わりました。意図して取り直したのなら調査をやり直し（survey-v2）、変わったところをレビューしてください。その archive のあと、オーケストレーターが新しい定義の capability を plan.md に写し、gate.mjs coverage で確かめます。意図しない変更なら git で元に戻してください。',
    dbUtf16: (list) => `DB の定義ファイルが UTF-16 で保存されています（${list}）。UTF-8 で出し直すか、docs/DATABASE.md の手順で変換してください。`,
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
    const canvas = result.canvas?.length ? [`The person changed ${result.canvas.join(', ')} in the canvas during the wave (ticks, decisions or the reviewer's name). Read them again before using them; they are the person's own edits.`] : [];
    return { person, agent: [...(result.problems ?? []), ...canvas] };
  }
  const problems = result.problems ?? [];
  // "R1", "R1:", "**R01**" all name R1.
  const idOf = (text) => { const m = plain(text).match(/^([A-Za-z])0*(\d+)/); return m ? `${m[1].toUpperCase()}${m[2]}` : plain(text).split(' ')[0]; };
  const fixing = problems.filter((p) => p.startsWith('fix requested and not answered: ')).map((p) => idOf(p.slice('fix requested and not answered: '.length)));
  const held = problems.filter((p) => p.startsWith('on hold: ')).map((p) => idOf(p.slice('on hold: '.length)));
  const unticked = problems.filter((p) => p.startsWith('not ticked: ')).map((p) => idOf(p.slice('not ticked: '.length)))
    .filter((id) => !fixing.includes(id) && !held.includes(id));
  const undecided = problems.filter((p) => p.startsWith('question has no recorded decision: ')).map((p) => p.slice('question has no recorded decision: '.length));
  const active = problems.map((p) => p.match(/^(?:extract|amend) change (\S+) is still active/)?.[1]).filter(Boolean);
  const foundation = ['survey', 'target-design'].filter((name) => problems.some((p) => p.startsWith(`no archived ${name} change`)));
  if (unticked.length) person.push(words.unticked(unticked.length, shortList(unticked)));
  if (fixing.length) person.push(words.fixing(fixing.length, shortList(fixing)));
  if (held.length) person.push(words.onHold(held.length, shortList(held)));
  if (problems.some((p) => p.startsWith('review.md names no reviewer'))) person.push(words.reviewer);
  if (undecided.length) person.push(words.decision(shortList(undecided)));
  for (const name of active) person.push(words.activeReview(name));
  for (const name of foundation) person.push(words.foundation(name));
  if (problems.some((p) => p.startsWith('database definitions changed after the survey'))) person.push(words.dbDrift);
  const wide = problems.filter((p) => p.startsWith('database definition is UTF-16: ')).map((p) => p.slice('database definition is UTF-16: '.length));
  if (wide.length) person.push(words.dbUtf16(shortList(wide)));
  agent = problems.filter((p) => !/^(not ticked: |on hold: |review\.md names no reviewer|question has no recorded decision: |(?:extract|amend) change \S+ is still active|no archived (?:survey|target-design) change|database definitions changed after the survey|database definition is UTF-16: |\.\.\.and \d+ more UTF-16)/.test(p));
  if (result.ok && command === 'review') person.push(words.archive);
  if (result.ok && command === 'port-done') {
    person.push(words.portArchive);
    const levels = (result.levels ?? []).filter((level) => level !== 'A');
    const counted = (level) => {
      const c = (result.cases ?? []).find((x) => x.level === level);
      const e = (result.screens ?? []).find((x) => x.level === level);
      return c ? words.cases(level, c.count, c.rules) : e ? words.screens(e) : level;
    };
    person.push(result.equivalence === 'compared' ? words.compared(levels.map(counted).join(', ')) : words.inferred);
    const checks = result.scenarioChecks;
    if (checks && (checks.e2e || checks.compare)) person.push(words.scenarioChecks(checks));
    const commands = result.commands ?? [];
    const label = (level) => (level === 'boundary' ? (lang === 'ja' ? '境界チェック' : 'boundary check') : level);
    if (commands.length) person.push(words.commands(commands.map((c) => `${label(c.level)} \`${c.command}\` (${c.from})`).join(', ')));
    const overridden = commands.filter((c) => c.from === 'design.md' && (c.level === 'A' || c.level === 'boundary'));
    if (overridden.length) person.push(words.overridden(overridden.map((c) => label(c.level)).join(', ')));
    if (result.followUp?.length) person.push(words.followUp(result.followUp.join(', ')));
  }
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
  else if (command === 'coverage' && !opts.change && !opts.capability) result = checkCoverage(opts.root);
  else if (command === 'guard' && opts.save !== undefined && opts.compare === undefined) result = guardSave(opts.root, opts.save);
  else if (command === 'guard' && opts.compare !== undefined && opts.save === undefined) result = guardCompare(opts.root, opts.compare);
  else if (command === 'guard' && opts.save === undefined && opts.compare === undefined) result = guardHash(opts.root);
  else if (command === 'db-hash') {
    const wide = databaseUtf16(opts.root);
    result = { ok: wide.length === 0, sha256: databaseHash(opts.root), files: databaseFiles(opts.root).length, ...(wide.length ? { problems: wide.map((f) => `database definition is UTF-16: ${f}`) } : {}) };
  }
  else if (command === 'baseline' && opts.capability) {
    const sha256 = baselineHash(opts.root, opts.capability);
    result = sha256 ? { ok: true, capability: opts.capability, sha256 } : { ok: false, problems: [`no baseline spec for ${opts.capability}`] };
  }
  else return usage();
  if (command !== 'baseline' && !(command === 'db-hash' && result.ok) && !(command === 'guard' && opts.compare === undefined)) {
    result.next = nextSteps(command, result, language(opts.root, opts.lang));
  }
  console.log(JSON.stringify(result, null, 2));
  return result.ok ? 0 : 1;
}

function usage() {
  console.error('Usage: node gate.mjs review --change NAME | port-ready --capability PATH | port-done --change NAME | baseline --capability PATH | coverage | db-hash | guard [--save NAME | --compare NAME] [--root DIR] [--lang ja|en]');
  return 2;
}

function invokedDirectly() {
  if (!process.argv[1]) return false;
  try { return fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url)); } catch { return false; }
}

if (invokedDirectly()) process.exitCode = main(process.argv.slice(2));
