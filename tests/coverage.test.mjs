import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { capabilitySources, ownersOf, checkCoverage, checkTrace, contextOf, inventoryRows, traceRefs } from '../scripts/coverage.mjs';
import { checkReview, main } from '../scripts/gate.mjs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { tempDir, writeChecked as write, quiet, crlf } from './helpers.mjs';

const KIT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const SURVEY = 'openspec/changes/archive/2026-11-01-survey';
const SPEC = '## Purpose\n\nInvoices for customers.\n\n## ADDED Requirements\n\n### Requirement: Total\nThe system SHALL add.\n\n#### Scenario: s\n- **WHEN** x\n- **THEN** y\n';
const CHANGE = 'openspec/changes/extract-billing-invoice';
const CAPABILITIES = '# Capabilities\n\n### platform\n1. `platform/db` DB\n   - `src/common/`\n\n### billing\n1. `billing/invoice` 請求書\n   - `src/billing/`\n2. `billing/tax` 税\n   - `src/billing/tax.php`\n';

// An archived survey over src/ and an extract change of billing/invoice that is
// ready for the gate except where a test changes it.
function project({ capabilities = CAPABILITIES, sourceMap = ['src/billing/invoice.php', 'src/billing/print.php'] } = {}) {
  const dir = tempDir();
  write(dir, 'openspec/config.yaml', 'context: |\n  Source root (read-only): src\n  Target root (new implementation): ts\n');
  for (const f of ['src/billing/invoice.php', 'src/billing/print.php', 'src/billing/tax.php', 'src/common/db.php', 'src/vendor/lib.php']) write(dir, f, PHP);
  write(dir, `${SURVEY}/inventory.md`, '| Path | Context | Notes |\n|---|---|---|\n| src/billing/ | billing | |\n| src/common/ | platform | |\n| src/vendor/ | excluded | library |\n');
  write(dir, `${SURVEY}/capabilities.md`, capabilities);
  write(dir, `${CHANGE}/.openspec.yaml`, 'schema: spec-relay-extract\n');
  write(dir, `${CHANGE}/specs/billing/invoice/spec.md`, SPEC);
  write(dir, `${CHANGE}/screens.md`, 'None\n');
  write(dir, `${CHANGE}/questions.md`, 'None\n');
  write(dir, `${CHANGE}/crosscheck.md`, '| Item | Verdict | Evidence |\n|---|---|---|\n| R1 Total | confirmed | src/billing/invoice.php:3 |\n');
  write(dir, `${CHANGE}/trace.md`, '| Requirement | Source | Existing tests |\n|---|---|---|\n| R1 Total | src/billing/invoice.php:Invoice.total:3-9 | none |\n');
  write(dir, `${CHANGE}/source-map.md`, `# Source map\n\n## Source files\n| Path | Role | In scope |\n|---|---|---|\n${sourceMap.map((p) => `| \`${p}\` | x | full |`).join('\n')}\n\n## Dependencies\n| Dependency | Use |\n|---|---|\n| MySQL invoices table | reads |\n`);
  write(dir, `${CHANGE}/review.md`, 'Reviewer: Uma\n- [x] R1 Total\n- [x] S0 This capability has no screens\n');
  write(dir, `${CHANGE}/coverage.md`, '| Site | Verdict | Evidence |\n|---|---|---|\n');
  return dir;
}
const problems = (dir) => checkReview(dir, 'extract-billing-invoice').problems;

test('capability sources: indented items under each capability, in the plan only under ## Capabilities', () => {
  const text = '### billing\n1. `billing/invoice` 請求書\n   - `src/billing/` and `src/shared/money.php`\n   - src/print/\n   - 印刷まわり\n   <!-- - `src/hidden/` -->\n2. `billing/tax`\n    1. `src/tax.php`\n### platform\n   - `src/orphan/`\n- `platform/db`\n';
  assert.deepEqual([...capabilitySources(text)], [
    ['billing/invoice', ['src/billing/', 'src/shared/money.php', 'src/print/']],
    ['billing/tax', ['src/tax.php']],
    ['platform/db', []],
  ]);
  assert.deepEqual([...capabilitySources(crlf(text))], [...capabilitySources(text)]);
  const plan = '# Plan\n\n## Capabilities\n\n### billing\n1. `billing/invoice`\n   - `.\\src\\billing\\`\n\n## Follow-up\n\n1. `billing/tax` later\n   - `src/tax.php`\n';
  assert.deepEqual([...capabilitySources(plan, /^capabilities/i)], [['billing/invoice', ['src/billing/']]]);
});

