import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { checkFinishReady, collect, draft, targetHash, planFollowUps, chosenLevels, main } from '../scripts/finish.mjs';
import { checkReview, baselineHash, nextSteps } from '../scripts/gate.mjs';
import { status } from '../scripts/status.mjs';
import { decide } from '../scripts/hook.mjs';
import { render } from '../scripts/render.mjs';
import { tempDir, write, quiet, crlf } from './helpers.mjs';

const KIT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const F = 'openspec/changes/finish';
const SPEC = '## Purpose\n\n### Requirement: a\nThe system SHALL a.\n';
const PLAN = '# Plan\n\n## Capabilities\n\n### billing\n1. `billing/invoice` 請求書\n\n## Follow-up\n- `billing/invoice` fix the rounding bug after the port\n  - an indented note is not an item\n';

// A migration whose only capability is ported: the finish step can start.
function repo() {
  const dir = tempDir();
  write(dir, 'openspec/config.yaml', '# spec-relay: managed by scripts/setup.mjs. Edit the values; keep this line.\ncontext: |\n  Source root (read-only): src\n  Target root (new implementation): ts\n  Artifact language: ja\n  Hook enforcement: on\n');
  write(dir, 'openspec/spec-relay/plan.md', PLAN);
  write(dir, 'openspec/changes/archive/2026-11-01-survey/context-map.md', '## Contexts\n\n### Context: platform\n\n### Context: billing\n\n## Relationships\n| Upstream | Downstream | Pattern | Channel |\n|---|---|---|---|\n| platform | billing | open host | call |\n\n## Shared data\n| Data | Owner | Also written by | Read by |\n|---|---|---|---|\n| invoices | billing | | |\n');
  write(dir, 'openspec/changes/archive/2026-11-02-target-design/conventions.md', '# Conventions\n\n## Commands\n| Purpose | Command |\n|---|---|\n| Build | `npm run build` |\n| Test | `npm test` |\n| Lint | |\n');
  write(dir, 'openspec/changes/archive/2026-11-02-target-design/verification.md', '## Levels\n| Context | A scenario tests | B1 logic comparison | B2 screen replay | C screenshots | Notes |\n|---|---|---|---|---|---|\n| platform | yes | no | no | no | |\n| billing | yes | yes | no | no | |\n');
  write(dir, 'openspec/specs/billing/invoice/spec.md', SPEC);
  write(dir, 'openspec/changes/archive/2026-11-03-extract-billing-invoice/review.md', 'Reviewer: Uma\n');
  write(dir, 'openspec/changes/archive/2026-11-04-port-billing-invoice/proposal.md', `## Baseline\n- \`billing/invoice\` sha256:${baselineHash(dir, 'billing/invoice')}\n`);
  write(dir, 'openspec/changes/archive/2026-11-04-port-billing-invoice/design.md', '## Risks\n- [Rounding differs in JS] -> decimal library\n- <!-- [Risk] -> Mitigation -->\n');
  write(dir, 'openspec/changes/archive/2026-11-04-port-billing-invoice/tasks.md', '- [x] 1.1 done\n');
  write(dir, 'src/invoice.php', '<?php // TODO(port) in the source is not counted\n');
  write(dir, 'ts/billing/invoice.ts', 'export const total = 1;\n// TODO(port) rounding of negative totals\n');
  write(dir, 'ts/node_modules/x/index.js', '// TODO(port) not ours\n');
  return dir;
}

