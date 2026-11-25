#!/usr/bin/env node
// Consistency between capabilities. Every capability's spec is written by its
// own analyst, who never reads the other capabilities' specs, and every check
// before this one (crosscheck, omission check, walkthrough) compares one spec
// with the source code. Two specs can each match the code and still disagree
// with each other where they meet: a caller that expects what the callee's spec
// does not say, a table two specs describe in different terms, a shared file
// split between two capabilities with a part described twice or not at all.
//
// Two kinds of checks:
// - Mechanical (checkDependencies, in the extract gate): the source map's
//   Dependencies table names every capability the walkthrough defers behavior
//   to; an entry point it says it uses is one the other capability's source map
//   lists (and the other way round: an entry point another capability uses is
//   listed here); a table this capability writes belongs to its context in the
//   survey's context map, or the context map (or the plan's "## Shared data")
//   lists the context as also writing it.
// - The pair check (checkConsistency): for every pair of capabilities with a
//   spec that are linked (one uses the other, both use one database object and
//   one of them writes it, or the plan gives both one file), a checker reads
//   both specs and judges each link. The rows live in one project-wide ledger,
//   openspec/spec-relay/consistency.md, so a pair checked during one extract
//   counts for the port of either side and for the finish step. Each row holds
//   a code of both specs (`<!-- pair <a> <b> -->`): when either spec changes
//   (a review fix, an amendment), the row goes stale and the pair is checked
//   again.
//
//   node consistency.mjs items --change extract-<capability>   the links of a capability under analysis
//   node consistency.mjs items --capability <capability>        the links of a capability about to be ported
//   node consistency.mjs items --all                            every link between baseline specs
//   node consistency.mjs check (--change NAME | --capability PATH | --all)
//
// items prints { ok, links: [{ pair, topic, code, status, sides }], todo, glossary }
// (status ok, missing, stale or open); check prints { ok, problems }.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readIf, headedRows, section, plain, archivedChange, baseName, checkboxes, questionIds, requirementNames, PLAN, PLACEHOLDER } from './gate.mjs';
import { assignment, ownersOf, keptFiles, inventoryRows, repoPath, extractChange } from './coverage.mjs';
import { entryPoints, entryKey, walkthroughRows } from './walkthrough.mjs';

export const LEDGER = 'openspec/spec-relay/consistency.md';
export const LEDGER_HEADER = /^(pair|組|ペア)(?![a-z0-9_])/i;
export const LEDGER_TEMPLATE = [
  '# Consistency between capabilities',
  '',
  '<!-- One row per link between two capabilities with a spec. merge.mjs writes the rows from the',
  '     checkers\' part files and the code of both specs (<!-- pair ... -->); only the orchestrator edits a',
  '     verdict (to question <change> Q<n>), keeping that code. See the spec-relay skill. -->',
  '',
  '| Pair | Topic | Verdict | Evidence |',
  '|---|---|---|---|',
  '',
].join('\n');
export const PAIR_STAMP = /<!--\s*pair\s+([0-9a-f]{8})\s+([0-9a-f]{8})\s*-->/i;
export const VERDICTS = 'consistent, conflict, duplicate, term, unclear, or (written by the orchestrator) question <change> Q<n>';

