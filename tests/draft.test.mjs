import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { review, items, portDesign, readReview, main } from '../scripts/draft.mjs';
import { runChecks, targetHash, draft as finishDraft } from '../scripts/finish.mjs';
import { checkReview, baselineHash, designScenarioChecks } from '../scripts/gate.mjs';
import { tempDir, write, quiet } from './helpers.mjs';

const read = (dir, rel) => fs.readFileSync(path.join(dir, rel), 'utf8');
// What the person does in the review: tick every box and sign.
const tickAll = (text, name = 'Uma') => text.replace(/^- \[ \]/gm, '- [x]').replace('Reviewer: <!-- name -->', `Reviewer: ${name}`);

const PHP = `<?php\n${'//\n'.repeat(40)}`;
const X = 'openspec/changes/extract-calc';
const SPEC = '## Purpose\n\nAdds numbers.\n\n## ADDED Requirements\n\n### Requirement: Add two numbers\nThe system SHALL add.\n\n#### Scenario: s\n- **WHEN** x\n- **THEN** y\n\n### Requirement: Reject `text`\nThe system SHALL reject text.\n\n#### Scenario: t\n- **WHEN** x\n- **THEN** y\n';

function extract() {
  const dir = tempDir();
  write(dir, 'openspec/changes/archive/2026-11-01-survey/capabilities.md', '# Capabilities\n\n1. `calc`\n   - `src/`\n');
  write(dir, 'src/calc.php', PHP);
  write(dir, `${X}/specs/calc/spec.md`, SPEC);
  write(dir, `${X}/source-map.md`, '# Source map\n\n## Source files\n| Path | Role | In scope |\n|---|---|---|\n| `src/calc.php` | calculator | full |\n');
  write(dir, `${X}/trace.md`, '| Requirement | Source | Existing tests |\n|---|---|---|\n| Add two numbers | src/calc.php:add:3-5 | none |\n| Reject `text` | src/calc.php:add:9 | none |\n');
  write(dir, `${X}/coverage.md`, '| Site | Verdict | Evidence |\n|---|---|---|\n');
  write(dir, `${X}/questions.md`, '# Questions\n\n## Suspected bugs\n- Q1. Overflow wraps around at 2^31 - src/calc.php:4 - keep or fix?\n\n## Ambiguities\n- **Q2** Rounding of halves\n');
  write(dir, `${X}/screens.md`, '# Screens\n\n### Screen: Calculator\n- labels\n');
  write(dir, `${X}/crosscheck.md`, '| Item | Verdict | Evidence |\n|---|---|---|\n| R1 Add two numbers | confirmed | x |\n| R2 Reject text | confirmed | x |\n| S1 Calculator | confirmed | x |\n');
  return dir;
}

test('review writes an extract checklist the gate accepts once the person ticks it', () => {
  const dir = extract();
  const result = review(dir, 'extract-calc');
  assert.equal(result.ok, true, result.problems.join('\n'));
  const text = read(dir, `${X}/review.md`);
  assert.equal(text, '# Review\n\nReviewer: <!-- name -->\n\n## 1. Requirements\n- [ ] R1 Add two numbers\n- [ ] R2 Reject `text`\n\n## 2. Screens\n- [ ] S1 Calculator\n\n## 3. Questions\n- [ ] Q1 Overflow wraps around at 2^31: decision:\n- [ ] Q2 Rounding of halves: decision:\n');
  // It never ticks, so the gate stops until the person has decided.
  assert.ok(checkReview(dir, 'extract-calc').problems.some((p) => p.startsWith('not ticked: R1')));
  write(dir, `${X}/review.md`, tickAll(text).replace(/decision:$/gm, 'decision: keep'));
  assert.deepEqual(checkReview(dir, 'extract-calc'), { ok: true, problems: [] });
  // Without --update it never touches the person's file.
  const again = review(dir, 'extract-calc');
  assert.equal(again.ok, false);
  assert.match(again.problems.join(), /exists; run with --update/);
});

