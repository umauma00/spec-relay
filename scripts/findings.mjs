#!/usr/bin/env node
// Every open finding of one change in one list, so that one fix task gets them
// all at once instead of one task per row. The checks of a change (crosscheck,
// omission check, walkthrough, consistency) and the person's change requests
// each find things to correct; fixing them one by one costs a subagent round
// (an analyst, then a checker) for each, while one analyst that fixes them all
// and one recheck wave give the same result in two rounds.
//
//   node findings.mjs --change <change> [--write] [--root DIR]
//
// Reads the change's crosscheck.md (rows not confirmed and not a question),
// coverage.md (gap, and rows without a verdict that holds), walkthrough.md (gap
// and vague), the consistency ledger (an extract's links with a conflict,
// duplicate, term or unclear row; questions are the person's) and review.md
// (fix: lines not answered by a fixed: line). It also counts the consistency
// links that need a checker again (no row, or a row checked on other specs).
// Never the analysts' notes.
//
// --write puts the list in openspec/spec-relay/work/<change>/findings/<n>.md
// (the next free number), the file a fix task names, and prints its path
// instead of the list; without it nothing is written. Prints { ok, change,
// counts, total, findings | file, recheck } as JSON; ok is false only when the change does not exist. Exit code 0, 1 when
// the change is missing, 2 on bad usage.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readIf, tableRows, plain, changeSchema, reviewRemarks, REMARK } from './gate.mjs';
import { readLedger } from './sites.mjs';
import { walkthroughRows } from './walkthrough.mjs';
import { items as consistencyItems, ledgerRows, pairKey, topicKey, LEDGER } from './consistency.mjs';

const WORK = 'openspec/spec-relay/work';
const stripComments = (text) => String(text ?? '').replace(/<!--[\s\S]*?-->/g, '').trim();
// A verdict that holds as the gate reads it: the whole cell, not its first word
// ("confirmed, but ..." is not confirmed). A question names its Q id, except in
// the survey, where the person decides the row with C2.
const settled = (cell, survey) => {
  const v = plain(stripComments(cell)).toLowerCase().replace(/[.。]$/, '').trim();
  return v === 'confirmed' || (survey ? v === 'question' : /^question\s*:?\s*q0*\d+$/.test(v));
};

// Crosscheck rows (extract, amend, port: | Item | Verdict | Evidence |; survey:
// | Path | Verdict | Evidence |) that need a correction: not confirmed, and not
// left to the person as a question.
function crosscheckFindings(dir, survey) {
  const text = readIf(path.join(dir, 'crosscheck.md'), []);
  if (text === null) return [];
  return tableRows(text).filter(([item = '']) => stripComments(item)).flatMap(([item = '', verdict = '', evidence = '']) => {
    if (settled(verdict, survey)) return [];
    return [{ from: 'crosscheck', key: stripComments(item), verdict: stripComments(verdict) || 'blank', evidence: stripComments(evidence) }];
  });
}

// Sites judged a gap, or with a verdict the gate cannot read. A site with no row
// is not listed here: it needs a checker first (gate.mjs review names it).
function coverageFindings(root, dir) {
  if (!fs.existsSync(path.join(dir, 'coverage.md'))) return [];
  let rows;
  try { ({ rows } = readLedger(root, dir, [])); } catch { return []; }
  return [...rows.values()].flatMap((row) => (['gap', 'invalid'].includes(row.parsed.kind)
    ? [{ from: 'coverage', key: stripComments(row.site), verdict: stripComments(row.verdict) || 'blank', evidence: stripComments(row.evidence) }]
    : []));
}

function walkthroughFindings(dir) {
  const text = readIf(path.join(dir, 'walkthrough.md'), []);
  if (text === null) return [];
  return walkthroughRows(text).flatMap((row) => (['gap', 'vague', 'invalid', 'blank'].includes(row.parsed.kind)
    ? [{ from: 'walkthrough', key: row.entry, behavior: row.behavior, verdict: stripComments(row.verdict) || 'blank', evidence: row.evidence }]
    : []));
}