// The finish change as the orchestrator leaves it once the person has reviewed it.
function finished(dir) {
  write(dir, `${F}/.openspec.yaml`, 'schema: spec-relay-finish\n');
  write(dir, `${F}/checks.md`, `# Whole-system checks\n\nTarget: sha256:${targetHash(dir)}\n\n## Commands\n| Purpose | Command | Result | Notes |\n|---|---|---|---|\n| Build | \`npm run build\` | pass | |\n| Test | \`npm test\` | pass (12 tests) | |\n\n## Verification levels\n| Context | A | B1 | B2 | C | Notes |\n|---|---|---|---|---|---|\n| platform | pass | - | - | - | |\n| billing | pass | not-run: the PHP server is gone | - | - | |\n\n## Cross-context flows\n| Upstream -> downstream | Covered by |\n|---|---|\n| platform -> billing | none |\n`);
  write(dir, `${F}/leftovers.md`, '# Leftovers\n\n| ID | Kind | Where | What | Class | Reason |\n|---|---|---|---|---|---|\n| L1 | todo | `ts/billing/invoice.ts:2` | TODO(port) rounding of negative totals | after-release | rare |\n| L2 | follow-up | billing/invoice | `billing/invoice` fix the rounding bug after the port | after-release | the person moved it |\n| L3 | risk | billing/invoice | [Rounding differs in JS] -> decimal library | wont-fix | resolved |\n| L4 | verification | billing B1 | logic comparison did not run | before-release | needs the old server |\n| L5 | flow | platform -> billing | no test across the modules | after-release | covered by hand |\n');
  write(dir, `${F}/handover.md`, '# Handover\n\n## Verdict\nMigration complete against the reviewed specs; billing was not compared with the source program.\n');
  write(dir, `${F}/review.md`, 'Reviewer: Uma\n\n## 1. Checks\n- [x] C1 The whole-system checks\n\n## 2. Leftovers\n- [x] L1 rounding - class: after-release\n- [x] L2 rounding bug - class: after-release\n- [x] L3 risk - class: wont-fix\n- [x] L4 B1 - class: before-release\n- [x] L5 flow - class: after-release\n\n## 3. Handover\n- [x] H1 The verdict\n- [x] H2 Before the switch\n');
  return dir;
}

const has = (result, text) => assert.ok(result.problems.some((p) => p.includes(text)), `${text}:\n${result.problems.join('\n')}`);

test('ready waits for every planned capability to be ported against its current baseline', () => {
  const dir = repo();
  assert.deepEqual(checkFinishReady(dir), { ok: true, problems: [] });
  // An amendment after the port makes it stale.
  write(dir, 'openspec/specs/billing/invoice/spec.md', `${SPEC}\n### Requirement: b\nThe system SHALL b.\n`);
  has(checkFinishReady(dir), 'was amended after its port');
  write(dir, 'openspec/specs/billing/invoice/spec.md', SPEC);
  // An unported capability, an unplanned baseline and another open change.
  write(dir, 'openspec/spec-relay/plan.md', PLAN.replace('1. `billing/invoice` 請求書', '1. `billing/invoice` 請求書\n2. `billing/payment`'));
  write(dir, 'openspec/specs/misc/old/spec.md', SPEC);
  write(dir, 'openspec/changes/port-misc-old/tasks.md', '- [ ] 1.1\n');
  const result = checkFinishReady(dir);
  has(result, 'capability billing/payment has no baseline spec yet');
  has(result, 'baseline spec misc/old is not in the plan');
  has(result, 'change port-misc-old is still active');
  // The finish change itself (and its reruns) do not block.
  const clean = repo();
  write(clean, `${F}-v2/.openspec.yaml`, 'schema: spec-relay-finish\n');
  assert.equal(checkFinishReady(clean).ok, true);
  const none = tempDir();
  write(none, 'openspec/config.yaml', 'context: |\n  Target root: ts\n');
  has(checkFinishReady(none), 'no archived survey change');
});

