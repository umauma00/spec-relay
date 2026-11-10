import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { render, markdown, inline, parseRefs, main } from '../scripts/render.mjs';
import { tempDir, write, quiet, crlf } from './helpers.mjs';

const CHANGE = 'openspec/changes/extract-billing-invoice';
const SPEC = '## Purpose\n\nComputes invoice totals from the lines of an invoice.\n\n## ADDED Requirements\n\n### Requirement: Total\nThe system SHALL add the lines.\n\n#### Scenario: two lines\n- **WHEN** 100 x 3 and 55 x 1\n- **THEN** `355`\n\n### Requirement: Reject empty\nThe system SHALL reject an invoice without lines.\n\n#### Scenario: none\n- **WHEN** no lines\n- **THEN** an error\n';
const TRACE = '| Requirement | Source (path:symbol:lines) | Existing tests |\n|---|---|---|\n| Total | src/invoice.php:invoice_total:2-3 | none |\n';
const REVIEW = 'Reviewer: Uma\n\n## 1. Requirements\n- [x] R1 Total\n- [ ] R2 Reject empty\n\n## 2. Questions\n- [x] Q1 Rounding: decision: keep\n';

function repo({ lang = 'ja' } = {}) {
  const dir = tempDir();
  write(dir, 'openspec/config.yaml', `context: |\n  Artifact language: ${lang}\n`);
  write(dir, `${CHANGE}/.openspec.yaml`, 'schema: spec-relay-extract\n');
  write(dir, `${CHANGE}/specs/billing/invoice/spec.md`, SPEC);
  write(dir, `${CHANGE}/trace.md`, TRACE);
  write(dir, `${CHANGE}/review.md`, REVIEW);
  write(dir, `${CHANGE}/questions.md`, '## Suspected bugs\n- Q1. Rounding\n');
  write(dir, `${CHANGE}/source-map.md`, '# Source map\n\n## Scope\nInvoices.\n');
  fs.mkdirSync(path.join(dir, 'src'));
  // Shift_JIS for "// 合計" on line 2: legacy code is shown, not dropped.
  fs.writeFileSync(path.join(dir, 'src/invoice.php'), Buffer.concat([
    Buffer.from('<?php\n// '), Buffer.from([0x8d, 0x87, 0x8c, 0x76]), Buffer.from('\nfunction invoice_total() {}\n'),
  ]));
  return dir;
}

const html = (dir, name) => fs.readFileSync(path.join(dir, 'openspec/spec-relay/views', `${name}.html`), 'utf8');

test('an extract change renders as a review page with progress, cards, trace and source', () => {
  const dir = repo();
  assert.deepEqual(render({ root: dir, change: 'extract-billing-invoice' }), { ok: true, out: 'openspec/spec-relay/views/extract-billing-invoice.html' });
  const page = html(dir, 'extract-billing-invoice');
  assert.match(page, /<html lang="ja">/);
  assert.match(page, /2<span>\/ 3<\/span>/, 'two of three items confirmed');
  assert.match(page, /class="card is-done" id="R1"[\s\S]*Total/);
  assert.match(page, /class="card is-open" id="R2"/);
  assert.match(page, /trace\.md に記載がありません/, 'R2 has no trace entry');
  assert.match(page, /\/\/ 合計/, 'Shift_JIS source decoded');
  assert.match(page, /shift_jis/);
  assert.match(page, /decision[\s\S]*keep/i);
  assert.match(page, /id="doc-source-map-md"/);
  assert.equal(fs.readFileSync(path.join(dir, 'openspec/spec-relay/views/.gitignore'), 'utf8').trim().split('\n').pop(), '*');
});

test('the same input gives the same page apart from the time stamp', () => {
  const dir = repo();
  const now = new Date('2026-11-10T00:00:00Z');
  render({ root: dir, change: 'extract-billing-invoice', now });
  const first = html(dir, 'extract-billing-invoice');
  render({ root: dir, change: 'extract-billing-invoice', now });
  assert.equal(html(dir, 'extract-billing-invoice'), first);
});