// The links of an extract whose row says the two specs disagree. A question
// row is the person's, an accepted one is decided; stale and missing links go
// to `recheck`, since they need a checker, not a correction.
function consistencyFindings(root, change) {
  if (!/^extract-/.test(change)) return { findings: [], recheck: [] };
  let listed;
  try { listed = consistencyItems(root, { change }); } catch { return { findings: [], recheck: [] }; }
  const rows = ledgerRows(readIf(path.join(root, LEDGER), []) ?? '');
  const findings = [];
  const recheck = [];
  for (const link of listed.links ?? []) {
    if (link.status === 'missing' || link.status === 'stale') { recheck.push({ pair: link.pair, topic: link.topic, status: link.status }); continue; }
    if (link.status !== 'open') continue;
    const row = rows.get(`${pairKey(link.pair)}|${topicKey(link.topic)}`);
    const kind = row?.parsed.kind;
    if (['conflict', 'duplicate', 'term', 'unclear'].includes(kind)) {
      findings.push({ from: 'consistency', key: `${link.pair}, ${link.topic}`, verdict: kind, evidence: row.evidence });
    } else if (kind !== 'question' && kind !== 'accepted') {
      // A consistent row whose evidence names no requirement: the checker looks again.
      recheck.push({ pair: link.pair, topic: link.topic, status: 'open' });
    }
  }
  return { findings, recheck };
}

