import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { checkPortDone, nextSteps, guardSave, guardCompare, targetFiles, scenarioList, conventionCommands, chosenLevels, designCommands } from '../scripts/gate.mjs';
import { verify, runCommand } from '../scripts/verify.mjs';
import { write } from './helpers.mjs';
import { PORT, PORT_CROSSCHECK, RUNS, TESTS, portRepo, receipt, remove } from './port-fixture.mjs';

const problems = (dir) => checkPortDone(dir, 'port-calc-add').problems;
const has = (dir, pattern) => assert.ok(problems(dir).some((p) => pattern.test(p)), `${pattern}: ${problems(dir).join(' / ')}`);

test('a port with a passing verify run, tagged tests and a confirmed crosscheck passes, as inferred', () => {
  const dir = portRepo();
  const result = checkPortDone(dir, 'port-calc-add');
  assert.deepEqual(result, { ok: true, problems: [], levels: ['A'], equivalence: 'inferred' });
  const ja = nextSteps('port-done', result, 'ja').person;
  assert.equal(ja.length, 2);
  assert.match(ja[1], /推定/);
  assert.match(nextSteps('port-done', result, 'en').person[1], /inferred/);
});

test('port-done needs a passing verify run on the current code', () => {
  const dir = portRepo();
  remove(dir, `${PORT}/verify.json`);
  has(dir, /no verify\.json/);
  write(dir, `${PORT}/verify.json`, '{ not json');
  has(dir, /not valid JSON/);
  receipt(dir, [RUNS[0], { ...RUNS[1], exitCode: 1 }]);
  has(dir, /the boundary check failed in the last verify run \(exit code 1\)/);
  receipt(dir, [RUNS[0]]);
  has(dir, /did not run the boundary check/);
  receipt(dir, [{ ...RUNS[0], exitCode: -1, timedOut: true }, RUNS[1]]);
  has(dir, /level A failed in the last verify run \(timed out\)/);
  receipt(dir, RUNS);
  assert.equal(checkPortDone(dir, 'port-calc-add').ok, true);
  // The code changed after the run.
  write(dir, 'ts/calc/add.ts', 'export const add = (a, b) => a - b;\n');
  has(dir, /target code changed after the last verify run/);
  receipt(dir, RUNS);
  assert.equal(checkPortDone(dir, 'port-calc-add').ok, true);
  // A CRLF checkout of the same code keeps the hash.
  write(dir, 'ts/calc/add.ts', 'export const add = (a, b) => a - b;\r\n');
  assert.equal(checkPortDone(dir, 'port-calc-add').ok, true);
  // The Test command changed in a later target design.
  write(dir, 'openspec/changes/archive/2026-11-09-target-design-v2/conventions.md', '## Commands\n| Purpose | Command |\n|---|---|\n| Test | npm test |\n| Boundary check | node boundary.js |\n');
  write(dir, 'openspec/changes/archive/2026-11-09-target-design-v2/verification.md', '| Context | A | B1 | B2 | C |\n|---|---|---|---|---|\n| calc | yes | no | no | no |\n');
  has(dir, /level A command changed since the last verify run/);
});

test('every baseline scenario needs a tagged test, and a tag must name a baseline scenario', () => {
  const dir = portRepo();
  write(dir, 'ts/calc/add.test.ts', TESTS.replace('Negative numbers', 'Negative numbers and more'));
  receipt(dir, RUNS);
  has(dir, /no test is tagged for scenario "Negative numbers" of requirement "Add two numbers"/);
  has(dir, /ts\/calc\/add\.test\.ts:2 is tagged for a scenario the baseline of calc\/add does not have/);
  // Case, spacing and the string or comment closers after the name do not matter.
  write(dir, 'ts/calc/add.test.ts', `${TESTS.replace('Add two numbers | Negative', 'add  TWO numbers |  Negative')} */\n`);
  receipt(dir, RUNS);
  assert.equal(checkPortDone(dir, 'port-calc-add').ok, true);
  // A tag of another capability is not this port's business.
  write(dir, 'ts/other.test.ts', '// spec-relay: calc/sub | Subtract | Anything\n');
  receipt(dir, RUNS);
  assert.equal(checkPortDone(dir, 'port-calc-add').ok, true);
});