const stripComments = (text) => String(text ?? '').replace(/<!--[\s\S]*?-->/g, '');
const REQUIREMENT = /^###\s*Requirement:\s*(.+?)\s*$/i;
const FENCE = /^\s*(```|~~~)/;
const MAX_LISTED = 20;
const NOTHING = /^(?:(?:none|なし|無し|n\/a)\.?|-|—|)$/i;

function capped(problems, list, say) {
  for (const item of list.slice(0, MAX_LISTED)) problems.push(say(item));
  if (list.length > MAX_LISTED) problems.push(`...and ${list.length - MAX_LISTED} more`);
}

const changesDir = (root) => path.join(root, 'openspec/changes');
const keyOf = (capability) => capability.split('/').join('-');

function walkMd(dir) {
  let entries = [];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return []; }
  return entries.flatMap((e) => (e.isDirectory() ? walkMd(path.join(dir, e.name)) : e.name.endsWith('.md') ? [path.join(dir, e.name)] : [])).sort();
}

// ---------------------------------------------------------------- spec codes

// The code of a spec: the requirements as written, from the first
// "### Requirement:" on, without blank lines, trailing spaces, comments and the
// "## ADDED Requirements" / "## Requirements" headings. The delta of an extract
// change and the baseline OpenSpec writes from it when the change is archived
// give the same code (OpenSpec 2.1.1 keeps the requirement blocks and drops the
// blank lines between them), so a pair checked during the analysis stays checked
// after the archive. Null when the text holds no requirement.
export function specCode(text) {
  const lines = stripComments(text).split(/\r?\n/);
  const start = lines.findIndex((line) => REQUIREMENT.test(line));
  if (start < 0) return null;
  const kept = lines.slice(start).map((line) => line.replace(/\s+$/, '')).filter((line) => line.trim() !== '' && !/^##\s/.test(line));
  return crypto.createHash('sha256').update(kept.join('\n')).digest('hex').slice(0, 8);
}

const activeChange = (root, name) => {
  let found = [];
  try { found = fs.readdirSync(changesDir(root), { withFileTypes: true }).filter((e) => e.isDirectory() && e.name !== 'archive' && baseName(e.name) === name).map((e) => e.name); } catch { /* none */ }
  const version = (n) => Number(n.match(/-v(\d+)$/)?.[1] ?? 1);
  found.sort((a, b) => version(a) - version(b));
  return found.length ? path.join(changesDir(root), found.at(-1)) : null;
};

// What the pair check reads of a capability. `live` (the extract gate): the
// spec and source map of its active extract change when it has one, else its
// baseline and archived extract. Otherwise (port-ready, finish) only the
// baseline and the archived extract. Null when there is no spec with a
// requirement yet.
export function sideOf(root, capability, live) {
  const extract = `extract-${keyOf(capability)}`;
  const active = live ? activeChange(root, extract) : null;
  const relOf = (file) => path.relative(root, file).split(path.sep).join('/');
  if (active) {
    const files = walkMd(path.join(active, 'specs'));
    const text = files.map((f) => readIf(f, []) ?? '').join('\n');
    const code = specCode(text);
    if (code) return { capability, code, text, specs: files.map(relOf), dir: active, change: path.basename(active), active: true };
  }
  const baseline = path.join(root, 'openspec/specs', ...capability.split('/'), 'spec.md');
  const text = readIf(baseline, []);
  const code = specCode(text ?? '');
  if (!code) return null;
  const archived = archivedChange(root, extract);
  return { capability, code, text, specs: [relOf(baseline)], dir: archived, change: archived ? path.basename(archived).replace(/^\d{4}-\d{2}-\d{2}-/, '') : null, active: false };
}

// The folders whose source-map.md describes a capability: its newest extract
// change (active or archived; only the archived one when not live) and its
// amendments that carry a source map.
function sourceMapDirs(root, capability, live) {
  const extract = `extract-${keyOf(capability)}`;
  const first = live ? extractChange(root, capability) : archivedChange(root, extract);
  const dirs = first && fs.existsSync(path.join(first, 'source-map.md')) ? [first] : [];
  const amend = `amend-${keyOf(capability)}`;
  const add = (base, name) => { if (fs.existsSync(path.join(base, name, 'source-map.md'))) dirs.push(path.join(base, name)); };
  try { for (const e of fs.readdirSync(changesDir(root), { withFileTypes: true })) if (live && e.isDirectory() && e.name !== 'archive' && baseName(e.name) === amend) add(changesDir(root), e.name); } catch { /* none */ }
  try {
    const archive = path.join(changesDir(root), 'archive');
    for (const e of fs.readdirSync(archive, { withFileTypes: true })) {
      const m = e.name.match(/^\d{4}-\d{2}-\d{2}-(.+)$/);
      if (e.isDirectory() && m && baseName(m[1]) === amend) add(archive, e.name);
    }
  } catch { /* none */ }
  return dirs;
}

// ---------------------------------------------------------------- source map sections

const DEPENDENCIES = /^(dependenc(?:y|ies)|依存)/i;
const DATABASE = /^(database|データベース|db\b)/i;
const ENTRY_COLUMN = /^(entry|入口|エントリ|where|呼び先|使う入口)/i;

// A capability path the way the plan writes it: lowercase, no backticks or final "/".
const capName = (token) => plain(String(token ?? '')).replace(/[:：,、.。;；]+$/, '').replace(/\/+$/, '').trim().toLowerCase();

// The Dependencies of a source map: [{ capability, entries: [id], line }] for the
// rows and items that name a capability of the plan (other dependencies, such
// as libraries and services, are not read). A table's first column names what is
// used; its Entry point column (else its third column) the entry points of that
// capability, in backticks or separated by commas. A list item names a
// capability in backticks or as its first word; it gives no entry points.
export function dependencies(text, capabilities) {
  const body = section(text ?? '', DEPENDENCIES);
  if (body === null) return [];
  const known = new Set([...capabilities].map(capName));
  const out = [];
  const tokensOf = (cell) => {
    const quoted = [...String(cell).matchAll(/`([^`]+)`/g)].map((m) => m[1]);
    return quoted.length ? quoted : String(cell).split(/[\s,、;；]+/);
  };
  const rows = headedRows(body);
  for (const { header, cells } of rows) {
    const caps = tokensOf(cells[0] ?? '').map(capName).filter((t) => known.has(t));
    if (!caps.length) continue;
    let at = header.findIndex((h, i) => i > 0 && ENTRY_COLUMN.test(h));
    if (at < 0) at = 2;
    const cell = stripComments(cells[at] ?? '').trim();
    const entries = NOTHING.test(cell) || PLACEHOLDER.test(cell) ? [] : (/`/.test(cell) ? [...cell.matchAll(/`([^`]+)`/g)].map((m) => m[1].trim()) : cell.split(/\s*(?:<br\s*\/?>|[,、;；])\s*/i)).filter((e) => e && !PLACEHOLDER.test(e));
    for (const capability of new Set(caps)) out.push({ capability, entries, line: cells.join(' | ') });
  }
  let fenced = false;
  for (const line of stripComments(body).split(/\r?\n/)) {
    if (FENCE.test(line)) { fenced = !fenced; continue; }
    if (fenced || /^\s*\|/.test(line)) continue;
    const item = line.match(/^\s*(?:[-*+]|\d+[.)])\s+(.*)$/);
    if (!item) continue;
    const quoted = [...item[1].matchAll(/`([^`]+)`/g)].map((m) => capName(m[1]));
    const first = capName(item[1].split(/\s+/)[0]);
    for (const capability of new Set([...quoted, first].filter((t) => known.has(t)))) out.push({ capability, entries: [], line: item[1].trim() });
  }
  return out;
}

// A database object as the specs and the context map name it: no quotes,
// brackets or backticks, only its last name (dbo.Orders, [dbo].[Orders] and
// Orders are one), lowercase.
export const objectKey = (name) => stripComments(name).replace(/\*\*|__/g, '').replace(/["'\[\]`]/g, '').trim().split(/\s+/)[0].split('.').filter(Boolean).pop()?.toLowerCase() ?? '';

