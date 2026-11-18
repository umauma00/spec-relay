#!/usr/bin/env node
// Level B1 of a port: compares what the source program did with what the new
// code does, case by case.
//
//   node compare.mjs --cases DIR (--driver "COMMAND" | --actual FILE)
//                    [--cwd DIR] [--timeout-minutes N]
//
// In a port's design.md the B1 command is written without the kit's path:
//   spec-relay-compare --cases tests/golden/<capability> --driver "<command>"
// and verify.mjs runs it with this script, in the target root.
//
// The cases: every `*.jsonl` file under DIR (sorted by path), one case per
// line: {"id": "...", "input": <any JSON>, "expected": <any JSON>}; "note" and
// other keys are kept for people and ignored here. They are recorded from the
// source program (a recorder the port writes for the old code, or records
// brought in from production: batch input and output, report data), never
// written by hand from the new code. DIR may hold rules.json:
//   { "ignore": ["$.createdAt", "$.lines[*].id"],  paths left out of the comparison
//     "tolerance": 0.005,                         numbers may differ by this much
//     "numbersAsText": false,                     "12.50" equals 12.5
//     "trim": false,                              strings compare without outer spaces
//     "unordered": ["$.lines"],                   arrays whose order does not matter
//     "missingIsNull": false }                    a missing key equals null
// A path is `$` and then `.name`, `[n]`, `[*]` or `.*`. Every rule loosens the
// comparison, so the port's design.md says why under Decisions.
//
// The driver: one command in the target language that reads the cases from
// stdin, one `{"id": "...", "input": ...}` line each, runs each input through the
// new code and writes one `{"id": "...", "output": ...}` line per case to stdout
// (anything else goes to stderr). With --actual FILE, the outputs are read from
// that JSONL file instead (written by the new code some other way).
//
// Prints a summary and the first differences (paths and short values), and
// exits 0 when every case matches, 1 when one differs or nothing could be
// compared, 2 on bad usage. The output can show recorded data: keep personal
// data out of the cases (docs/COMPARE.md).
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runCommand, MAX_TIMEOUT_MS, stopAllOnSignal } from './run.mjs';
import { chainProblem } from './gate.mjs';

export const COMPARE_COMMAND = 'spec-relay-compare';
const RULE_KEYS = ['ignore', 'tolerance', 'numbersAsText', 'trim', 'unordered', 'missingIsNull'];
const SHOW_CASES = 20;
const SHOW_DIFFS = 5;
const DIFFS_PER_CASE = 50;
const NUMBER = /^\s*-?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?\s*$/;

// Splits a command line into words; "..." and '...' keep spaces (no escapes,
// so Windows paths keep their backslashes).
export function words(line) {
  const out = [];
  let word = null;
  let quote = null;
  for (const c of line) {
    if (quote) { if (c === quote) quote = null; else word += c; continue; }
    if (c === '"' || c === "'") { quote = c; word ??= ''; continue; }
    if (/\s/.test(c)) { if (word !== null) out.push(word); word = null; continue; }
    word = (word ?? '') + c;
  }
  if (quote) return null;
  if (word !== null) out.push(word);
  return out;
}

export const isCompareCommand = (command) => new RegExp(`^\\s*${COMPARE_COMMAND}(\\s|$)`).test(command);

// The options of a compare command line or argv, or { problem }.
export function parseOptions(argv) {
  const opts = {};
  for (let i = 0; i < argv.length; i += 2) {
    const key = { '--cases': 'cases', '--driver': 'driver', '--actual': 'actual', '--cwd': 'cwd', '--timeout-minutes': 'timeout' }[argv[i]];
    if (!key || argv[i + 1] === undefined) return { problem: `unknown or incomplete option ${argv[i]}` };
    opts[key] = argv[i + 1];
  }
  if (!opts.cases) return { problem: 'no --cases folder' };
  if (!opts.driver === !opts.actual) return { problem: 'give one of --driver "<command>" and --actual <file>' };
  const chained = opts.driver ? chainProblem(opts.driver) : null;
  if (chained) return { problem: `the driver ${chained}` };
  if (opts.timeout !== undefined && !(Number(opts.timeout) > 0 && Number(opts.timeout) * 60000 <= MAX_TIMEOUT_MS)) return { problem: `--timeout-minutes ${opts.timeout} is not a number of minutes` };
  return opts;
}

