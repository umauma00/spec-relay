import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { review, items, portDesign, readReview, main } from '../scripts/draft.mjs';
import { runChecks, targetHash, draft as finishDraft } from '../scripts/finish.mjs';
import { checkReview, baselineHash, designScenarioChecks } from '../scripts/gate.mjs';
import { tempDir, writeChecked as write, quiet } from './helpers.mjs';

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
  write(dir, `${X}/questions.md`, '# Questions\n\n## Suspected bugs\n- Q1. Overflow wraps around at 2^31 - src/calc.php:4 - keep or fix?\n  - Recommended: keep\n  - Why: the old system does it\n\n## Ambiguities\n- **Q2** Rounding of halves\n  - Recommended: keep\n  - Why: the old system does it\n');
  write(dir, `${X}/screens.md`, '# Screens\n\n### Screen: Calculator\n- labels\n');
  write(dir, `${X}/crosscheck.md`, '| Item | Verdict | Evidence |\n|---|---|---|\n| R1 Add two numbers | confirmed | x |\n| R2 Reject text | confirmed | x |\n| S1 Calculator | confirmed | x |\n');
  return dir;
}

test('review writes an extract checklist the gate accepts once the person ticks it', () => {
  const dir = extract();
  const result = review(dir, 'extract-calc');
  assert.equal(result.ok, true, result.problems.join('\n'));
  const text = read(dir, `${X}/review.md`);
  assert.equal(text, '# Review\n\nReviewer: <!-- name -->\n\n## 1. Requirements\n- [ ] R1 Add two numbers\n- [ ] R2 Reject `text`\n\n## 2. Screens\n- [ ] S1 Calculator\n\n## 3. Questions\n- [ ] Q1 Overflow wraps around at 2^31 - src/calc.php:4 - keep or fix?: decision:\n- [ ] Q2 Rounding of halves: decision:\n');
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
  // The screen is gone, so the person confirms that none is left (S0).
  assert.deepEqual(result.added, ['R3 Clear', 'S0 This capability has no screens']);
  // The renamed requirement keeps its place and notes, unticked.
  assert.deepEqual(result.changed, [{ was: 'R1 Add two numbers', now: 'R1 Add two integers', ticked: true }]);
  assert.deepEqual(result.removed, [{ item: 'S1 Calculator', ticked: true, lines: ['- [x] S1 Calculator', '  - hold: ask the accounting team'], why: 'its subject is gone' }]);
  const text = read(dir, `${X}/review.md`);
  assert.equal(text, '# Review\n\nReviewer: Uma\n\n## 1. Requirements\n- [ ] R1 Add two integers\n- [ ] R2 Reject `text`\n  - fix: say what the error says\n  - fixed: added the message\n- [ ] R3 Clear\n\n## 2. Screens\n- [ ] S0 This capability has no screens\n\n## 3. Questions\n- [x] Q1 Overflow wraps around at 2^31 - src/calc.php:4 - keep or fix?: decision: keep, the old system did the same\n- [x] Q2 Rounding of halves: decision:\n');
  // Nothing changed: nothing is written.
  assert.equal(review(dir, 'extract-calc', { update: true }).written, false);
});

