import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { status, checklist, markdown, planCapabilities, language, main } from '../scripts/status.mjs';
import { KIT_ROOT } from '../scripts/setup.mjs';
import { baselineHash } from '../scripts/gate.mjs';
import { tempDir, write, quiet, crlf } from './helpers.mjs';

const PLAN = `# Plan

## Capabilities

### 共通基盤
1. \`common/base\` 共通基盤
   - \`src/common\` (source folder, not a capability)

### 請求
2. \`billing/invoice\` 請求書
3. \`billing/payment\` 入金

## Follow-up
- \`billing/refund\` fix the rounding bug after the port
`;
const EXTRACT = 'openspec/changes/extract-billing-invoice';
const SPEC = '## Purpose\n\n## ADDED Requirements\n\n### Requirement: a\nThe system SHALL a.\n\n### Requirement: b\nThe system SHALL b.\n';
const PASSING = 'Reviewer: Uma\n\n- [x] R1 a\n- [x] R2 b\n- [x] Q1 c decision: keep\n';

function repo({ plan = PLAN, review = '- [x] R1 a\n- [ ] R2 b\n- [ ] Q1 c decision:\n', artifacts = true } = {}) {
  const dir = tempDir();
  write(dir, 'openspec/config.yaml', 'context: |\n  Artifact language: ja\n');
  if (plan !== null) write(dir, 'openspec/spec-relay/plan.md', plan);
  // common/base: reviewed and ported.
  write(dir, 'openspec/specs/common/base/spec.md', '## Purpose\n');
  write(dir, 'openspec/changes/archive/2026-11-01-extract-common-base/specs/common/base/spec.md', '## Purpose\n');
  write(dir, 'openspec/changes/archive/2026-11-02-port-common-base/tasks.md', '- [x] 1.1 done\n');
  // The survey and the target design are done.
  write(dir, 'openspec/changes/archive/2026-10-30-survey/context-map.md', '### Context: billing\n');
  write(dir, 'openspec/changes/archive/2026-10-31-target-design/architecture.md', '# a\n');
  // billing/invoice: analyzed, under review.
  write(dir, `${EXTRACT}/.openspec.yaml`, 'schema: spec-relay-extract\n');
  if (artifacts) {
    write(dir, `${EXTRACT}/specs/billing/invoice/spec.md`, SPEC);
    for (const file of ['source-map.md', 'trace.md']) write(dir, `${EXTRACT}/${file}`, '# x\n');
    write(dir, `${EXTRACT}/screens.md`, '# Screens\nNone\n');
    write(dir, `${EXTRACT}/crosscheck.md`, '| Item | Verdict | Evidence |\n|---|---|---|\n| R1 a | confirmed | x |\n| R2 b | confirmed | x |\n');
    write(dir, `${EXTRACT}/questions.md`, '- Q1. c\n');
    write(dir, `${EXTRACT}/review.md`, review.startsWith('Reviewer') ? review : `Reviewer: Uma\n\n${review}`);
  }
  return dir;
}

const statuses = (report) => report.todoList.map((item) => item.status);
const titles = (report) => report.todoList.map((item) => item.title);
const has = (report, text) => assert.ok(report.problems.some((p) => p.includes(text)), `${text}: ${report.problems}`);

test('the plan list is read in order, with groups; indented items and other sections are ignored', () => {
  assert.deepEqual(planCapabilities(crlf(PLAN)), [
    { capability: 'common/base', group: '共通基盤' },
    { capability: 'billing/invoice', group: '請求' },
    { capability: 'billing/payment', group: '請求' },
  ]);
  assert.deepEqual(planCapabilities('## Capabilities\n```\n- `in/fence`\n```\n- `Bad_Name`\n- [ ] `with/box` x\n'), [{ capability: 'with/box', group: null }]);
  for (const heading of ['## 1. Capabilities', '## Capability list', '## 機能一覧', '## 機能一覧（移行順）', '## ケイパビリティ']) {
    assert.equal(planCapabilities(`${heading}\n- \`a/b\`\n`).length, 1, heading);
  }
  assert.equal(planCapabilities('## 機能外のメモ\n- `a/b`\n').length, 0);
});

