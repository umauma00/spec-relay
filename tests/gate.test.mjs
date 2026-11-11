import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { checkReview, checkPortReady, checkPortDone, baselineHash, archivedChange, sourceFiles, main, nextSteps, language } from '../scripts/gate.mjs';
import { quiet } from './helpers.mjs';
import { tempDir, write } from './helpers.mjs';

const CHANGE = 'openspec/changes/extract-calc';
const SPEC = `## Purpose\n\nAdds numbers.\n\n## ADDED Requirements\n\n### Requirement: Add two numbers\nThe system SHALL add.\n\n#### Scenario: s\n- **WHEN** x\n- **THEN** y\n\n### Requirement: Reject text\nThe system SHALL reject text.\n\n#### Scenario: t\n- **WHEN** x\n- **THEN** y\n`;
const QUESTIONS = '# Questions\n\n## Suspected bugs\n- Q1. Overflow wraps - keep or fix?\n\n## Ambiguities\nNone\n';
const GOOD = 'Reviewer: Uma\n\n## 1. Requirements\n- [x] R1 Add two numbers\n- [x] R2 Reject text\n\n## 2. Questions\n- [x] Q1 Overflow: decision: keep\n';

const CROSSCHECK = '| Item | Verdict | Evidence |\n|---|---|---|\n| R1 Add two numbers | confirmed | src/calc.php:3 |\n| R2 Reject text | confirmed | src/calc.php:9 |\n';

// The archived survey that lists the capability the fixtures review.
function surveyed(dir, caps = ['calc']) {
  write(dir, 'openspec/changes/archive/2026-11-01-survey/capabilities.md', `# Capabilities\n\n${caps.map((c, i) => `${i + 1}. \`${c}\``).join('\n')}\n`);
  return dir;
}

function repo(review, { questions = QUESTIONS, screens = '# Screens\n\nNone\n', crosscheck = CROSSCHECK } = {}) {
  const dir = surveyed(tempDir());
  write(dir, `${CHANGE}/specs/calc/spec.md`, SPEC);
  write(dir, `${CHANGE}/questions.md`, questions);
  if (screens !== null) write(dir, `${CHANGE}/screens.md`, screens);
  if (crosscheck !== null) write(dir, `${CHANGE}/crosscheck.md`, crosscheck);
  if (review !== null) write(dir, `${CHANGE}/review.md`, review);
  return dir;
}

test('a complete, ticked review passes', () => {
  assert.deepEqual(checkReview(repo(GOOD), 'extract-calc'), { ok: true, problems: [] });
});

test('review gate failures', () => {
  const cases = {
    'review.md is missing': null,
    'no checklist items': 'Reviewer: Uma\n',
    'not ticked: R2': GOOD.replace('- [x] R2', '- [ ] R2'),
    'no review item: "Reject text"': GOOD.replace('- [x] R2 Reject text\n', ''),
    'no review item: Q1': GOOD.replace('- [x] Q1 Overflow: decision: keep\n', ''),
    'no recorded decision: Q1': GOOD.replace('decision: keep', 'decision:'),
    'names no reviewer': GOOD.replace('Reviewer: Uma', 'Reviewer: <!-- name -->'),
  };
  for (const [expected, review] of Object.entries(cases)) {
    const result = checkReview(repo(review), 'extract-calc');
    assert.equal(result.ok, false, expected);
    assert.ok(result.problems.some((p) => p.includes(expected)), `${expected}: ${result.problems}`);
  }
});

test('ticks inside HTML comments do not count', () => {
  const result = checkReview(repo(`${GOOD.replace('- [x] R2 Reject text', '<!-- - [x] R2 Reject text -->')}`), 'extract-calc');
  assert.ok(result.problems.some((p) => p.includes('"Reject text"')));
});

function foundation(dir) {
  write(dir, 'openspec/changes/archive/2026-11-01-survey/context-map.md', '### Context: billing\n');
  write(dir, 'openspec/changes/archive/2026-11-02-target-design/architecture.md', '# a\n');
}

test('port-ready needs a baseline and no active extract change', () => {
  const dir = tempDir();
  let problems = checkPortReady(dir, 'billing/invoice').problems.join();
  assert.match(problems, /no baseline spec/);
  assert.match(problems, /no archived survey/);
  assert.match(problems, /no archived target-design/);
  foundation(dir);
  write(dir, 'openspec/specs/billing/invoice/spec.md', SPEC);
  write(dir, 'openspec/changes/extract-billing-invoice/review.md', GOOD);
  assert.match(checkPortReady(dir, 'billing/invoice').problems.join(), /still active/);
  fs.rmSync(path.join(dir, 'openspec/changes/extract-billing-invoice'), { recursive: true });
  assert.deepEqual(checkPortReady(dir, 'billing/invoice'), { ok: true, problems: [] });
  write(dir, 'openspec/changes/amend-billing-invoice-v2/reason.md', '# r\n');
  assert.match(checkPortReady(dir, 'billing/invoice').problems.join(), /amend change amend-billing-invoice-v2 is still active/);
});

test('port-done needs at least one task and every task done', () => {
  const dir = tempDir();
  assert.equal(checkPortDone(dir, 'port-calc').ok, false);
  write(dir, 'openspec/changes/port-calc/tasks.md', '# Tasks\n');
  assert.match(checkPortDone(dir, 'port-calc').problems.join(), /no tasks/);
  write(dir, 'openspec/changes/port-calc/tasks.md', '# Tasks\n- [x] 1.1 a\n- [ ] 1.2 b\n');
  assert.match(checkPortDone(dir, 'port-calc').problems.join(), /not done: 1.2 b/);
  write(dir, 'openspec/changes/port-calc/tasks.md', '# Tasks\n- [x] 1.1 a\n- [X] 1.2 b\n');
  assert.match(checkPortDone(dir, 'port-calc').problems.join(), /records no baseline hash/);
  write(dir, 'openspec/specs/calc/spec.md', SPEC);
  const hash = baselineHash(dir, 'calc');
  write(dir, 'openspec/changes/port-calc/proposal.md', `## Baseline\n- \`calc\` sha256:${hash}\n`);
  assert.deepEqual(checkPortDone(dir, 'port-calc'), { ok: true, problems: [] });
  // A CRLF checkout of the same baseline has the same hash.
  write(dir, 'openspec/specs/calc/spec.md', SPEC.replace(/\n/g, '\r\n'));
  assert.equal(baselineHash(dir, 'calc'), hash);
  // An archived amendment changed the baseline.
  write(dir, 'openspec/specs/calc/spec.md', `${SPEC}\n### Requirement: More\n`);
  assert.match(checkPortDone(dir, 'port-calc').problems.join(), /baseline of calc changed/);
});