test('--update keeps the person\'s ticks, decisions and notes, and unticks what changed', () => {
  const dir = extract();
  review(dir, 'extract-calc');
  write(dir, `${X}/review.md`, tickAll(read(dir, `${X}/review.md`))
    .replace('- [x] R2 Reject `text`', '- [ ] R2 Reject `text`\n  - fix: say what the error says\n  - fixed: added the message')
    .replace(/Q1 (.*)decision:$/m, 'Q1 $1decision: keep, the old system did the same')
    .replace('- [x] S1 Calculator', '- [x] S1 Calculator\n  - hold: ask the accounting team'));
  // The analyst renamed R1 and added a requirement at the end; the screen is gone.
  write(dir, `${X}/specs/calc/spec.md`, `${SPEC.replace('Add two numbers', 'Add two integers')}\n### Requirement: Clear\nThe system SHALL clear.\n\n#### Scenario: c\n- **WHEN** x\n- **THEN** y\n`);
  write(dir, `${X}/screens.md`, 'None\n');
  const result = review(dir, 'extract-calc', { update: true });
  assert.equal(result.written, true);
  assert.deepEqual(result.added, ['R1 Add two integers', 'R3 Clear']);
  assert.deepEqual(result.removed.map((r) => [r.item, r.ticked, r.why]), [['R1 Add two numbers', true, 'its subject is gone'], ['S1 Calculator', true, 'its subject is gone']]);
  const text = read(dir, `${X}/review.md`);
  assert.equal(text, '# Review\n\nReviewer: Uma\n\n## 1. Requirements\n- [ ] R1 Add two integers\n- [ ] R2 Reject `text`\n  - fix: say what the error says\n  - fixed: added the message\n- [ ] R3 Clear\n\n## 2. Screens\n\n## 3. Questions\n- [x] Q1 Overflow wraps around at 2^31: decision: keep, the old system did the same\n- [x] Q2 Rounding of halves: decision:\n');
  // Nothing changed: nothing is written.
  assert.equal(review(dir, 'extract-calc', { update: true }).written, false);
});

test('--update unticks an item whose wording changed but keeps its notes, and keeps CRLF', () => {
  const dir = extract();
  write(dir, `${X}/review.md`, 'Reviewer: Uma\r\n\r\n- [x] R1 Add two numbers\r\n  - fix: x\r\n  - fixed: y\r\n- [x] R2 Reject text\r\n- [x] S1 Calculator\r\n- [x] Q1 Overflow: decision: keep\r\n- [x] Q2 Halves: decision: up\r\nA note the person wrote.\r\n');
  const result = review(dir, 'extract-calc', { update: true });
  // "Reject text" and "Reject `text`" are the same subject; the line is rewritten with the spec's name.
  assert.deepEqual(result.changed, []);
  const text = read(dir, `${X}/review.md`);
  assert.match(text, /\r\n/);
  assert.match(text, /- \[x\] R1 Add two numbers\r\n {2}- fix: x\r\n {2}- fixed: y\r\n/);
  assert.match(text, /- \[x\] Q1 Overflow: decision: keep\r\n/);
  assert.match(text, /A note the person wrote\.\r\n$/);
});

test('review writes the survey checklist from the context map and database.md', () => {
  const dir = tempDir();
  write(dir, 'openspec/changes/survey/.openspec.yaml', 'schema: spec-relay-survey\n');
  write(dir, 'openspec/changes/survey/context-map.md', '## Contexts\n\n### Context: platform\n- **Name**: 共通基盤\n\n### Context: billing\n- **Name**: 請求\n<!-- ### Context: shipping -->\n');
  write(dir, 'openspec/changes/survey/database.md', '## Databases\n| Database | Product | Connection | Definitions |\n|---|---|---|---|\n| sales | SQL Server | x | none |\n| <!-- legacy --> | | | |\n');
  assert.equal(review(dir, 'survey').ok, true);
  assert.equal(read(dir, 'openspec/changes/survey/review.md'), '# Review\n\nReviewer: <!-- name -->\n\n## 1. Contexts\n- [ ] K1 platform: 共通基盤\n- [ ] K2 billing: 請求\n\n## 2. Map\n- [ ] M1 The relationships between contexts are right\n- [ ] M2 Every piece of shared data has the right owner\n- [ ] M3 The glossary conflicts are understood\n- [ ] M4 The capability list and its order are right\n- [ ] M5 The files marked carry may go to the new system unchanged\n\n## 3. Coverage\n- [ ] C1 Every file marked excluded may be left out of the migration\n\n## 4. Databases\n- [ ] D1 sales: definitions and the logic in it\n- [ ] D90 The missing definitions are understood\n');
  // A context renamed in the map keeps its tick only while its id stays.
  write(dir, 'openspec/changes/survey/review.md', tickAll(read(dir, 'openspec/changes/survey/review.md')));
  write(dir, 'openspec/changes/survey/context-map.md', '### Context: platform\n- **Name**: 基盤\n\n### Context: billing\n- **Name**: 請求\n');
  const result = review(dir, 'survey', { update: true });
  assert.deepEqual(result.changed.map((c) => [c.was, c.now]), [['K1 platform: 共通基盤', 'K1 platform: 基盤']]);
  assert.match(read(dir, 'openspec/changes/survey/review.md'), /- \[ \] K1 platform: 基盤\n- \[x\] K2 billing: 請求\n/);
});

