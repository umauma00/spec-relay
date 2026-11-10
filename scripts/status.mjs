#!/usr/bin/env node
// Migration progress, computed from the files in openspec/ alone, for the host's
// TODO list (Copilot CLI update_todo, VS Code todo) and for chat.
//
//   node status.mjs [--format todo|checklist|markdown|json] [--capability PATH]
//                   [--language ja|en] [--root DIR]
//
//   todo       { todoList: [{ id, title, description, status }], checklist, current, parallel, problems }
//              for the TODO tool. ASCII-only JSON (\uXXXX escapes), so a console
//              code page on Windows cannot garble the titles.
//   checklist  the same items as a Markdown checklist for chat, then any problems
//   markdown   the checklist, then a table of every capability
//   json       everything, with the per-capability details (the default)
//
// The TODO list is a view: one line for the whole migration, the steps of the
// current capability, and one line for each other capability with an active
// change (several run at once when the orchestrator works in parallel).
// `parallel` says how many subagents may run at once, which capabilities are
// being analyzed or are in review, and which may be analyzed next without
// running more than `ahead` capabilities ahead of the person's review (both
// numbers come from openspec/config.yaml). It never records or grants an approval; the review gate is
// scripts/gate.mjs. Read-only. Exits 0, 1 when --capability names no known
// capability, 2 on bad usage.
//
// Steps are data (STEPS below): a new step is one more entry with a label, the
// person or agent who does it, and a function from a capability's files (and the
// earlier steps' states) to its state.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkboxes, readIf, capabilitySegments, checkReview, baseName, archivedChange, baselineHash, configValue } from './gate.mjs';

