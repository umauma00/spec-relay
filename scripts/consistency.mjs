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
// - Mechanical (checkDependencies, in the extract and amend gates): the source
//   map's Dependencies table names every capability the walkthrough defers
//   behavior to; an entry point it says it uses is one the other capability's
//   archived source map lists; a table this capability writes belongs to its
//   context in the survey's context map, or the context map (or the plan's
//   "## Shared data") lists the context as also writing it.
// - The pair check (checkConsistency): for every pair of capabilities with a
//   spec that are linked (one uses the other, both use one database object and
//   one of them writes it, or the plan gives both one file), a checker reads
//   both specs and judges each link. The rows live in one project-wide ledger,
//   openspec/spec-relay/consistency.md, so a pair checked during one extract
//   counts for the port of either side and for the finish step. Each row holds
//   a code of both specs (`<!-- pair <a> <b> -->`): when either spec changes
//   (a review fix, an amendment), the row goes stale and the pair is checked
//   again. The extract gate compares the spec under review with the baselines
//   only, never with another extract's draft; port-ready (and port-done)
//   compares a baseline with the other baselines, the finish step all of them.
//   What the person decides about a row outside an extract's review (keep a
//   difference as it is) is recorded in the plan's "## Consistency decisions"
//   table and cited as `accepted D<n>`.
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
import { assignment, ownersOf, keptFiles, inventoryRows, covers } from './coverage.mjs';
import { entryPoints, entryKey, walkthroughRows } from './walkthrough.mjs';

export const LEDGER = 'openspec/spec-relay/consistency.md';
export const LEDGER_HEADER = /^(pair|組|ペア)(?![a-z0-9_])/i;
export const LEDGER_TEMPLATE = [
  '# Consistency between capabilities',
  '',
  '<!-- One row per link between two capabilities with a spec. merge.mjs writes the rows from the',
  '     checkers\' part files with the code of both specs ("pair" comment in the Verdict cell); only the',
  '     orchestrator edits a verdict (to question or accepted), keeping that code. See the spec-relay skill. -->',
  '',
  '| Pair | Topic | Verdict | Evidence |',
  '|---|---|---|---|',
  '',
].join('\n');
export const PAIR_STAMP = /<!--\s*pair\s+([0-9a-f]{8})\s+([0-9a-f]{8})\s*-->/i;
export const VERDICTS = 'consistent, conflict, duplicate, term, unclear, or (written by the orchestrator) question <change> Q<n> or accepted D<n>';

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