// --- paths ------------------------------------------------------------------

// A rule path as segments: a string key, a number index, or '*'.
export function parsePath(text) {
  if (typeof text !== 'string' || !text.startsWith('$')) return null;
  const segments = [];
  let rest = text.slice(1);
  while (rest) {
    let m;
    if ((m = rest.match(/^\.\*/))) segments.push('*');
    else if ((m = rest.match(/^\[\*\]/))) segments.push('*');
    else if ((m = rest.match(/^\[(\d+)\]/))) segments.push(Number(m[1]));
    else if ((m = rest.match(/^\.([^.[\]]+)/))) segments.push(m[1]);
    else return null;
    rest = rest.slice(m[0].length);
  }
  return segments;
}

const matches = (pattern, at) => pattern.length === at.length && pattern.every((p, i) => p === '*' || p === at[i]);
const show = (at) => `$${at.map((s) => (typeof s === 'number' ? `[${s}]` : /^[A-Za-z_$][\w$]*$/.test(s) ? `.${s}` : `[${JSON.stringify(s)}]`)).join('')}`;

// --- rules ------------------------------------------------------------------

export function readRules(text, problems) {
  // text: the rules in force, one short line each, for the person.
  const rules = { ignore: [], tolerance: 0, numbersAsText: false, trim: false, unordered: [], missingIsNull: false, text: [], byKey: true };
  if (text === null) return rules;
  let raw;
  try { raw = JSON.parse(text); } catch (error) { problems.push(`rules.json is not JSON: ${error.message}`); return rules; }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) { problems.push('rules.json must be one JSON object'); return rules; }
  for (const key of Object.keys(raw).filter((k) => !RULE_KEYS.includes(k))) problems.push(`rules.json has the unknown rule "${key}" (rules: ${RULE_KEYS.join(', ')})`);
  for (const key of ['ignore', 'unordered']) {
    if (raw[key] === undefined) continue;
    if (!Array.isArray(raw[key])) { problems.push(`rules.json "${key}" must be a list of paths`); continue; }
    for (const p of raw[key]) {
      const parsed = parsePath(p);
      if (!parsed) problems.push(`rules.json "${key}" has the path ${JSON.stringify(p)}; write $ then .name, [n], [*] or .*`);
      // Ignoring the whole output, or every top-level part of it, would switch the comparison off.
      else if (key === 'ignore' && (parsed.length === 0 || parsed.every((seg) => seg === '*'))) problems.push(`rules.json "ignore" has ${p}, which leaves nothing to compare; name the parts to leave out`);
      else { rules[key].push(parsed); rules.text.push(`${key} ${p}`); }
    }
  }
  if (raw.tolerance !== undefined) {
    if (typeof raw.tolerance !== 'number' || !Number.isFinite(raw.tolerance) || raw.tolerance < 0) problems.push('rules.json "tolerance" must be a finite number of 0 or more');
    else { rules.tolerance = raw.tolerance; if (raw.tolerance > 0) rules.text.push(`tolerance ${raw.tolerance}`); }
  }
  for (const key of ['numbersAsText', 'trim', 'missingIsNull']) {
    if (raw[key] === undefined) continue;
    if (typeof raw[key] !== 'boolean') problems.push(`rules.json "${key}" must be true or false`);
    else { rules[key] = raw[key]; if (raw[key]) rules.text.push(key); }
  }
  // Pairing unordered items by their text is safe only while no rule names a
  // fixed index, since the text is made as if every item stood at index 0.
  rules.byKey = ![...rules.ignore, ...rules.unordered].some((p) => p.some((seg) => typeof seg === 'number'));
  return rules;
}

// --- comparing --------------------------------------------------------------

const kind = (v) => (v === null ? 'null' : Array.isArray(v) ? 'array' : typeof v);
const brief = (v) => {
  if (v === undefined) return '(missing)';
  const s = JSON.stringify(v);
  return s.length > 80 ? `${s.slice(0, 77)}...` : s;
};

