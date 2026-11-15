#!/usr/bin/env node
// Time spent on each step of a migration. A record only: progress itself stays
// in the openspec/ files, and nothing here approves or blocks anything.
//
//   node metrics.mjs report [--format markdown|json] [--language ja|en] [--root DIR]
//       the time per capability and step (in progress apart from waiting for
//       the person) and the kit's subagent runs (count and time); --format json
//       is ASCII and holds the same table as `markdown`
//   node metrics.mjs note (--file PATH | --text TEXT) [--capability PATH] [--root DIR]
//       keeps a note, such as the output of Copilot CLI's /usage the person
//       pasted (--file reads it from a file, so no shell quoting can alter it)
//   node metrics.mjs hook subagent-start|subagent-stop
//       called by the plugin hook (com.github.copilot/hooks/hooks.json) with the
//       host's event JSON on stdin; always exits 0 and prints nothing
//
// status.mjs calls recordSteps() each time it runs (the orchestrator runs it when a
// step starts or ends), so a step's times are as exact as those runs. Records go
// to openspec/spec-relay/local/metrics.jsonl, one JSON object per line, which is
// git-ignored like the trial record: they belong to one machine. Recording is on
// unless openspec/config.yaml's context says "Record metrics: off" (anything
// other than on, true or yes turns it off).
//
// Tokens are not recorded automatically: Copilot gives hooks no token counts
// (hooks reference, 2026-11-11) and the transcript format is not documented, so
// adding numbers found there would be a guess. The person's /usage output can be
// kept as a note.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { configValue, cleanValue, readIf, language } from './gate.mjs';
import { findRoot } from './hook.mjs';

export const METRICS = 'openspec/spec-relay/local/metrics.jsonl';
// Only the kit's own subagents are counted; the orchestrator's run would span theirs.
const KIT_AGENTS = /(?:^|[:/\\])spec-relay-(?:analyst|checker|implementer)$/i;
// A start with no stop for this long (a cancelled run, a closed session) is dropped.
const STALE_START = 24 * 60 * 60000;

export function enabled(root) {
  const config = readIf(path.join(root, 'openspec/config.yaml'), []) ?? '';
  // No line: on (repositories set up before 0.10.0). A line: on only when it says so.
  if (!/^\s*Record metrics[^:\n]*:/m.test(config)) return true;
  return /^(on|true|yes)$/i.test(cleanValue(configValue(root, 'Record metrics', '') ?? ''));
}

const validTime = (t) => typeof t === 'string' && Number.isFinite(Date.parse(t));

export function readEvents(root) {
  const text = readIf(path.join(root, METRICS), []) ?? '';
  const events = [];
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    try { const e = JSON.parse(line); if (e && typeof e === 'object' && validTime(e.t)) events.push(e); } catch { /* a torn line is skipped */ }
  }
  return events;
}

// openspec/spec-relay/local/ holds one machine's files; its .gitignore keeps them out of git.
export function ignoreLocal(root) {
  const dir = path.dirname(path.join(root, METRICS));
  fs.mkdirSync(dir, { recursive: true });
  const ignore = path.join(dir, '.gitignore');
  if (!fs.existsSync(ignore)) fs.writeFileSync(ignore, '# spec-relay: results that belong to one machine; never committed.\n*\n');
}

export function append(root, events) {
  if (!events.length) return;
  const file = path.join(root, METRICS);
  ignoreLocal(root);
  // One appendFileSync per call keeps lines whole when hooks of parallel subagents write at once.
  fs.appendFileSync(file, events.map((e) => `${JSON.stringify(e)}\n`).join(''));
}

const stateOf = (s) => `${s.status}${s.waiting ? ':waiting' : ''}`;
// A step is named by its capability (null for the survey and target design) and its step id.
const stepKey = (capability, step) => JSON.stringify([capability ?? null, step]);
const isOpen = (state) => state === 'in-progress' || /:waiting$/.test(state ?? '');