test('collect lists the markers, follow-ups, risks, levels, flows and commands', () => {
  const dir = repo();
  const facts = collect(dir);
  assert.deepEqual(facts.markers, [{ file: 'ts/billing/invoice.ts', line: 2, text: '// TODO(port) rounding of negative totals' }]);
  assert.deepEqual(facts.followUps, ['`billing/invoice` fix the rounding bug after the port']);
  assert.deepEqual(facts.risks, [{ port: 'port-billing-invoice', capability: 'billing/invoice', text: '[Rounding differs in JS] -> decimal library' }]);
  assert.deepEqual(facts.contexts, ['platform', 'billing']);
  assert.deepEqual(facts.levels, [{ context: 'platform', chosen: ['A'] }, { context: 'billing', chosen: ['A', 'B1'] }]);
  assert.deepEqual(facts.relations, [{ upstream: 'platform', downstream: 'billing', pattern: 'open host', channel: 'call' }]);
  assert.deepEqual(facts.commands, [{ purpose: 'Build', command: 'npm run build' }, { purpose: 'Test', command: 'npm test' }]);
  assert.equal(facts.target.files, 1);
  // A Windows checkout (CRLF) gives the same hash; a change to the code does not.
  const before = targetHash(dir);
  write(dir, 'ts/billing/invoice.ts', crlf('export const total = 1;\n// TODO(port) rounding of negative totals\n'));
  assert.equal(targetHash(dir), before);
  write(dir, 'ts/billing/invoice.ts', 'export const total = 2;\n');
  assert.notEqual(targetHash(dir), before);
});

test('in a git repository, ignored files (build output) are not part of the target', { skip: spawnSync('git', ['--version']).status !== 0 && 'git not found' }, () => {
  const dir = repo();
  const git = (...args) => assert.equal(spawnSync('git', args, { cwd: dir, encoding: 'utf8' }).status, 0, args.join(' '));
  git('init', '-q');
  write(dir, '.gitignore', 'ts/dist/\n');
  write(dir, 'ts/dist/bundle.js', '// TODO(port) built\n');
  const before = targetHash(dir);
  // node_modules is left out even when git does not ignore it.
  assert.deepEqual(collect(dir).markers.map((m) => m.file), ['ts/billing/invoice.ts']);
  write(dir, 'ts/dist/bundle.js', '// rebuilt\n');
  assert.equal(targetHash(dir), before);
  // A nested repository (a cloned starter) is listed as a folder; its files still count.
  write(dir, 'ts/web/main.ts', '// TODO(port) web\n');
  assert.equal(spawnSync('git', ['init', '-q'], { cwd: path.join(dir, 'ts/web') }).status, 0);
  assert.deepEqual(collect(dir).markers.map((m) => m.file), ['ts/billing/invoice.ts', 'ts/web/main.ts']);
  const nested = targetHash(dir);
  write(dir, 'ts/web/main.ts', '// changed\n');
  assert.notEqual(targetHash(dir), nested);
});

test('a context whose every capability has no screens drops B2 and C; one screen keeps them', () => {
  const dir = repo();
  const verification = 'openspec/changes/archive/2026-11-02-target-design/verification.md';
  write(dir, verification, '## Levels\n| Context | A scenario tests | B1 logic comparison | B2 screen replay | C screenshots | Notes |\n|---|---|---|---|---|---|\n| platform | yes | no | no | no | |\n| billing | yes | yes | yes | yes | |\n');
  // The extract's screens.md is not None (here: missing), so B2 and C stay.
  assert.deepEqual(collect(dir).levels[1], { context: 'billing', chosen: ['A', 'B1', 'B2', 'C'] });
  write(dir, 'openspec/changes/archive/2026-11-03-extract-billing-invoice/screens.md', '# Screens\n\nNone\n');
  const facts = collect(dir);
  assert.deepEqual(facts.levels[1], { context: 'billing', chosen: ['A', 'B1'], notApplicable: ['B2', 'C'] });
  write(dir, `${F}/.openspec.yaml`, 'schema: spec-relay-finish\n');
  assert.equal(draft(dir, 'finish').ok, true);
  assert.match(fs.readFileSync(path.join(dir, F, 'checks.md'), 'utf8'), /\| billing \| <!-- pass \/ fail \/ not-run: reason --> \| <!-- pass \/ fail \/ not-run: reason --> \| - \| - \| B2, C: no capability has screens \|/);
  // A second capability of the context with a screen keeps both for the context.
  write(dir, 'openspec/spec-relay/plan.md', PLAN.replace('1. `billing/invoice` 請求書', '1. `billing/invoice` 請求書\n2. `billing/entry` 入力'));
  write(dir, 'openspec/changes/archive/2026-11-03-extract-billing-entry/screens.md', '### Screen: Entry\n- x\n');
  assert.deepEqual(collect(dir).levels[1], { context: 'billing', chosen: ['A', 'B1', 'B2', 'C'] });
});

