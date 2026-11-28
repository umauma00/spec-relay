import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { findings, main } from '../scripts/findings.mjs';
import { tempDir, write, quiet } from './helpers.mjs';

function repo() {
  const dir = tempDir();
  write(dir, 'openspec/config.yaml', 'context: |\n  Source root: src\n');
  const ch = 'openspec/changes/extract-billing';
  write(dir, `${ch}/.openspec.yaml`, 'schema: spec-relay-extract\n');
  write(dir, `${ch}/crosscheck.md`, [
    '| Item | Verdict | Evidence |', '|---|---|---|',
    '| R1 Create | confirmed | a.php:1 |',
    '| R2 Total | mismatch | a.php:9 rounds down |',
    '| R3 Tax | incomplete | a.php:12 also caps at 100 |',
    '| R4 Mail | question Q1 | a.php:20 |',
    '| S1 List | unclear | v.php:3 |', '',
  ].join('\n'));
  write(dir, `${ch}/coverage.md`, [
    '| Site | Verdict | Evidence |', '|---|---|---|',
    '| `src/a.php:save` | covered R1 | a.php:1 |',
    '| `src/a.php:purge` | gap | a.php:30 deletes old rows |', '',
  ].join('\n'));
  write(dir, `${ch}/walkthrough.md`, [
    '| Entry point | Behavior | Verdict | Evidence |', '|---|---|---|---|',
    '| `src/a.php:save` | saves | covered R1: Saved | src/a.php:1 |',
    '| `src/a.php:save` | logs the user out on error | gap | src/a.php:40 |',
    '| `src/b.php:list` | sorts | vague R2: Listed | src/b.php:5 |', '',
  ].join('\n'));
  write(dir, `${ch}/review.md`, [
    '# Review', '', 'Reviewer: うま', '', '## 1. Requirements',
    '- [ ] R1 Create', '  - fix: the limit is 10, not 5',
    '- [ ] R2 Total', '  - fix: wrong word', '  - fixed: changed the word', '',
  ].join('\n'));
  return dir;
}

test('findings lists every open row of a change in one place', () => {
  const dir = repo();
  const result = findings(dir, 'extract-billing');
  assert.equal(result.ok, true);
  assert.deepEqual(result.counts, { crosscheck: 3, coverage: 1, walkthrough: 2, review: 1 });
  const keys = result.findings.map((f) => `${f.from} ${f.key} ${f.verdict}`);
  assert.deepEqual(keys, [
    'crosscheck R2 Total mismatch', 'crosscheck R3 Tax incomplete', 'crosscheck S1 List unclear',
    'coverage `src/a.php:purge` gap',
    'walkthrough `src/a.php:save` gap', 'walkthrough `src/b.php:list` vague R2: Listed',
    'review R1 fix',
  ]);
  assert.equal(result.findings.at(-1).evidence, 'the limit is 10, not 5', 'the answered fix is not listed');
});

test('--write puts the list in the work folder for one fix task and prints only its path', () => {
  const dir = repo();
  const lines = [];
  const { log } = console;
  console.log = (s) => lines.push(s);
  try { assert.equal(main(['--change', 'extract-billing', '--write', '--root', dir]), 0); } finally { console.log = log; }
  const out = JSON.parse(lines.join('\n'));
  assert.equal(out.file, 'openspec/spec-relay/work/extract-billing/findings/01.md');
  assert.equal(out.findings, undefined);
  assert.equal(out.total, 7);
  const text = fs.readFileSync(path.join(dir, out.file), 'utf8');
  assert.match(text, /^# Findings 1 for extract-billing/);
  assert.match(text, /## Omission check[^\n]*\n\n- `src\/a\.php:purge` - \*\*gap\*\*: a\.php:30 deletes old rows/);
  assert.match(text, /- `src\/a\.php:save` - logs the user out on error - \*\*gap\*\*/);
  assert.match(text, /- `R1` - \*\*fix\*\*: the limit is 10, not 5/);
  quiet(() => main(['--change', 'extract-billing', '--write', '--root', dir]));
  assert.equal(fs.existsSync(path.join(dir, 'openspec/spec-relay/work/extract-billing/findings/02.md')), true, 'the next round gets the next number');
});

test('a change with nothing open writes nothing; an unknown change is refused', () => {
  const dir = tempDir();
  write(dir, 'openspec/config.yaml', 'x\n');
  write(dir, 'openspec/changes/extract-x/.openspec.yaml', 'schema: spec-relay-extract\n');
  assert.equal(quiet(() => main(['--change', 'extract-x', '--write', '--root', dir])), 0);
  assert.equal(fs.existsSync(path.join(dir, 'openspec/spec-relay/work/extract-x')), false);
  assert.equal(findings(dir, 'extract-x').total, 0);
  assert.equal(findings(dir, 'extract-nope').ok, false);
  assert.equal(findings(dir, '../x').ok, false);
  assert.equal(quiet(() => main(['--root', dir])), 2);
});

test('every unanswered fix: of an item is listed, with the lines written under it', () => {
  const dir = repo();
  write(dir, 'openspec/changes/extract-billing/review.md', [
    '# Review', '', '## 1. Requirements',
    '- [ ] R1 Create', '  - fix: the limit is 10,', '    not 5', '  - fixed: changed', '  - fix: and the message says "too many"', '  - fix: the button is grey',
    '- [ ] R2 Total', '  - hold: ask accounting', '',
  ].join('\n'));
  const got = findings(dir, 'extract-billing').findings.filter((f) => f.from === 'review').map((f) => `${f.key}: ${f.evidence}`);
  assert.deepEqual(got, ['R1: and the message says "too many"', 'R1: the button is grey']);
  write(dir, 'openspec/changes/extract-billing/review.md', '- [ ] R1 Create\n  - fix: the limit is 10,\n    not 5\n');
  assert.deepEqual(findings(dir, 'extract-billing').findings.filter((f) => f.from === 'review').map((f) => f.evidence), ['the limit is 10, not 5']);
});

test('a verdict holds only as a whole cell; done means nothing to fix and nothing to compare again', () => {
  const dir = tempDir();
  write(dir, 'openspec/config.yaml', 'x\n');
  write(dir, 'openspec/changes/extract-x/.openspec.yaml', 'schema: spec-relay-extract\n');
  write(dir, 'openspec/changes/extract-x/crosscheck.md', '| Item | Verdict | Evidence |\n|---|---|---|\n| R1 A | confirmed, but the default differs | a:1 |\n| R2 B | question | a:2 |\n| R3 C | question Q2 | a:3 |\n| R4 D | Confirmed. | a:4 |\n');
  const result = findings(dir, 'extract-x');
  assert.deepEqual(result.findings.map((f) => f.key), ['R1 A', 'R2 B']);
  assert.equal(result.done, false);
  write(dir, 'openspec/changes/survey/.openspec.yaml', 'schema: spec-relay-survey\n');
  write(dir, 'openspec/changes/survey/crosscheck.md', '| Path | Verdict | Evidence |\n|---|---|---|\n| `src/a.php` | question | used? |\n| `src/b.php` | mismatch | belongs to billing |\n');
  assert.deepEqual(findings(dir, 'survey').findings.map((f) => f.key), ['`src/b.php`']);
  write(dir, 'openspec/changes/extract-x/crosscheck.md', '| Item | Verdict | Evidence |\n|---|---|---|\n| R1 A | confirmed | a:1 |\n');
  assert.equal(findings(dir, 'extract-x').done, true);
});