test('owners: the most specific listing wins, and the same file may have several owners', () => {
  const map = capabilitySources(CAPABILITIES);
  assert.deepEqual(ownersOf(map, 'src/billing/invoice.php'), ['billing/invoice']);
  assert.deepEqual(ownersOf(map, 'src/billing/tax.php'), ['billing/tax']);
  assert.deepEqual(ownersOf(map, 'src/other.php'), []);
  const shared = capabilitySources('1. `a/x`\n   - `src/god.php`\n2. `b/y`\n   - `src/god.php`\n   - `src/`\n');
  assert.deepEqual(ownersOf(shared, 'src/god.php'), ['a/x', 'b/y']);
  const rows = inventoryRows('| Path | Context |\n|---|---|\n| src/ | billing |\n| src/vendor/ | excluded |\n| src/vendor/patched.php | billing |\n');
  assert.equal(contextOf(rows, 'src/vendor/lib.php'), 'excluded');
  assert.equal(contextOf(rows, 'src/vendor/patched.php'), 'billing');
  assert.equal(contextOf(rows, 'docs/x.md'), null);
});

test('the survey gate needs every kept file in a capability, and every listed path to exist', () => {
  const dir = tempDir();
  const S = 'openspec/changes/survey';
  write(dir, 'openspec/config.yaml', 'context: |\n  Source root (read-only): src\n');
  for (const f of ['src/billing/invoice.php', 'src/common/db.php', 'src/vendor/lib.php']) write(dir, f, PHP);
  write(dir, `${S}/.openspec.yaml`, 'schema: spec-relay-survey\n');
  write(dir, `${S}/context-map.md`, '### Context: platform\n\n### Context: billing\n');
  write(dir, `${S}/inventory.md`, '| Path | Context | Handling | Notes |\n|---|---|---|---|\n| src/billing/ | billing | port | |\n| src/common/ | platform | port | |\n| src/vendor/ | excluded | | library |\n');
  write(dir, `${S}/review.md`, 'Reviewer: Uma\n- [x] K1 platform\n- [x] K2 billing\n- [x] M1 map\n- [x] M2 owners\n- [x] M3 glossary\n- [x] M4 capabilities\n- [x] M5 carry\n- [x] C1 coverage\n');
  write(dir, `${S}/database.md`, '## Databases\nNone\n\n## Logic in the database\nNone\n');
  write(dir, `${S}/capabilities.md`, '### platform\n1. `platform/db`\n\n### billing\n1. `billing/invoice`\n   - `src/billing`\n');
  const found = checkReview(dir, 'survey').problems;
  assert.ok(found.includes('source file is in no capability of capabilities.md: src/common/db.php (list it, or its folder, under a capability, or mark it excluded in inventory.md)'), found.join('\n'));
  assert.ok(found.includes('capability platform/db owns no source file in capabilities.md; list its folders or files in indented items under it'), found.join('\n'));
  assert.ok(!found.some((p) => p.includes('vendor')), 'excluded files need no capability');
  // A folder listed without its trailing "/" is still the folder.
  write(dir, `${S}/capabilities.md`, '### platform\n1. `platform/db`\n   - `src/common/db.php`\n\n### billing\n1. `billing/invoice`\n   - `src/billing`\n   - `src/biling/`\n');
  assert.deepEqual(checkReview(dir, 'survey').problems, ['capabilities.md lists src/biling/ under billing/invoice, but no source file is there']);
  write(dir, `${S}/capabilities.md`, '### platform\n1. `platform/db`\n   - `src/common/db.php`\n\n### billing\n1. `billing/invoice`\n   - `src/billing/`\n');
  assert.deepEqual(checkReview(dir, 'survey'), { ok: true, problems: [] });
});