test('paths, comments and pipes in the code pass through the draft to the gate unchanged', () => {
  const dir = repo();
  write(dir, 'ts/billing/invoice_service.py', '# TODO(port) total() || 0 fallback\n');
  write(dir, 'ts/app/[id]/(shop)/page.tsx', '{/* TODO(port) pager */}\n');
  write(dir, 'ts/app/view.html', '<!-- TODO(port): pager\n<p>x</p>\n');
  write(dir, 'openspec/spec-relay/plan.md', `${PLAN}- fix \`a || b\` fallback\n`);
  finished(dir);
  fs.rmSync(path.join(dir, F, 'leftovers.md'));
  draft(dir, 'finish');
  const text = fs.readFileSync(path.join(dir, F, 'leftovers.md'), 'utf8').replace(/<!-- before-release \/ after-release \/ wont-fix --> \| \|/g, 'after-release | later |');
  const extra = '| L90 | verification | billing B1 | did not run | before-release | needs the old server |\n| L91 | flow | platform -> billing | no test | after-release | by hand |\n';
  write(dir, `${F}/leftovers.md`, text.replace('\n\n<!-- Add', `\n${extra}\n<!-- Add`));
  const ids = [...text.matchAll(/^\| (L\d+) \|/gm)].map((m) => m[1]);
  assert.equal(ids.length, 7);
  write(dir, `${F}/review.md`, `Reviewer: Uma\n\n${[...ids, 'L90', 'L91'].map((id) => `- [x] ${id} item`).join('\n')}\n- [x] H1 verdict\n`);
  assert.deepEqual(checkReview(dir, 'finish').problems.filter((p) => !p.includes('target code changed')), []);
  // The review page shows the path as written.
  render({ root: dir, change: 'finish' });
  assert.match(fs.readFileSync(path.join(dir, 'openspec/spec-relay/views/finish.html'), 'utf8'), /invoice_service\.py/);
});

test('a class changed in the review must match leftovers.md, level A always runs, and the change is named finish', () => {
  const dir = finished(repo());
  const review = path.join(dir, F, 'review.md');
  fs.writeFileSync(review, fs.readFileSync(review, 'utf8').replace('L1 rounding - class: after-release', 'L1 rounding - class: before-release'));
  has(checkReview(dir, 'finish'), 'review item L1 says class before-release, and leftovers.md says after-release');
  finished(dir);
  const checks = path.join(dir, F, 'checks.md');
  fs.writeFileSync(checks, fs.readFileSync(checks, 'utf8').replace('| platform | pass |', '| platform | not-run: later |'));
  has(checkReview(dir, 'finish'), 'level A of context platform is the new system');
  finished(dir);
  fs.cpSync(path.join(dir, F), path.join(dir, 'openspec/changes/wrap-up'), { recursive: true });
  has(checkReview(dir, 'wrap-up'), 'is named finish (or finish-v<n>), not wrap-up');
});

test('the plan is read as status.mjs reads it; archived tables are found without their usual headings', () => {
  const dir = repo();
  write(dir, 'openspec/spec-relay/plan.md', '# Capabilities\n- [x] `billing/invoice`\n');
  assert.deepEqual(checkFinishReady(dir), { ok: true, problems: [] });
  write(dir, 'openspec/changes/archive/2026-11-02-target-design/verification.md', '## 検証レベル\n| コンテキスト | A | B1 | B2 | C |\n|---|---|---|---|---|\n| billing | 必須 | 実施 | 不要 | - |\n| platform | 必須 | - | - | - |\n');
  write(dir, 'openspec/changes/archive/2026-11-01-survey/context-map.md', '### Context: platform\n\n### Context: billing\n\n## コンテキスト間のつながり\n| 上流 | 下流 | 型 | 経路 |\n|---|---|---|---|\n| platform | billing | open host | call |\n');
  const facts = collect(dir);
  assert.deepEqual(facts.levels, [{ context: 'billing', chosen: ['A', 'B1'] }, { context: 'platform', chosen: ['A'] }]);
  assert.equal(facts.relations.length, 1);
  write(dir, 'ts/empty/.keep', '');
  fs.rmSync(path.join(dir, 'ts/billing'), { recursive: true });
  fs.rmSync(path.join(dir, 'ts/empty'), { recursive: true });
  assert.ok(collect(dir).problems.some((p) => p.includes('holds no files')));
});

