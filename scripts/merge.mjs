#!/usr/bin/env node
// Merges the table rows that parallel subagents wrote into part files into one
// artifact table, so the orchestrator never has to read and copy them itself.
//
//   node merge.mjs --into <artifact.md> --parts <file-or-folder> [--parts ...] [--clean] [--root DIR]
//
// Used for the survey's inventory.md (rows keyed by path) and for crosscheck.md
// (a table whose first column is `Item`, rows keyed by R<n> / S<n>).
// - --into is an artifact of an active change: openspec/changes/<change>/<name>.md,
//   never review.md. When it does not exist yet, it starts from the change
//   schema's template of the same name. Its first table keeps its header and the
//   text around it.
// - --parts are files or folders under openspec/spec-relay/work/. A folder means
//   every .md file directly in it, in name order with numbers compared as
//   numbers (02 < 02-recheck < 10), so a later file wins. Every table in a part
//   is read; its header must match the artifact's.
// - A part row replaces the row with the same key and adds new keys; rows are
//   sorted by key. One R<n> or S<n> with two different names is a problem (the
//   numbering moved), not a replacement.
// - Extra cells in a row (an unescaped `|` in the last cell) are kept in the
//   last cell, escaped.
// - --clean deletes the part files that were merged, and folders left empty.
//
// Prints { ok, into, rows, added, replaced, parts, problems } as JSON; exits 0
// when ok, 1 when something could not be used (nothing is written or deleted
// then), 2 on bad usage. Files may use CRLF line endings and a UTF-8 BOM;
// UTF-16 files are rejected.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readIf, changeSchema, plain, norm } from './gate.mjs';

const SEPARATOR = /^\s*\|?\s*:?-{2,}/;
const cellsOf = (line) => line.trim().replace(/^\|/, '').replace(/\|$/, '').split(/(?<!\\)\|/).map((c) => c.trim());
const visible = (cell) => cell.replace(/<!--[\s\S]*?-->/g, '').trim();
const ID = /^([RS])(\d+)\b\s*[.:)-]?\s*(.*)$/i;
const WORK = 'openspec/spec-relay/work';
const collator = new Intl.Collator('en', { numeric: true });

