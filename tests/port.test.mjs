import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { checkPortDone, baselineHash, nextSteps, guardSave, guardCompare, targetFiles, scenarioList, conventionCommands, chosenLevels, designCommands, chainProblem, CODE_STAMP, targetHash } from '../scripts/gate.mjs';
import { verify, runCommand } from '../scripts/verify.mjs';
import { merge } from '../scripts/merge.mjs';
import { decide } from '../scripts/hook.mjs';
import { write } from './helpers.mjs';
import { PORT, PORT_CROSSCHECK, RUNS, TESTS, portRepo, receipt, crosscheck, refresh, remove } from './port-fixture.mjs';

const problems = (dir) => checkPortDone(dir, 'port-calc-add').problems;
const has = (dir, pattern) => assert.ok(problems(dir).some((p) => pattern.test(p)), `${pattern}: ${problems(dir).join(' / ')}`);
const passes = (dir) => assert.deepEqual(problems(dir), []);
const quietly = { progress: () => {} };

test('a port with a passing verify run, tagged tests and a confirmed crosscheck passes, as inferred', () => {
  const dir = portRepo();
  const result = checkPortDone(dir, 'port-calc-add');
  assert.equal(result.ok, true, result.problems.join());
  assert.deepEqual([result.levels, result.equivalence, result.followUp], [['A'], 'inferred', []]);
  assert.deepEqual(result.commands, [{ level: 'A', command: 'node test.js', from: 'conventions.md' }, { level: 'boundary', command: 'node boundary.js', from: 'conventions.md' }]);
  const ja = nextSteps('port-done', result, 'ja').person;
  assert.match(ja[1], /推定/);
  assert.match(ja[2], /実行したコマンド: A `node test.js` \(conventions.md\), 境界チェック `node boundary.js` \(conventions.md\)/);
  assert.equal(ja.length, 3);
  assert.match(nextSteps('port-done', result, 'en').person[1], /inferred/);
});

test('port-done needs a passing verify run of this change on the current code', () => {
  const dir = portRepo();
  remove(dir, `${PORT}/verify.json`);
  has(dir, /no verify\.json/);
  for (const forged of ['{ not json', 'null', '[]', '0', '{"change":"port-calc-add","runs":[null],"target":{"sha256":"x"}}', '{"runs":[],"target":{"sha256":"x"}}']) {
    write(dir, `${PORT}/verify.json`, forged);
    has(dir, /verify\.json is not a verify run of port-calc-add/);
  }
  receipt(dir, RUNS, 'port-other');
  fs.renameSync(path.join(dir, 'openspec/changes/port-other/verify.json'), path.join(dir, PORT, 'verify.json'));
  has(dir, /not a verify run of port-calc-add/);
  receipt(dir, [RUNS[0], { ...RUNS[1], exitCode: 1 }]);
  has(dir, /the boundary check failed in the last verify run \(exit code 1\)/);
  receipt(dir, [RUNS[0]]);
  has(dir, /did not run the boundary check/);
  receipt(dir, [{ ...RUNS[0], exitCode: -1, timedOut: true }, RUNS[1]]);
  has(dir, /level A failed in the last verify run \(timed out\)/);
  receipt(dir, RUNS);
  passes(dir);
  // The code changed after the run: the message names the file.
  write(dir, 'ts/calc/add.ts', 'export const add = (a, b) => a - b;\n');
  has(dir, /target code changed after the last verify run \(ts\/calc\/add\.ts\)/);
  refresh(dir);
  passes(dir);
  // A CRLF checkout of the same code keeps the hash.
  write(dir, 'ts/calc/add.ts', 'export const add = (a, b) => a - b;\r\n');
  passes(dir);
  // The Test command changed in a later target design.
  write(dir, 'openspec/changes/archive/2026-11-09-target-design-v2/conventions.md', '## Commands\n| Purpose | Command |\n|---|---|\n| Test | npm test |\n| Boundary check | node boundary.js |\n');
  write(dir, 'openspec/changes/archive/2026-11-09-target-design-v2/verification.md', '| Context | A | B1 | B2 | C |\n|---|---|---|---|---|\n| calc | yes | no | no | no |\n');
  has(dir, /level A command changed since the last verify run/);
});

