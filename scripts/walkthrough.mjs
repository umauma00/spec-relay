// The walkthrough of an extract change: an independent checker starts at each
// entry point of the capability (a page, a button's handler, a route, a job, a
// public function), follows the code to its end, also into other files, and
// lists every behavior a user or caller can notice on the way. Each behavior
// names the scenario that states it.
//
// The crosscheck asks whether what the spec says is right, and the omission
// check (sites.mjs, coverage.md) asks site by site whether a requirement covers
// it. Neither follows one request from its start to its end, and a site can be
// judged "covered" by a requirement whose scenarios never state one of its
// branches. The walkthrough cuts the code the other way and must name the exact
// scenario, so a gap one of the three checks misses can still be found by another.
//
// walkthrough.md is one table, `| Entry point | Behavior | Verdict | Evidence |`,
// with any number of rows per entry point. The entry points are those of
// source-map.md (## Entry points); a checker that finds one the source map
// lacks writes it too, and the gate asks for it in the source map.
import fs from 'node:fs';
import path from 'node:path';
import { readIf, headedRows, section, scenarioList, PLACEHOLDER } from './gate.mjs';
import { ownersOf } from './coverage.mjs';
import { parseRefs } from './render.mjs';

const stripComments = (text) => String(text ?? '').replace(/<!--[\s\S]*?-->/g, '');
const FENCE = /^\s*(```|~~~)/;
const MAX_LISTED = 20;

function capped(problems, list, say) {
  for (const item of list.slice(0, MAX_LISTED)) problems.push(say(item));
  if (list.length > MAX_LISTED) problems.push(`...and ${list.length - MAX_LISTED} more`);
}

// An entry point id as the rows and the source map are compared: backticks and
// a leading "./" go, backslashes become "/", and the path (before the first ":")
// ignores letter case (Windows); the symbol keeps it.
export function entryKey(text) {
  const t = stripComments(text).trim().replace(/^`(.*)`$/, '$1').trim().replace(/\\/g, '/').replace(/^(\.\/)+/, '');
  const colon = t.indexOf(':');
  return colon < 0 ? t.toLowerCase() : `${t.slice(0, colon).toLowerCase()}${t.slice(colon)}`;
}

// The id of an entry point item: its first backticked token when the item
// starts with one, else the words before " - " (or " — ", " – ", ": " after
// a space).
function entryId(item) {
  const t = item.replace(/\*\*|__/g, '').trim();
  const code = t.match(/^`([^`]+)`/);
  if (code) return code[1].trim();
  return t.split(/\s+[-–—]\s+|\s[-–—]$/)[0].trim();
}

// The entry points under "## Entry points" of a source map: [{ id, key }], in
// order, without duplicates. A table there is read by its first column.
export function entryPoints(text) {
  const body = section(text ?? '', /^(entry points?|入口|エントリーポイント)/i);
  if (body === null) return null;
  const out = [];
  const seen = new Set();
  const add = (id) => {
    if (!id || PLACEHOLDER.test(id) || /^(none|なし|無し)\.?$/i.test(id)) return;
    const key = entryKey(id);
    if (seen.has(key)) return;
    seen.add(key);
    out.push({ id, key });
  };
  let fenced = false;
  for (const line of stripComments(body).split(/\r?\n/)) {
    if (FENCE.test(line)) { fenced = !fenced; continue; }
    if (fenced) continue;
    const item = line.match(/^ {0,3}(?:[-*+]|\d+[.)])\s+(.*)$/);
    if (item) add(entryId(item[1]));
  }
  for (const { header, cells } of headedRows(body)) {
    if (/^(entry|入口|path|パス)/.test(header[0] ?? '')) add(entryId(cells[0] ?? ''));
  }
  return out;
}

