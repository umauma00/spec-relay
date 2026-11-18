import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { render, markdown, inline, parseRefs, parseReview, parseQuestions, diffChars, commonIndent, timeStamp, main, capabilities } from '../scripts/render.mjs';
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

test('an extract change renders as a review page with progress, items, trace and source', () => {
  const dir = repo();
  assert.deepEqual(render({ root: dir, change: 'extract-billing-invoice' }), { ok: true, out: 'openspec/spec-relay/views/extract-billing-invoice.html' });
  const page = html(dir, 'extract-billing-invoice');
  assert.match(page, /<html lang="ja">/);
  assert.match(page, /<p class="remain"><b>1<\/b>件が未確認<\/p>/, 'one of three items is open');
  assert.match(page, /3 件中 2 件を確認済み/);
  assert.match(page, /class="item k-req is-done" id="R1"[\s\S]*Total/);
  assert.match(page, /class="item k-req is-open" id="R2"/);
  assert.match(page, /href="#R2">最初の未確認 R2 へ/);
  assert.match(page, /<dl class="gwt"><div class="when"><dt>操作<small>WHEN<\/small><\/dt>/, 'scenario steps with their Japanese names');
  assert.match(page, /<span class="q-kind">バグの疑い<\/span>/, 'the question shows its section of questions.md');
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
  assert.deepEqual(parseRefs('src/a.php:120-125'), [{ file: 'src/a.php', symbol: '', from: 120, to: 125 }]);
  assert.deepEqual(parseRefs('src/Billing.cs:Billing::Total:3-9'), [{ file: 'src/Billing.cs', symbol: 'Billing::Total', from: 3, to: 9 }]);
  assert.deepEqual(parseRefs('src\\請求 書\\a.php:f:4'), [{ file: 'src/請求 書/a.php', symbol: 'f', from: 4, to: 4 }]);
});

test('network paths, rooted paths and backslashes never become links or images', () => {
  for (const src of ['\\\\host\\share\\a.png', '/\\host/a.png', '/etc/a.png', '//host/a.png']) {
    const out = inline(`![x](${src}) [y](${src})`);
    assert.doesNotMatch(out, /<img|<a /, src);
  }
});

test('a lone CR or U+2028 in a heading does not hang the renderer', () => {
  assert.match(markdown('# Title\rnext\n#\tx\n'), /<h1>Title<\/h1>/);
  assert.match(markdown('# A\u2028B'), /<h1>A<\/h1>/);
});