test('every baseline scenario needs a tagged test, and a tag must name a baseline scenario', () => {
  const dir = portRepo();
  write(dir, 'ts/calc/add.test.ts', TESTS.replace('Negative numbers', 'Negative numbers and more'));
  refresh(dir);
  has(dir, /no test is tagged for scenario "Negative numbers" of requirement "Add two numbers"/);
  has(dir, /ts\/calc\/add\.test\.ts:2 is tagged for a scenario the baseline of calc\/add does not have/);
  // Case and spacing do not matter; comment closers may follow.
  write(dir, 'ts/calc/add.test.ts', `${TESTS.replace('Add two numbers | Negative', 'add  TWO numbers |  Negative')}\n/* spec-relay: calc/add | Reject text | Text input */\n`);
  refresh(dir);
  passes(dir);
  // A tag of another capability is not this port's business.
  write(dir, 'ts/other.test.ts', '// spec-relay: calc/sub | Subtract | Anything\n');
  refresh(dir);
  passes(dir);
});

test('a tag in a string ends at its closing quote, and documentation does not count', () => {
  const dir = portRepo();
  const spec = fs.readFileSync(path.join(dir, 'openspec/specs/calc/add/spec.md'), 'utf8').replace('#### Scenario: Text input', '#### Scenario: Input "a" is text');
  write(dir, 'openspec/specs/calc/add/spec.md', spec);
  write(dir, `${PORT}/proposal.md`, `## Baseline\n- \`calc/add\` sha256:${baselineHash(dir, 'calc/add')}\n`);
  write(dir, 'ts/calc/add.test.ts', [
    '// spec-relay: calc/add | Add two numbers | Positive numbers',
    // Another scenario whose name starts like this one does not count for it.
    'it("spec-relay: calc/add | Add two numbers | Negative numbers\' sum", () => {});',
    'it("spec-relay: calc/add | Reject text | Input \\"a\\" is text", () => {});',
  ].join('\n'));
  write(dir, 'ts/NOTES.md', '- spec-relay: calc/add | Add two numbers | Negative numbers\n');
  refresh(dir);
  has(dir, /no test is tagged for scenario "Negative numbers"/);
  assert.ok(!problems(dir).some((p) => /Input "a" is text/.test(p)), problems(dir).join(' / '));
  write(dir, 'ts/calc/neg.test.ts', "it('spec-relay: calc/add | Add two numbers | Negative numbers', () => {});\n");
  refresh(dir);
  has(dir, /add\.test\.ts:2 is tagged for a scenario the baseline of calc\/add does not have/);
  write(dir, 'ts/calc/add.test.ts', fs.readFileSync(path.join(dir, 'ts/calc/add.test.ts'), 'utf8').replace("Negative numbers' sum", 'Negative numbers'));
  refresh(dir);
  passes(dir);
});

test('who agreed is read from a Follow-up item, and placeholders or a refusal are not agreement', async () => {
  const { agreedBy } = await import('../scripts/gate.mjs');
  for (const [line, name] of [
    ['- `a` - x (agreed by Uma)', 'Uma'], ['- `a` （了承: うま）', 'うま'], ['- `a` （田中さん了承）', '田中'],
    ['- `a` (agreed by <name>)', null], ['- `a` agreed by TBD', null], ['- `a` not agreed by anyone yet', null],
    ['- `a` （了承待ち）', null], ['- `a` （了承を得ていない）', null], ['- `a` - overflow', null],
  ]) assert.equal(agreedBy(line), name, line);
});