const trimmed = (value, rules) => (rules.trim && typeof value === 'string' ? value.trim() : value);
// numbersAsText reads a numeric string as a number only against a number:
// two strings still compare as text ("0123" is not "123").
const asNumber = (value, other, rules) => (rules.numbersAsText && typeof value === 'string' && typeof other === 'number' && NUMBER.test(value) ? Number(value) : value);
const own = (object, key) => (Object.hasOwn(object, key) ? object[key] : undefined);

// Equal numbers: integers exactly, other numbers within a few units of the last
// place (0.1 + 0.2 is 0.3), and within the tolerance rule.
function sameNumber(e, a, rules) {
  if (Math.abs(e - a) <= rules.tolerance) return true;
  if (Number.isInteger(e) && Number.isInteger(a)) return e === a;
  return Math.abs(e - a) <= 4 * Number.EPSILON * Math.max(Math.abs(e), Math.abs(a));
}

// The differences between an expected and an actual value: [{ path, expected, actual }].
export function differences(expected, actual, rules, at = [], out = []) {
  if (out.length >= DIFFS_PER_CASE) return out;
  if (rules.ignore.some((p) => matches(p, at))) return out;
  let e = trimmed(expected, rules);
  let a = trimmed(actual, rules);
  [e, a] = [asNumber(e, a, rules), asNumber(a, e, rules)];
  const diff = (what) => { out.push({ path: show(at), expected: brief(expected), actual: brief(actual), ...(what ? { what } : {}) }); return out; };
  if (e === undefined || a === undefined) {
    if (rules.missingIsNull && (e ?? null) === null && (a ?? null) === null) return out;
    return diff();
  }
  if (kind(e) !== kind(a)) return diff(`${kind(e)} vs ${kind(a)}`);
  if (typeof e === 'number') {
    return sameNumber(e, a, rules) ? out : diff();
  }
  if (Array.isArray(e)) {
    if (rules.unordered.some((p) => matches(p, at))) {
      if (e.length !== a.length) return diff(`${e.length} items vs ${a.length}`);
      // Items that are the same after the rules pair up by a key at once (a
      // batch can have tens of thousands of rows); the rest are tried one by one.
      const keys = new Map();
      const used = new Set();
      const rest = [];
      if (rules.byKey) {
        a.forEach((item, j) => { const k = canonical(item, rules, [...at, 0]); if (!keys.has(k)) keys.set(k, []); keys.get(k).push(j); });
        e.forEach((item, i) => {
          const free = keys.get(canonical(item, rules, [...at, 0]));
          if (free?.length) used.add(free.shift()); else rest.push(i);
        });
      } else rest.push(...e.keys());
      const left = a.map((_, j) => j).filter((j) => !used.has(j));
      for (const i of rest) {
        const k = left.findIndex((j) => differences(e[i], a[j], rules, [...at, i]).length === 0);
        if (k < 0) out.push({ path: show([...at, i]), expected: brief(e[i]), actual: '(no matching item)' });
        else left.splice(k, 1);
      }
      return out;
    }
    if (e.length !== a.length) diff(`${e.length} items vs ${a.length}`);
    for (let i = 0; i < Math.min(e.length, a.length); i += 1) differences(e[i], a[i], rules, [...at, i], out);
    return out;
  }
  if (kind(e) === 'object') {
    for (const key of new Set([...Object.keys(e), ...Object.keys(a)])) differences(own(e, key), own(a, key), rules, [...at, key], out);
    return out;
  }
  return e === a ? out : diff();
}

// A value as text after the rules that do not need the other side (ignored
// paths, trimming, unordered arrays, missing as null): two values with the same
// text compare equal. Items of an array all stand at index 0 here, so a rule
// with [n] for a fixed index is left to the item-by-item comparison.
function canonical(value, rules, at) {
  if (rules.ignore.some((p) => matches(p, at))) return '~';
  const v = trimmed(value, rules);
  if (Array.isArray(v)) {
    const items = v.map((item) => canonical(item, rules, [...at, 0]));
    if (rules.unordered.some((p) => matches(p, at))) items.sort();
    return `[${items.join(',')}]`;
  }
  if (v && typeof v === 'object') {
    const keys = Object.keys(v).filter((k) => !(rules.missingIsNull && v[k] === null)).sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${canonical(v[k], rules, [...at, k])}`).join(',')}}`;
  }
  return JSON.stringify(v);
}