test('one overall line and the steps of the active capability', () => {
  const report = status(repo(), { language: 'ja' });
  assert.deepEqual([report.total, report.ported, report.reviewed], [3, 1, 1]);
  assert.deepEqual(titles(report), [
    '全体: 3機能のうち1機能が移行済み（仕様確定 1）',
    'billing/invoice: 解析',
    'billing/invoice: レビュー【レビュー待ち 1/3】',
    'billing/invoice: 実装',
  ]);
  assert.deepEqual(statuses(report), ['not-started', 'completed', 'not-started', 'not-started']);
  assert.deepEqual(report.current, { capability: 'billing/invoice', step: 'review', owner: 'person', waiting: true });
  assert.deepEqual(report.todoList.map((item) => item.id), [1, 2, 3, 4]);
  assert.deepEqual(report.problems, []);
  assert.match(checklist(report), /^- \[ \] 全体.*\n- \[x\] billing\/invoice: 解析\n- \[ \] ▶ billing\/invoice: レビュー【レビュー待ち 1\/3】 ← いまここ\n- \[ \] billing\/invoice: 実装$/);
});

test('the review step says whether the gate passes, and a waiting step is never in progress', () => {
  const ticked = status(repo({ review: '- [x] R1 a\n- [x] R2 b\n- [x] Q1 c decision:\n' }));
  assert.equal(ticked.todoList[2].title, 'billing/invoice: Review [all ticked, but gate.mjs review fails]');
  const passing = status(repo({ review: PASSING }));
  assert.equal(passing.todoList[2].title, 'billing/invoice: Review [reviewed; waiting for approval to archive]');
  const writing = status(repo({ artifacts: false }));
  assert.equal(writing.todoList[1].title, 'billing/invoice: Analyze [writing artifacts 0/7]');
  assert.deepEqual(statuses(writing), ['not-started', 'in-progress', 'not-started', 'not-started']);
  for (const report of [ticked, passing, writing]) {
    assert.equal(report.todoList[2].status, 'not-started');
    assert.ok(statuses(report).filter((s) => s === 'in-progress').length <= 1);
  }
});

test('artifacts are counted from the change schema, so a new artifact needs no code change', () => {
  const dir = repo();
  const schema = fs.readFileSync(path.join(KIT_ROOT, 'openspec-schemas/spec-relay-extract/schema.yaml'), 'utf8')
    .replace('  - id: trace\n', '  - id: notes\n    generates: notes.md  # new\n    requires: []\n    instruction: |\n      generates: not-an-artifact.md\n\n  - id: trace\n');
  write(dir, 'openspec/schemas/spec-relay-extract/schema.yaml', schema);
  const report = status(dir);
  assert.equal(report.todoList[1].title, 'billing/invoice: Analyze [writing artifacts 7/8]');
  write(dir, `${EXTRACT}/notes.md`, '# notes\n');
  assert.equal(status(dir).todoList[1].status, 'completed');
});