test('the extract gate needs a source map with the files the plan assigns to the capability', () => {
  assert.deepEqual(checkReview(project(), 'extract-billing-invoice'), { ok: true, problems: [] });

  const short = project({ sourceMap: ['src/billing/invoice.php'] });
  assert.deepEqual(problems(short), ['source file assigned to billing/invoice in capabilities.md of the archived survey is not in source-map.md: src/billing/print.php (add it, or move it to the capability it belongs to in openspec/spec-relay/plan.md)']);
  // The plan is the live assignment: moving the file to another capability there settles it.
  write(short, 'openspec/spec-relay/plan.md', `# Plan\n\n## Capabilities\n\n${CAPABILITIES.replace('# Capabilities\n\n', '').replace('   - `src/billing/tax.php`', '   - `src/billing/tax.php`\n   - `src/billing/print.php`')}`);
  assert.deepEqual(problems(short), []);
  // A plan copied without the source items still uses the survey's assignment.
  write(short, 'openspec/spec-relay/plan.md', '# Plan\n\n## Capabilities\n\n1. `platform/db`\n1. `billing/invoice`\n2. `billing/tax`\n');
  assert.match(problems(short).join(), /src\/billing\/print.php/);

  // A folder row covers the files below it; a row that does not exist is a typo.
  assert.deepEqual(problems(project({ sourceMap: ['src/billing/'] })), []);
  assert.deepEqual(problems(project({ sourceMap: ['src/billing/invoice.php', 'src/billing/print.php', 'src/billing/Invoce.php'] })), ['source-map.md lists src/billing/Invoce.php, which does not exist']);
  const empty = project();
  write(empty, `${CHANGE}/source-map.md`, '# Source map\n\n## Source files\n| Path | Role | In scope |\n|---|---|---|\n');
  assert.match(problems(empty).join(), /source-map.md lists no source files/);
  fs.rmSync(path.join(empty, CHANGE, 'source-map.md'));
  assert.match(problems(empty).join(), /source-map.md is missing/);
});

test('the extract gate needs a trace row with existing source files for every requirement', () => {
  const dir = project();
  const trace = (rows) => write(dir, `${CHANGE}/trace.md`, `| Requirement | Source | Existing tests |\n|---|---|---|\n${rows}`);
  trace('| Total | `src/billing/invoice.php:Invoice.total:3`; src/billing/print.php:Print::run | none |\n');
  assert.deepEqual(problems(dir), []);
  trace('| Other | src/billing/invoice.php:3 | none |\n');
  assert.deepEqual(problems(dir), ['requirement has no trace row: "Total"']);
  trace('| Total | see the invoice class | none |\n');
  assert.deepEqual(problems(dir), ['the trace row of "Total" names no source location (path:symbol:lines)']);
  trace('| Total | src/billing/invoices.php:3, src/../../etc/passwd.txt:1 | none |\n');
  assert.deepEqual(problems(dir), ['the trace of "Total" points to src/billing/invoices.php, which does not exist', 'the trace of "Total" points to src/../../etc/passwd.txt, which does not exist']);
  fs.rmSync(path.join(dir, CHANGE, 'trace.md'));
  assert.deepEqual(problems(dir), ['trace.md is missing']);
});