test('follow-ups and levels are read from their sections only', () => {
  assert.deepEqual(planFollowUps('## Capabilities\n- `a/b`\n\n## 後回しの作業\n1. バグ A\n- [ ] バグ B\n\n## Notes\n- not a follow-up\n'), ['バグ A', 'バグ B']);
  assert.deepEqual(planFollowUps('## Follow-up\n- None\n'), []);
  assert.deepEqual(chosenLevels('## Levels\n| Context | A | B1 | B2 | C |\n|---|---|---|---|---|\n| web | yes | はい | ✓ | no |\n'), [{ context: 'web', chosen: ['A', 'B1', 'B2'] }]);
});

test('draft writes checks.md and leftovers.md once, never over the orchestrator\'s files', () => {
  const dir = repo();
  write(dir, `${F}/.openspec.yaml`, 'schema: spec-relay-finish\n');
  const first = draft(dir, 'finish');
  assert.deepEqual(first.written, ['checks.md', 'leftovers.md']);
  const checks = fs.readFileSync(path.join(dir, F, 'checks.md'), 'utf8');
  assert.match(checks, new RegExp(`^Target: sha256:${targetHash(dir)}$`, 'm'));
  assert.match(checks, /\| Build \| `npm run build` \| <!-- pass \/ fail --> \| \|/);
  assert.match(checks, /\| billing \| <!-- pass \/ fail \/ not-run: reason --> \| <!-- pass \/ fail \/ not-run: reason --> \| - \| - \| \|/);
  assert.match(checks, /\| platform -> billing \| <!-- test \(call\), or none --> \|/);
  const leftovers = fs.readFileSync(path.join(dir, F, 'leftovers.md'), 'utf8');
  assert.match(leftovers, /\| L1 \| todo \| `ts\/billing\/invoice.ts:2` \| \/\/ TODO\(port\) rounding of negative totals \|/);
  assert.match(leftovers, /\| L2 \| follow-up \| billing\/invoice \| `billing\/invoice` fix the rounding bug after the port \|/);
  assert.match(leftovers, /\| L3 \| risk \| billing\/invoice \|/);
  write(dir, `${F}/leftovers.md`, '# mine\n');
  assert.deepEqual(draft(dir, 'finish').kept, ['checks.md', 'leftovers.md']);
  assert.equal(fs.readFileSync(path.join(dir, F, 'leftovers.md'), 'utf8'), '# mine\n');
  assert.equal(draft(dir, 'port-x').ok, false);
  assert.equal(draft(dir, 'finish-v2').ok, false);
});