test('the port step follows tasks.md and the archive', () => {
  const dir = repo();
  fs.rmSync(path.join(dir, EXTRACT), { recursive: true });
  write(dir, 'openspec/specs/billing/invoice/spec.md', '## Purpose\n');
  write(dir, 'openspec/changes/port-billing-invoice/proposal.md', '# p\n');
  const steps = () => status(dir).todoList.slice(1).map((item) => [item.status, item.title.replace(/^billing\/invoice: /, '')]);
  assert.deepEqual(steps(), [['completed', 'Analyze'], ['completed', 'Review'], ['in-progress', 'Implement [writing the design]']]);
  write(dir, 'openspec/changes/port-billing-invoice/tasks.md', '- [ ] 1.1 a\n- [ ] 1.2 b\n');
  assert.deepEqual(steps()[2], ['not-started', 'Implement [tasks 0/2; starts once the person agrees to the design]']);
  write(dir, 'openspec/changes/port-billing-invoice/tasks.md', '- [x] 1.1 a\n- [ ] 1.2 b\n');
  assert.deepEqual(steps()[2], ['in-progress', 'Implement [tasks 1/2]']);
  write(dir, 'openspec/changes/port-billing-invoice/tasks.md', '- [x] 1.1 a\n- [x] 1.2 b\n');
  assert.deepEqual(steps()[2], ['not-started', 'Implement [all tasks done; waiting for agreement to archive]']);
  fs.renameSync(path.join(dir, 'openspec/changes/port-billing-invoice'), path.join(dir, 'openspec/changes/archive/2026-11-10-port-billing-invoice'));
  // The next capability in plan order becomes current.
  const report = status(dir);
  assert.equal(report.ported, 2);
  assert.deepEqual(report.current, { capability: 'billing/payment', step: 'analyze', owner: 'agent' });
  assert.deepEqual(statuses(report), ['not-started', 'not-started', 'not-started', 'not-started']);
});

test('everything ported leaves one completed line, unless a change is open again', () => {
  const dir = repo({ plan: '## Capabilities\n- `common/base`\n' });
  fs.rmSync(path.join(dir, EXTRACT), { recursive: true });
  const report = status(dir);
  assert.deepEqual(report.todoList.map(({ title, status: s }) => [title, s]), [['Overall: all 1 capabilities ported', 'completed']]);
  assert.equal(report.current, null);
  write(dir, 'openspec/changes/extract-common-base/source-map.md', '# again\n');
  const reopened = status(dir);
  assert.equal(reopened.todoList[0].status, 'not-started');
  assert.equal(reopened.current.capability, 'common/base');
  assert.equal(reopened.todoList[1].status, 'in-progress');
});

test('a plan without a readable list never reads as finished', () => {
  const dir = repo({ plan: '# Plan\n\n## Things to port\n- `common/base`\n- `billing/invoice`\n' });
  fs.rmSync(path.join(dir, EXTRACT), { recursive: true });
  const report = status(dir);
  assert.equal(report.todoList[0].title, 'Overall: no capability list in the plan yet');
  assert.equal(report.todoList[0].status, 'not-started');
  has(report, 'has no capability list');
});

test('a plan item that cannot be read is reported and blocks "all ported"', () => {
  const dir = repo({ plan: '## Capabilities\n1. `common/base`\n2. **`billing/two`**\n3. `Billing/Three`\n - `one/space`\n- plain note\n' });
  fs.rmSync(path.join(dir, EXTRACT), { recursive: true });
  const report = status(dir);
  assert.equal(report.total, 2);
  assert.equal(report.todoList[0].status, 'not-started');
  has(report, '"2. **`billing/two`**" is not read as a capability');
  has(report, '"3. `Billing/Three`" is not read as a capability');
  assert.equal(report.problems.length, 2);
});

test('without a plan, openspec/ alone gives the list; with one, unplanned specs are shown but not counted', () => {
  const report = status(repo({ plan: null }));
  assert.equal(report.plan, false);
  assert.deepEqual(report.capabilities.map((c) => c.capability), ['billing/invoice', 'common/base']);
  assert.equal(report.current.capability, 'billing/invoice');
  const empty = tempDir();
  fs.mkdirSync(path.join(empty, 'openspec'));
  assert.deepEqual(status(empty).todoList.map(({ key, status: st }) => [key, st]), [['overall', 'not-started'], ['survey', 'not-started'], ['target', 'not-started']]);
  assert.deepEqual(status(empty).current, { capability: null, step: 'survey', owner: 'agent' });

  const dir = repo();
  write(dir, 'openspec/specs/auth/spec.md', '## Purpose\n');
  const withExtra = status(dir);
  assert.equal(withExtra.total, 3);
  assert.deepEqual(withExtra.capabilities.find((c) => c.capability === 'auth').counted, false);
  assert.match(markdown(withExtra), /`auth` \(not in the plan\)/);
});

