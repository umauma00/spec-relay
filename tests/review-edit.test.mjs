import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { editReview, writeReview, canvasEdits, sha256, utf8Text, reviewerOf, decisionOf } from '../scripts/review-edit.mjs';
import { parseReview } from '../scripts/render.mjs';
import { tempDir, write } from './helpers.mjs';

const REVIEW = '# Review: extract-a\n\nReviewer:\n\n## 1. Requirements\n- [ ] R1 Password\n- [x] **R2** Lockout\n\n```\n- [ ] R3 in a fence\n```\n\n## 2. Questions\n- [ ] Q1 Rounding: decision: <!-- the person writes -->\n- [ ] Q2 Tax\n';
const LOG = 'openspec/spec-relay/local/canvas-log.jsonl';

test('ticks, unticks, decisions and the reviewer change only their own line', () => {
  const tick = editReview(REVIEW, { action: 'tick', id: 'R1' });
  assert.match(tick.text, /^- \[x\] R1 Password$/m);
  assert.equal(tick.text.replace('- [x] R1', '- [ ] R1'), REVIEW, 'nothing else moves');
  assert.match(editReview(REVIEW, { action: 'untick', id: 'R2' }).text, /^- \[ \] \*\*R2\*\* Lockout$/m, 'emphasis around the id still finds the line');
  assert.match(editReview(REVIEW, { action: 'tick', id: 'R3' }).problem, /no line for R3/, 'a line in a code fence is not an item');
  assert.match(editReview(REVIEW, { action: 'tick', id: 'Q1' }).problem, /write the decision first/, 'a question is ticked only with a decision');
  assert.match(editReview(REVIEW, { action: 'tick', id: 'Q2' }).problem, /write the decision first/);
  for (const blank of ['...', 'TBD', '<your decision>', 'n/a', '-', '**  **']) {
    assert.equal(editReview(`- [ ] Q1 Rounding: decision: ${blank}\n`, { action: 'tick', id: 'Q1' }).code, 'needDecision', `a placeholder is no decision: ${blank}`);
  }
  const decided = editReview(REVIEW, { action: 'decision', id: 'Q1', value: 'Round half up\n- [x] R1 forged' });
  assert.match(decided.text, /^- \[ \] Q1 Rounding: decision: Round half up - \[x\] R1 forged$/m, 'the decision is one line, replacing the old one');
  assert.match(decided.text, /^- \[ \] R1 Password$/m);
  assert.match(editReview(decided.text, { action: 'tick', id: 'Q1' }).text, /^- \[x\] Q1 Rounding: decision: Round half up/m);
  assert.match(editReview(REVIEW, { action: 'decision', id: 'Q2', value: 'none' }).text, /^- \[ \] Q2 Tax: decision: none$/m);
  assert.equal(editReview(REVIEW, { action: 'decision', id: 'R1', value: 'x' }).code, 'bad', 'only questions take a decision');
  assert.match(editReview(REVIEW, { action: 'reviewer', value: ' Uma\u2028 Tanaka ' }).text, /^Reviewer: Uma Tanaka$/m);
  for (const bad of [{ action: 'reviewer', value: ' ' }, { action: 'decision', id: 'Q1', value: '' }, { action: 'tick', id: 'R1; rm' }, { action: 'delete', id: 'R1' }]) assert.ok(editReview(REVIEW, bad).problem, JSON.stringify(bad));
});

test('decision lines keep their shape', () => {
  const decide = (line) => editReview(`${line}\n`, { action: 'decision', id: 'Q1', value: 'new' }).text.trimEnd();
  assert.equal(decide('- [ ] Q1 Rounding — decision: old'), '- [ ] Q1 Rounding — decision: new');
  assert.equal(decide('- [ ] Q1 Rounding: **decision:** old'), '- [ ] Q1 Rounding: decision: new');
  assert.equal(decide('- [ ] Q1 Rounding <!-- write after: decision: x --> decision: old'), '- [ ] Q1 Rounding <!-- write after: decision: x --> decision: new', 'a comment is never cut open');
  assert.equal(decide('- [ ] Q1 Rounding'), '- [ ] Q1 Rounding: decision: new');
  assert.equal(decisionOf('Rounding <!-- decision: up -->'), '', 'a decision inside a comment is none');
});