test('review items must match requirement names exactly, once each', () => {
  const spec = SPEC.replace('Reject text', 'Add two numbers twice');
  const dir = repo(GOOD.replace('R2 Reject text', 'R2 Add two numbers twice'), { crosscheck: CROSSCHECK.replace('R2 Reject text', 'R2 Add two numbers twice') });
  write(dir, `${CHANGE}/specs/calc/spec.md`, spec);
  assert.equal(checkReview(dir, 'extract-calc').ok, true);
  write(dir, `${CHANGE}/review.md`, GOOD.replace('- [x] R1 Add two numbers\n', '').replace('R2 Reject text', 'R2 Add two numbers twice'));
  assert.match(checkReview(dir, 'extract-calc').problems.join(), /no review item: "Add two numbers"/);
});

test('requirements OpenSpec would archive count even in lower case or comments', () => {
  for (const extra of ['### requirement: Hidden lowercase\n', '<!--\n### Requirement: Commented out\n-->\n']) {
    const dir = repo(GOOD);
    write(dir, `${CHANGE}/specs/calc/spec.md`, SPEC + extra);
    assert.match(checkReview(dir, 'extract-calc').problems.join(), /no review item/, extra);
  }
});

test('boxes count the way OpenSpec counts them, and fenced lines do not count', () => {
  assert.match(checkReview(repo(`${GOOD}1. [ ] C1 Coverage\n`), 'extract-calc').problems.join(), /not ticked: C1/);
  assert.match(checkReview(repo(`${GOOD}<!--\n- [ ] C2 hidden\n-->\n`), 'extract-calc').problems.join(), /not ticked/);
  const fenced = GOOD.replace('- [x] R2 Reject text', '```\n- [x] R2 Reject text\n```');
  assert.match(checkReview(repo(fenced), 'extract-calc').problems.join(), /"Reject text"/);
  const dir = tempDir();
  write(dir, 'openspec/changes/port-calc/tasks.md', '# Tasks\n- [x] 1.1 a\n1. [ ] 1.2 b\n+ [ ] 1.3 c\n');
  assert.equal(checkPortDone(dir, 'port-calc').problems.filter((p) => p.startsWith('not done')).length, 2);
});