test('mismatched and colliding names, a missing baseline and overlapping changes are reported', () => {
  const dir = repo({ plan: `${PLAN.replace('3. `billing/payment` 入金', '3. `billing/payment` 入金\n4. `billing-invoice` dup')}` });
  write(dir, 'openspec/changes/extract-billing-payment/specs/payment/spec.md', SPEC);
  write(dir, 'openspec/changes/port-billing-invoice/proposal.md', '# p\n');
  fs.mkdirSync(path.join(dir, 'openspec/changes/archive/2026-11-03-extract-legacy'), { recursive: true });
  write(dir, 'openspec/changes/archive/2026-11-03-extract-legacy/specs/legacy/spec.md', '## Purpose\n');
  const report = status(dir);
  has(report, 'billing/invoice and billing-invoice share the change names');
  has(report, 'change extract-billing-payment has its spec at specs/payment/spec.md');
  has(report, 'port-billing-invoice is active while extract-billing-invoice is still active');
  // Analyze and Implement are never both in progress.
  write(dir, 'openspec/changes/port-billing-invoice/tasks.md', '- [x] 1.1 a\n- [ ] 1.2 b\n');
  fs.rmSync(path.join(dir, `${EXTRACT}/trace.md`));
  const overlap = status(dir, { capability: 'billing/invoice' });
  assert.deepEqual(statuses(overlap).slice(1, 4), ['in-progress', 'not-started', 'not-started']);
  // An archived extract whose baseline never appeared.
  write(dir, 'openspec/changes/archive/2026-11-04-extract-billing-payment/source-map.md', '# x\n');
  fs.rmSync(path.join(dir, 'openspec/changes/extract-billing-payment'), { recursive: true });
  has(status(dir), 'extract-billing-payment is archived, but there is no baseline spec');
  assert.equal(status(dir, { capability: 'billing/payment' }).todoList[1].title, 'billing/payment: Analyze [archived, but no baseline spec]');
});

test('--capability picks the capability to show', () => {
  const report = status(repo(), { capability: 'billing\\payment' });
  assert.equal(report.current.capability, 'billing/payment');
  assert.equal(report.current.step, 'analyze');
  const missing = status(repo(), { capability: 'no/such' });
  assert.equal(missing.unknown, true);
  has(missing, 'capability not found: no/such');
});

test('language comes from the config, and a UTF-16 file is reported with its path', () => {
  const dir = repo();
  assert.equal(language(dir), 'ja');
  assert.equal(language(dir, 'en'), 'en');
  write(dir, 'openspec/config.yaml', 'context: |\n  Artifact language: "ja"\n');
  assert.equal(language(dir), 'ja');
  fs.writeFileSync(path.join(dir, EXTRACT, 'review.md'), Buffer.from('﻿- [x] R1 a\n', 'utf16le'));
  fs.writeFileSync(path.join(dir, 'openspec/spec-relay/plan.md'), Buffer.from(`﻿${PLAN}`, 'utf16le'));
  const report = status(dir, { language: 'ja' });
  has(report, 'openspec/changes/extract-billing-invoice/review.md is not UTF-8');
  has(report, 'openspec/spec-relay/plan.md is not UTF-8');
  assert.ok(!report.problems.some((p) => p.includes('has no capability list')));
  assert.match(checklist(report, { problems: true }), /問題:\n- /);
});