test('trace references to files without an extension, dotfiles, dotted folders and backslashes pass the gate', () => {
  const files = ['src/billing/Makefile', 'src/billing/.gitignore', 'src/billing/v1.2/Dockerfile', 'src/billing/bin/console'];
  const dir = project({ sourceMap: ['src/billing/invoice.php', 'src/billing/print.php', ...files] });
  for (const f of files) write(dir, f, 'a\nb\nc\nd\n');
  write(dir, `${CHANGE}/coverage.md`, `| Site | Verdict | Evidence |\n|---|---|---|\n${files.map((f) => `| \`${f}:(file)\` | covered: R1 | x |`).join('\n')}\n`);
  const trace = (source) => write(dir, `${CHANGE}/trace.md`, `| Requirement | Source | Existing tests |\n|---|---|---|\n| Total | ${source} | none |\n`);
  // Each alone: a cell whose only reference was dropped used to stop the gate.
  for (const source of ['src/billing/Makefile:build:2-3', 'src/billing/.gitignore:1-2', 'src\\billing\\v1.2\\Dockerfile:4', 'src/billing/bin/console:main']) {
    trace(source);
    assert.deepEqual(problems(dir), [], source);
  }
  // Together: none is dropped beside another.
  trace('`src/billing/Makefile:build:2-3`<br>src/billing/.gitignore:1-2; src\\billing\\v1.2\\Dockerfile:4, src/billing/bin/console:main');
  assert.deepEqual(problems(dir), []);
  assert.deepEqual(traceRefs(path.join(dir, CHANGE), dir).get('total').map((r) => r.file), files);
  trace('src/billing/Makefile:2-9');
  assert.deepEqual(problems(dir), ['the trace of "Total" gives src/billing/Makefile the lines 2-9, but the file has 4 lines']);
  trace('src/billing/.gitignore');
  assert.deepEqual(problems(dir), ['the trace of "Total" names only the file src/billing/.gitignore; add the symbol or the lines (path:symbol:lines)']);
  trace('src/billing/GNUmakefile:1');
  assert.deepEqual(problems(dir), ['the trace of "Total" points to src/billing/GNUmakefile, which does not exist']);
  // A "," or a note inside a cell is not a file: cells that passed before still pass.
  for (const source of ['src/billing/invoice.php:Page_Load, btnSave_Click:3-9', 'src/billing/invoice.php:total(int $qty, \\App\\Money $rate):3-9', 'src/billing/invoice.php:Invoice.total:3<br>注: 税は別']) {
    trace(source);
    assert.deepEqual(problems(dir), [], source);
  }
  for (const prose of ['see the Makefile', '注: 税は別', 'InvoiceController:index', 'src/billing:Invoice.total', 'Billing::Total', 'TODO: fill in later', 'n/a']) {
    trace(prose);
    assert.deepEqual(problems(dir), ['the trace row of "Total" names no source location (path:symbol:lines)'], prose);
  }
});

test('reading listings: first path of an item, tabs, items that end a capability, links and symbols', () => {
  const text = '1. `billing/invoice`\n   - `src/common/God.php` (`formatMoney`, `roundTax`)\n\t- `src/tabbed/`\n   - [src/linked.php](../src/linked.php)\n   - N/A\n   - src/print/, and its helpers\n2. **`billing/tax`** 税\n   - `src/tax/`\n';
  assert.deepEqual([...capabilitySources(text)], [['billing/invoice', ['src/common/God.php', 'src/tabbed/', 'src/linked.php', 'src/print/']]]);
});

test('reading listings: dotfiles and backticked files without an extension', () => {
  const text = '1. `ops/build`\n   - .gitignore\n   - .editorconfig (root)\n   - `Makefile` (build)\n   - `docker\\Dockerfile`\n   - Makefile and friends\n   - .. and more\n   - Billing\\Invoice 名前空間のクラス\n';
  assert.deepEqual([...capabilitySources(text)], [['ops/build', ['.gitignore', '.editorconfig', 'Makefile', 'docker/Dockerfile']]]);
});

test('source maps: the Source files table only, any letter case, rows marked out of scope do not count', () => {
  const dir = project();
  const map = (heading, rows) => write(dir, `${CHANGE}/source-map.md`, `# Source map\n\n${heading}\n| Path | Role | In scope |\n|---|---|---|\n${rows}\n## 3. Entry points\n| Entry | Where |\n|---|---|\n| total | src/billing/invoice.php:Invoice.total |\n`);
  map('## 2. ソースファイル', '| `src/Billing/Invoice.php` (partial) | x | full |\n| src/billing/print.php | x | partial |\n');
  assert.deepEqual(problems(dir).filter((p) => !p.includes('does not exist')), []);
  map('## Source files', '| src/billing/invoice.php | x | full |\n| src/billing/print.php | x | 範囲外 |\n');
  assert.match(problems(dir).join(), /not in source-map.md: src\/billing\/print.php/);
});