test('questions: missing file, other id formats and placeholder decisions', () => {
  const missing = repo(GOOD);
  fs.rmSync(path.join(missing, `${CHANGE}/questions.md`));
  assert.match(checkReview(missing, 'extract-calc').problems.join(), /questions.md is missing/);
  const formats = repo(GOOD, { questions: '| Id | Q |\n|---|---|\n| Q1 | a |\n1. **Q2** b\n- [Q3] c\n' });
  const problems = checkReview(formats, 'extract-calc').problems.join();
  assert.match(problems, /no review item: Q2/);
  assert.match(problems, /no review item: Q3/);
  assert.ok(checkReview(repo(GOOD.replace('- [x] Q1 Overflow', '- [x] **Q1** Overflow')), 'extract-calc').ok);
  for (const placeholder of ['TBD', '<decision>', '...']) {
    assert.match(checkReview(repo(GOOD.replace('decision: keep', `decision: ${placeholder}`)), 'extract-calc').problems.join(), /no recorded decision/);
  }
  assert.match(checkReview(repo(GOOD.replace('Reviewer: Uma', 'Reviewer: <name>')), 'extract-calc').problems.join(), /no reviewer/);
});

test('port-ready normalises the capability path', () => {
  const dir = tempDir();
  write(dir, 'openspec/specs/billing/invoice/spec.md', SPEC);
  write(dir, 'openspec/changes/extract-billing-invoice/review.md', GOOD);
  foundation(dir);
  for (const cap of ['billing/invoice/', './billing/invoice', 'billing//invoice', 'billing\\invoice']) {
    assert.match(checkPortReady(dir, cap).problems.join(), /still active/, cap);
  }
  assert.equal(checkPortReady(dir, '../x').ok, false);
});

test('CRLF and a UTF-8 BOM are read normally; UTF-16 files fail the gate', () => {
  const crlf = (text) => text.replace(/\n/g, '\r\n');
  const dir = repo(`\uFEFF${crlf(GOOD)}`, { questions: `\uFEFF${crlf(QUESTIONS)}` });
  write(dir, `${CHANGE}/specs/calc/spec.md`, `\uFEFF${crlf(SPEC)}`);
  assert.deepEqual(checkReview(dir, 'extract-calc'), { ok: true, problems: [] });

  // What Windows PowerShell 5.1 writes with `>` or Out-File.
  const utf16 = (text) => Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(text, 'utf16le')]);
  for (const rel of ['questions.md', 'specs/calc/spec.md', 'review.md']) {
    const bad = repo(GOOD.replace('- [x] Q1 Overflow: decision: keep\n', ''), { questions: '# Questions\nNone\n' });
    fs.writeFileSync(path.join(bad, CHANGE, rel), utf16(rel === 'questions.md' ? QUESTIONS : 'x\n'));
    assert.match(checkReview(bad, 'extract-calc').problems.join(), /not UTF-8/, rel);
  }
  const port = tempDir();
  fs.mkdirSync(path.join(port, 'openspec/changes/port-calc'), { recursive: true });
  fs.writeFileSync(path.join(port, 'openspec/changes/port-calc/tasks.md'), utf16('- [x] 1.1 a\n'));
  assert.equal(checkPortDone(port, 'port-calc').ok, false);
});

test('a spec file with no requirements fails the review gate', () => {
  const dir = repo(GOOD);
  write(dir, `${CHANGE}/specs/calc/spec.md`, '## Purpose\n\nNothing here.\n');
  assert.match(checkReview(dir, 'extract-calc').problems.join(), /no requirements found/);
});

test('screens need review items and crosscheck rows; crosscheck verdicts must be resolved', () => {
  const screens = '### Screen: 請求書入力\n- **Entry**: x\n';
  const withScreen = repo(GOOD, { screens });
  let problems = checkReview(withScreen, 'extract-calc').problems.join('\n');
  assert.match(problems, /screen has no review item: "請求書入力"/);
  assert.match(problems, /screen has no crosscheck row: "請求書入力"/);
  const ok = repo(GOOD.replace('## 2. Questions', '- [x] S1 請求書入力\n\n## 2. Questions'), { screens, crosscheck: `${CROSSCHECK}| S1 請求書入力 | confirmed | x |\n` });
  assert.deepEqual(checkReview(ok, 'extract-calc'), { ok: true, problems: [] });

  assert.match(checkReview(repo(GOOD, { screens: null }), 'extract-calc').problems.join(), /screens.md is missing/);
  assert.match(checkReview(repo(GOOD, { crosscheck: null }), 'extract-calc').problems.join(), /crosscheck.md is missing/);
  for (const verdict of ['mismatch', 'unclear', '']) {
    problems = checkReview(repo(GOOD, { crosscheck: CROSSCHECK.replace('| R2 Reject text | confirmed', `| R2 Reject text | ${verdict}`) }), 'extract-calc').problems.join();
    assert.match(problems, /crosscheck of requirement "Reject text"/, verdict);
  }
  assert.ok(checkReview(repo(GOOD, { crosscheck: CROSSCHECK.replace('| R2 Reject text | confirmed', '| R2 Reject text | question Q1') }), 'extract-calc').ok);
  assert.match(checkReview(repo(GOOD, { crosscheck: CROSSCHECK.replace(/\| R2[^\n]*\n/, '') }), 'extract-calc').problems.join(), /no crosscheck row: "Reject text"/);
});