// The state of every step now, from a status.mjs report: the survey and target
// design, and each capability's analyze, review and implement steps.
export function stepStates(report) {
  const states = new Map();
  for (const f of report.foundation ?? []) states.set(stepKey(null, f.id), { capability: null, step: f.id, state: stateOf(f) });
  for (const c of report.capabilities ?? []) {
    for (const [step, s] of Object.entries(c.steps ?? {})) states.set(stepKey(c.capability, step), { capability: c.capability, step, state: stateOf(s) });
  }
  return states;
}

const stepRecord = (t, capability, step, state) => ({ t, kind: 'step', ...(capability ? { capability } : {}), step, state });

// Appends a "step" record for every step whose state changed since the last
// record, and closes a step that was running or waiting and is gone from the
// report (a renamed or removed capability). Returns the records it wrote. Only
// in a repository spec-relay set up.
export function recordSteps(root, report, now = new Date()) {
  if (findRoot(root) !== path.resolve(root) || !enabled(root)) return [];
  const last = new Map();
  for (const e of readEvents(root)) if (e.kind === 'step') last.set(stepKey(e.capability, e.step), e);
  const t = now.toISOString();
  const out = [];
  const current = stepStates(report);
  for (const [key, { capability, step, state }] of current) {
    const prev = last.get(key)?.state;
    if (prev === state) continue;
    // A step seen for the first time as not started has not begun; nothing to time.
    if (prev === undefined && state === 'not-started') continue;
    out.push(stepRecord(t, capability, step, state));
  }
  for (const [key, e] of last) {
    if (!current.has(key) && isOpen(e.state)) out.push(stepRecord(t, e.capability, e.step, 'gone'));
  }
  append(root, out);
  return out;
}

// The changes a subagent's report names (openspec/changes/<change>/...), so its
// time can be counted for that change's capability.
export function namedChanges(text) {
  const names = new Set();
  for (const m of String(text ?? '').matchAll(/openspec[\\/]+(?:changes|spec-relay[\\/]+work)[\\/]+((?:survey|target-design|(?:extract|port|amend)-[a-z0-9-]+))\b/g)) names.add(m[1]);
  return [...names];
}

// The event time: an ISO string, or a number in milliseconds (or seconds), within
// a sane range; otherwise now.
function eventTime(value, now) {
  let ms = typeof value === 'number' ? value : typeof value === 'string' ? Date.parse(value) : NaN;
  if (Number.isFinite(ms) && ms > 0 && ms < 1e11) ms *= 1000;
  return Number.isFinite(ms) && ms > Date.UTC(2000, 0, 1) && ms < Date.UTC(2200, 0, 1) ? new Date(ms).toISOString() : now.toISOString();
}

// Only a pairing key is kept, not the host's session id.
const sessionKey = (id) => crypto.createHash('sha256').update(String(id ?? '')).digest('hex').slice(0, 12);

// A record for a subagentStart or subagentStop event of a kit subagent, or null.
export function hookRecord(kind, payload, now = new Date()) {
  if (kind !== 'subagent-start' && kind !== 'subagent-stop') return null;
  const agent = String(payload.agentName || payload.agent_name || payload.agentType || payload.agent_type || '');
  if (!KIT_AGENTS.test(agent)) return null;
  const base = { t: eventTime(payload.timestamp, now), kind, agent: agent.replace(/^.*[:/\\]/, ''), session: sessionKey(payload.sessionId ?? payload.session_id) };
  if (kind === 'subagent-start') return base;
  const changes = namedChanges(payload.response ?? payload.last_assistant_message);
  return { ...base, ...(changes.length ? { changes } : {}) };
}

export function hook(kind, input) {
  let payload;
  try { payload = JSON.parse(String(input || '{}').replace(/^\uFEFF/, '')); } catch { return; }
  if (!payload || typeof payload !== 'object') return;
  const root = findRoot(payload.cwd ?? process.cwd());
  if (!root || !enabled(root)) return;
  const record = hookRecord(kind, payload);
  if (record) append(root, [record]);
}