test('a TODO(port) blocks the port until the person agrees to leave it as follow-up', () => {
  const dir = portRepo();
  write(dir, 'ts/calc/add.ts', 'export function add(a, b) {\n  // TODO(port): overflow\n  return a + b;\n}\n');
  refresh(dir);
  has(dir, /TODO\(port\) left at ts\/calc\/add\.ts:2: \/\/ TODO\(port\): overflow/);
  const proposal = fs.readFileSync(path.join(dir, PORT, 'proposal.md'), 'utf8');
  for (const notAgreed of ['<!-- - `ts/calc/add.ts` (agreed by Uma) -->', '`ts/calc/add.ts` was discussed (agreed by Uma)', '- `ts/calc/add.ts` - overflow, not agreed yet']) {
    write(dir, `${PORT}/proposal.md`, `${proposal}\n## Follow-up\n${notAgreed}\n`);
    has(dir, /TODO\(port\) left/);
  }
  write(dir, `${PORT}/proposal.md`, `${proposal}\n## 5. Follow up\n- \`calc/add.ts\` - overflow (agreed by Uma)\n`);
  const result = checkPortDone(dir, 'port-calc-add');
  assert.equal(result.ok, true, result.problems.join());
  assert.deepEqual(result.followUp, ['ts/calc/add.ts']);
  assert.match(nextSteps('port-done', result, 'ja').person.at(-1), /後の作業に回した TODO\(port\).*ts\/calc\/add\.ts/);
  // One that an earlier, archived port left counts as agreed, and is not this port's to report.
  write(dir, `${PORT}/proposal.md`, proposal);
  write(dir, 'openspec/changes/archive/2026-11-05-port-calc-base/proposal.md', '## Follow-up\n- `ts/calc/add.ts` - overflow （了承: うま）\n');
  assert.deepEqual(checkPortDone(dir, 'port-calc-add').followUp, []);
  passes(dir);
});

test('the port crosscheck needs a confirmed row per requirement and screen, merged on the current code', () => {
  const dir = portRepo();
  remove(dir, `${PORT}/crosscheck.md`);
  has(dir, /crosscheck\.md is missing/);
  crosscheck(dir, PORT_CROSSCHECK.replace('| S1 Calculator | confirmed | src/calc.php:1 vs ts/calc/page.ts:1 |\n', ''));
  has(dir, /screen has no crosscheck row: "Calculator"/);
  crosscheck(dir, PORT_CROSSCHECK.replace('| R2 Reject text | confirmed', '| R2 Reject text | mismatch'));
  has(dir, /crosscheck of requirement "Reject text" is "mismatch"; resolve it \(fix and check again\)/);
  crosscheck(dir, PORT_CROSSCHECK.replace('| R2 Reject text | confirmed', '| R2 Reject text | question Q1'));
  has(dir, /"question q1"/);
  write(dir, `${PORT}/crosscheck.md`, PORT_CROSSCHECK);
  has(dir, /crosscheck\.md has no code stamp/);
  // The code changed after the crosscheck, even with a new verify run.
  crosscheck(dir);
  write(dir, 'ts/calc/add.ts', 'export const add = (a, b) => a * b;\n');
  receipt(dir, RUNS);
  has(dir, /target code changed after the last crosscheck merge/);
});