const SURVEY = 'openspec/changes/survey';
function survey({ inventory, review } = {}) {
  const dir = tempDir();
  write(dir, 'openspec/config.yaml', 'context: |\n  Source root (read-only; only openspec/ and the target root may change): .\n  Target root (new implementation): ts\n');
  write(dir, `${SURVEY}/.openspec.yaml`, 'schema: spec-relay-survey\n');
  write(dir, 'src/billing/invoice.php', '<?php\n');
  write(dir, 'src/common/db.php', '<?php\n');
  write(dir, 'vendor/lib.php', '<?php\n');
  write(dir, 'ts/index.ts', '');
  write(dir, '.git/HEAD', 'ref');
  write(dir, '.github/skills/openspec-explore/SKILL.md', '#');
  write(dir, `${SURVEY}/context-map.md`, '## Contexts\n\n### Context: platform\n- x\n\n### Context: billing\n- y\n');
  write(dir, `${SURVEY}/inventory.md`, inventory ?? '| Path | Context | Notes |\n|---|---|---|\n| src/ | billing | |\n| src/common/db.php | platform | |\n| vendor/ | excluded | library |\n');
  write(dir, `${SURVEY}/capabilities.md`, '# Capabilities\n\n### platform\n1. `platform/db` DB\n\n### billing\n1. `billing/invoice` 請求書\n   - src/billing\n');
  write(dir, `${SURVEY}/review.md`, review ?? 'Reviewer: Uma\n\n- [x] K1 platform: 共通基盤\n- [x] K2 billing: 請求\n- [x] M1 map\n- [x] C1 coverage\n');
  return dir;
}

test('the survey gate checks contexts, the inventory and the capability list', () => {
  const dir = survey();
  assert.deepEqual(sourceFiles(dir), ['src/billing/invoice.php', 'src/common/db.php', 'vendor/lib.php']);
  assert.deepEqual(checkReview(dir, 'survey'), { ok: true, problems: [] });

  const missing = survey({ inventory: '| Path | Context | Notes |\n|---|---|---|\n| src/billing/ | billing | |\n| ./vendor/lib.php | excluded | |\n| src/x | shipping | |\n' });
  const problems = checkReview(missing, 'survey').problems.join('\n');
  assert.match(problems, /source file not in the inventory: src\/common\/db.php/);
  assert.doesNotMatch(problems, /vendor/);
  assert.match(problems, /unknown context "shipping"/);
  assert.match(checkReview(survey({ review: 'Reviewer: Uma\n- [x] K1 platform\n' }), 'survey').problems.join(), /context has no review item: billing/);

  write(dir, `${SURVEY}/capabilities.md`, '### billing\n1. `billing/invoice`\n2. `shipping/x`\n3. `billing-invoice/a`\n4. `Billing`\n');
  const caps = checkReview(dir, 'survey').problems.join('\n');
  assert.match(caps, /"shipping\/x" starts with an unknown context/);
  assert.match(caps, /"Billing" is not <context>\/<name>/);
});

test('the target-design gate needs a module and verification levels for every context', () => {
  const dir = survey();
  fs.mkdirSync(path.join(dir, 'openspec/changes/archive'));
  fs.renameSync(path.join(dir, SURVEY), path.join(dir, 'openspec/changes/archive/2026-11-01-survey'));
  const T = 'openspec/changes/target-design';
  write(dir, `${T}/.openspec.yaml`, 'schema: spec-relay-target\n');
  write(dir, `${T}/review.md`, 'Reviewer: Uma\n- [x] A0 style\n- [x] A1 platform\n- [x] A2 billing\n- [x] E1 platform: levels\n- [x] E2 `billing`: levels\n');
  write(dir, `${T}/architecture.md`, '| Context | Module path |\n|---|---|\n| platform | ts/platform |\n');
  write(dir, `${T}/verification.md`, '| Context | A |\n|---|---|\n| platform | yes |\n| billing | yes |\n');
  assert.deepEqual(checkReview(dir, 'target-design').problems, ['architecture.md has no module row for context billing']);
  write(dir, `${T}/review.md`, 'Reviewer: Uma\n- [x] A1 platform\n- [x] E1 platform\n');
  assert.match(checkReview(dir, 'target-design').problems.join(), /module of context billing has no review item/);
  write(dir, `${T}/review.md`, 'Reviewer: Uma\n- [x] A0 style\n- [x] A1 platform\n- [x] A2 billing\n- [x] E1 platform: levels\n- [x] E2 `billing`: levels\n');
  write(dir, `${T}/architecture.md`, '| Context | Module path |\n|---|---|\n| platform | ts/platform |\n| `billing` | ts/billing |\n');
  assert.deepEqual(checkReview(dir, 'target-design'), { ok: true, problems: [] });
});