// The capability a change belongs to: extract-billing-invoice -> billing/invoice
// when the step records name it. The survey and target design belong to the project (null).
function changeCapability(change, capabilities) {
  if (/^(survey|target-design)(-v\d+)?$/.test(change)) return null;
  const key = change.replace(/^(extract|port|amend)-/, '').replace(/-v\d+$/, '');
  return capabilities.find((c) => c.split('/').join('-') === key) ?? key;
}

// Durations in milliseconds per capability and step, split into time in
// progress and time waiting for the person, and the kit's subagent runs.
export function summarize(events, now = new Date()) {
  const steps = new Map();
  const row = (e) => {
    const key = stepKey(e.capability, e.step);
    if (!steps.has(key)) steps.set(key, { capability: e.capability ?? null, step: e.step, agent: 0, person: 0 });
    return steps.get(key);
  };
  const open = new Map();
  // Which steps of each capability are open (in progress or waiting), for subagent runs that name no change.
  const openSteps = new Map();
  const ROLE_STEPS = { 'spec-relay-implementer': ['implement'], 'spec-relay-analyst': ['analyze', 'review'], 'spec-relay-checker': ['analyze', 'review'] };
  const sorted = [...events].sort((a, b) => Date.parse(a.t) - Date.parse(b.t));
  const subagents = new Map();
  const starts = new Map();
  const owner = (e) => {
    const capabilities = [...new Set([...steps.values()].map((s) => s.capability).filter(Boolean))];
    const named = [...new Set((e.changes ?? []).map((c) => changeCapability(c, capabilities)))];
    if (named.length) return named.length === 1 ? named[0] : undefined;
    // No change named: the one capability with an open step of the kind this agent works on.
    const kinds = ROLE_STEPS[e.agent] ?? [];
    const busy = [...openSteps].filter(([c, set]) => c && kinds.some((k) => set.has(k))).map(([c]) => c);
    return busy.length === 1 ? busy[0] : undefined;
  };
  for (const e of sorted) {
    if (e.kind === 'step' && typeof e.step === 'string') {
      const r = row(e);
      const key = stepKey(e.capability, e.step);
      const prev = open.get(key);
      if (prev) r[prev.field] += Math.max(0, Date.parse(e.t) - Date.parse(prev.t));
      const field = e.state === 'in-progress' ? 'agent' : /:waiting$/.test(e.state) ? 'person' : null;
      if (field) open.set(key, { t: e.t, field }); else open.delete(key);
      if (!openSteps.has(r.capability)) openSteps.set(r.capability, new Set());
      openSteps.get(r.capability)[field ? 'add' : 'delete'](e.step);
    } else if (e.kind === 'subagent-start') {
      const k = `${e.session}|${e.agent}`;
      if (!starts.has(k)) starts.set(k, []);
      starts.get(k).push(e.t);
    } else if (e.kind === 'subagent-stop') {
      const k = `${e.session}|${e.agent}`;
      // The latest start pairs with this stop: a start whose stop was lost then
      // stays behind instead of stretching every later run.
      const list = (starts.get(k) ?? []).filter((t) => Date.parse(e.t) - Date.parse(t) <= STALE_START);
      const start = list.pop();
      starts.set(k, list);
      const who = owner(e);
      const id = who === undefined ? '' : who === null ? '#project' : who;
      if (!subagents.has(id)) subagents.set(id, { capability: who ?? null, attributed: who !== undefined, runs: 0, ms: 0 });
      const s = subagents.get(id);
      s.runs += 1;
      if (start) s.ms += Math.max(0, Date.parse(e.t) - Date.parse(start));
    }
  }
  for (const [key, { t, field }] of open) steps.get(key)[field] += Math.max(0, now.getTime() - Date.parse(t));

  const notes = sorted.filter((e) => e.kind === 'note' && typeof e.text === 'string').map(({ t, capability, text }) => ({ t, capability: capability ?? null, text }));
  return {
    // A step first seen already completed (recording began after it) has no time; leave it out.
    steps: [...steps.values()].filter((s) => s.agent > 0 || s.person > 0),
    subagents: [...subagents.values()],
    notes,
    since: sorted[0]?.t ?? null,
  };
}

