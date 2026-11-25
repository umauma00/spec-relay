// File-level coverage: every source file the migration keeps belongs to a
// capability, and every capability's source map holds the files assigned to it.
// Without these checks a file nobody claims, or a file an analyst left out of a
// source map, never reaches a spec, and the implementer (who adds nothing the
// spec lacks) drops its behavior without anyone noticing.
//
// The assignment of files to capabilities lives in the indented items under each
// capability of the survey's capabilities.md, copied to openspec/spec-relay/plan.md
// after the survey is archived. The plan is the live copy: when a file moves to
// another capability, the orchestrator moves its line there.
//
// gate.mjs runs these checks in `review` (survey, extract, amend) and in
// `coverage`, the check over the whole plan.
import fs from 'node:fs';
import path from 'node:path';
import { readIf, tableRows, plain, norm, sourceFiles, archivedChange, baseName, PLAN, DATABASE_DIR, checkDatabaseDrift } from './gate.mjs';
import { parseRefs } from './render.mjs';

const MAX_LISTED = 20;
const stripComments = (text) => text.replace(/<!--[\s\S]*?-->/g, '');
const FENCE = /^\s*(```|~~~)/;
const ITEM = /^(\s*)(?:[-*+]|\d+[.)])\s+(.*)$/;

// Repository-relative path with forward slashes; a leading "./" or "/" and
// surrounding backticks go.
export const repoPath = (p) => p.trim().replace(/^`(.*)`$/, '$1').trim().replace(/\\/g, '/').replace(/^\.\//, '').replace(/^\/+/, '');

// A path ending in "/" covers every file below it; any other path covers itself.
// Letter case is ignored: on Windows `src/Billing/` and `src/billing/` are one
// folder, and a checkout from Windows keeps whichever case someone typed.
export const covers = (listed, file) => {
  const a = listed.toLowerCase(); const b = file.toLowerCase();
  return a === b || (a.endsWith('/') && b.startsWith(a));
};
// How specific a covering path is: an exact file beats any folder, a deeper folder a shallower one.
const specificity = (listed, file) => (listed.toLowerCase() === file.toLowerCase() ? Infinity : listed.length);

const indentOf = (s) => s.replace(/\t/g, '    ').length;
// The path an item names: its first backticked token, else its first word when
// that looks like a path (see barePath). A link keeps its text.
export function itemPath(text) {
  return itemPaths(text)[0] ?? '';
}

// Every path an item names: the backticked tokens that hold a "/" (a symbol
// such as `formatMoney` beside a path is not one), else the first backticked
// token, else the first word when it looks like a path.
export function itemPaths(text) {
  const t = text.replace(/\[([^\]]*)\]\([^)]*\)/g, '$1').replace(/\*\*|__/g, '');
  const quoted = [...t.matchAll(/`([^`]+)`/g)].map((m) => m[1]);
  if (quoted.length) {
    const paths = quoted.filter((q) => q.includes('/'));
    return (paths.length ? paths : quoted.slice(0, 1)).map(repoPath).filter(Boolean);
  }
  const bare = barePath(t);
  return bare ? [bare] : [];
}