// --- files ------------------------------------------------------------------

// Files under dir (sorted by path) whose name ends with the suffix.
function listFiles(dir, suffix) {
  const out = [];
  const walk = (d) => {
    for (const entry of fs.readdirSync(d, { withFileTypes: true }).sort((x, y) => (x.name < y.name ? -1 : x.name > y.name ? 1 : 0))) {
      const full = path.join(d, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile() && entry.name.toLowerCase().endsWith(suffix)) out.push(full);
    }
  };
  walk(dir);
  return out;
}
const listCases = (dir) => listFiles(dir, '.jsonl');

const UTF8 = new TextDecoder('utf-8', { fatal: true });

// Bytes as UTF-8 text (a BOM and CRLF are dropped), or null with a problem:
// text in another encoding must not compare as replacement characters.
export function decode(bytes, label, problems) {
  if ((bytes[0] === 0xff && bytes[1] === 0xfe) || (bytes[0] === 0xfe && bytes[1] === 0xff)) { problems.push(`${label} is UTF-16; write it as UTF-8 (in Windows PowerShell 5.1, > writes UTF-16)`); return null; }
  try { return UTF8.decode(bytes).replace(/^﻿/, '').replace(/\r\n/g, '\n'); } catch {
    problems.push(`${label} is not UTF-8 (Shift_JIS or another code page?); write it as UTF-8`);
    return null;
  }
}

const text = (file, label, problems) => decode(fs.readFileSync(file), label, problems);

// Reads JSONL lines into objects; a line that is not a JSON object is a problem.
function jsonLines(content, label, problems) {
  const out = [];
  content.split('\n').forEach((line, i) => {
    if (!line.trim()) return;
    let value;
    try { value = JSON.parse(line); } catch (error) { problems.push(`${label}:${i + 1} is not JSON (${error.message})`); return; }
    if (!value || typeof value !== 'object' || Array.isArray(value)) { problems.push(`${label}:${i + 1} is not a JSON object`); return; }
    out.push({ value, line: i + 1 });
  });
  return out;
}

// The cases of a folder: { cases: [{ id, input, expected, file, line }], rules, sha256, files }.
export function readCases(dir, problems, root = dir) {
  if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) { problems.push(`the cases folder ${dir} does not exist`); return { cases: [], rules: readRules(null, problems), sha256: null, files: [] }; }
  const files = listCases(dir);
  const hash = crypto.createHash('sha256');
  const cases = [];
  const seen = new Map();
  for (const file of files) {
    const rel = path.relative(root, file).split(path.sep).join('/');
    const content = text(file, rel, problems);
    if (content === null) continue;
    hash.update(`${path.relative(dir, file).split(path.sep).join('/')}\0${content}\0`);
    for (const { value, line } of jsonLines(content, rel, problems)) {
      const where = `${rel}:${line}`;
      if (typeof value.id !== 'string' || !value.id) { problems.push(`${where} has no "id" (a non-empty string)`); continue; }
      if (!('input' in value)) problems.push(`${where} (case ${value.id}) has no "input"`);
      if (!('expected' in value)) { problems.push(`${where} (case ${value.id}) has no "expected"`); continue; }
      if (seen.has(value.id)) { problems.push(`${where}: case ${value.id} is also at ${seen.get(value.id)}`); continue; }
      seen.set(value.id, where);
      cases.push({ id: value.id, input: value.input, expected: value.expected, file: rel, line });
    }
  }
  const rulesFile = path.join(dir, 'rules.json');
  const rulesText = fs.existsSync(rulesFile) ? text(rulesFile, 'rules.json', problems) : null;
  for (const f of listFiles(dir, 'rules.json').filter((f) => f !== rulesFile)) problems.push(`${path.relative(root, f).split(path.sep).join('/')} is not read: only the cases folder's own rules.json counts`);
  if (rulesText !== null) hash.update(`rules.json\0${rulesText}\0`);
  const rules = readRules(rulesText, problems);
  if (files.length === 0) problems.push(`no *.jsonl case files under ${dir}`);
  else if (cases.length === 0 && problems.length === 0) problems.push(`the case files under ${dir} hold no cases`);
  return { cases, rules, sha256: files.length ? hash.digest('hex') : null, files: files.map((f) => path.relative(root, f).split(path.sep).join('/')) };
}