// The code of a spec: the requirement sections as written ("## ADDED
// Requirements" in a delta, "## Requirements" in a baseline), from the first
// "### Requirement:" on, without the headings, blank lines, trailing spaces and
// comments. The delta of a first extract and the baseline OpenSpec writes from
// it when the change is archived give the same code (OpenSpec 2.1.1 keeps the
// requirement blocks, drops the blank lines between them and does not carry
// other "## " sections of a delta), so a pair checked during the analysis stays
// checked after the archive. Null when the text holds no requirement.
export function specCode(text) {
  const kept = [];
  let inRequirements = false;
  let started = false;
  let fenced = false;
  for (const raw of stripComments(text).split(/\r?\n/)) {
    const line = raw.replace(/\s+$/, '');
    const h2 = !fenced && line.match(/^##\s+(.*)$/);
    if (FENCE.test(line)) fenced = !fenced;
    if (h2) { inRequirements = /requirements/i.test(h2[1]); continue; }
    if (!inRequirements) continue;
    if (!started && !REQUIREMENT.test(line)) continue;
    started = true;
    if (line.trim() !== '') kept.push(line);
  }
  if (!started) return null;
  return crypto.createHash('sha256').update(kept.join('\n')).digest('hex').slice(0, 8);
}

const activeChange = (root, name) => {
  let found = [];
  try { found = fs.readdirSync(changesDir(root), { withFileTypes: true }).filter((e) => e.isDirectory() && e.name !== 'archive' && baseName(e.name) === name).map((e) => e.name); } catch { /* none */ }
  const version = (n) => Number(n.match(/-v(\d+)$/)?.[1] ?? 1);
  found.sort((a, b) => version(a) - version(b));
  return found.length ? path.join(changesDir(root), found.at(-1)) : null;
};
const relOf = (root, file) => path.relative(root, file).split(path.sep).join('/');
const baselineFile = (root, capability) => path.join(root, 'openspec/specs', ...capability.split('/'), 'spec.md');
export const hasBaseline = (root, capability) => specCode(readIf(baselineFile(root, capability), []) ?? '') !== null;

// What the pair check reads of a capability. `live` is only for the capability
// of an extract gate: the spec of its active extract change (a first extract,
// with no baseline yet). Otherwise its baseline. A spec still under analysis is
// never a side for the others, so one extract never waits for another one's
// draft: that pair is checked by whichever extract gate comes after the other
// is archived, else by port-ready. Null when there is no spec with a
// requirement yet.
export function sideOf(root, capability, live = false) {
  const extract = `extract-${keyOf(capability)}`;
  if (live) {
    const active = activeChange(root, extract);
    if (!active) return null;
    const files = walkMd(path.join(active, 'specs'));
    const text = files.map((f) => readIf(f, []) ?? '').join('\n');
    const code = specCode(text);
    return code ? { capability, code, text, specs: files.map((f) => relOf(root, f)), maps: sourceMapDirs(root, capability, true), trace: path.join(active, 'trace.md') } : null;
  }
  const text = readIf(baselineFile(root, capability), []);
  const code = specCode(text ?? '');
  if (!code) return null;
  const archived = archivedChange(root, extract);
  return { capability, code, text, specs: [relOf(root, baselineFile(root, capability))], maps: sourceMapDirs(root, capability, false), trace: archived ? path.join(archived, 'trace.md') : null };
}

// The folders whose source-map.md describes a capability: its extract change
// (the active one when live, else the archived one) and its archived
// amendments (and, when live, its active ones) that carry a source map.
export function sourceMapDirs(root, capability, live = false) {
  const extract = `extract-${keyOf(capability)}`;
  const first = (live && activeChange(root, extract)) || archivedChange(root, extract);
  const dirs = first && fs.existsSync(path.join(first, 'source-map.md')) ? [first] : [];
  const amend = `amend-${keyOf(capability)}`;
  const add = (base, name) => { if (fs.existsSync(path.join(base, name, 'source-map.md'))) dirs.push(path.join(base, name)); };
  if (live) try { for (const e of fs.readdirSync(changesDir(root), { withFileTypes: true })) if (e.isDirectory() && e.name !== 'archive' && baseName(e.name) === amend) add(changesDir(root), e.name); } catch { /* none */ }
  try {
    const archive = path.join(changesDir(root), 'archive');
    for (const e of fs.readdirSync(archive, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const m = e.name.match(/^\d{4}-\d{2}-\d{2}-(.+)$/);
      if (e.isDirectory() && m && baseName(m[1]) === amend) add(archive, e.name);
    }
  } catch { /* none */ }
  return dirs;
}

// ---------------------------------------------------------------- source map sections

const DEPENDENCIES = /^(dependenc(?:y|ies)|依存)/i;
const DATABASE = /^(database|データベース|db\b)/i;
const ENTRY_COLUMN = /^(entry|入口|エントリ)/i;

// A capability path the way the plan writes it: lowercase, no backticks or final "/".
const capName = (token) => plain(String(token ?? '')).replace(/\\/g, '/').replace(/[:：,、.。;；]+$/, '').replace(/\/+$/, '').trim().toLowerCase();
// A token that names a place in the code: a path, or path:symbol.
const placeLike = (t) => /[/\\]|\.[A-Za-z0-9]+(?::|$)/.test(t) && !/\s/.test(t.trim());

// The Dependencies of a source map: [{ capability, entries: [id], line }] for the
// rows and items that name a capability of the plan (other dependencies, such
// as libraries and services, are not read). A table's first column names what is
// used; its Entry point column (only a column with that heading) the entry
// points of that capability: each backticked path or path:symbol, else each
// such word separated by commas. A list item names a capability in backticks or
// as its first word; it gives no entry points.
export function dependencies(text, capabilities) {
  const body = section(text ?? '', DEPENDENCIES);
  if (body === null) return [];
  const known = new Set([...capabilities].map(capName));
  const out = [];
  const tokensOf = (cell) => {
    const quoted = [...String(cell).matchAll(/`([^`]+)`/g)].map((m) => m[1]);
    return quoted.length ? quoted : String(cell).split(/[\s,、;；]+/);
  };
  for (const { header, cells } of headedRows(body)) {
    const caps = tokensOf(cells[0] ?? '').map(capName).filter((t) => known.has(t));
    if (!caps.length) continue;
    const at = header.findIndex((h, i) => i > 0 && ENTRY_COLUMN.test(h));
    // A note in parentheses after an entry point (`a.php:f` (`Auth.f`)) names nothing.
    const cell = at < 0 ? '' : stripComments(cells[at] ?? '').replace(/\s+[(（][^)）]*[)）]/g, '').trim();
    const quoted = [...cell.matchAll(/`([^`]+)`/g)].map((m) => m[1].trim());
    const entries = (quoted.length ? quoted : cell.split(/\s*(?:<br\s*\/?>|[,、;；])\s*/i).map((e) => e.trim())).filter((e) => e && placeLike(e));
    const row = [...new Set(caps)];
    for (const capability of row) out.push({ capability, entries, line: cells.join(' | '), row });
  }
  let fenced = false;
  for (const line of stripComments(body).split(/\r?\n/)) {
    if (FENCE.test(line)) { fenced = !fenced; continue; }
    if (fenced || /^\s*\|/.test(line)) continue;
    const item = line.match(/^\s*(?:[-*+]|\d+[.)])\s+(.*)$/);
    if (!item) continue;
    const quoted = [...item[1].matchAll(/`([^`]+)`/g)].map((m) => capName(m[1]));
    const first = capName(item[1].split(/\s+/)[0]);
    for (const capability of new Set([...quoted, first].filter((t) => known.has(t)))) out.push({ capability, entries: [], line: item[1].trim(), row: [capability] });
  }
  return out;
}

// A database object as the specs and the context map name it: only its last
// name (dbo.Orders, [dbo].[Orders] and Orders are one), lowercase. A name in
// brackets, quotes or backticks is kept whole ([Order Details]); otherwise
// the first word is the name (Orders table, Orders (legacy)).
export function objectKey(name) {
  const s = stripComments(name).replace(/\*\*|__/g, '').trim();
  const m = s.match(/`([^`]+)`|"([^"]+)"|((?:\[[^\]]+\]\s*\.\s*)*\[[^\]]+\])/);
  const core = m ? (m[1] ?? m[2] ?? m[3]).replace(/[\[\]]/g, '') : s.split(/[\s,、;；]+/)[0].replace(/^'|'$/g, '');
  return core.split(/\s*\.\s*/).filter(Boolean).pop()?.replace(/\s+/g, ' ').trim().toLowerCase() ?? '';
}

// What the Use cell says, before a note in parentheses or after a ";" or " - ".
// The cell is cut before plain(), which drops the parentheses.
const useOf = (cell) => plain(stripComments(cell).split(/\s*(?:[(（;；]|\s[-–—]\s)/)[0]);
const WRITES = /(?<![A-Za-z0-9_])(writes?|written|wrote|inserts?|inserted|updates?|updated|deletes?|deleted|upserts?|upserted|merges?|merged|truncates?|truncated|saves?|saved|modif(?:y|ies|ied)|creates?|created|crud|r\/w|rw)(?![A-Za-z0-9_])|読み書き|書き込|書込|書く|(?:更新|削除|登録|追加|挿入|作成)(?!済|日|者)/i;
const CALLS = /(?<![A-Za-z0-9_])(call|calls|called|fire|fires|fired|exec|execs|execute|executes|executed|run|runs)(?![A-Za-z0-9_])|呼ぶ|呼び出|実行|発火/i;
const READS = /(?<![A-Za-z0-9_])(reads?|select|selects|selected|references?|lookups?|look up|looks up|views?)(?![A-Za-z0-9_])|参照|読む|読み|読込|取得|検索|照会/i;

// The Database table of a source map: Map<object key, { name, kind, writes, effect, unread }>.
// writes: the Use cell says the capability changes it (a table's rows);
// effect: that, or it calls or fires it (a procedure, a trigger), or the cell
// says nothing the kit can read (unread: then it is compared as an effect).
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
    const use = useOf(cells[useAt < 0 ? 2 : useAt] ?? '');
    const unread = useAt >= 0 && !WRITES.test(use) && !CALLS.test(use) && !READS.test(use);
    const old = out.get(key) ?? { name: plain(name), kind, writes: false, effect: false, unread: false, use: '' };
    old.writes ||= WRITES.test(use);
    old.effect ||= WRITES.test(use) || CALLS.test(use) || unread;
    if (unread) { old.unread = true; old.use = use; }
    if (!old.kind) old.kind = kind;
    out.set(key, old);
  }
  return out;
}

// ---------------------------------------------------------------- data owners

const CONTEXT_HEADING = /^###\s*Context:\s*([a-z0-9]+(?:-[a-z0-9]+)*)\s*$/i;
const SHARED = /^(shared data|共有データ)/i;
const OWNED_LABEL = /^\s*(?:[-*+]\s+)?(?:\*\*|__)?\s*(owned data|持っているデータ|所有データ)\s*(?:[:：]\s*(?:\*\*|__)|(?:\*\*|__)\s*[:：])\s*(.*)$/i;

// The table names an Owned data text lists: its backticked names, else each
// comma-separated piece that is one word (prose such as "the audit log of
// orders" names nothing).
function ownedNames(text) {
  const t = stripComments(text);
  const quoted = [...t.matchAll(/`([^`]+)`/g)].map((m) => objectKey(`\`${m[1]}\``));
  if (quoted.length) return quoted.filter(Boolean);
  return t.split(/[,、;；\n]+/).map((p) => p.replace(/^\s*(?:[-*+]\s+)?/, '').replace(/\*\*|__/g, '').replace(/\s*(tables?|テーブル)\s*$/i, '').trim())
    .filter((p) => p && !/\s/.test(p) && !NOTHING.test(p)).map(objectKey).filter(Boolean);
}