test('source map cells: a path with spaces, notes after the path, out-of-scope notes', () => {
  const dir = project({ sourceMap: [] });
  write(dir, 'src/billing/My Project/AssemblyInfo.vb', 'Imports System\n');
  write(dir, `${CHANGE}/source-map.md`, '## Source files\n| Path | Role | In scope |\n|---|---|---|\n| src/billing/My Project/AssemblyInfo.vb | info | full |\n| src/billing/invoice.php (main) | x | full |\n| **src/billing/print.php** | x | partial |\n| src/billing/tax.php | x | No (belongs to billing/tax) |\n');
  assert.deepEqual(problems(dir), []);
});

test('an amendment\'s source map needs the trace of one of its requirements', () => {
  const dir = project();
  const A = 'openspec/changes/amend-billing-invoice';
  write(dir, 'openspec/specs/billing/invoice/spec.md', SPEC);
  write(dir, `${A}/.openspec.yaml`, 'schema: spec-relay-amend\n');
  write(dir, `${A}/reason.md`, '# Reason\n\nRefunds were left out (src/billing/refund.php:2).\n');
  write(dir, `${A}/specs/billing/invoice/spec.md`, '## ADDED Requirements\n\n### Requirement: Refund\nThe system SHALL refund.\n\n#### Scenario: r\n- **WHEN** x\n- **THEN** y\n');
  write(dir, `${A}/crosscheck.md`, '| Item | Verdict | Evidence |\n|---|---|---|\n| R1 Refund | confirmed | x |\n');
  write(dir, `${A}/review.md`, 'Reviewer: Uma\n- [x] R1 Refund\n');
  write(dir, 'src/billing/refund.php', PHP);
  write(dir, `${A}/source-map.md`, '## Source files\n| Path | Role | In scope |\n|---|---|---|\n| src/billing/refund.php | refunds | full |\n');
  write(dir, `${A}/trace.md`, '| Requirement | Source | Existing tests |\n|---|---|---|\n| Refund | src/billing/invoice.php:2 | none |\n');
  assert.deepEqual(checkReview(dir, 'amend-billing-invoice').problems, ['source-map.md lists src/billing/refund.php, but no requirement of this amendment traces to it; specify what it does, or leave it out']);
  write(dir, `${A}/trace.md`, '| Requirement | Source | Existing tests |\n|---|---|---|\n| Refund | src/billing/refund.php:refund:2 | none |\n');
  assert.deepEqual(checkReview(dir, 'amend-billing-invoice').problems, []);
});

test('trace rows: a symbol or lines, in a kept source file, several rows per requirement', () => {
  const dir = project();
  write(dir, 'ts/invoice.ts', 'x');
  const trace = (rows) => write(dir, `${CHANGE}/trace.md`, `| Requirement | Source | Existing tests |\n|---|---|---|\n${rows}`);
  trace('| Total | src/billing/invoice.php | none |\n');
  assert.deepEqual(problems(dir), ['the trace of "Total" names only the file src/billing/invoice.php; add the symbol or the lines (path:symbol:lines)']);
  for (const bad of ['ts/invoice.ts:3', 'openspec/config.yaml:1', 'src/vendor/lib.php:1']) {
    trace(`| Total | ${bad} | none |\n`);
    assert.match(problems(dir).join(), /is not a kept source file/, bad);
  }
  trace('| Total | src/billing/invoice.php:3 | none |\n| R1 Total | src/billing/nope.php:9 | none |\n');
  assert.deepEqual(problems(dir), ['the trace of "Total" points to src/billing/nope.php, which does not exist']);
});