// The outputs a driver wrote (or an --actual file holds), by case id.
export function readOutputs(content, label, problems) {
  const outputs = new Map();
  if (content === null) return outputs;
  for (const { value, line } of jsonLines(content, label, problems)) {
    if (typeof value.id !== 'string' || !value.id) { problems.push(`${label}:${line} has no "id"`); continue; }
    if (!('output' in value)) { problems.push(`${label}:${line} (case ${value.id}) has no "output"`); continue; }
    if (outputs.has(value.id)) { problems.push(`${label}:${line}: case ${value.id} has a second output`); continue; }
    outputs.set(value.id, value.output);
  }
  return outputs;
}

// --- running ----------------------------------------------------------------

// Compares the cases of a folder with the new code's outputs. Resolves to
// { ok, count, passed, failed: [{ id, file, line, diffs }], problems, sha256, seconds, timedOut, driverExit, output }.
export async function compare({ cases: casesDir, driver, actual, cwd = process.cwd(), timeoutMs, run = runCommand }) {
  const started = Date.now();
  const problems = [];
  const dir = path.resolve(cwd, casesDir);
  const { cases, rules, sha256 } = readCases(dir, problems, cwd);
  const rulesText = rules.text;
  const result = (extra = {}) => {
    const failed = extra.failed ?? [];
    const ok = problems.length === 0 && failed.length === 0 && cases.length > 0;
    const passed = cases.length - failed.length - (extra.unrun ?? 0);
    const { unrun, ...rest } = extra;
    return { ok, count: cases.length, passed: Math.max(0, passed), failed, problems, sha256, rules: rulesText, seconds: Math.round((Date.now() - started) / 100) / 10, timedOut: false, ...rest };
  };
  if (problems.length) return result({ unrun: cases.length });
  let outputs;
  let driverOutput;
  if (driver) {
    const input = cases.map((c) => JSON.stringify({ id: c.id, input: c.input })).join('\n') + '\n';
    const ran = await run(driver, cwd, { timeoutMs, input, captureStdout: true });
    if (ran.exitCode !== 0) {
      problems.push(`the driver ${ran.timedOut ? 'timed out' : `failed (exit code ${ran.exitCode})`}: ${driver}`);
      return result({ unrun: cases.length, timedOut: ran.timedOut, driverExit: ran.exitCode, output: ran.output });
    }
    const before = problems.length;
    outputs = readOutputs(decode(ran.stdout ?? Buffer.alloc(0), 'the driver output', problems), 'the driver output', problems);
    // What the driver wrote to stderr helps with output it could not read.
    if (problems.length > before) driverOutput = ran.output;
  } else {
    const file = path.resolve(cwd, actual);
    if (!fs.existsSync(file) || !fs.statSync(file).isFile()) { problems.push(`the --actual file ${actual} does not exist`); return result({ unrun: cases.length }); }
    outputs = readOutputs(decode(fs.readFileSync(file), actual, problems), actual, problems);
  }
  const ids = new Set(cases.map((c) => c.id));
  for (const id of outputs.keys()) if (!ids.has(id)) problems.push(`an output names the case ${id}, which no case file has`);
  const failed = [];
  let missing = 0;
  for (const c of cases) {
    if (!outputs.has(c.id)) { missing += 1; if (missing <= SHOW_CASES) problems.push(`no output for case ${c.id} (${c.file}:${c.line})`); continue; }
    const diffs = differences(c.expected, outputs.get(c.id), rules);
    if (diffs.length) failed.push({ id: c.id, file: c.file, line: c.line, diffs });
  }
  if (missing > SHOW_CASES) problems.push(`...and ${missing - SHOW_CASES} more cases without output`);
  return result({ failed, unrun: missing, ...(driverOutput ? { output: driverOutput } : {}) });
}

