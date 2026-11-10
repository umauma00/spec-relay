import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { merge, main, rowKey, compareKeys } from '../scripts/merge.mjs';
import { KIT_ROOT } from '../scripts/setup.mjs';
import { tempDir, write, quiet, crlf } from './helpers.mjs';

const read = (dir, rel) => fs.readFileSync(path.join(dir, rel), 'utf8');

function repo() {
  const dir = tempDir();
  for (const schema of ['spec-relay-survey', 'spec-relay-extract']) {
    fs.cpSync(path.join(KIT_ROOT, 'openspec-schemas', schema), path.join(dir, 'openspec/schemas', schema), { recursive: true });
  }
  write(dir, 'openspec/changes/survey/.openspec.yaml', 'schema: spec-relay-survey\n');
  write(dir, 'openspec/changes/extract-billing-invoice/.openspec.yaml', 'schema: spec-relay-extract\n');
  return dir;
}

test('inventory parts merge into the template, sorted by path, and --clean removes them', () => {
  const dir = repo();
  write(dir, 'openspec/spec-relay/work/survey/inventory-02.md', '| Path | Context | Notes |\n|---|---|---|\n| `src/web/` | platform | layout |\n');
  write(dir, 'openspec/spec-relay/work/survey/inventory-01.md', '| Path | Context | Notes |\n|---|---|---|\n| src/billing/ | billing | |\n| src/billing/Tax.cs | tax | god class |\n');
  write(dir, 'openspec/spec-relay/work/survey/evidence-01.md', '# Evidence\n\nNo table here.\n');
  const result = merge(dir, { into: 'openspec/changes/survey/inventory.md', parts: ['openspec/spec-relay/work/survey/inventory-01.md', 'openspec/spec-relay/work/survey/inventory-02.md'], clean: true });
  assert.equal(result.ok, true, result.problems.join('\n'));
  assert.equal(result.rows, 3);
  const text = read(dir, 'openspec/changes/survey/inventory.md');
  assert.match(text, /^# Inventory\n\n\| Path \| Context \| Notes \|\n\|---\|---\|---\|\n\| src\/billing\/ \|/);
  assert.ok(text.indexOf('src/billing/Tax.cs') < text.indexOf('`src/web/`'));
  assert.doesNotMatch(text, /<!--/, 'the template placeholder row is dropped');
  assert.equal(fs.existsSync(path.join(dir, 'openspec/spec-relay/work/survey/inventory-01.md')), false);
  assert.equal(fs.existsSync(path.join(dir, 'openspec/spec-relay/work/survey/evidence-01.md')), true, 'files not named are kept');
});

test('crosscheck rows upsert by R/S id; a later part wins and hand-made rows stay', () => {
  const dir = repo();
  const into = 'openspec/changes/extract-billing-invoice/crosscheck.md';
  write(dir, into, crlf('# Crosscheck\n\n| Item | Verdict | Evidence |\n|---|---|---|\n| R2 Rounding | question Q1 | a.cs:3 |\n\nNotes after the table.\n'));
  write(dir, 'openspec/spec-relay/work/extract-billing-invoice/crosscheck-01.md', '| Item | Verdict | Evidence |\n|---|---|---|\n| S1 Invoice list | confirmed | v.php:1 |\n| R10 Total | mismatch | a.cs:9 |\n| R1 Create | confirmed | a.cs:1 |\n');
  write(dir, 'openspec/spec-relay/work/extract-billing-invoice/crosscheck-02-recheck.md', '| Item | Verdict | Evidence |\n|---|---|---|\n| R10 total | confirmed | a.cs:10 |\n');
  const result = merge(dir, { into, parts: ['openspec/spec-relay/work/extract-billing-invoice'] });
  assert.equal(result.ok, true, result.problems.join('\n'));
  assert.deepEqual([result.rows, result.added, result.replaced], [4, 3, 1]);
  const text = read(dir, into);
  assert.match(text, /\r\n/, 'CRLF is kept');
  const items = text.split('\r\n').filter((l) => /^\| [RS]\d/.test(l)).map((l) => l.split('|')[1].trim());
  assert.deepEqual(items, ['R1 Create', 'R2 Rounding', 'R10 total', 'S1 Invoice list']);
  assert.match(text, /R10 total \| confirmed/);
  assert.match(text, /Notes after the table\.\r\n$/);
});

test('a bad part writes nothing', () => {
  const dir = repo();
  const into = 'openspec/changes/survey/inventory.md';
  write(dir, 'openspec/spec-relay/work/survey/a.md', '| Path | Context | Notes |\n|---|---|---|\n| src/a | x | |\n');
  write(dir, 'openspec/spec-relay/work/survey/b.md', '| Path | Context | Notes |\n|---|---|---|\n| src/b | x |\n');
  const result = merge(dir, { into, parts: ['openspec/spec-relay/work/survey'] });
  assert.equal(result.ok, false);
  assert.match(result.problems.join('\n'), /2 cells, the table has 3/);
  assert.equal(fs.existsSync(path.join(dir, into)), false);

  fs.writeFileSync(path.join(dir, 'openspec/spec-relay/work/survey/b.md'), Buffer.from('﻿| Path |\n', 'utf16le'));
  assert.match(merge(dir, { into, parts: ['openspec/spec-relay/work/survey/b.md'] }).problems.join('\n'), /not UTF-8/);
});

test('only change artifacts are written and only work-folder files are parts', () => {
  const dir = repo();
  const part = 'openspec/spec-relay/work/survey/a.md';
  write(dir, part, '| Path | Context | Notes |\n|---|---|---|\n| src/a | x | |\n');
  write(dir, 'src/a.md', '| Path |\n|---|\n| x |\n');
  const bad = (into, parts) => merge(dir, { into, parts, clean: true }).problems.join('\n');
  for (const into of ['src/out.md', 'openspec/config.yaml', 'openspec/specs/billing/invoice/spec.md', 'openspec/changes/survey/review.md', 'openspec/changes/archive/2026-01-01-survey/inventory.md', 'openspec/changes/survey/specs/x.md']) {
    assert.match(bad(into, [part]), /--into must be an artifact of an active change/, into);
  }
  assert.match(bad('openspec/changes/extract-billing-invioce/crosscheck.md', [part]), /no active change extract-billing-invioce/);
  assert.equal(fs.existsSync(path.join(dir, 'openspec/changes/extract-billing-invioce')), false);
  fs.mkdirSync(path.join(dir, 'openspec/changes/survey/glossary.md'));
  assert.match(bad('openspec/changes/survey/glossary.md', [part]), /--into is a folder/);
  write(dir, 'openspec/changes/survey/inventory.md', '# Inventory\n\n| Path | Context | Notes |\n|---|---|---|\n');
  for (const parts of [['src/a.md'], ['openspec/changes/survey/inventory.md'], ['openspec/changes/survey'], ['openspec/spec-relay/work/../../changes/survey'], ['openspec/spec-relay/work']]) {
    assert.match(bad('openspec/changes/survey/inventory.md', parts), /--parts must be under openspec\/spec-relay\/work\//, parts[0]);
  }
  assert.equal(fs.existsSync(path.join(dir, 'openspec/changes/survey/inventory.md')), true, 'nothing was cleaned');
});

test('inventory paths that look like R/S ids stay apart; every table of a part is read', () => {
  const dir = repo();
  write(dir, 'openspec/spec-relay/work/survey/inv/1.md', '## src/s3\n\n| Path | Context | Notes |\n|---|---|---|\n| s3/upload.js | files | |\n| s3/download.js | files | |\n\n## top\n\n| Path | Context | Notes |\n|---|---|---|\n| S3.php | files | |\n| ./R10.sql | data | |\n| R10.sql | data | dup |\n');
  const result = merge(dir, { into: 'openspec/changes/survey/inventory.md', parts: ['openspec/spec-relay/work/survey/inv'] });
  assert.equal(result.ok, true, result.problems.join('\n'));
  assert.deepEqual([result.rows, result.replaced], [4, 1]);
});

test('one R<n> with two names is a problem; parts are read in numeric name order', () => {
  const dir = repo();
  const into = 'openspec/changes/extract-billing-invoice/crosscheck.md';
  const work = 'openspec/spec-relay/work/extract-billing-invoice';
  write(dir, `${work}/crosscheck-01.md`, '| Item | Verdict | Evidence |\n|---|---|---|\n| R15 Foo | confirmed | a |\n');
  write(dir, `${work}/crosscheck-02.md`, '| Item | Verdict | Evidence |\n|---|---|---|\n| R15 Bar | confirmed | b |\n');
  assert.match(merge(dir, { into, parts: [work], clean: true }).problems.join('\n'), /R15 names "R15 Bar", but .*crosscheck-01\.md names it "R15 Foo"/);
  assert.equal(fs.existsSync(path.join(dir, `${work}/crosscheck-01.md`)), true, 'nothing was cleaned');

  write(dir, `${work}/crosscheck-02.md`, '| Item | Verdict | Evidence |\n|---|---|---|\n| **R15** foo | mismatch | b |\n| R2 Two | confirmed | `if (a || b)` at a.cs:3 |\n');
  write(dir, `${work}/crosscheck-02-recheck.md`, '| Item | Verdict | Evidence |\n|---|---|---|\n| R15 Foo | confirmed | c |\n');
  write(dir, `${work}/crosscheck-10.md`, '| Item | Verdict | Evidence |\n|---|---|---|\n| R16 Last | confirmed | d |\n');
  const result = merge(dir, { into, parts: [work] });
  assert.equal(result.ok, true, result.problems.join('\n'));
  const text = read(dir, into);
  assert.match(text, /\| R15 Foo \| confirmed \| c \|/, 'the recheck wins');
  assert.match(text, /\| R2 Two \| confirmed \| `if \(a \\\|\\\| b\)` at a\.cs:3 \|/, 'surplus cells stay in the last cell, escaped');
  assert.deepEqual(text.split('\n').filter((l) => /^\| R/.test(l)).map((l) => l.split('|')[1].trim()), ['R2 Two', 'R15 Foo', 'R16 Last']);
});

test('a part whose header differs is a problem; a target without a table gets one after a blank line', () => {
  const dir = repo();
  const work = 'openspec/spec-relay/work/survey';
  write(dir, `${work}/x.md`, '| Item | Verdict | Evidence |\n|---|---|---|\n| R1 a | confirmed | x |\n');
  assert.match(merge(dir, { into: 'openspec/changes/survey/inventory.md', parts: [`${work}/x.md`] }).problems[0], /header \| Item \| Verdict \| Evidence \| differs from \| Path \| Context \| Notes \|/);
  write(dir, 'openspec/changes/survey/glossary.md', 'Nothing yet');
  assert.equal(merge(dir, { into: 'openspec/changes/survey/glossary.md', parts: [`${work}/x.md`] }).ok, true);
  assert.match(read(dir, 'openspec/changes/survey/glossary.md'), /^Nothing yet\n\n\| Item \| Verdict \| Evidence \|\n/);
});

test('keys and order', () => {
  assert.deepEqual(rowKey('| r3 Name | x |', true), { key: 'R3', name: 'name' });
  assert.deepEqual(rowKey('| `.\\src\\a.cs` | x |', false), { key: 'src/a.cs', name: null });
  assert.deepEqual(rowKey('| R3.php | x |', false), { key: 'R3.php', name: null });
  assert.deepEqual(['S2', 'src/a', 'R10', 'R2', 'S1'].sort(compareKeys), ['R2', 'R10', 'S1', 'S2', 'src/a']);
});

test('command line usage and exit codes', () => {
  const dir = repo();
  write(dir, 'openspec/spec-relay/work/p.md', '| Path | Context | Notes |\n|---|---|---|\n| src/a | x | |\n');
  assert.equal(quiet(() => main(['--into', 'openspec/changes/survey/inventory.md'])), 2);
  assert.equal(quiet(() => main(['--into', 'openspec/changes/survey/inventory.md', '--parts', 'openspec/spec-relay/work/p.md', '--root', dir])), 0);
  assert.equal(quiet(() => main(['--into', 'openspec/changes/survey/inventory.md', '--parts', 'openspec/spec-relay/work/none.md', '--root', dir])), 1);
});