test('a capability that owns no file fails the extract gate', () => {
  const dir = project({ capabilities: '### billing\n1. `billing/invoice` 請求書\n2. `billing/tax`\n   - `src/billing/`\n   - `src/common/`\n' });
  assert.deepEqual(problems(dir), ['openspec/spec-relay/plan.md assigns no source file to billing/invoice; list its folders or files in indented items under it']);
  // A plan copied without paths takes each capability's paths from the survey.
  write(dir, 'openspec/spec-relay/plan.md', '# Plan\n\n## Capabilities\n\n1. `billing/invoice`\n2. `billing/tax`\n');
  assert.match(problems(dir).join(), /assigns no source file to billing\/invoice/);
  // Once the plan lists a path, only the plan's paths count: billing/tax has none there.
  write(dir, 'openspec/spec-relay/plan.md', '# Plan\n\n## Capabilities\n\n1. `billing/invoice`\n   - `src/billing/invoice.php`\n   - `src/billing/print.php`\n2. `billing/tax`\n');
  assert.deepEqual(problems(dir), []);
  assert.match(checkCoverage(dir).problems.join('\n'), /capability billing\/tax owns no source file/);
  // The plan's capabilities win: a capability the plan renamed is not looked for.
  write(dir, 'openspec/spec-relay/plan.md', '# Plan\n\n## Capabilities\n\n1. `billing/invoice`\n   - `src/`\n');
  const renamed = checkCoverage(dir);
  assert.deepEqual(renamed.capabilities, { analyzed: 1, pending: [] });
  assert.deepEqual(renamed.problems.map((p) => p.split(': ').pop()), ['src/billing/tax.php', 'src/common/db.php']);
});

test('gate.mjs and render.mjs run as programs despite the import cycle', () => {
  const dir = project();
  for (const [script, args] of [['gate.mjs', ['coverage']], ['gate.mjs', ['review', '--change', 'extract-billing-invoice']], ['render.mjs', ['--change', 'extract-billing-invoice', '--out', path.join(dir, 'page.html')]], ['coverage.mjs', []]]) {
    const run = spawnSync(process.execPath, [path.join(KIT, 'scripts', script), ...args, ...(script === 'coverage.mjs' ? [] : ['--root', dir])], { encoding: 'utf8' });
    assert.equal(run.status, 0, `${script} ${args.join(' ')}: ${run.stderr}`);
  }
});

// A source file with no site and enough lines for the fixtures' trace ranges.
const PHP = `<?php\n${'//\n'.repeat(40)}`;

