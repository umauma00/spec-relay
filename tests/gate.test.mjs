import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { checkReview, checkPortReady, checkPortDone } from '../scripts/gate.mjs';
import { tempDir, write } from './helpers.mjs';

const CHANGE = 'openspec/changes/extract-calc';
const SPEC = `## Purpose\n\nAdds numbers.\n\n## ADDED Requirements\n\n### Requirement: Add two numbers\nThe system SHALL add.\n\n#### Scenario: s\n- **WHEN** x\n- **THEN** y\n\n### Requirement: Reject text\nThe system SHALL reject text.\n\n#### Scenario: t\n- **WHEN** x\n- **THEN** y\n`;
const QUESTIONS = '# Questions\n\n## Suspected bugs\n- Q1. Overflow wraps - keep or fix?\n\n## Ambiguities\nNone\n';
const GOOD = 'Reviewer: Uma\n\n## 1. Requirements\n- [x] R1 Add two numbers\n- [x] R2 Reject text\n\n## 2. Questions\n- [x] Q1 Overflow: decision: keep\n';

function repo(review, { questions = QUESTIONS } = {}) {
  const dir = tempDir();
  write(dir, `${CHANGE}/specs/calc/spec.md`, SPEC);
  write(dir, `${CHANGE}/questions.md`, questions);
  if (review !== null) write(dir, `${CHANGE}/review.md`, review);
  return dir;
}

test('a complete, ticked review passes', () => {
  assert.deepEqual(checkReview(repo(GOOD), 'extract-calc'), { ok: true, problems: [] });
});

test('review gate failures', () => {
  const cases = {
    'review.md is missing': null,
    'no checklist items': 'Reviewer: Uma\n',
    'not ticked: R2': GOOD.replace('- [x] R2', '- [ ] R2'),
    'no review item: "Reject text"': GOOD.replace('- [x] R2 Reject text\n', ''),
    'no review item: Q1': GOOD.replace('- [x] Q1 Overflow: decision: keep\n', ''),
    'no recorded decision: Q1': GOOD.replace('decision: keep', 'decision:'),
    'names no reviewer': GOOD.replace('Reviewer: Uma', 'Reviewer: <!-- name -->'),
  };
  for (const [expected, review] of Object.entries(cases)) {
    const result = checkReview(repo(review), 'extract-calc');
    assert.equal(result.ok, false, expected);
    assert.ok(result.problems.some((p) => p.includes(expected)), `${expected}: ${result.problems}`);
  }
});

test('ticks inside HTML comments do not count', () => {
  const result = checkReview(repo(`${GOOD.replace('- [x] R2 Reject text', '<!-- - [x] R2 Reject text -->')}`), 'extract-calc');
  assert.ok(result.problems.some((p) => p.includes('"Reject text"')));
});

test('port-ready needs a baseline and no active extract change', () => {
  const dir = tempDir();
  assert.match(checkPortReady(dir, 'billing/invoice').problems.join(), /no baseline spec/);
  write(dir, 'openspec/specs/billing/invoice/spec.md', SPEC);
  write(dir, 'openspec/changes/extract-billing-invoice/review.md', GOOD);
  assert.match(checkPortReady(dir, 'billing/invoice').problems.join(), /still active/);
  fs.rmSync(path.join(dir, 'openspec/changes/extract-billing-invoice'), { recursive: true });
  assert.deepEqual(checkPortReady(dir, 'billing/invoice'), { ok: true, problems: [] });
});

test('port-done needs at least one task and every task done', () => {
  const dir = tempDir();
  assert.equal(checkPortDone(dir, 'port-calc').ok, false);
  write(dir, 'openspec/changes/port-calc/tasks.md', '# Tasks\n');
  assert.match(checkPortDone(dir, 'port-calc').problems.join(), /no tasks/);
  write(dir, 'openspec/changes/port-calc/tasks.md', '# Tasks\n- [x] 1.1 a\n- [ ] 1.2 b\n');
  assert.match(checkPortDone(dir, 'port-calc').problems.join(), /not done: 1.2 b/);
  write(dir, 'openspec/changes/port-calc/tasks.md', '# Tasks\n- [x] 1.1 a\n- [X] 1.2 b\n');
  assert.equal(checkPortDone(dir, 'port-calc').ok, true);
});
