#!/usr/bin/env node
// Migration progress, computed from the files in openspec/ alone, for the host's
// TODO list (Copilot CLI update_todo, VS Code todo) and for chat.
//
//   node status.mjs [--format todo|checklist|markdown|json] [--capability PATH]
//                   [--language ja|en] [--root DIR]
//
//   todo       { todoList: [{ id, title, description, status }], current } for the TODO tool
//   checklist  the same items as a Markdown checklist, for chat and for update_todo
//   markdown   the checklist, then a table of every capability
//   json       everything above and the per-capability details (the default)
//
// The TODO list is a view: it shows one line for the whole migration and the
// steps of the current capability. It never records or grants an approval; the
// review gate is scripts/gate.mjs. Read-only. Exits 0, or 2 on bad usage.
//
// Steps are data (STEPS below), so a new step is one more entry: a label, the
// person or agent who does it, and a function from a capability's files to its state.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkboxes, readIf, capabilitySegments } from './gate.mjs';

const PLAN = 'openspec/spec-relay/plan.md';
const EXTRACT_ARTIFACTS = ['source-map.md', 'trace.md', 'questions.md', 'review.md'];
// Lowercase ASCII kebab-case segments, as the skill asks capabilities to be named.
const CAPABILITY = /^[a-z0-9]+(?:-[a-z0-9]+)*(?:\/[a-z0-9]+(?:-[a-z0-9]+)*)*$/;
const changeKey = (capability) => capability.split('/').join('-');

const WORDS = {
  en: {
    analyze: 'Analyze', review: 'Review', implement: 'Implement',
    overall: (done, total, reviewed) => `Overall: ${done} of ${total} capabilities ported (${reviewed} with a reviewed spec)`,
    noPlan: 'Overall: no capability plan yet',
    allDone: (total) => `Overall: all ${total} capabilities ported`,
    writing: (n, of) => `writing artifacts ${n}/${of}`,
    waitingReview: (n, of) => `waiting for review ${n}/${of}`,
    waitingArchive: 'reviewed; waiting for approval to archive',
    designing: 'writing the design',
    tasks: (n, of) => `tasks ${n}/${of}`,
    waitingPortArchive: 'all tasks done; waiting for agreement to archive',
    current: 'you are here',
    table: ['Capability', 'Analyze', 'Review', 'Implement'],
    done: 'done', notStarted: '-',
    unreadable: 'Unreadable files (save them again as UTF-8)',
  },
  ja: {
    analyze: '解析', review: 'レビュー', implement: '実装',
    overall: (done, total, reviewed) => `全体: ${total}機能のうち${done}機能が移行済み（仕様確定 ${reviewed}）`,
    noPlan: '全体: 機能の計画はまだありません',
    allDone: (total) => `全体: ${total}機能すべて移行済み`,
    writing: (n, of) => `成果物 ${n}/${of}`,
    waitingReview: (n, of) => `レビュー待ち ${n}/${of}`,
    waitingArchive: 'レビュー済み・承認待ち',
    designing: '設計中',
    tasks: (n, of) => `タスク ${n}/${of}`,
    waitingPortArchive: '全タスク完了・完了の確認待ち',
    current: 'いまここ',
    table: ['機能', '解析', 'レビュー', '実装'],
    done: '完了', notStarted: '-',
    unreadable: '読めないファイル（UTF-8 で保存し直してください）',
  },
};