test('a TODO(port) blocks the port until the person agrees to leave it as follow-up', () => {
  const dir = portRepo();
  write(dir, 'ts/calc/add.ts', 'export function add(a, b) {\n  // TODO(port): overflow\n  return a + b;\n}\n');
  receipt(dir, RUNS);
  has(dir, /TODO\(port\) left at ts\/calc\/add\.ts:2: \/\/ TODO\(port\): overflow/);
  const proposal = fs.readFileSync(path.join(dir, PORT, 'proposal.md'), 'utf8');
  write(dir, `${PORT}/proposal.md`, `${proposal}\n## Follow-up\n<!-- - \`ts/calc/add.ts\` -->\n`);
  has(dir, /TODO\(port\) left/);
  write(dir, `${PORT}/proposal.md`, `${proposal}\n## Follow-up\n- \`ts/calc/add.ts\` - overflow (agreed by Uma)\n`);
  assert.equal(checkPortDone(dir, 'port-calc-add').ok, true);
  // One that an earlier, archived port left counts as agreed.
  write(dir, `${PORT}/proposal.md`, proposal);
  write(dir, 'openspec/changes/archive/2026-11-05-port-calc-base/proposal.md', '## Follow-up\n- `ts/calc/add.ts` - overflow (agreed by Uma)\n');
  assert.equal(checkPortDone(dir, 'port-calc-add').ok, true);
});

test('the port crosscheck needs a confirmed row per requirement and screen', () => {
  const dir = portRepo();
  remove(dir, `${PORT}/crosscheck.md`);
  has(dir, /crosscheck\.md is missing/);
  write(dir, `${PORT}/crosscheck.md`, PORT_CROSSCHECK.replace('| S1 Calculator | confirmed | src/calc.php:1 vs ts/calc/page.ts:1 |\n', ''));
  has(dir, /screen has no crosscheck row: "Calculator"/);
  write(dir, `${PORT}/crosscheck.md`, PORT_CROSSCHECK.replace('| R2 Reject text | confirmed', '| R2 Reject text | mismatch'));
  has(dir, /crosscheck of requirement "Reject text" is "mismatch"; resolve it \(fix and check again\)/);
  write(dir, `${PORT}/crosscheck.md`, PORT_CROSSCHECK.replace('| R2 Reject text | confirmed', '| R2 Reject text | question Q1'));
  has(dir, /"question q1"/);
});