const PLAN = 'openspec/spec-relay/plan.md';
// Used when a change's schema file cannot be read. The schema's own list wins,
// so an artifact added to a schema later is counted without touching this file.
const DEFAULT_ARTIFACTS = {
  'spec-relay-survey': ['inventory.md', 'context-map.md', 'glossary.md', 'capabilities.md', 'review.md'],
  'spec-relay-target': ['architecture.md', 'conventions.md', 'verification.md', 'review.md'],
  'spec-relay-extract': ['source-map.md', 'specs/**/*.md', 'screens.md', 'trace.md', 'crosscheck.md', 'questions.md', 'review.md'],
  'spec-relay-amend': ['reason.md', 'specs/**/*.md', 'trace.md', 'crosscheck.md', 'impact.md', 'review.md'],
  'spec-relay-port': ['proposal.md', 'design.md', 'tasks.md'],
};
// Lowercase ASCII kebab-case segments, as the skill asks capabilities to be named.
const CAPABILITY = /^[a-z0-9]+(?:-[a-z0-9]+)*(?:\/[a-z0-9]+(?:-[a-z0-9]+)*)*$/;
const PLAN_HEADING = /^(?:\d+[.)]?\s*)?(?:capabilit(?:y|ies)\b|機能(?:一覧|リスト)?(?:$|[\s（(:：])|ケイパビリティ)/i;
const changeKey = (capability) => capability.split('/').join('-');

const WORDS = {
  en: {
    analyze: 'Analyze', review: 'Review', implement: 'Implement', capability: 'Capability', group: 'Group',
    survey: 'Survey: map the bounded contexts', target: 'Target design: modules, conventions, verification',
    amending: (n, of) => `amendment under review ${n}/${of}`,
    amendedAfterPort: 'the spec was amended after the port; port it again',
    overall: (done, total, reviewed) => `Overall: ${done} of ${total} capabilities ported (${reviewed} with a reviewed spec)`,
    noPlan: 'Overall: no capability list in the plan yet',
    allDone: (total) => `Overall: all ${total} capabilities ported`,
    writing: (n, of) => `writing artifacts ${n}/${of}`,
    waitingReview: (n, of) => `waiting for review ${n}/${of}`,
    gateFails: 'all ticked, but gate.mjs review fails',
    waitingArchive: 'reviewed; waiting for approval to archive',
    archivedNoBaseline: 'archived, but no baseline spec',
    designing: 'writing the design',
    waitingDesign: (of) => `tasks 0/${of}; starts once the person agrees to the design`,
    tasks: (n, of) => `tasks ${n}/${of}`,
    waitingPortArchive: 'all tasks done; waiting for agreement to archive',
    person: 'decided by the person',
    current: 'you are here', done: 'done', notStarted: '-', notInPlan: 'not in the plan',
    problems: 'Problems',
  },
  ja: {
    analyze: '解析', review: 'レビュー', implement: '実装', capability: '機能', group: 'グループ',
    survey: '調査: コンテキストの地図', target: '移行先の設計: モジュール・規約・比べ方',
    amending: (n, of) => `仕様の修正をレビュー中 ${n}/${of}`,
    amendedAfterPort: '移行後に仕様が修正された・再実装が必要',
    overall: (done, total, reviewed) => `全体: ${total}機能のうち${done}機能が移行済み（仕様確定 ${reviewed}）`,
    noPlan: '全体: 計画に機能の一覧がまだありません',
    allDone: (total) => `全体: ${total}機能すべて移行済み`,
    writing: (n, of) => `成果物 ${n}/${of}`,
    waitingReview: (n, of) => `レビュー待ち ${n}/${of}`,
    gateFails: '全項目チェック済み・gate.mjs review 未通過',
    waitingArchive: 'レビュー済み・承認待ち',
    archivedNoBaseline: 'アーカイブ済み・ベースライン仕様なし',
    designing: '設計中',
    waitingDesign: (of) => `タスク 0/${of}・設計の合意後に着手`,
    tasks: (n, of) => `タスク ${n}/${of}`,
    waitingPortArchive: '全タスク完了・完了の確認待ち',
    person: '人が判断します',
    current: 'いまここ', done: '完了', notStarted: '-', notInPlan: '計画にない',
    problems: '問題',
  },
};

// Each step returns { status, detail?, waiting? }. status is one of the three
// states every host supports. Work that waits for the person stays not-started
// with the reason in `detail`, so a waiting step never looks as if the agent
// were busy with it. Several steps are in progress only when subagents work on
// several capabilities at once. `marks` names the summary
// count a completed step adds to.
export const FOUNDATION = [
  { id: 'survey', change: 'survey', schema: 'spec-relay-survey' },
  { id: 'target', change: 'target-design', schema: 'spec-relay-target' },
];

export const STEPS = [
  {
    id: 'analyze', owner: 'agent',
    state: (c) => {
      if (c.extract) {
        const { done, total } = c.extract.artifacts;
        return done === total ? { status: 'completed' } : { status: 'in-progress', detail: ['writing', done, total] };
      }
      if (c.baseline) return { status: 'completed' };
      if (c.extractArchived) return { status: 'not-started', detail: ['archivedNoBaseline'] };
      return { status: 'not-started' };
    },
  },
  {
    id: 'review', owner: 'person', marks: 'reviewed',
    state: (c, earlier) => {
      if (c.amend) {
        const { done, total } = c.amend.review;
        if (c.amend.artifacts.done < c.amend.artifacts.total) return { status: 'in-progress', detail: ['writing', c.amend.artifacts.done, c.amend.artifacts.total] };
        if (c.amend.gate) return { status: 'not-started', waiting: true, detail: ['waitingArchive'] };
        return { status: 'not-started', waiting: true, detail: ['amending', done, total] };
      }
      if (c.extract) {
        if (earlier.analyze.status !== 'completed') return { status: 'not-started' };
        const { done, total } = c.extract.review;
        if (c.extract.gate) return { status: 'not-started', waiting: true, detail: ['waitingArchive'] };
        if (total > 0 && done === total) return { status: 'not-started', waiting: true, detail: ['gateFails'] };
        return { status: 'not-started', waiting: true, detail: ['waitingReview', done, total] };
      }
      return c.baseline ? { status: 'completed' } : { status: 'not-started' };
    },
  },
  {
    id: 'implement', owner: 'agent', marks: 'ported',
    state: (c) => {
      // A port opened while the extract is still active waits for that review (gate.mjs port-ready).
      if (c.port && (c.extract || c.amend)) return { status: 'not-started' };
      if (c.port) {
        if (!c.port.tasks || c.port.tasks.total === 0) return { status: 'in-progress', detail: ['designing'] };
        const { done, total } = c.port.tasks;
        if (total > 0 && done === total) return { status: 'not-started', waiting: true, detail: ['waitingPortArchive'] };
        if (done === 0) return { status: 'not-started', waiting: true, detail: ['waitingDesign', total] };
        return { status: 'in-progress', detail: ['tasks', done, total] };
      }
      if (c.portArchived && c.portStale) return { status: 'not-started', detail: ['amendedAfterPort'] };
      return c.portArchived ? { status: 'completed' } : { status: 'not-started' };
    },
  },
];

function dirs(dir) {
  try { return fs.readdirSync(dir, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name); } catch { return []; }
}
function files(dir) {
  let entries = [];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return []; }
  return entries.flatMap((e) => (e.isDirectory() ? files(path.join(dir, e.name)) : [path.join(dir, e.name)]));
}
const isFile = (file) => { try { return fs.statSync(file).isFile(); } catch { return false; } };
const rel = (root, file) => path.relative(root, file).split(path.sep).join('/');

