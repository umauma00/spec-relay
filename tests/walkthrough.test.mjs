import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { checkReview } from '../scripts/gate.mjs';
import { entryPoints, entryKey, parseWalkVerdict, walkthroughSummary, evidenceRefs } from '../scripts/walkthrough.mjs';
import { surveyCheckSummary, surveyRowStamp } from '../scripts/coverage.mjs';
import { changeSites } from '../scripts/sites.mjs';
import { inventoryRows } from '../scripts/gate.mjs';
import { merge } from '../scripts/merge.mjs';
import { items, review } from '../scripts/draft.mjs';
import { render } from '../scripts/render.mjs';
import { KIT_ROOT } from '../scripts/setup.mjs';
import { tempDir, write, crlf } from './helpers.mjs';

const PHP = `<?php\n${'//\n'.repeat(40)}`;
const X = 'openspec/changes/extract-billing-invoice';
const SPEC = '## Purpose\n\nInvoices for customers.\n\n## ADDED Requirements\n\n### Requirement: Total\nThe system SHALL add the lines.\n\n#### Scenario: Two lines\n- **WHEN** two lines\n- **THEN** the sum\n\n#### Scenario: No lines\n- **WHEN** none\n- **THEN** 0\n\n### Requirement: Reject a negative quantity\nThe system SHALL reject it.\n\n#### Scenario: Minus one\n- **WHEN** -1\n- **THEN** "Quantity must be positive"\n';
const MAP = '# Source map\n\n## Source files\n| Path | Role | In scope |\n|---|---|---|\n| `src/billing/invoice.php` | page | full |\n\n## Entry points\n- `src/billing/invoice.php` - the invoice page\n- src/billing/invoice.php:save - the Save button\n';
const WALK = '# Walkthrough\n\n| Entry point | Behavior | Verdict | Evidence |\n|---|---|---|---|\n| `src/billing/invoice.php` | shows the total | covered R1: Two lines | src/billing/invoice.php:3 - sums |\n| `src/billing/invoice.php` | an empty invoice shows 0 | covered R1: No lines | src/billing/invoice.php:4 |\n| `src/billing/invoice.php:save` | -1 is rejected with its message | covered R2: Minus one; S1 | src/billing/invoice.php:9 - throws |\n| `src/billing/invoice.php:save` | the sign-in check | other capability platform/auth | src/common/auth.php:2 - redirects to login |\n';
const REVIEW = 'Reviewer: Uma\n\n## 1. Requirements\n- [x] R1 Total\n- [x] R2 Reject a negative quantity\n\n## 2. Screens\n- [x] S1 Invoice\n\n## 3. Questions\n- [x] Q1 Rounding: decision: keep\n';

function extract({ map = MAP, walk = WALK } = {}) {
  const dir = tempDir();
  write(dir, 'openspec/config.yaml', 'context: |\n  Source root (read-only): src\n  Target root (new implementation): ts\n');
  write(dir, 'src/billing/invoice.php', PHP);
  write(dir, 'src/common/auth.php', PHP);
  write(dir, 'openspec/changes/archive/2026-11-01-survey/capabilities.md', '# Capabilities\n\n### platform\n1. `platform/auth`\n   - `src/common/`\n\n### billing\n1. `billing/invoice`\n   - `src/billing/`\n');
  write(dir, 'openspec/changes/archive/2026-11-01-survey/inventory.md', '| Path | Context | Handling | Notes |\n|---|---|---|---|\n| src/ | billing | port | |\n');
  write(dir, `${X}/.openspec.yaml`, 'schema: spec-relay-extract\n');
  write(dir, `${X}/specs/billing/invoice/spec.md`, SPEC);
  write(dir, `${X}/source-map.md`, map);
  write(dir, `${X}/trace.md`, '| Requirement | Source | Existing tests |\n|---|---|---|\n| Total | src/billing/invoice.php:3-4 | none |\n| Reject a negative quantity | src/billing/invoice.php:9 | none |\n');
  write(dir, `${X}/screens.md`, '# Screens\n\n### Screen: Invoice\n- Entry: src/billing/invoice.php\n');
  write(dir, `${X}/crosscheck.md`, '| Item | Verdict | Evidence |\n|---|---|---|\n| R1 Total | confirmed | x |\n| R2 Reject a negative quantity | confirmed | x |\n| S1 Invoice | confirmed | x |\n');
  write(dir, `${X}/coverage.md`, '| Site | Verdict | Evidence |\n|---|---|---|\n');
  write(dir, `${X}/questions.md`, '# Questions\n\n- Q1. Rounding\n  - Recommended: keep\n  - Why: as today\n');
  if (walk !== null) write(dir, `${X}/walkthrough.md`, walk);
  write(dir, `${X}/review.md`, REVIEW);
  return dir;
}
const problems = (dir) => checkReview(dir, 'extract-billing-invoice').problems;
const walkRow = (entry, behavior, verdict, evidence = 'src/billing/invoice.php:5 - x') => `| \`${entry}\` | ${behavior} | ${verdict} | ${evidence} |\n`;