const WORDS = {
  en: {
    title: 'Time spent',
    since: (t) => `Recorded on this machine since ${t}. Step times run from one status.mjs run to the next (the orchestrator runs it at every step change), so they include time when nobody worked: a session left open, a night, a weekend.`,
    none: 'Nothing recorded yet.', target: 'Capability', step: 'Step', agent: 'In progress', person: 'Waiting for the person',
    split: '"Waiting for the person" is a review or a decision; the implement step counts as waiting until its first task is ticked, and fixes the agent makes during a review count there too. The subagent table shows the kit subagents\' own working time.',
    subagents: 'Subagent runs', runs: 'Runs', time: 'Working time', total: 'Total', unknownOwner: '(not attributed)',
    noTokens: 'Copilot gives the kit no token counts. Paste the output of Copilot CLI\'s /usage to keep it as a note.',
    notes: 'Notes', project: '(project)',
    steps: { survey: 'Survey', target: 'Target design', analyze: 'Analyze', review: 'Review', implement: 'Implement' },
  },
  ja: {
    title: 'かかった時間',
    since: (t) => `${t} から、この端末で記録。工程の時間は status.mjs を実行した時点の間隔です（オーケストレーターは工程が変わるたびに実行します）。セッションを開いたままの時間や夜間・休日など、誰も作業していない時間も含みます。`,
    none: 'まだ記録がありません。', target: '機能', step: '工程', agent: '進行中', person: '人の確認待ち',
    split: '「人の確認待ち」はレビューや判断を待っていた時間です。実装は最初のタスクにチェックが付くまで確認待ちに数え、レビュー中に AI が直していた時間もここに入ります。AI 自身の作業時間は、下のサブエージェントの表を見てください。',
    subagents: 'サブエージェント', runs: '回数', time: '作業時間', total: '合計', unknownOwner: '（機能を特定できず）',
    noTokens: 'Copilot はキットにトークン数を渡しません。Copilot CLI の /usage の結果を貼ると、メモとして残せます。',
    notes: 'メモ', project: '（プロジェクト全体）',
    steps: { survey: '調査', target: '移行先の設計', analyze: '解析', review: 'レビュー', implement: '実装' },
  },
};

export function duration(ms, lang = 'en') {
  const m = Math.floor(ms / 60000);
  if (m === 0) return ms > 0 ? (lang === 'ja' ? '1分未満' : '<1m') : '-';
  const d = Math.floor(m / 1440); const h = Math.floor((m % 1440) / 60); const min = m % 60;
  const parts = lang === 'ja'
    ? [d && `${d}日`, h && `${h}時間`, min && `${min}分`]
    : [d && `${d}d`, h && `${h}h`, min && `${min}m`];
  return parts.filter(Boolean).join(lang === 'ja' ? '' : ' ');
}

const when = (t) => `${t.slice(0, 16).replace('T', ' ')} UTC`;