test('the markdown table lists every capability with its group', () => {
  const text = markdown(status(repo(), { language: 'ja' }));
  assert.match(text, /\| グループ \| 機能 \| 解析 \| レビュー \| 実装 \|/);
  assert.match(text, /\| 共通基盤 \| `common\/base` \| 完了 \| 完了 \| 完了 \|/);
  assert.match(text, /\| 請求 \| `billing\/invoice` \| 完了 \| レビュー待ち 1\/3 \| - \|/);
  assert.match(text, /\| 請求 \| `billing\/payment` \| - \| - \| - \|/);
});

test('the CLI prints each format, keeps the TODO JSON ASCII-only and exits 1 for an unknown capability', () => {
  const dir = repo();
  const out = [];
  const { log } = console;
  console.log = (text) => out.push(text);
  try {
    for (const format of ['todo', 'checklist', 'markdown', 'json']) assert.equal(main(['--root', dir, '--format', format]), 0);
    assert.equal(main(['--root', dir, '--format', 'todo', '--capability', 'no/such']), 1);
  } finally { console.log = log; }
  assert.match(out[0], /^[\x00-\x7f]*$/);
  const todo = JSON.parse(out[0]);
  assert.deepEqual(Object.keys(todo), ['todoList', 'checklist', 'current', 'parallel', 'problems']);
  assert.deepEqual(Object.keys(todo.todoList[0]), ['id', 'title', 'description', 'status']);
  assert.match(todo.todoList[0].title, /^全体/);
  assert.match(todo.checklist, /← いまここ/);
  assert.match(out[1], /^- \[ \] 全体/);
  assert.match(out[2], /\| 機能 \|/);
  assert.equal(JSON.parse(out[3]).total, 3);
  assert.deepEqual(JSON.parse(out[4]).problems, ['capability not found: no/such']);
  assert.equal(quiet(() => main(['--root', dir, '--format', 'yaml'])), 2);
  assert.equal(quiet(() => main(['--root', tempDir()])), 2);
});

test('it runs as a script from the repository folder', () => {
  const dir = repo();
  const result = spawnSync(process.execPath, [path.join(KIT_ROOT, 'scripts/status.mjs'), '--format', 'todo'], { cwd: dir, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).current.capability, 'billing/invoice');
});

test('the survey and the target design come before any capability', () => {
  const dir = tempDir();
  write(dir, 'openspec/config.yaml', 'context: |\n  Artifact language: ja\n');
  write(dir, 'openspec/changes/survey/.openspec.yaml', 'schema: spec-relay-survey\n');
  write(dir, 'openspec/changes/survey/inventory.md', '# i\n');
  let report = status(dir);
  assert.deepEqual(report.todoList.map((i) => i.title).slice(1), ['Survey: map the bounded contexts [writing artifacts 1/5]', 'Target design: modules, conventions, verification']);
  assert.deepEqual(statuses(report), ['not-started', 'in-progress', 'not-started']);
  for (const f of ['context-map.md', 'glossary.md', 'capabilities.md']) write(dir, `openspec/changes/survey/${f}`, '# x\n');
  write(dir, 'openspec/changes/survey/review.md', 'Reviewer: Uma\n- [ ] K1 billing\n');
  report = status(dir);
  assert.equal(report.todoList[1].title, 'Survey: map the bounded contexts [waiting for review 0/1]');
  assert.deepEqual(report.current, { capability: null, step: 'survey', owner: 'person', waiting: true });
  assert.match(checklist(report), /▶ Survey/);
  fs.mkdirSync(path.join(dir, 'openspec/changes/archive'));
  fs.renameSync(path.join(dir, 'openspec/changes/survey'), path.join(dir, 'openspec/changes/archive/2026-11-10-survey'));
  write(dir, 'openspec/changes/archive/2026-11-11-target-design-v2/architecture.md', '# a\n');
  write(dir, 'openspec/spec-relay/plan.md', '## Capabilities\n### billing\n1. `billing/invoice` 請求書\n');
  report = status(dir);
  assert.deepEqual(report.foundation.map((f) => f.status), ['completed', 'completed']);
  assert.equal(report.current.capability, 'billing/invoice');
});