test('entry points: bullets with or without backticks, a table, None, duplicates; keys ignore the letter case of the path only', () => {
  assert.deepEqual(entryPoints(MAP).map((e) => e.id), ['src/billing/invoice.php', 'src/billing/invoice.php:save']);
  assert.deepEqual([...entryPoints('## Entry points\n- None\n')], []);
  assert.equal(entryPoints('## Entry points\n- None (only definitions)\n').none, true);
  assert.equal(entryPoints(MAP).none, undefined);
  assert.equal(entryPoints('## Source files\n- `a.php`\n'), null);
  const table = '## Entry points\n| Entry point | How |\n|---|---|\n| `src/A.cs:Orders.btnSave_Click` | Save |\n\n- src/a.cs:Orders.btnSave_Click — again\n- **`src/b.php`**: the page\n';
  assert.deepEqual(entryPoints(table).map((e) => e.id), ['src/a.cs:Orders.btnSave_Click', 'src/b.php'], 'the same entry point once, whatever its path\'s letter case');
  assert.equal(entryKey('`.\\src\\A.cs:Orders.btnSave_Click`'), 'src/a.cs:Orders.btnSave_Click');
  assert.notEqual(entryKey('src/a.cs:Save'), entryKey('src/a.cs:save'));
  assert.deepEqual(entryPoints(crlf(MAP)).map((e) => e.id), entryPoints(MAP).map((e) => e.id));
  // Nested items describe their parent; "path:symbol: how" ends the id at ": ";
  // a backticked id may hold underscores; bold around it is fine.
  const more = '## Entry points\n- src/a.py:main: the command\n  - `src/a.py:helper` - called by main\n- __`src/b.py:__init__`__ - the module\n';
  assert.deepEqual(entryPoints(more).map((e) => e.id), ['src/a.py:main', 'src/b.py:__init__']);
  // A list indented as a whole, and items grouped under headings.
  assert.deepEqual(entryPoints('## Entry points\n  - `src/a.php` - page\n  - `src/b.php` - page\n').map((e) => e.id), ['src/a.php', 'src/b.php']);
  assert.deepEqual(entryPoints('## Entry points\n- Pages\n  - `src/a.php` - page\n    - shows the list\n- Jobs\n  - `src/job.php:run` - nightly\n').map((e) => e.id), ['src/a.php', 'src/job.php:run']);
  for (const none of ['- なし。', '- 特になし', '- None, only definitions']) assert.equal(entryPoints(`## Entry points\n${none}\n`).none, true, none);
});

test('walkthrough verdicts', () => {
  assert.deepEqual(parseWalkVerdict('covered R2: Minus one; S1'), { kind: 'covered', refs: [{ letter: 'R', n: 2, scenario: 'Minus one' }, { letter: 'S', n: 1 }] });
  assert.deepEqual(parseWalkVerdict('**vague R01: Two lines**'), { kind: 'vague', refs: [{ letter: 'R', n: 1, scenario: 'Two lines' }] });
  assert.deepEqual(parseWalkVerdict('other capability platform/auth'), { kind: 'other', capability: 'platform/auth' });
  assert.deepEqual(parseWalkVerdict('question Q02'), { kind: 'question', question: 'Q2' });
  assert.equal(parseWalkVerdict('gap.').kind, 'gap');
  assert.equal(parseWalkVerdict('covered').kind, 'invalid');
  assert.equal(parseWalkVerdict('covered by R1').kind, 'invalid');
  assert.equal(parseWalkVerdict('').kind, 'blank');
  // Only "; R<n>" or "; S<n>" starts the next reference: a scenario name may hold ";".
  assert.deepEqual(parseWalkVerdict('`covered R1: Save; then close`； S1'), { kind: 'covered', refs: [{ letter: 'R', n: 1, scenario: 'Save; then close' }, { letter: 'S', n: 1 }] });
});

