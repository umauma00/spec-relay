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

test('review items must match requirement names exactly, once each', () => {
  const spec = SPEC.replace('Reject text', 'Add two numbers twice');
  const dir = repo(GOOD.replace('R2 Reject text', 'R2 Add two numbers twice'));
  write(dir, `${CHANGE}/specs/calc/spec.md`, spec);
  assert.equal(checkReview(dir, 'extract-calc').ok, true);
  write(dir, `${CHANGE}/review.md`, GOOD.replace('- [x] R1 Add two numbers\n', '').replace('R2 Reject text', 'R2 Add two numbers twice'));
  assert.match(checkReview(dir, 'extract-calc').problems.join(), /no review item: "Add two numbers"/);
});

test('requirements OpenSpec would archive count even in lower case or comments', () => {
  for (const extra of ['### requirement: Hidden lowercase\n', '<!--\n### Requirement: Commented out\n-->\n']) {
    const dir = repo(GOOD);
    write(dir, `${CHANGE}/specs/calc/spec.md`, SPEC + extra);
    assert.match(checkReview(dir, 'extract-calc').problems.join(), /no review item/, extra);
  }
});

test('boxes count the way OpenSpec counts them, and fenced lines do not count', () => {
  assert.match(checkReview(repo(`${GOOD}1. [ ] C1 Coverage\n`), 'extract-calc').problems.join(), /not ticked: C1/);
  assert.match(checkReview(repo(`${GOOD}<!--\n- [ ] C2 hidden\n-->\n`), 'extract-calc').problems.join(), /not ticked/);
  const fenced = GOOD.replace('- [x] R2 Reject text', '```\n- [x] R2 Reject text\n```');
  assert.match(checkReview(repo(fenced), 'extract-calc').problems.join(), /"Reject text"/);
  const dir = tempDir();
  write(dir, 'openspec/changes/port-calc/tasks.md', '# Tasks\n- [x] 1.1 a\n1. [ ] 1.2 b\n+ [ ] 1.3 c\n');
  assert.equal(checkPortDone(dir, 'port-calc').problems.length, 2);
});

test('questions: missing file, other id formats and placeholder decisions', () => {
  const missing = repo(GOOD);
  fs.rmSync(path.join(missing, `${CHANGE}/questions.md`));
  assert.match(checkReview(missing, 'extract-calc').problems.join(), /questions.md is missing/);
  const formats = repo(GOOD, { questions: '| Id | Q |\n|---|---|\n| Q1 | a |\n1. **Q2** b\n- [Q3] c\n' });
  const problems = checkReview(formats, 'extract-calc').problems.join();
  assert.match(problems, /no review item: Q2/);
  assert.match(problems, /no review item: Q3/);
  assert.ok(checkReview(repo(GOOD.replace('- [x] Q1 Overflow', '- [x] **Q1** Overflow')), 'extract-calc').ok);
  for (const placeholder of ['TBD', '<decision>', '...']) {
    assert.match(checkReview(repo(GOOD.replace('decision: keep', `decision: ${placeholder}`)), 'extract-calc').problems.join(), /no recorded decision/);
  }
  assert.match(checkReview(repo(GOOD.replace('Reviewer: Uma', 'Reviewer: <name>')), 'extract-calc').problems.join(), /no reviewer/);
});

test('port-ready normalises the capability path', () => {
  const dir = tempDir();
  write(dir, 'openspec/specs/billing/invoice/spec.md', SPEC);
  write(dir, 'openspec/changes/extract-billing-invoice/review.md', GOOD);
  for (const cap of ['billing/invoice/', './billing/invoice', 'billing//invoice', 'billing\\invoice']) {
    assert.match(checkPortReady(dir, cap).problems.join(), /still active/, cap);
  }
  assert.equal(checkPortReady(dir, '../x').ok, false);
});

test('CRLF and a UTF-8 BOM are read normally; UTF-16 files fail the gate', () => {
  const crlf = (text) => text.replace(/\n/g, '\r\n');
  const dir = repo(`\uFEFF${crlf(GOOD)}`, { questions: `\uFEFF${crlf(QUESTIONS)}` });
  write(dir, `${CHANGE}/specs/calc/spec.md`, `\uFEFF${crlf(SPEC)}`);
  assert.deepEqual(checkReview(dir, 'extract-calc'), { ok: true, problems: [] });

  // What Windows PowerShell 5.1 writes with `>` or Out-File.
  const utf16 = (text) => Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(text, 'utf16le')]);
  for (const rel of ['questions.md', 'specs/calc/spec.md', 'review.md']) {
    const bad = repo(GOOD.replace('- [x] Q1 Overflow: decision: keep\n', ''), { questions: '# Questions\nNone\n' });
    fs.writeFileSync(path.join(bad, CHANGE, rel), utf16(rel === 'questions.md' ? QUESTIONS : 'x\n'));
    assert.match(checkReview(bad, 'extract-calc').problems.join(), /not UTF-8/, rel);
  }
  const port = tempDir();
  fs.mkdirSync(path.join(port, 'openspec/changes/port-calc'), { recursive: true });
  fs.writeFileSync(path.join(port, 'openspec/changes/port-calc/tasks.md'), utf16('- [x] 1.1 a\n'));
  assert.equal(checkPortDone(port, 'port-calc').ok, false);
});

test('a spec file with no requirements fails the review gate', () => {
  const dir = repo(GOOD);
  write(dir, `${CHANGE}/specs/calc/spec.md`, '## Purpose\n\nNothing here.\n');
  assert.match(checkReview(dir, 'extract-calc').problems.join(), /no requirements found/);
});
