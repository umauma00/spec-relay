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

test('only files under openspec/ are read or written', () => {
  const dir = repo();
  write(dir, 'src/a.md', '| Path |\n|---|\n| x |\n');
  assert.match(merge(dir, { into: 'src/out.md', parts: ['openspec/x'] }).problems[0], /--into must be a file under openspec/);
  assert.match(merge(dir, { into: 'openspec/out.md', parts: ['src/a.md'] }).problems[0], /--parts must be under openspec/);
  assert.match(merge(dir, { into: 'openspec/out.md', parts: ['openspec/../src/a.md'] }).problems[0], /--parts must be under openspec/);
});

test('keys and order', () => {
  assert.equal(rowKey('| r3 Name | x |'), 'R3');
  assert.equal(rowKey('| `src\\a.cs` | x |'), 'src/a.cs');
  assert.deepEqual(['S2', 'src/a', 'R10', 'R2', 'S1'].sort(compareKeys), ['R2', 'R10', 'S1', 'S2', 'src/a']);
});

test('command line usage and exit codes', () => {
  const dir = repo();
  write(dir, 'openspec/spec-relay/work/p.md', '| Path | Context | Notes |\n|---|---|---|\n| src/a | x | |\n');
  assert.equal(quiet(() => main(['--into', 'openspec/changes/survey/inventory.md'])), 2);
  assert.equal(quiet(() => main(['--into', 'openspec/changes/survey/inventory.md', '--parts', 'openspec/spec-relay/work/p.md', '--root', dir])), 0);
  assert.equal(quiet(() => main(['--into', 'openspec/changes/survey/inventory.md', '--parts', 'openspec/spec-relay/work/none.md', '--root', dir])), 1);
});