// The notes under each item of review.md, in order, each with the lines indented
// under it (a request the person wrote over several lines).
function notesByItem(text) {
  const lines = String(text ?? '').replace(/<!--[\s\S]*?-->/g, (m) => m.replace(/[^\r\n]/g, ' ')).split(/\r?\n/);
  const items = [];
  let item = null;
  let note = null;
  let fenced = false;
  for (const line of lines) {
    if (/^\s*(```|~~~)/.test(line)) { fenced = !fenced; item = null; note = null; continue; }
    if (fenced) continue;
    const box = line.match(/^\s*(?:[-*+]|\d+[.)])\s+\[.?\]\s*(.*)$/);
    // As reviewRemarks reads them: only a box whose text starts with an id is an item.
    if (box) { item = /^[A-Za-z]\d+\b/.test(plain(box[1])) ? [] : null; if (item) items.push(item); note = null; continue; }
    if (/^#{1,6}\s/.test(line)) { item = null; note = null; continue; }
    if (!item) continue;
    const r = line.match(REMARK);
    if (r) { note = { kind: r[1].toLowerCase(), text: r[2].trim(), indent: line.search(/\S/) }; item.push(note); continue; }
    if (note && line.trim() && line.search(/\S/) > note.indent && !/^\s*(?:[-*+]|\d+[.)])\s/.test(line)) { note.text = `${note.text} ${line.trim()}`.trim(); continue; }
    if (line.trim() && !/^\s/.test(line)) { item = null; note = null; }
  }
  return items;
}

// The person's change requests that no fixed: line answers yet: every fix: after
// the last fixed:, with the lines under each, so none of their words is lost.
function reviewFindings(dir) {
  const text = readIf(path.join(dir, 'review.md'), []);
  if (text === null) return [];
  const items = reviewRemarks(text);
  const notes = notesByItem(text);
  if (notes.length !== items.length) return items.filter((item) => item.openFix).map((item) => ({ from: 'review', key: item.id, verdict: 'fix', evidence: item.remarks.filter((r) => r.kind === 'fix').map((r) => r.text).join(' / ') }));
  return items.flatMap((item, i) => {
    if (!item.openFix) return [];
    const list = notes[i];
    const last = list.map((n) => n.kind).lastIndexOf('fixed');
    return list.slice(last + 1).filter((n) => n.kind === 'fix').map((n) => ({ from: 'review', key: item.id, verdict: 'fix', evidence: n.text }));
  });
}

export function findings(root, change) {
  const dir = path.join(root, 'openspec/changes', change);
  if (!/^[a-z0-9][a-z0-9-]*$/.test(change) || !fs.existsSync(dir)) {
    return { ok: false, change, problems: [`no active change ${change} under openspec/changes/`] };
  }
  const schema = changeSchema(dir);
  const consistency = consistencyFindings(root, change);
  const list = [
    ...crosscheckFindings(dir, schema === 'spec-relay-survey'),
    ...(schema === 'spec-relay-extract' ? coverageFindings(root, dir) : []),
    ...walkthroughFindings(dir),
    ...consistency.findings,
    ...reviewFindings(dir),
  ];
  const counts = {};
  for (const f of list) counts[f.from] = (counts[f.from] ?? 0) + 1;
  // done: nothing to fix and nothing to compare again; run it after the fix task
  // returns, since a fix that changes the spec makes its consistency rows stale.
  return { ok: true, change, schema, counts, total: list.length, done: list.length === 0 && consistency.recheck.length === 0, findings: list, recheck: consistency.recheck };
}

const TITLES = {
  crosscheck: 'Crosscheck (crosscheck.md): the text and the code disagree, or the code does more',
  coverage: 'Omission check (coverage.md): behavior of these sites is in no requirement',
  walkthrough: 'Walkthrough (walkthrough.md): behavior met from an entry point that no scenario states, or states loosely',
  consistency: `Consistency (${LEDGER}): this spec and another capability's disagree where they meet`,
  review: "The person's change requests (fix: lines in review.md)",
};
const cell = (s) => String(s ?? '').replace(/\r?\n/g, ' ').trim();

// The list as the file a fix task reads.
export function findingsText(result, n) {
  const out = [
    `# Findings ${n} for ${result.change}`,
    '',
    'Correct every finding below in one pass, in the files the task names. Add a new requirement',
    'at the END of the spec, so the numbers other rows use stay the same. When you think a finding',
    'is wrong, change nothing for it and say why in your report. Report, per finding, what you changed,',
    'and every requirement or screen you added or renamed.',
    '',
  ];
  for (const from of Object.keys(TITLES)) {
    const group = result.findings.filter((f) => f.from === from);
    if (!group.length) continue;
    out.push(`## ${TITLES[from]}`, '');
    for (const f of group) {
      const what = f.behavior ? ` - ${cell(f.behavior)}` : '';
      out.push(`- \`${cell(f.key).replace(/^`+|`+$/g, '')}\`${what} - **${cell(f.verdict)}**${f.evidence ? `: ${cell(f.evidence)}` : ''}`);
    }
    out.push('');
  }
  return out.join('\n');
}

export function writeFindings(root, result) {
  const dir = path.join(root, WORK, result.change, 'findings');
  fs.mkdirSync(dir, { recursive: true });
  const used = fs.readdirSync(dir).map((f) => f.match(/^(\d+)\.md$/)?.[1]).filter(Boolean).map(Number);
  const n = (used.length ? Math.max(...used) : 0) + 1;
  const file = path.join(dir, `${String(n).padStart(2, '0')}.md`);
  fs.writeFileSync(file, findingsText(result, n), 'utf8');
  return path.relative(root, file).split(path.sep).join('/');
}

export function main(argv) {
  const opts = { root: process.cwd(), write: false };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--write') { opts.write = true; continue; }
    const key = { '--change': 'change', '--root': 'root' }[argv[i]];
    if (!key || argv[i + 1] === undefined) return usage();
    opts[key] = argv[i + 1];
    i += 1;
  }
  if (!opts.change) return usage();
  if (!fs.existsSync(path.join(opts.root, 'openspec'))) {
    console.error(`findings: no openspec/ folder in ${path.resolve(opts.root)}. Run this from the repository root or pass --root DIR.`);
    return 2;
  }
  const result = findings(opts.root, opts.change);
  let out = result;
  // With --write the list is in the file: the orchestrator passes its path on and keeps the counts.
  if (result.ok && opts.write && result.total) { const { findings: _list, ...rest } = result; out = { ...rest, file: writeFindings(opts.root, result) }; }
  console.log(JSON.stringify(out, null, 2));
  return result.ok ? 0 : 1;
}

function usage() {
  console.error('Usage: node findings.mjs --change NAME [--write] [--root DIR]');
  return 2;
}

function invokedDirectly() {
  if (!process.argv[1]) return false;
  try { return fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url)); } catch { return false; }
}

if (invokedDirectly()) process.exitCode = main(process.argv.slice(2));
