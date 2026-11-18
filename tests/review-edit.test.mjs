import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { editReview, writeReview, canvasEdits, sha256 } from '../scripts/review-edit.mjs';
import { tempDir, write } from './helpers.mjs';

const REVIEW = '# Review: extract-a\n\nReviewer:\n\n## 1. Requirements\n- [ ] R1 Password\n- [x] **R2** Lockout\n\n```\n- [ ] R3 in a fence\n```\n\n## 2. Questions\n- [ ] Q1 Rounding: decision: <!-- the person writes -->\n- [ ] Q2 Tax\n';

test('ticks, unticks, decisions and the reviewer change only their own line', () => {
  const tick = editReview(REVIEW, { action: 'tick', id: 'R1' });
  assert.match(tick.text, /^- \[x\] R1 Password$/m);
  assert.equal(tick.text.replace('- [x] R1', '- [ ] R1'), REVIEW, 'nothing else moves');
  assert.match(editReview(REVIEW, { action: 'untick', id: 'R2' }).text, /^- \[ \] \*\*R2\*\* Lockout$/m, 'emphasis around the id still finds the line');
  assert.match(editReview(REVIEW, { action: 'tick', id: 'R3' }).problem, /no line for R3/, 'a line in a code fence is not an item');
  assert.match(editReview(REVIEW, { action: 'tick', id: 'Q1' }).problem, /write the decision first/, 'a question is ticked only with a decision');
  assert.match(editReview(REVIEW, { action: 'tick', id: 'Q2' }).problem, /write the decision first/);
  const decided = editReview(REVIEW, { action: 'decision', id: 'Q1', value: 'Round half up\n- [x] R1 forged' });
  assert.match(decided.text, /^- \[ \] Q1 Rounding: decision: Round half up - \[x\] R1 forged$/m, 'the decision is one line, replacing the old one');
  assert.match(decided.text, /^- \[ \] R1 Password$/m);
  assert.match(editReview(decided.text, { action: 'tick', id: 'Q1' }).text, /^- \[x\] Q1 Rounding: decision: Round half up/m);
  assert.match(editReview(REVIEW, { action: 'decision', id: 'Q2', value: 'none' }).text, /^- \[ \] Q2 Tax: decision: none$/m);
  assert.match(editReview(REVIEW, { action: 'reviewer', value: ' Uma\u2028 Tanaka ' }).text, /^Reviewer: Uma Tanaka$/m);
  assert.match(editReview('# Review\n\n- [ ] R1 a\n', { action: 'reviewer', value: 'Uma' }).text, /^# Review\n\nReviewer: Uma\n/, 'a missing Reviewer line goes under the title');
  for (const bad of [{ action: 'reviewer', value: ' ' }, { action: 'decision', id: 'Q1', value: '' }, { action: 'tick', id: 'R1; rm' }, { action: 'delete', id: 'R1' }]) assert.ok(editReview(REVIEW, bad).problem, JSON.stringify(bad));
  // Windows files: the byte order mark and CRLF line ends are kept.
  const crlf = `\uFEFF${REVIEW.replace(/\n/g, '\r\n')}`;
  const out = editReview(crlf, { action: 'tick', id: 'R1' }).text;
  assert.ok(out.startsWith('\uFEFF'));
  assert.equal(out, crlf.replace('- [ ] R1', '- [x] R1'));
});

test('a write needs the hash the page was built from, swaps the file in whole and is logged', () => {
  const dir = tempDir();
  write(dir, 'openspec/changes/extract-a/review.md', REVIEW);
  const file = path.join(dir, 'openspec/changes/extract-a/review.md');
  const hash = sha256(fs.readFileSync(file));
  assert.deepEqual(writeReview(dir, 'extract-a', { action: 'tick', id: 'R1', hash: 'old' }).status, 409);
  assert.equal(fs.readFileSync(file, 'utf8'), REVIEW, 'a stale page writes nothing');
  assert.equal(writeReview(dir, 'extract-b', { action: 'tick', id: 'R1', hash }).status, 404);
  assert.equal(writeReview(dir, 'extract-a', { action: 'tick', id: 'Q2', hash }).status, 400);
  const done = writeReview(dir, 'extract-a', { action: 'tick', id: 'R1', hash });
  assert.equal(done.ok, true);
  assert.equal(done.hash, sha256(fs.readFileSync(file)));
  assert.deepEqual(writeReview(dir, 'extract-a', { action: 'tick', id: 'R1', hash: done.hash }), { ok: true, hash: done.hash, unchanged: true });
  assert.deepEqual(fs.readdirSync(path.dirname(file)).filter((f) => f.endsWith('.tmp')), [], 'no temporary file is left');
  const log = canvasEdits(dir);
  assert.equal(log.length, 1, 'a write that changes nothing is not logged');
  assert.deepEqual({ ...log[0], time: 't' }, { time: 't', file: 'openspec/changes/extract-a/review.md', action: 'tick', id: 'R1', before: hash, after: done.hash });
  assert.deepEqual(canvasEdits(dir, { since: log[0].time }), []);
  assert.deepEqual(canvasEdits(tempDir()), []);
});