// A bare word is a path when it has a folder, an extension or a leading dot
// (.gitignore, .htaccess); a file without an extension (Makefile) needs backticks.
function barePath(t) {
  const bare = (t.trim().split(/\s+/)[0] ?? '').replace(/[,;:、。]+$/, '');
  if (/^n\/a$/i.test(bare) || !/^[^*<>"|?]+$/.test(bare) || !(/[\\/]/.test(bare) || /\.[A-Za-z0-9]{1,8}$/.test(bare) || /^\.[^.\s\\/]/.test(bare))) return '';
  return repoPath(bare);
}

const lines = (text) => {
  let fenced = false;
  return stripComments(text ?? '').split(/\r?\n/).filter((line) => {
    if (FENCE.test(line)) { fenced = !fenced; return false; }
    return !fenced;
  });
};

function capped(problems, list, say) {
  for (const item of list.slice(0, MAX_LISTED)) problems.push(say(item));
  if (list.length > MAX_LISTED) problems.push(`...and ${list.length - MAX_LISTED} more`);
}

// Inventory rows of the survey: { path, context }.
export function inventoryRows(text) {
  return tableRows(text).map(([p = '', context = '']) => ({ path: repoPath(p), context: plain(context).toLowerCase() })).filter((r) => r.path);
}

// The context of the most specific inventory row that covers the file, or null.
export function contextOf(rows, file) {
  let best = null;
  for (const row of rows) {
    if (covers(row.path, file) && (!best || specificity(row.path, file) > specificity(best.path, file))) best = row;
  }
  return best ? best.context : null;
}

// The source paths listed under each capability: Map<capability, string[]>.
// A capability is a top-level item that starts with its backticked path; its
// source folders and files are the indented items below it, each a backticked
// path (or a bare path). `onlyUnder` limits the reading to the `##` section whose
// heading matches it (the plan's "## Capabilities").
export function capabilitySources(text, onlyUnder = null) {
  const out = new Map();
  let current = null;
  let inSection = onlyUnder === null;
  for (const line of lines(text)) {
    const h = line.match(/^(#{1,6})\s+(.*)$/);
    if (h) {
      if (h[1].length <= 2 && onlyUnder) inSection = onlyUnder.test(h[2].trim());
      current = null;
      continue;
    }
    if (!inSection) continue;
    const item = line.match(ITEM);
    if (!item) continue;
    // A top-level item is a capability only when it starts with the backticked
    // path, as capabilityList in gate.mjs reads it; any other top-level item ends
    // the previous capability's list.
    if (indentOf(item[1]) <= 1) {
      const top = item[2].match(/^`([^`]+)`/);
      current = top ? top[1] : null;
      if (current && !out.has(current)) out.set(current, []);
      continue;
    }
    if (!current) continue;
    out.get(current).push(...itemPaths(item[2]));
  }
  return out;
}

// A listed path without its trailing "/" that is a folder on disk is read as the folder.
function asFolders(root, map) {
  for (const paths of map.values()) {
    for (let k = 0; k < paths.length; k += 1) {
      if (paths[k].endsWith('/')) continue;
      try { if (fs.statSync(path.join(root, paths[k])).isDirectory()) paths[k] = `${paths[k]}/`; } catch { /* a file, or nothing */ }
    }
  }
  return map;
}

const PLAN_SECTION = /^(?:\d+[.)]?\s*)?(?:capabilit(?:y|ies)\b|機能|ケイパビリティ)/i;

// The assignment the checks use. Once the plan lists capabilities, they are the
// capabilities (a rename or a merge there wins). Their paths are the plan's when
// the plan lists any path at all; a plan copied without paths takes each
// capability's paths from the archived survey's capabilities.md. Without a plan,
// the survey's list is the assignment. `from` names where each capability's
// paths came from, for messages.
export function assignment(root, problems = []) {
  const plan = capabilitySources(readIf(path.join(root, PLAN), problems) ?? '', PLAN_SECTION);
  const survey = archivedChange(root, 'survey');
  const listed = capabilitySources((survey ? readIf(path.join(survey, 'capabilities.md'), problems) : null) ?? '');
  const SURVEY = 'capabilities.md of the archived survey';
  const map = new Map();
  const from = new Map();
  if (plan.size === 0) {
    for (const [capability, paths] of listed) { map.set(capability, [...paths]); from.set(capability, SURVEY); }
  } else {
    const planPaths = [...plan.values()].some((paths) => paths.length);
    for (const [capability, paths] of plan) {
      const own = planPaths ? paths : listed.get(capability) ?? [];
      map.set(capability, [...own]);
      from.set(capability, planPaths ? PLAN : SURVEY);
    }
  }
  return { map: asFolders(root, map), from };
}

// The owners of every file, computed once.
export function ownerTable(map, files) {
  return new Map(files.map((file) => [file, ownersOf(map, file)]));
}

// The capabilities that own a file: those whose listing covers it most specifically.
// The same exact path under several capabilities (a god class split by method)
// gives several owners.
export function ownersOf(map, file) {
  let best = -1;
  let owners = [];
  for (const [capability, paths] of map) {
    for (const listed of paths) {
      if (!covers(listed, file)) continue;
      const s = specificity(listed, file);
      if (s > best) { best = s; owners = [capability]; } else if (s === best && !owners.includes(capability)) owners.push(capability);
    }
  }
  return owners;
}

// Source files the migration keeps: on disk under the source root and not
// excluded in the inventory. A file the inventory does not name is kept too (the
// survey gate stops on it).
export function keptFiles(root, inventory) {
  const files = sourceFiles(root);
  if (files === null) return null;
  return files.filter((file) => contextOf(inventory, file) !== 'excluded');
}

function unknownListings(map, files, problems, where, skip = () => false) {
  for (const [capability, paths] of map) {
    for (const listed of paths) {
      if (!skip(listed) && !files.some((file) => covers(listed, file))) problems.push(`${typeof where === 'string' ? where : where.get(capability)} lists ${listed} under ${capability}, but no source file is there`);
    }
  }
}

// Survey review: every kept file belongs to a capability of capabilities.md,
// and every capability owns at least one kept file.
export function checkSurveyCoverage(root, dir, inventory, problems) {
  const files = keptFiles(root, inventory);
  if (!files) return;
  const map = asFolders(root, capabilitySources(readIf(path.join(dir, 'capabilities.md'), problems) ?? ''));
  const owners = ownerTable(map, files);
  const unowned = files.filter((file) => owners.get(file).length === 0);
  capped(problems, unowned, (file) => `source file is in no capability of capabilities.md: ${file} (list it, or its folder, under a capability, or mark it excluded in inventory.md)`);
  unknownListings(map, sourceFiles(root) ?? [], problems, 'capabilities.md');
  for (const capability of map.keys()) {
    if (!files.some((file) => owners.get(file).includes(capability))) problems.push(`capability ${capability} owns no source file in capabilities.md; list its folders or files in indented items under it`);
  }
}

const SOURCE_FILES = /^##\s+(?:\d+[.)]?\s*)?(?:source\s+files\b|ソースファイル|元ファイル|対象ファイル|ファイル)/i;
const OUT_OF_SCOPE = /^(no\b|none\b|out\b|excluded\b|範囲外|対象外|なし)/i;

// While the database definitions differ from the ones the survey recorded, the
// drift problem says what to do (survey-v2); a list of each new or moved
// definition file would only repeat it.
const inDatabaseDir = (file) => file.toLowerCase().startsWith(`${DATABASE_DIR.toLowerCase()}/`);
function databaseDrifted(root, problems = []) {
  const before = problems.length;
  checkDatabaseDrift(root, problems);
  return problems.length > before;
}
const unlessDrifted = (drifted, files) => (drifted ? files.filter((file) => !inDatabaseDir(file)) : files);

// The paths in the first column of the source map's "## Source files" table
// (every table when there is no such heading), so a dependency table is never
// read as files. A row whose "In scope" cell says it is out of scope does not count.
export function sourceMapPaths(text, root = null) {
  const all = stripComments(text ?? '').split(/\r?\n/);
  const start = all.findIndex((line) => SOURCE_FILES.test(line.trim()));
  let section = all;
  if (start < 0) {
    // No Source files heading: every table but the Database one, which names objects, not files.
    const db = all.findIndex((line) => /^##\s+database\s*$/i.test(line.trim()));
    if (db >= 0) {
      const end = all.findIndex((line, i) => i > db && /^#{1,2}\s/.test(line.trim()));
      section = [...all.slice(0, db), ...(end < 0 ? [] : all.slice(end))];
    }
  } else {
    const end = all.findIndex((line, i) => i > start && /^#{1,2}\s/.test(line.trim()));
    section = all.slice(start + 1, end < 0 ? all.length : end);
  }
  return tableRows(section.join('\n'))
    .filter(([, , scope = '']) => !OUT_OF_SCOPE.test(plain(scope)))
    .map(([p = '']) => {
      // A plain cell is the path as written (`My Project/AssemblyInfo.vb` has a space);
      // a cell with marks or a note after the path gives its path.
      const whole = repoPath(p.replace(/\*\*|__/g, ''));
      if (root && whole && fs.existsSync(path.join(root, whole))) return whole;
      if (!/[`[*_]/.test(p) && !/\s\(|\s[-–—]\s/.test(p)) return whole;
      return itemPath(p) || whole;
    }).filter((p) => p && !/^path$/i.test(p))
    // A folder written without its trailing / is still the folder.
    .map((p) => { try { return root && !p.endsWith('/') && fs.statSync(path.join(root, p)).isDirectory() ? `${p}/` : p; } catch { return p; } });
}

// Extract review: the source map exists, every path in it exists, and it holds
// every kept file the plan assigns to this capability.
export function checkSourceMap(root, dir, capability, problems) {
  const text = readIf(path.join(dir, 'source-map.md'), problems);
  if (text === null) { problems.push('source-map.md is missing'); return; }
  const listed = sourceMapPaths(text, root);
  if (listed.length === 0) { problems.push('source-map.md lists no source files ("| Path | Role | In scope |")'); return; }
  for (const p of listed) {
    if (p.split('/').includes('..') || !fs.existsSync(path.join(root, p))) problems.push(`source-map.md lists ${p}, which does not exist`);
  }
  const survey = archivedChange(root, 'survey');
  if (!survey) return;
  const files = keptFiles(root, inventoryRows(readIf(path.join(survey, 'inventory.md'), problems) ?? ''));
  if (!files) return;
  const { map, from } = assignment(root, problems);
  const owned = files.filter((file) => ownersOf(map, file).includes(capability));
  if (owned.length === 0) {
    problems.push(`${PLAN} assigns no source file to ${capability}; list its folders or files in indented items under it`);
    return;
  }
  const missing = unlessDrifted(databaseDrifted(root), owned.filter((file) => !listed.some((p) => covers(p, file))));
  capped(problems, missing, (file) => `source file assigned to ${capability} in ${from.get(capability)} is not in source-map.md: ${file} (add it, or move it to the capability it belongs to in ${PLAN})`);
}

const withoutRequirementId = (s) => norm(plain(s).replace(/^R\d+\b(?:[.:)-]|\s+(?:[:)]|[.-](?=\s|$)))?\s*/i, ''));

// The Source cells of trace.md by requirement name (lowercase, without its R<n>).
export function traceSources(text) {
  const rows = new Map();
  for (const [name = '', source = ''] of tableRows(text ?? '')) {
    const key = withoutRequirementId(name);
    if (key) rows.set(key, [...(rows.get(key) ?? []), source.replace(/\\\|/g, '|')]);
  }
  return rows;
}

// The source references of every requirement in a change's trace.md:
// Map<requirement name (lowercase, without R<n>), [{ file, symbol, from, to }]>.
export function traceRefs(dir) {
  const refs = new Map();
  for (const [key, sources] of traceSources(readIf(path.join(dir, 'trace.md'), []))) {
    refs.set(key, sources.flatMap((source) => parseRefs(source)).map((ref) => ({ ...ref, file: repoPath(ref.file) })));
  }
  return refs;
}

// The number of lines of a file (LF, CRLF or CR ends a line; a last line break
// starts no line), or null when it cannot be read. Bytes are enough for every
// encoding old sources use except UTF-16, which is read by its byte order mark.
const lineCounts = new Map();
function lineCount(root, file) {
  const full = path.join(root, file);
  let stat;
  try { stat = fs.statSync(full); } catch { return null; }
  const key = `${full}\0${stat.size}\0${stat.mtimeMs}`;
  if (lineCounts.has(key)) return lineCounts.get(key);
  let count = null;
  try {
    const buffer = fs.readFileSync(full);
    const wide = buffer[0] === 0xff && buffer[1] === 0xfe ? 'utf-16le' : buffer[0] === 0xfe && buffer[1] === 0xff ? 'utf-16be' : null;
    const parts = (wide ? new TextDecoder(wide).decode(buffer) : buffer.toString('latin1')).split(/\r\n|\r|\n/);
    count = parts.length - (parts.at(-1) === '' ? 1 : 0);
  } catch { /* unreadable: no check */ }
  lineCounts.set(key, count);
  return count;
}

// Extract and amend review: every requirement has a trace row whose source
// references name a symbol or lines in a source file the migration keeps (not
// the target code, the kit's files or an excluded file), and the lines exist.
export function checkTrace(root, dir, requirements, problems) {
  if (requirements.length === 0) return;
  const text = readIf(path.join(dir, 'trace.md'), problems);
  if (text === null) { problems.push('trace.md is missing'); return; }
  const rows = traceSources(text);
  const survey = archivedChange(root, 'survey');
  const kept = survey ? keptFiles(root, inventoryRows(readIf(path.join(survey, 'inventory.md'), []) ?? '')) : null;
  for (const name of requirements) {
    const sources = rows.get(norm(name));
    if (sources === undefined) { problems.push(`requirement has no trace row: "${name}"`); continue; }
    const refs = sources.flatMap((source) => parseRefs(source));
    if (refs.length === 0) { problems.push(`the trace row of "${name}" names no source location (path:symbol:lines)`); continue; }
    for (const ref of refs) {
      const file = repoPath(ref.file);
      if (file.split('/').includes('..') || !fs.existsSync(path.join(root, file))) problems.push(`the trace of "${name}" points to ${file}, which does not exist`);
      else if (kept && !kept.some((k) => k.toLowerCase() === file.toLowerCase())) problems.push(`the trace of "${name}" points to ${file}, which is not a kept source file (target code, an excluded file or a file outside the source root)`);
      else if (!ref.symbol && ref.from === null) problems.push(`the trace of "${name}" names only the file ${file}; add the symbol or the lines (path:symbol:lines)`);
      else if (ref.from !== null) {
        // Lines that are not in the file point nowhere: the implementer and the checker would read other code.
        const count = lineCount(root, file);
        if (ref.from < 1 || ref.to < ref.from) problems.push(`the trace of "${name}" gives ${file} the lines ${ref.from}-${ref.to}, which is not a range`);
        else if (count !== null && ref.to > count) problems.push(`the trace of "${name}" gives ${file} the lines ${ref.from}-${ref.to}, but the file has ${count} lines`);
      }
    }
  }
}

// Amend review: a source-map.md in an amendment (a file moved to the capability
// after its extract was archived) lists existing files, and each of them is
// cited by the trace of a requirement the amendment adds or modifies, so the
// file is specified, not only listed.
export function checkAmendSourceMap(root, dir, requirements, problems) {
  const text = readIf(path.join(dir, 'source-map.md'), problems);
  if (text === null) return;
  const listed = sourceMapPaths(text, root);
  const wanted = new Set(requirements.map(norm));
  const cited = tableRows(readIf(path.join(dir, 'trace.md'), []) ?? '')
    .filter(([name = '']) => wanted.has(withoutRequirementId(name)))
    .flatMap(([, source = '']) => parseRefs(source).map((ref) => repoPath(ref.file)));
  for (const p of listed) {
    if (p.split('/').includes('..') || !fs.existsSync(path.join(root, p))) problems.push(`source-map.md lists ${p}, which does not exist`);
    else if (!cited.some((file) => covers(p, file))) problems.push(`source-map.md lists ${p}, but no requirement of this amendment traces to it; specify what it does, or leave it out`);
  }
}

// The newest extract change of a capability: an active one, else the archived one.
export function extractChange(root, capability) {
  const key = `extract-${capability.split('/').join('-')}`;
  const changes = path.join(root, 'openspec/changes');
  let active = [];
  try { active = fs.readdirSync(changes, { withFileTypes: true }).filter((e) => e.isDirectory() && e.name !== 'archive' && baseName(e.name) === key).map((e) => e.name); } catch { /* none */ }
  const version = (name) => Number(name.match(/-v(\d+)$/)?.[1] ?? 1);
  active.sort((a, b) => version(a) - version(b));
  if (active.length) return path.join(changes, active[active.length - 1]);
  return archivedChange(root, key);
}

// The source map paths of a capability: its newest extract change's, plus those
// of its amendments (active or archived) that carry a source-map.md, for a file
// that moved to the capability after its extract was archived.
export function capabilitySourceMap(root, capability, extract) {
  const key = `amend-${capability.split('/').join('-')}`;
  const changes = path.join(root, 'openspec/changes');
  const dirs = [extract];
  const add = (base, name) => { if (fs.existsSync(path.join(base, name, 'source-map.md'))) dirs.push(path.join(base, name)); };
  try { for (const e of fs.readdirSync(changes, { withFileTypes: true })) if (e.isDirectory() && baseName(e.name) === key) add(changes, e.name); } catch { /* none */ }
  try {
    for (const e of fs.readdirSync(path.join(changes, 'archive'), { withFileTypes: true })) {
      const m = e.name.match(/^\d{4}-\d{2}-\d{2}-(.+)$/);
      if (e.isDirectory() && m && baseName(m[1]) === key) add(path.join(changes, 'archive'), e.name);
    }
  } catch { /* none */ }
  return dirs.flatMap((dir) => sourceMapPaths(readIf(path.join(dir, 'source-map.md'), []) ?? '', root));
}

// `gate.mjs coverage`: the whole plan. Every kept file has a capability, every
// listed path exists, and every capability analyzed so far holds its files in its
// source map. Capabilities not analyzed yet are listed, not failed.
export function checkCoverage(root) {
  const problems = [];
  const survey = archivedChange(root, 'survey');
  if (!survey) return { ok: false, problems: ['no archived survey change: the coverage check needs the reviewed inventory and capability list'] };
  const inventory = inventoryRows(readIf(path.join(survey, 'inventory.md'), problems) ?? '');
  const all = sourceFiles(root);
  if (all === null) return { ok: false, problems: ['the source root in openspec/config.yaml is not a folder inside the repository'] };
  const files = keptFiles(root, inventory);
  const drifted = databaseDrifted(root, problems);
  const { map, from } = assignment(root, problems);
  const owners = ownerTable(map, files);
  const unowned = unlessDrifted(drifted, files.filter((file) => owners.get(file).length === 0));
  capped(problems, unowned, (file) => `source file is in no capability of ${PLAN}: ${file} (list it under its capability, or have the person exclude it)`);
  const uninventoried = unlessDrifted(drifted, all.filter((file) => contextOf(inventory, file) === null));
  capped(problems, uninventoried, (file) => `source file is not in the archived inventory (added after the survey?): ${file}`);
  unknownListings(map, all, problems, from, (listed) => drifted && inDatabaseDir(listed));
  const pending = [];
  let analyzed = 0;
  for (const capability of map.keys()) {
    const owned = files.filter((file) => owners.get(file).includes(capability));
    if (owned.length === 0) problems.push(`capability ${capability} owns no source file; list its folders or files under it in ${PLAN}`);
    const change = extractChange(root, capability);
    if (!change) { pending.push(capability); continue; }
    analyzed += 1;
    const listed = capabilitySourceMap(root, capability, change);
    const missing = unlessDrifted(drifted, owned.filter((file) => !listed.some((p) => covers(p, file))));
    capped(problems, missing, (file) => `source file assigned to ${capability} is not in the source map of ${path.basename(change)} or of an amendment: ${file}`);
  }
  return { ok: problems.length === 0, problems, files: files.length, capabilities: { analyzed, pending } };
}