test('an amendment holds the review step, and reruns (-v2) count as their base change', () => {
  const dir = repo();
  fs.rmSync(path.join(dir, EXTRACT), { recursive: true });
  write(dir, 'openspec/specs/billing/invoice/spec.md', SPEC);
  write(dir, 'openspec/changes/archive/2026-11-03-extract-billing-invoice/review.md', 'x');
  write(dir, 'openspec/changes/archive/2026-11-04-port-billing-invoice/tasks.md', '- [x] 1.1 a\n');
  write(dir, 'openspec/changes/amend-billing-invoice/.openspec.yaml', 'schema: spec-relay-amend\n');
  write(dir, 'openspec/changes/amend-billing-invoice/reason.md', '# r\n');
  let report = status(dir, { capability: 'billing/invoice' });
  assert.deepEqual(report.todoList.slice(1).map((i) => [i.status, i.title]), [
    ['completed', 'billing/invoice: Analyze'], ['in-progress', 'billing/invoice: Review [writing artifacts 1/6]'], ['completed', 'billing/invoice: Implement'],
  ]);
  fs.renameSync(path.join(dir, 'openspec/changes/amend-billing-invoice'), path.join(dir, 'openspec/changes/archive/2026-11-05-amend-billing-invoice'));
  write(dir, 'openspec/changes/port-billing-invoice-v2/tasks.md', '- [x] 1.1 a\n- [ ] 1.2 b\n');
  report = status(dir, { capability: 'billing/invoice' });
  assert.deepEqual(report.todoList[3].title, 'billing/invoice: Implement [tasks 1/2]');
  assert.deepEqual(report.active, ['billing/invoice']);
});

test('a port archived before an amendment is not done; -v plan names are reported; --capability shows steps early', () => {
  const dir = repo();
  fs.rmSync(path.join(dir, EXTRACT), { recursive: true });
  write(dir, 'openspec/specs/billing/invoice/spec.md', SPEC);
  write(dir, 'openspec/changes/archive/2026-11-03-extract-billing-invoice/review.md', 'x');
  const hash = baselineHash(dir, 'billing/invoice');
  write(dir, 'openspec/changes/archive/2026-11-04-port-billing-invoice/proposal.md', `- \`billing/invoice\` sha256:${hash}\n`);
  assert.equal(status(dir, { capability: 'billing/invoice' }).todoList[3].status, 'completed');
  write(dir, 'openspec/specs/billing/invoice/spec.md', `${SPEC}\n### Requirement: c\nThe system SHALL c.\n`);
  const stale = status(dir, { capability: 'billing/invoice' }).todoList[3];
  assert.deepEqual([stale.status, stale.title], ['not-started', 'billing/invoice: Implement [the spec was amended after the port; port it again]']);

  has(status(repo({ plan: '## Capabilities\n- `api/v1`\n' })), 'ending like a rerun suffix');

  const early = repo();
  fs.rmSync(path.join(early, 'openspec/changes/archive/2026-10-31-target-design'), { recursive: true });
  // An extract change opened during the target design's review shows its steps.
  assert.deepEqual(status(early).todoList.map((i) => i.key), ['overall', 'survey', 'target', 'billing/invoice:analyze', 'billing/invoice:review', 'billing/invoice:implement']);
  fs.rmSync(path.join(early, EXTRACT), { recursive: true });
  assert.deepEqual(status(early).todoList.map((i) => i.key), ['overall', 'survey', 'target']);
  assert.deepEqual(status(early, { capability: 'billing/invoice' }).todoList.map((i) => i.key), ['overall', 'survey', 'target', 'billing/invoice:analyze', 'billing/invoice:review', 'billing/invoice:implement']);
  assert.equal(status(early, { capability: 'billing/invoice' }).current.step, 'target');
});

