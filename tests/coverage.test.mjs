import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { capabilitySources, ownersOf, checkCoverage, contextOf, inventoryRows } from '../scripts/coverage.mjs';
import { checkReview, main } from '../scripts/gate.mjs';
import { tempDir, write, quiet, crlf } from './helpers.mjs';

const SURVEY = 'openspec/changes/archive/2026-11-01-survey';
const SPEC = '## Purpose\n\nInvoices for customers.\n\n## ADDED Requirements\n\n### Requirement: Total\nThe system SHALL add.\n\n#### Scenario: s\n- **WHEN** x\n- **THEN** y\n';
const CHANGE = 'openspec/changes/extract-billing-invoice';
const CAPABILITIES = '# Capabilities\n\n### platform\n1. `platform/db` DB\n   - `src/common/`\n\n### billing\n1. `billing/invoice` 請求書\n   - `src/billing/`\n2. `billing/tax` 税\n   - `src/billing/tax.php`\n';

// An archived survey over src/ and an extract change of billing/invoice that is
// ready for the gate except where a test changes it.
function project({ capabilities = CAPABILITIES, sourceMap = ['src/billing/invoice.php', 'src/billing/print.php'] } = {}) {
  const dir = tempDir();
  write(dir, 'openspec/config.yaml', 'context: |\n  Source root (read-only): src\n  Target root (new implementation): ts\n');
  for (const f of ['src/billing/invoice.php', 'src/billing/print.php', 'src/billing/tax.php', 'src/common/db.php', 'src/vendor/lib.php']) write(dir, f, '<?php\n');
  write(dir, `${SURVEY}/inventory.md`, '| Path | Context | Notes |\n|---|---|---|\n| src/billing/ | billing | |\n| src/common/ | platform | |\n| src/vendor/ | excluded | library |\n');
  write(dir, `${SURVEY}/capabilities.md`, capabilities);
  write(dir, `${CHANGE}/.openspec.yaml`, 'schema: spec-relay-extract\n');
  write(dir, `${CHANGE}/specs/billing/invoice/spec.md`, SPEC);
  write(dir, `${CHANGE}/screens.md`, 'None\n');
  write(dir, `${CHANGE}/questions.md`, 'None\n');
  write(dir, `${CHANGE}/crosscheck.md`, '| Item | Verdict | Evidence |\n|---|---|---|\n| R1 Total | confirmed | src/billing/invoice.php:3 |\n');
  write(dir, `${CHANGE}/trace.md`, '| Requirement | Source | Existing tests |\n|---|---|---|\n| R1 Total | src/billing/invoice.php:Invoice.total:3-9 | none |\n');
  write(dir, `${CHANGE}/source-map.md`, `# Source map\n\n## Source files\n| Path | Role | In scope |\n|---|---|---|\n${sourceMap.map((p) => `| \`${p}\` | x | full |`).join('\n')}\n\n## Dependencies\n| Dependency | Use |\n|---|---|\n| MySQL invoices table | reads |\n`);
  write(dir, `${CHANGE}/review.md`, 'Reviewer: Uma\n- [x] R1 Total\n');
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
  for (const f of ['src/billing/invoice.php', 'src/common/db.php', 'src/vendor/lib.php']) write(dir, f, '<?php\n');
  write(dir, `${S}/.openspec.yaml`, 'schema: spec-relay-survey\n');
  write(dir, `${S}/context-map.md`, '### Context: platform\n\n### Context: billing\n');
  write(dir, `${S}/inventory.md`, '| Path | Context | Notes |\n|---|---|---|\n| src/billing/ | billing | |\n| src/common/ | platform | |\n| src/vendor/ | excluded | |\n');
  write(dir, `${S}/review.md`, 'Reviewer: Uma\n- [x] K1 platform\n- [x] K2 billing\n');
  write(dir, `${S}/capabilities.md`, '### platform\n1. `platform/db`\n\n### billing\n1. `billing/invoice`\n   - `src/billing`\n');
  const found = checkReview(dir, 'survey').problems;
  assert.ok(found.includes('source file is in no capability of capabilities.md: src/common/db.php (list it, or its folder, under a capability, or mark it excluded in inventory.md)'), found.join('\n'));
  assert.ok(found.some((p) => p.startsWith('source file is in no capability of capabilities.md: src/billing/invoice.php')));
  assert.ok(found.some((p) => p.includes('capabilities.md lists src/billing under billing/invoice, but no source file is there')));
  assert.ok(!found.some((p) => p.includes('vendor')), 'excluded files need no capability');
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

test('gate.mjs coverage checks the whole plan and lists the capabilities not analyzed yet', () => {
  const dir = project();
  assert.deepEqual(checkCoverage(dir), { ok: true, problems: [], files: 4, capabilities: { analyzed: 1, pending: ['platform/db', 'billing/tax'] } });

  write(dir, 'src/billing/refund.php', '<?php\n');
  write(dir, 'src/report/monthly.php', '<?php\n');
  write(dir, 'openspec/spec-relay/plan.md', `# Plan\n\n## Capabilities\n\n${CAPABILITIES.replace('# Capabilities\n\n', '').replace('`src/common/`', '`src/commons/`')}`);
  const result = checkCoverage(dir);
  assert.equal(result.ok, false);
  assert.deepEqual(result.problems, [
    'source file is in no capability of openspec/spec-relay/plan.md: src/common/db.php (list it under its capability, or have the person exclude it)',
    'source file is in no capability of openspec/spec-relay/plan.md: src/report/monthly.php (list it under its capability, or have the person exclude it)',
    'source file is not in the archived inventory (added after the survey?): src/report/monthly.php',
    'openspec/spec-relay/plan.md lists src/commons/ under platform/db, but no source file is there (a typo, or a folder without its trailing "/")',
    'source file assigned to billing/invoice is not in the source map of extract-billing-invoice: src/billing/refund.php',
  ]);

  // An archived extract counts as analyzed, and the newest active rerun wins over it.
  const archived = project();
  fs.renameSync(path.join(archived, CHANGE), path.join(archived, 'openspec/changes/archive/2026-11-05-extract-billing-invoice'));
  assert.equal(checkCoverage(archived).capabilities.analyzed, 1);
  write(archived, 'openspec/changes/extract-billing-invoice-v2/source-map.md', '| Path | Role | In scope |\n|---|---|---|\n| src/billing/invoice.php | x | full |\n');
  assert.match(checkCoverage(archived).problems.join(), /not in the source map of extract-billing-invoice-v2: src\/billing\/print.php/);

  const none = tempDir();
  write(none, 'openspec/config.yaml', 'context: |\n  Source root: .\n');
  assert.match(checkCoverage(none).problems.join(), /no archived survey/);
  assert.equal(quiet(() => main(['coverage', '--root', none])), 1);
  assert.equal(quiet(() => main(['coverage', '--root', project()])), 0);
});