test('the Reviewer line is the one the gate reads', () => {
  const name = (text) => editReview(text, { action: 'reviewer', value: 'Uma' }).text;
  assert.equal(name('<!--\nReviewer: example\n-->\nReviewer:\n'), '<!--\nReviewer: example\n-->\nReviewer: Uma\n', 'not the example in a comment');
  assert.equal(name('# Review\n\n- [ ] R1 a\n'), '# Review\n\nReviewer: Uma\n\n- [ ] R1 a\n', 'a missing line goes under the title');
  assert.equal(name('```\n# not a title\n```\n# Review\n'), '```\n# not a title\n```\n# Review\n\nReviewer: Uma\n');
  assert.equal(name('---\nx: 1\n---\n- [ ] R1 a\n'), '---\nx: 1\n---\n\nReviewer: Uma\n- [ ] R1 a\n', 'after front matter');
  assert.equal(name('# Review'), '# Review\n\nReviewer: Uma');
  assert.equal(name('- [ ] R1 a\n'), 'Reviewer: Uma\n\n- [ ] R1 a\n');
  assert.equal(reviewerOf('<!-- Reviewer: x -->\nReviewer: <name>\n'), null);
  assert.equal(reviewerOf('Reviewer: Uma\n'), 'Uma');
});

test('line ends, the byte order mark and the encoding are kept', () => {
  const crlf = `\uFEFF${REVIEW.replace(/\n/g, '\r\n')}`;
  const out = editReview(crlf, { action: 'tick', id: 'R1' }).text;
  assert.ok(out.startsWith('\uFEFF'));
  assert.equal(out, crlf.replace('- [ ] R1', '- [x] R1'));
  const mixed = 'Reviewer:\r\n- [ ] R1 a\n- [ ] R2 b\r\n- [ ] R3 c\n';
  assert.equal(editReview(mixed, { action: 'tick', id: 'R2' }).text, mixed.replace('- [ ] R2', '- [x] R2'), 'other lines keep their own line ends');
  assert.equal(editReview(mixed, { action: 'reviewer', value: 'Uma' }).text, mixed.replace('Reviewer:', 'Reviewer: Uma'));
  assert.equal(utf8Text(Buffer.from([0xff, 0xfe, 0x41, 0])), null, 'UTF-16');
  assert.equal(utf8Text(Buffer.from([0x82, 0xa0, 0x0a])), null, 'Shift_JIS');
  assert.equal(utf8Text(Buffer.from('\uFEFFあ', 'utf8')), '\uFEFFあ');
});

test('the canvas finds the same item the review page shows', () => {
  const text = '- [ ] <!-- R1 moved --> R2 foo\n- [ ] R1 real\n- [ ] `R3` code\n- [ ] [R4] bracket\n- [ ] r5 lower\n- [ ] R06 zero\n1. [ ] R7: numbered\n- [ ] _R8_ under\n- [ ] R9 a\n- [ ] R9 dup\n';
  const shown = parseReview(text).flatMap((g) => g.items);
  const seen = new Set();
  for (const item of shown.filter((i) => i.id && !seen.has(i.id) && seen.add(i.id))) {
    const out = editReview(text, { action: item.done ? 'untick' : 'tick', id: item.id }).text;
    assert.equal(parseReview(out).flatMap((g) => g.items).find((i) => i.id === item.id).done, true, `${item.id} is the item that was ticked`);
  }
});