// What a scenario name is compared as: no marks, quotes or case.
const loose = (s) => stripComments(s).replace(/[*`"'“”「」『』]/g, '').replace(/\s+/g, ' ').trim().toLowerCase();

// The verdict cell: { kind, refs } where refs are [{ letter, n, scenario }].
// covered R3: <scenario>; R4: <scenario>; S1  |  vague R3: <scenario>
// other capability <path>  |  question Q2  |  gap
export function parseWalkVerdict(cell) {
  const v = stripComments(cell).replace(/\*\*|__/g, '').trim().replace(/[.。]$/, '');
  let m = v.match(/^(covered|vague)\b\s*:?\s*(.*)$/i);
  if (m) {
    const refs = [];
    for (const part of m[2].split(/\s*;\s*/).filter(Boolean)) {
      const r = part.match(/^R0*(\d+)\s*[:：]\s*(.+)$/i);
      const s = part.match(/^S0*(\d+)$/i);
      const bare = part.match(/^R0*(\d+)$/i);
      if (r) refs.push({ letter: 'R', n: Number(r[1]), scenario: r[2].trim() });
      else if (s) refs.push({ letter: 'S', n: Number(s[1]) });
      else if (bare) refs.push({ letter: 'R', n: Number(bare[1]), scenario: '' });
      else return { kind: 'invalid' };
    }
    return refs.length ? { kind: m[1].toLowerCase(), refs } : { kind: 'invalid' };
  }
  m = v.match(/^other[\s-]+capability\s*:?\s*([a-z0-9]+(?:-[a-z0-9]+)*(?:\/[a-z0-9]+(?:-[a-z0-9]+)*)+)$/i);
  if (m) return { kind: 'other', capability: m[1].toLowerCase() };
  m = v.match(/^question\s*:?\s*Q0*(\d+)$/i);
  if (m) return { kind: 'question', question: `Q${Number(m[1])}` };
  if (/^gap$/i.test(v)) return { kind: 'gap' };
  return { kind: v ? 'invalid' : 'blank' };
}

// The rows of the tables whose first column is Entry point.
export function walkthroughRows(text) {
  return headedRows(text ?? '').filter(({ header }) => /^(entry|入口)/.test(header[0] ?? '')).map(({ cells }) => {
    const [entry = '', behavior = '', verdict = '', evidence = ''] = cells;
    return { entry: entry.trim(), key: entryKey(entry), behavior: stripComments(behavior).trim(), verdict: verdict.trim(), evidence: stripComments(evidence).trim(), parsed: parseWalkVerdict(verdict) };
  }).filter((row) => row.key);
}

// The scenario names of each requirement, by requirement name (lowercase).
function scenariosByRequirement(dir) {
  const map = new Map();
  for (const { requirement, scenario } of scenarioList(specText(dir))) {
    const key = loose(requirement);
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(loose(scenario));
  }
  return map;
}

function specText(dir) {
  // The specs of one change (one capability), in the order the gate numbers them.
  return specFiles(path.join(dir, 'specs')).map((f) => readIf(f, []) ?? '').join('\n');
}

function specFiles(dir) {
  let entries = [];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return []; }
  return entries.flatMap((e) => (e.isDirectory() ? specFiles(path.join(dir, e.name)) : e.name.endsWith('.md') ? [path.join(dir, e.name)] : [])).sort();
}

const VERDICTS = 'covered R<n>: <scenario name> (or covered S<n>), vague R<n>: <scenario name>, other capability <path>, question Q<n> or gap';

// Extract review: every entry point of the source map is walked, every behavior
// names a scenario that exists (or a screen, another capability of the plan, a
// question with a review item), and no gap or vague scenario is left.
// `requirements` and `screens` are the names in spec and screens.md order (R1,
// S1...), `asked` the question ids with a review item, `assignment` the plan's
// capabilities with their source paths, `own` this change's capability.
export function checkWalkthrough(root, dir, { requirements, screens, asked, assignment, own }, problems) {
  const text = readIf(path.join(dir, 'walkthrough.md'), problems);
  if (text === null) { problems.push('walkthrough.md is missing (the walkthrough: checkers follow each entry point of source-map.md and name the scenario of every behavior; see the spec-relay skill)'); return; }
  const map = readIf(path.join(dir, 'source-map.md'), []);
  const entries = entryPoints(map);
  if (entries === null || entries.length === 0) {
    problems.push('source-map.md lists no entry point under "## Entry points" (pages, handlers, routes, jobs, public functions: path:symbol - how callers reach it), so the walkthrough has nowhere to start');
  }
  const rows = walkthroughRows(text);
  const walked = new Set(rows.map((r) => r.key));
  const listed = new Set((entries ?? []).map((e) => e.key));
  capped(problems, (entries ?? []).filter((e) => !walked.has(e.key)).map((e) => e.id), (id) => `entry point has no row in walkthrough.md: ${id} (have a checker walk it)`);
  capped(problems, [...new Set(rows.filter((r) => !listed.has(r.key)).map((r) => r.entry))], (id) => `walkthrough.md walks ${id}, which source-map.md does not list under "## Entry points": add it there (an entry point the analyst missed) or correct the id in walkthrough.md`);
  const scenarios = scenariosByRequirement(dir);
  const bad = [];
  for (const row of rows) {
    const where = `${row.entry} "${row.behavior || '?'}"`;
    const v = row.parsed;
    if (!row.behavior) bad.push(`walkthrough row of ${row.entry} names no behavior; write what a user or caller notices`);
    if (noEvidence(row.evidence)) bad.push(`walkthrough row ${where} has no evidence; give path:line and what the code does`);
    if (v.kind === 'covered' || v.kind === 'vague') {
      for (const ref of v.refs) {
        const names = ref.letter === 'R' ? requirements : screens;
        if (ref.n < 1 || ref.n > names.length) { bad.push(`walkthrough row ${where} names ${ref.letter}${ref.n}, but the change has ${names.length ? `only ${ref.letter}1-${ref.letter}${names.length}` : 'none'} as ${ref.letter === 'R' ? 'requirements' : 'screens'}`); continue; }
        if (ref.letter !== 'R') continue;
        const name = requirements[ref.n - 1];
        if (!ref.scenario) { bad.push(`walkthrough row ${where} names R${ref.n} without its scenario; write "covered R${ref.n}: <scenario name>" with the scenario that states the behavior`); continue; }
        if (!(scenarios.get(loose(name)) ?? []).includes(loose(ref.scenario))) bad.push(`walkthrough row ${where} names the scenario "${ref.scenario}", which R${ref.n} "${name}" does not have; copy the name of the scenario that states the behavior, or write gap`);
      }
      if (v.kind === 'vague') bad.push(`walkthrough row ${where} is vague: the scenario does not state the condition or the values an implementer needs; have an analyst make it concrete (then walk ${row.entry} again), or move it to questions.md as "question Q<n>"`);
    } else if (v.kind === 'other') {
      const paths = assignment.get(v.capability);
      if (v.capability === own) bad.push(`walkthrough row ${where} names its own capability as "other capability"`);
      else if (!paths) bad.push(`walkthrough row ${where} names ${v.capability}, which is not a capability of the plan`);
      else if (!parseRefs(row.evidence, root).some(({ file }) => ownersOf(assignment, file.replace(/^(\.\/)+/, '')).includes(v.capability))) bad.push(`walkthrough row ${where} names ${v.capability}, but its evidence cites no file the plan gives to that capability; cite the line in that capability's code, or judge the behavior here`);
    } else if (v.kind === 'question') {
      if (!asked.has(v.question)) bad.push(`walkthrough row ${where} points to ${v.question}, which is not in questions.md with a review item`);
    } else if (v.kind === 'gap') bad.push(`walkthrough row ${where} is a gap: add the requirement it needs at the end of the spec (then walk ${row.entry} again), or move it to questions.md as "question Q<n>"`);
    else bad.push(`walkthrough row ${where} has the verdict "${row.verdict || 'blank'}"; write only ${VERDICTS}, and put reasons in the Evidence cell`);
  }
  capped(problems, bad, (p) => p);
}

