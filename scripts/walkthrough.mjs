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
import { ownersOf, repoPath, lineCount } from './coverage.mjs';
import { parseRefs } from './render.mjs';
import { readLedger, untracedEffects, markerText, refReaches, ledgerKey as ledgerId } from './sites.mjs';

const stripComments = (text) => String(text ?? '').replace(/<!--[\s\S]*?-->/g, '');
const FENCE = /^\s*(```|~~~)/;
const MAX_LISTED = 20;

// The first header cell of a walkthrough table, as gate.mjs and merge.mjs read it.
export const WALK_HEADER = /^(entry|入口|エントリ)/i;

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
// starts with one (bold around it is fine), else the words before " - " (or
// " — ", " – ", or ": " followed by a space: `path:symbol: how`).
function entryId(item) {
  const t = item.trim();
  const code = t.replace(/^(\*\*|__)/, '').match(/^`([^`]+)`/);
  if (code) return code[1].trim();
  const bare = t.replace(/^(\*\*|__)([\s\S]*?)\1/, '$2');
  return bare.split(/\s+[-–—]\s+|\s[-–—]$|:\s+/)[0].trim();
}

// "None", or "None (only internal helpers)": the capability has no way in.
const NONE = /^(none|なし|無し|該当なし)(?:\s*[(（:：\-–—]|\.?$)/i;

// The entry points under "## Entry points" of a source map: [{ id, key }], in
// order, without duplicates; `none` is set on the list when it says "None".
// Only top-level list items count (a nested item describes its parent), and a
// table there is read by its first column. Null when there is no such section.
export function entryPoints(text) {
  const body = section(text ?? '', /^(entry points?|入口|エントリー?ポイント)/i);
  if (body === null) return null;
  const out = [];
  const seen = new Set();
  const add = (id) => {
    if (!id || PLACEHOLDER.test(id)) return;
    if (NONE.test(id)) { out.none = true; return; }
    const key = entryKey(id);
    if (seen.has(key)) return;
    seen.add(key);
    out.push({ id, key });
  };
  let fenced = false;
  for (const line of stripComments(body).split(/\r?\n/)) {
    if (FENCE.test(line)) { fenced = !fenced; continue; }
    if (fenced) continue;
    const item = line.match(/^ ?(?:[-*+]|\d+[.)])\s+(.*)$/);
    if (item) add(entryId(item[1]));
  }
  for (const { header, cells } of headedRows(body)) {
    if (/^(entry|入口|エントリ|path|パス)/i.test(header[0] ?? '')) add(entryId(cells[0] ?? ''));
  }
  return out;
}

// What a scenario name is compared as: no marks, quotes, escapes, final stop or case.
const loose = (s) => stripComments(s).replace(/\\\|/g, '|').replace(/[*_`"'“”「」『』]/g, '').replace(/\s+/g, ' ').trim().replace(/[.。]$/, '').trim().toLowerCase();

// The verdict cell: { kind, refs } where refs are [{ letter, n, scenario }].
// covered R3: <scenario>; R4: <scenario>; S1  |  vague R3: <scenario>
// other capability <path>  |  question Q2  |  gap
export function parseWalkVerdict(cell) {
  const v = stripComments(cell).replace(/\*\*|__|`/g, '').trim().replace(/[.。]$/, '');
  let m = v.match(/^(covered|vague)\b\s*:?\s*(.*)$/i);
  if (m) {
    const refs = [];
    // A scenario name may hold ";": only "; R<n>" or "; S<n>" starts the next one.
    for (const part of m[2].split(/\s*[;；]\s*(?=[RS]\s*\d)/i).map((p) => p.trim()).filter(Boolean)) {
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

// The rows of the tables whose first column is Entry point. A row with an empty
// Entry point cell is kept (key ''), so the gate can name it.
export function walkthroughRows(text) {
  return headedRows(text ?? '').filter(({ header }) => WALK_HEADER.test(header[0] ?? '')).map(({ cells }) => {
    const [entry = '', behavior = '', verdict = '', evidence = ''] = cells;
    return { entry: entry.trim(), key: entryKey(entry), behavior: stripComments(behavior).trim(), verdict: verdict.trim(), evidence: stripComments(evidence).trim(), parsed: parseWalkVerdict(verdict) };
  }).filter((row) => row.key || row.behavior || row.verdict || row.evidence);
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
// question with a review item) and cites the code it comes from, no gap or
// vague scenario is left, every requirement is reached from some entry point,
// and the effect lines of every site coverage.md judges covered are reached by
// some row's evidence (a walk that stops at the first file reaches none of the
// writes and messages behind it). `requirements` and `screens` are the names in
// spec and screens.md order (R1, S1...), `asked` the question ids with a review
// item, `assignment` the plan's capabilities with their source paths, `own`
// this change's capability.
export function checkWalkthrough(root, dir, { requirements, screens, asked, assignment, own }, problems) {
  const text = readIf(path.join(dir, 'walkthrough.md'), problems);
  if (text === null) { problems.push('walkthrough.md is missing (the walkthrough: checkers follow each entry point of source-map.md and name the scenario of every behavior; see the spec-relay skill)'); return; }
  const map = readIf(path.join(dir, 'source-map.md'), []);
  const entries = entryPoints(map);
  const effects = coveredEffects(root, dir);
  if (entries === null || entries.length === 0) {
    if (!entries?.none) problems.push('source-map.md lists no entry point under "## Entry points" (pages, handlers, routes, jobs, public functions: path:symbol - how callers reach it), so the walkthrough has nowhere to start; when nothing calls into the capability at all (only definitions), write "- None (why)" there');
    else if (effects.length) capped(problems, effects.map(({ site, lines }) => `${site.id} (${markerText(lines)})`), (s) => `source-map.md says the capability has no entry point ("None"), but coverage.md judges ${s} covered: code that saves, sends or ends a request is reached from somewhere; list that way in under "## Entry points" (a page, a handler, a route, a job, a public function other capabilities call) and walk it`);
  }
  const all = walkthroughRows(text);
  const unnamed = all.filter((r) => !r.key);
  if (unnamed.length) problems.push(`walkthrough.md has ${unnamed.length} row${unnamed.length === 1 ? '' : 's'} with an empty Entry point cell (${unnamed.slice(0, 3).map((r) => `"${r.behavior || r.verdict || r.evidence}"`).join('; ')}); write the entry point on every row`);
  const rows = all.filter((r) => r.key);
  const walked = new Set(rows.map((r) => r.key));
  const listed = new Set((entries ?? []).map((e) => e.key));
  capped(problems, (entries ?? []).filter((e) => !walked.has(e.key)).map((e) => e.id), (id) => `entry point has no row in walkthrough.md: ${id} (have a checker walk it)`);
  capped(problems, [...new Set(rows.filter((r) => !listed.has(r.key)).map((r) => r.entry))], (id) => `walkthrough.md walks ${id}, which source-map.md does not list under "## Entry points": add it there (an entry point the analyst missed) or correct the id in walkthrough.md`);
  const scenarios = scenariosByRequirement(dir);
  const bad = [];
  const reached = [];
  const named = new Set();
  for (const row of rows) {
    const where = `${row.entry} "${row.behavior || '?'}"`;
    const v = row.parsed;
    if (!row.behavior) bad.push(`walkthrough row of ${row.entry} names no behavior; write what a user or caller notices`);
    if (noEvidence(row.evidence)) bad.push(`walkthrough row ${where} has no evidence; give path:line and what the code does`);
    else reached.push(...citedCode(root, row.evidence, where, bad));
    if (v.kind === 'covered' || v.kind === 'vague') {
      for (const ref of v.refs) {
        const names = ref.letter === 'R' ? requirements : screens;
        if (ref.n < 1 || ref.n > names.length) { bad.push(`walkthrough row ${where} names ${ref.letter}${ref.n}, but the change has ${names.length ? `only ${ref.letter}1-${ref.letter}${names.length}` : 'none'} as ${ref.letter === 'R' ? 'requirements' : 'screens'}`); continue; }
        if (ref.letter !== 'R') continue;
        const name = requirements[ref.n - 1];
        if (!ref.scenario) { bad.push(`walkthrough row ${where} names R${ref.n} without its scenario; write "covered R${ref.n}: <scenario name>" with the scenario that states the behavior`); continue; }
        if (!(scenarios.get(loose(name)) ?? []).includes(loose(ref.scenario))) { bad.push(`walkthrough row ${where} names the scenario "${ref.scenario}", which R${ref.n} "${name}" does not have; copy the name of the scenario that states the behavior, or write gap`); continue; }
        named.add(ref.n);
      }
      if (v.kind === 'vague') bad.push(`walkthrough row ${where} is vague: the scenario does not state the condition or the values an implementer needs; have an analyst make it concrete (then walk ${row.entry} again), or move it to questions.md as "question Q<n>"`);
    } else if (v.kind === 'other') {
      const paths = assignment.get(v.capability);
      if (v.capability === own) bad.push(`walkthrough row ${where} names its own capability as "other capability"`);
      else if (!paths) bad.push(`walkthrough row ${where} names ${v.capability}, which is not a capability of the plan`);
      else if (!evidenceRefs(row.evidence, root).some(({ file }) => ownersOf(assignment, repoPath(file)).includes(v.capability))) bad.push(`walkthrough row ${where} names ${v.capability}, but its evidence cites no file the plan gives to that capability; cite the line in that capability's code, or judge the behavior here`);
    } else if (v.kind === 'question') {
      if (!asked.has(v.question)) bad.push(`walkthrough row ${where} points to ${v.question}, which is not in questions.md with a review item`);
    } else if (v.kind === 'gap') bad.push(`walkthrough row ${where} is a gap: add the requirement it needs at the end of the spec (then walk ${row.entry} again), or move it to questions.md as "question Q<n>"`);
    else bad.push(`walkthrough row ${where} has the verdict "${row.verdict || 'blank'}"; write only ${VERDICTS}, and put reasons in the Evidence cell`);
  }
  capped(problems, bad, (p) => p);
  if (!entries?.length) return;
  // A requirement no walk reaches is behavior nobody can start, or a way in the
  // source map and the walk both missed.
  capped(problems, requirements.map((name, i) => ({ name, n: i + 1 })).filter(({ n }) => !named.has(n)), ({ name, n }) => `no walkthrough row names a scenario of R${n} "${name}": the entry point that leads there is missing from source-map.md or was not walked to its end; list it (a public function or a job counts) and walk it`);
  // Every effect of a covered site is a behavior somebody starts: some walk must reach it.
  capped(problems, effects.map(({ site, lines }) => ({ site, lines: lines.filter((m) => !reached.some((ref) => refReaches(ref, site, m.line))) })).filter(({ lines }) => lines.length), ({ site, lines }) => `no walkthrough row reaches the effect lines of ${site.id} (${markerText(lines)}), which coverage.md judges covered: walk the entry point that leads there to the end and cite the line (or the member) in that row's evidence, or list the entry point the source map misses; when nothing reaches the code (dead code), judge the site "question Q<n>" in coverage.md`);
}

// The effect lines of the sites coverage.md judges covered, without the lines
// the checker set aside as "no effect": [{ site, lines }].
function coveredEffects(root, dir) {
  let ledger;
  try { ledger = readLedger(root, dir, []); } catch { return []; }
  if (ledger.text === null) return [];
  const out = [];
  for (const site of ledger.sites) {
    const row = ledger.rows.get(ledgerId(site.id));
    if (row?.parsed.kind !== 'covered') continue;
    const waived = new Set(row.parsed.dismissed ?? []);
    const lines = untracedEffects(site, []).filter((m) => !waived.has(m.line));
    if (lines.length) out.push({ site, lines });
  }
  return out;
}

// The source locations in an Evidence cell, which is prose around them
// ("src/a.php:12 - throws", "`Orders.cs:Save:3-9` saves"): each backticked span,
// and each path:symbol:lines in the rest, read as trace.md cells are read. A
// path with spaces is found only in backticks.
const SEGMENT = String.raw`[\p{L}\p{N}_@+$-][\p{L}\p{N}_.@+$-]*`;
const LOCATION = new RegExp(String.raw`(?:\.{1,2}[\\/])?(?:${SEGMENT}[\\/])*${SEGMENT}\.[A-Za-z][A-Za-z0-9]*(?::(?:[A-Za-z_$\p{L}][\p{L}\p{N}_$.#~]*(?:::[\p{L}\p{N}_$.#~]+)*))?(?::?L?\d+(?:\s*[-–]\s*L?\d+)?(?:\s*,\s*L?\d+(?:\s*[-–]\s*L?\d+)?)*)?`, 'gu');
export function evidenceRefs(text, root = null) {
  const cell = stripComments(text);
  const spans = [...cell.matchAll(/`([^`]+)`/g)].map((m) => m[1]);
  const rest = cell.replace(/`[^`]*`/g, ' ');
  // A backticked span that is one location as a whole may hold spaces (`My Project/a.vb:3`).
  const whole = (span) => /^[^\s:][^:]*\.[A-Za-z][A-Za-z0-9]*(?::[^:\s]+)?(?::?\s*L?\d+(?:\s*[-–,]\s*L?\d+)*)?$/.test(span.trim()) && /[\\/:]/.test(span);
  const found = [...spans.flatMap((span) => (whole(span) ? [span.trim()] : [...span.matchAll(LOCATION)].map((m) => m[0]))), ...[...rest.matchAll(LOCATION)].map((m) => m[0])];
  // A bare name with a dot in prose ("e.g.", "jQuery.ajax") is a location only
  // with a folder, a symbol or lines after it, or when the file is there.
  const located = (loc) => /[\\/:]/.test(loc) || (root && fs.existsSync(path.join(root, loc)));
  // "file.php:12" has the lines after one colon; "file.php:Save:12" after the symbol.
  return found.filter(located).flatMap((loc) => parseRefs(loc.replace(/^([^:]+\.[A-Za-z0-9]+):?(L?\d)/, '$1:$2'), root));
}

// The code a row cites, checked: each file exists and the lines are in it.
function citedCode(root, evidence, where, bad) {
  const refs = evidenceRefs(evidence, root);
  if (refs.length === 0) { bad.push(`walkthrough row ${where} cites no source location; give path:line (or path:symbol) of the code that does it`); return []; }
  const ok = [];
  for (const ref of refs) {
    const file = repoPath(ref.file);
    if (file.split('/').includes('..') || !fs.existsSync(path.join(root, file))) { bad.push(`walkthrough row ${where} cites ${file}, which does not exist`); continue; }
    if (ref.from !== null) {
      const count = lineCount(root, file);
      if (ref.from < 1 || ref.to < ref.from) { bad.push(`walkthrough row ${where} gives ${file} the lines ${ref.from}-${ref.to}, which is not a range`); continue; }
      if (count !== null && ref.to > count) { bad.push(`walkthrough row ${where} gives ${file} the lines ${ref.from}-${ref.to}, but the file has ${count} lines`); continue; }
    }
    ok.push({ ...ref, file });
  }
  return ok;
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
  const rows = walkthroughRows(text).filter((r) => r.key);
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