// Which contexts own and may write each table, from the archived survey's
// context map (each context's Owned data, the Shared data table) and the plan's
// "## Shared data" table (the person's later decisions, same columns: Data,
// Owner, Also written by). Returns (key) => { owners: Set, writers: Set }.
export function dataOwners(root) {
  const survey = archivedChange(root, 'survey');
  const map = survey ? readIf(path.join(survey, 'context-map.md'), []) ?? '' : '';
  const owned = new Map();
  const known = new Set();
  let current = null;
  let collecting = false;
  for (const line of stripComments(map).split(/\r?\n/)) {
    const h = line.trim().match(CONTEXT_HEADING);
    if (h) { current = h[1].toLowerCase(); known.add(current); collecting = false; continue; }
    if (/^#{1,3}\s/.test(line)) { current = null; collecting = false; continue; }
    if (!current) continue;
    const m = line.match(OWNED_LABEL);
    if (m) { owned.set(current, [...(owned.get(current) ?? []), ...ownedNames(m[2])]); collecting = true; continue; }
    // A sub-list under the label continues it; the next label ends it.
    if (collecting && /^\s{2,}(?:[-*+]|\d+[.)])\s+/.test(line)) { owned.get(current).push(...ownedNames(line)); continue; }
    if (/^\s*(?:[-*+]|\d+[.)])\s+/.test(line) || line.trim()) collecting = false;
  }
  const contexts = (cell) => new Set(plain(stripComments(cell)).toLowerCase().split(/[\s,、;；/]+/).filter((c) => /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(c) && !NOTHING.test(c) && (!known.size || known.has(c))));
  const shared = [];
  const plan = readIf(path.join(root, PLAN), []) ?? '';
  for (const text of [map, plan]) {
    for (const { header, cells } of headedRows(section(text, SHARED) ?? '')) {
      const at = (re, fallback) => { const i = header.findIndex((x) => re.test(x)); return cells[i < 0 ? fallback : i] ?? ''; };
      const key = objectKey(cells[0]);
      if (!key || NOTHING.test(plain(cells[0] ?? ''))) continue;
      shared.push({ key, owners: contexts(at(/^(owner|持ち主)/i, 1)), also: contexts(at(/^(also|ほか|他)/i, 2)) });
    }
  }
  return (key) => {
    const owners = new Set();
    const writers = new Set();
    for (const [context, names] of owned) if (names.includes(key)) { owners.add(context); writers.add(context); }
    for (const row of shared.filter((r) => r.key === key)) {
      for (const c of row.owners) { owners.add(c); writers.add(c); }
      for (const c of row.also) writers.add(c);
    }
    return { owners, writers };
  };
}