test('evidence is prose around source locations', () => {
  const at = (text) => evidenceRefs(text).map((r) => `${r.file}|${r.symbol}|${r.from}-${r.to}`);
  assert.deepEqual(at('src/a.php:12 - throws "Quantity"'), ['src/a.php||12-12']);
  assert.deepEqual(at('`src/A.cs:Orders.btnSave_Click:3-9` saves, then src\\b.php:4, 7'), ['src/A.cs|Orders.btnSave_Click|3-9', 'src/b.php||4-4', 'src/b.php||7-7']);
  assert.deepEqual(at('`src/My Project/a.vb:2` and lib/x.php:Foo::bar'), ['src/My Project/a.vb||2-2', 'lib/x.php|Foo::bar|null-null']);
  assert.deepEqual(at('e.g. jQuery.ajax v1.2, the loop'), []);
  assert.deepEqual(at('src/a.php:L3-L5, 9 and src/v1.10/b.php:Save:3, then src/c.cs:Save.'), ['src/a.php||3-5', 'src/a.php||9-9', 'src/v1.10/b.php|Save|3-3', 'src/c.cs|Save|null-null']);
  assert.deepEqual(at('Response.Redirect("~/Orders/List.aspx") after src/o.cs:Save:3'), ['src/o.cs|Save|3-3']);
  assert.deepEqual(at('src/Orders.cs:Saveで保存する'), ['src/Orders.cs|Save|null-null']);
});

test('a walkthrough of every entry point that names real scenarios passes', () => {
  assert.deepEqual(problems(extract()), []);
  assert.deepEqual(problems(extract({ walk: crlf(`﻿${WALK}`) })), []);
});