test('--update reads hand-written ids as the gate does, keeps decisions and CRLF, and unticks a reworded question', () => {
  const dir = extract();
  write(dir, `${X}/review.md`, 'Reviewer: Uma\r\n\r\n- [x] R1: Add two numbers\r\n  - fix: x\r\n  - fixed: y\r\n- [x] **R2** Reject text\r\n- [x] S1. Calculator\r\n- [x] Q1 Overflow: decision: keep\r\n- [x] Q2 Rounding of halves: decision: up\r\n<!-- a comment\r\nof two lines -->\r\nA note the person wrote.\r\n');
  const result = review(dir, 'extract-calc', { update: true });
  // "Reject text" and "Reject `text`" are the same subject; Q1's title is not the one questions.md gives.
  // A reworded question starts without a decision; the report has the old one.
  assert.deepEqual(result.changed, [{ was: 'Q1 Overflow: decision: keep', now: 'Q1 Overflow wraps around at 2^31 - src/calc.php:4 - keep or fix?: decision:', ticked: true }]);
  // The comment and the note are already at the end of the file.
  assert.equal(result.moved, 0);
  const text = read(dir, `${X}/review.md`);
  assert.match(text, /\r\n/);
  assert.match(text, /- \[x\] R1 Add two numbers\r\n {2}- fix: x\r\n {2}- fixed: y\r\n- \[x\] R2 Reject `text`\r\n/);
  assert.match(text, /- \[x\] S1 Calculator\r\n/);
  assert.match(text, /- \[ \] Q1 Overflow wraps around at 2\^31 - src\/calc\.php:4 - keep or fix\?: decision:\r\n- \[x\] Q2 Rounding of halves: decision: up\r\n/);
  assert.match(text, /<!-- a comment\r\nof two lines -->\r\nA note the person wrote\.\r\n$/);
});

test('--update follows questions by their title and writes nothing while an artifact is unreadable', () => {
  const dir = extract();
  review(dir, 'extract-calc');
  write(dir, `${X}/review.md`, tickAll(read(dir, `${X}/review.md`)).replace(/Q1 (.*)decision:$/m, 'Q1 $1decision: keep').replace(/Q2 (.*)decision:$/m, 'Q2 $1decision: round up'));
  // Q1 is withdrawn and Q2 becomes Q1: its decision moves with it.
  write(dir, `${X}/questions.md`, '# Questions\n\n## Ambiguities\n- **Q1** Rounding of halves\n');
  const result = review(dir, 'extract-calc', { update: true });
  assert.match(read(dir, `${X}/review.md`), /## 3. Questions\n- \[x\] Q1 Rounding of halves: decision: round up\n$/);
  assert.deepEqual(result.removed.map((r) => r.item), ['Q1 Overflow wraps around at 2^31 - src/calc.php:4 - keep or fix?: decision: keep']);
  const before = read(dir, `${X}/review.md`);
  fs.writeFileSync(path.join(dir, `${X}/screens.md`), Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('### Screen: Calculator', 'utf16le')]));
  const refused = review(dir, 'extract-calc', { update: true });
  assert.equal(refused.ok, false);
  assert.equal(refused.written, false);
  assert.match(refused.problems.join(), /not UTF-8/);
  fs.rmSync(path.join(dir, `${X}/screens.md`));
  assert.match(review(dir, 'extract-calc', { update: true }).problems.join(), /screens.md is missing/);
  assert.equal(read(dir, `${X}/review.md`), before);
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
  assert.equal(result.ok, true);
  assert.match(result.warnings.join(), /gives the trigger objects no handling/);
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
  assert.match(result.warnings.join(), /L2 has no class yet/);
  assert.match(read(dir, 'openspec/changes/finish/review.md'), /- \[ \] L1 TODO\(port\) rounding \| negative \(ts\/a\.ts:2\) - class: after-release\n- \[ \] L2 x \(billing\) - class: \?\n/);
});