// The report a person or verify.mjs prints.
export function report(r) {
  const lines = [`compare: ${r.count} cases, ${r.passed} match${r.failed.length ? `, ${r.failed.length} differ` : ''}${r.problems.length ? `, ${r.problems.length} problems` : ''}`];
  if (r.rules?.length) lines.push(`rules: ${r.rules.join('; ')}`);
  for (const p of r.problems.slice(0, SHOW_CASES)) lines.push(`problem: ${p}`);
  for (const f of r.failed.slice(0, SHOW_CASES)) {
    lines.push(`case ${f.id} (${f.file}:${f.line}):`);
    for (const d of f.diffs.slice(0, SHOW_DIFFS)) lines.push(`  ${d.path}: expected ${d.expected}, got ${d.actual}${d.what ? ` (${d.what})` : ''}`);
    if (f.diffs.length > SHOW_DIFFS) lines.push(`  ...and ${f.diffs.length - SHOW_DIFFS} more differences`);
  }
  if (r.failed.length > SHOW_CASES) lines.push(`...and ${r.failed.length - SHOW_CASES} more cases differ`);
  if (r.output) lines.push('driver output (last lines):', r.output.replace(/\s+$/, '').split(/\r?\n/).slice(-20).join('\n'));
  return lines.join('\n');
}

// What a port's command may not use: --cwd (it runs in the target root), and
// --actual (a file of outputs proves nothing about the code as it is now;
// only a driver runs the new code during the verify run).
export function portOptionProblem(opts) {
  if (opts.cwd) return '--cwd is not allowed in a port command; it runs in the target root';
  if (opts.actual) return '--actual is not allowed in a port command: give a --driver that runs the new code, so the verify run compares the code as it is now';
  return null;
}

// Runs a `spec-relay-compare ...` command line in cwd, as verify.mjs does for
// a level: { exitCode, timedOut, seconds, output, cases: { count, sha256 } }.
export async function runCompareCommand(command, cwd, { timeoutMs, run } = {}) {
  const argv = words(command.trim().slice(COMPARE_COMMAND.length));
  const opts = argv ? parseOptions(argv) : { problem: 'an unclosed quote' };
  if (opts.problem) return { exitCode: 2, timedOut: false, seconds: 0, output: `compare: ${opts.problem} in: ${command}` };
  const refused = portOptionProblem(opts);
  if (refused) return { exitCode: 2, timedOut: false, seconds: 0, output: `compare: ${refused}` };
  const r = await compare({ ...opts, cwd, timeoutMs: opts.timeout ? Number(opts.timeout) * 60000 : timeoutMs, ...(run ? { run } : {}) });
  return { exitCode: r.ok ? 0 : r.timedOut ? -1 : 1, timedOut: r.timedOut, seconds: r.seconds, output: report(r), cases: { count: r.count, passed: r.passed, sha256: r.sha256, rules: r.rules } };
}

export async function main(argv) {
  const opts = parseOptions(argv);
  if (opts.problem) {
    console.error(`compare: ${opts.problem}`);
    console.error('Usage: node compare.mjs --cases DIR (--driver "COMMAND" | --actual FILE) [--cwd DIR] [--timeout-minutes N]');
    return 2;
  }
  stopAllOnSignal();
  const r = await compare({ ...opts, cwd: path.resolve(opts.cwd ?? process.cwd()), timeoutMs: opts.timeout ? Number(opts.timeout) * 60000 : undefined });
  console.log(report(r));
  return r.ok ? 0 : 1;
}

function invokedDirectly() {
  if (!process.argv[1]) return false;
  try { return fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url)); } catch { return false; }
}

if (invokedDirectly()) Promise.resolve(main(process.argv.slice(2))).then((code) => { process.exitCode = code; });