test('the review gate of the finish change passes only when everything is accounted for', () => {
  const dir = finished(repo());
  assert.deepEqual(checkReview(dir, 'finish'), { ok: true, problems: [] });
  assert.deepEqual(nextSteps('review', checkReview(dir, 'finish'), 'ja').person, ['すべてレビュー済みです。この change を archive（確定）してよいかを答えてください。']);

  // The code changed after the checks.
  write(dir, 'ts/billing/extra.ts', 'export {};\n');
  has(checkReview(dir, 'finish'), 'the target code changed after the checks were recorded');
  fs.rmSync(path.join(dir, 'ts/billing/extra.ts'));
  assert.equal(checkReview(dir, 'finish').ok, true);

  const swap = (file, from, to) => {
    const full = path.join(dir, F, file);
    const before = fs.readFileSync(full, 'utf8');
    assert.ok(before.includes(from), `${file} has ${from}`);
    fs.writeFileSync(full, before.replace(from, to));
    const result = checkReview(dir, 'finish');
    fs.writeFileSync(full, before);
    return result;
  };
  has(swap('checks.md', '| pass (12 tests) |', '| fail |'), 'the Test command did not pass');
  has(swap('checks.md', '| Test | `npm test` | pass (12 tests) | |\n', ''), 'no row for the Test command of conventions.md');
  has(swap('checks.md', '| billing | pass | not-run', '| billing | pass | - | x'), 'context billing chose level B1');
  has(swap('checks.md', '| platform | pass | - | - | - | |\n', ''), 'no verification row for context platform');
  has(swap('checks.md', '| platform | pass |', '| platform | fail |'), 'level A of context platform failed');
  has(swap('leftovers.md', '| billing B1 |', '| billing |'), 'add a verification row "billing B1"');
  has(swap('checks.md', '| platform -> billing | none |', '| platform -> billing | |'), 'names no test for the flow platform -> billing');
  has(swap('leftovers.md', '| L5 | flow | platform -> billing |', '| L5 | flow | billing -> platform |'), 'add a flow row "platform -> billing"');
  has(swap('leftovers.md', '| L1 | todo | `ts/billing/invoice.ts:2` |', '| L1 | todo | `ts/other.ts:2` |'), 'ts/billing/invoice.ts has 1 TODO(port), and leftovers.md lists 0');
  has(swap('leftovers.md', '| L1 | todo | `ts/billing/invoice.ts:2` |', '| L1 | todo | `ts/other.ts:2` |'), 'drop the rows that were fixed');
  has(swap('leftovers.md', 'fix the rounding bug after the port | after', 'fix the rounding | after'), "the plan's follow-up item is not in leftovers.md");
  has(swap('leftovers.md', '| wont-fix | resolved |', '| maybe | resolved |'), 'class "maybe" is not one of');
  has(swap('leftovers.md', '| after-release | rare |', '| after-release | |'), 'L1 gives no reason');
  has(swap('leftovers.md', '| L3 | risk |', '| L3 | bug |'), 'kind "bug" is not one of');
  has(swap('leftovers.md', '| L3 |', '| L2 |'), 'leftovers.md has two rows L2');
  has(swap('review.md', '- [x] L3 risk - class: wont-fix\n', ''), 'leftover L3 has no review item');
  has(swap('review.md', '- [x] L5 flow', '- [x] L5 flow\n- [x] L6 extra'), 'review item L6 has no row in leftovers.md');
  has(swap('review.md', '- [x] L4', '- [ ] L4'), 'not ticked: L4');
  has(swap('handover.md', 'Migration complete against the reviewed specs; billing was not compared with the source program.', '<!-- verdict -->'), 'handover.md has no verdict');
  has(swap('checks.md', 'Target: sha256:', 'Target: '), 'checks.md records no target hash');
  // A new port opened after the checks blocks the hand-over.
  write(dir, 'openspec/changes/port-billing-invoice-v2/tasks.md', '- [ ] 1.1\n');
  has(checkReview(dir, 'finish'), 'change port-billing-invoice-v2 is still active');
});