const contextOfCapability = (capability) => capability.split('/')[0];
const isTable = (kind) => !kind || /table|テーブル|表|マスタ|master/i.test(kind);

// ---------------------------------------------------------------- mechanical checks (extract and amend gates)

// The entry points of a capability from its archived source maps, or null when
// none of them has an Entry points section.
function entryList(root, capability) {
  const lists = sourceMapDirs(root, capability, false).map((dir) => entryPoints(readIf(path.join(dir, 'source-map.md'), []) ?? '')).filter(Boolean);
  return lists.length ? lists.flat() : null;
}

const lastSymbol = (key) => {
  const colon = key.indexOf(':');
  return colon < 0 ? '' : key.slice(colon + 1).replace(/\(.*\)$/, '').split(/\.|::|->/).pop().trim();
};
const pathOf = (key) => (key.indexOf(':') < 0 ? key : key.slice(0, key.indexOf(':')));

// Whether an entry point id a dependency gives is one of the listed entry points:
// the same id; the same path and the same last name of the symbol
// (`src/a.php:Billing.total` and `src/a.php:total`); a page given by its path;
// or a symbol in a file listed as a whole (a PHP page's top-level code).
export function entryListed(id, entries) {
  const key = entryKey(id);
  return entries.some((e) => e.key === key
    || (pathOf(e.key) === pathOf(key) && (key.indexOf(':') < 0 || e.key.indexOf(':') < 0 || (lastSymbol(key) && lastSymbol(key) === lastSymbol(e.key)))));
}