export function markdown(summary, lang = 'en') {
  const w = WORDS[lang] ?? WORDS.en;
  if (!summary.steps.length && !summary.subagents.length && !summary.notes.length) return `## ${w.title}\n\n${w.none}`;
  const cell = (s) => String(s).replace(/\|/g, '\\|');
  const who = (capability) => (capability === null ? w.project : `\`${cell(capability)}\``);
  const lines = [`## ${w.title}`, '', w.since(when(summary.since))];
  if (summary.steps.length) {
    lines.push('', `| ${w.target} | ${w.step} | ${w.agent} | ${w.person} |`, '|---|---|---|---|');
    let agent = 0; let person = 0;
    for (const s of summary.steps) {
      agent += s.agent; person += s.person;
      lines.push(`| ${who(s.capability)} | ${w.steps[s.step] ?? cell(s.step)} | ${duration(s.agent, lang)} | ${duration(s.person, lang)} |`);
    }
    lines.push(`| **${w.total}** | | **${duration(agent, lang)}** | **${duration(person, lang)}** |`, '', w.split);
  }
  if (summary.subagents.length) {
    lines.push('', `### ${w.subagents}`, '', `| ${w.target} | ${w.runs} | ${w.time} |`, '|---|---|---|');
    for (const s of summary.subagents) lines.push(`| ${s.attributed ? who(s.capability) : w.unknownOwner} | ${s.runs} | ${duration(s.ms, lang)} |`);
  }
  lines.push('', w.noTokens);
  if (summary.notes.length) {
    lines.push('', `### ${w.notes}`, '');
    for (const n of summary.notes) lines.push(`- ${when(n.t)}${n.capability ? ` \`${cell(n.capability)}\`` : ''}: ${cell(n.text).replace(/\s*\r?\n\s*/g, ' / ')}`);
  }
  return lines.join('\n');
}

const ascii = (json) => json.replace(/[\u007f-\uFFFF]/g, (ch) => `\\u${ch.charCodeAt(0).toString(16).padStart(4, '0')}`);

export function main(argv, stdin = () => fs.readFileSync(0, 'utf8')) {
  const [command, ...rest] = argv;
  if (command === 'hook') {
    try { hook(rest[0], stdin()); } catch { /* a record never stops the host */ }
    return 0;
  }
  const opts = { root: process.cwd(), format: 'markdown' };
  const flags = { '--format': 'format', '--lang': 'lang', '--language': 'lang', '--root': 'root', '--text': 'text', '--file': 'file', '--capability': 'capability' };
  for (let i = 0; i < rest.length; i += 2) {
    const key = flags[rest[i]];
    if (!key || rest[i + 1] === undefined) return usage();
    opts[key] = rest[i + 1];
  }
  if (!fs.existsSync(path.join(opts.root, 'openspec'))) {
    console.error(`metrics: no openspec/ folder in ${path.resolve(opts.root)}. Run this from the repository root or pass --root DIR.`);
    return 2;
  }
  if (command === 'note') {
    let text = opts.text;
    if (opts.file !== undefined) {
      try { text = fs.readFileSync(path.resolve(opts.root, opts.file), 'utf8').replace(/^\uFEFF/, ''); } catch (error) {
        console.error(`metrics: cannot read ${opts.file}: ${error.message}`);
        return 2;
      }
    }
    if (!text?.trim()) return usage();
    // The pasted file sits in local/ too; keep it out of git even when nothing is recorded.
    ignoreLocal(opts.root);
    if (!enabled(opts.root)) { console.error('metrics: "Record metrics" is off in openspec/config.yaml; nothing was kept.'); return 1; }
    append(opts.root, [{ t: new Date().toISOString(), kind: 'note', ...(opts.capability ? { capability: opts.capability } : {}), text: text.trim().slice(0, 4000) }]);
    return 0;
  }
  if (command !== 'report' || !['markdown', 'json'].includes(opts.format)) return usage();
  const summary = summarize(readEvents(opts.root));
  const lang = language(opts.root, opts.lang);
  // The JSON is ASCII (\uXXXX) and carries the table too, for a console whose code page garbles UTF-8.
  console.log(opts.format === 'json' ? ascii(JSON.stringify({ ...summary, markdown: markdown(summary, lang) }, null, 2)) : markdown(summary, lang));
  return 0;
}

function usage() {
  console.error('Usage: node metrics.mjs report [--format markdown|json] [--language ja|en] [--root DIR] | note (--file PATH | --text TEXT) [--capability PATH] [--root DIR] | hook subagent-start|subagent-stop');
  return 2;
}

function invokedDirectly() {
  if (!process.argv[1]) return false;
  try { return fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url)); } catch { return false; }
}

if (invokedDirectly()) process.exitCode = main(process.argv.slice(2));
