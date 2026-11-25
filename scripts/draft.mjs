#!/usr/bin/env node
// Writes the parts of the artifacts that follow from other files alone, so that
// no model, the orchestrator or a subagent, retypes them: the items of a
// review.md, the numbered names a checker gets, and the tables of a port's
// design.md that copy the baseline spec, the screens and the trace.
//
//   node draft.mjs review --change <change> [--update]
//       review.md of a survey, target-design, extract, amend or finish change,
//       from its artifacts (context map, architecture, specs, screens,
//       questions, coverage, leftovers) and the template's fixed items. It
//       never ticks a box. Without --update it writes only a missing file.
//       With --update it rebuilds the list and keeps, for every item whose
//       subject is still there, the person's tick, decision and notes; an item
//       whose wording changed keeps its notes and loses its tick (a question
//       also its decision), so the person looks at it again. It reports what
//       it added, changed and removed.
//   node draft.mjs items --change <change>
//       the numbered requirement and screen names (`R1 <name>`, `S1 <name>`)
//       in spec and screens.md order, for crosscheck, omission-check and
//       walkthrough tasks, and an extract's entry points from source-map.md;
//       for a port change, those of the baseline spec and the archived
//       extract's screens.md; for a survey, the inventory rows (`paths`) the
//       survey crosscheck judges.
//   node draft.mjs port-design --change port-<capability> [--update]
//       the Screens, Scenario checks and Source references tables of
//       design.md, from screens.md and ui.md, the baseline spec, and the
//       trace.md of the archived extract and of every later amendment (the
//       newest wins). It writes design.md from the template when it is
//       missing, and fills only sections that are still the template's.
//       With --update it adds the rows that are missing and reports rows
//       whose scenario or requirement is gone, or whose source differs.
//
// Prints { ok, ... , problems } as JSON (ASCII only) and exits 0 when ok, 1 when
// not, 2 on bad usage. Run it from the repository root (or pass --root DIR).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  readIf, tableRows, headedRows, column, section, plain, norm, contextIds, archivedChange, changeSchema,
  requirementNames, screenNames, noScreens, NO_SCREENS_ITEM, inventoryRows, portLevels, questionIds, scenarioList, capabilitySegments, portCapability,
  PLACEHOLDER, DB_KINDS, REMARK,
} from './gate.mjs';
import { assignment, traceSources, checkSurveyCrosscheck, surveyRowStamp } from './coverage.mjs';
import { checkLedger } from './sites.mjs';
import { entryPoints } from './walkthrough.mjs';
import { leftoverRows } from './finish.mjs';