test('the extract gate needs the walkthrough, every entry point walked, and only entry points of the source map', () => {
  assert.match(problems(extract({ walk: null })).join('\n'), /walkthrough.md is missing/);
  assert.match(problems(extract({ map: MAP.replace(/## Entry points[\s\S]*$/, '') })).join('\n'), /source-map.md lists no entry point/);
  const one = extract({ walk: WALK.split('\n').filter((l) => !l.includes(':save`')).join('\n') });
  assert.deepEqual(problems(one), [
    'entry point has no row in walkthrough.md: src/billing/invoice.php:save (have a checker walk it)',
    'no walkthrough row names a scenario of R2 "Reject a negative quantity": the entry point that leads there is missing from source-map.md or was not walked to its end; list it (a public function or a job counts) and walk it',
  ]);
  assert.match(problems(extract({ walk: `${WALK}| | rounds | covered R1: Two lines | src/billing/invoice.php:3 |\n` })).join('\n'), /1 row with an empty Entry point cell \("rounds"\)/);
  const extra = extract({ walk: `${WALK}${walkRow('src/billing/invoice.php:print', 'prints', 'covered R1: Two lines')}` });
  assert.match(problems(extra).join('\n'), /walks `src\/billing\/invoice.php:print`, which source-map.md does not list/);
  // The id is compared without the letter case of its path, and with backslashes as slashes.
  assert.deepEqual(problems(extract({ walk: WALK.replace(/`src\/billing\/invoice\.php:save`/g, '`SRC\\billing\\invoice.php:save`') })), []);
  assert.match(problems(extract({ walk: WALK.replace(/invoice\.php:save`/g, 'invoice.php:Save`') })).join('\n'), /no row in walkthrough.md: src\/billing\/invoice.php:save/);
});

test('a covered behavior names a scenario of that requirement; gaps, vague scenarios and bad verdicts fail', () => {
  const add = (row) => problems(extract({ walk: `${WALK}${row}` })).join('\n');
  assert.match(add(walkRow('src/billing/invoice.php', 'a discount over 100', 'gap')), /is a gap: add the requirement it needs at the end of the spec/);
  assert.match(add(walkRow('src/billing/invoice.php', 'rounds half up', 'vague R1: Two lines')), /is vague: the scenario does not state the condition or the values/);
  assert.match(add(walkRow('src/billing/invoice.php', 'rounds', 'covered R1: Three lines')), /names the scenario "Three lines", which R1 "Total" does not have/);
  assert.match(add(walkRow('src/billing/invoice.php', 'rounds', 'covered R1')), /names R1 without its scenario/);
  assert.match(add(walkRow('src/billing/invoice.php', 'rounds', 'covered R3: x')), /names R3, but the change has only R1-R2 as requirements/);
  assert.match(add(walkRow('src/billing/invoice.php', 'shows', 'covered S2')), /names S2, but the change has only S1-S1 as screens/);
  assert.match(add(walkRow('src/billing/invoice.php', 'rounds', 'question Q2')), /points to Q2, which is not in questions.md with a review item/);
  assert.match(add(walkRow('src/billing/invoice.php', 'rounds', 'looks fine')), /has the verdict "looks fine"; write only covered R<n>: <scenario name>/);
  assert.match(add(walkRow('src/billing/invoice.php', '', 'covered R1: Two lines')), /names no behavior/);
  assert.match(add(walkRow('src/billing/invoice.php', 'sums', 'covered R1: Two lines', '-')), /has no evidence/);
  // Scenario names are compared without case, marks, quotes or a final stop.
  assert.equal(add(walkRow('src/billing/invoice.php', 'sums', 'covered R1: "two LINES".')), '');
  // The evidence cites code that exists.
  assert.match(add(walkRow('src/billing/invoice.php', 'sums', 'covered R1: Two lines', 'the loop sums the lines')), /cites no source location/);
  assert.match(add(walkRow('src/billing/invoice.php', 'sums', 'covered R1: Two lines', 'src/billing/total.php:3')), /cites no file that exists \(src\/billing\/total.php\)/);
  assert.match(add(walkRow('src/billing/invoice.php', 'sums', 'covered R1: Two lines', 'src/billing/invoice.php:40-90')), /gives src\/billing\/invoice.php the lines 40-90, but the file has 41 lines/);
  assert.equal(add(walkRow('src/billing/invoice.php', 'rounding', 'question Q1')), '');
  // Japanese prose glued to a path still finds the file.
  assert.equal(add(walkRow('src/billing/invoice.php', '合計', 'covered R1: Two lines', '入口のsrc/billing/invoice.php:3-4で合計')), '');
  // A vague R2 moved to a question still counts for R2 when the evidence names it.
  const moved = WALK.replace('| covered R2: Minus one; S1 |', '| question Q1 |').replace('src/billing/invoice.php:9 - throws', 'R2: src/billing/invoice.php:9 - throws');
  assert.deepEqual(problems(extract({ walk: moved })), []);
});

test('another capability must be in the plan, not this one, and own the code the evidence cites', () => {
  const add = (row) => problems(extract({ walk: `${WALK}${row}` })).join('\n');
  assert.match(add(walkRow('src/billing/invoice.php', 'x', 'other capability billing/invoice')), /names its own capability/);
  assert.match(add(walkRow('src/billing/invoice.php', 'x', 'other capability platform/mail')), /names platform\/mail, which is not a capability of the plan/);
  assert.match(add(walkRow('src/billing/invoice.php', 'x', 'other capability platform/auth', 'src/billing/invoice.php:7 - calls auth')), /cites no file the plan gives to that capability/);
});

test('every effect line of a covered site is reached by some walk; None passes only without such lines', () => {
  const CODE = '<?php\nfunction save($db, $q) {\n  if ($q < 0) {\n    throw new Exception("Quantity must be positive");\n  }\n  $db->exec("INSERT INTO lines VALUES (1)");\n}\n';
  const dir = extract();
  write(dir, 'src/billing/invoice.php', CODE);
  write(dir, `${X}/trace.md`, '| Requirement | Source | Existing tests |\n|---|---|---|\n| Total | src/billing/invoice.php:save | none |\n| Reject a negative quantity | src/billing/invoice.php:save | none |\n');
  const sites = changeSites(dir, path.join(dir, X));
  assert.ok(sites.length > 0 && sites.some((s) => s.markers.length), 'the fixture has effect lines');
  write(dir, `${X}/coverage.md`, `| Site | Verdict | Evidence |\n|---|---|---|\n${sites.map((s) => `| \`${s.id}\` | covered R1, R2 | saves |`).join('\n')}\n`);
  const shallow = WALK.replace(/invoice\.php:(3|4|9)\b/g, 'invoice.php:2');
  write(dir, `${X}/walkthrough.md`, shallow);
  assert.match(problems(dir).join('\n'), /no covered walkthrough row reaches the effect lines of src\/billing\/invoice.php:save \(.*4.*6.*\), which coverage.md judges covered/);
  // Citing the member reaches every line of it.
  write(dir, `${X}/walkthrough.md`, shallow.replace('invoice.php:2 - throws', 'invoice.php:save'));
  assert.deepEqual(problems(dir), []);
  // Only a covered row reaches; a whole-file range does not stand for the lines in it.
  const pooled = `${shallow}| \`src/billing/invoice.php\` | rounding | question Q1 | src/billing/invoice.php:save |\n`;
  write(dir, `${X}/walkthrough.md`, pooled);
  assert.match(problems(dir).join('\n'), /no covered walkthrough row reaches/);
  write(dir, `${X}/walkthrough.md`, shallow.replace('invoice.php:2 - throws', 'invoice.php:1-60'));
  assert.match(problems(dir).join('\n'), /gives src\/billing\/invoice.php the lines 1-60, but the file has 7 lines/);
  write(dir, `${X}/walkthrough.md`, shallow.replace('invoice.php:2 - throws', '`src/billing/invoice.php:(file):4-6` throws, then header("Location: /billing/list.php") and calls https://api.example.com/v2/charge.json'));
  assert.deepEqual(problems(dir), [], 'a redirect target or a URL in the prose is not a missing file');
  // "None" is for a capability nothing calls into: not with effect lines judged covered.
  const none = MAP.replace(/## Entry points[\s\S]*$/, '## Entry points\n- None (only definitions)\n');
  write(dir, `${X}/source-map.md`, none);
  write(dir, `${X}/walkthrough.md`, '# Walkthrough\n\n| Entry point | Behavior | Verdict | Evidence |\n|---|---|---|---|\n');
  assert.match(problems(dir).join('\n'), /says the capability has no entry point \("None"\), but coverage.md judges src\/billing\/invoice.php:save/);
  const quiet = extract({ map: none, walk: '# Walkthrough\n\n| Entry point | Behavior | Verdict | Evidence |\n|---|---|---|---|\n' });
  assert.deepEqual(problems(quiet), []);
});

test('draft.mjs items gives the entry points; the review page counts the walkthrough', () => {
  const dir = extract();
  assert.deepEqual(items(dir, 'extract-billing-invoice').entryPoints, ['src/billing/invoice.php', 'src/billing/invoice.php:save']);
  write(dir, `${X}/source-map.md`, MAP.replace(/## Entry points[\s\S]*$/, ''));
  assert.match(items(dir, 'extract-billing-invoice').problems.join('\n'), /source-map.md has no "## Entry points" section/);
  write(dir, `${X}/source-map.md`, MAP);
  const sum = walkthroughSummary(path.join(dir, X));
  assert.deepEqual([sum.entries, sum.behaviors, sum.counts.covered, sum.counts.other, sum.unwalked.length], [2, 4, 3, 1, 0]);
  render({ root: dir, change: 'extract-billing-invoice', lang: 'ja', now: new Date('2026-11-25T00:00:00Z') });
  const html = fs.readFileSync(path.join(dir, 'openspec/spec-relay/views/extract-billing-invoice.html'), 'utf8');
  assert.match(html, /入口からの見直し/);
  assert.match(html, /入口 2・確かめた動作 4・シナリオあり 3・別の capability 1/);
  assert.match(html, /id="doc-walkthrough-md"/);
});

test('walkthrough parts merge by entry point: a later part replaces all the rows of an entry point', () => {
  const dir = extract({ walk: null });
  fs.cpSync(path.join(KIT_ROOT, 'openspec-schemas/spec-relay-extract'), path.join(dir, 'openspec/schemas/spec-relay-extract'), { recursive: true });
  const W = 'openspec/spec-relay/work/extract-billing-invoice/walkthrough';
  const head = '| Entry point | Behavior | Verdict | Evidence |\n|---|---|---|---|\n';
  write(dir, `${W}/01.md`, `${head}${walkRow('src/billing/invoice.php:save', 'rejects -1', 'gap')}${walkRow('src/billing/invoice.php:save', 'saves', 'covered R1: Two lines')}`);
  write(dir, `${W}/02.md`, `${head}${walkRow('src/billing/invoice.php', 'shows the total', 'covered R1: Two lines')}`);
  let result = merge(dir, { into: `${X}/walkthrough.md`, parts: [W], clean: true });
  assert.equal(result.ok, true, result.problems?.join('\n'));
  assert.deepEqual([result.rows, result.entries], [3, 2]);
  let text = fs.readFileSync(path.join(dir, X, 'walkthrough.md'), 'utf8');
  assert.match(text, /^# Walkthrough\n\n\| Entry point \|/);
  assert.doesNotMatch(text, /<!--/);
  assert.ok(text.indexOf('shows the total') < text.indexOf('rejects -1'), 'sorted by entry point');
  // Walked again after the fix: both old rows of :save go, the new ones stay together.
  write(dir, `${W}/03.md`, `${head}${walkRow('src/billing/invoice.php:save', 'rejects -1', 'covered R2: Minus one')}`);
  result = merge(dir, { into: `${X}/walkthrough.md`, parts: [W], clean: true });
  assert.deepEqual([result.ok, result.rows, result.replaced, result.added], [true, 2, 1, 0]);
  text = fs.readFileSync(path.join(dir, X, 'walkthrough.md'), 'utf8');
  assert.doesNotMatch(text, /\| gap \|/);
  assert.doesNotMatch(text, /saves/);
  assert.deepEqual(result.dropped, ['`src/billing/invoice.php:save` | rejects -1 | gap']);
  // Two checkers of one wave walked the same entry point: their rows add up.
  write(dir, `${W}/04.md`, `${head}${walkRow('src/billing/invoice.php', 'shows 0', 'covered R1: No lines')}`);
  write(dir, `${W}/05.md`, `${head}${walkRow('src/billing/invoice.php', 'shows the total', 'covered R1: Two lines')}`);
  result = merge(dir, { into: `${X}/walkthrough.md`, parts: [W], clean: true });
  assert.deepEqual([result.ok, result.rows, result.replaced], [true, 3, 1]);
  // A table headed "Entry" is a walkthrough too, for the merge as for the gate.
  write(dir, `${W}/06.md`, `| Entry | Behavior | Verdict | Evidence |\n|---|---|---|---|\n${walkRow('src/billing/invoice.php', 'shows the total', 'covered R1: Two lines')}`);
  write(dir, `${X}/walkthrough.md`, '');
  result = merge(dir, { into: `${X}/walkthrough.md`, parts: [W], clean: true });
  assert.deepEqual([result.ok, result.entries], [true, 1]);
});

// ---------------------------------------------------------------- survey crosscheck

const S = 'openspec/changes/survey';
const INVENTORY = '| Path | Context | Handling | Notes |\n|---|---|---|---|\n| src/billing/ | billing | port | |\n| src/common/S1.php | platform | port | |\n| src/vendor/ | excluded | | library |\n';
const CHECK = '# Crosscheck\n\n| Path | Verdict | Evidence |\n|---|---|---|\n| `src/billing/` | confirmed | invoice.php: the page |\n| src/common/S1.php | confirmed | the db helper |\n| src/vendor/ | confirmed | jQuery 1.4 |\n';
const SURVEY_REVIEW = 'Reviewer: Uma\n\n## 1. Contexts\n- [x] K1 platform: 共通\n- [x] K2 billing: 請求\n\n## 2. Map\n- [x] M1 a\n- [x] M2 b\n- [x] M3 c\n- [x] M4 d\n- [x] M5 e\n\n## 3. Coverage\n- [x] C1 excluded\n';

// The code merge.mjs writes into each crosscheck row: of the inventory row as it is.
function stamped(text, inventory = INVENTORY) {
  const rows = new Map(inventoryRows(inventory).map((r) => [r.path.toLowerCase(), r]));
  return text.replace(/^\|([^|\n]*)\|([^|\n]*)\|/gm, (all, where, verdict) => {
    const row = rows.get(where.trim().replace(/`/g, '').toLowerCase());
    return row ? `|${where}| ${verdict.trim()} <!-- row ${surveyRowStamp(row)} --> |` : all;
  });
}

function survey({ check = CHECK, reviewText = SURVEY_REVIEW } = {}) {
  const dir = tempDir();
  write(dir, 'openspec/config.yaml', 'context: |\n  Source root (read-only): src\n');
  for (const f of ['src/billing/invoice.php', 'src/common/S1.php', 'src/vendor/lib.php']) write(dir, f, PHP);
  write(dir, `${S}/.openspec.yaml`, 'schema: spec-relay-survey\n');
  write(dir, `${S}/context-map.md`, '## Contexts\n\n### Context: platform\n- Name: 共通\n\n### Context: billing\n- Name: 請求\n');
  write(dir, `${S}/inventory.md`, INVENTORY);
  write(dir, `${S}/capabilities.md`, '### platform\n1. `platform/db`\n   - `src/common/`\n\n### billing\n1. `billing/invoice`\n   - `src/billing/`\n');
  write(dir, `${S}/database.md`, '## Databases\nNone\n\n## Logic in the database\nNone\n\n## Missing definitions\nNone\n\n## Snapshot\nsha256: none\n');
  if (check !== null) write(dir, `${S}/crosscheck.md`, stamped(check));
  if (reviewText !== null) write(dir, `${S}/review.md`, reviewText);
  return dir;
}
const surveyProblems = (dir) => checkReview(dir, 'survey').problems;

test('the survey gate needs one confirmed crosscheck row per inventory row', () => {
  assert.deepEqual(surveyProblems(survey()), []);
  assert.match(surveyProblems(survey({ check: null })).join('\n'), /crosscheck.md is missing/);
  assert.deepEqual(surveyProblems(survey({ check: CHECK.replace(/\| src\/vendor\/[^\n]*\n/, '') })), ['inventory row has no crosscheck row: src/vendor/ (have a checker judge it)']);
  assert.match(surveyProblems(survey({ check: `${CHECK}| src/old/ | confirmed | x |\n` })).join('\n'), /row for src\/old\/, which is not a row of inventory.md/);
  assert.match(surveyProblems(survey({ check: `${CHECK}| SRC/vendor/ | confirmed | x |\n` })).join('\n'), /more than one crosscheck row: SRC\/vendor\//);
  const wrong = surveyProblems(survey({ check: CHECK.replace('| src/vendor/ | confirmed | jQuery 1.4 |', '| src/vendor/ | mismatch | lib.php:3 writes orders |') }));
  assert.deepEqual(wrong, ['crosscheck of src/vendor/ is "mismatch"; fix the survey and have a checker judge the row again, or write "question" for the person to decide (item C2)']);
  assert.deepEqual(surveyProblems(survey({ check: CHECK.replace('| jQuery 1.4 |', '| - |') })), ['crosscheck of src/vendor/ is confirmed with no evidence; say which files the checker read and what it found there']);
  // A row judged before the inventory row changed, or written without merge.mjs, is not a check of the row as it is.
  const dir = survey();
  write(dir, `${S}/inventory.md`, INVENTORY.replace('| library |', '| library, patched |'));
  assert.deepEqual(surveyProblems(dir), ['inventory row src/vendor/ changed after the crosscheck judged it (context, handling or notes); have a checker judge the row again and merge its part']);
  write(dir, `${S}/inventory.md`, INVENTORY);
  write(dir, `${S}/crosscheck.md`, CHECK);
  assert.equal(surveyProblems(dir).length, 3);
  assert.match(surveyProblems(dir)[0], /crosscheck row of src\/billing\/ carries no code of the inventory row it judged; merge the checker's part with merge.mjs/);
});

test('rows left to the person need C2 with the code of the list as it is', () => {
  const asked = CHECK.replace('| src/vendor/ | confirmed | jQuery 1.4 |', '| src/vendor/ | question | lib.php:3 writes the orders table: is it still used? |');
  const dir = survey({ check: asked });
  assert.match(surveyProblems(dir).join('\n'), /review.md has no C2 item/);
  // draft.mjs adds the item in the gate's words; the person ticks it.
  const drafted = review(dir, 'survey', { update: true });
  assert.equal(drafted.ok, true, drafted.problems?.join('\n'));
  const text = fs.readFileSync(path.join(dir, S, 'review.md'), 'utf8');
  const c2 = text.match(/- \[ \] (C2 The survey crosscheck leaves 1 row for you to decide \(list [0-9a-f]{6}\))/);
  assert.ok(c2, text);
  write(dir, `${S}/review.md`, `${SURVEY_REVIEW}- [x] ${c2[1]}\n`);
  assert.deepEqual(surveyProblems(dir), []);
  // Another row left to the person changes the code: the tick no longer counts.
  write(dir, `${S}/crosscheck.md`, stamped(asked.replace('| src/common/S1.php | confirmed | the db helper |', '| src/common/S1.php | question | also billing? |')));
  assert.match(surveyProblems(dir).join('\n'), /review item C2 is not for the list as it is now/);
  // A question needs its evidence; a C2 without questions is stale.
  write(dir, `${S}/crosscheck.md`, stamped(CHECK.replace('| src/vendor/ | confirmed | jQuery 1.4 |', '| src/vendor/ | question | |')));
  assert.match(surveyProblems(dir).join('\n'), /crosscheck of src\/vendor\/ is a question with no evidence/);
  write(dir, `${S}/crosscheck.md`, stamped(CHECK));
  assert.match(surveyProblems(dir).join('\n'), /review.md has a C2 item, but the survey crosscheck leaves no row to the person/);
});

test('survey crosscheck: items lists the rows, parts merge by path, the review page counts them', () => {
  const dir = survey({ check: null });
  assert.deepEqual(items(dir, 'survey').paths, ['src/billing/', 'src/common/S1.php', 'src/vendor/']);
  fs.cpSync(path.join(KIT_ROOT, 'openspec-schemas/spec-relay-survey'), path.join(dir, 'openspec/schemas/spec-relay-survey'), { recursive: true });
  const W = 'openspec/spec-relay/work/survey/crosscheck';
  write(dir, `${W}/01.md`, '| Path | Verdict | Evidence |\n|---|---|---|\n| src/common/S1.php | mismatch | also billing |\n| src/billing/ | confirmed | the page |\n');
  write(dir, `${W}/02.md`, '| Path | Verdict | Evidence |\n|---|---|---|\n| src/vendor/ | confirmed | jQuery |\n| src/common/S1.php | question | also billing? |\n');
  const result = merge(dir, { into: `${S}/crosscheck.md`, parts: [W], clean: true });
  assert.equal(result.ok, true, result.problems?.join('\n'));
  assert.equal(result.rows, 3, 'a path like S1.php is a path, not the id S1');
  // The checker copies the code items gives; a part judged before the row changed is refused.
  const { codes } = items(dir, 'survey');
  assert.equal(codes['src/vendor/'], surveyRowStamp(inventoryRows(INVENTORY)[2]));
  write(dir, `${W}/03.md`, `| Path | Verdict | Evidence |\n|---|---|---|\n| src/vendor/ | confirmed <!-- row ${codes['src/vendor/']} --> | jQuery |\n`);
  write(dir, `${S}/inventory.md`, INVENTORY.replace('| library |', '| library, patched |'));
  const refused = merge(dir, { into: `${S}/crosscheck.md`, parts: [W] });
  assert.equal(refused.ok, false);
  assert.match(refused.problems.join('\n'), /judged src\/vendor\/ as the inventory row was before it changed/);
  write(dir, `${S}/inventory.md`, INVENTORY);
  assert.equal(merge(dir, { into: `${S}/crosscheck.md`, parts: [W], clean: true }).ok, true);
  // A blank handling is port: writing it out changes nothing the checker judged.
  write(dir, `${S}/inventory.md`, INVENTORY.replace('| src/billing/ | billing | port |', '| src/billing/ | billing | |'));
  assert.doesNotMatch(surveyProblems(dir).join('\n'), /changed after the crosscheck/);
  write(dir, `${S}/inventory.md`, INVENTORY);
  assert.match(fs.readFileSync(path.join(dir, S, 'crosscheck.md'), 'utf8'), new RegExp(`\\| src/vendor/ \\| confirmed <!-- row ${surveyRowStamp(inventoryRows(INVENTORY)[2])} --> \\|`));
  const sum = surveyCheckSummary(path.join(dir, S), inventoryRows(INVENTORY));
  assert.deepEqual([sum.rows, sum.confirmed, sum.questions.length, sum.open.length, sum.unchecked.length], [3, 2, 1, 0, 0]);
  render({ root: dir, change: 'survey', lang: 'ja', now: new Date('2026-11-25T00:00:00Z') });
  const html = fs.readFileSync(path.join(dir, 'openspec/spec-relay/views/survey.html'), 'utf8');
  assert.match(html, /行 3・一致 2・判断待ち 1/);
  assert.match(html, /review\.md の C2/);
});
