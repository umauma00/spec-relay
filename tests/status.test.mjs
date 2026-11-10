import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { status, checklist, markdown, planCapabilities, language, main } from '../scripts/status.mjs';
import { tempDir, write, quiet, crlf } from './helpers.mjs';

const PLAN = `# Plan

## Capabilities

### 共通基盤
1. \`common/base\` 共通基盤 (src/common)

### 請求
2. \`billing/invoice\` 請求書
3. \`billing/payment\` 入金

## Follow-up
- \`billing/refund\` fix the rounding bug after the port
`;
const EXTRACT = 'openspec/changes/extract-billing-invoice';

function repo({ plan = PLAN, review = '- [x] R1 a\n- [ ] R2 b\n- [ ] Q1 c decision:\n', artifacts = true } = {}) {
  const dir = tempDir();
  write(dir, 'openspec/config.yaml', 'context: |\n  Artifact language: ja\n');
  if (plan !== null) write(dir, 'openspec/spec-relay/plan.md', plan);
  // common/base: reviewed and ported.
  write(dir, 'openspec/specs/common/base/spec.md', '## Purpose\n');
  write(dir, 'openspec/changes/archive/2026-11-01-extract-common-base/specs/common/base/spec.md', '## Purpose\n');
  write(dir, 'openspec/changes/archive/2026-11-02-port-common-base/tasks.md', '- [x] 1.1 done\n');
  // billing/invoice: analyzed, under review.
  write(dir, `${EXTRACT}/.openspec.yaml`, 'schema: spec-relay-extract\n');
  if (artifacts) {
    write(dir, `${EXTRACT}/specs/billing/invoice/spec.md`, '## Purpose\n');
    for (const file of ['source-map.md', 'trace.md', 'questions.md']) write(dir, `${EXTRACT}/${file}`, '# x\n');
    write(dir, `${EXTRACT}/review.md`, `Reviewer: Uma\n\n${review}`);
  }
  return dir;
}

const statuses = (report) => report.todoList.map((item) => item.status);

test('the plan list is read in order, with groups, and other sections are ignored', () => {
  assert.deepEqual(planCapabilities(crlf(PLAN)), [
    { capability: 'common/base', group: '共通基盤' },
    { capability: 'billing/invoice', group: '請求' },
    { capability: 'billing/payment', group: '請求' },
  ]);
  assert.deepEqual(planCapabilities('## Capabilities\n```\n- `in/fence`\n```\n- `Bad_Name`\n- [ ] `with/box` x\n'), [{ capability: 'with/box', group: null }]);
});

test('one overall line and the steps of the active capability', () => {
  const report = status(repo(), { language: 'ja' });
  assert.equal(report.total, 3);
  assert.equal(report.ported, 1);
  assert.equal(report.reviewed, 1);
  assert.deepEqual(report.todoList.map((item) => item.title), [
    '全体: 3機能のうち1機能が移行済み（仕様確定 1）',
    'billing/invoice: 解析',
    'billing/invoice: レビュー【レビュー待ち 1/3】',
    'billing/invoice: 実装',
  ]);
  assert.deepEqual(statuses(report), ['not-started', 'completed', 'not-started', 'not-started']);
  assert.deepEqual(report.current, { capability: 'billing/invoice', step: 'review', owner: 'person', waiting: true });
  assert.deepEqual(report.todoList.map((item) => item.id), [1, 2, 3, 4]);
  assert.match(checklist(report), /^- \[ \] 全体.*\n- \[x\] billing\/invoice: 解析\n- \[ \] ▶ billing\/invoice: レビュー【レビュー待ち 1\/3】 ← いまここ\n- \[ \] billing\/invoice: 実装$/);
});

test('a waiting step is never in progress; at most one step is', () => {
  const ticked = status(repo({ review: '- [x] R1 a\n' }), { language: 'en' });
  assert.equal(ticked.todoList[2].title, 'billing/invoice: Review [reviewed; waiting for approval to archive]');
  assert.equal(ticked.todoList[2].status, 'not-started');
  const writing = status(repo({ artifacts: false }), { language: 'en' });
  assert.equal(writing.todoList[1].title, 'billing/invoice: Analyze [writing artifacts 0/5]');
  assert.deepEqual(statuses(writing), ['not-started', 'in-progress', 'not-started', 'not-started']);
  for (const report of [ticked, writing]) assert.ok(statuses(report).filter((s) => s === 'in-progress').length <= 1);
});