const WRITES = /(write|insert|update|delete|upsert|merge|truncate|書|更新|削除|登録|追加)/i;
const EFFECT = /(write|insert|update|delete|upsert|merge|truncate|call|fire|exec|書|更新|削除|登録|追加|呼|実行)/i;

// The Database table of a source map: Map<object key, { name, kind, writes, effect }>.
// writes: the Use cell says the capability changes it (a table's rows);
// effect: that, or it calls or fires it (a procedure, a trigger).
export function databaseObjects(text) {
  const body = section(text ?? '', DATABASE);
  const out = new Map();
  if (body === null) return out;
  for (const { header, cells } of headedRows(body)) {
    if (!/^(table|object|テーブル|オブジェクト|名前|name)/i.test(header[0] ?? '')) continue;
    const name = stripComments(cells[0] ?? '').trim();
    const key = objectKey(name);
    if (!key || NOTHING.test(plain(name)) || PLACEHOLDER.test(plain(name))) continue;
    const kindAt = header.findIndex((h) => /^(kind|種類|type)/i.test(h));
    const useAt = header.findIndex((h) => /^(use|使い方|用途|access)/i.test(h));
    const kind = plain(cells[kindAt < 0 ? 1 : kindAt] ?? '').toLowerCase();
    const use = plain(cells[useAt < 0 ? 2 : useAt] ?? '');
    const old = out.get(key) ?? { name: plain(name), kind, writes: false, effect: false };
    old.writes ||= WRITES.test(use);
    old.effect ||= EFFECT.test(use);
    if (!old.kind) old.kind = kind;
    out.set(key, old);
  }
  return out;
}

// ---------------------------------------------------------------- data owners

const CONTEXT_HEADING = /^###\s*Context:\s*([a-z0-9]+(?:-[a-z0-9]+)*)\s*$/i;
const SHARED = /^(shared data|共有データ)/i;