test('a write needs the hash the page was built from, swaps the file in whole and is logged after it', () => {
  const dir = tempDir();
  write(dir, 'openspec/changes/extract-a/review.md', REVIEW);
  const file = path.join(dir, 'openspec/changes/extract-a/review.md');
  const hash = sha256(fs.readFileSync(file));
  assert.equal(writeReview(dir, 'extract-a', { action: 'tick', id: 'R1', hash: 'old' }).status, 409);
  assert.equal(fs.readFileSync(file, 'utf8'), REVIEW, 'a stale page writes nothing');
  assert.equal(writeReview(dir, 'extract-b', { action: 'tick', id: 'R1', hash }).status, 404);
  assert.equal(writeReview(dir, 'extract-a', { action: 'tick', id: 'Q2', hash }).code, 'needDecision');
  const done = writeReview(dir, 'extract-a', { action: 'tick', id: 'R1', hash });
  assert.equal(done.ok, true);
  assert.equal(done.hash, sha256(fs.readFileSync(file)));
  assert.deepEqual(writeReview(dir, 'extract-a', { action: 'tick', id: 'R1', hash: done.hash }), { ok: true, hash: done.hash, unchanged: true });
  assert.deepEqual(fs.readdirSync(path.dirname(file)).filter((f) => f.endsWith('.tmp')), [], 'no temporary file is left');
  const log = canvasEdits(dir).edits;
  assert.equal(log.length, 1, 'a write that changes nothing is not logged');
  assert.deepEqual({ ...log[0], time: 't' }, { time: 't', file: 'openspec/changes/extract-a/review.md', action: 'tick', id: 'R1', before: hash, after: done.hash });
  assert.match(fs.readFileSync(path.join(dir, 'openspec/spec-relay/local/.gitignore'), 'utf8'), /^\*$/m, 'the log is never committed');
  // `since` with an offset means the same instant as in UTC.
  const t = Date.parse(log[0].time);
  const jst = new Date(t - 1000 + 9 * 3600e3).toISOString().replace('Z', '+09:00');
  assert.equal(canvasEdits(dir, { since: jst }).edits.length, 1);
  assert.equal(canvasEdits(dir, { since: log[0].time }).edits.length, 0);
  assert.equal(canvasEdits(dir, { since: 'yesterday' }).ok, false);
  fs.appendFileSync(path.join(dir, LOG), 'null\n{"file":1}\n');
  assert.equal(canvasEdits(dir).edits.length, 1, 'lines that are not edits are skipped');
  assert.deepEqual(canvasEdits(tempDir()), { ok: true, edits: [] });
});

test('a file that is not UTF-8 is never rewritten', () => {
  const dir = tempDir();
  const sjis = Buffer.concat([Buffer.from('Reviewer: '), Buffer.from([0x82, 0xa4, 0x82, 0xdc]), Buffer.from('\n- [ ] R1 a\n')]);
  write(dir, 'openspec/changes/extract-a/review.md', '');
  const file = path.join(dir, 'openspec/changes/extract-a/review.md');
  fs.writeFileSync(file, sjis);
  const result = writeReview(dir, 'extract-a', { action: 'tick', id: 'R1', hash: sha256(sjis) });
  assert.deepEqual([result.status, result.code], [415, 'notUtf8']);
  assert.ok(fs.readFileSync(file).equals(sjis));
  assert.equal(fs.existsSync(path.join(dir, LOG)), false);
});

test('a busy file is retried, never written over a save made meanwhile, and a failed write is not logged', () => {
  const dir = tempDir();
  write(dir, 'openspec/changes/extract-a/review.md', REVIEW);
  const file = path.join(dir, 'openspec/changes/extract-a/review.md');
  const hash = sha256(fs.readFileSync(file));
  const rename = fs.renameSync;
  const busy = () => Object.assign(new Error('busy'), { code: 'EBUSY' });
  try {
    let calls = 0;
    fs.renameSync = (...args) => { calls += 1; if (calls === 1) throw busy(); return rename(...args); };
    assert.equal(writeReview(dir, 'extract-a', { action: 'tick', id: 'R1', hash }).ok, true, 'a moment of EBUSY is waited out');
    const now = sha256(fs.readFileSync(file));
    fs.renameSync = () => { fs.writeFileSync(file, `${REVIEW}saved elsewhere\n`); throw busy(); };
    const raced = writeReview(dir, 'extract-a', { action: 'untick', id: 'R1', hash: now });
    assert.deepEqual([raced.status, raced.code], [409, 'stale']);
    assert.match(fs.readFileSync(file, 'utf8'), /saved elsewhere/, 'the other save stays');
    const later = sha256(fs.readFileSync(file));
    fs.renameSync = () => { throw busy(); };
    assert.equal(writeReview(dir, 'extract-a', { action: 'tick', id: 'R1', hash: later }).status, 423);
  } finally { fs.renameSync = rename; }
  assert.equal(canvasEdits(dir).edits.length, 1, 'only the write that happened is logged');
  assert.deepEqual(fs.readdirSync(path.dirname(file)).filter((f) => f.endsWith('.tmp')), []);
});