test('the amend gate: a reason, review items for the delta, crosscheck except for removed requirements', () => {
  const dir = surveyed(tempDir());
  write(dir, 'openspec/specs/calc/spec.md', SPEC);
  const A = 'openspec/changes/amend-calc';
  write(dir, `${A}/.openspec.yaml`, 'schema: spec-relay-amend\n');
  write(dir, `${A}/specs/calc/spec.md`, '## MODIFIED Requirements\n\n### Requirement: Add two numbers\nThe system SHALL truncate.\n\n## REMOVED Requirements\n\n### Requirement: Reject text\n**Reason**: not in the code\n');
  write(dir, `${A}/crosscheck.md`, '| Item | Verdict | Evidence |\n|---|---|---|\n| R1 Add two numbers | confirmed | x |\n');
  write(dir, `${A}/review.md`, 'Reviewer: Uma\n- [x] R1 Add two numbers\n- [x] R2 Reject text\n- [x] I1 impact\n');
  assert.match(checkReview(dir, 'amend-calc').problems.join(), /reason.md gives no reason/);
  write(dir, `${A}/reason.md`, '# Reason\n\n## What the source code does\nTruncates (src/calc.php:3).\n');
  assert.deepEqual(checkReview(dir, 'amend-calc'), { ok: true, problems: [] });
  write(dir, `${A}/review.md`, 'Reviewer: Uma\n- [x] R1 Add two numbers\n');
  assert.match(checkReview(dir, 'amend-calc').problems.join(), /no review item: "Reject text"/);
});

test('archived changes: the newest by date and rerun number', () => {
  const dir = tempDir();
  for (const name of ['2026-11-01-survey', '2026-11-03-survey', '2026-11-03-survey-v2', '2026-11-04-survey-extra']) fs.mkdirSync(path.join(dir, 'openspec/changes/archive', name), { recursive: true });
  assert.equal(path.basename(archivedChange(dir, 'survey')), '2026-11-03-survey-v2');
  assert.equal(archivedChange(dir, 'target-design'), null);
});

test('gate baseline prints the hash', () => {
  const dir = tempDir();
  write(dir, 'openspec/specs/calc/spec.md', SPEC);
  const logs = [];
  const { log } = console;
  console.log = (text) => logs.push(text);
  try { assert.equal(main(['baseline', '--capability', 'calc', '--root', dir]), 0); } finally { console.log = log; }
  assert.equal(JSON.parse(logs[0]).sha256, baselineHash(dir, 'calc'));
  assert.equal(quiet(() => main(['baseline', '--capability', 'nope', '--root', dir])), 1);
});

test('crosscheck verdicts: the whole cell, one row per item, questions that exist', () => {
  const bad = {
    'confirmed? No: mismatch': /is "confirmed\? no: mismatch"/,
    'confirmed partially; scenario 2 mismatch': /is "confirmed partially/,
    'question Q9': /points to Q9, which is not in questions.md/,
  };
  for (const [verdict, expected] of Object.entries(bad)) {
    const problems = checkReview(repo(GOOD, { crosscheck: CROSSCHECK.replace('| R2 Reject text | confirmed', `| R2 Reject text | ${verdict}`) }), 'extract-calc').problems.join();
    assert.match(problems, expected, verdict);
  }
  assert.ok(checkReview(repo(GOOD, { crosscheck: CROSSCHECK.replace('| R2 Reject text | confirmed', '| R2 Reject text | Confirmed.') }), 'extract-calc').ok);
  const twice = repo(GOOD, { crosscheck: `${CROSSCHECK}| R2 Reject text | mismatch | later |\n` });
  assert.match(checkReview(twice, 'extract-calc').problems.join(), /more than one crosscheck row: "Reject text"/);
});

test('screens.md needs readable screen headings or only None', () => {
  for (const screens of ['## Screen: Login\n', '### 画面: ログイン\n']) {
    assert.match(checkReview(repo(GOOD, { screens }), 'extract-calc').problems.join(), /no "### Screen: <name>" heading/, screens);
  }
  assert.ok(checkReview(repo(GOOD, { screens: '# Screens\n<!-- c -->\nNone\n' }), 'extract-calc').ok);
});