test('review writes the target-design checklist the gate asks for', () => {
  const dir = tempDir();
  const S = 'openspec/changes/archive/2026-11-01-survey';
  write(dir, 'openspec/config.yaml', 'context: |\n  Source root: src\n  Target root: ts\n');
  write(dir, `${S}/context-map.md`, '### Context: platform\n\n### Context: billing\n');
  write(dir, `${S}/inventory.md`, '| Path | Context | Handling | Notes |\n|---|---|---|---|\n| src/ | billing | port | |\n');
  write(dir, `${S}/database.md`, '## Databases\n| Database | Product |\n|---|---|\n| sales | SQL Server |\n\n## Logic in the database\n| Kind | Count |\n|---|---|\n| procedure | 3 |\n| trigger | 1 |\n');
  const T = 'openspec/changes/target-design';
  write(dir, `${T}/.openspec.yaml`, 'schema: spec-relay-target\n');
  write(dir, `${T}/architecture.md`, '## Modules\n| Context | Module path | Public API |\n|---|---|---|\n| platform | ts/platform | |\n| billing | ts/billing | |\n');
  write(dir, `${T}/conventions.md`, '## Commands\n| Purpose | Command |\n|---|---|\n| Test | `npm test` |\n| Boundary check | `npm run boundary` |\n');
  write(dir, `${T}/verification.md`, '| Context | A | B1 | B2 | C |\n|---|---|---|---|---|\n| platform | yes | no | no | no |\n| billing | yes | no | no | no |\n');
  write(dir, `${T}/ui.md`, '## Screens\n| Context | Screens | Policy |\n|---|---|---|\n| platform | all | same |\n| billing | all | layout |\n\n## Carried files\nNone\n');
  write(dir, `${T}/data.md`, '## Schema policy\nkeep\n\n## Database logic\n| Kind | Handling |\n|---|---|\n| procedure | keep |\n\n## Exceptions\nNone\n\n## Data access mapping\nNone\n\n## Schema changes\nnone\n\n## Test database\nLocalDB\n');
  const result = review(dir, 'target-design');
  assert.match(result.problems.join(), /gives the trigger objects no handling/);
  const text = read(dir, `${T}/review.md`);
  assert.match(text, /- \[ \] A1 platform: ts\/platform\n- \[ \] A2 billing: ts\/billing\n/);
  assert.match(text, /- \[ \] D1 procedure: keep\n- \[ \] D2 trigger: keep or move\n/);
  write(dir, `${T}/data.md`, read(dir, `${T}/data.md`).replace('| procedure | keep |', '| procedure | keep |\n| trigger | move |'));
  assert.equal(review(dir, 'target-design', { update: true }).ok, true);
  write(dir, `${T}/review.md`, tickAll(read(dir, `${T}/review.md`)));
  assert.deepEqual(checkReview(dir, 'target-design'), { ok: true, problems: [] });
});

test('review writes the amend and finish checklists', () => {
  const dir = tempDir();
  write(dir, 'openspec/changes/amend-calc/.openspec.yaml', 'schema: spec-relay-amend\n');
  write(dir, 'openspec/changes/amend-calc/specs/calc/spec.md', '## MODIFIED Requirements\n\n### Requirement: Add two numbers\nx\n\n## ADDED Requirements\n\n### Requirement: Clear\ny\n');
  review(dir, 'amend-calc');
  assert.equal(read(dir, 'openspec/changes/amend-calc/review.md'), '# Review\n\nReviewer: <!-- name -->\n\n## 1. Requirements\n- [ ] R1 Add two numbers\n- [ ] R2 Clear\n\n## 2. Impact\n- [ ] I1 The port updates in impact.md are right\n');
  write(dir, 'openspec/changes/finish/.openspec.yaml', 'schema: spec-relay-finish\n');
  write(dir, 'openspec/changes/finish/leftovers.md', '| ID | Kind | Where | What | Class | Reason |\n|---|---|---|---|---|---|\n| L1 | todo | `ts/a.ts:2` | TODO(port) rounding \\| negative | after-release | rare |\n| L2 | risk | billing | x | <!-- before-release / after-release / wont-fix --> | |\n');
  const result = review(dir, 'finish');
  assert.match(result.problems.join(), /L2 has no class yet/);
  assert.match(read(dir, 'openspec/changes/finish/review.md'), /- \[ \] L1 TODO\(port\) rounding \| negative - class: after-release\n- \[ \] L2 x - class: \?\n/);
});