// Every table in the text, outside code fences: where it starts and ends (line
// indexes), its header cells and its row lines.
export function tables(lines) {
  const found = [];
  let fenced = false;
  for (let i = 0; i < lines.length - 1; i += 1) {
    if (/^\s*(```|~~~)/.test(lines[i])) { fenced = !fenced; continue; }
    if (fenced || !/^\s*\|/.test(lines[i]) || !SEPARATOR.test(lines[i + 1])) continue;
    let end = i + 2;
    while (end < lines.length && /^\s*\|/.test(lines[end])) end += 1;
    found.push({ start: i, end, header: lines[i].trim(), separator: lines[i + 1].trim(), names: cellsOf(lines[i]).map(norm), rows: lines.slice(i + 2, end).map((l) => l.trim()) });
    i = end - 1;
  }
  return found;
}

// Rows of a crosscheck table (first column `Item`) are keyed by R<n> / S<n>, so a
// recheck that changes the evidence replaces the row; other tables by their
// first cell read as a path (forward slashes, no leading ./).
export function rowKey(line, byId) {
  const cell = visible(cellsOf(line)[0] ?? '');
  const id = byId ? plain(cell).match(ID) : null;
  if (id) return { key: `${id[1].toUpperCase()}${Number(id[2])}`, name: norm(id[3]) };
  // Paths keep every character (my_module.php, [id].tsx, (shop)/page.tsx), as gate.mjs reads them.
  return { key: cell.replace(/^`(.*)`$/, '$1').trim().replace(/\\/g, '/').replace(/^(\.\/)+/, ''), name: null };
}

const isPlaceholder = (line) => cellsOf(line).every((c) => visible(c) === '');

export function compareKeys(a, b) {
  const x = a.match(/^([RS])(\d+)$/), y = b.match(/^([RS])(\d+)$/);
  if (x && y) return x[1] === y[1] ? Number(x[2]) - Number(y[2]) : (x[1] < y[1] ? -1 : 1);
  if (x || y) return x ? -1 : 1;
  return a < b ? -1 : a > b ? 1 : 0;
}

// `rel` of `file` inside `dir`, or null when it is not strictly inside.
function inside(dir, file) {
  const rel = path.relative(path.resolve(dir), path.resolve(file));
  return rel === '' || rel === '..' || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel) ? null : rel;
}

function partFiles(root, entry, problems) {
  const full = path.resolve(root, entry);
  let stat;
  try { stat = fs.statSync(full); } catch { problems.push(`part not found: ${entry}`); return []; }
  if (stat.isFile()) return [full];
  return fs.readdirSync(full, { withFileTypes: true })
    .filter((e) => e.isFile() && e.name.toLowerCase().endsWith('.md'))
    .map((e) => e.name)
    .sort((a, b) => collator.compare(a.replace(/\.md$/i, ''), b.replace(/\.md$/i, '')))
    .map((name) => path.join(full, name));
}

// The row with its cells fitted to the table: surplus cells (an unescaped `|`
// in the last cell) are joined back into the last one.
function fitted(row, columns) {
  const raw = row.trim().replace(/^\|/, '').replace(/\|$/, '').split(/(?<!\\)\|/);
  if (raw.length <= columns) return { row, ok: raw.length === columns };
  const last = raw.slice(columns - 1).join('|').replace(/(?<!\\)\|/g, '\\|').trim();
  return { row: `| ${[...raw.slice(0, columns - 1).map((c) => c.trim()), last].join(' | ')} |`, ok: true };
}

function checkPaths(root, into, parts) {
  const problems = [];
  const rel = inside(path.join(root, 'openspec/changes'), path.resolve(root, into));
  const segs = rel ? rel.split(path.sep) : [];
  if (segs.length !== 2 || segs[0] === 'archive' || !segs[1].toLowerCase().endsWith('.md') || segs[1].toLowerCase() === 'review.md') {
    problems.push(`--into must be an artifact of an active change, openspec/changes/<change>/<name>.md (not review.md): ${into}`);
  } else if (!fs.existsSync(path.join(root, 'openspec/changes', segs[0]))) {
    problems.push(`no active change ${segs[0]}: create it with "openspec new change" first`);
  } else if (fs.existsSync(path.resolve(root, into)) && !fs.statSync(path.resolve(root, into)).isFile()) {
    problems.push(`--into is a folder: ${into}`);
  }
  for (const entry of parts) {
    if (!inside(path.join(root, WORK), path.resolve(root, entry))) problems.push(`--parts must be under ${WORK}/: ${entry}`);
  }
  return problems;
}

function templateFor(root, into) {
  const schema = changeSchema(path.dirname(path.resolve(root, into)));
  return readIf(path.join(root, 'openspec/schemas', schema, 'templates', path.basename(into)), []);
}

export function merge(root, { into, parts, clean = false }) {
  let problems = checkPaths(root, into, parts);
  if (problems.length) return { ok: false, problems };

  const target = path.resolve(root, into);
  const existing = readIf(target, problems);
  const base = existing ?? templateFor(root, into) ?? '';
  const eol = /\r\n/.test(base) ? '\r\n' : '\n';
  const lines = base.split(/\r?\n/);
  let table = tables(lines)[0] ?? null;

  const files = parts.flatMap((entry) => partFiles(root, entry, problems));
  if (files.length === 0 && problems.length === 0) problems.push('no part files to merge');
  const show = (f) => path.relative(root, f).split(path.sep).join('/');
  const incoming = [];
  for (const file of files) {
    const before = problems.length;
    const text = readIf(file, problems);
    if (problems.length > before) continue;
    const found = tables((text ?? '').split(/\r?\n/));
    if (found.length === 0) { problems.push(`${show(file)} has no Markdown table`); continue; }
    for (const part of found) {
      if (!table) table = { start: lines.length, end: lines.length, header: part.header, separator: part.separator, names: part.names, rows: [] };
      if (part.names.join('|') !== table.names.join('|')) { problems.push(`${show(file)}: table header ${part.header} differs from ${table.header}`); continue; }
      for (const raw of part.rows) {
        if (isPlaceholder(raw)) continue;
        const { row, ok } = fitted(raw, table.names.length);
        if (!ok) { problems.push(`${show(file)}: row has ${cellsOf(raw).length} cells, the table has ${table.names.length}: ${raw}`); continue; }
        incoming.push({ row, file });
      }
    }
  }
  if (problems.length) return { ok: false, problems };

  const byId = table.names[0] === 'item' || path.basename(into).toLowerCase() === 'crosscheck.md';
  const rows = new Map();
  const claim = (row, where) => {
    const { key, name } = rowKey(row, byId);
    if (!key) { problems.push(`${where}: row has an empty first cell: ${row}`); return null; }
    const old = rows.get(key);
    if (old && name && old.name && old.name !== name) {
      problems.push(`${where}: ${key} names "${plain(visible(cellsOf(row)[0]))}", but ${old.where} names it "${plain(visible(cellsOf(old.row)[0]))}"; renumber the items or fix the name; if the name was changed on purpose, delete the old row from ${old.where === path.basename(into) ? into : old.where} and merge again`);
      return null;
    }
    return { key, name, old };
  };
  for (const row of table.rows) {
    if (isPlaceholder(row)) continue;
    const c = claim(row, path.basename(into));
    if (c) rows.set(c.key, { row, name: c.name, where: path.basename(into) });
  }
  let added = 0, replaced = 0;
  for (const { row, file } of incoming) {
    const c = claim(row, show(file));
    if (!c) continue;
    if (c.old) replaced += 1; else added += 1;
    rows.set(c.key, { row, name: c.name, where: show(file) });
  }
  if (problems.length) return { ok: false, problems };

  const sorted = [...rows.keys()].sort(compareKeys).map((key) => rows.get(key).row);
  const head = lines.slice(0, table.start);
  if (table.start === lines.length) {
    while (head.length && head.at(-1).trim() === '') head.pop();
    if (head.length) head.push('');
  }
  const out = [...head, table.header, table.separator, ...sorted, ...lines.slice(table.end)];
  let text = out.join(eol);
  if (!text.endsWith(eol)) text += eol;
  try {
    fs.writeFileSync(target, text, 'utf8');
  } catch (e) {
    return { ok: false, problems: [`could not write ${into}: ${e.message}`] };
  }

  if (clean) {
    for (const file of files) fs.rmSync(file, { force: true });
    for (const entry of parts) {
      const dir = path.resolve(root, entry);
      try { if (fs.statSync(dir).isDirectory() && fs.readdirSync(dir).length === 0) fs.rmdirSync(dir); } catch { /* already gone */ }
    }
  }
  problems = [];
  return { ok: true, into: show(target), rows: sorted.length, added, replaced, parts: files.map(show), ...(clean ? { cleaned: true } : {}), problems };
}

export function main(argv) {
  const opts = { root: process.cwd(), parts: [], clean: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--clean') { opts.clean = true; continue; }
    const value = argv[i + 1];
    if (value === undefined || value.startsWith('--')) return usage();
    if (arg === '--into') opts.into = value;
    else if (arg === '--parts') opts.parts.push(value);
    else if (arg === '--root') opts.root = value;
    else return usage();
    i += 1;
  }
  if (!opts.into || opts.parts.length === 0) return usage();
  if (!fs.existsSync(path.join(opts.root, 'openspec'))) {
    console.error(`merge: no openspec/ folder in ${path.resolve(opts.root)}. Run this from the repository root or pass --root DIR.`);
    return 2;
  }
  const result = merge(opts.root, opts);
  console.log(JSON.stringify(result, null, 2));
  return result.ok ? 0 : 1;
}

function usage() {
  console.error('Usage: node merge.mjs --into openspec/changes/CHANGE/FILE.md --parts openspec/spec-relay/work/... [--parts ...] [--clean] [--root DIR]');
  return 2;
}

function invokedDirectly() {
  if (!process.argv[1]) return false;
  try { return fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url)); } catch { return false; }
}

if (invokedDirectly()) process.exitCode = main(process.argv.slice(2));