const noEvidence = (cell) => {
  const t = cell.replace(/[`'"*_]/g, '').trim();
  return PLACEHOLDER.test(t) || /^(?:[-–—―‐ー.。?？!・…]+|none|nothing|nil|null|na|なし|無し|特になし|不明)$/i.test(t);
};

// What the review page shows: how many entry points and behaviors were walked,
// the counts per verdict, the rows that are not covered here, and the entry
// points still missing.
export function walkthroughSummary(dir) {
  const text = readIf(path.join(dir, 'walkthrough.md'), []);
  if (text === null) return null;
  const rows = walkthroughRows(text);
  const entries = entryPoints(readIf(path.join(dir, 'source-map.md'), []) ?? '') ?? [];
  const walked = new Set(rows.map((r) => r.key));
  const counts = { covered: 0, other: 0, question: 0, open: 0 };
  const elsewhere = [];
  const open = [];
  for (const row of rows) {
    const kind = row.parsed.kind;
    if (kind === 'covered' || kind === 'other' || kind === 'question') counts[kind] += 1; else { counts.open += 1; open.push(row); }
    if (kind === 'other' || kind === 'question') elsewhere.push(row);
  }
  return {
    entries: new Set([...entries.map((e) => e.key), ...walked]).size,
    behaviors: rows.length,
    counts,
    elsewhere,
    open,
    unwalked: entries.filter((e) => !walked.has(e.key)).map((e) => e.id),
  };
}