// Each step maps a capability's facts to { status, detail?, waiting? }.
// status is one of the three states every host supports. Work that waits for the
// person stays not-started with the reason in `detail`, so at most one step is
// in progress and a waiting step never looks like the agent is busy with it.
export const STEPS = [
  {
    id: 'analyze', owner: 'agent',
    state: (c) => {
      if (c.baseline && !c.extract) return { status: 'completed' };
      if (!c.extract) return { status: 'not-started' };
      const of = EXTRACT_ARTIFACTS.length + 1;
      const n = c.extract.artifacts.length + (c.extract.specs ? 1 : 0);
      return n === of ? { status: 'completed' } : { status: 'in-progress', detail: ['writing', n, of] };
    },
  },
  {
    id: 'review', owner: 'person',
    state: (c) => {
      if (c.baseline && !c.extract) return { status: 'completed' };
      if (!c.extract || c.extract.artifacts.length + (c.extract.specs ? 1 : 0) < EXTRACT_ARTIFACTS.length + 1) return { status: 'not-started' };
      const { done, total } = c.extract.review;
      return done === total && total > 0
        ? { status: 'not-started', waiting: true, detail: ['waitingArchive'] }
        : { status: 'not-started', waiting: true, detail: ['waitingReview', done, total] };
    },
  },
  {
    id: 'implement', owner: 'agent',
    state: (c) => {
      if (c.portArchived && !c.port) return { status: 'completed' };
      if (!c.port) return { status: 'not-started' };
      if (!c.port.tasks) return { status: 'in-progress', detail: ['designing'] };
      const { done, total } = c.port.tasks;
      return done === total && total > 0
        ? { status: 'not-started', waiting: true, detail: ['waitingPortArchive'] }
        : { status: 'in-progress', detail: ['tasks', done, total] };
    },
  },
];

function dirs(dir) {
  try { return fs.readdirSync(dir, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name); } catch { return []; }
}
const isFile = (file) => { try { return fs.statSync(file).isFile(); } catch { return false; } };

// Capability paths that have a spec.md below `dir` (openspec/specs or a change's specs/).
function specCapabilities(dir, prefix = []) {
  const found = [];
  for (const name of dirs(dir)) {
    const parts = [...prefix, name];
    if (isFile(path.join(dir, name, 'spec.md'))) found.push(parts.join('/'));
    found.push(...specCapabilities(path.join(dir, name), parts));
  }
  return found;
}

