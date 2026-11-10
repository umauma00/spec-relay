#!/usr/bin/env node
// Merges the table rows that parallel subagents wrote into part files into one
// artifact table, so the orchestrator never has to read and copy them itself.
//
//   node merge.mjs --into <artifact.md> --parts <file-or-folder> [--parts ...] [--clean] [--root DIR]
//
// Used for the survey's inventory.md (rows keyed by path) and for crosscheck.md
// (rows keyed by R<n> / S<n>). The first table of --into keeps its header and
// the text around it; a part row replaces the row with the same key (the first
// cell, or its R<n> / S<n> id) and adds new keys; rows are sorted by key. When
// --into does not exist yet, it starts from the change schema's template of the
// same name. A folder in --parts means every .md file directly in it, by name,
// so a later file (crosscheck-02-recheck.md) wins over an earlier one.
// --clean deletes the part files that were merged.
//
// Only files under openspec/ are read as parts or written. Prints
// { ok, into, rows, added, replaced, parts, problems } as JSON; exits 0 when ok,
// 1 when a part could not be used (nothing is written then), 2 on bad usage.
// Files may use CRLF line endings and a UTF-8 BOM; UTF-16 files are rejected.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readIf, changeSchema } from './gate.mjs';

const SEPARATOR = /^\s*\|?\s*:?-{2,}/;
const cellsOf = (line) => line.trim().replace(/^\|/, '').replace(/\|$/, '').split(/(?<!\\)\|/).map((c) => c.trim());
const visible = (cell) => cell.replace(/<!--[\s\S]*?-->/g, '').trim();
const ID = /^([RS])(\d+)\b/i;

// The first table in the text: where it starts and ends (line indexes) and its rows.
export function firstTable(lines) {
  let fenced = false;
  for (let i = 0; i < lines.length - 1; i += 1) {
    if (/^\s*(```|~~~)/.test(lines[i])) { fenced = !fenced; continue; }
    if (fenced || !/^\s*\|/.test(lines[i]) || !SEPARATOR.test(lines[i + 1])) continue;
    let end = i + 2;
    while (end < lines.length && /^\s*\|/.test(lines[end])) end += 1;
    return { start: i, end, header: lines[i].trim(), separator: lines[i + 1].trim(), columns: cellsOf(lines[i]).length, rows: lines.slice(i + 2, end).map((l) => l.trim()) };
  }
  return null;
}

// R<n> and S<n> rows are keyed by the id, so a recheck that spells the name a
// little differently still replaces the row. Other rows by their first cell.
export function rowKey(line) {
  const first = visible(cellsOf(line)[0] ?? '').replace(/`/g, '').trim();
  const id = first.match(ID);
  return id ? `${id[1].toUpperCase()}${Number(id[2])}` : first.replace(/\\/g, '/');
}

const isPlaceholder = (line) => cellsOf(line).every((c) => visible(c) === '');

export function compareKeys(a, b) {
  const x = a.match(/^([RS])(\d+)$/), y = b.match(/^([RS])(\d+)$/);
  if (x && y) return x[1] === y[1] ? Number(x[2]) - Number(y[2]) : (x[1] < y[1] ? -1 : 1);
  if (x || y) return x ? -1 : 1;
  return a < b ? -1 : a > b ? 1 : 0;
}

function insideOpenspec(root, file) {
  const rel = path.relative(path.resolve(root, 'openspec'), path.resolve(root, file));
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
}

function partFiles(root, entry, problems) {
  const full = path.resolve(root, entry);
  let stat;
  try { stat = fs.statSync(full); } catch { problems.push(`part not found: ${entry}`); return []; }
  if (stat.isFile()) return [full];
  return fs.readdirSync(full, { withFileTypes: true }).filter((e) => e.isFile() && e.name.toLowerCase().endsWith('.md')).map((e) => path.join(full, e.name)).sort();
}

function templateFor(root, into) {
  const schema = changeSchema(path.dirname(path.resolve(root, into)));
  if (!schema) return null;
  return readIf(path.join(root, 'openspec/schemas', schema, 'templates', path.basename(into)), []);
}

export function merge(root, { into, parts, clean = false }) {
  const problems = [];
  if (!insideOpenspec(root, into)) return { ok: false, problems: [`--into must be a file under openspec/: ${into}`] };
  for (const entry of parts) if (!insideOpenspec(root, entry)) problems.push(`--parts must be under openspec/: ${entry}`);
  if (problems.length) return { ok: false, problems };

  const target = path.resolve(root, into);
  const existing = readIf(target, problems);
  const base = existing ?? templateFor(root, into) ?? '';
  const eol = /\r\n/.test(base) ? '\r\n' : '\n';
  const lines = base.split(/\r?\n/);
  let table = firstTable(lines);

  const files = parts.flatMap((entry) => partFiles(root, entry, problems));
  if (files.length === 0 && problems.length === 0) problems.push('no part files to merge');
  const incoming = [];
  for (const file of files) {
    const text = readIf(file, problems);
    const part = text === null || text === '' ? null : firstTable(text.split(/\r?\n/));
    if (!part) { problems.push(`${path.relative(root, file).split(path.sep).join('/')} has no Markdown table`); continue; }
    if (!table) table = { start: lines.length, end: lines.length, header: part.header, separator: part.separator, columns: part.columns, rows: [] };
    for (const row of part.rows) {
      if (isPlaceholder(row)) continue;
      if (cellsOf(row).length !== table.columns) { problems.push(`${path.basename(file)}: row has ${cellsOf(row).length} cells, the table has ${table.columns}: ${row}`); continue; }
      incoming.push(row);
    }
  }
  if (problems.length) return { ok: false, problems };

  const rows = new Map();
  for (const row of table.rows) if (!isPlaceholder(row)) rows.set(rowKey(row), row);
  let added = 0, replaced = 0;
  for (const row of incoming) {
    const key = rowKey(row);
    if (rows.has(key)) replaced += 1; else added += 1;
    rows.set(key, row);
  }
  const sorted = [...rows.keys()].sort(compareKeys).map((key) => rows.get(key));
  const out = [...lines.slice(0, table.start), table.header, table.separator, ...sorted, ...lines.slice(table.end)];
  if (table.start === lines.length && out[0] === '') out.shift();
  let text = out.join(eol);
  if (!text.endsWith(eol)) text += eol;
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, text, 'utf8');

  const rel = (f) => path.relative(root, f).split(path.sep).join('/');
  if (clean) {
    for (const file of files) fs.rmSync(file, { force: true });
    for (const entry of parts) {
      const dir = path.resolve(root, entry);
      try { if (fs.statSync(dir).isDirectory() && fs.readdirSync(dir).length === 0) fs.rmdirSync(dir); } catch { /* already gone */ }
    }
  }
  return { ok: true, into: rel(target), rows: sorted.length, added, replaced, parts: files.map(rel), ...(clean ? { cleaned: true } : {}), problems: [] };
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
  console.error('Usage: node merge.mjs --into FILE --parts FILE_OR_FOLDER [--parts ...] [--clean] [--root DIR]');
  return 2;
}

function invokedDirectly() {
  if (!process.argv[1]) return false;
  try { return fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url)); } catch { return false; }
}

if (invokedDirectly()) process.exitCode = main(process.argv.slice(2));