test('inventory paths keep their characters; a bad source root fails', () => {
  const dir = survey({ inventory: '| Path | Context | Notes |\n|---|---|---|\n| `src/my_module/file_a.php` | billing | |\n| src/Copy (1).php | billing | |\n| src/[id].php | billing | |\n| src/billing/ | billing | |\n| src/common/ | platform | |\n| vendor/ | excluded | |\n' });
  for (const f of ['src/my_module/file_a.php', 'src/Copy (1).php', 'src/[id].php']) write(dir, f, 'x');
  assert.deepEqual(checkReview(dir, 'survey'), { ok: true, problems: [] });
  for (const root of ['srcc', '../legacy', 'C:\\\\work\\\\legacy']) {
    write(dir, 'openspec/config.yaml', `context: |\n  Source root (read-only): ${root}\n`);
    assert.match(checkReview(dir, 'survey').problems.join(), /is not a folder inside the repository/, root);
  }
  write(dir, 'openspec/config.yaml', 'context: |\n  Source root (read-only): "src"  # quoted\n');
  assert.equal(checkReview(dir, 'survey').ok, true);
});

test('in a git repository, ignored and untracked-ignored files need no inventory row', { skip: spawnSync('git', ['--version']).status !== 0 && 'git not installed' }, () => {
  const dir = survey();
  write(dir, '.gitignore', '.vs/\ndesktop.ini\n');
  write(dir, '.vs/settings.json', '{}');
  write(dir, 'desktop.ini', 'x');
  fs.rmSync(path.join(dir, '.git'), { recursive: true });
  assert.equal(spawnSync('git', ['init', '-q'], { cwd: dir }).status, 0);
  const files = sourceFiles(dir);
  assert.ok(!files.some((f) => f.startsWith('.vs/') || f === 'desktop.ini'), files.join());
  assert.ok(files.includes('.gitignore'));
  assert.ok(files.includes('src/billing/invoice.php'));
});

test('capability names whose change name ends like a rerun are refused', () => {
  const dir = survey();
  write(dir, `${SURVEY}/capabilities.md`, '### billing\n1. `billing/v1`\n');
  assert.match(checkReview(dir, 'survey').problems.join(), /ends like a rerun suffix/);
});

test('an untouched reason template is no reason; amendments accept only confirmed', () => {
  const dir = tempDir();
  const A = 'openspec/changes/amend-calc';
  write(dir, `${A}/.openspec.yaml`, 'schema: spec-relay-amend\n');
  write(dir, `${A}/reason.md`, fs.readFileSync(path.join(import.meta.dirname, '../openspec-schemas/spec-relay-amend/templates/reason.md'), 'utf8'));
  write(dir, `${A}/specs/calc/spec.md`, '## MODIFIED Requirements\n\n### Requirement: Add two numbers\nThe system SHALL truncate.\n');
  write(dir, `${A}/crosscheck.md`, '| Item | Verdict | Evidence |\n|---|---|---|\n| R1 Add two numbers | question Q1 | x |\n');
  write(dir, `${A}/review.md`, 'Reviewer: Uma\n- [x] R1 Add two numbers\n');
  const problems = checkReview(dir, 'amend-calc').problems.join();
  assert.match(problems, /reason.md gives no reason/);
  assert.match(problems, /is "question q1"; resolve it \(fix and check again\)/);
});