const KIT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CHECKBOX = /^\s*(?:[-*+]|\d+[.)])\s+\[(.?)\]\s*(.*)$/;
const FENCE = /^\s*(```|~~~)/;
const OTHER = '## Other notes';
// The decision at the end of a question's line (": decision: ..."); a
// "decision" inside the title has no colon before it.
const DECISION = /\s*:\s*(?:\*\*|__)?decision(?:\*\*|__)?\s*:.*$/i;
// An item's id and the rest of its line. A mark right after the id (R1. R1:
// R1-) ends the id; after a space (R1 - name) only with a space after it, so
// that "R1 .NET" or "R1 -1 is rejected" keeps its mark.
const ID_REST = /^([A-Za-z])(\d+)\b(?:[.:)-]|\s+(?:[:)]|[.-](?=\s|$)))?\s*(.*)$/;
const ID_ONLY = /^[A-Za-z]\d+\b(?:[.:)-]|\s+(?:[:)]|[.-](?=\s|$)))?\s*/;
const stripComments = (text) => String(text ?? '').replace(/<!--[\s\S]*?-->/g, '');
const ascii = (json) => json.replace(/[\u007f-\uffff]/g, (ch) => `\\u${ch.charCodeAt(0).toString(16).padStart(4, '0')}`);
const escCell = (s) => String(s).replace(/\|/g, '\\|');
// A name inside a review item: one line, no comment markers.
const oneLine = (s) => String(s).replace(/<!--|-->/g, ' ').replace(/\s+/g, ' ').trim();
// Text from an artifact for a review line: one line, without bold or italics marks.
const light = (s) => oneLine(String(s).replace(/\*\*|__/g, ''));

// ---------------------------------------------------------------- items

function walk(dir) {
  let entries = [];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return []; }
  return entries.flatMap((e) => (e.isDirectory() ? walk(path.join(dir, e.name)) : [path.join(dir, e.name)])).sort();
}

// The requirement names of a change's spec files, in file and spec order.
function changeRequirements(dir, problems) {
  const files = walk(path.join(dir, 'specs')).filter((f) => f.endsWith('.md'));
  if (files.length === 0) problems.push('the change has no spec files');
  return files.flatMap((f) => requirementNames(readIf(f, problems) ?? ''));
}

const numbered = (letter, names) => names.map((name, i) => `${letter}${i + 1} ${name}`);

// The archived extract change of a capability, or null.
const archivedExtract = (root, capability) => archivedChange(root, `extract-${capabilitySegments(capability).join('-')}`);
const baselineFile = (root, capability) => path.join(root, 'openspec/specs', ...capabilitySegments(capability), 'spec.md');

export function items(root, change) {
  const problems = [];
  const dir = path.join(root, 'openspec/changes', change);
  if (!fs.existsSync(dir)) return { ok: false, problems: [`change not found: ${change}`] };
  const schema = changeSchema(dir);
  let requirements = [];
  let screens = [];
  if (schema === 'spec-relay-survey') {
    const inventory = readIf(path.join(dir, 'inventory.md'), problems);
    const rows = inventoryRows(inventory ?? '');
    const paths = rows.map((r) => r.path);
    if (inventory !== null && paths.length === 0) problems.push('inventory.md has no rows');
    // The code of each row as it is now: the checker copies it into its row
    // (`<!-- row <code> -->`), so merge.mjs refuses a check of a row that changed since.
    return { ok: problems.length === 0, change, paths, codes: Object.fromEntries(rows.map((r) => [r.path, surveyRowStamp(r)])), problems };
  }
  let entries = null;
  if (schema === 'spec-relay-extract' || schema === 'spec-relay-amend') {
    requirements = changeRequirements(dir, problems);
    if (schema === 'spec-relay-extract') {
      screens = screenNames(readIf(path.join(dir, 'screens.md'), problems) ?? '');
      const map = readIf(path.join(dir, 'source-map.md'), problems);
      const listed = map === null ? [] : entryPoints(map);
      if (listed === null) problems.push('source-map.md has no "## Entry points" section: the analyst lists every way in there (path:symbol - how callers reach it), or "- None (why)"; the walkthrough starts from it');
      entries = (listed ?? []).map((e) => e.id);
    }
  } else if (schema === 'spec-relay-port') {
    const capability = portCapability(root, change);
    if (!capability) return { ok: false, problems: ['proposal.md records no baseline hash for this change\'s own capability; add it with gate.mjs baseline'] };
    const spec = readIf(baselineFile(root, capability), problems);
    if (spec === null) problems.push(`no baseline spec for ${capability}`);
    requirements = requirementNames(spec ?? '');
    const extract = archivedExtract(root, capability);
    if (!extract) problems.push(`no archived extract change of ${capability}`);
    else screens = screenNames(readIf(path.join(extract, 'screens.md'), problems) ?? '');
  } else return { ok: false, problems: [`${change} has schema ${schema}; items lists the requirements and screens of an extract, amend or port change, or the inventory rows of a survey`] };
  return { ok: problems.length === 0, change, requirements: numbered('R', requirements), screens: numbered('S', screens), ...(entries ? { entryPoints: entries } : {}), problems };
}

// ---------------------------------------------------------------- review.md

// The context map's contexts with their names: [{ id, name }].
function contextsOf(text) {
  const out = [];
  let current = null;
  for (const line of stripComments(text ?? '').split(/\r?\n/)) {
    const ids = contextIds(line);
    if (ids.length) { current = { id: ids[0], name: '' }; out.push(current); continue; }
    if (/^#{1,3}\s/.test(line)) { current = null; continue; }
    const name = current && !current.name && line.match(/^\s*[-*+]\s*(?:\*\*|__)?(?:Name|名前)(?:\*\*|__)?\s*[:：]\s*(.*)$/i);
    if (name) current.name = light(name[1]);
  }
  return out;
}

// The rows of the first table under `## <title>` as objects keyed by the
// header's plain lowercase cells.
function tableUnder(text, title) {
  const body = section(text ?? '', title);
  if (body === null) return null;
  return headedRows(body).map(({ header, cells }) => ({ header, cells }));
}

// The databases of database.md: the Database column of the first table under
// ## Databases, as the gate reads it.
function databasesOf(text) {
  const rows = tableUnder(text, /^databases$/i);
  if (rows === null) return null;
  const first = rows.filter((r) => r.header === rows[0]?.header);
  return first.map(({ header, cells }) => oneLine(plain(cells[Math.max(column(header, /^(database|データベース)/), 0)] ?? ''))).filter((name) => name && !PLACEHOLDER.test(name));
}

function surveyReview(dir, problems) {
  const map = readIf(path.join(dir, 'context-map.md'), problems);
  if (map === null) problems.push('context-map.md is missing; write it before the review');
  const contexts = contextsOf(map);
  const db = readIf(path.join(dir, 'database.md'), problems);
  if (db === null) problems.push('database.md is missing; write it before the review');
  const databases = databasesOf(db) ?? [];
  // An unreadable crosscheck would drop the C2 item with the person's tick and notes.
  const readable = fs.existsSync(path.join(dir, 'crosscheck.md')) && readIf(path.join(dir, 'crosscheck.md'), problems) !== null;
  const inventory = readable ? readIf(path.join(dir, 'inventory.md'), problems) : null;
  const asked = inventory === null ? null : checkSurveyCrosscheck(dir, inventoryRows(inventory), null, []).wording;
  return [
    ['1. Contexts', contexts.map((c, i) => ({ key: `K:${c.id}`, text: `K${i + 1} ${c.id}: ${c.name || c.id}` }))],
    ['2. Map', [
      ['M1', 'The relationships between contexts are right'],
      ['M2', 'Every piece of shared data has the right owner'],
      ['M3', 'The glossary conflicts are understood'],
      ['M4', 'The capability list and its order are right'],
      ['M5', 'The files marked carry may go to the new system unchanged'],
    ].map(([id, text]) => ({ key: id, text: `${id} ${text}` }))],
    ['3. Coverage', [
      { key: 'C1', text: 'C1 Every file marked excluded may be left out of the migration' },
      // The rows the survey crosscheck leaves to the person, in the gate's own words.
      ...(asked ? [{ key: 'C2', text: asked }] : []),
    ]],
    ['4. Databases', databases.length ? [
      ...databases.map((name, i) => ({ key: `D:${norm(name)}`, text: `D${i + 1} ${name}: definitions and the logic in it` })),
      { key: 'D90', text: 'D90 The missing definitions are understood' },
    ] : []],
  ];
}

function targetReview(root, dir, problems, warnings) {
  const survey = archivedChange(root, 'survey');
  if (!survey) { problems.push('no archived survey change; review and archive the survey first'); return []; }
  const contexts = contextIds(readIf(path.join(survey, 'context-map.md'), problems) ?? '');
  const modules = new Map((tableUnder(readIf(path.join(dir, 'architecture.md'), problems) ?? '', /^modules$/i) ?? [])
    .map(({ header, cells }) => [plain(cells[0] ?? '').toLowerCase(), oneLine(plain(cells[Math.max(column(header, /^(module path|モジュールのパス|パス)/), 1)] ?? ''))]));
  const per = (letter, what) => contexts.map((id, i) => ({ key: `${letter}:${id}`, text: `${letter}${i + 1} ${id}: ${what(id)}` }));
  const sections = [
    ['1. Architecture', [
      { key: 'A0', text: 'A0 The style' },
      ...per('A', (id) => (modules.get(id) && !PLACEHOLDER.test(modules.get(id)) ? modules.get(id) : 'module')),
      { key: 'A90', text: 'A90 Data ownership' },
      { key: 'A91', text: 'A91 The boundary check' },
    ]],
    ['2. Conventions', [['V1', 'Runtime and frameworks'], ['V2', 'Language mapping'], ['V3', 'Coding conventions'], ['V4', 'Commands']]
      .map(([id, text]) => ({ key: id, text: `${id} ${text}` }))],
    ['3. Verification', [...per('E', () => 'levels'), { key: 'E90', text: 'E90 Sign-in and recorded data' }]],
    ['4. Screens', [...per('U', () => 'screens'), { key: 'U90', text: 'U90 Shared look, carried files and client-side scripts' }]],
  ];
  const surveyDb = readIf(path.join(survey, 'database.md'), problems) ?? '';
  if ((databasesOf(surveyDb) ?? []).length) {
    const kinds = [...new Set(tableRows(section(surveyDb, /^logic in the database$/i) ?? '').map(([kind = '']) => norm(kind)).filter((k) => DB_KINDS.includes(k)))];
    const handling = new Map(tableRows(section(readIf(path.join(dir, 'data.md'), problems) ?? '', /^database logic$/i) ?? '')
      .map(([kind = '', how = '']) => [norm(kind), norm(how).match(/^(keep|move)\b/)?.[1] ?? '']));
    sections.push(['5. Data', [
      { key: 'D0', text: 'D0 The schema policy' },
      ...kinds.map((kind, i) => ({ key: `D:${kind}`, text: `D${i + 1} ${kind}: ${handling.get(kind) || 'keep or move'}` })),
      { key: 'D90', text: 'D90 The exceptions' },
      { key: 'D91', text: 'D91 The data access mapping' },
      { key: 'D92', text: 'D92 The schema changes and the test database' },
    ]]);
    for (const kind of kinds.filter((k) => !handling.get(k))) warnings.push(`data.md gives the ${kind} objects no handling (keep or move) under ## Database logic; the item says "keep or move" until it does`);
  }
  return sections;
}

// A question's title: its whole first line without the id (a leading
// "[requirement]" included), so that two questions are told apart by all their
// words and a tick or a decision cannot pass from one to the other.
function questionTitles(text) {
  const titles = new Map();
  for (const line of stripComments(text ?? '').split(/\r?\n/)) {
    const m = line.match(/^\s*(?:[-*+]\s*|#{1,6}\s*)?(?:\*\*|__)?Q(\d+)(?:\*\*|__)?\s*[.:)）．]?\s*(.*)$/i);
    if (!m) continue;
    const id = `Q${Number(m[1])}`;
    if (titles.has(id)) continue;
    titles.set(id, light(m[2]).replace(/decision\s*:/gi, '').trim() || id);
  }
  return titles;
}

function extractReview(root, dir, problems) {
  const requirements = changeRequirements(dir, problems);
  const screensText = readIf(path.join(dir, 'screens.md'), problems);
  if (screensText === null) problems.push('screens.md is missing; write it (or "None") before the review');
  const screens = screenNames(screensText ?? '');
  const questions = readIf(path.join(dir, 'questions.md'), problems);
  if (questions === null) problems.push('questions.md is missing; write it before the review');
  const ids = questionIds(questions ?? '').sort((a, b) => Number(a.slice(1)) - Number(b.slice(1)));
  const titles = questionTitles(questions);
  const sections = [
    ['1. Requirements', requirements.map((name, i) => ({ key: `R:${norm(name)}`, text: `R${i + 1} ${oneLine(name)}` }))],
    ['2. Screens', screensText !== null && noScreens(screensText)
      ? [{ key: `S:${norm(NO_SCREENS_ITEM.replace(/^S0\s+/, ''))}`, text: NO_SCREENS_ITEM }]
      : screens.map((name, i) => ({ key: `S:${norm(name)}`, text: `S${i + 1} ${oneLine(name)}` }))],
    ['3. Questions', ids.map((id) => ({ key: `Q:${norm(titles.get(id) ?? id)}`, fallback: id, text: `${id} ${titles.get(id) ?? id}: decision:`, question: true }))],
  ];
  // The C1 item, in the gate's own words, when the omission check set sites aside.
  const own = walk(path.join(dir, 'specs')).filter((f) => f.endsWith('.md')).map((f) => path.relative(path.join(dir, 'specs'), path.dirname(f)).split(path.sep).join('/'))[0] ?? '';
  const ledger = [];
  // An unreadable ledger would drop the C1 item with the person's tick and notes.
  const readable = fs.existsSync(path.join(dir, 'coverage.md'))
    && readIf(path.join(dir, 'coverage.md'), problems) !== null
    && (!fs.existsSync(path.join(dir, 'source-map.md')) || readIf(path.join(dir, 'source-map.md'), problems) !== null);
  const result = readable
    ? checkLedger(root, dir, { requirements, screens, asked: new Set(ids), assignment: assignment(root).map, own, boxes: null }, ledger)
    : null;
  if (result?.wording) sections.push(['4. Coverage', [{ key: 'C1', text: result.wording }]]);
  return sections;
}

function amendReview(dir, problems) {
  const requirements = changeRequirements(dir, problems);
  return [
    ['1. Requirements', requirements.map((name, i) => ({ key: `R:${norm(name)}`, text: `R${i + 1} ${oneLine(name)}` }))],
    ['2. Impact', [{ key: 'I1', text: 'I1 The port updates in impact.md are right' }]],
  ];
}

function finishReview(dir, problems, warnings) {
  const text = readIf(path.join(dir, 'leftovers.md'), problems);
  if (text === null) problems.push('leftovers.md is missing; run finish.mjs draft first');
  const rows = leftoverRows(text ?? '').filter((r) => /^L\d+$/.test(r.id));
  // What and where: two leftovers with the same words (one TODO in two files)
  // are told apart by where they are.
  const what = (r) => {
    const t = light(r.what) || r.kind;
    const short = t.length > 80 ? `${t.slice(0, 79).trim()}…` : t;
    return r.where ? `${short} (${light(r.where)})` : short;
  };
  for (const r of rows.filter((x) => !x.klass)) warnings.push(`leftovers.md ${r.id} has no class yet; the item says "class: ?" until it has one`);
  return [
    ['1. Checks', [{ key: 'C1', text: 'C1 The whole-system checks' }]],
    ['2. Leftovers', rows.map((r) => ({ key: `L:${norm(what(r))}`, fallback: r.id, text: `${r.id} ${what(r)} - class: ${r.klass || '?'}` }))],
    ['3. Handover', [{ key: 'H1', text: 'H1 The verdict' }, { key: 'H2', text: 'H2 Before the switch' }]],
  ];
}

// The items of an existing review.md: [{ key, id, text, done, block }], where
// block is the item's lines (its box line and the notes under it), the
// Reviewer line, and the lines that are neither (free text the update keeps).
export function readReview(text, keyOf) {
  const lines = String(text ?? '').split(/\r?\n/);
  const found = [];
  const other = [];
  let reviewer = null;
  let item = null;
  let fenced = false;
  // A comment that spans lines: the item whose notes it is in, or 'other'.
  let comment = null;
  // Free text and comments keep their blank lines between them.
  let gap = false;
  // How many kept lines had an item or a heading after them: the update moves
  // those to the end of the file (the ones already there stay where they are).
  let pending = 0;
  let moved = 0;
  const keep = (line) => { if (gap && other.length) other.push(''); other.push(line); gap = false; if (line.trim()) pending += 1; };
  const passed = () => { moved += pending; pending = 0; };
  for (const line of lines) {
    if (comment) {
      if (comment === 'other') keep(line); else comment.block.push(line);
      if (line.includes('-->')) comment = null;
      continue;
    }
    if (!fenced && /^\s*<!--/.test(line) && !line.includes('-->')) {
      if (item && /^\s/.test(line)) { comment = item; item.block.push(line); continue; }
      comment = 'other'; item = null; keep(line); continue;
    }
    if (FENCE.test(line)) fenced = !fenced;
    const box = !fenced && line.match(CHECKBOX);
    if (box) {
      const body = box[2].trim();
      item = { done: box[1].trim().toLowerCase() === 'x', text: body, key: keyOf(plain(stripComments(body))), block: [line] };
      found.push(item);
      passed();
      continue;
    }
    if (!fenced && /^Reviewer:/.test(line)) { reviewer = line; item = null; continue; }
    if (!fenced && (/^#{1,6}\s/.test(line) || !line.trim())) { if (/^#{1,6}\s/.test(line)) { item = null; passed(); } gap = true; continue; }
    if (item && (REMARK.test(line) || /^\s/.test(line))) { item.block.push(line); continue; }
    item = null;
    keep(line);
  }
  return { items: found, reviewer, other, moved };
}

// The key an existing item line has, given the new items: the same key the
// new list gives the same subject (an id for fixed items and questions, the
// letter and the subject's name for the rest).
function keyFor(schema) {
  return (body) => {
    const m = body.match(ID_REST);
    if (!m) return null;
    const letter = m[1].toUpperCase();
    const id = `${letter}${Number(m[2])}`;
    const rest = m[3];
    if (schema === 'spec-relay-extract' || schema === 'spec-relay-amend') {
      if (letter === 'Q') return `Q:${norm(rest.replace(DECISION, ''))}`;
      if (letter === 'R' || letter === 'S') return `${letter}:${norm(rest)}`;
      return id;
    }
    if (schema === 'spec-relay-finish' && letter === 'L') return `L:${norm(rest.replace(/\s+-\s+class\s*:.*$/i, ''))}`;
    if (schema === 'spec-relay-survey') {
      if (letter === 'K') return `K:${norm(rest.split(/[:：]/)[0])}`;
      if (letter === 'D' && Number(m[2]) < 90) return `D:${norm(rest.split(/[:：]/)[0])}`;
      return id;
    }
    if (schema === 'spec-relay-target') {
      if (['A', 'E', 'U'].includes(letter) && Number(m[2]) > 0 && Number(m[2]) < 90) return `${letter}:${norm(rest.split(/[:：]/)[0])}`;
      if (letter === 'D' && Number(m[2]) > 0 && Number(m[2]) < 90) return `D:${norm(rest.split(/[:：]/)[0])}`;
      return id;
    }
    return id;
  };
}

// The words of an item without its id, as the gate compares them (withoutId).
const words = (s) => norm(plain(stripComments(s)).replace(ID_ONLY, ''));
// A question's line without its decision.
const unDecided = (s) => (/^\W*Q\d/i.test(plain(s)) ? s.replace(DECISION, '') : s);
const sameWords = (a, b) => words(unDecided(a)) === words(unDecided(b));
const idOf = (text) => plain(stripComments(text)).match(/^([A-Za-z])(\d+)\b/)?.slice(1, 3).join('').toUpperCase().replace(/^([A-Z])0*(\d)/, '$1$2') ?? null;

// The decision a question's line holds, or ''.
const decisionOf = (text) => text.match(/:\s*(?:\*\*|__)?decision(?:\*\*|__)?\s*:(?:\*\*|__)?\s*(.*)$/i)?.[1]?.trim() ?? '';

// Whether two items share a word (two characters in a row for Japanese and
// Chinese), so that an item that only kept its number is not taken for the
// old one.
const STOP = new Set(['the', 'and', 'for', 'with', 'from', 'that', 'this', 'are', 'not']);
// Of the subjects only (the keys), not the fixed words after them.
function grams(key) {
  const out = new Set();
  for (const w of String(key).replace(/^[A-Z]:/, '').split(/[^\p{L}\p{N}]+/u)) {
    if (/^[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}ー]+$/u.test(w)) for (let i = 0; i + 1 < w.length; i++) out.add(w.slice(i, i + 2));
    else if (w.length >= 3 && !STOP.has(w)) out.add(w);
  }
  return out;
}
const overlaps = (a, b) => { const x = grams(a); return [...grams(b)].some((g) => x.has(g)); };

// Pairs every new item with the old item about the same subject: first by
// subject, then, for an item whose subject changed (a rename the person asked
// for, a question reworded), by the same id when the two subjects share a
// word. Two items with the same words (old or new) are paired by subject and
// id together, since nothing else tells them apart.
// matches: Map(new item -> { old, exact }).
function pair(sections, old) {
  const matches = new Map();
  const used = new Set();
  const all = sections.flatMap(([, list]) => list);
  const tally = (list) => list.reduce((m, i) => (i.key ? m.set(i.key, (m.get(i.key) ?? 0) + 1) : m), new Map());
  const olds = tally(old);
  const news = tally(all);
  for (const item of all) {
    const twins = olds.get(item.key) > 1 || news.get(item.key) > 1;
    const id = item.fallback ?? idOf(item.text);
    const m = old.find((o) => !used.has(o) && o.key === item.key && (!twins || idOf(o.text) === id));
    if (m) { matches.set(item, { old: m, exact: true }); used.add(m); }
  }
  for (const item of all.filter((i) => !matches.has(i))) {
    const id = item.fallback ?? idOf(item.text);
    const m = old.find((o) => !used.has(o) && idOf(o.text) === id && o.key && item.key && overlaps(o.key, item.key));
    if (m) { matches.set(item, { old: m, exact: false }); used.add(m); }
  }
  return { matches, unused: old.filter((o) => !used.has(o)), ambiguous: new Set([...olds.keys()].filter((k) => olds.get(k) > 1)) };
}

function renderReview(sections, reviewer, matches = new Map(), report = null, other = []) {
  const out = ['# Review', '', reviewer ?? 'Reviewer: <!-- name -->'];
  for (const [heading, list] of sections) {
    out.push('', `## ${heading}`);
    for (const item of list) {
      const match = matches.get(item);
      if (!match) { out.push(`- [ ] ${item.text}`); report?.added.push(item.text); continue; }
      const { old, exact } = match;
      const [, ...notes] = old.block;
      // A question keeps the person's decision only when it is the same
      // question; otherwise the old line is in the report.
      const text = item.question && exact ? `${item.text} ${decisionOf(old.text)}`.trim() : item.text;
      if (exact && sameWords(old.text, item.text)) {
        out.push(`- [${old.done ? 'x' : ' '}] ${text}`, ...notes);
      } else {
        out.push(`- [ ] ${text}`, ...notes);
        report?.changed.push({ was: old.text, now: text, ticked: old.done });
      }
    }
  }
  // Under a heading of its own, so that a fix or hold line in it stays with no
  // item, as the gate read it before.
  if (other.length) out.push('', OTHER, ...other);
  return `${out.join('\n')}\n`;
}

export function review(root, change, { update = false } = {}) {
  const problems = [];
  const warnings = [];
  const dir = path.join(root, 'openspec/changes', change);
  if (!fs.existsSync(dir)) return { ok: false, problems: [`change not found: ${change}`] };
  const schema = changeSchema(dir);
  let sections;
  if (schema === 'spec-relay-survey') sections = surveyReview(dir, problems);
  else if (schema === 'spec-relay-target') sections = targetReview(root, dir, problems, warnings);
  else if (schema === 'spec-relay-extract') sections = extractReview(root, dir, problems);
  else if (schema === 'spec-relay-amend') sections = amendReview(dir, problems);
  else if (schema === 'spec-relay-finish') sections = finishReview(dir, problems, warnings);
  else return { ok: false, problems: [`${change} has schema ${schema}, which has no review`] };
  const file = path.join(dir, 'review.md');
  const rel = `openspec/changes/${change}/review.md`;
  const existing = readIf(file, problems);
  // A missing or unreadable artifact would make its items look removed and
  // drop the person's ticks and notes with them: write nothing then.
  if (problems.length) return { ok: false, file: rel, written: false, problems, warnings };
  if (existing !== null && !update) {
    return { ok: false, file: rel, written: false, problems: [`${rel} exists; run with --update to rebuild its items and keep the person's ticks, decisions and notes`], warnings };
  }
  const report = { added: [], changed: [], removed: [], moved: 0 };
  let text;
  if (existing === null) text = renderReview(sections, null);
  else {
    const old = readReview(existing, keyFor(schema));
    const { matches, unused, ambiguous } = pair(sections, old.items);
    text = renderReview(sections, old.reviewer, matches, report, old.other);
    // What goes, with its lines, so that the orchestrator can tell the person and keep a fix's thread.
    for (const item of unused) {
      const why = !item.key ? 'no id' : ambiguous.has(item.key) ? 'another item has the same subject' : 'its subject is gone';
      report.removed.push({ item: item.text, ticked: item.done, lines: item.block, why });
    }
    report.moved = old.moved;
  }
  if (existing !== null && text === existing.replace(/\r\n/g, '\n')) return { ok: true, file: rel, written: false, ...report, problems, warnings };
  // Keep the file's line endings.
  fs.writeFileSync(file, existing && /\r\n/.test(existing) ? text.replace(/\n/g, '\r\n') : text);
  const items = sections.reduce((n, [, list]) => n + list.length, 0);
  return { ok: true, file: rel, written: true, items, ...(existing === null ? {} : report), problems, warnings };
}

// ---------------------------------------------------------------- port design.md

// Trace rows of a trace.md, read as the gate reads them (a leading R<n> is
// dropped, two rows of one requirement count together): Map(normalised
// requirement -> source cell).
function traceRows(text) {
  const rows = new Map();
  for (const [name, sources] of traceSources(text ?? '')) {
    const cells = sources.map((src) => stripComments(src).trim()).filter((src) => src && !PLACEHOLDER.test(src));
    if (cells.length) rows.set(name, cells.join('; ').replace(/\|/g, '\\|'));
  }
  return rows;
}

// Every archived change named `name` or `name-v<n>`, oldest first.
function archivedAll(root, name) {
  const dir = path.join(root, 'openspec/changes/archive');
  let entries = [];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name); } catch { return []; }
  return entries.map((entry) => {
    const m = entry.match(/^(\d{4}-\d{2}-\d{2})-(.+?)(?:-v(\d+))?$/);
    return m && m[2] === name ? { dir: path.join(dir, entry), date: m[1], version: Number(m[3] ?? 1) } : null;
  }).filter(Boolean).sort((a, b) => a.date.localeCompare(b.date) || a.version - b.version).map((x) => x.dir);
}

// Where each requirement's source is: the archived extract's trace, then each
// later amendment's, the newest winning.
export function sourceReferences(root, capability) {
  const key = capabilitySegments(capability).join('-');
  const refs = new Map();
  const from = new Map();
  for (const dir of [...archivedAll(root, `extract-${key}`).slice(-1), ...archivedAll(root, `amend-${key}`)]) {
    const rel = path.relative(root, dir).split(path.sep).join('/');
    for (const [name, src] of traceRows(readIf(path.join(dir, 'trace.md'), []) ?? '')) { refs.set(name, src); from.set(name, rel); }
  }
  return { refs, from };
}

// The screen policy ui.md gives a context, or null.
function screenPolicy(root, context) {
  const design = archivedChange(root, 'target-design');
  const ui = design ? readIf(path.join(design, 'ui.md'), []) : null;
  if (!ui) return null;
  for (const { header, cells } of headedRows(section(ui, /^screens$/i) ?? '')) {
    const c = plain(cells[Math.max(column(header, /^(context|コンテキスト)(?![a-z0-9_])/i), 0)] ?? '').toLowerCase();
    const p = column(header, /^(policy|方針)(?![a-z0-9_])/i);
    if (c === context && p >= 0) return plain(cells[p] ?? '').toLowerCase() || null;
  }
  return null;
}

// The levels a port of the capability runs: those verification.md chose for
// its context, less B2 and C when its extract's screens.md says None.
function levelsFor(root, capability) {
  const design = archivedChange(root, 'target-design');
  const text = design ? readIf(path.join(design, 'verification.md'), []) : null;
  return text ? portLevels(root, capability, text, []) : { levels: null, notApplicable: [] };
}

// The `## <title>` section of a Markdown text as { start, end } line indexes
// (start is the heading), or null.
function sectionRange(lines, title) {
  let start = -1;
  let fenced = false;
  let comment = false;
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    if (comment) { if (line.includes('-->')) comment = false; continue; }
    if (FENCE.test(line)) { fenced = !fenced; continue; }
    if (fenced) continue;
    if (/<!--/.test(line) && !/<!--[\s\S]*?-->/.test(line.slice(line.indexOf('<!--')))) { comment = true; continue; }
    const h2 = line.match(/^##\s+(.*?)(?:\s+#+)?\s*$/);
    if (!h2) continue;
    if (start >= 0) return { start, end: i };
    if (title.test(plain(h2[1]).replace(/^\d+[.)]?\s+/, ''))) start = i;
  }
  return start >= 0 ? { start, end: lines.length } : null;
}

// Whether a section still holds only the template: no table row and no text
// other than placeholders.
function untouched(lines) {
  const rows = tableRows(lines.join('\n'));
  const text = stripComments(lines.filter((l) => !/^\s*\|/.test(l)).join('\n')).trim();
  return !text && rows.every((cells) => cells.every((c) => PLACEHOLDER.test(stripComments(c).trim())));
}

// The template's sections after each table this script writes.
const LATER = {
  Screens: ['carried files', 'data access', 'verification', 'scenario checks', 'source references', 'decisions', 'risks'],
  'Scenario checks': ['source references', 'decisions', 'risks'],
  'Source references': ['decisions', 'risks'],
};

export function portDesign(root, change, { update = false } = {}) {
  const problems = [];
  const dir = path.join(root, 'openspec/changes', change);
  if (!fs.existsSync(dir)) return { ok: false, problems: [`change not found: ${change}`] };
  if (changeSchema(dir) !== 'spec-relay-port') return { ok: false, problems: [`${change} is not a port change (schema spec-relay-port)`] };
  const capability = portCapability(root, change);
  if (!capability) return { ok: false, problems: ['proposal.md records no baseline hash for this change\'s own capability; write the proposal first (gate.mjs baseline)'] };
  const spec = readIf(baselineFile(root, capability), problems);
  if (spec === null) return { ok: false, problems: [`no baseline spec for ${capability}`] };
  const context = capability.split('/')[0];
  const requirements = requirementNames(spec);
  const scenarios = scenarioList(spec);
  const extract = archivedExtract(root, capability);
  if (!extract) problems.push(`no archived extract change of ${capability}`);
  const screens = extract ? screenNames(readIf(path.join(extract, 'screens.md'), problems) ?? '') : [];
  const policy = screenPolicy(root, context);
  if (screens.length && !policy) problems.push(`the archived target design's ui.md gives context ${context} no screen policy; ask the person for each screen's policy and write it under Decisions`);
  const { levels, notApplicable } = levelsFor(root, capability);
  if (levels === null) problems.push(`the archived target design's verification.md has no row for context ${context}`);
  // Without B1, B2 or C every scenario is a unit test; otherwise the check is a choice.
  const fixedCheck = levels && !levels.some((l) => ['B1', 'B2', 'C'].includes(l)) ? 'unit' : null;
  const { refs, from } = sourceReferences(root, capability);
  for (const name of requirements.filter((n) => !refs.has(norm(n)))) problems.push(`no trace row for requirement "${name}" in the archived extract or amendments`);

  const tables = {
    screens: {
      title: /^screens\b/i,
      heading: 'Screens',
      header: ['| Screen (screens.md) | Policy (ui.md) | Target page or form | How the design is kept |', '|---|---|---|---|'],
      rows: screens.map((s) => ({ key: norm(s), line: `| ${escCell(s)} | ${policy ?? '<!-- ask the person -->'} | <!-- --> | <!-- --> |` })),
      none: 'None',
    },
    scenarios: {
      title: /^scenario checks\b/i,
      heading: 'Scenario checks',
      header: ['| Requirement | Scenario | Check |', '|---|---|---|'],
      rows: scenarios.map((s) => ({ key: `${norm(s.requirement)}\u0000${norm(s.scenario)}`, line: `| ${escCell(s.requirement)} | ${escCell(s.scenario)} | ${fixedCheck ?? (notApplicable.length ? '<!-- compare / unit -->' : '<!-- e2e / compare / unit -->')} |` })),
      none: 'None',
    },
    sources: {
      title: /^source references\b/i,
      heading: 'Source references',
      header: ['| Requirement | Source (from trace.md) |', '|---|---|'],
      rows: requirements.map((r) => ({ key: norm(r), source: refs.get(norm(r)) ?? '', line: `| ${escCell(r)} | ${refs.get(norm(r)) ?? '<!-- not in trace.md -->'} |` })),
      none: 'None',
    },
  };
  const file = path.join(dir, 'design.md');
  const rel = `openspec/changes/${change}/design.md`;
  let text = readIf(file, problems);
  const created = text === null;
  if (created) text = readIf(path.join(KIT, 'openspec-schemas/spec-relay-port/templates/design.md'), problems) ?? '';
  const crlf = /\r\n/.test(text);
  let lines = text.replace(/\r\n/g, '\n').split('\n');
  const result = { filled: [], kept: [], added: [], gone: [], differs: [] };
  for (const [name, t] of Object.entries(tables)) {
    const range = sectionRange(lines, t.title);
    const body = t.rows.length ? [...t.header, ...t.rows.map((r) => r.line)] : [t.none];
    if (!range) {
      // Before the first section the template puts after it, else at the end.
      const later = LATER[t.heading].map((h) => sectionRange(lines, new RegExp(`^${h}\\b`, 'i'))?.start).filter((i) => i !== undefined);
      const at = later.length ? Math.min(...later) : -1;
      if (at < 0) lines = [...lines.join('\n').replace(/\n*$/, '').split('\n'), '', `## ${t.heading}`, ...body];
      else lines.splice(at, 0, `## ${t.heading}`, ...body, '');
      result.filled.push(name);
      continue;
    }
    const inside = lines.slice(range.start + 1, range.end);
    if (untouched(inside)) {
      const tail = inside.length && !inside[inside.length - 1].trim() ? [''] : [];
      lines.splice(range.start + 1, inside.length, ...body, ...tail);
      result.filled.push(name);
      continue;
    }
    if (!update) { result.kept.push(name); continue; }
    // Add the missing rows after the table's last row; report the rest.
    const present = [];
    let last = -1;
    inside.forEach((line, i) => { if (/^\s*\|/.test(line)) last = i; });
    const un = (c) => norm((c ?? '').replace(/\\\|/g, '|'));
    for (const cells of tableRows(inside.join('\n'))) {
      if (name === 'scenarios') present.push({ key: `${un(cells[0])}\u0000${un(cells[1])}`, cells });
      else present.push({ key: un(cells[0]), cells });
    }
    const missing = t.rows.filter((r) => !present.some((p) => p.key === r.key));
    for (const p of present.filter((x) => x.key.replace(/\u0000/g, '') && !t.rows.some((r) => r.key === x.key))) result.gone.push({ table: name, row: p.cells.slice(0, 2).map(plain).join(' | ') });
    if (name === 'sources') {
      for (const p of present) {
        const want = t.rows.find((r) => r.key === p.key);
        if (want?.source && norm(stripComments(p.cells[1] ?? '')) !== norm(want.source)) result.differs.push({ requirement: plain(p.cells[0] ?? ''), now: plain(p.cells[1] ?? ''), trace: want.source, from: from.get(p.key) });
      }
    }
    if (missing.length) {
      if (last < 0) lines.splice(range.start + 1, 0, ...t.header, ...missing.map((r) => r.line));
      else lines.splice(range.start + 1 + last + 1, 0, ...missing.map((r) => r.line));
      result.added.push(...missing.map((r) => ({ table: name, row: r.line })));
    }
  }
  const out = lines.join('\n').replace(/\n*$/, '\n');
  if (out !== text.replace(/\r\n/g, '\n')) fs.writeFileSync(file, crlf ? out.replace(/\n/g, '\r\n') : out);
  return { ok: problems.length === 0, file: rel, created, capability, scenarios: scenarios.length, requirements: requirements.length, screens: screens.length, ...(notApplicable.length ? { notApplicable } : {}), ...result, problems };
}

// ---------------------------------------------------------------- CLI

export function main(argv) {
  const [command, ...rest] = argv;
  const opts = { root: process.cwd(), update: false };
  for (let i = 0; i < rest.length; i += 1) {
    if (rest[i] === '--update') { opts.update = true; continue; }
    const key = { '--change': 'change', '--root': 'root' }[rest[i]];
    if (!key || rest[i + 1] === undefined) return usage();
    opts[key] = rest[i + 1];
    i += 1;
  }
  if (!opts.change || !['review', 'items', 'port-design'].includes(command)) return usage();
  if (command === 'items' && opts.update) return usage();
  if (!fs.existsSync(path.join(opts.root, 'openspec'))) {
    console.error(`draft: no openspec/ folder in ${path.resolve(opts.root)}. Run this from the repository root or pass --root DIR.`);
    return 2;
  }
  const result = command === 'review' ? review(opts.root, opts.change, opts)
    : command === 'items' ? items(opts.root, opts.change)
      : portDesign(opts.root, opts.change, opts);
  console.log(ascii(JSON.stringify(result, null, 2)));
  return result.ok ? 0 : 1;
}

function usage() {
  console.error('Usage: node draft.mjs review --change NAME [--update] | items --change NAME | port-design --change port-<capability> [--update] [--root DIR]');
  return 2;
}

function invokedDirectly() {
  if (!process.argv[1]) return false;
  try { return fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url)); } catch { return false; }
}

if (invokedDirectly()) process.exitCode = main(process.argv.slice(2));

