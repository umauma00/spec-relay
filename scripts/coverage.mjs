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
import { readIf, tableRows, plain, norm, sourceFiles, archivedChange, baseName, PLAN } from './gate.mjs';
import { parseRefs } from './render.mjs';

const MAX_LISTED = 20;
const stripComments = (text) => text.replace(/<!--[\s\S]*?-->/g, '');
const FENCE = /^\s*(```|~~~)/;
const ITEM = /^(\s*)(?:[-*+]|\d+[.)])\s+(.*)$/;

// Repository-relative path with forward slashes; a leading "./" or "/" and
// surrounding backticks go.
export const repoPath = (p) => p.trim().replace(/^`(.*)`$/, '$1').trim().replace(/\\/g, '/').replace(/^\.\//, '').replace(/^\/+/, '');

// A path ending in "/" covers every file below it; any other path covers itself.
export const covers = (listed, file) => listed === file || (listed.endsWith('/') && file.startsWith(listed));
// How specific a covering path is: an exact file beats any folder, a deeper folder a shallower one.
const specificity = (listed, file) => (listed === file ? Infinity : listed.length);

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
    const top = item[1].length <= 1 ? item[2].match(/^`([^`]+)`/) : null;
    if (top) { current = top[1]; if (!out.has(current)) out.set(current, []); continue; }
    if (!current || item[1].length < 2) continue;
    const quoted = [...item[2].matchAll(/`([^`]+)`/g)].map((m) => m[1]);
    const bare = item[2].trim().split(/\s+/)[0] ?? '';
    const paths = quoted.length ? quoted : (/[./]/.test(bare) ? [bare] : []);
    out.get(current).push(...paths.map(repoPath).filter(Boolean));
  }
  return out;
}

const PLAN_SECTION = /^(?:\d+[.)]?\s*)?(?:capabilit(?:y|ies)\b|機能|ケイパビリティ)/i;

// The assignment the checks use: the plan's when it lists capabilities, else the
// archived survey's capabilities.md. `from` names the file for messages.
export function assignment(root) {
  const plan = capabilitySources(readIf(path.join(root, PLAN), []) ?? '', PLAN_SECTION);
  // A plan copied without the indented source items assigns nothing; the survey's list still does.
  if ([...plan.values()].some((paths) => paths.length)) return { map: plan, from: PLAN };
  const survey = archivedChange(root, 'survey');
  const text = survey ? readIf(path.join(survey, 'capabilities.md'), []) : null;
  return { map: capabilitySources(text ?? ''), from: 'capabilities.md of the archived survey' };
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

function unknownListings(map, files, problems, where) {
  for (const [capability, paths] of map) {
    for (const listed of paths) {
      if (!files.some((file) => covers(listed, file))) problems.push(`${where} lists ${listed} under ${capability}, but no source file is there (a typo, or a folder without its trailing "/")`);
    }
  }
}

// Survey review: every kept file belongs to a capability of capabilities.md.
export function checkSurveyCoverage(root, dir, inventory, problems) {
  const files = keptFiles(root, inventory);
  if (!files) return;
  const map = capabilitySources(readIf(path.join(dir, 'capabilities.md'), []) ?? '');
  const unowned = files.filter((file) => ownersOf(map, file).length === 0);
  capped(problems, unowned, (file) => `source file is in no capability of capabilities.md: ${file} (list it, or its folder, under a capability, or mark it excluded in inventory.md)`);
  unknownListings(map, sourceFiles(root) ?? [], problems, 'capabilities.md');
}

// The paths in the first column of the source map's "## Source files" table
// (every table when there is no such heading), so a dependency table is never
// read as files.
export function sourceMapPaths(text) {
  const all = stripComments(text ?? '').split(/\r?\n/);
  const start = all.findIndex((line) => /^##\s+source files\b/i.test(line.trim()));
  let section = all;
  if (start >= 0) {
    const end = all.findIndex((line, i) => i > start && /^#{1,2}\s/.test(line.trim()));
    section = all.slice(start + 1, end < 0 ? all.length : end);
  }
  return tableRows(section.join('\n')).map(([p = '']) => repoPath(p)).filter((p) => p && !/^path$/i.test(p));
}

// Extract review: the source map exists, every path in it exists, and it holds
// every kept file the plan assigns to this capability.
export function checkSourceMap(root, dir, capability, problems) {
  const text = readIf(path.join(dir, 'source-map.md'), problems);
  if (text === null) { problems.push('source-map.md is missing'); return; }
  const listed = sourceMapPaths(text);
  if (listed.length === 0) { problems.push('source-map.md lists no source files ("| Path | Role | In scope |")'); return; }
  for (const p of listed) {
    if (p.split('/').includes('..') || !fs.existsSync(path.join(root, p))) problems.push(`source-map.md lists ${p}, which does not exist`);
  }
  const survey = archivedChange(root, 'survey');
  if (!survey) return;
  const files = keptFiles(root, inventoryRows(readIf(path.join(survey, 'inventory.md'), []) ?? ''));
  if (!files) return;
  const { map, from } = assignment(root);
  const missing = files.filter((file) => ownersOf(map, file).includes(capability) && !listed.some((p) => covers(p, file)));
  capped(problems, missing, (file) => `source file assigned to ${capability} in ${from} is not in source-map.md: ${file} (add it, or move it to the capability it belongs to in ${PLAN})`);
}

const withoutRequirementId = (s) => norm(plain(s).replace(/^R\d+\s*[.:)-]?\s*/i, ''));

// Extract and amend review: every requirement has a trace row whose source
// references open existing files.
export function checkTrace(root, dir, requirements, problems) {
  if (requirements.length === 0) return;
  const text = readIf(path.join(dir, 'trace.md'), problems);
  if (text === null) { problems.push('trace.md is missing'); return; }
  const rows = new Map();
  for (const [name = '', source = ''] of tableRows(text)) {
    const key = withoutRequirementId(name);
    if (key && !rows.has(key)) rows.set(key, source.replace(/\\\|/g, '|'));
  }
  for (const name of requirements) {
    const source = rows.get(norm(name));
    if (source === undefined) { problems.push(`requirement has no trace row: "${name}"`); continue; }
    const refs = parseRefs(source);
    if (refs.length === 0) { problems.push(`the trace row of "${name}" names no source location (path:symbol:lines)`); continue; }
    for (const ref of refs) {
      const file = repoPath(ref.file);
      if (file.split('/').includes('..') || !fs.existsSync(path.join(root, file))) problems.push(`the trace of "${name}" points to ${file}, which does not exist`);
    }
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
  const { map, from } = assignment(root);
  const unowned = files.filter((file) => ownersOf(map, file).length === 0);
  capped(problems, unowned, (file) => `source file is in no capability of ${from}: ${file} (list it under its capability, or have the person exclude it)`);
  const uninventoried = all.filter((file) => contextOf(inventory, file) === null);
  capped(problems, uninventoried, (file) => `source file is not in the archived inventory (added after the survey?): ${file}`);
  unknownListings(map, all, problems, from);
  const pending = [];
  let analyzed = 0;
  for (const capability of map.keys()) {
    const owned = files.filter((file) => ownersOf(map, file).includes(capability));
    const change = extractChange(root, capability);
    if (!change) { pending.push(capability); continue; }
    analyzed += 1;
    const listed = sourceMapPaths(readIf(path.join(change, 'source-map.md'), []) ?? '');
    const missing = owned.filter((file) => !listed.some((p) => covers(p, file)));
    capped(problems, missing, (file) => `source file assigned to ${capability} is not in the source map of ${path.basename(change)}: ${file}`);
  }
  return { ok: problems.length === 0, problems, files: files.length, capabilities: { analyzed, pending } };
}