// The capability list of the plan: list items under "## Capabilities" (and any
// deeper headings below it, such as one per bounded context) that start with a
// backticked capability path, in order. Other text in the plan is ignored.
export function planCapabilities(text) {
  const list = [];
  let inside = false;
  let group = null;
  let fenced = false;
  for (const line of text.split(/\r?\n/)) {
    if (/^\s*(```|~~~)/.test(line)) { fenced = !fenced; continue; }
    if (fenced) continue;
    const heading = line.match(/^(#{1,6})\s+(.*?)\s*#*\s*$/);
    if (heading) {
      const level = heading[1].length;
      if (level <= 2) { inside = /^capabilities\b/i.test(heading[2]) || /^機能/.test(heading[2]); group = null; }
      else if (inside) group = heading[2];
      continue;
    }
    if (!inside) continue;
    const item = line.match(/^\s*(?:[-*+]|\d+[.)])\s+(?:\[.?\]\s+)?`([^`]+)`/);
    if (item && CAPABILITY.test(item[1]) && !list.some((c) => c.capability === item[1])) {
      list.push({ capability: item[1], group });
    }
  }
  return list;
}

function counts(text) {
  const boxes = checkboxes(text ?? '');
  return { done: boxes.filter((b) => b.done).length, total: boxes.length };
}

export function language(root, requested) {
  let value = requested;
  if (!value) {
    const config = readIf(path.join(root, 'openspec/config.yaml'), []) ?? '';
    value = config.match(/^\s*Artifact language:\s*(.+?)\s*$/m)?.[1] ?? 'en';
  }
  return /^(ja|jp|japanese|日本語)/i.test(value.trim()) ? 'ja' : 'en';
}

export function collect(root) {
  const problems = [];
  const changes = path.join(root, 'openspec/changes');
  const archived = dirs(path.join(changes, 'archive'));
  const plan = readIf(path.join(root, PLAN), problems);
  const planned = plan === null ? [] : planCapabilities(plan);

  // Capabilities that only openspec/ knows about come after the plan's, by name.
  const seen = new Map(planned.map((p) => [changeKey(p.capability), p]));
  const extra = new Set(specCapabilities(path.join(root, 'openspec/specs')));
  for (const name of dirs(changes)) {
    if (name.startsWith('extract-')) for (const cap of specCapabilities(path.join(changes, name, 'specs'))) extra.add(cap);
  }
  for (const name of archived) {
    if (/^\d{4}-\d{2}-\d{2}-extract-/.test(name)) for (const cap of specCapabilities(path.join(changes, 'archive', name, 'specs'))) extra.add(cap);
  }
  const all = [...planned];
  for (const capability of [...extra].sort()) {
    if (!seen.has(changeKey(capability))) { seen.set(changeKey(capability), true); all.push({ capability, group: null, unplanned: true }); }
  }
  // An active change whose capability is known nowhere else still shows, under its change name.
  for (const name of dirs(changes)) {
    const m = name.match(/^(?:extract|port)-(.+)$/);
    if (m && !seen.has(m[1])) { seen.set(m[1], true); all.push({ capability: m[1], group: null, unplanned: true }); }
  }

  const capabilities = all.map((entry) => {
    const key = changeKey(entry.capability);
    const parts = capabilitySegments(entry.capability);
    const c = {
      ...entry,
      baseline: isFile(path.join(root, 'openspec/specs', ...parts, 'spec.md')),
      extract: null, port: null,
      portArchived: archived.some((name) => name.replace(/^\d{4}-\d{2}-\d{2}-/, '') === `port-${key}`),
    };
    const extractDir = path.join(changes, `extract-${key}`);
    if (fs.existsSync(extractDir)) {
      const review = readIf(path.join(extractDir, 'review.md'), problems);
      c.extract = {
        artifacts: EXTRACT_ARTIFACTS.filter((file) => isFile(path.join(extractDir, file))),
        specs: specCapabilities(path.join(extractDir, 'specs')).length > 0,
        review: counts(review),
      };
    }
    const portDir = path.join(changes, `port-${key}`);
    if (fs.existsSync(portDir)) {
      const tasks = readIf(path.join(portDir, 'tasks.md'), problems);
      c.port = { tasks: tasks === null ? null : counts(tasks) };
    }
    c.steps = Object.fromEntries(STEPS.map((step) => [step.id, step.state(c)]));
    c.ported = c.steps.implement.status === 'completed';
    c.reviewed = c.steps.review.status === 'completed';
    c.active = Boolean(c.extract || c.port);
    return c;
  });
  return { capabilities, problems: [...new Set(problems)], plan: plan !== null };
}

function pickCurrent(capabilities, requested) {
  if (requested) {
    const key = changeKey(capabilitySegments(requested).join('/'));
    return capabilities.find((c) => changeKey(c.capability) === key) ?? null;
  }
  return capabilities.find((c) => c.active && !c.ported)
    ?? capabilities.find((c) => !c.ported) ?? null;
}

const say = (words, detail) => (detail ? words[detail[0]] instanceof Function ? words[detail[0]](...detail.slice(1)) : words[detail[0]] : '');

export function status(root, { capability, language: lang = 'en' } = {}) {
  const words = WORDS[lang] ?? WORDS.en;
  const { capabilities, problems, plan } = collect(root);
  const total = capabilities.length;
  const ported = capabilities.filter((c) => c.ported).length;
  const reviewed = capabilities.filter((c) => c.reviewed).length;
  const current = pickCurrent(capabilities, capability);
  if (capability && !current) problems.push(`capability not found: ${capability}`);

  const overallTitle = total === 0 ? words.noPlan : ported === total ? words.allDone(total) : words.overall(ported, total, reviewed);
  const todoList = [{ id: 1, key: 'overall', title: overallTitle, description: '', status: total > 0 && ported === total ? 'completed' : 'not-started' }];
  let here = null;
  if (current) {
    STEPS.forEach((step, i) => {
      const state = current.steps[step.id];
      const detail = say(words, state.detail);
      todoList.push({
        id: i + 2,
        key: `${current.capability}:${step.id}`,
        title: `${current.capability}: ${words[step.id]}${detail ? (lang === 'ja' ? `【${detail}】` : ` [${detail}]`) : ''}`,
        description: step.owner === 'person' ? (lang === 'ja' ? '人が判断します' : 'decided by the person') : '',
        status: state.status,
      });
      if (!here && state.status !== 'completed') here = { capability: current.capability, step: step.id, owner: step.owner, ...(state.waiting ? { waiting: true } : {}) };
    });
  }
  return {
    plan, total, ported, reviewed,
    current: here,
    active: capabilities.filter((c) => c.active).map((c) => c.capability),
    todoList,
    capabilities: capabilities.map(({ capability, group, unplanned, steps }) => ({ capability, group, ...(unplanned ? { unplanned: true } : {}), steps })),
    problems,
    language: lang,
  };
}

export function checklist(report) {
  const words = WORDS[report.language] ?? WORDS.en;
  const hereKey = report.current ? `${report.current.capability}:${report.current.step}` : null;
  return report.todoList.map((item) => `- [${item.status === 'completed' ? 'x' : ' '}] ${item.key === hereKey ? '▶ ' : ''}${item.title}${item.key === hereKey ? ` ← ${words.current}` : ''}`).join('\n');
}

export function markdown(report) {
  const words = WORDS[report.language] ?? WORDS.en;
  const cell = (state) => (state.status === 'completed' ? words.done : say(words, state.detail) || (state.status === 'in-progress' ? '…' : words.notStarted));
  const rows = report.capabilities.map((c) => `| \`${c.capability}\`${c.unplanned ? ' *' : ''} | ${STEPS.map((s) => cell(c.steps[s.id])).join(' | ')} |`);
  const lines = [checklist(report)];
  if (rows.length) lines.push('', `| ${words.table.join(' | ')} |`, `|${words.table.map(() => '---').join('|')}|`, ...rows);
  if (report.problems.length) lines.push('', `${words.unreadable}:`, ...report.problems.map((p) => `- ${p}`));
  return lines.join('\n');
}

export function main(argv) {
  const opts = { root: process.cwd(), format: 'json' };
  for (let i = 0; i < argv.length; i += 2) {
    const key = { '--format': 'format', '--capability': 'capability', '--language': 'language', '--root': 'root' }[argv[i]];
    if (!key || argv[i + 1] === undefined) return usage();
    opts[key] = argv[i + 1];
  }
  if (!['todo', 'checklist', 'markdown', 'json'].includes(opts.format)) return usage();
  if (!fs.existsSync(path.join(opts.root, 'openspec'))) {
    console.error(`status: no openspec/ folder in ${path.resolve(opts.root)}. Run this from the repository root or pass --root DIR.`);
    return 2;
  }
  const report = status(opts.root, { capability: opts.capability, language: language(opts.root, opts.language) });
  if (opts.format === 'todo') console.log(JSON.stringify({ todoList: report.todoList.map(({ id, title, description, status: s }) => ({ id, title, description, status: s })), current: report.current }, null, 2));
  else if (opts.format === 'checklist') console.log(checklist(report));
  else if (opts.format === 'markdown') console.log(markdown(report));
  else console.log(JSON.stringify({ ...report, checklist: checklist(report) }, null, 2));
  return 0;
}

function usage() {
  console.error('Usage: node status.mjs [--format todo|checklist|markdown|json] [--capability PATH] [--language ja|en] [--root DIR]');
  return 2;
}

function invokedDirectly() {
  if (!process.argv[1]) return false;
  try { return fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url)); } catch { return false; }
}

if (invokedDirectly()) process.exitCode = main(process.argv.slice(2));