test('CRLF and a BOM read the same as LF', () => {
  const dir = repo();
  const now = new Date('2026-11-10T00:00:00Z');
  render({ root: dir, change: 'extract-billing-invoice', now });
  const lf = html(dir, 'extract-billing-invoice');
  for (const file of ['review.md', 'trace.md', 'specs/billing/invoice/spec.md']) {
    const p = path.join(dir, CHANGE, file);
    fs.writeFileSync(p, `﻿${crlf(fs.readFileSync(p, 'utf8'))}`);
  }
  render({ root: dir, change: 'extract-billing-invoice', now });
  assert.equal(html(dir, 'extract-billing-invoice'), lf);
});

test('labels follow the artifact language', () => {
  const dir = repo({ lang: 'en' });
  render({ root: dir, change: 'extract-billing-invoice' });
  assert.match(html(dir, 'extract-billing-invoice'), /<html lang="en">[\s\S]*Requirements/);
});

test('archived changes are found', () => {
  const dir = repo();
  fs.mkdirSync(path.join(dir, 'openspec/changes/archive'), { recursive: true });
  fs.renameSync(path.join(dir, CHANGE), path.join(dir, 'openspec/changes/archive/2026-11-10-extract-billing-invoice'));
  assert.equal(render({ root: dir, change: 'extract-billing-invoice' }).ok, true);
  assert.equal(render({ root: dir, change: 'extract-missing' }).ok, false);
});

test('nothing in the Markdown can inject markup or script', () => {
  const out = markdown('# <script>alert(1)</script>\n\n[x](javascript:alert(1)) ![i](https://evil.example/t.png) <img src=x onerror=alert(1)>\n\n| a |\n|---|\n| <b>b</b> |\n');
  assert.doesNotMatch(out, /<script|<img src=x|<b>|javascript:|evil\.example/);
  assert.match(out, /&lt;script&gt;/);
  assert.equal(inline('[ok](docs/a.md) **b** `<c>`'), '<a href="docs/a.md">ok</a> <strong>b</strong> <code>&lt;c&gt;</code>');
});

test('source references outside the repository are not read', () => {
  const dir = repo();
  const outside = tempDir();
  fs.writeFileSync(path.join(outside, 'secret.txt'), 'SECRET');
  const rel = path.relative(dir, path.join(outside, 'secret.txt')).replace(/\\/g, '/');
  assert.equal(parseRefs(`${rel}:x:1-1`)[0].file, rel);
  write(dir, `${CHANGE}/trace.md`, TRACE.replace('src/invoice.php', rel));
  render({ root: dir, change: 'extract-billing-invoice' });
  const page = html(dir, 'extract-billing-invoice');
  assert.doesNotMatch(page, /SECRET/);
  assert.match(page, /ファイルを読めませんでした/);
});

test('markdown subset: nested and task lists, tables, fences', () => {
  const out = markdown('- a\n  - b\n- [x] done\n- [ ] open\n\n```cs\nvar x = 1 < 2;\n```\n\n1. one\n2. two\n');
  assert.match(out, /<ul><li>a<ul><li>b<\/li><\/ul><\/li><li class="task done">/);
  assert.match(out, /<li class="task open">/);
  assert.match(out, /<pre class="code"><code>var x = 1 &lt; 2;<\/code><\/pre>/);
  assert.match(out, /<ol><li>one<\/li><li>two<\/li><\/ol>/);
});

test('trace cells with several references', () => {
  assert.deepEqual(parseRefs('`src/a.cs:A.B:10-20`<br>src/b.php:f:5; lib/c.py'), [
    { file: 'src/a.cs', symbol: 'A.B', from: 10, to: 20 },
    { file: 'src/b.php', symbol: 'f', from: 5, to: 5 },
    { file: 'lib/c.py', symbol: '', from: null, to: null },
  ]);
});

test('a single file renders, and bad usage exits 2', () => {
  const dir = repo();
  write(dir, 'notes/plan.md', '# Plan\n\n- billing/invoice\n');
  assert.equal(render({ root: dir, file: 'notes/plan.md' }).ok, true);
  assert.match(html(dir, 'plan'), /billing\/invoice/);
  assert.equal(quiet(() => main([])), 2);
  assert.equal(quiet(() => main(['--change', 'a', '--file', 'b'])), 2);
});