test('merge.mjs stamps a port crosscheck with the code it was merged on, and only a port one', () => {
  const dir = portRepo();
  remove(dir, `${PORT}/crosscheck.md`);
  write(dir, 'openspec/schemas/spec-relay-port/templates/crosscheck.md', fs.readFileSync(path.join(import.meta.dirname, '../openspec-schemas/spec-relay-port/templates/crosscheck.md'), 'utf8'));
  write(dir, 'openspec/spec-relay/work/port-calc-add/crosscheck-01.md', PORT_CROSSCHECK);
  assert.equal(merge(dir, { into: `${PORT}/crosscheck.md`, parts: ['openspec/spec-relay/work/port-calc-add'], clean: true }).ok, true);
  let text = fs.readFileSync(path.join(dir, PORT, 'crosscheck.md'), 'utf8');
  assert.equal(text.match(CODE_STAMP)[1], targetHash(dir));
  passes(dir);
  // A recheck after a fix moves the stamp; there is only ever one.
  write(dir, 'ts/calc/add.ts', 'export const add = (a, b) => a + b + 0;\n');
  write(dir, 'openspec/spec-relay/work/port-calc-add/crosscheck-02.md', '| Item | Verdict | Evidence |\n|---|---|---|\n| R1 Add two numbers | confirmed | again |\n');
  assert.equal(merge(dir, { into: `${PORT}/crosscheck.md`, parts: ['openspec/spec-relay/work/port-calc-add'] }).ok, true);
  text = fs.readFileSync(path.join(dir, PORT, 'crosscheck.md'), 'utf8');
  assert.equal(text.match(new RegExp(CODE_STAMP.source, 'g')).length, 1);
  assert.match(text, /^# Crosscheck\n\n<!-- spec-relay: code checked sha256:[0-9a-f]{64} -->\n\n\| Item/);
  receipt(dir, RUNS);
  passes(dir);
  // An extract crosscheck gets no stamp.
  write(dir, 'openspec/changes/extract-calc-add/.openspec.yaml', 'schema: spec-relay-extract\n');
  write(dir, 'openspec/spec-relay/work/extract-calc-add/crosscheck-01.md', PORT_CROSSCHECK);
  assert.equal(merge(dir, { into: 'openspec/changes/extract-calc-add/crosscheck.md', parts: ['openspec/spec-relay/work/extract-calc-add'] }).ok, true);
  assert.doesNotMatch(fs.readFileSync(path.join(dir, 'openspec/changes/extract-calc-add/crosscheck.md'), 'utf8'), CODE_STAMP);
});

test('what verify runs write in the target root does not void a crosscheck merged before them', async () => {
  const dir = portRepo();
  write(dir, 'ts/test.js', 'require("fs").mkdirSync("reports", { recursive: true }); require("fs").writeFileSync("reports/TEST-add.xml", String(Date.now()));\n');
  crosscheck(dir);
  assert.equal((await verify(dir, 'port-calc-add', quietly)).ok, true);
  passes(dir);
  // Again, with nothing else changed: the report changes once more.
  assert.equal((await verify(dir, 'port-calc-add', quietly)).ok, true);
  passes(dir);
  // A change to the code itself does void it, even after another verify run.
  write(dir, 'ts/calc/add.ts', 'export const add = (a, b) => b + a;\n');
  assert.equal((await verify(dir, 'port-calc-add', quietly)).ok, true);
  has(dir, /target code changed after the last crosscheck merge/);
});

test('a chosen comparison level needs a command in design.md and a passing run', () => {
  const dir = portRepo({ levels: 'yes' });
  has(dir, /verification\.md chose B1 for context calc, but design\.md's Verification table gives it no command/);
  write(dir, `${PORT}/design.md`, '## Verification\n| Level | Covers | Command |\n|---|---|---|\n| A | all | (conventions.md\'s Test command) |\n| B1 logic comparison | totals | `node compare.js` |\n');
  has(dir, /did not run level B1/);
  receipt(dir, [...RUNS, { level: 'B1', command: 'node compare.js', exitCode: 0, seconds: 2, timedOut: false }]);
  const result = checkPortDone(dir, 'port-calc-add');
  assert.equal(result.ok, true, result.problems.join());
  assert.deepEqual([result.levels, result.equivalence], [['A', 'B1'], 'compared']);
  assert.match(nextSteps('port-done', result, 'ja').person[1], /B1/);
});

test('a design.md command that replaces the reviewed one is shown to the person', () => {
  const dir = portRepo();
  write(dir, `${PORT}/design.md`, '## Verification\n| Level | Covers | Command |\n|---|---|---|\n| A | all | `node other-test.js` |\n');
  receipt(dir, [{ ...RUNS[0], command: 'node other-test.js' }, RUNS[1]]);
  const result = checkPortDone(dir, 'port-calc-add');
  assert.equal(result.ok, true, result.problems.join());
  const person = nextSteps('port-done', result, 'en').person;
  assert.match(person.join(' '), /A `node other-test.js` \(design.md\)/);
  assert.match(person.at(-1), /For A, this port's design.md replaced the command of the reviewed conventions.md/);
});

test('levels read only yes or no, and commands must not chain', () => {
  const dir = portRepo({ levels: '要検討' });
  has(dir, /the B1 cell of context calc is "要検討"; write yes or no/);
  write(dir, 'openspec/changes/archive/2026-11-02-target-design/conventions.md', '## Commands\n| Purpose | Command |\n|---|---|\n| Test | `npm run build; npm test` |\n| Boundary check | `node boundary.js \\| Tee-Object b.log` |\n');
  has(dir, /level A: "npm run build; npm test" chains commands/);
  has(dir, /the boundary check: "node boundary.js \| Tee-Object b.log" chains commands/);
});

test('the parsers read the tables as the templates write them', () => {
  assert.deepEqual(conventionCommands('| 用途 | コマンド |\n|---|---|\n| テスト | `npm.cmd test` |\n| 境界チェック | npx depcruise src |\n'), { test: 'npm.cmd test', boundary: 'npx depcruise src' });
  const levels = (text, context = 'billing') => { const problems = []; return [chosenLevels(text, context, problems), problems]; };
  assert.deepEqual(levels('| Context | A | B1 | B2 | C |\n|---|---|---|---|---|\n| billing | yes | はい | ✅ | ✓ |\n'), [['B1', 'B2', 'C'], []]);
  assert.deepEqual(levels('| Context | A | B-1 | B2 | Ｃ |\n|---|---|---|---|---|\n| billing | yes | yes | no | yes |\n'), [['B1', 'C'], []]);
  assert.match(levels('| Context | A | B1 | B2 | C |\n|---|---|---|---|---|\n| billing | yes | <!-- yes / no --> | x | no |\n')[1].join(' / '), /B1 cell of context billing is empty.*B2 cell of context billing is "x"/);
  assert.match(levels('| Context | A | B1 |\n|---|---|---|\n| billing | yes | no |\n')[1].join(), /no B2 column/);
  assert.deepEqual(levels('| Context | A | Logic comparison (B1) | B2 | C screenshots |\n|---|---|---|---|---|\n| billing | yes | あり | 不要 | - |\n'), [['B1'], []]);
  // A table without level columns (the modules) is not the levels table.
  assert.deepEqual(levels('| Context | Module |\n|---|---|\n| billing | ts/billing |\n\n| Context | B1 | B2 | C |\n|---|---|---|---|\n| billing | no | no | yes |\n'), [['C'], []]);
  assert.equal(levels('| Context | A | B1 | B2 | C |\n|---|---|---|---|---|\n| billing | yes | no | no | no |\n', 'calc')[0], null);
  assert.match(levels('| Context | B1 | B2 | C |\n|---|---|---|---|\n| billing | 必要なし | no | no |\n')[1].join(), /"必要なし"; write yes or no/);
  assert.deepEqual(designCommands('| Level | Covers | Command |\n|---|---|---|\n| A | all | `mvn -q test` |\n| C screenshots | screens | - |\n| Boundary check | modules | `mvn -q verify -Pboundary` |\n'), { A: 'mvn -q test', boundary: 'mvn -q verify -Pboundary' });
  assert.deepEqual(scenarioList('### Requirement: R\nx\n#### Scenario: a\n```\n#### Scenario: fenced\n```\n## Other\n#### Scenario: orphan\n'), [{ requirement: 'R', scenario: 'a' }]);
  assert.equal(chainProblem('mvn -q test "-Dtest=A|B"'), null);
  assert.equal(chainProblem('dotnet test --filter "A;B"'), null);
  assert.match(chainProblem('npm ci && npm test'), /&&/);
  assert.match(chainProblem('npm test & exit 0'), /background/);
  assert.equal(chainProblem('& "C:/Program Files/dotnet/dotnet.exe" test'), null);
  assert.match(chainProblem('cmd /c "a & b"'), /another shell/);
  assert.match(chainProblem('sh -c "a; exit 0"'), /another shell/);
  assert.match(chainProblem('$env:CI="1"; npm test'), /chains/);
  assert.equal(chainProblem('find . -name "*.ts" -exec cat {} \\;'), null);
  assert.equal(chainProblem('npm test # then; nothing'), null);
});

test('verify.mjs runs the commands in the target root and writes the receipt the gate reads', async () => {
  const dir = portRepo();
  remove(dir, `${PORT}/verify.json`);
  const lines = [];
  let result = await verify(dir, 'port-calc-add', { progress: (line) => lines.push(line) });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.deepEqual(result.runs.map((r) => [r.level, r.command, r.from, r.exitCode]), [['A', 'node test.js', 'conventions.md', 0], ['boundary', 'node boundary.js', 'conventions.md', 0]]);
  assert.match(lines[0], /^A \(conventions.md\): node test.js$/);
  const saved = JSON.parse(fs.readFileSync(path.join(dir, PORT, 'verify.json'), 'utf8'));
  assert.deepEqual([saved.change, saved.capability, saved.target.count], ['port-calc-add', 'calc/add', Object.keys(saved.target.files).length]);
  passes(dir);
  // A failing command: the gate fails, later levels do not run, and the output's
  // last lines are printed, not saved.
  write(dir, 'ts/test.js', 'console.error("expected 3, got 4"); process.exit(3);\n');
  result = await verify(dir, 'port-calc-add', quietly);
  assert.equal(result.ok, false);
  assert.deepEqual(result.runs.map((r) => r.exitCode), [3]);
  assert.match(result.runs[0].tail, /expected 3, got 4/);
  assert.match(result.problems.join(), /not run after that failure: boundary/);
  assert.doesNotMatch(fs.readFileSync(path.join(dir, PORT, 'verify.json'), 'utf8'), /expected 3/);
  has(dir, /level A failed in the last verify run \(exit code 3\)/);
});

test('verify.mjs stops a command that runs too long, with what it started', async () => {
  const dir = portRepo();
  write(dir, 'ts/test.js', 'require("child_process").spawn(process.execPath, ["-e", "setTimeout(() => {}, 60000)"], { stdio: "inherit" }); setTimeout(() => {}, 60000);\n');
  const started = Date.now();
  const result = await verify(dir, 'port-calc-add', { timeoutMs: 1500, ...quietly });
  assert.ok(Date.now() - started < 20000);
  assert.equal(result.ok, false);
  assert.deepEqual([result.runs[0].exitCode, result.runs[0].timedOut], [-1, true]);
  has(dir, /level A failed in the last verify run \(timed out\)/);
});

test('verify.mjs goes on when the command exits, even if what it started keeps the output open', async () => {
  const dir = portRepo();
  // It runs outside the repository: Windows cannot delete a folder that is a
  // running process's working directory.
  write(dir, 'ts/test.js', 'require("child_process").spawn(process.execPath, ["-e", "setTimeout(() => {}, 15000)"], { stdio: "inherit", detached: true, cwd: require("os").tmpdir() }).unref();\n');
  const started = Date.now();
  const result = await verify(dir, 'port-calc-add', quietly);
  assert.ok(Date.now() - started < 12000, `${Date.now() - started} ms`);
  assert.equal(result.ok, true, JSON.stringify(result));
});

test('verify.mjs refuses what it cannot run', async () => {
  const dir = portRepo();
  assert.match((await verify(dir, 'port-nothing', quietly)).problems.join(), /change not found/);
  write(dir, 'openspec/changes/extract-calc-add/.openspec.yaml', 'schema: spec-relay-extract\n');
  assert.match((await verify(dir, 'extract-calc-add', quietly)).problems.join(), /not a port change/);
  write(dir, 'openspec/changes/archive/2026-11-02-target-design/conventions.md', '# none\n');
  assert.match((await verify(dir, 'port-calc-add', quietly)).problems.join(), /names no Test command/);
});

test('on Windows the commands run in Windows PowerShell for this process only, with UTF-8 output', async () => {
  const calls = [];
  const exec = (file, args, options) => {
    calls.push([file, args, options.cwd]);
    const child = { pid: 1, stdout: { on() {} }, stderr: { on() {} }, on(event, fn) { if (event === 'exit' || event === 'close') setImmediate(() => fn(0)); } };
    return child;
  };
  const result = await runCommand('npm test', 'C:/repo/ts', { platform: 'win32', exec });
  assert.equal(result.exitCode, 0);
  assert.deepEqual(calls[0], ['powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', '[Console]::OutputEncoding = [Text.Encoding]::UTF8; npm test; $ok = $?; if ($LASTEXITCODE) { exit $LASTEXITCODE }; if (-not $ok) { exit 1 }'], 'C:/repo/ts']);
});

test('in a git repository, files git ignores are not target code, and a nested repository is read from disk', { skip: spawnSync('git', ['--version']).status !== 0 && 'git not found' }, () => {
  const dir = portRepo();
  spawnSync('git', ['init', '-q'], { cwd: dir });
  write(dir, '.gitignore', 'node_modules/\n');
  write(dir, 'ts/node_modules/x/index.js', 'x\n');
  write(dir, 'ts/coverage.txt', 'y\n');
  let files = targetFiles(dir);
  assert.ok(files.includes('ts/coverage.txt'));
  assert.ok(!files.some((f) => f.includes('node_modules')));
  assert.ok(!files.some((f) => f.startsWith('src/') || f.startsWith('openspec/')));
  spawnSync('git', ['init', '-q'], { cwd: path.join(dir, 'ts') });
  write(dir, 'ts/.gitignore', 'bin/\n');
  write(dir, 'ts/bin/out.dll', 'x\n');
  files = targetFiles(dir);
  assert.ok(files.includes('ts/calc/add.ts'), files.join());
  assert.ok(!files.includes('ts/bin/out.dll'), files.join());
  refresh(dir);
  passes(dir);
});

test('without git, build folders right under the target root are skipped, but not deeper', () => {
  const dir = portRepo();
  write(dir, 'ts/dist/add.js', 'x\n');
  write(dir, 'ts/calc/build/pipeline.ts', '// TODO(port): later\n');
  const files = targetFiles(dir);
  assert.ok(!files.includes('ts/dist/add.js'));
  refresh(dir);
  has(dir, /TODO\(port\) left at ts\/calc\/build\/pipeline\.ts:1/);
});

test('a UTF-16 target file is reported, not skipped', () => {
  const dir = portRepo();
  fs.writeFileSync(path.join(dir, 'ts/calc/more.test.ts'), Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('// TODO(port)\n', 'utf16le')]));
  refresh(dir);
  has(dir, /ts\/calc\/more\.test\.ts is UTF-16/);
});