test('status: the finish step follows the last port, and completion follows its archive', () => {
  const dir = repo();
  const lines = () => status(dir, { language: 'ja' }).todoList.map((item) => [item.title, item.status]);
  assert.deepEqual(lines(), [['全体: 1機能すべて移行済み・次は仕上げ', 'not-started'], ['仕上げ: 全体の確認・残りもの・引き渡し', 'not-started']]);
  assert.deepEqual(status(dir).current, { capability: null, step: 'finish', owner: 'agent' });
  write(dir, `${F}/.openspec.yaml`, 'schema: spec-relay-finish\n');
  write(dir, `${F}/checks.md`, '# c\n');
  assert.deepEqual(lines()[1], ['仕上げ: 全体の確認・残りもの・引き渡し【成果物 1/4】', 'in-progress']);
  finished(dir);
  fs.writeFileSync(path.join(dir, F, 'review.md'), fs.readFileSync(path.join(dir, F, 'review.md'), 'utf8').replace('- [x] L4', '- [ ] L4'));
  assert.deepEqual(lines()[1], ['仕上げ: 全体の確認・残りもの・引き渡し【引き渡しのレビュー待ち】', 'not-started']);
  assert.deepEqual(status(dir).current, { capability: null, step: 'finish', owner: 'person', waiting: true });
  finished(dir);
  assert.deepEqual(lines()[1], ['仕上げ: 全体の確認・残りもの・引き渡し【レビュー済み・承認待ち】', 'not-started']);
  fs.renameSync(path.join(dir, F), path.join(dir, 'openspec/changes/archive/2026-11-20-finish'));
  assert.deepEqual(lines(), [['全体: 移行完了（1機能・引き渡し済み）', 'completed'], ['仕上げ: 全体の確認・残りもの・引き渡し', 'completed']]);
  assert.equal(status(dir).finished, true);
  assert.equal(status(dir).current, null);
  // Code changed after the hand-over: the migration is not complete any more.
  write(dir, 'ts/billing/invoice.ts', 'changed\n');
  assert.deepEqual(lines(), [['全体: 1機能すべて移行済み・次は仕上げ', 'not-started'], ['仕上げ: 全体の確認・残りもの・引き渡し【引き渡しの後にコードが変わった・仕上げをやり直す】', 'not-started']]);
  // Before every capability is ported there is no finish line.
  const early = repo();
  fs.rmSync(path.join(early, 'openspec/changes/archive/2026-11-04-port-billing-invoice'), { recursive: true });
  assert.ok(!status(early).todoList.some((item) => item.key === 'finish'));
});

test('the hook denies archiving a finish change whose gate fails', () => {
  const dir = finished(repo());
  const shell = (command) => decide({ cwd: dir, toolName: 'powershell', toolArgs: { command } }, { pluginRoot: KIT });
  assert.equal(shell('node "C:/kit/scripts/openspec.mjs" archive finish --yes'), null);
  write(dir, 'ts/billing/extra.ts', 'export {};\n');
  assert.match(shell('node "C:/kit/scripts/openspec.mjs" archive finish --yes'), /gate.mjs review fails for finish.*target code changed/);
});

test('the review page shows each leftover with its kind, place and class', () => {
  const dir = finished(repo());
  const result = render({ root: dir, change: 'finish', now: new Date('2026-11-20T10:00:00Z') });
  assert.equal(result.ok, true, JSON.stringify(result));
  const page = fs.readFileSync(path.join(dir, 'openspec/spec-relay/views/finish.html'), 'utf8');
  assert.match(page, /仕上げレビュー/);
  assert.match(page, /残りもの/);
  assert.match(page, /実装の積み残し TODO\(port\)/);
  assert.match(page, /切替の前に直す/);
  assert.match(page, /ts\/billing\/invoice\.ts:2/);
  assert.doesNotMatch(page, /同じ id の行が leftovers\.md にありません/);
});

test('the CLI prints ASCII-only JSON and exits 0, 1 or 2', () => {
  const dir = repo();
  const run = (...args) => spawnSync(process.execPath, [path.join(KIT, 'scripts/finish.mjs'), ...args], { cwd: dir, encoding: 'utf8' });
  const ready = run('ready');
  assert.equal(ready.status, 0, ready.stderr);
  assert.match(ready.stdout, /^[\x00-\x7f]*$/);
  assert.equal(JSON.parse(ready.stdout).next.person[0].slice(0, 6), 'すべての機能');
  const collected = run('collect');
  assert.equal(JSON.parse(collected.stdout).markers.length, 1);
  assert.equal(JSON.parse(run('hash').stdout).sha256, targetHash(dir));
  assert.equal(run('draft', '--change', 'finish').status, 1);
  assert.equal(quiet(() => main(['nonsense'])), 2);
  assert.equal(quiet(() => main(['ready', '--root', tempDir()])), 2);
  write(dir, 'openspec/changes/extract-billing-other/.openspec.yaml', 'schema: spec-relay-extract\n');
  assert.equal(run('ready').status, 1);
});