test('gate.mjs coverage checks the whole plan and lists the capabilities not analyzed yet', () => {
  const dir = project();
  assert.deepEqual(checkCoverage(dir), { ok: true, problems: [], files: 4, capabilities: { analyzed: 1, pending: ['platform/db', 'billing/tax'] } });

  write(dir, 'src/billing/refund.php', PHP);
  write(dir, 'src/report/monthly.php', PHP);
  write(dir, 'openspec/spec-relay/plan.md', `# Plan\n\n## Capabilities\n\n${CAPABILITIES.replace('# Capabilities\n\n', '').replace('`src/common/`', '`src/commons/`')}`);
  const result = checkCoverage(dir);
  assert.equal(result.ok, false);
  assert.deepEqual(result.problems, [
    'source file is in no capability of openspec/spec-relay/plan.md: src/common/db.php (list it under its capability, or have the person exclude it)',
    'source file is in no capability of openspec/spec-relay/plan.md: src/report/monthly.php (list it under its capability, or have the person exclude it)',
    'source file is not in the archived inventory (added after the survey?): src/report/monthly.php',
    'openspec/spec-relay/plan.md lists src/commons/ under platform/db, but no source file is there',
    'capability platform/db owns no source file; list its folders or files under it in openspec/spec-relay/plan.md',
    'source file assigned to billing/invoice is not in the source map of extract-billing-invoice or of an amendment: src/billing/refund.php',
  ]);

  // An archived extract counts as analyzed, and the newest active rerun wins over it.
  const archived = project();
  fs.renameSync(path.join(archived, CHANGE), path.join(archived, 'openspec/changes/archive/2026-11-05-extract-billing-invoice'));
  assert.equal(checkCoverage(archived).capabilities.analyzed, 1);
  write(archived, 'openspec/changes/extract-billing-invoice-v2/source-map.md', '| Path | Role | In scope |\n|---|---|---|\n| src/billing/invoice.php | x | full |\n');
  assert.match(checkCoverage(archived).problems.join(), /not in the source map of extract-billing-invoice-v2 or of an amendment: src\/billing\/print.php/);

  // A file moved to a capability whose extract is archived: the amendment that specifies it carries a source map.
  write(archived, 'openspec/spec-relay/plan.md', `# Plan\n\n## Capabilities\n\n${CAPABILITIES.replace('# Capabilities\n\n', '')}`);
  fs.rmSync(path.join(archived, 'openspec/changes/extract-billing-invoice-v2'), { recursive: true });
  write(archived, 'src/billing/refund.php', PHP);
  assert.match(checkCoverage(archived).problems.join(), /src\/billing\/refund.php/);
  write(archived, 'openspec/changes/archive/2026-11-09-amend-billing-invoice/source-map.md', '## Source files\n| Path | Role | In scope |\n|---|---|---|\n| src/billing/refund.php | refunds | full |\n');
  assert.deepEqual(checkCoverage(archived).problems, []);

  // A plan saved as UTF-16 is reported, not read as empty.
  write(archived, 'openspec/spec-relay/plan.md', '');
  fs.writeFileSync(path.join(archived, 'openspec/spec-relay/plan.md'), Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('## Capabilities\n', 'utf16le')]));
  assert.match(checkCoverage(archived).problems.join(), /plan.md is not UTF-8/);

  const none = tempDir();
  write(none, 'openspec/config.yaml', 'context: |\n  Source root: .\n');
  assert.match(checkCoverage(none).problems.join(), /no archived survey/);
  assert.equal(quiet(() => main(['coverage', '--root', none])), 1);
  assert.equal(quiet(() => main(['coverage', '--root', project()])), 0);
});