// The mechanical checks for capability `own` (see the top), on the source map
// in `dir` (an extract change, or an amendment that carries one).
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
  // An entry point this capability uses must be one the other capability's
  // reviewed source map lists, or at least in a file the plan gives it: a
  // symbol its list misses is the pair check's (a conflict, settled on the
  // side the code supports); a file it does not own is a mistake here. (One
  // still under analysis is not compared: its list may still change.)
  for (const dep of deps.filter((d) => d.capability !== own && d.entries.length)) {
    const named = dep.row.filter((c) => c !== own);
    const lists = named.map((c) => entryList(root, c));
    if (lists.some((l) => !l)) continue;
    const theirs = lists.flat();
    for (const id of dep.entries.filter((e) => !entryListed(e, theirs))) {
      const file = pathOf(entryKey(id));
      if (named.some((c) => ownersOf(plan, file).map(capName).includes(c))) continue;
      bad.push(`source-map.md says ${own} uses ${id} of ${named.join(' or ')}, which is neither under "## Entry points" of ${named.length > 1 ? 'their' : 'its'} archived source map nor in a file the plan gives ${named.length > 1 ? 'them' : 'it'}: correct the entry point here (path:symbol as ${named.join(' or ')} lists it) or the capability that owns it`);
    }
  }
  // Who may write a table: the survey's context map, and the plan's Shared data.
  const owners = dataOwners(root);
  const context = contextOfCapability(own);
  const writtenBy = new Map();
  for (const other of capabilities.filter((c) => c !== own && contextOfCapability(c) !== context)) {
    for (const d of sourceMapDirs(root, other, false)) {
      for (const [key, o] of databaseObjects(readIf(path.join(d, 'source-map.md'), []) ?? '')) {
        if (o.writes && isTable(o.kind)) { if (!writtenBy.has(key)) writtenBy.set(key, new Set()); writtenBy.get(key).add(other); }
      }
    }
  }
  const record = `ask the person, and record the answer as a row of "## Shared data" in ${PLAN} (| Data | Owner | Also written by |, contexts by id): in the new system only the owner's module writes the table, so another context's write becomes a call to it`;
  for (const [key, o] of databaseObjects(mapText)) {
    if (o.unread) bad.push(`source-map.md's "## Database" row ${o.name}: the Use cell "${o.use}" says neither read, write nor calls; write read, write, read / write, calls or fires (a note in parentheses after it)`);
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
// A topic as rows are compared: lowercase, one space, forward slashes.
export const topicKey = (cell) => plain(stripComments(cell)).replace(/\\/g, '/').replace(/\s+/g, ' ').trim().toLowerCase();
export const TOPIC = /^(uses|data \S.*|file \S.*)$/i;

// The links between capabilities with a spec. `scope`: { change, own } (the
// extract gate: the links of `own`, its draft against the baselines),
// { capability } (port-ready and port-done: the links of its baseline with the
// other baselines) or { all: true } (finish: every link between baselines).
// Each link: { pair, a, b, topic, key, code, sides: [sideA, sideB] }.
// - uses: one side's Dependencies names the other;
// - data <object>: both use it and one writes, calls or fires it; when the
//   context map names its owner and a capability of the owner's context uses
//   it, only pairs with that capability (a table everybody writes links each
//   writer to its owner, not to every other writer);
// - file <path>: the plan lists the same file or folder under both (one link
//   per listing, not per file under a folder).
export function links(root, scope) {
  const { map: plan } = assignment(root);
  const capabilities = [...plan.keys()].map(capName).sort();
  const own = scope.own ?? scope.capability ?? null;
  const sides = new Map();
  for (const c of new Set([...capabilities, ...(own ? [own] : [])])) {
    const side = sideOf(root, c, Boolean(scope.change) && c === own);
    if (side) sides.set(c, side);
  }
  if (own && !sides.has(own)) return [];
  const mapsOf = (side) => side.maps.map((d) => readIf(path.join(d, 'source-map.md'), []) ?? '');
  const deps = new Map([...sides].map(([c, side]) => [c, new Set(mapsOf(side).flatMap((t) => dependencies(t, capabilities)).map((d) => d.capability))]));
  const objects = new Map([...sides].map(([c, side]) => {
    const merged = new Map();
    for (const t of mapsOf(side)) for (const [k, o] of databaseObjects(t)) { const old = merged.get(k); merged.set(k, old ? { ...old, writes: old.writes || o.writes, effect: old.effect || o.effect } : o); }
    return [c, merged];
  }));
  const owners = dataOwners(root);
  // The listings two capabilities share: Map<pair, Set<listed path>>.
  let shared = null;
  const sharedListings = () => {
    if (shared) return shared;
    shared = new Map();
    const survey = archivedChange(root, 'survey');
    const inventory = inventoryRows(survey ? readIf(path.join(survey, 'inventory.md'), []) ?? '' : '');
    const keys = new Map([...plan.keys()].map((k) => [capName(k), k]));
    for (const file of keptFiles(root, inventory) ?? []) {
      const who = ownersOf(plan, file).map(capName);
      if (who.length < 2) continue;
      // The owners tie on the most specific listing, so it is the same path for all of them.
      const listing = (plan.get(keys.get(who[0])) ?? []).filter((p) => covers(p, file)).sort((x, y) => (y.toLowerCase() === file.toLowerCase()) - (x.toLowerCase() === file.toLowerCase()) || y.length - x.length)[0] ?? file;
      for (let i = 0; i < who.length; i += 1) for (let j = i + 1; j < who.length; j += 1) {
        const k = [who[i], who[j]].sort().join(' <-> ');
        if (!shared.has(k)) shared.set(k, new Set());
        shared.get(k).add(listing);
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
        if (!p || !(o.effect || p.effect)) continue;
        // When a capability of the owner's context uses it, each writer meets
        // that one; when none does, the users meet each other.
        const who = owners(k).owners;
        const ownerUses = who.size && [...sides.keys()].some((c) => who.has(contextOfCapability(c)) && objects.get(c)?.has(k));
        if (ownerUses && !who.has(contextOfCapability(a)) && !who.has(contextOfCapability(b))) continue;
        topics.push(`data ${k}`);
      }
      for (const listing of [...(sharedListings().get(pair) ?? [])].sort()) topics.push(`file ${listing}`);
      for (const topic of [...new Set(topics)]) {
        out.push({ pair, a, b, topic, key: `${pair}|${topicKey(topic)}`, code: `${sides.get(a).code} ${sides.get(b).code}`, sides: [sides.get(a), sides.get(b)] });
      }
    }
  }
  return out;
}

// The codes a merged row may carry for a pair: each side's baseline code, or
// its draft's while it is in its first extract.
export function validCodes(root, pair) {
  return pair.split(' <-> ').map((c) => new Set([sideOf(root, c, true)?.code, sideOf(root, c, false)?.code].filter(Boolean)));
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

// consistent | conflict | duplicate | term | unclear | question <change> Q<n> | accepted D<n>
export function parseVerdict(cell) {
  const v = stripComments(cell).replace(/\*\*|__|`/g, '').trim().replace(/[.。]$/, '');
  let m = v.match(/^question\s*:?\s*([a-z0-9]+(?:-[a-z0-9]+)*)\s+Q0*(\d+)$/i);
  if (m) return { kind: 'question', change: m[1].toLowerCase(), question: `Q${Number(m[2])}` };
  m = v.match(/^accepted\s*:?\s*D0*(\d+)$/i);
  if (m) return { kind: 'accepted', decision: `D${Number(m[1])}` };
  const k = v.toLowerCase();
  if (['consistent', 'conflict', 'duplicate', 'term', 'unclear'].includes(k)) return { kind: k };
  return { kind: v ? 'invalid' : 'blank' };
}

const DECISIONS = /^(consistency decisions|整合性の判断)/i;
// The person's decisions about links, in the plan's "## Consistency decisions"
// table (| Id | Pair | Topic | Decision |): Map<D<n>, { key, decision }>.
// The Decision cell carries the pair code of the specs it was decided on
// (<!-- pair <a> <b> -->, copied from the ledger row): a decision holds only
// for those specs, so after an amendment the person decides again.
export function decisions(root) {
  const out = new Map();
  const text = readIf(path.join(root, PLAN), []) ?? '';
  const body = section(text, DECISIONS) ?? '';
  // section() drops comments, so the codes are read from the raw lines.
  const stamps = new Map();
  let inside = false;
  for (const line of text.split(/\r?\n/)) {
    const h = line.match(/^##\s+(.*?)\s*#*\s*$/);
    if (h) { inside = DECISIONS.test(h[1].replace(/^\d+[.)]?\s*/, '')); continue; }
    if (!inside) continue;
    const id = line.match(/^\s*\|\s*D0*(\d+)\s*\|/i);
    const stamp = line.match(PAIR_STAMP);
    if (id && stamp) stamps.set(`D${Number(id[1])}`, [stamp[1].toLowerCase(), stamp[2].toLowerCase()]);
  }
  for (const { cells } of headedRows(body)) {
    const id = plain(cells[0] ?? '').match(/^D0*(\d+)$/i);
    if (!id) continue;
    const d = `D${Number(id[1])}`;
    out.set(d, { key: `${pairKey(cells[1] ?? '')}|${topicKey(cells[2] ?? '')}`, decision: plain(stripComments(cells[3] ?? '')), stamp: stamps.get(d) ?? null });
  }
  return out;
}

// The question ids of a change that have a review item, as its gate counts them.
export function askedOf(dir) {
  const items = new Set(checkboxes(readIf(path.join(dir, 'review.md'), []) ?? '').map((b) => b.plain.match(/^Q(\d+)\b/i)).filter(Boolean).map((m) => `Q${Number(m[1])}`));
  return new Set(questionIds(readIf(path.join(dir, 'questions.md'), []) ?? '').filter((id) => items.has(id)));
}

// What the spec names look like when an evidence cell names them.
const loose = (s) => stripComments(s).replace(/\\\|/g, '|').replace(/\*\*|__/g, '').replace(/\s+/g, ' ').trim().toLowerCase();
const QUOTES = [['"', '"'], ['“', '”'], ['「', '」'], ['『', '』'], ['`', '`']];
// How the evidence names a side: 'quoted' (a requirement of it in quotes, the
// title whole, so a title holding 「」 or quotes itself counts), 'nothing'
// ("platform/auth: nothing", it states nothing about the topic) or null.
function namesSide(evidence, side) {
  const text = loose(evidence);
  if (requirementNames(side.text ?? '').some((n) => QUOTES.some(([o, c]) => text.includes(`${o}${loose(n)}${c}`)))) return 'quoted';
  const cap = side.capability.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`${cap}\\s*[:：]\\s*(nothing|none|なし|記載なし)`, 'i').test(text) ? 'nothing' : null;
}

// Each link's state: ok, missing, stale or open, with a problem when not ok.
// `change` and `asked` (the question ids with a review item) are the change
// under review in the extract gate: only there does a question count.
export function judge(root, list, { change = null, asked = new Set(), problems = [] } = {}) {
  const rows = list.length ? ledgerRows(readIf(path.join(root, LEDGER), problems) ?? '') : new Map();
  let decided = null;
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
      const named = link.sides.map((s) => namesSide(row.evidence, s));
      const missing = link.sides.filter((s, i) => !named[i]).map((s) => s.capability);
      if (missing.length) return { ...link, status: 'open', problem: `the row for ${where} is consistent, but its evidence does not name in quotes a requirement of ${missing.join(' and ')} (or say "<capability>: nothing" for a side that states nothing about it); have the checker name the requirements it compared` };
      if (!named.includes('quoted')) return { ...link, status: 'open', problem: `the row for ${where} is consistent, but its evidence says both sides state nothing about it: then the link compares nothing; have the checker name in quotes the requirement of the side that states it, or judge it unclear` };
      return { ...link, status: 'ok' };
    }
    if (v.kind === 'question') {
      if (change && v.change === change.toLowerCase() && asked.has(v.question)) return { ...link, status: 'ok' };
      if (change && v.change === change.toLowerCase()) return { ...link, status: 'open', problem: `the row for ${where} points to ${v.question}, which is not in questions.md with a review item` };
      return { ...link, status: 'open', problem: `the row for ${where} still points to ${v.question} of ${v.change}: a question holds only during that change's review. Do what the person decided: an amendment of the wrong side, then compare the pair again; or, to keep the difference, record the decision as a row of "## Consistency decisions" in ${PLAN} (| D<n> | ${link.pair} | ${link.topic} | <the decision> |) and write "accepted D<n>"` };
    }
    if (v.kind === 'accepted') {
      decided ??= decisions(root);
      const d = decided.get(v.decision);
      if (d && d.key === link.key && d.decision && !PLACEHOLDER.test(d.decision)) {
        if (d.stamp && d.stamp[0] === now[0] && d.stamp[1] === now[1]) return { ...link, status: 'ok' };
        return { ...link, status: 'open', problem: `the row for ${where} is accepted ${v.decision}, but ${v.decision} in "## Consistency decisions" of ${PLAN} ${d.stamp ? 'was decided on other specs: have a checker compare the pair again, and ask the person again when the difference is still there (a new D<n>)' : `has no pair code: copy the row's <!-- pair ${link.code} --> into its Decision cell`}` };
      }
      return { ...link, status: 'open', problem: `the row for ${where} is accepted ${v.decision}, but "## Consistency decisions" in ${PLAN} has no ${v.decision} with this pair, this topic and a decision` };
    }
    const fix = {
      conflict: 'the two specs state different things about the same behavior or data: have an analyst correct the spec the code does not support (an archived one through an amendment), then compare the pair again; in an extract\'s review, or for the person to decide, move it to questions.md and write "question <change> Q<n>"',
      duplicate: 'both specs specify the same behavior of the same code: in an extract, have its spec refer to the capability that owns the code instead, then compare the pair again; between baselines, ask the person (a question in an extract, else a decision recorded as accepted D<n>)',
      term: 'the specs name one thing with two words (or one word for two things): in an extract, use the glossary\'s word, then compare the pair again; between baselines, ask the person (an amendment, or a decision recorded as accepted D<n>)',
      unclear: 'the checker could not decide from the specs and the code: give the checker what settles it, or ask the person (a question in an extract, else a decision recorded as accepted D<n>)',
    }[v.kind];
    if (fix) return { ...link, status: 'open', problem: `the row for ${where} is ${v.kind}: ${fix}` };
    return { ...link, status: 'open', problem: `the row for ${where} has the verdict "${row.verdict || 'blank'}"; write only ${VERDICTS}` };
  });
}

// The gate: every link of the scope has a current row with a verdict that holds.
export function checkConsistency(root, scope, problems, extra = {}) {
  const judged = judge(root, links(root, scope), { ...extra, problems }).filter((l) => l.status !== 'ok');
  capped(problems, judged, (l) => l.problem);
  return judged;
}

// ---------------------------------------------------------------- CLI

function scopeFor(root, opts) {
  if (opts.all) return { all: true };
  if (opts.capability) return { capability: capName(opts.capability) };
  const dir = path.join(changesDir(root), opts.change);
  const specs = walkMd(path.join(dir, 'specs')).map((f) => path.relative(path.join(dir, 'specs'), path.dirname(f)).split(path.sep).join('/'));
  const own = capName(specs[0] ?? opts.change.replace(/^extract-/, '').replace(/-v\d+$/, ''));
  return { change: opts.change, own, dir };
}

// The extract gate's part, the same for gate.mjs and the CLI. A rerun
// (extract-<capability>-v<n> of a capability with a baseline) is compared
// after its archive, by port-ready: its delta is not the spec the others meet.
export function checkExtractLinks(root, dir, own, problems, asked = askedOf(dir)) {
  checkDependencies(root, dir, own, problems);
  if (hasBaseline(root, own)) return;
  checkConsistency(root, { change: path.basename(dir), own }, problems, { change: path.basename(dir), asked });
}

export function items(root, opts) {
  const scope = scopeFor(root, opts);
  const rerun = scope.change && hasBaseline(root, scope.own);
  const list = rerun ? [] : links(root, scope);
  const judged = judge(root, list, scope.change ? { change: scope.change, asked: askedOf(scope.dir) } : {});
  const survey = archivedChange(root, 'survey');
  const existing = (p) => (p && fs.existsSync(p) ? relOf(root, p) : null);
  return {
    ok: judged.every((l) => l.status === 'ok'),
    ...(rerun ? { note: `${scope.own} has a baseline: a rerun is compared after its archive (consistency.mjs items --capability ${scope.own})` } : {}),
    links: judged.map((l) => ({
      pair: l.pair, topic: l.topic, code: `<!-- pair ${l.code} -->`, status: l.status,
      sides: l.sides.map((s) => ({ capability: s.capability, specs: s.specs, sourceMaps: s.maps.map((d) => relOf(root, path.join(d, 'source-map.md'))), trace: existing(s.trace) })),
    })),
    todo: judged.filter((l) => l.status !== 'ok').length,
    glossary: survey ? existing(path.join(survey, 'glossary.md')) : null,
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
    if (scope.change) checkExtractLinks(opts.root, scope.dir, scope.own, problems);
    else checkConsistency(opts.root, scope, problems);
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