// readIf with the path in its message, so a person knows which change it is.
function read(root, file, problems) {
  const local = [];
  const text = readIf(file, local);
  for (const problem of local) problems.push(problem.replace(path.basename(file), rel(root, file)));
  return text;
}

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

// The artifacts a change's schema generates, from openspec/schemas/<schema>/schema.yaml.
function schemaArtifacts(root, changeDir, fallback) {
  const meta = readIf(path.join(changeDir, '.openspec.yaml'), []) ?? '';
  const schema = meta.match(/^schema:\s*["']?([^"'\s#]+)/m)?.[1] ?? fallback;
  const text = readIf(path.join(root, 'openspec/schemas', schema, 'schema.yaml'), []) ?? '';
  const listed = [...text.matchAll(/^ {1,4}generates:\s*["']?([^"'\r\n#]+?)["']?\s*(?:#.*)?$/gm)].map((m) => m[1]);
  return listed.length ? listed : DEFAULT_ARTIFACTS[fallback];
}

// A plain file name, or a pattern such as specs/**/*.md: some file below its fixed part.
function generated(changeDir, pattern) {
  if (!pattern.includes('*')) return isFile(path.join(changeDir, ...pattern.split('/')));
  const fixed = pattern.slice(0, pattern.indexOf('*')).split('/').filter(Boolean);
  const ext = pattern.match(/\*(\.[A-Za-z0-9]+)$/)?.[1];
  return files(path.join(changeDir, ...fixed)).some((file) => !ext || file.endsWith(ext));
}

function artifactCount(root, changeDir, fallback) {
  const list = schemaArtifacts(root, changeDir, fallback);
  return { done: list.filter((pattern) => generated(changeDir, pattern)).length, total: list.length };
}

// The capability list of the plan: top-level list items under a "## Capabilities"
// heading (and any deeper headings below it, such as one per bounded context)
// that start with a backticked capability path, in order. Indented items (notes
// and source folders under a capability) and the rest of the plan are ignored.
export function planCapabilities(text) {
  return parsePlan(text).list;
}

// Also returns the top-level items under the heading that hold a backticked name
// but no valid capability path, so a slip in the plan is reported, not dropped.
export function parsePlan(text) {
  const list = [];
  const skipped = [];
  let inside = false;
  let group = null;
  let fenced = false;
  for (const line of text.split(/\r?\n/)) {
    if (/^\s*(```|~~~)/.test(line)) { fenced = !fenced; continue; }
    if (fenced) continue;
    const heading = line.match(/^(#{1,6})\s+(.*?)\s*#*\s*$/);
    if (heading) {
      if (heading[1].length <= 2) { inside = PLAN_HEADING.test(heading[2].trim()); group = null; } else if (inside) group = heading[2];
      continue;
    }
    if (!inside) continue;
    if (!/^ ?(?:[-*+]|\d+[.)])\s/.test(line)) continue;
    const item = line.match(/^ ?(?:[-*+]|\d+[.)])\s+(?:\[.?\]\s+)?`([^`]+)`/);
    if (item && CAPABILITY.test(item[1])) {
      if (!list.some((c) => c.capability === item[1])) list.push({ capability: item[1], group });
    } else if (line.includes('`')) skipped.push(line.trim());
  }
  return { list, skipped };
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
  return /^["']?(ja|jp|japanese|日本語)/i.test(value.trim()) ? 'ja' : 'en';
}

export function collect(root) {
  const problems = [];
  const changes = path.join(root, 'openspec/changes');
  // Reruns carry a -v<n> suffix (port-billing-invoice-v2); they count as their base name.
  const activeNames = dirs(changes).filter((name) => name !== 'archive');
  const activeDir = new Map(activeNames.map((name) => [baseName(name), name]));
  const active = [...activeDir.keys()];
  const archived = dirs(path.join(changes, 'archive')).map((name) => baseName(name.replace(/^\d{4}-\d{2}-\d{2}-/, '')));
  const plan = read(root, path.join(root, PLAN), problems);
  const parsed = plan === null ? { list: [], skipped: [] } : parsePlan(plan);
  const planned = parsed.list;
  for (const line of parsed.skipped) {
    problems.push(`${PLAN}: "${line}" is not read as a capability; start the item with the path in backticks, lowercase kebab-case (\`billing/invoice\`)`);
  }
  // An unreadable (UTF-16) plan is already reported as such.
  if (plan && planned.length === 0) {
    problems.push(`${PLAN} has no capability list: put each capability under a "## Capabilities" heading as a top-level item such as "1. \`billing/invoice\` ..."`);
  }
  const keys = new Map();
  for (const { capability } of planned) {
    const key = changeKey(capability);
    if (keys.has(key)) problems.push(`capabilities ${keys.get(key)} and ${capability} share the change names extract-${key} and port-${key}; rename one`);
    else keys.set(key, capability);
    if (/-v\d+$/.test(key)) problems.push(`capability ${capability} gives change names ending like a rerun suffix (extract-${key}); rename it`);
  }

  // Capabilities that only openspec/ knows about come after the plan's, by name.
  const known = new Set(keys.keys());
  const extra = new Set(specCapabilities(path.join(root, 'openspec/specs')));
  for (const name of active.filter((n) => n.startsWith('extract-'))) {
    const specs = specCapabilities(path.join(changes, activeDir.get(name), 'specs'));
    for (const cap of specs) {
      extra.add(cap);
      if (`extract-${changeKey(cap)}` !== name) problems.push(`change ${name} has its spec at specs/${cap}/spec.md; the path must be the capability the change is named after`);
    }
  }
  const all = planned.map((p) => ({ ...p, planned: true }));
  for (const capability of [...extra].sort()) {
    if (!known.has(changeKey(capability))) { known.add(changeKey(capability)); all.push({ capability, group: null, planned: false }); }
  }
  // An active change known nowhere else still shows, under its change name.
  for (const name of active) {
    const key = name.match(/^(?:extract|amend|port)-(.+)$/)?.[1];
    if (key && !known.has(key)) { known.add(key); all.push({ capability: key, group: null, planned: false }); }
  }

  const capabilities = all.map((entry) => {
    const key = changeKey(entry.capability);
    const parts = capabilitySegments(entry.capability);
    const c = {
      ...entry,
      baseline: isFile(path.join(root, 'openspec/specs', ...parts, 'spec.md')),
      extractArchived: archived.includes(`extract-${key}`),
      portArchived: archived.includes(`port-${key}`),
      portStale: false,
      extract: null, amend: null, port: null,
    };
    // A port archived before an amendment changed the baseline is not done: the
    // hash its proposal recorded no longer matches (gate.mjs port-done's check).
    if (c.portArchived) {
      const proposal = readIf(path.join(archivedChange(root, `port-${key}`) ?? '', 'proposal.md'), []) ?? '';
      const now = baselineHash(root, entry.capability);
      const recorded = [...proposal.matchAll(/`([^`]+)`\s*sha256:\s*([0-9a-f]{64})/gi)].find(([, cap]) => changeKey(capabilitySegments(cap).join('/')) === key);
      c.portStale = Boolean(recorded && now && recorded[2].toLowerCase() !== now);
    }
    for (const kind of ['extract', 'amend']) {
      if (!active.includes(`${kind}-${key}`)) continue;
      const name = activeDir.get(`${kind}-${key}`);
      const dir = path.join(changes, name);
      c[kind] = {
        artifacts: artifactCount(root, dir, `spec-relay-${kind}`),
        review: counts(read(root, path.join(dir, 'review.md'), problems)),
        gate: checkReview(root, name).ok,
      };
    }
    if (active.includes(`port-${key}`)) {
      const tasks = read(root, path.join(changes, activeDir.get(`port-${key}`), 'tasks.md'), problems);
      c.port = { tasks: tasks === null ? null : counts(tasks) };
    }
    if (c.extractArchived && !c.baseline && !c.extract) {
      problems.push(`extract-${key} is archived, but there is no baseline spec at openspec/specs/${parts.join('/')}/spec.md`);
    }
    if (c.extract && c.port) problems.push(`port-${key} is active while extract-${key} is still active; finish the review and archive the extract change first`);
    if (!entry.planned && planned.length && (c.extract || c.port)) problems.push(`${entry.capability} has an active change but is not in ${PLAN}`);
    c.steps = {};
    for (const step of STEPS) c.steps[step.id] = step.state(c, c.steps);
    for (const step of STEPS.filter((s) => s.marks)) c[step.marks] = c.steps[step.id].status === 'completed';
    c.active = Boolean(c.extract || c.amend || c.port);
    c.finished = STEPS.every((step) => c.steps[step.id].status === 'completed') && !c.active;
    // With a plan, what is not in it is shown but not counted (an active change on it is reported above).
    c.counted = planned.length === 0 || entry.planned;
    return c;
  });
  // Project-wide steps before any capability: the survey and the target design.
  const foundation = FOUNDATION.map(({ id, change, schema }) => {
    if (active.includes(change)) {
      const name = activeDir.get(change);
      const dir = path.join(changes, name);
      const artifacts = artifactCount(root, dir, schema);
      if (artifacts.done < artifacts.total) return { id, status: 'in-progress', detail: ['writing', artifacts.done, artifacts.total] };
      if (checkReview(root, name).ok) return { id, status: 'not-started', waiting: true, owner: 'person', detail: ['waitingArchive'] };
      const review = counts(read(root, path.join(dir, 'review.md'), problems));
      return { id, status: 'not-started', waiting: true, owner: 'person', detail: ['waitingReview', review.done, review.total] };
    }
    return archived.includes(change) ? { id, status: 'completed' } : { id, status: 'not-started' };
  });
  return { capabilities, foundation, problems: [...new Set(problems)], plan: plan !== null, planned: planned.length, skipped: parsed.skipped.length };
}

function pickCurrent(capabilities, requested) {
  if (requested) {
    const key = changeKey(capabilitySegments(requested).join('/'));
    return capabilities.find((c) => changeKey(c.capability) === key) ?? null;
  }
  return capabilities.find((c) => c.active)
    ?? capabilities.find((c) => c.counted && !c.finished) ?? null;
}

const say = (words, detail) => {
  if (!detail) return '';
  const word = words[detail[0]];
  return typeof word === 'function' ? word(...detail.slice(1)) : word;
};

export function status(root, { capability, language: lang = 'en' } = {}) {
  const words = WORDS[lang] ?? WORDS.en;
  const { capabilities, foundation, problems, plan, planned, skipped } = collect(root);
  const counted = capabilities.filter((c) => c.counted);
  const total = counted.length;
  const ported = counted.filter((c) => c.ported).length;
  const reviewed = counted.filter((c) => c.reviewed).length;
  const current = pickCurrent(capabilities, capability);
  const unknown = Boolean(capability && !current);
  if (unknown) problems.push(`capability not found: ${capability}`);
  const finished = total > 0 && foundation.every((f) => f.status === 'completed') && counted.every((c) => c.finished) && !capabilities.some((c) => c.active) && !(plan && planned === 0) && skipped === 0;

  const overallTitle = (plan && planned === 0) || total === 0 ? words.noPlan : finished ? words.allDone(total) : words.overall(ported, total, reviewed);
  const todoList = [{ id: 1, key: 'overall', title: overallTitle, description: '', status: finished ? 'completed' : 'not-started' }];
  let here = null;
  // Until the survey and the target design are archived, they are the work.
  const foundationOpen = foundation.some((f) => f.status !== 'completed');
  if (foundationOpen) {
    foundation.forEach((f, i) => {
      const detail = say(words, f.detail);
      todoList.push({ id: i + 2, key: f.id, title: `${words[f.id]}${detail ? (lang === 'ja' ? `【${detail}】` : ` [${detail}]`) : ''}`, description: f.waiting ? words.person : '', status: f.status });
      if (!here && f.status !== 'completed') here = { capability: null, step: f.id, owner: f.waiting ? 'person' : 'agent', ...(f.waiting ? { waiting: true } : {}) };
    });
  }
  // Before the survey and target design are both archived, a capability's steps
  // show only when it has an active change (analyzed during the target design's
  // review) or when asked for (a project that started on an earlier kit version).
  if (current && (!foundationOpen || capability || current.active)) {
    const first = todoList.length + 1;
    STEPS.forEach((step, i) => {
      const state = current.steps[step.id];
      const detail = say(words, state.detail);
      todoList.push({
        id: first + i,
        key: `${current.capability}:${step.id}`,
        title: `${current.capability}: ${words[step.id]}${detail ? (lang === 'ja' ? `【${detail}】` : ` [${detail}]`) : ''}`,
        description: step.owner === 'person' ? words.person : '',
        status: state.status,
      });
      if (!here && state.status !== 'completed') here = { capability: current.capability, step: step.id, owner: step.owner, ...(state.waiting ? { waiting: true } : {}) };
    });
  }
  // Every other capability with an active change gets one line: its first
  // unfinished step.
  for (const other of capabilities.filter((c) => c.active && c !== current)) {
    const step = STEPS.find((st) => other.steps[st.id].status !== 'completed');
    if (!step) continue;
    const state = other.steps[step.id];
    const detail = say(words, state.detail);
    todoList.push({
      id: todoList.length + 1,
      key: `${other.capability}:${step.id}`,
      title: `${other.capability}: ${words[step.id]}${detail ? (lang === 'ja' ? `【${detail}】` : ` [${detail}]`) : ''}`,
      description: step.owner === 'person' ? words.person : '',
      status: state.status,
    });
  }
  return {
    plan, total, ported, reviewed,
    current: here,
    parallel: parallelPlan(root, capabilities, foundation, problems),
    foundation: foundation.map(({ id, status: st }) => ({ id, status: st })),
    active: capabilities.filter((c) => c.active).map((c) => c.capability),
    todoList,
    capabilities: capabilities.map(({ capability: name, group, counted: isCounted, steps }) => ({ capability: name, group, ...(isCounted ? {} : { counted: false }), steps })),
    problems,
    unknown,
    language: lang,
  };
}

// A limit from openspec/config.yaml: a whole number in range, else the default
// (with a problem when a value is there but cannot be used).
function setting(root, label, fallback, max, problems) {
  const raw = configValue(root, label, null);
  if (raw === null) return fallback;
  const value = raw.replace(/\s+#.*$/, '').trim();
  if (/^\d+$/.test(value) && Number(value) >= 1 && Number(value) <= max) return Number(value);
  problems.push(`openspec/config.yaml: "${label}" is "${value}"; use a whole number from 1 to ${max} (using ${fallback})`);
  return fallback;
}

// What the orchestrator may run at once. Analyses run at most `ahead`
// capabilities in front of the person's review, because the review is the one
// step that cannot run in parallel: what it finds should reach the next
// analyses, and a long queue only waits. Until the first capability is
// reviewed (the pilot), only one is analyzed at a time. Extract changes need
// the archived survey (the glossary and the capability list), not the target
// design. `inReview` counts amendments from the moment they are opened.
export function parallelPlan(root, capabilities, foundation, problems = []) {
  const subagents = setting(root, 'Parallel subagents', 4, 32, problems);
  const ahead = setting(root, 'Analyses ahead of review', 2, 10, problems);
  const analyzing = capabilities.filter((c) => c.extract && c.steps.analyze.status !== 'completed').map((c) => c.capability);
  const inReview = capabilities.filter((c) => (c.extract && c.steps.analyze.status === 'completed') || c.amend).map((c) => c.capability);
  const surveyDone = foundation.find((f) => f.id === 'survey')?.status === 'completed';
  const piloted = capabilities.some((c) => c.baseline || c.extractArchived);
  const limit = piloted ? ahead : 1;
  const busy = analyzing.length + inReview.length;
  // Amendments are not started from nextToAnalyze, so only extract changes can overrun the limit.
  const extracts = capabilities.filter((c) => c.extract).length;
  if (extracts > ahead) problems.push(`${extracts} extract changes are in analysis or review, more than the ${ahead} allowed ahead of the review; finish reviews before starting new analyses`);
  const nextToAnalyze = surveyDone
    ? capabilities.filter((c) => c.planned && c.counted && !c.extract && !c.baseline && !c.extractArchived).slice(0, Math.max(0, limit - busy)).map((c) => c.capability)
    : [];
  // The model each role should run on; "session" means the orchestrator's own.
  const models = Object.fromEntries(['analyst', 'checker', 'implementer'].map((role) => {
    const value = (configValue(root, `${role[0].toUpperCase()}${role.slice(1)} model`, 'session') ?? 'session').replace(/\s+#.*$/, '').trim();
    return [role, value || 'session'];
  }));
  return { subagents, ahead, models, analyzing, inReview, nextToAnalyze };
}

export function checklist(report, { problems = false } = {}) {
  const words = WORDS[report.language] ?? WORDS.en;
  const hereKey = report.current ? (report.current.capability ? `${report.current.capability}:${report.current.step}` : report.current.step) : null;
  const lines = report.todoList.map((item) => `- [${item.status === 'completed' ? 'x' : ' '}] ${item.key === hereKey ? '▶ ' : ''}${item.title}${item.key === hereKey ? ` ← ${words.current}` : ''}`);
  if (problems && report.problems.length) lines.push('', `${words.problems}:`, ...report.problems.map((p) => `- ${p}`));
  return lines.join('\n');
}

export function markdown(report) {
  const words = WORDS[report.language] ?? WORDS.en;
  const cell = (state) => (state.status === 'completed' ? words.done : say(words, state.detail) || (state.status === 'in-progress' ? '…' : words.notStarted));
  const grouped = report.capabilities.some((c) => c.group);
  const head = [...(grouped ? [words.group] : []), words.capability, ...STEPS.map((s) => words[s.id])];
  const rows = report.capabilities.map((c) => `| ${grouped ? `${c.group ?? ''} | ` : ''}\`${c.capability}\`${c.counted === false ? ` (${words.notInPlan})` : ''} | ${STEPS.map((s) => cell(c.steps[s.id])).join(' | ')} |`);
  const lines = [checklist(report)];
  if (rows.length) lines.push('', `| ${head.join(' | ')} |`, `|${head.map(() => '---').join('|')}|`, ...rows);
  if (report.problems.length) lines.push('', `${words.problems}:`, ...report.problems.map((p) => `- ${p}`));
  return lines.join('\n');
}

const ascii = (json) => json.replace(/[\u007f-\uffff]/g, (ch) => `\\u${ch.charCodeAt(0).toString(16).padStart(4, '0')}`);

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
  const todoList = report.todoList.map(({ id, title, description, status: s }) => ({ id, title, description, status: s }));
  if (opts.format === 'todo') console.log(ascii(JSON.stringify({ todoList, checklist: checklist(report), current: report.current, parallel: report.parallel, problems: report.problems }, null, 2)));
  else if (opts.format === 'checklist') console.log(checklist(report, { problems: true }));
  else if (opts.format === 'markdown') console.log(markdown(report));
  else console.log(JSON.stringify({ ...report, checklist: checklist(report) }, null, 2));
  return report.unknown ? 1 : 0;
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