test('database definitions: assigned to a capability, held by its source map, and not listed file by file after a drift', async () => {
  const { databaseHash } = await import('../scripts/gate.mjs');
  const DB = 'openspec/spec-relay/db/sales/dbo';
  const withDb = CAPABILITIES.replace('   - `src/billing/`\n', '   - `src/billing/`\n   - `openspec/spec-relay/db/sales/`\n');
  const dir = project({ capabilities: withDb });
  write(dir, `${SURVEY}/inventory.md`, '| Path | Context | Notes |\n|---|---|---|\n| src/billing/ | billing | |\n| src/common/ | platform | |\n| src/vendor/ | excluded | library |\n| openspec/spec-relay/db/ | billing | |\n');
  write(dir, `${DB}/Tables/Invoices.sql`, 'CREATE TABLE dbo.Invoices (Id int);\n');
  const snapshot = () => write(dir, `${SURVEY}/database.md`, `## Databases\n| Database | Product | Connection | Definitions |\n|---|---|---|---|\n| sales | SQL Server 2016 | connectionStrings/Sales | \`openspec/spec-relay/db/sales/\` |\n\n## Snapshot\nsha256: ${databaseHash(dir)}\n`);
  snapshot();

  // The assigned definition file must be in the Source files table of the source map.
  assert.match(problems(dir).join('\n'), /assigned to billing\/invoice in capabilities\.md of the archived survey is not in source-map\.md: openspec\/spec-relay\/db\/sales\/dbo\/Tables\/Invoices\.sql/);
  assert.match(checkCoverage(dir).problems.join('\n'), /billing\/invoice is not in the source map of extract-billing-invoice or of an amendment: openspec\/spec-relay\/db\/sales\/dbo\/Tables\/Invoices\.sql/);
  write(dir, `${CHANGE}/source-map.md`, '# Source map\n\n## Source files\n| Path | Role | In scope |\n|---|---|---|\n| `src/billing/` | x | full |\n| `openspec/spec-relay/db/sales/` | tables | full |\n\n## Database\n| Table or object | Kind | Use | Definition |\n|---|---|---|---|\n| dbo.Invoices | table | write | `openspec/spec-relay/db/sales/dbo/Tables/Invoices.sql` |\n');
  // The definitions are sites of the omission check too.
  write(dir, `${CHANGE}/coverage.md`, '| Site | Verdict | Evidence |\n|---|---|---|\n| `openspec/spec-relay/db/sales/dbo/Tables/Invoices.sql:(file)` | no behavior | the table only |\n');
  assert.deepEqual(problems(dir), []);
  assert.deepEqual(checkCoverage(dir).problems, []);

  // A source map without the Source files heading: the Database table names objects, not files.
  write(dir, `${CHANGE}/source-map.md`, '| Path | Role | In scope |\n|---|---|---|\n| src/billing/ | x | full |\n| openspec/spec-relay/db/sales/ | tables | full |\n\n## Database\n| Table or object | Kind | Use | Definition |\n|---|---|---|---|\n| dbo.Invoices | table | write | db |\n');
  assert.deepEqual(problems(dir), []);

  // A definition in no capability is reported like any source file.
  write(dir, 'openspec/spec-relay/plan.md', `# Plan\n\n## Capabilities\n\n${CAPABILITIES.replace('# Capabilities\n\n', '')}`);
  assert.match(checkCoverage(dir).problems.join('\n'), /in no capability of openspec\/spec-relay\/plan\.md: openspec\/spec-relay\/db\/sales\/dbo\/Tables\/Invoices\.sql/);
  write(dir, 'openspec/spec-relay/plan.md', `# Plan\n\n## Capabilities\n\n${withDb.replace('# Capabilities\n\n', '')}`);
  assert.deepEqual(checkCoverage(dir).problems, []);

  // A definition added after the survey: the drift is reported once, not each file under it.
  write(dir, `${DB}/Triggers/trg_Invoices.sql`, 'CREATE TRIGGER trg_Invoices ON dbo.Invoices AFTER INSERT AS SELECT 1;\n');
  write(dir, `${CHANGE}/source-map.md`, '## Source files\n| Path | Role | In scope |\n|---|---|---|\n| `src/billing/` | x | full |\n| `openspec/spec-relay/db/sales/dbo/Tables/Invoices.sql` | table | full |\n');
  const coverage = checkCoverage(dir);
  assert.equal(coverage.problems.length, 1, coverage.problems.join('\n'));
  assert.match(coverage.problems[0], /^database definitions changed after the survey/);
  const review = problems(dir);
  assert.ok(review.some((p) => p.startsWith('database definitions changed after the survey')), review.join('\n'));
  assert.ok(!review.some((p) => p.includes('trg_Invoices')), review.join('\n'));
  snapshot();
  assert.match(checkCoverage(dir).problems.join('\n'), /not in the source map of extract-billing-invoice or of an amendment: openspec\/spec-relay\/db\/sales\/dbo\/Triggers\/trg_Invoices\.sql/);
});

test('trace lines must exist in the file', () => {
  const dir = tempDir();
  const C = 'openspec/changes/extract-billing-invoice';
  write(dir, 'openspec/config.yaml', 'context: |\n  Source root (read-only): src\n');
  write(dir, 'src/a.php', '<?php\r\n// 2\r\n// 3\r\n');
  const trace = (source) => { write(dir, `${C}/trace.md`, `| Requirement | Source | Existing tests |\n|---|---|---|\n| Total | ${source} | none |\n`); const problems = []; checkTrace(dir, path.join(dir, C), ['Total'], problems); return problems; };
  assert.deepEqual(trace('src/a.php:2-3'), []);
  assert.deepEqual(trace('src/a.php:total:3'), []);
  assert.deepEqual(trace('src/a.php:total:3-40'), ['the trace of "Total" gives src/a.php the lines 3-40, but the file has 3 lines']);
  assert.deepEqual(trace('src/a.php:9-2'), ['the trace of "Total" gives src/a.php the lines 9-2, which is not a range']);
  assert.deepEqual(trace('src/a.php:0-2'), ['the trace of "Total" gives src/a.php the lines 0-2, which is not a range']);
});