test('port-done needs the hash of its own capability', () => {
  const dir = tempDir();
  write(dir, 'openspec/specs/calc/other/spec.md', SPEC);
  write(dir, 'openspec/changes/port-calc-add/tasks.md', '- [x] 1.1 a\n');
  write(dir, 'openspec/changes/port-calc-add/proposal.md', `- \`calc/other\` sha256:${baselineHash(dir, 'calc/other')}\n`);
  assert.match(checkPortDone(dir, 'port-calc-add').problems.join(), /no baseline hash for this change's own capability/);
});

test('guard hashes review.md of active changes, baseline specs and the config, not artifacts or archives', async () => {
  const { guardHash } = await import('../scripts/gate.mjs');
  const dir = tempDir();
  write(dir, 'openspec/config.yaml', 'x\n');
  write(dir, 'openspec/specs/a/b/spec.md', '## Purpose\n');
  write(dir, 'openspec/changes/extract-a/review.md', '- [ ] R1 a\n');
  write(dir, 'openspec/changes/extract-a/spec.md', 'draft\n');
  write(dir, 'openspec/changes/archive/2026-01-01-x/review.md', '- [x] old\n');
  write(dir, 'x.php', '<?php\n');
  const before = guardHash(dir);
  assert.equal(before.files, 4, 'review.md, the spec, the config and the source file x.php');
  write(dir, 'openspec/changes/extract-a/spec.md', 'draft 2\n');
  write(dir, 'openspec/changes/archive/2026-01-01-x/review.md', 'changed\n');
  assert.equal(guardHash(dir).sha256, before.sha256, 'artifacts and archives may change');
  write(dir, 'openspec/changes/extract-a/review.md', '- [x] R1 a\n');
  assert.notEqual(guardHash(dir).sha256, before.sha256, 'a tick changes the hash');
});

test('guard --save and --compare list only the protected files that changed', async () => {
  const { guardSave, guardCompare } = await import('../scripts/gate.mjs');
  const dir = tempDir();
  write(dir, 'openspec/config.yaml', 'context: |\n  Source root: src\n  Target root: new\n');
  write(dir, 'openspec/spec-relay/plan.md', '## Capabilities\n');
  write(dir, 'openspec/changes/extract-a/review.md', '- [ ] R1 a\n');
  write(dir, 'openspec/changes/extract-a/questions.md', '- Q1 a\n');
  write(dir, 'openspec/changes/extract-a/specs/a/spec.md', 'draft\n');
  write(dir, 'src/a.php', '<?php\n');
  write(dir, 'src/b.php', '<?php\n');
  write(dir, 'new/A.java', 'class A {}\n');
  assert.deepEqual(guardSave(dir, 'wave-1'), { ok: true, snapshot: 'openspec/spec-relay/work/guard/wave-1.json', files: 6 });
  write(dir, 'openspec/changes/extract-a/specs/a/spec.md', 'draft 2\n');
  write(dir, 'new/A.java', 'class A { }\n');
  write(dir, 'openspec/spec-relay/work/extract-a/crosscheck-01.md', '| Item | Verdict | Evidence |\n');
  assert.deepEqual(guardCompare(dir, 'wave-1'), { ok: true, changed: [], added: [], removed: [] }, 'artifacts, the target and work files may change');
  write(dir, 'openspec/changes/extract-a/questions.md', '- Q1 b\n');
  write(dir, 'openspec/spec-relay/plan.md', '## Capabilities\n- x\n');
  write(dir, 'src/a.php', '<?php // fixed\n');
  write(dir, 'src/c.php', '<?php\n');
  fs.rmSync(path.join(dir, 'src/b.php'));
  assert.deepEqual(guardCompare(dir, 'wave-1'), {
    ok: false,
    changed: ['openspec/changes/extract-a/questions.md', 'openspec/spec-relay/plan.md', 'src/a.php'],
    added: ['src/c.php'],
    removed: ['src/b.php'],
  });
  assert.match(guardCompare(dir, 'wave-2').problems.join(), /no snapshot .*wave-2\.json; run gate\.mjs guard --save wave-2/);
  assert.equal(guardSave(dir, '../x').ok, false);
  assert.equal(quiet(() => main(['guard', '--compare', '', '--root', dir])), 1, 'an empty name never falls back to the plain hash');
  write(dir, 'openspec/config.yaml', 'context: |\n  Source root: missing\n');
  assert.match(guardSave(dir, 'wave-3').warnings.join(), /source files are not guarded/);
});

test('an extract or amend review needs the archived survey, a listed capability and the matching change name', () => {
  const none = repo(GOOD);
  fs.rmSync(path.join(none, 'openspec/changes/archive'), { recursive: true });
  assert.match(checkReview(none, 'extract-calc').problems.join(), /no archived survey change: extract changes need the reviewed capability list/);

  const unlisted = surveyed(repo(GOOD), ['billing/invoice']);
  assert.match(checkReview(unlisted, 'extract-calc').problems.join(), /capability calc is not in the archived survey's capabilities.md or in openspec\/spec-relay\/plan.md/);
  // A capability added to the plan after the survey counts.
  write(unlisted, 'openspec/spec-relay/plan.md', '# Plan\n\n## Capabilities\n\n1. `billing/invoice`\n2. `calc` added later\n');
  assert.deepEqual(checkReview(unlisted, 'extract-calc'), { ok: true, problems: [] });

  const renamed = repo(GOOD);
  fs.renameSync(path.join(renamed, CHANGE), path.join(renamed, 'openspec/changes/extract-other'));
  assert.match(checkReview(renamed, 'extract-other').problems.join(), /change extract-other holds the spec of calc; a extract change of calc is named extract-calc/);
  // A rerun suffix is the same change.
  const rerun = repo(GOOD);
  fs.renameSync(path.join(rerun, CHANGE), path.join(rerun, 'openspec/changes/extract-calc-v2'));
  assert.deepEqual(checkReview(rerun, 'extract-calc-v2'), { ok: true, problems: [] });

  const amend = surveyed(tempDir());
  const A = 'openspec/changes/amend-calc';
  write(amend, `${A}/.openspec.yaml`, 'schema: spec-relay-amend\n');
  write(amend, `${A}/reason.md`, '# Reason\n\nTruncates (src/calc.php:3).\n');
  write(amend, `${A}/specs/calc/spec.md`, '## MODIFIED Requirements\n\n### Requirement: Add two numbers\nThe system SHALL truncate.\n');
  write(amend, `${A}/crosscheck.md`, '| Item | Verdict | Evidence |\n|---|---|---|\n| R1 Add two numbers | confirmed | x |\n');
  write(amend, `${A}/review.md`, 'Reviewer: Uma\n- [x] R1 Add two numbers\n');
  assert.match(checkReview(amend, 'amend-calc').problems.join(), /no baseline spec at openspec\/specs\/calc\/spec.md to amend/);
  write(amend, 'openspec/specs/calc/spec.md', SPEC);
  assert.deepEqual(checkReview(amend, 'amend-calc'), { ok: true, problems: [] });
});

test('next separates what the person decides from what the agent fixes, in the person\'s language', () => {
  const dir = repo('Reviewer: <name>\n- [ ] **R1** Add two numbers\n- [x] R2 Reject text\n- [ ] Q1 Overflow: decision:\n');
  const result = checkReview(dir, 'extract-calc');
  const ja = nextSteps('review', result, 'ja');
  assert.deepEqual(ja.person, [
    'レビューで未承認の項目が 2 件あります（R1, Q1）。チャットで承認を伝えるか、review.md で自分でチェックしてください。',
    'review.md に承認者の名前（Reviewer:）がありません。記録する名前を教えてください。',
    '判断がまだの質問があります（Q1）。新しいシステムでどうするかを決めてください。',
  ]);
  assert.deepEqual(ja.agent, []);
  write(dir, `${CHANGE}/crosscheck.md`, '| Item | Verdict | Evidence |\n|---|---|---|\n| R1 Add two numbers | mismatch | x |\n| R2 Reject text | confirmed | x |\n');
  assert.match(nextSteps('review', checkReview(dir, 'extract-calc'), 'en').agent.join(), /crosscheck of requirement "Add two numbers" is "mismatch"/);
  assert.match(nextSteps('review', checkReview(repo(GOOD), 'extract-calc'), 'en').person.join(), /may be archived/);
  assert.deepEqual(nextSteps('port-ready', { ok: false, problems: ['extract change extract-calc is still active; finish its review and archive it first', 'no archived survey change: x'] }, 'ja'),
    { person: ['extract-calc のレビューがまだ終わっていません。先にそのレビューを終えてください。', '調査（コンテキストの地図と capability の一覧）がまだレビュー・archive されていません。AI が用意するので、そのレビューをお願いします。この工程はそれを待ちます。'], agent: [] });
  // A project from kit 0.1.0 with an extract change in flight and no survey: the survey review is the person's.
  const old = repo(GOOD);
  fs.rmSync(path.join(old, 'openspec/changes/archive'), { recursive: true });
  assert.match(nextSteps('review', checkReview(old, 'extract-calc'), 'en').person.join(), /The survey .* is not reviewed and archived yet/);
  assert.match(nextSteps('guard', { ok: false, changed: ['src/a.php'], added: [], removed: [] }, 'ja').person[0], /割り当て外のファイルが変わりました（src\/a.php）/);

  write(dir, 'openspec/config.yaml', '# spec-relay: managed\ncontext: |\n  Artifact language: 日本語\n');
  assert.equal(language(dir), 'ja');
  assert.equal(language(dir, 'en'), 'en');
  const log = console.log;
  let out = '';
  console.log = (s) => { out += s; };
  try { assert.equal(main(['review', '--change', 'extract-calc', '--root', dir]), 1); } finally { console.log = log; }
  assert.match(JSON.parse(out).next.person[0], /^レビューで未承認の項目が/);
});

test('plan capabilities come from the capability list only, and no capability may end like a rerun', () => {
  const dir = surveyed(repo(GOOD), ['billing/invoice']);
  write(dir, 'openspec/spec-relay/plan.md', '# Plan\n\n## Capabilities\n\n1. `billing/invoice`\n\n## Follow-up\n\n- `calc`: fix rounding\n');
  assert.match(checkReview(dir, 'extract-calc').problems.join(), /capability calc is not in the archived survey/);
  const v = surveyed(tempDir(), ['billing/api-v2']);
  write(v, 'openspec/changes/extract-billing-api-v2/specs/billing/api-v2/spec.md', SPEC);
  write(v, 'openspec/changes/extract-billing-api-v2/review.md', GOOD);
  assert.match(checkReview(v, 'extract-billing-api-v2').problems.join(), /capability billing\/api-v2 ends like a rerun suffix/);
});