test('images in a change are rebased to the page; links out of the repository are not read', () => {
  const dir = repo();
  write(dir, 'openspec/spec-relay/screens/a.png', 'png');
  write(dir, `${CHANGE}/source-map.md`, '# Source map\n\n![shot](../../spec-relay/screens/a.png) ![out](../../../../outside.png)\n');
  render({ root: dir, change: 'extract-billing-invoice' });
  const page = html(dir, 'extract-billing-invoice');
  assert.match(page, /<img src="\.\.\/screens\/a\.png"/);
  assert.doesNotMatch(page, /outside\.png"/);
  const outside = tempDir();
  fs.writeFileSync(path.join(outside, 'secret.txt'), 'SECRET');
  try { fs.symlinkSync(path.join(outside, 'secret.txt'), path.join(dir, 'src/link.php')); } catch { return; }
  write(dir, `${CHANGE}/trace.md`, '| Requirement | Source | Tests |\n|---|---|---|\n| Total | src/link.php:x:1 | none |\n');
  render({ root: dir, change: 'extract-billing-invoice' });
  assert.doesNotMatch(html(dir, 'extract-billing-invoice'), /SECRET/);
});

test('a single file renders, and bad usage exits 2', () => {
  const dir = repo();
  write(dir, 'notes/plan.md', '# Plan\n\n- billing/invoice\n');
  assert.equal(render({ root: dir, file: 'notes/plan.md' }).ok, true);
  assert.match(html(dir, 'plan'), /billing\/invoice/);
  assert.equal(quiet(() => main([])), 2);
  assert.equal(quiet(() => main(['--change', 'a', '--file', 'b'])), 2);
});

// ---- the review ledger

const change = (dir, name, schema, files) => {
  write(dir, `openspec/changes/${name}/.openspec.yaml`, `schema: ${schema}\n`);
  for (const [rel, text] of Object.entries(files)) write(dir, `openspec/changes/${name}/${rel}`, text);
  const result = render({ root: dir, change: name, lang: 'ja' });
  assert.equal(result.ok, true);
  return html(dir, name);
};
const count = (page, re) => (page.match(re) ?? []).length;

test('pages without review items claim no progress', () => {
  const dir = repo();
  write(dir, 'openspec/changes/port-billing-invoice/tasks.md', '## 1. Port\n- [x] 1.1 Model\n- [ ] 1.2 Tests\n');
  write(dir, 'notes/plan.md', '# Plan\n');
  render({ root: dir, change: 'port-billing-invoice' });
  render({ root: dir, file: 'notes/plan.md' });
  for (const page of [html(dir, 'port-billing-invoice'), html(dir, 'plan')]) {
    assert.doesNotMatch(page, /class="remain"|class="sheet"|id="f-open"|class="dock"|すべて確認済み/);
    assert.match(page, /<details class="toc">/);
  }
  assert.match(html(dir, 'port-billing-invoice'), /<li class="task done">/);
});

test('a requirement without a review row is open and says so; a row that names nothing says so', () => {
  const dir = repo();
  write(dir, `${CHANGE}/review.md`, 'Reviewer: Uma\n\n## 1. Requirements\n- [x] R1 Total\n- [x] R7 Gone\n\n## 2. Empty\n');
  render({ root: dir, change: 'extract-billing-invoice' });
  const page = html(dir, 'extract-billing-invoice');
  assert.match(page, /<p class="remain"><b>2<\/b>件が未確認<\/p>/, 'the unlisted requirement and the unlisted question count as open');
  assert.match(page, /class="item k-req is-open" id="x1"[\s\S]*?Reject empty[\s\S]*?review\.md に項目がありません/);
  assert.match(page, /id="R7"[\s\S]*?同じ名前の要件が仕様にありません/);
  assert.doesNotMatch(page, /Empty/, 'a group without items is not shown');
});

test('review items are any <Letter><n> id, grouped by the headings of review.md', () => {
  const groups = parseReview('## 1. Architecture\n- [x] A0 The style\n- [ ] A90 Data ownership\n\n## 2. Conventions\n- [ ] V1 Runtime\n\n```\n- [ ] Z9 in a fence\n```\n- [ ] no id here\n');
  assert.deepEqual(groups.map((g) => [g.title, g.items.map((i) => `${i.id}:${i.done}`)]), [['Architecture', ['A0:true', 'A90:false']], ['Conventions', ['V1:false', ':false']]]);
  const dir = repo();
  const page = change(dir, 'target-design', 'spec-relay-target', {
    'review.md': 'Reviewer: Uma\n\n## 1. Architecture\n- [x] A0 The style\n- [ ] A1 billing\n\n## 3. Verification\n- [ ] E1 billing: levels\n\n## 4. Screens\n- [ ] U1 billing: screens\n',
    'architecture.md': '# Architecture\n\n| Context | Module |\n|---|---|\n| billing | Billing |\n',
    'ui.md': '# UI\n\n## Screens\n| Context | Policy |\n|---|---|\n| billing | layout |\n',
  });
  assert.match(page, /<h2 id="g3">画面<span class="n">確認済み 0 \/ 1<\/span>/);
  assert.match(page, /id="doc-ui-md"/);
  assert.match(page, /移行先設計レビュー/);
  assert.match(page, /<h2 id="g1">アーキテクチャ<span class="n">確認済み 1 \/ 2<\/span>/);
  assert.match(page, /class="item small is-open" id="E1"/);
  assert.match(page, /id="doc-architecture-md"/);
  assert.match(page, /<b>3<\/b>件が未確認/);
});

test('questions are found in every shape the gate accepts', () => {
  const found = parseQuestions('# Questions\n\n## Suspected bugs\n- Q1. [Total] floors the tax\n1. **Q2** second, see Q1\n\n## Assumptions\n- [Q3] third\n\n| Id | Question |\n|---|---|\n| Q4 | fourth |\n');
  assert.deepEqual([...found], [
    ['Q1', { kind: 'Suspected bugs', text: '[Total] floors the tax' }],
    ['Q2', { kind: 'Suspected bugs', text: 'second, see Q1' }],
    ['Q3', { kind: 'Assumptions', text: 'third' }],
    ['Q4', { kind: 'Assumptions', text: 'fourth' }],
  ]);
});

test('a decision and its tick that disagree are flagged, and unlisted questions are open', () => {
  const dir = repo();
  write(dir, `${CHANGE}/questions.md`, '## Assumptions\n- Q1. a\n- Q2. b\n- Q3. c\n');
  write(dir, `${CHANGE}/review.md`, `${REVIEW.replace('decision: keep', 'decision:')}- [ ] Q2 Units: decision: integers\n`);
  render({ root: dir, change: 'extract-billing-invoice' });
  const page = html(dir, 'extract-billing-invoice');
  assert.match(page, /id="Q1"[\s\S]*?チェック済みですが、判断が未記入です/);
  assert.match(page, /id="Q2"[\s\S]*?判断は書かれていますが、チェックされていません/);
  assert.match(page, /<span class="id">Q3<\/span>[\s\S]*?review\.md に項目がありません/);
});

test('screens show their table and messages, and the screenshot as a relative image', () => {
  const dir = repo();
  write(dir, 'openspec/spec-relay/screens/entry.png', 'png');
  write(dir, `${CHANGE}/screens.md`, '# Screens\n\n### Screen: Entry\n- **Entry**: menu\n- **Screenshot**: openspec/spec-relay/screens/entry.png\n\n| Label | Kind |\n|---|---|\n| Customer | text box |\n\n**Messages**\n- "No lines" - when empty\n\n### Screen: Outside\n- **Screenshot**: ../../secret.png\n\n### Screen: Remote\n- **Screenshot**: https://evil.example/a.png\n');
  write(dir, `${CHANGE}/crosscheck.md`, '| Item | Verdict | Evidence |\n|---|---|---|\n| S1 Entry | confirmed | src/a.cs:1 |\n| R2 Reject empty | unclear | src/a.cs:2 |\n');
  write(dir, `${CHANGE}/review.md`, `${REVIEW}\n## 3. Screens\n- [ ] S1 Entry\n- [ ] S2 Outside\n- [ ] S3 Remote\n`);
  render({ root: dir, change: 'extract-billing-invoice' });
  const page = html(dir, 'extract-billing-invoice');
  assert.match(page, /class="item k-screen is-open" id="S1"/);
  assert.match(page, /<img src="\.\.\/screens\/entry\.png" alt="[^"]*" loading="lazy"><figcaption><a href="\.\.\/screens\/entry\.png">原寸で開く<\/a>/);
  assert.match(page, /<td>Customer<\/td>[\s\S]*?&quot;No lines&quot; - when empty/);
  assert.equal(count(page, /<img /g), 1, 'nothing outside the repository and nothing remote is loaded');
  assert.equal(count(page, /画像ファイルがありません/g), 2);
  assert.doesNotMatch(page, /id="doc-screens-md"/, 'screens already shown are not repeated');
  assert.match(page, /照合（AI の再確認）<\/span><span><span>confirmed<\/span> — src\/a\.cs:1/);
  assert.match(page, /<span class="caution">unclear<\/span>/);
  // Written elsewhere, the page still points at the same file.
  render({ root: dir, change: 'extract-billing-invoice', out: 'out/deep/page.html' });
  assert.match(fs.readFileSync(path.join(dir, 'out/deep/page.html'), 'utf8'), /<img src="\.\.\/\.\.\/openspec\/spec-relay\/screens\/entry\.png"/);
});

test('a survey shows each context as an item and keeps the relationships table', () => {
  const dir = repo();
  const page = change(dir, 'survey', 'spec-relay-survey', {
    'review.md': 'Reviewer: Uma\n\n## 1. Contexts\n- [x] K1 platform: Platform\n- [ ] K2 billing-core: Billing\n- [ ] K9 nowhere: Nothing\n\n## 2. Map\n- [ ] M1 The relationships between contexts are right\n',
    'context-map.md': '# Context map\n\n## Contexts\n\n### Context: platform\n- **Type**: generic\n\n### Context: billing-core\n- **Type**: core\n\n### Context: order\n- **Type**: supporting\n\n## Relationships\n| Upstream | Downstream | Pattern | Channel |\n|---|---|---|---|\n| order | billing-core | customer-supplier | table t_order |\n',
  });
  assert.match(page, /調査レビュー/);
  assert.match(page, /class="item k-context is-done" id="K1"[\s\S]*?<strong>Type<\/strong>: generic/);
  assert.match(page, /class="item k-context is-open" id="K2"[\s\S]*?<strong>Type<\/strong>: core/);
  assert.match(page, /id="K9"[\s\S]*?同じ id のコンテキストが context-map\.md にありません/);
  assert.match(page, /class="item k-context is-open" id="x1"[\s\S]*?order[\s\S]*?review\.md に項目がありません/);
  assert.match(page, /id="doc-context-map-md"[\s\S]*?<th>Channel<\/th>[\s\S]*?<td>table t_order<\/td>/);
  assert.equal(count(page, /<strong>Type<\/strong>: core/g), 1, 'the contexts are not repeated in the appendix');
  assert.match(page, /<b>4<\/b>件が未確認/);
});

test('an amendment shows the old wording from the baseline against the new', () => {
  const dir = repo();
  write(dir, 'openspec/specs/billing/invoice/spec.md', '## Purpose\nx\n\n## Requirements\n\n### Requirement: Total\nThe system SHALL round the tax **half up**.\n\n#### Scenario: tax\n- **WHEN** 15 at 10%\n- **THEN** `17`\n\n#### Scenario: dropped\n- **WHEN** x\n- **THEN** y\n\n### Requirement: Recalculate\nThe system SHALL recalculate.\n');
  const page = change(dir, 'amend-billing-invoice', 'spec-relay-amend', {
    'review.md': 'Reviewer: Uma\n\n## 1. Requirements\n- [ ] R1 Total\n- [ ] R2 Zero rate\n- [ ] R3 Recalculate\n- [ ] R4 Unknown\n\n## 2. Impact\n- [ ] I1 The port updates in impact.md are right\n',
    'specs/billing/invoice/spec.md': '## MODIFIED Requirements\n\n### Requirement: Total\nThe system SHALL round the tax **down**.\n\n#### Scenario: tax\n- **WHEN** 15 at 10%\n- **THEN** `16`\n- **AND** nothing else\n\n#### Scenario: new one\n- **WHEN** a\n- **THEN** b\n\n### Requirement: Unknown\nThe system SHALL x.\n\n## ADDED Requirements\n\n### Requirement: Zero rate\nThe system SHALL accept 0.\n\n## REMOVED Requirements\n\n### Requirement: Recalculate\n**Reason**: not in the code.\n',
    'reason.md': '# Reason\n\n## Found by\nport test\n',
  });
  assert.match(page, /修正レビュー/);
  assert.match(page, /id="R1"[\s\S]*?<span class="delta modified">＊ 変更<\/span>Total/);
  assert.match(page, /<p class="was"><span class="label">旧<\/span><span>The system SHALL round the tax <del>half up<\/del>\.<\/span><\/p><p class="now"><span class="label">新<\/span><span>The system SHALL round the tax <ins>down<\/ins>\.<\/span><\/p>/);
  assert.match(page, /<span class="delta added">＋ 追加<\/span><span>new one<\/span>/);
  assert.match(page, /<section class="scenario gone">[\s\S]*?<span class="delta removed">－ 削除<\/span><span>dropped<\/span>/);
  assert.match(page, /<span class="delta added">＋ 追加<\/span>Zero rate/);
  assert.match(page, /class="item k-req is-open is-removed" id="R3"[\s\S]*?<div class="statement gone"><p>The system SHALL recalculate\.<\/p><\/div>[\s\S]*?not in the code/);
  assert.match(page, /id="R4"[\s\S]*?現在の仕様（openspec\/specs）に同じ名前の要件がありません/);
  assert.match(page, /class="item small is-open" id="I1"/);
  assert.doesNotMatch(page, /delta[^"]*">△/, 'the change mark is not the caution mark');
});

test('the character difference is deterministic and gives up on very long texts', () => {
  assert.deepEqual(diffChars('税額を四捨五入で加える', '税額を切り捨てで加える'), [['=', '税額を'], ['-', '四'], ['+', '切り'], ['=', '捨'], ['-', '五入'], ['+', 'て'], ['=', 'で加える']]);
  assert.deepEqual(diffChars('same', 'same'), [['=', 'same']]);
  assert.deepEqual(diffChars('', 'new'), [['+', 'new']]);
  assert.equal(diffChars('a'.repeat(1001), 'b'.repeat(1001)), null);
});

test('long snippets stop at 80 lines, lose their shared indentation and keep their line numbers', () => {
  assert.equal(commonIndent(['        a', '', '          b', '        c']), 8);
  assert.equal(commonIndent(['\ta', '    b']), 0);
  const dir = repo();
  write(dir, 'src/Long.cs', `class A\n{\n${Array.from({ length: 100 }, (_, i) => `        line${i + 3}();`).join('\n')}\n}\n`);
  write(dir, `${CHANGE}/trace.md`, TRACE.replace('src/invoice.php:invoice_total:2-3', 'src/Long.cs:A.Run:3-102'));
  render({ root: dir, change: 'extract-billing-invoice' });
  const page = html(dir, 'extract-billing-invoice');
  assert.equal(count(page, /<span class="l">/g), 80);
  assert.match(page, /<span class="l"><span class="ln">3<\/span>line3\(\);\n<\/span>/);
  assert.match(page, /<span class="ln">82<\/span>line82\(\);/);
  assert.doesNotMatch(page, /line83\(\)/);
  assert.match(page, /長いため先頭のみ表示 · 字下げを 8 文字詰めて表示/);
});

test('AND after THEN reads as part of the outcome', () => {
  const dir = repo();
  write(dir, `${CHANGE}/specs/billing/invoice/spec.md`, `${SPEC}- **AND** nothing is saved\n\n#### Scenario: free text\nJust a sentence.\n`);
  render({ root: dir, change: 'extract-billing-invoice' });
  const page = html(dir, 'extract-billing-invoice');
  assert.match(page, /<div class="then"><dt>かつ<small>AND<\/small><\/dt><dd>nothing is saved<\/dd><\/div>/);
  assert.match(page, /free text<\/span><\/h4><p>Just a sentence\.<\/p>/, 'a scenario that is not a step list stays plain Markdown');
});

test('the page works without script and leaves the reader in control', () => {
  const dir = repo();
  render({ root: dir, change: 'extract-billing-invoice' });
  const page = html(dir, 'extract-billing-invoice');
  assert.match(page, /<details class="toc"><summary>目次<\/summary>/, 'the index ships closed');
  assert.match(page, /body:has\(#f-open:checked\) main \.item\.is-done,body:has\(#f-open:checked\) \.toc li\.is-done\{display:none\}/, 'the filter leaves the progress cells alone');
  assert.doesNotMatch(page, /scroll-behavior/);
  assert.match(page, /<input type="checkbox" id="keys-on" checked>/, 'single-key shortcuts can be turned off');
  assert.match(page, /Content-Security-Policy" content="default-src 'none'/);
  assert.doesNotMatch(page, /https?:\/\//, 'nothing is fetched');
  assert.match(page, /<span class="sign">Uma<\/span>/);
});

test('the time stamp is local time with its offset', () => {
  assert.match(timeStamp(new Date('2026-11-10T13:41:00Z')), /^2026-11-1[01] \d\d:\d\d UTC[+-]\d\d:\d\d$/);
});

// ---- the approved specs

const BASELINE = '## Purpose\n\nComputes invoice totals.\n\n## Requirements\n\n### Requirement: Total\nThe system SHALL add the lines.\n\n#### Scenario: two lines\n- **WHEN** 100 x 3 and 55 x 1\n- **THEN** `355`\n\n### Requirement: Reject empty\nThe system SHALL reject an invoice without lines.\n';
const ARCHIVED = 'openspec/changes/archive/2026-11-10-extract-billing-invoice';

function specs() {
  const dir = repo();
  fs.rmSync(path.join(dir, CHANGE), { recursive: true });
  write(dir, 'openspec/specs/billing/invoice/spec.md', BASELINE);
  write(dir, 'openspec/specs/billing/payment/spec.md', '## Purpose\nTakes payments.\n\n## Requirements\n\n### Requirement: Card\nThe system SHALL take cards.\n');
  write(dir, 'openspec/specs/auth/login/spec.md', '## Purpose\nSigns people in.\n\n## Requirements\n');
  write(dir, `${ARCHIVED}/.openspec.yaml`, 'schema: spec-relay-extract\n');
  write(dir, `${ARCHIVED}/trace.md`, TRACE);
  write(dir, `${ARCHIVED}/review.md`, REVIEW);
  write(dir, `${ARCHIVED}/screens.md`, '# Screens\n\n### Screen: Entry\n- **Entry**: menu\n');
  return dir;
}

test('an approved spec reads as a page with its scenarios, source and screens, and no review marks', () => {
  const dir = specs();
  assert.deepEqual(render({ root: dir, spec: 'billing/invoice' }), { ok: true, out: 'openspec/spec-relay/views/spec-billing-invoice.html' });
  const page = html(dir, 'spec-billing-invoice');
  assert.match(page, /<p class="kind">仕様<\/p>\s*<h1>billing\/invoice<\/h1>/);
  assert.match(page, /Computes invoice totals\./);
  assert.match(page, /<dt>要件<\/dt><dd>2<\/dd><dt>シナリオ<\/dt><dd>1<\/dd><dt>画面<\/dt><dd>1<\/dd><dt>根拠<\/dt><dd class="mono">2026-11-10-extract-billing-invoice<\/dd>/);
  assert.match(page, /class="item k-req" id="R1"[\s\S]*?Total[\s\S]*?<dl class="gwt">/);
  assert.match(page, /\/\/ 合計/, 'the source code from the archived trace.md');
  assert.match(page, /id="R2"[\s\S]*?trace\.md に記載がありません/);
  assert.match(page, /class="item small k-screen" id="S1"|class="item k-screen" id="S1"/);
  assert.doesNotMatch(page, /class="seal|class="left"|class="filter"|id="keys-on"|class="dock"|class="all-clear"|未確認/, 'nothing about review');
  assert.match(page, /<input id="q" type="search"/);
  assert.match(page, /<li data-for="R1"><a href="#R1">/);
  assert.match(page, /正は openspec\/specs\/ の Markdown です/);
  assert.match(page, /Content-Security-Policy" content="default-src 'none'/);
});

test('an amendment in progress is shown on the spec it would change, and an archived one counts', () => {
  const dir = specs();
  write(dir, 'openspec/changes/archive/2026-11-12-amend-billing-invoice/specs/billing/invoice/spec.md', '## MODIFIED Requirements\n');
  write(dir, 'openspec/changes/archive/2026-11-12-amend-billing-invoice/trace.md', '| Requirement | Source | Tests |\n|---|---|---|\n| Reject empty | src/invoice.php:invoice_total:3 | tests/a.php |\n');
  write(dir, 'openspec/changes/amend-billing-invoice-2/specs/billing/invoice/spec.md', '## MODIFIED Requirements\n\n### Requirement: Total\nThe system SHALL add the lines and round down.\n\n#### Scenario: two lines\n- **WHEN** 100 x 3 and 55 x 1\n- **THEN** `355`\n\n## ADDED Requirements\n\n### Requirement: Zero rate\nThe system SHALL accept 0.\n');
  write(dir, 'openspec/changes/amend-other/specs/billing/payment/spec.md', '## ADDED Requirements\n\n### Requirement: Cash\nx\n');
  render({ root: dir, spec: 'billing/invoice' });
  const page = html(dir, 'spec-billing-invoice');
  assert.match(page, /2026-11-10-extract-billing-invoice<br>2026-11-12-amend-billing-invoice/);
  assert.match(page, /<dt>修正中<\/dt><dd class="mono">amend-billing-invoice-2<\/dd>/);
  assert.match(page, /id="R1"[\s\S]*?＊ 変更[\s\S]*?修正中の変更があります（amend-billing-invoice-2）[\s\S]*?<ins> and round down<\/ins>/);
  assert.match(page, /id="R2"[\s\S]*?tests\/a\.php/, 'the archived amendment\'s trace is used');
  assert.match(page, /id="R3"[\s\S]*?＋ 追加[\s\S]*?Zero rate/);
  assert.doesNotMatch(page, /Cash/);
});

test('--spec all writes the list and every page, grouped by context and linked', () => {
  const dir = specs();
  assert.deepEqual(capabilities(dir), ['auth/login', 'billing/invoice', 'billing/payment']);
  const result = render({ root: dir, spec: 'all' });
  assert.deepEqual(result, { ok: true, out: 'openspec/spec-relay/views/specs.html', pages: ['openspec/spec-relay/views/spec-auth-login.html', 'openspec/spec-relay/views/spec-billing-invoice.html', 'openspec/spec-relay/views/spec-billing-payment.html'] });
  const index = html(dir, 'specs');
  assert.match(index, /<h1>移行の仕様<\/h1>/);
  assert.match(index, /<h2 id="g1">auth<span class="n">1<\/span><\/h2>[\s\S]*<h2 id="g2">billing<span class="n">2<\/span><\/h2>/);
  assert.match(index, /<h3><a href="spec-billing-invoice\.html">billing\/invoice<\/a><\/h3>/);
  assert.match(index, /<summary>要件 2<\/summary><ol><li>Total<\/li><li>Reject empty<\/li><\/ol>/);
  assert.match(html(dir, 'spec-billing-payment'), /<p class="nav"><a href="specs\.html">← 仕様の一覧<\/a><\/p>/);
  assert.equal(render({ root: dir, spec: 'all', out: 'x.html' }).ok, false);
});

test('a spec outside openspec/specs, or one that does not exist, is refused', () => {
  const dir = specs();
  for (const bad of ['../billing', 'billing/../../x', 'billing/none', 'a:b']) {
    const result = render({ root: dir, spec: bad });
    assert.equal(result.ok, false, bad);
  }
  assert.equal(quiet(() => main(['--spec', 'billing/invoice', '--change', 'x'])), 2);
  assert.equal(quiet(() => main(['--root', dir, '--spec', 'billing/invoice'])), 0);
});

test('with no specs the list says so', () => {
  const dir = tempDir();
  const result = render({ root: dir, spec: 'all', lang: 'en' });
  assert.equal(result.ok, true);
  assert.deepEqual(result.pages, []);
  assert.match(html(dir, 'specs'), /No specs yet/);
});

test('renames, deltas that name no baseline requirement and two amendments are all shown', () => {
  const dir = specs();
  write(dir, 'openspec/changes/amend-a/specs/billing/invoice/spec.md', '## RENAMED Requirements\n- FROM: `### Requirement: Total`\n- TO: `### Requirement: Grand total`\n\n## MODIFIED Requirements\n\n### Requirement: Grand total\nThe system SHALL add the lines and the tax.\n\n### Requirement: Totals\nThe system SHALL x.\n');
  write(dir, 'openspec/changes/amend-b/specs/billing/invoice/spec.md', '## MODIFIED Requirements\n\n### Requirement: Reject empty\nThe system SHALL warn on an invoice without lines.\n');
  write(dir, 'openspec/changes/amend-b/trace.md', '| Requirement | Source | Tests |\n|---|---|---|\n| Total | src/pending.php:x:1 | none |\n');
  write(dir, 'src/pending.php', 'PENDING\n');
  render({ root: dir, spec: 'billing/invoice' });
  const page = html(dir, 'spec-billing-invoice');
  assert.match(page, /id="R1"[\s\S]*?Total → Grand total[\s\S]*?修正中の変更があります（amend-a）[\s\S]*?<ins> and the tax<\/ins>/);
  assert.match(page, /id="R1"[\s\S]*?invoice_total[\s\S]*?id="R2"/, 'the evidence follows the rename');
  assert.match(page, /id="R2"[\s\S]*?修正中の変更があります（amend-b）[\s\S]*?<ins>n on<\/ins>/);
  assert.match(page, /id="R3"[\s\S]*?Totals[\s\S]*?現在の仕様（openspec\/specs）に同じ名前の要件がありません/, 'a delta that names nothing is not dropped');
  assert.doesNotMatch(page, /PENDING/, 'the trace of an amendment in progress is not the evidence of an unchanged requirement');
});

test('images of screens.md and of a purpose resolve against their own files and stay inside the repository', () => {
  const dir = specs();
  write(dir, `${ARCHIVED}/shots/entry.png`, 'png');
  write(dir, `${ARCHIVED}/screens.md`, '# Screens\n\n### Screen: Entry\n![shot](shots/entry.png)\n');
  write(dir, 'openspec/specs/auth/login/spec.md', '## Purpose\nSigns in. ![o](../../../../../../outside.png)\n\n## Requirements\n');
  render({ root: dir, spec: 'all' });
  assert.match(html(dir, 'spec-billing-invoice'), /<img src="\.\.\/\.\.\/changes\/archive\/2026-11-10-extract-billing-invoice\/shots\/entry\.png"/);
  assert.doesNotMatch(html(dir, 'specs'), /outside\.png"/);
});

test('one page rendered again keeps its link to the list; names are encoded, matched without case and pages of removed specs go', () => {
  const dir = specs();
  render({ root: dir, spec: 'all' });
  render({ root: dir, spec: 'billing/invoice' });
  assert.match(html(dir, 'spec-billing-invoice'), /← 仕様の一覧/);
  assert.equal(render({ root: dir, spec: 'Billing/Invoice' }).out, 'openspec/spec-relay/views/spec-billing-invoice.html');
  write(dir, 'openspec/specs/billing/a#b/spec.md', '## Purpose\nx\n\n## Requirements\n');
  fs.rmSync(path.join(dir, 'openspec/specs/auth'), { recursive: true });
  render({ root: dir, spec: 'all' });
  assert.match(html(dir, 'specs'), /href="spec-billing-a%23b\.html"/);
  assert.equal(fs.existsSync(path.join(dir, 'openspec/spec-relay/views/spec-auth-login.html')), false);
});

test('archived amendments count in date and version order; a spec linked from outside is not read', () => {
  const dir = specs();
  for (const [v, file] of [['-v9', 'nine'], ['-v10', 'ten']]) {
    write(dir, `openspec/changes/archive/2026-11-12-amend-billing-invoice${v}/specs/billing/invoice/spec.md`, '## MODIFIED Requirements\n');
    write(dir, `openspec/changes/archive/2026-11-12-amend-billing-invoice${v}/trace.md`, `| Requirement | Source | Tests |\n|---|---|---|\n| Total | src/${file}.php:x:1 | none |\n`);
    write(dir, `src/${file}.php`, `${file.toUpperCase()}\n`);
  }
  render({ root: dir, spec: 'billing/invoice' });
  assert.match(html(dir, 'spec-billing-invoice'), /TEN/);
  const outside = tempDir();
  fs.writeFileSync(path.join(outside, 'spec.md'), '## Purpose\nSECRET\n');
  fs.mkdirSync(path.join(dir, 'openspec/specs/billing/link'));
  try { fs.symlinkSync(path.join(outside, 'spec.md'), path.join(dir, 'openspec/specs/billing/link/spec.md')); } catch { return; }
  render({ root: dir, spec: 'all' });
  assert.doesNotMatch(html(dir, 'specs'), /SECRET/);
  assert.equal(render({ root: dir, spec: 'billing/link' }).ok, false);
});

test('two amendments of one requirement each show their wording; only pages --spec wrote are removed; no link to a missing list', () => {
  const dir = specs();
  render({ root: dir, spec: 'billing/invoice' });
  assert.doesNotMatch(html(dir, 'spec-billing-invoice'), /← 仕様の一覧/, 'specs.html does not exist yet');
  write(dir, 'openspec/changes/amend-a/specs/billing/invoice/spec.md', '## MODIFIED Requirements\n\n### Requirement: Total\nThe system SHALL add the lines, ALPHA.\n');
  write(dir, 'openspec/changes/amend-b/specs/billing/invoice/spec.md', '## MODIFIED Requirements\n\n### Requirement: Total\nThe system SHALL add the lines, BETA.\n');
  write(dir, 'notes/spec-notes.md', '# Notes\n');
  render({ root: dir, file: 'notes/spec-notes.md' });
  render({ root: dir, spec: 'all' });
  const page = html(dir, 'spec-billing-invoice');
  assert.match(page, /id="R1"[\s\S]*?amend-a, amend-b[\s\S]*?amend-a<\/p>[\s\S]*?ALPHA[\s\S]*?amend-b<\/p>[\s\S]*?BETA[\s\S]*?id="R2"/);
  assert.equal(fs.existsSync(path.join(dir, 'openspec/spec-relay/views/spec-notes.html')), true, 'a page of --file is not removed');
});

test('a relative --root writes the page inside that root; a change folder linked from outside is not read', () => {
  const dir = repo();
  const parent = path.dirname(dir);
  const cwd = process.cwd();
  process.chdir(parent);
  try {
    assert.equal(render({ root: path.basename(dir), change: 'extract-billing-invoice' }).out, 'openspec/spec-relay/views/extract-billing-invoice.html');
  } finally { process.chdir(cwd); }
  assert.equal(fs.existsSync(path.join(dir, 'openspec/spec-relay/views/extract-billing-invoice.html')), true);
  const outside = tempDir();
  write(outside, 'review.md', 'Reviewer: SECRET\n\n## 1. Requirements\n- [ ] R1 SECRET\n');
  try { fs.symlinkSync(outside, path.join(dir, 'openspec/changes/extract-evil'), 'junction'); } catch { return; }
  render({ root: dir, change: 'extract-evil' });
  assert.doesNotMatch(html(dir, 'extract-evil'), /SECRET/);
});