test('items numbers the requirements and screens as the review and the crosscheck do', () => {
  const dir = extract();
  assert.deepEqual(items(dir, 'extract-calc'), { ok: true, change: 'extract-calc', requirements: ['R1 Add two numbers', 'R2 Reject `text`'], screens: ['S1 Calculator'], problems: [] });
  assert.equal(items(dir, 'nope').ok, false);
});

const P = 'openspec/changes/port-calc-add';
const BASE = '## Purpose\n\nAdds.\n\n## Requirements\n\n### Requirement: Add two numbers\nThe system SHALL add.\n\n#### Scenario: Positive numbers\n- x\n\n#### Scenario: Negative numbers\n- y\n\n### Requirement: Reject text\nThe system SHALL reject.\n\n#### Scenario: Text input\n- z\n';
function port(levels = 'no') {
  const dir = tempDir();
  write(dir, 'openspec/config.yaml', 'context: |\n  Source root: src\n  Target root: ts\n');
  write(dir, 'openspec/changes/archive/2026-11-02-target-design/verification.md', `## Levels\n| Context | A | B1 | B2 | C |\n|---|---|---|---|---|\n| calc | yes | ${levels} | no | no |\n`);
  write(dir, 'openspec/changes/archive/2026-11-02-target-design/ui.md', '## Screens\n| Context | Screens | Policy |\n|---|---|---|\n| calc | all | layout |\n');
  write(dir, 'openspec/changes/archive/2026-11-03-extract-calc-add/screens.md', '### Screen: Calculator\n');
  write(dir, 'openspec/changes/archive/2026-11-03-extract-calc-add/trace.md', '| Requirement | Source | Existing tests |\n|---|---|---|\n| Add two numbers | `src/calc.py:add:1-2` | none |\n| Reject text | src/calc.py:check:5 | none |\n');
  write(dir, 'openspec/changes/archive/2026-11-05-amend-calc-add/trace.md', '| Requirement | Source | Existing tests |\n|---|---|---|\n| Reject text | src/calc.py:check:5-9 | none |\n');
  write(dir, 'openspec/specs/calc/add/spec.md', BASE);
  write(dir, `${P}/.openspec.yaml`, 'schema: spec-relay-port\n');
  write(dir, `${P}/proposal.md`, `## Baseline\n- \`calc/add\` sha256:${baselineHash(dir, 'calc/add')}\n`);
  return dir;
}