test('the guard and the hook keep subagents away from the evidence', () => {
  const dir = portRepo();
  assert.equal(guardSave(dir, 'wave-1').ok, true);
  write(dir, `${PORT}/verify.json`, '{}\n');
  write(dir, `${PORT}/crosscheck.md`, '# forged\n');
  write(dir, `${PORT}/design.md`, '# forged\n');
  assert.deepEqual(guardCompare(dir, 'wave-1').changed, [`${PORT}/crosscheck.md`, `${PORT}/design.md`, `${PORT}/verify.json`]);
  write(dir, 'openspec/config.yaml', `${fs.readFileSync(path.join(dir, 'openspec/config.yaml'), 'utf8')}  Hook enforcement (on or off): on\n`);
  const shell = (command) => decide({ toolName: 'powershell', toolArgs: { command }, cwd: dir });
  assert.match(shell(`Set-Content ${PORT}/verify.json 'null'`), /only verify\.mjs writes verify\.json/);
  assert.match(shell(`node -e "require('fs').writeFileSync('${PORT}/verify.json','{}')"`), /only verify\.mjs writes/);
  assert.equal(shell('node "C:/kit/scripts/verify.mjs" --change port-calc-add'), null);
  assert.match(shell(`[System.IO.File]::WriteAllText("${PORT}/verify.json", "{}")`), /only verify\.mjs writes/);
  assert.match(shell(`python -c "open('${PORT}/verify.json','w').write('{}')"`), /only verify\.mjs writes/);
  assert.match(shell(`Copy-Item forged.json ${PORT}/verify.json`), /only verify\.mjs writes/);
  // Reading it, or naming it in a message, is fine.
  assert.equal(shell(`cat ${PORT}/verify.json 2>/dev/null`), null);
  assert.equal(shell(`Get-Content ${PORT}/verify.json > $null`), null);
  assert.equal(shell('git commit -m "record verify.json" > $null'), null);
  const edit = (file) => decide({ toolName: 'edit', toolArgs: { path: file }, cwd: dir, agentId: 'a1', agentType: 'spec-relay-implementer' });
  assert.match(edit(path.join(dir, PORT, 'design.md')), /only the orchestrator writes/);
  assert.match(edit(path.join(dir, PORT, 'proposal.md')), /only the orchestrator writes/);
  assert.equal(edit(path.join(dir, PORT, 'tasks.md')), null);
});