test('a chosen comparison level needs a command in design.md and a passing run', () => {
  const dir = portRepo({ levels: 'yes' });
  has(dir, /verification\.md chose B1 for context calc, but design\.md's Verification table gives it no command/);
  write(dir, `${PORT}/design.md`, '## Verification\n| Level | Covers | Command |\n|---|---|---|\n| A | all | |\n| B1 logic comparison | totals | `node compare.js` |\n');
  has(dir, /did not run level B1/);
  receipt(dir, [...RUNS, { level: 'B1', command: 'node compare.js', exitCode: 0, seconds: 2, timedOut: false }]);
  const result = checkPortDone(dir, 'port-calc-add');
  assert.equal(result.ok, true, result.problems.join());
  assert.deepEqual([result.levels, result.equivalence], [['A', 'B1'], 'compared']);
  assert.match(nextSteps('port-done', result, 'ja').person[1], /B1/);
});

test('the parsers read the tables as the templates write them', () => {
  assert.deepEqual(conventionCommands('| 用途 | コマンド |\n|---|---|\n| テスト | `npm.cmd test` |\n| 境界チェック | npx depcruise src |\n'), { test: 'npm.cmd test', boundary: 'npx depcruise src' });
  assert.deepEqual(chosenLevels('| Context | A | B1 | B2 | C |\n|---|---|---|---|---|\n| billing | yes | はい | no | ✓ |\n', 'billing'), ['B1', 'C']);
  assert.equal(chosenLevels('| Context | A | B1 |\n|---|---|---|\n| billing | yes | no |\n', 'calc'), null);
  assert.deepEqual(designCommands('| Level | Covers | Command |\n|---|---|---|\n| A | all | `mvn -q test` |\n| C screenshots | screens | |\n| Boundary check | modules | `mvn -q verify -Pboundary` |\n'), { A: 'mvn -q test', boundary: 'mvn -q verify -Pboundary' });
  assert.deepEqual(scenarioList('### Requirement: R\nx\n#### Scenario: a\n```\n#### Scenario: fenced\n```\n## Other\n#### Scenario: orphan\n'), [{ requirement: 'R', scenario: 'a' }]);
});

test('verify.mjs runs the commands in the target root and writes the receipt the gate reads', () => {
  const dir = portRepo();
  remove(dir, `${PORT}/verify.json`);
  let result = verify(dir, 'port-calc-add');
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.deepEqual(result.runs.map((r) => [r.level, r.command, r.exitCode]), [['A', 'node test.js', 0], ['boundary', 'node boundary.js', 0]]);
  const saved = JSON.parse(fs.readFileSync(path.join(dir, PORT, 'verify.json'), 'utf8'));
  assert.equal(saved.capability, 'calc/add');
  assert.equal(JSON.stringify(saved).includes('tail'), false);
  assert.equal(checkPortDone(dir, 'port-calc-add').ok, true);
  // A failing command: the gate fails, and the output's last lines are printed, not saved.
  write(dir, 'ts/boundary.js', 'console.error("module calc reaches into billing"); process.exit(3);\n');
  result = verify(dir, 'port-calc-add');
  assert.equal(result.ok, false);
  assert.equal(result.runs[1].exitCode, 3);
  assert.match(result.runs[1].tail, /reaches into billing/);
  assert.doesNotMatch(fs.readFileSync(path.join(dir, PORT, 'verify.json'), 'utf8'), /reaches into/);
  has(dir, /the boundary check failed in the last verify run \(exit code 3\)/);
});

test('verify.mjs refuses what it cannot run', () => {
  const dir = portRepo();
  assert.match(verify(dir, 'port-nothing').problems.join(), /change not found/);
  write(dir, 'openspec/changes/extract-calc-add/.openspec.yaml', 'schema: spec-relay-extract\n');
  assert.match(verify(dir, 'extract-calc-add').problems.join(), /not a port change/);
  write(dir, 'openspec/changes/archive/2026-11-02-target-design/conventions.md', '# none\n');
  assert.match(verify(dir, 'port-calc-add').problems.join(), /names no Test command/);
});

test('on Windows the commands run in Windows PowerShell for this process only', () => {
  const calls = [];
  const exec = (file, args, options) => { calls.push([file, args, options.cwd]); return { status: 0, stdout: '', stderr: '' }; };
  runCommand('npm test', 'C:/repo/ts', { platform: 'win32', exec });
  assert.deepEqual(calls[0], ['powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', 'npm test'], 'C:/repo/ts']);
  const timedOut = runCommand('x', '.', { platform: 'linux', timeoutMs: 5, exec: () => ({ status: null, signal: 'SIGTERM', error: Object.assign(new Error('t'), { code: 'ETIMEDOUT' }) }) });
  assert.deepEqual([timedOut.exitCode, timedOut.timedOut], [-1, true]);
});

test('in a git repository, files git ignores are not target code', { skip: spawnSync('git', ['--version']).status !== 0 && 'git not found' }, () => {
  const dir = portRepo();
  spawnSync('git', ['init', '-q'], { cwd: dir });
  write(dir, '.gitignore', 'node_modules/\n');
  write(dir, 'ts/node_modules/x/index.js', 'x\n');
  write(dir, 'ts/coverage.txt', 'y\n');
  const files = targetFiles(dir);
  assert.ok(files.includes('ts/coverage.txt'));
  assert.ok(!files.some((f) => f.includes('node_modules')));
  assert.ok(!files.some((f) => f.startsWith('src/') || f.startsWith('openspec/')));
});

test('the guard covers the verify receipt and the crosscheck', () => {
  const dir = portRepo();
  assert.equal(guardSave(dir, 'wave-1').ok, true);
  write(dir, `${PORT}/verify.json`, '{}\n');
  write(dir, `${PORT}/crosscheck.md`, '# forged\n');
  assert.deepEqual(guardCompare(dir, 'wave-1').changed, [`${PORT}/crosscheck.md`, `${PORT}/verify.json`]);
});