test('items numbers the requirements and screens as the review and the crosscheck do', () => {
  const dir = extract();
  const listed = items(dir, 'extract-calc');
  assert.deepEqual({ ...listed, entryPoints: undefined }, { ok: true, change: 'extract-calc', requirements: ['R1 Add two numbers', 'R2 Reject `text`'], screens: ['S1 Calculator'], entryPoints: undefined, problems: [] });
  // The walkthrough's checkers get the entry points of the source map.
  write(dir, 'openspec/changes/extract-calc/source-map.md', '# Source map\n\n## Entry points\n- `src/calc.py:add` - callers add\n- src/calc.py:check - validation\n- `src/calc.py:add` - again\n');
  assert.deepEqual(items(dir, 'extract-calc').entryPoints, ['src/calc.py:add', 'src/calc.py:check']);
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

test('port-design reads trace.md as the gate does and keeps a scenario with a pipe in its name', () => {
  const dir = port('no');
  write(dir, 'openspec/changes/archive/2026-11-02-target-design/verification.md', '## Levels\n| Context | A | B1 | B2 | C |\n|---|---|---|---|---|\n| calc | yes | no | no | yes |\n');
  write(dir, 'openspec/changes/archive/2026-11-05-amend-calc-add/trace.md', '| Requirement | Source | Existing tests |\n|---|---|---|\n| R2 Reject text | src/calc.py:check:5-9 | none |\n| Reject text | src/calc.py:msg:20 | none |\n');
  write(dir, 'openspec/specs/calc/add/spec.md', BASE.replace('#### Scenario: Text input', '#### Scenario: Text a | b'));
  write(dir, `${P}/proposal.md`, `## Baseline\n- \`calc/add\` sha256:${baselineHash(dir, 'calc/add')}\n`);
  write(dir, `${P}/design.md`, '## Structure\nx\n\n```\n## Scenario checks\n```\n\n## Source References (from trace) ##\n| Requirement | Source |\n|---|---|\n| <!-- r --> | <!-- s --> |\n');
  const result = portDesign(dir, 'port-calc-add');
  assert.equal(result.ok, true, result.problems.join('\n'));
  const text = read(dir, `${P}/design.md`);
  assert.match(text, /\| Reject text \| src\/calc.py:check:5-9; src\/calc.py:msg:20 \|/);
  assert.equal(text.match(/## Source References/g).length, 1);
  // C runs screen tests, so the check is the person's choice.
  assert.match(text, /\| Reject text \| Text a \\\| b \| <!-- e2e \/ compare \/ unit --> \|/);
  assert.deepEqual(portDesign(dir, 'port-calc-add', { update: true }).added, []);
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

test('--update tells apart questions whose short titles are the same', () => {
  const dir = extract();
  const long = '[Reject `text`] Overflow wraps around for very large numbers in the add function of the calculator page';
  write(dir, `${X}/questions.md`, `# Questions\n\n- Q1. ${long} - when the sum is negative\n- Q2. ${long} - when the sum is positive\n`);
  review(dir, 'extract-calc');
  const first = read(dir, `${X}/review.md`);
  assert.match(first, /- \[ \] Q1 \[Reject `text`\] Overflow wraps[^\n]* - when the sum is negative: decision:\n- \[ \] Q2 \[Reject `text`\] Overflow wraps[^\n]* - when the sum is positive: decision:\n/);
  write(dir, `${X}/review.md`, tickAll(first).replace(/(negative: decision:)$/m, '$1 keep').replace(/(positive: decision:)$/m, '$1 **fix**'));
  assert.equal(review(dir, 'extract-calc', { update: true }).written, false);
  // Q1 is withdrawn and Q2 becomes Q1: only Q2's tick and decision move.
  write(dir, `${X}/questions.md`, `# Questions\n\n- Q1. ${long} - when the sum is positive\n`);
  const result = review(dir, 'extract-calc', { update: true });
  assert.match(read(dir, `${X}/review.md`), /- \[x\] Q1 \[Reject `text`\] Overflow wraps[^\n]* - when the sum is positive: decision: \*\*fix\*\*\n$/);
  assert.deepEqual(result.removed.map((r) => [r.item.slice(-31), r.why]), [['sum is negative: decision: keep', 'its subject is gone']]);
});

test('--update keeps a question when a sibling with the same opening is added or withdrawn, and reads "decision" inside a name', () => {
  const dir = extract();
  write(dir, `${X}/questions.md`, '# Questions\n\n- Q1. Overflow wraps around\n- Q2. Overflow wraps around - only on 32-bit hosts\n- Q3. The credit limit decision\n');
  write(dir, `${X}/specs/calc/spec.md`, SPEC.replace('Add two numbers', 'Record the decision: approve or reject'));
  review(dir, 'extract-calc');
  write(dir, `${X}/review.md`, tickAll(read(dir, `${X}/review.md`)).replace(/(around: decision:)$/m, '$1 keep').replace(/(hosts: decision:)$/m, '$1 fix').replace(/(limit decision: decision:)$/m, '$1 ask'));
  const ticked = read(dir, `${X}/review.md`);
  assert.equal(review(dir, 'extract-calc', { update: true }).written, false, 'a name with "decision:" in it is stable');
  // Q1 is withdrawn: Q2 (now Q1) keeps its own tick and decision, and only Q1's goes.
  write(dir, `${X}/questions.md`, '# Questions\n\n- Q1. Overflow wraps around - only on 32-bit hosts\n- Q2. The credit limit decision\n');
  const result = review(dir, 'extract-calc', { update: true });
  assert.match(read(dir, `${X}/review.md`), /- \[x\] Q1 Overflow wraps around - only on 32-bit hosts: decision: fix\n- \[x\] Q2 The credit limit decision: decision: ask\n$/);
  assert.deepEqual(result.removed.map((r) => r.item), ['Q1 Overflow wraps around: decision: keep']);
  // A new sibling leaves the ticked one as it was.
  write(dir, `${X}/review.md`, ticked);
  write(dir, `${X}/questions.md`, '# Questions\n\n- Q1. Overflow wraps around\n- Q2. Overflow wraps around - only on 32-bit hosts\n- Q3. The credit limit decision\n- Q4. Overflow wraps around - on 16-bit hosts\n');
  const added = review(dir, 'extract-calc', { update: true });
  assert.deepEqual(added.changed, []);
  assert.deepEqual(added.added, ['Q4 Overflow wraps around - on 16-bit hosts: decision:']);
});

test('--update writes nothing while coverage.md is unreadable, and a renumbered item needs a shared word', () => {
  const dir = extract();
  review(dir, 'extract-calc');
  write(dir, `${X}/review.md`, tickAll(read(dir, `${X}/review.md`)));
  const before = read(dir, `${X}/review.md`);
  // A UTF-16 ledger would make its C1 item look gone, with the person's tick.
  fs.writeFileSync(path.join(dir, `${X}/coverage.md`), Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('| Site |', 'utf16le')]));
  const refused = review(dir, 'extract-calc', { update: true });
  assert.equal(refused.ok, false);
  assert.match(refused.problems.join(), /coverage\.md/);
  assert.equal(read(dir, `${X}/review.md`), before);
  // A requirement that only kept R1's number does not take R1's notes.
  const fresh = extract();
  review(fresh, 'extract-calc');
  write(fresh, `${X}/review.md`, tickAll(read(fresh, `${X}/review.md`)).replace('- [x] R1 Add two numbers', '- [x] R1 Add two numbers\n  - fix: name the operands'));
  write(fresh, `${X}/specs/calc/spec.md`, SPEC.replace('Add two numbers', 'Clear memory'));
  const result = review(fresh, 'extract-calc', { update: true });
  assert.deepEqual(result.added, ['R1 Clear memory']);
  assert.deepEqual(result.removed.map((r) => r.lines), [['- [x] R1 Add two numbers', '  - fix: name the operands']]);
});

test('review accepts a requirement named ".NET ..." as the gate does', () => {
  const dir = extract();
  write(dir, `${X}/specs/calc/spec.md`, SPEC.replace('Add two numbers', '.NET rounding').replace('Reject `text`', '-1 is rejected'));
  write(dir, `${X}/trace.md`, '| Requirement | Source | Existing tests |\n|---|---|---|\n| .NET rounding | src/calc.php:add:3-5 | none |\n| -1 is rejected | src/calc.php:add:9 | none |\n');
  write(dir, `${X}/crosscheck.md`, '| Item | Verdict | Evidence |\n|---|---|---|\n| R1 .NET rounding | confirmed | x |\n| R2 -1 is rejected | confirmed | x |\n| S1 Calculator | confirmed | x |\n');
  review(dir, 'extract-calc');
  write(dir, `${X}/review.md`, tickAll(read(dir, `${X}/review.md`)).replace(/decision:$/gm, 'decision: keep'));
  assert.deepEqual(checkReview(dir, 'extract-calc').problems.filter((p) => /rounding|rejected/.test(p)), []);
  assert.equal(review(dir, 'extract-calc', { update: true }).written, false);
  // Hand-written ids with a mark right after them still name the requirement.
  write(dir, `${X}/review.md`, read(dir, `${X}/review.md`).replace('- [x] R1 .NET rounding', '- [x] R1..NET rounding').replace('- [x] R2 -1 is rejected', '- [x] R2--1 is rejected'));
  assert.deepEqual(checkReview(dir, 'extract-calc').problems.filter((p) => /rounding|rejected/.test(p)), []);
  write(dir, `${X}/review.md`, read(dir, `${X}/review.md`).replace('- [x] R1..NET rounding', '- [x] R1.**.NET rounding**'));
  assert.deepEqual(checkReview(dir, 'extract-calc').problems.filter((p) => /rounding|rejected/.test(p)), []);
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
  // platform has no port: its A is the whole-system Test command.
  assert.match(text, /\| platform \| pass \| - \| - \| - \| finish\.mjs run \d{4}-\d{2}-\d{2}: no port, the Test command \|/);
  // A second run replaces its own note and keeps the orchestrator's.
  write(dir, 'openspec/changes/finish/checks.md', text.replace(/(\| Build \| `npm run build` \| pass \| )([^|]*)\|/, '$1 12 targets; $2|'));
  const again = await runChecks(dir, 'finish', { run: async () => ({ exitCode: 0, seconds: 2, timedOut: false, output: '' }), progress: () => {} });
  assert.equal(again.ok, true, again.problems.join('\n'));
  const now = read(dir, 'openspec/changes/finish/checks.md');
  assert.match(now, /\| Build \| `npm run build` \| pass \| 12 targets; finish\.mjs run \d{4}-\d{2}-\d{2}, 2 s \|/);
  assert.match(now, /\| billing \| pass \| pass \| - \| - \| finish\.mjs run \d{4}-\d{2}-\d{2} \|/);
});

test('finish.mjs run keeps a not-run cell, leaves a level a port has no command for, and keeps the orchestrator\'s counts', async () => {
  const dir = finishRepo();
  quiet(() => finishDraft(dir, 'finish'));
  write(dir, 'openspec/changes/finish/checks.md', read(dir, 'openspec/changes/finish/checks.md').replace(/\| billing \| ([^|]*) \| ([^|]*) \|/, '| billing | $1 | not-run: the PHP server is gone |'));
  const calls = [];
  const ok = async (command) => { calls.push(command); return { exitCode: 0, seconds: 1, timedOut: false, output: '' }; };
  let result = await runChecks(dir, 'finish', { run: ok, progress: () => {} });
  assert.ok(!calls.some((c) => c.startsWith('node b1-')));
  assert.deepEqual(result.skipped, [{ context: 'billing', level: 'B1', why: 'checks.md says not-run' }]);
  assert.match(read(dir, 'openspec/changes/finish/checks.md'), /\| billing \| pass \| not-run: the PHP server is gone \|/);
  // A port without the B1 command: the cell stays as it was.
  quiet(() => fs.rmSync(path.join(dir, 'openspec/changes/finish/checks.md')));
  quiet(() => finishDraft(dir, 'finish'));
  write(dir, 'openspec/changes/archive/2026-11-04-port-billing-payment/design.md', '## Verification\n| Level | Covers | Command |\n|---|---|---|\n| A | all | |\n');
  result = await runChecks(dir, 'finish', { run: ok, progress: () => {} });
  assert.match(result.problems.join('\n'), /level B1 of context billing has no command in the design.md of billing\/payment/);
  const text = read(dir, 'openspec/changes/finish/checks.md');
  assert.match(text, /\| billing \| pass \| <!-- pass \/ fail \/ not-run: reason --> \|/);
  write(dir, 'openspec/changes/finish/checks.md', text.replace(/(\| Test \| `npm test` \| pass \| )(finish\.mjs run [^|]*?) \|/, '$1$2 (412 tests, 412 passed) |'));
  await runChecks(dir, 'finish', { run: ok, progress: () => {} });
  assert.match(read(dir, 'openspec/changes/finish/checks.md'), /\| Test \| `npm test` \| pass \| \(412 tests, 412 passed\); finish\.mjs run \d{4}-\d{2}-\d{2}, 1 s \|/);
});

test('finish.mjs run writes fail when a level failed in one port and another has no command, and opens a stale pass', async () => {
  const dir = finishRepo();
  quiet(() => finishDraft(dir, 'finish'));
  const ok = async () => ({ exitCode: 0, seconds: 1, timedOut: false, output: '' });
  await runChecks(dir, 'finish', { run: ok, progress: () => {} });
  assert.match(read(dir, 'openspec/changes/finish/checks.md'), /\| billing \| pass \| pass \|/);
  // payment loses its B1 command: the earlier pass no longer stands.
  write(dir, 'openspec/changes/archive/2026-11-04-port-billing-payment/design.md', '## Verification\n| Level | Covers | Command |\n|---|---|---|\n| A | all | |\n');
  let result = await runChecks(dir, 'finish', { run: ok, progress: () => {} });
  assert.match(result.problems.join('\n'), /has no command in the design\.md of billing\/payment; its cell is left open/);
  assert.match(read(dir, 'openspec/changes/finish/checks.md'), /\| billing \| pass \|  \|/);
  // And invoice's B1 fails: the cell says fail.
  result = await runChecks(dir, 'finish', { run: async (command) => ({ exitCode: command === 'node b1-invoice.js' ? 1 : 0, seconds: 1, timedOut: false, output: '' }), progress: () => {} });
  assert.match(read(dir, 'openspec/changes/finish/checks.md'), /\| billing \| pass \| fail \| - \| - \| finish\.mjs run \d{4}-\d{2}-\d{2}: B1 failed in billing\/invoice \|/);
  // invoice passes now, payment still has no command: the old fail is opened.
  await runChecks(dir, 'finish', { run: ok, progress: () => {} });
  assert.match(read(dir, 'openspec/changes/finish/checks.md'), /\| billing \| pass \|  \|/);
  result = await runChecks(dir, 'finish', { run: async (command) => ({ exitCode: command === 'node b1-invoice.js' ? 1 : 0, seconds: 1, timedOut: false, output: '' }), progress: () => {} });
  // An older note with commas is replaced too.
  write(dir, 'openspec/changes/finish/checks.md', read(dir, 'openspec/changes/finish/checks.md').replace('B1 failed in billing/invoice', 'B1 failed in billing/invoice, billing/payment'));
  await runChecks(dir, 'finish', { run: ok, progress: () => {} });
  assert.doesNotMatch(read(dir, 'openspec/changes/finish/checks.md'), /failed in billing\/invoice, billing\/payment/);
});

test('--update unticks a leftover whose class changed, keeps twins, and a new leftover needs a shared word to take notes', () => {
  const dir = tempDir();
  const L = 'openspec/changes/finish';
  write(dir, `${L}/.openspec.yaml`, 'schema: spec-relay-finish\n');
  const rows = (...r) => `| Id | Kind | Where | What | Class | Reason |\n|---|---|---|---|---|---|\n${r.join('\n')}\n`;
  write(dir, `${L}/leftovers.md`, rows('| L1 | todo | `ts/a.ts:3` | check the rounding | after-release | x |', '| L2 | todo | `ts/a.ts:3` | check the rounding | after-release | x |', '| L3 | flow | billing | refund flow has no test | after-release | y |'));
  review(dir, 'finish');
  write(dir, `${L}/review.md`, tickAll(read(dir, `${L}/review.md`)).replace('refund flow has no test (billing) - class: after-release', 'refund flow has no test (billing) - class: after-release\n  - hold: ask the payments team'));
  assert.equal(review(dir, 'finish', { update: true }).written, false, 'two leftovers with the same what and where stay ticked');
  // L1 goes and the twin becomes wont-fix: it is unticked.
  write(dir, `${L}/leftovers.md`, rows('| L1 | todo | `ts/a.ts:3` | check the rounding | wont-fix | x |', '| L2 | flow | billing | refund flow has no test | after-release | y |'));
  const changed = review(dir, 'finish', { update: true });
  assert.match(read(dir, `${L}/review.md`), /- \[ \] L1 check the rounding \(ts\/a\.ts:3\) - class: wont-fix\n- \[x\] L2 refund flow has no test \(billing\) - class: after-release\n {2}- hold: ask the payments team\n/);
  assert.equal(changed.changed.length, 1);
  // An unrelated leftover at the old number does not take L2's note.
  write(dir, `${L}/leftovers.md`, rows('| L1 | todo | `ts/a.ts:3` | check the rounding | wont-fix | x |', '| L2 | risk | ts | logging is verbose | after-release | z |'));
  const swapped = review(dir, 'finish', { update: true });
  assert.deepEqual(swapped.added, ['L2 logging is verbose (ts) - class: after-release']);
  assert.deepEqual(swapped.removed.map((r) => r.lines.length), [2]);
});

test('review tells apart two leftovers with the same words by where they are', () => {
  const dir = tempDir();
  write(dir, 'openspec/changes/finish/.openspec.yaml', 'schema: spec-relay-finish\n');
  write(dir, 'openspec/changes/finish/leftovers.md', '# Leftovers\n\n| Id | Kind | Where | What | Class | Reason |\n|---|---|---|---|---|---|\n| L1 | todo | `ts/a.ts:3` | check the rounding | after-release | x |\n| L2 | todo | `ts/b.ts:9` | check the rounding | before-release | y |\n');
  review(dir, 'finish');
  const text = read(dir, 'openspec/changes/finish/review.md');
  assert.match(text, /- \[ \] L1 check the rounding \(ts\/a\.ts:3\) - class: after-release\n- \[ \] L2 check the rounding \(ts\/b\.ts:9\) - class: before-release\n/);
  write(dir, 'openspec/changes/finish/review.md', tickAll(text));
  assert.equal(review(dir, 'finish', { update: true }).written, false);
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
  const { items: found, reviewer, other } = readReview('# Review\n\nReviewer: Uma\n<!-- a\ncomment -->\n- [x] R1 a\n  - fix: b\n- [ ] R2 c\nfree text\n\nmore text\n', (b) => b.slice(0, 2));
  assert.equal(reviewer, 'Reviewer: Uma');
  assert.deepEqual(found.map((i) => [i.key, i.done, i.block.length]), [['R1', true, 2], ['R2', false, 1]]);
  assert.deepEqual(other, ['<!-- a', 'comment -->', 'free text', '', 'more text']);
});

test('readReview keeps a comment inside an item\'s notes with it, and a fix under a heading of its own with no item', () => {
  const read2 = readReview('# Review\n\n## 1. R\n- [ ] R1 a\n  <!-- two\n  lines -->\n  - fix: b\n\n## 2. S\n- fix: c\n- [ ] S1 d\ntail\n', (b) => b.slice(0, 2));
  assert.deepEqual(read2.items.map((i) => i.block), [['- [ ] R1 a', '  <!-- two', '  lines -->', '  - fix: b'], ['- [ ] S1 d']]);
  assert.deepEqual(read2.other, ['- fix: c', 'tail']);
  assert.equal(read2.moved, 1);
  assert.equal(readReview('free\n## 1. R\n- [ ] R1 a\n', (b) => b.slice(0, 2)).moved, 1);
  // In a review.md it goes under a heading of its own, where the gate gives it to no item, and stays there.
  const dir = extract();
  review(dir, 'extract-calc');
  write(dir, `${X}/review.md`, tickAll(read(dir, `${X}/review.md`)).replace(/decision:$/gm, 'decision: keep').replace('## 2. Screens\n', '## 2. Screens\n- fix: c\n'));
  assert.deepEqual(checkReview(dir, 'extract-calc'), { ok: true, problems: [] });
  assert.equal(review(dir, 'extract-calc', { update: true }).moved, 1);
  assert.match(read(dir, `${X}/review.md`), /\n## Other notes\n- fix: c\n$/);
  assert.deepEqual(checkReview(dir, 'extract-calc'), { ok: true, problems: [] });
  const again = review(dir, 'extract-calc', { update: true });
  assert.equal(again.written, false);
  assert.equal(again.moved, 0);
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