test('parallel work: one line per other active capability, and what may be analyzed next', () => {
  const dir = repo({ plan: PLAN.replace('3. `billing/payment` 入金', '3. `billing/payment` 入金\n4. `billing/tax` 税\n5. `billing/refund` 返金') });
  write(dir, 'openspec/changes/extract-billing-payment/.openspec.yaml', 'schema: spec-relay-extract\n');
  write(dir, 'openspec/changes/extract-billing-payment/source-map.md', '# m\n');
  const report = status(dir);
  assert.equal(report.current.capability, 'billing/invoice');
  assert.deepEqual(report.todoList.map((i) => i.key).slice(-1), ['billing/payment:analyze']);
  assert.equal(report.todoList.at(-1).status, 'in-progress');
  assert.deepEqual(report.parallel, { subagents: 4, ahead: 2, models: { analyst: 'session', checker: 'session', implementer: 'session' }, analyzing: ['billing/payment'], inReview: ['billing/invoice'], nextToAnalyze: [] });

  // The limits come from openspec/config.yaml; a bad value falls back to the default.
  const config = fs.readFileSync(path.join(dir, 'openspec/config.yaml'), 'utf8');
  write(dir, 'openspec/config.yaml', `${config}\ncontext: |\n  Parallel subagents (at once, whole session): 16\n  Analyses ahead of review: 3\n  Analyst model: claude-sonnet-5.5\n  Checker model: Claude Opus 5.5  # a second opinion\n  Implementer model: session\n`);
  assert.deepEqual(status(dir).parallel, { subagents: 16, ahead: 3, models: { analyst: 'claude-sonnet-5.5', checker: 'Claude Opus 5.5', implementer: 'session' }, analyzing: ['billing/payment'], inReview: ['billing/invoice'], nextToAnalyze: ['billing/tax'] });
  for (const bad of ['99', '"16"', '1e1', '8.0']) {
    write(dir, 'openspec/config.yaml', `${config}\ncontext: |\n  Parallel subagents (at once, whole session): ${bad}\n`);
    const report = status(dir);
    assert.equal(report.parallel.subagents, 4, bad);
    has(report, `"Parallel subagents" is "${bad}"`);
  }
  // More in flight than allowed is reported.
  write(dir, 'openspec/config.yaml', `${config}\ncontext: |\n  Analyses ahead of review: 1\n`);
  has(status(dir), '2 extract changes are in analysis or review, more than the 1 allowed');

  // The pilot: until one capability is reviewed, one analysis at a time.
  const fresh = repo({ plan: PLAN });
  for (const rel of ['openspec/specs', 'openspec/changes/archive/2026-11-01-extract-common-base', 'openspec/changes/archive/2026-11-02-port-common-base', EXTRACT]) fs.rmSync(path.join(fresh, rel), { recursive: true });
  assert.deepEqual(status(fresh).parallel.nextToAnalyze, ['common/base']);
  for (const name of ['common-base', 'billing-invoice']) write(fresh, `openspec/changes/extract-${name}/.openspec.yaml`, 'schema: spec-relay-extract\n');
  has(status(fresh), '2 extract changes are in analysis or review before the first capability was reviewed');

  // A quoted model name loses its quotes, and "Session" is the session model.
  write(dir, 'openspec/config.yaml', `${config}\ncontext: |\n  Analyst model: "claude-sonnet-5.5"\n  Checker model: Session\n`);
  assert.deepEqual(status(dir).parallel.models, { analyst: 'claude-sonnet-5.5', checker: 'session', implementer: 'session' });

  // Nothing is analyzed before the survey is archived.
  fs.rmSync(path.join(dir, 'openspec/changes/archive'), { recursive: true });
  write(dir, 'openspec/config.yaml', `${config}\ncontext: |\n  Analyses ahead of review: 5\n`);
  assert.deepEqual(status(dir).parallel.nextToAnalyze, []);
});