test('port-design writes design.md from the template with the copied tables', () => {
  const dir = port();
  const result = portDesign(dir, 'port-calc-add');
  assert.equal(result.ok, true, result.problems.join('\n'));
  assert.equal(result.created, true);
  const text = read(dir, `${P}/design.md`);
  assert.match(text, /## Screens\n\| Screen \(screens.md\) \| Policy \(ui.md\) \| Target page or form \| How the design is kept \|\n\|---\|---\|---\|---\|\n\| Calculator \| layout \| <!-- --> \| <!-- --> \|\n\n## Carried files/);
  // Without B1 or B2, every scenario is a unit test.
  assert.deepEqual(designScenarioChecks(text).map((r) => [r.requirement, r.scenario, r.check]), [
    ['Add two numbers', 'Positive numbers', 'unit'], ['Add two numbers', 'Negative numbers', 'unit'], ['Reject text', 'Text input', 'unit'],
  ]);
  // The amendment's trace wins.
  assert.match(text, /\| Add two numbers \| `src\/calc.py:add:1-2` \|\n\| Reject text \| src\/calc.py:check:5-9 \|\n/);
  assert.match(text, /## Decisions\n/);
});

test('port-design fills only template sections, and --update adds missing rows', () => {
  const dir = port('yes');
  write(dir, `${P}/design.md`, '## Structure\nts/calc\n\n## Scenario checks\n| Requirement | Scenario | Check |\n|---|---|---|\n| Add two numbers | Positive numbers | compare |\n| Old | Gone | unit |\n\n## Source references\n| Requirement | Source (from trace.md) |\n|---|---|\n| <!-- requirement --> | <!-- src/...:Symbol:lines --> |\n\n## Risks\n- none\n');
  const first = portDesign(dir, 'port-calc-add');
  assert.deepEqual(first.filled, ['screens', 'sources']);
  assert.deepEqual(first.kept, ['scenarios']);
  const result = portDesign(dir, 'port-calc-add', { update: true });
  assert.deepEqual(result.added.map((a) => a.row), ['| Add two numbers | Negative numbers | <!-- e2e / compare / unit --> |', '| Reject text | Text input | <!-- e2e / compare / unit --> |']);
  assert.deepEqual(result.gone, [{ table: 'scenarios', row: 'Old | Gone' }]);
  const text = read(dir, `${P}/design.md`);
  assert.match(text, /\| Add two numbers \| Positive numbers \| compare \|\n\| Old \| Gone \| unit \|\n\| Add two numbers \| Negative numbers \|/);
  assert.match(text, /## Screens\n\| Screen[^\n]*\n\|---\|---\|---\|---\|\n\| Calculator \| layout \| <!-- --> \| <!-- --> \|\n\n## Scenario checks/);
  assert.match(text, /## Risks\n- none\n$/);
  // A source cell that differs from the trace is reported, not rewritten.
  write(dir, `${P}/design.md`, text.replace('src/calc.py:check:5-9', 'src/calc.py:check:5'));
  assert.deepEqual(portDesign(dir, 'port-calc-add', { update: true }).differs, [{ requirement: 'Reject text', now: 'src/calc.py:check:5', trace: 'src/calc.py:check:5-9', from: 'openspec/changes/archive/2026-11-05-amend-calc-add' }]);
  assert.deepEqual(items(dir, 'port-calc-add').requirements, ['R1 Add two numbers', 'R2 Reject text']);
  assert.deepEqual(items(dir, 'port-calc-add').screens, ['S1 Calculator']);
});

// ---------------------------------------------------------------- finish.mjs run

function finishRepo() {
  const dir = tempDir();
  write(dir, 'openspec/config.yaml', 'context: |\n  Source root: src\n  Target root: ts\n');
  write(dir, 'openspec/spec-relay/plan.md', '# Plan\n\n## Capabilities\n\n### billing\n1. `billing/invoice`\n1. `billing/payment`\n');
  write(dir, 'openspec/changes/archive/2026-11-01-survey/context-map.md', '### Context: platform\n\n### Context: billing\n');
  write(dir, 'openspec/changes/archive/2026-11-02-target-design/conventions.md', '## Commands\n| Purpose | Command |\n|---|---|\n| Build | `npm run build` |\n| Test | `npm test` |\n| Boundary check | `npm run boundary` |\n');
  write(dir, 'openspec/changes/archive/2026-11-02-target-design/verification.md', '## Levels\n| Context | A | B1 | B2 | C |\n|---|---|---|---|---|\n| platform | yes | no | no | no |\n| billing | yes | yes | no | no |\n');
  for (const cap of ['invoice', 'payment']) {
    write(dir, `openspec/specs/billing/${cap}/spec.md`, '### Requirement: a\nx\n');
    const D = `openspec/changes/archive/2026-11-04-port-billing-${cap}`;
    write(dir, `${D}/proposal.md`, `## Baseline\n- \`billing/${cap}\` sha256:${baselineHash(dir, `billing/${cap}`)}\n`);
    write(dir, `${D}/design.md`, `## Verification\n| Level | Covers | Command |\n|---|---|---|\n| A | all | |\n| B1 | cases | \`node b1-${cap}.js\` |\n`);
  }
  write(dir, 'ts/billing/invoice.ts', 'export const a = 1;\n');
  write(dir, 'openspec/changes/finish/.openspec.yaml', 'schema: spec-relay-finish\n');
  return dir;
}

test('finish.mjs run runs every check once and writes the results and the hash into checks.md', async () => {
  const dir = finishRepo();
  quiet(() => finishDraft(dir, 'finish'));
  const calls = [];
  const run = async (command, cwd, opts) => {
    calls.push([command, opts.capability ?? null]);
    return { exitCode: command === 'node b1-payment.js' ? 1 : 0, seconds: 1.5, timedOut: false, output: `ran ${command}` };
  };
  const result = await runChecks(dir, 'finish', { run, progress: () => {} });
  // npm test runs once: level A of both ports uses the conventions' Test command.
  assert.deepEqual(calls, [['npm run build', null], ['npm test', null], ['npm run boundary', null], ['node b1-invoice.js', 'billing/invoice'], ['node b1-payment.js', 'billing/payment']]);
  assert.equal(result.ok, false);
  assert.deepEqual(result.problems, ['level B1 of billing/payment failed: node b1-payment.js']);
  assert.equal(result.levels.find((l) => l.capability === 'billing/payment' && l.level === 'B1').tail, 'ran node b1-payment.js');
  const text = read(dir, 'openspec/changes/finish/checks.md');
  assert.match(text, new RegExp(`^Target: sha256:${targetHash(dir)}$`, 'm'));
  assert.match(text, /\| Build \| `npm run build` \| pass \| finish\.mjs run \d{4}-\d{2}-\d{2}, 1\.5 s \|/);
  assert.match(text, /\| billing \| pass \| fail \| - \| - \| finish\.mjs run \d{4}-\d{2}-\d{2}: B1 failed in billing\/payment \|/);
  // platform has no port: its row is left for the orchestrator.
  assert.match(text, /\| platform \| <!-- pass \/ fail \/ not-run: reason --> \| - \| - \| - \| \|/);
  // A second run replaces its own note and keeps the orchestrator's.
  write(dir, 'openspec/changes/finish/checks.md', text.replace(/(\| Build \| `npm run build` \| pass \| )([^|]*)\|/, '$1 12 targets; $2|'));
  const again = await runChecks(dir, 'finish', { run: async () => ({ exitCode: 0, seconds: 2, timedOut: false, output: '' }), progress: () => {} });
  assert.equal(again.ok, true, again.problems.join('\n'));
  const now = read(dir, 'openspec/changes/finish/checks.md');
  assert.match(now, /\| Build \| `npm run build` \| pass \| 12 targets; finish\.mjs run \d{4}-\d{2}-\d{2}, 2 s \|/);
  assert.match(now, /\| billing \| pass \| pass \| - \| - \| finish\.mjs run \d{4}-\d{2}-\d{2} \|/);
});

test('finish.mjs run refuses a chained command and a missing checks.md', async () => {
  const dir = finishRepo();
  assert.match((await runChecks(dir, 'finish', { progress: () => {} })).problems.join(), /checks.md is missing/);
  assert.match((await runChecks(dir, 'other', { progress: () => {} })).problems.join(), /named finish/);
  quiet(() => finishDraft(dir, 'finish'));
  write(dir, 'openspec/changes/finish/checks.md', read(dir, 'openspec/changes/finish/checks.md').replace('`npm run build`', '`npm run build; npm run x`'));
  const result = await runChecks(dir, 'finish', { run: async () => ({ exitCode: 0, seconds: 0, timedOut: false, output: '' }), progress: () => {} });
  assert.match(result.problems.join(), /checks.md Build: /);
  assert.ok(!result.commands.some((c) => c.purpose === 'Build'));
});

test('readReview keeps an item\'s notes with it and the rest apart', () => {
  const { items: found, reviewer, other } = readReview('# Review\n\nReviewer: Uma\n<!-- a\ncomment -->\n- [x] R1 a\n  - fix: b\n- [ ] R2 c\nfree text\n', (b) => b.slice(0, 2));
  assert.equal(reviewer, 'Reviewer: Uma');
  assert.deepEqual(found.map((i) => [i.key, i.done, i.block.length]), [['R1', true, 2], ['R2', false, 1]]);
  assert.deepEqual(other, ['free text']);
});

test('the CLI prints ASCII-only JSON and exits 0, 1 or 2', () => {
  const dir = extract();
  let out = '';
  const log = console.log;
  console.log = (s) => { out += s; };
  try {
    assert.equal(main(['items', '--change', 'extract-calc', '--root', dir]), 0);
    assert.equal(main(['review', '--change', 'nope', '--root', dir]), 1);
  } finally { console.log = log; }
  assert.doesNotMatch(out, /[^\x00-\x7f]/);
  assert.equal(quiet(() => main(['items', '--root', dir])), 2);
  assert.equal(quiet(() => main(['items', '--change', 'extract-calc', '--update', '--root', dir])), 2);
});