test('the port step follows tasks.md and the archive', () => {
  const dir = repo();
  fs.rmSync(path.join(dir, EXTRACT), { recursive: true });
  write(dir, 'openspec/specs/billing/invoice/spec.md', '## Purpose\n');
  write(dir, 'openspec/changes/port-billing-invoice/proposal.md', '# p\n');
  const steps = () => status(dir).todoList.slice(1).map((item) => [item.status, item.title.replace(/^billing\/invoice: /, '')]);
  assert.deepEqual(steps(), [['completed', 'Analyze'], ['completed', 'Review'], ['in-progress', 'Implement [writing the design]']]);
  write(dir, 'openspec/changes/port-billing-invoice/tasks.md', '- [x] 1.1 a\n- [ ] 1.2 b\n');
  assert.deepEqual(steps()[2], ['in-progress', 'Implement [tasks 1/2]']);
  write(dir, 'openspec/changes/port-billing-invoice/tasks.md', '- [x] 1.1 a\n- [x] 1.2 b\n');
  assert.deepEqual(steps()[2], ['not-started', 'Implement [all tasks done; waiting for agreement to archive]']);
  fs.renameSync(path.join(dir, 'openspec/changes/port-billing-invoice'), path.join(dir, 'openspec/changes/archive/2026-11-10-port-billing-invoice'));
  // The next capability in plan order becomes current.
  const report = status(dir);
  assert.equal(report.ported, 2);
  assert.equal(report.current.capability, 'billing/payment');
  assert.deepEqual(statuses(report), ['not-started', 'not-started', 'not-started', 'not-started']);
  assert.equal(report.current.step, 'analyze');
});

test('everything ported leaves one completed line', () => {
  const dir = repo({ plan: '## Capabilities\n- `common/base`\n' });
  fs.rmSync(path.join(dir, EXTRACT), { recursive: true });
  const report = status(dir);
  assert.deepEqual(report.todoList.map(({ title, status: s }) => [title, s]), [['Overall: all 1 capabilities ported', 'completed']]);
  assert.equal(report.current, null);
});

test('capabilities missing from the plan still show, after the planned ones', () => {
  const report = status(repo({ plan: null }));
  assert.equal(report.plan, false);
  assert.deepEqual(report.capabilities.map((c) => [c.capability, Boolean(c.unplanned)]), [['billing/invoice', true], ['common/base', true]]);
  assert.equal(report.current.capability, 'billing/invoice');
  const empty = tempDir();
  fs.mkdirSync(path.join(empty, 'openspec'));
  assert.deepEqual(status(empty).todoList, [{ id: 1, key: 'overall', title: 'Overall: no capability plan yet', description: '', status: 'not-started' }]);
});

test('--capability picks the capability to show', () => {
  const report = status(repo(), { capability: 'billing/payment' });
  assert.equal(report.current.capability, 'billing/payment');
  assert.equal(report.current.step, 'analyze');
  assert.ok(status(repo(), { capability: 'no/such' }).problems.includes('capability not found: no/such'));
});

test('language comes from the config, and a UTF-16 file is reported, not trusted', () => {
  const dir = repo();
  assert.equal(language(dir), 'ja');
  assert.equal(language(dir, 'en'), 'en');
  fs.writeFileSync(path.join(dir, EXTRACT, 'review.md'), Buffer.from('﻿- [x] R1 a\n', 'utf16le'));
  const report = status(dir, { language: 'ja' });
  assert.ok(report.problems.some((p) => p.includes('review.md is not UTF-8')));
  assert.match(markdown(report), /読めないファイル/);
});

test('the markdown table lists every capability', () => {
  const text = markdown(status(repo(), { language: 'ja' }));
  assert.match(text, /\| 機能 \| 解析 \| レビュー \| 実装 \|/);
  assert.match(text, /\| `common\/base` \| 完了 \| 完了 \| 完了 \|/);
  assert.match(text, /\| `billing\/invoice` \| 完了 \| レビュー待ち 1\/3 \| - \|/);
  assert.match(text, /\| `billing\/payment` \| - \| - \| - \|/);
});

test('the CLI prints each format and rejects bad usage', () => {
  const dir = repo();
  const out = [];
  const { log } = console;
  console.log = (text) => out.push(text);
  try {
    assert.equal(main(['--root', dir, '--format', 'todo']), 0);
    assert.equal(main(['--root', dir, '--format', 'checklist']), 0);
  } finally { console.log = log; }
  const todo = JSON.parse(out[0]);
  assert.deepEqual(Object.keys(todo), ['todoList', 'current']);
  assert.deepEqual(Object.keys(todo.todoList[0]), ['id', 'title', 'description', 'status']);
  assert.match(out[1], /^- \[ \] 全体/);
  assert.equal(quiet(() => main(['--root', dir, '--format', 'yaml'])), 2);
  assert.equal(quiet(() => main(['--root', tempDir()])), 2);
});