// Which contexts own and may write each table, from the archived survey's
// context map (each context's Owned data, the Shared data table) and the plan's
// "## Shared data" table (the person's later decisions, same columns: Data,
// Owner, Also written by). Returns (key) => { owners: Set, writers: Set, shared }.
export function dataOwners(root) {
  const survey = archivedChange(root, 'survey');
  const map = survey ? readIf(path.join(survey, 'context-map.md'), []) ?? '' : '';
  const owned = new Map();
  let current = null;
  for (const line of stripComments(map).split(/\r?\n/)) {
    const h = line.trim().match(CONTEXT_HEADING);
    if (h) { current = h[1].toLowerCase(); continue; }
    if (/^#{1,3}\s/.test(line)) { current = null; continue; }
    const m = line.match(/\*\*(owned data|持っているデータ|所有データ)\*\*\s*[:：]\s*(.*)$/i);
    if (m && current) owned.set(current, `${owned.get(current) ?? ''} ${m[2]}`);
  }
  const shared = [];
  const plan = readIf(path.join(root, PLAN), []) ?? '';
  for (const text of [map, plan]) {
    for (const { header, cells } of headedRows(section(text, SHARED) ?? '')) {
      const at = (re, fallback) => { const i = header.findIndex((h) => re.test(h)); return cells[i < 0 ? fallback : i] ?? ''; };
      const key = objectKey(cells[0]);
      if (!key) continue;
      const contexts = (cell) => new Set(plain(cell).toLowerCase().split(/[\s,、;；/]+/).filter((c) => /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(c)));
      shared.push({ key, owners: contexts(at(/^(owner|持ち主)/i, 1)), also: contexts(at(/^(also|ほか|他)/i, 2)) });
    }
  }
  const word = (key) => new RegExp(`(?<![A-Za-z0-9_])${key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![A-Za-z0-9_])`, 'i');
  return (key) => {
    const owners = new Set();
    const writers = new Set();
    let listed = false;
    for (const [context, text] of owned) {
      const names = stripComments(text).replace(/["'\[\]`*]/g, ' ');
      // "dbo.Orders" and "Orders" both name the table orders.
      if (word(key).test(names.replace(/[A-Za-z0-9_]+\./g, ''))) { owners.add(context); writers.add(context); }
    }
    for (const row of shared.filter((r) => r.key === key)) {
      listed = true;
      for (const c of row.owners) { owners.add(c); writers.add(c); }
      for (const c of row.also) writers.add(c);
    }
    return { owners, writers, shared: listed };
  };
}

const contextOfCapability = (capability) => capability.split('/')[0];
const isTable = (kind) => !kind || /table|テーブル/i.test(kind);

// ---------------------------------------------------------------- mechanical checks (extract gate)

// The entry points of a capability, from every source map that describes it,
// or null when none of them has an Entry points section.
function entryList(root, capability, live) {
  const lists = sourceMapDirs(root, capability, live).map((dir) => entryPoints(readIf(path.join(dir, 'source-map.md'), []) ?? '')).filter(Boolean);
  return lists.length ? lists.flat() : null;
}

const lastSymbol = (key) => {
  const colon = key.indexOf(':');
  return colon < 0 ? '' : key.slice(colon + 1).replace(/\(.*\)$/, '').split(/\.|::|->/).pop().trim();
};
const pathOf = (key) => (key.indexOf(':') < 0 ? key : key.slice(0, key.indexOf(':')));

// Whether an entry point id a dependency gives is one of the listed entry points:
// the same id, or the same path and the same last name of the symbol
// (`src/a.php:Billing.total` and `src/a.php:total`), or only the path of a page.
export function entryListed(id, entries) {
  const key = entryKey(id);
  return entries.some((e) => e.key === key
    || (pathOf(e.key) === pathOf(key) && (key.indexOf(':') < 0 || (lastSymbol(key) && lastSymbol(key) === lastSymbol(e.key)))));
}

// The extract gate's mechanical checks for capability `own` (see the top).
export function checkDependencies(root, dir, own, problems) {
  const { map: plan } = assignment(root);
  const capabilities = [...plan.keys()].map(capName);
  const planned = new Set(capabilities);
  const mapText = readIf(path.join(dir, 'source-map.md'), []) ?? '';
  const deps = dependencies(mapText, capabilities);
  const named = new Set(deps.map((d) => d.capability));
  const bad = [];
  // The walkthrough follows calls into other capabilities' code: those are dependencies.
  const walked = walkthroughRows(readIf(path.join(dir, 'walkthrough.md'), []) ?? '').filter((r) => r.parsed.kind === 'other' && r.parsed.capability !== own && planned.has(r.parsed.capability));
  for (const capability of [...new Set(walked.map((r) => r.parsed.capability))].filter((c) => !named.has(c))) {
    bad.push(`walkthrough.md leaves behavior to ${capability} (${walked.find((r) => r.parsed.capability === capability).entry}), but source-map.md's "## Dependencies" does not name it: add a row "| \`${capability}\` | <what it uses> | <its entry point> |"`);
  }
  for (const dep of deps.filter((d) => d.capability === own)) bad.push(`source-map.md's "## Dependencies" names its own capability ${own}: ${dep.line}`);
  // An entry point this capability uses must be one the other capability lists.
  for (const dep of deps.filter((d) => d.capability !== own && d.entries.length)) {
    const theirs = entryList(root, dep.capability, true);
    if (!theirs) continue;
    for (const id of dep.entries.filter((e) => !entryListed(e, theirs))) {
      const other = extractChange(root, dep.capability);
      const archived = other && path.basename(path.dirname(other)) === 'archive';
      bad.push(`source-map.md says ${own} uses ${id} of ${dep.capability}, which ${dep.capability}'s source map does not list under "## Entry points": correct the entry point here (path:symbol as ${dep.capability} lists it)${archived ? `, or, when ${dep.capability} really misses it (its walkthrough never followed it), amend ${dep.capability} with a source-map.md that lists it and the requirements it needs` : `, or have ${dep.capability}'s analyst add it there`}`);
    }
  }
  // An entry point another capability uses must be listed here.
  const mine = entryPoints(mapText) ?? [];
  for (const other of capabilities.filter((c) => c !== own)) {
    for (const d of sourceMapDirs(root, other, true)) {
      for (const dep of dependencies(readIf(path.join(d, 'source-map.md'), []) ?? '', capabilities).filter((x) => x.capability === own)) {
        for (const id of dep.entries.filter((e) => !entryListed(e, mine))) bad.push(`${other}'s source map (${path.basename(d)}) says it uses ${id} of ${own}, which this source map does not list under "## Entry points": list it (a public function other capabilities call is an entry point, and the walkthrough must follow it), or have ${other}'s row corrected`);
      }
    }
  }
  // Who may write a table: the survey's context map, and the plan's Shared data.
  const owners = dataOwners(root);
  const context = contextOfCapability(own);
  const writtenBy = new Map();
  for (const other of capabilities.filter((c) => c !== own && contextOfCapability(c) !== context)) {
    for (const d of sourceMapDirs(root, other, true)) {
      for (const [key, o] of databaseObjects(readIf(path.join(d, 'source-map.md'), []) ?? '')) {
        if (o.writes && isTable(o.kind)) { if (!writtenBy.has(key)) writtenBy.set(key, new Set()); writtenBy.get(key).add(other); }
      }
    }
  }
  const record = `ask the person, and record the answer as a row of "## Shared data" in ${PLAN} (| Data | Owner | Also written by |, contexts by id): in the new system only the owner's module writes the table, so another context's write becomes a call to it`;
  for (const [key, o] of databaseObjects(mapText)) {
    if (!o.writes || !isTable(o.kind)) continue;
    const who = owners(key);
    if (who.owners.size && !who.writers.has(context)) {
      bad.push(`source-map.md says ${own} writes ${o.name}, which the context map gives to ${[...who.owners].join(', ')} and does not list ${context} as also writing it: ${record}`);
    } else if (!who.owners.size && writtenBy.has(key)) {
      bad.push(`${o.name} is written by ${own} (${context}) and by ${[...writtenBy.get(key)].join(', ')} of other contexts, and the context map names no owner for it: ${record}`);
    }
  }
  capped(problems, bad, (p) => p);
}

// ---------------------------------------------------------------- links

const pairName = (a, b) => `${a} <-> ${b}`;
// A pair cell as rows are compared: the two capabilities, sorted, lowercase.
export function pairKey(cell) {
  const caps = plain(stripComments(cell)).toLowerCase().split(/\s*(?:<->|<=>|↔|⇔|,|、|\s\/\s|\s+and\s+)\s*/).map(capName).filter(Boolean).sort();
  return caps.length === 2 ? caps.join(' <-> ') : '';
}
// A topic as rows are compared: lowercase, one space; a file path keeps its form.
export const topicKey = (cell) => plain(stripComments(cell)).replace(/\\/g, '/').replace(/\s+/g, ' ').trim().toLowerCase();

// The links between capabilities with a spec. `scope`: { change, own } (the
// extract gate: links of `own`, read live), { capability } (port-ready: links of
// it with other baselines) or { all: true } (finish: every link between
// baselines). Each link: { pair, a, b, topic, key, code, sides: [sideA, sideB] }.
export function links(root, scope) {
  const live = Boolean(scope.change);
  const { map: plan } = assignment(root);
  const capabilities = [...plan.keys()].map(capName).sort();
  const own = scope.own ?? scope.capability ?? null;
  const sides = new Map();
  for (const c of new Set([...capabilities, ...(own ? [own] : [])])) {
    const side = sideOf(root, c, live);
    if (side) sides.set(c, side);
  }
  const maps = new Map([...sides.keys()].map((c) => [c, sourceMapDirs(root, c, live).map((d) => readIf(path.join(d, 'source-map.md'), []) ?? '')]));
  const deps = new Map([...maps].map(([c, texts]) => [c, new Set(texts.flatMap((t) => dependencies(t, capabilities)).map((d) => d.capability))]));
  const objects = new Map([...maps].map(([c, texts]) => {
    const merged = new Map();
    for (const t of texts) for (const [k, o] of databaseObjects(t)) { const old = merged.get(k); merged.set(k, old ? { ...old, writes: old.writes || o.writes, effect: old.effect || o.effect } : o); }
    return [c, merged];
  }));
  let shared = null;
  const sharedFiles = () => {
    if (shared) return shared;
    shared = new Map();
    const survey = archivedChange(root, 'survey');
    const inventory = inventoryRows(survey ? readIf(path.join(survey, 'inventory.md'), []) ?? '' : '');
    for (const file of keptFiles(root, inventory) ?? []) {
      const owners = ownersOf(plan, file).map(capName);
      if (owners.length < 2) continue;
      for (let i = 0; i < owners.length; i += 1) for (let j = i + 1; j < owners.length; j += 1) {
        const k = [owners[i], owners[j]].sort().join(' <-> ');
        if (!shared.has(k)) shared.set(k, []);
        shared.get(k).push(file);
      }
    }
    return shared;
  };
  const names = [...sides.keys()].sort();
  const out = [];
  for (let i = 0; i < names.length; i += 1) {
    for (let j = i + 1; j < names.length; j += 1) {
      const [a, b] = [names[i], names[j]];
      if (own && a !== own && b !== own) continue;
      const pair = pairName(a, b);
      const topics = [];
      if (deps.get(a)?.has(b) || deps.get(b)?.has(a)) topics.push('uses');
      for (const [k, o] of objects.get(a) ?? []) {
        const p = objects.get(b)?.get(k);
        if (p && (o.effect || p.effect)) topics.push(`data ${k}`);
      }
      for (const file of sharedFiles().get(pair) ?? []) topics.push(`file ${file}`);
      for (const topic of [...new Set(topics)]) {
        out.push({ pair, a, b, topic, key: `${pair}|${topicKey(topic)}`, code: `${sides.get(a).code} ${sides.get(b).code}`, sides: [sides.get(a), sides.get(b)] });
      }
    }
  }
  return out;
}

// The codes a merged row may carry for a pair: each side's live and baseline code.
export function validCodes(root, pair) {
  const caps = pair.split(' <-> ');
  return caps.map((c) => new Set([sideOf(root, c, true)?.code, sideOf(root, c, false)?.code].filter(Boolean)));
}

// ---------------------------------------------------------------- the ledger

// The ledger's rows: Map<key, { pair, topic, verdict, evidence, stamp: [a, b] | null, parsed }>.
// Stamps are read from the raw lines (headedRows drops comments).
export function ledgerRows(text) {
  const rows = new Map();
  let header = null;
  let fenced = false;
  const lines = String(text ?? '').split(/\r?\n/);
  const cells = (line) => line.trim().replace(/^\|/, '').replace(/\|$/, '').split(/(?<!\\)\|/).map((c) => c.trim());
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    if (FENCE.test(line)) { fenced = !fenced; continue; }
    if (fenced) continue;
    if (/^\s*\|/.test(line) && /^\s*\|?\s*:?-{2,}/.test(lines[i + 1] ?? '')) { header = cells(line).map((c) => plain(c).toLowerCase()); i += 1; continue; }
    if (!/^\s*\|/.test(line)) { header = null; continue; }
    if (!header || !LEDGER_HEADER.test(header[0] ?? '')) continue;
    const [pair = '', topic = '', verdict = '', evidence = ''] = cells(line);
    const key = pairKey(pair);
    if (!key && !stripComments(topic).trim()) continue;
    const stamp = verdict.match(PAIR_STAMP);
    rows.set(`${key}|${topicKey(topic)}`, { pair: plain(stripComments(pair)), topic: plain(stripComments(topic)), verdict: stripComments(verdict).trim(), evidence: stripComments(evidence).trim(), stamp: stamp ? [stamp[1].toLowerCase(), stamp[2].toLowerCase()] : null, parsed: parseVerdict(verdict) });
  }
  return rows;
}

// consistent | conflict | duplicate | term | unclear | question <change> Q<n>
export function parseVerdict(cell) {
  const v = stripComments(cell).replace(/\*\*|__|`/g, '').trim().replace(/[.。]$/, '');
  const m = v.match(/^question\s*:?\s*([a-z0-9]+(?:-[a-z0-9]+)*)\s+Q0*(\d+)$/i);
  if (m) return { kind: 'question', change: m[1].toLowerCase(), question: `Q${Number(m[2])}` };
  const k = v.toLowerCase();
  if (['consistent', 'conflict', 'duplicate', 'term', 'unclear'].includes(k)) return { kind: k };
  return { kind: v ? 'invalid' : 'blank' };
}

// What the spec names look like when an evidence cell names them.
const loose = (s) => stripComments(s).replace(/\\\|/g, '|').replace(/[*_`"'“”「」『』]/g, '').replace(/\s+/g, ' ').trim().toLowerCase();

// Whether a question of a change is asked and decided: in questions.md, with a
// ticked review item that records a decision (the change archived, or `asked`
// for the change under review, which its own gate checks).
function archivedExact(root, change) {
  const archive = path.join(changesDir(root), 'archive');
  let names = [];
  try { names = fs.readdirSync(archive, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name); } catch { return null; }
  const found = names.filter((n) => n.replace(/^\d{4}-\d{2}-\d{2}-/, '').toLowerCase() === change.toLowerCase()).sort();
  return found.length ? path.join(archive, found.at(-1)) : null;
}

function questionDecided(root, change, question) {
  const dir = archivedExact(root, change);
  if (!dir) return false;
  const ids = new Set(questionIds(readIf(path.join(dir, 'questions.md'), []) ?? ''));
  if (!ids.has(question)) return false;
  const box = checkboxes(readIf(path.join(dir, 'review.md'), []) ?? '').find((b) => b.plain.match(/^Q(\d+)\b/i) && `Q${Number(b.plain.match(/^Q(\d+)\b/i)[1])}` === question);
  return Boolean(box?.done && /decision:\s*\S/i.test(box.plain) && !PLACEHOLDER.test((box.plain.match(/decision:\s*(.*)$/i)?.[1] ?? '').trim()));
}

// Each link's state: ok, missing, stale or open, with a problem when not ok.
// `change` and `asked` (the question ids with a review item) are the change
// under review in the extract gate.
export function judge(root, list, { change = null, asked = new Set() } = {}) {
  const rows = ledgerRows(readIf(path.join(root, LEDGER), []) ?? '');
  return list.map((link) => {
    const row = rows.get(link.key);
    const where = `${link.pair} (${link.topic})`;
    if (!row) return { ...link, status: 'missing', problem: `no row in ${LEDGER} for ${where}: have a checker compare the two specs (consistency.mjs items) and merge its part with merge.mjs --into ${LEDGER}` };
    const now = link.code.split(' ');
    if (!row.stamp || row.stamp[0] !== now[0] || row.stamp[1] !== now[1]) {
      const changed = !row.stamp ? 'without the code of the two specs' : row.stamp[0] !== now[0] && row.stamp[1] !== now[1] ? 'when both specs were different' : `when the spec of ${row.stamp[0] !== now[0] ? link.a : link.b} was different`;
      return { ...link, status: 'stale', problem: `the row for ${where} in ${LEDGER} was checked ${changed}: have a checker compare the pair again (consistency.mjs items lists the current code)` };
    }
    const v = row.parsed;
    if (v.kind === 'consistent') {
      if (!row.evidence || PLACEHOLDER.test(row.evidence)) return { ...link, status: 'open', problem: `the row for ${where} is consistent with no evidence; the checker names the requirements of both specs it compared` };
      const names = link.sides.flatMap((s) => requirementNames(s.text ?? ''));
      const evidence = loose(row.evidence);
      if (!names.some((n) => evidence.includes(loose(n)))) return { ...link, status: 'open', problem: `the row for ${where} is consistent, but its evidence names no requirement of ${link.a} or ${link.b}; have the checker name the requirements it compared` };
      return { ...link, status: 'ok' };
    }
    if (v.kind === 'question') {
      if (change && v.change === change.toLowerCase()) {
        if (asked.has(v.question)) return { ...link, status: 'ok' };
        return { ...link, status: 'open', problem: `the row for ${where} points to ${v.question} of ${v.change}, which is not in questions.md with a review item` };
      }
      if (questionDecided(root, v.change, v.question)) return { ...link, status: 'ok' };
      return { ...link, status: 'open', problem: `the row for ${where} points to ${v.question} of ${v.change}, which is not a decided question of an archived change: the person decides it in that change's review first` };
    }
    const fix = {
      conflict: 'the two specs state different things about the same behavior or data: have an analyst correct the spec the code does not support (in this change; an archived one through an amendment), then check the pair again, or move it to questions.md and write "question <change> Q<n>"',
      duplicate: 'both specs specify the same behavior of the same code: keep it in the capability that owns the code and have the other spec refer to it (the requirement that uses it), then check the pair again, or move it to questions.md',
      term: 'the specs name one thing with two words (or one word for two things): use the glossary\'s word in the spec being written (an archived one through an amendment), then check the pair again, or move it to questions.md',
      unclear: 'the checker could not decide from the specs and the code: move it to questions.md and write "question <change> Q<n>", or give the checker what settles it',
    }[v.kind];
    if (fix) return { ...link, status: 'open', problem: `the row for ${where} is ${v.kind}: ${fix}` };
    return { ...link, status: 'open', problem: `the row for ${where} has the verdict "${row.verdict || 'blank'}"; write only ${VERDICTS}` };
  });
}

// The gate: every link of the scope has a current row with a verdict that holds.
export function checkConsistency(root, scope, problems, extra = {}) {
  const judged = judge(root, links(root, scope), extra).filter((l) => l.status !== 'ok');
  capped(problems, judged, (l) => l.problem);
  return judged;
}

// ---------------------------------------------------------------- CLI

function scopeFor(root, opts) {
  if (opts.all) return { all: true };
  if (opts.capability) return { capability: capName(opts.capability) };
  const dir = path.join(changesDir(root), opts.change);
  const specs = walkMd(path.join(dir, 'specs')).map((f) => path.relative(path.join(dir, 'specs'), path.dirname(f)).split(path.sep).join('/'));
  const own = specs[0] ?? opts.change.replace(/^extract-/, '').replace(/-v\d+$/, '');
  return { change: opts.change, own: capName(own) };
}

export function items(root, opts) {
  const scope = scopeFor(root, opts);
  const judged = judge(root, links(root, scope), { change: scope.change ?? null });
  const survey = archivedChange(root, 'survey');
  const rel = (p) => (p ? path.relative(root, p).split(path.sep).join('/') : null);
  return {
    ok: judged.every((l) => l.status === 'ok'),
    links: judged.map((l) => ({
      pair: l.pair, topic: l.topic, code: `<!-- pair ${l.code} -->`, status: l.status,
      sides: l.sides.map((s) => ({ capability: s.capability, specs: s.specs, sourceMap: s.dir && fs.existsSync(path.join(s.dir, 'source-map.md')) ? rel(path.join(s.dir, 'source-map.md')) : null, trace: s.dir && fs.existsSync(path.join(s.dir, 'trace.md')) ? rel(path.join(s.dir, 'trace.md')) : null })),
    })),
    todo: judged.filter((l) => l.status !== 'ok').length,
    glossary: survey && fs.existsSync(path.join(survey, 'glossary.md')) ? rel(path.join(survey, 'glossary.md')) : null,
    ledger: LEDGER,
  };
}

export function main(argv) {
  const [command, ...rest] = argv;
  const opts = { root: process.cwd() };
  for (let i = 0; i < rest.length; i += 1) {
    if (rest[i] === '--all') { opts.all = true; continue; }
    const key = { '--change': 'change', '--capability': 'capability', '--root': 'root' }[rest[i]];
    if (!key || rest[i + 1] === undefined) return usage();
    opts[key] = rest[i + 1];
    i += 1;
  }
  if ([opts.all, opts.change, opts.capability].filter(Boolean).length !== 1) return usage();
  if (!fs.existsSync(path.join(opts.root, 'openspec'))) {
    console.error(`consistency: no openspec/ folder in ${path.resolve(opts.root)}. Run this from the repository root or pass --root DIR.`);
    return 2;
  }
  if (opts.change && !fs.existsSync(path.join(changesDir(opts.root), opts.change))) {
    console.error(`consistency: no active change ${opts.change}`);
    return 2;
  }
  let result;
  if (command === 'items') result = items(opts.root, opts);
  else if (command === 'check') {
    const problems = [];
    const scope = scopeFor(opts.root, opts);
    checkConsistency(opts.root, scope, problems, { change: scope.change ?? null });
    result = { ok: problems.length === 0, problems };
  } else return usage();
  console.log(JSON.stringify(result, null, 2));
  return result.ok ? 0 : 1;
}

function usage() {
  console.error('Usage: node consistency.mjs items|check (--change extract-NAME | --capability PATH | --all) [--root DIR]');
  return 2;
}

function invokedDirectly() {
  if (!process.argv[1]) return false;
  try { return fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url)); } catch { return false; }
}

if (invokedDirectly()) process.exitCode = main(process.argv.slice(2));
