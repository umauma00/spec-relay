import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { parseE2eOptions, e2eCommandOptions, selectorProblems, e2eDigest, reportTests, testProblems, recordOld, runNew, runE2eCommand, oldReceipt, init, isE2eCommand, OLD_RECEIPT } from '../scripts/e2e.mjs';
import { checkPortDone, nextSteps, verifyPlan, designScenarioChecks, scenarioList, guardFiles } from '../scripts/gate.mjs';
import { verify, runLevel } from '../scripts/verify.mjs';
import { runCommand } from '../scripts/run.mjs';
import { decide } from '../scripts/hook.mjs';
import { tempDir, write } from './helpers.mjs';
import { PORT, PORT_SPEC, checksTable, crosscheck, portRepo } from './port-fixture.mjs';

const KIT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const node = (args) => `node ${args}`;

function freePort() {
  return new Promise((resolve) => {
    const probe = http.createServer();
    probe.listen(0, '127.0.0.1', () => { const { port } = probe.address(); probe.close(() => resolve(port)); });
  });
}

// A system under test: answers every request until it is stopped.
const SERVER = "require('http').createServer((q, r) => r.end('ok')).listen(Number(process.argv[2]), '127.0.0.1');\n";

const TAGS = {
  pos: 'spec-relay: calc/add | Add two numbers | Positive numbers',
  neg: 'spec-relay: calc/add | Add two numbers | Negative numbers',
  text: 'spec-relay: calc/add | Reject text | Text input',
};

// Stands in for Playwright: reads the titles of the capability's *.e2e.mjs
// files, writes the JSON report e2e.mjs reads, and on the old run (screenshots
// updated) writes one screenshot per test file. `outcome(side, title)` decides
// each test's result.
function fakePlaywright(outcome = () => 'passed', calls = []) {
  return async (argv, cwd, { env }) => {
    calls.push({ argv, cwd, env });
    if (!Array.isArray(argv)) return { exitCode: 0, timedOut: false, seconds: 0, output: '' };
    const specs = [];
    for (const f of fs.readdirSync(env.SPEC_RELAY_E2E_TEST_DIR).filter((x) => x.endsWith('.e2e.mjs'))) {
      const text = fs.readFileSync(path.join(env.SPEC_RELAY_E2E_TEST_DIR, f), 'utf8');
      text.split('\n').forEach((line, i) => {
        const m = line.match(/test\('([^']+)'/);
        if (!m) return;
        const status = outcome(env.SPEC_RELAY_SIDE, m[1]);
        specs.push({ title: m[1], file: f, line: i + 1, tests: [{ projectName: '', status: status === 'passed' ? 'expected' : status === 'skipped' ? 'skipped' : 'unexpected', results: [{ status, ...(status === 'failed' ? { error: { message: '\u001b[31mexpect(locator).toBeVisible() failed\u001b[39m\nLocator: getByText(\'結果: 3\')' } } : {}) }] }] });
      });
      if (env.SPEC_RELAY_E2E_UPDATE === 'all') write(env.SPEC_RELAY_E2E_TEST_DIR, `screenshots/${f}/result.png`, `png from ${env.SPEC_RELAY_SIDE}`);
    }
    fs.mkdirSync(path.dirname(env.SPEC_RELAY_E2E_REPORT), { recursive: true });
    fs.writeFileSync(env.SPEC_RELAY_E2E_REPORT, JSON.stringify({ config: { projects: [{ name: '' }] }, suites: [{ title: 'x', file: 'x', specs }], errors: [] }));
    return { exitCode: specs.every((s) => s.tests[0].status === 'expected') ? 0 : 1, timedOut: false, seconds: 1, output: '' };
  };
}

// The port repository of the gate tests with screen tests for two scenarios:
// B2 (and C) chosen, the e2e folder installed (a stand-in for Playwright).
async function screenRepo({ c = 'no', cCommand = false } = {}) {
  const port = await freePort();
  const command = `spec-relay-e2e --base http://127.0.0.1:${port} --start '${node('server.cjs')} ${port}'`;
  const rows = `| B2 screen tests | the calculator | \`${command}\` |\n${cCommand ? `| C screenshots | the calculator | \`${command}\` |\n` : ''}`;
  const dir = portRepo({ designCommand: rows + checksTable(['e2e', 'e2e', 'unit']) });
  write(dir, 'openspec/changes/archive/2026-11-02-target-design/verification.md', `## Levels\n| Context | A scenario tests | B1 logic comparison | B2 screen tests | C screenshots | Notes |\n|---|---|---|---|---|---|\n| calc | yes | no | yes | ${c} | |\n`);
  write(dir, 'ts/server.cjs', SERVER);
  write(dir, 'ts/tests/e2e/package.json', '{"private":true}\n');
  write(dir, 'ts/tests/e2e/node_modules/@playwright/test/cli.js', '// stand-in\n');
  write(dir, 'ts/tests/e2e/calc-add/add.e2e.mjs', `import { test } from '@playwright/test';\ntest('${TAGS.pos}', async ({ page }) => {\n  await page.getByLabel('A').fill('1');\n});\ntest('${TAGS.neg}', async ({ page }) => {});\n`);
  crosscheck(dir);
  return { dir, port, command };
}

const quietly = { progress: () => {} };
const withFake = (fake) => (command, cwd, options) => (isE2eCommand(command) ? runE2eCommand(command, cwd, { ...options, run: fake }) : runLevel(command, cwd, options));
const problems = (dir) => checkPortDone(dir, 'port-calc-add').problems;

test('the options of the old run and of a port command', () => {
  assert.match(parseE2eOptions(['--base', 'http://localhost:3000'], 'port').problem, /needs --start/);
  assert.match(parseE2eOptions(['--base', 'http://localhost:3000', '--start', 'npm start', '--allow-host', 'x'], 'port').problem, /--allow-host is not allowed in a port command/);
  assert.match(parseE2eOptions(['--base', 'http://test.example:80', '--start', 'npm start'], 'port').problem, /not this machine/);
  assert.match(parseE2eOptions(['--base', 'http://localhost:3000', '--start', 'npm run build; npm start'], 'port').problem, /the --start command .*chains|the --start command/);
  assert.match(parseE2eOptions(['--base', 'http://localhost:3000', '--start', 'x', '--wait-seconds', 'soon'], 'port').problem, /not a number of seconds/);
  assert.equal(parseE2eOptions(['--base', 'http://localhost:3000', '--start', 'npm --silent start', '--reset', 'node reset.mjs'], 'port').url.origin, 'http://localhost:3000');
  assert.match(parseE2eOptions(['--base', 'http://localhost:8080'], 'old').problem, /old needs --change/);
  // Only the person names another host, and only for the old run.
  assert.equal(parseE2eOptions(['--change', 'port-x', '--base', 'http://test-old:8080', '--allow-host', 'test-old'], 'old').url.hostname, 'test-old');
  assert.match(e2eCommandOptions("spec-relay-e2e --base http://localhost:3000 --start 'npm start").problem, /unclosed quote/);
  assert.equal(isE2eCommand("spec-relay-e2e --base x"), true);
  assert.equal(isE2eCommand('npx playwright test'), false);
});

test('screen tests find elements as a user does, not by ids, classes or test ids', () => {
  const dir = tempDir();
  write(dir, 'a.e2e.mjs', [
    "await page.getByRole('button', { name: '登録' }).click();",
    "await page.getByLabel('数量').fill('3');",
    "await page.locator('#ctl00_Main_txtQty').fill('3');",
    "await page.locator(\".btn-primary\").click();",
    "await page.getByTestId('save').click();",
    "await page.locator('input[id=qty]').fill('1');",
    "await page.locator('//div[@id=\"x\"]').click();",
    "await page.$('#x');",
    "// page.locator('#ok-in-a-comment')",
    "await page.locator('table').getByRole('row', { name: '山田' }).click();",
    "await page.locator('input[name=\"qty\"]').fill('1');",
  ].join('\n'));
  write(dir, 'helper.mjs', "page.locator('#not-a-test-file');\n");
  const found = selectorProblems(dir);
  assert.deepEqual(found.map((p) => p.split(' uses ')[0]), ['a.e2e.mjs:3', 'a.e2e.mjs:4', 'a.e2e.mjs:5', 'a.e2e.mjs:6', 'a.e2e.mjs:7', 'a.e2e.mjs:8']);
  assert.match(found[0], /getByRole, getByLabel, getByText/);
});

test('the e2e hash covers tests and screenshots, reads CRLF as LF and skips installed packages', () => {
  const dir = tempDir();
  write(dir, 'tests/e2e/calc-add/add.e2e.mjs', "test('x', () => {});\n");
  write(dir, 'tests/e2e/calc-add/screenshots/add.e2e.mjs/a.png', 'png');
  write(dir, 'tests/e2e/other/screenshots/b.e2e.mjs/b.png', 'png');
  const first = e2eDigest(dir, 'calc/add');
  assert.equal(first.screenshots, 1);
  write(dir, 'tests/e2e/calc-add/add.e2e.mjs', "test('x', () => {});\r\n");
  write(dir, 'tests/e2e/node_modules/@playwright/test/cli.js', 'x');
  assert.equal(e2eDigest(dir, 'calc/add').sha256, first.sha256);
  write(dir, 'tests/e2e/calc-add/screenshots/add.e2e.mjs/a.png', 'other png');
  assert.notEqual(e2eDigest(dir, 'calc/add').sha256, first.sha256);
});

test('a report test passes only when it passed at its only try', () => {
  const report = { suites: [{ specs: [], suites: [{ specs: [
    { title: TAGS.pos, file: 'a.e2e.mjs', line: 3, tests: [{ projectName: 'edge', status: 'expected', results: [{ status: 'passed' }] }] },
    { title: TAGS.neg, file: 'a.e2e.mjs', line: 9, tests: [{ status: 'skipped', results: [{ status: 'skipped' }] }] },
    { title: TAGS.text, file: 'a.e2e.mjs', line: 12, tests: [{ status: 'flaky', results: [{ status: 'failed' }, { status: 'passed' }] }] },
    { title: 'expected to fail', file: 'a.e2e.mjs', line: 15, tests: [{ status: 'expected', results: [{ status: 'failed' }] }] },
  ] }] }] };
  const tests = reportTests(report);
  assert.deepEqual(tests.map((t) => [t.line, t.passed, t.status]), [[3, true, 'passed'], [9, false, 'skipped'], [12, false, 'passed'], [15, false, 'failed']]);
  assert.equal(tests[0].project, 'edge');
  const scenarios = scenarioList(PORT_SPEC);
  const found = testProblems(tests, 'calc/add', scenarios);
  assert.deepEqual(found.length, 1);
  assert.match(found[0], /a\.e2e\.mjs:15 "expected to fail": a screen test's title is the tag of its scenario/);
  assert.match(testProblems([{ title: 'spec-relay: calc/add | Add two numbers | Zero', file: 'a', line: 1 }], 'calc/add', scenarios)[0], /names no scenario of the baseline/);
  assert.deepEqual(testProblems([], 'calc/add', scenarios), ['no test ran']);
});

test('the old run proves the tests on the old system and records them, and only then', async () => {
  const { dir, port } = await screenRepo();
  const old = http.createServer((q, r) => r.end('old')).listen(0, '127.0.0.1');
  await new Promise((resolve) => { old.once('listening', resolve); });
  const base = `http://127.0.0.1:${old.address().port}`;
  const opts = (extra = []) => parseE2eOptions(['--change', 'port-calc-add', '--base', base, ...extra], 'old');
  try {
    // A test that fails on the old system is wrong: nothing is recorded.
    let result = await recordOld(dir, opts(), { run: fakePlaywright((side, title) => (title === TAGS.neg ? 'failed' : 'passed')) });
    assert.equal(result.ok, false);
    assert.match(result.lines.join('\n'), /failed on the old system[\s\S]*Negative numbers": failed\n {4}expect\(locator\)\.toBeVisible\(\) failed/);
    assert.equal(fs.existsSync(path.join(dir, PORT, OLD_RECEIPT)), false);
    // A skipped test is not a passed test.
    result = await recordOld(dir, opts(), { run: fakePlaywright((side, title) => (title === TAGS.neg ? 'skipped' : 'passed')) });
    assert.equal(result.ok, false);
    const calls = [];
    result = await recordOld(dir, opts(), { run: fakePlaywright(() => 'passed', calls) });
    assert.equal(result.ok, true, result.problems.join());
    assert.match(result.lines[0], /2 tests passed on the old system at http:\/\/127\.0\.0\.1:\d+ \(2 scenarios, 1 screenshots taken\)/);
    const env = calls.at(-1).env;
    assert.deepEqual([env.SPEC_RELAY_SIDE, env.SPEC_RELAY_E2E_UPDATE, env.SPEC_RELAY_BASE_URL], ['old', 'all', base]);
    assert.ok(calls.at(-1).argv.includes('--retries=0') && calls.at(-1).argv.includes('--workers=1'));
    assert.match(env.SPEC_RELAY_E2E_OUTPUT_DIR.split(path.sep).join('/'), /openspec\/spec-relay\/local\/e2e\/calc-add\/old\/results$/);
    const receipt = JSON.parse(fs.readFileSync(path.join(dir, PORT, OLD_RECEIPT), 'utf8'));
    assert.deepEqual([receipt.capability, receipt.screenshots, receipt.tests.length], ['calc/add', 1, 2]);
    // A reset command that fails stops the run before any test.
    result = await recordOld(dir, opts(['--reset', `${node('-e')} "process.exit(3)"`]), { run: async (command, cwd, o) => (Array.isArray(command) ? fakePlaywright()(command, cwd, o) : runCommand(command, cwd, o)) });
    assert.match(result.problems.join(), /the --reset command failed \(exit code 3\)/);
  } finally { old.close(); }
  // Nothing answers: the person has to start the old system first.
  const none = await recordOld(dir, parseE2eOptions(['--change', 'port-calc-add', '--base', `http://127.0.0.1:${port}`], 'old'), { run: fakePlaywright() });
  assert.match(none.problems.join(), /nothing answers at http:\/\/127\.0\.0\.1:\d+: ask the person to start the test copy of the old system/);
});

test('the new run tests the new system with exactly the tests that passed on the old one', async () => {
  const { dir, command } = await screenRepo();
  const old = http.createServer((q, r) => r.end('old')).listen(0, '127.0.0.1');
  await new Promise((resolve) => { old.once('listening', resolve); });
  const run = (fake) => runE2eCommand(command, dir, { root: dir, change: 'port-calc-add', capability: 'calc/add', run: fake });
  try {
    // Before the old run, nothing judges the new system.
    assert.match((await run(fakePlaywright())).output, /never passed on the old system \(no e2e-old\.json\)/);
    assert.equal((await recordOld(dir, parseE2eOptions(['--change', 'port-calc-add', '--base', `http://127.0.0.1:${old.address().port}`], 'old'), { run: fakePlaywright() })).ok, true);
  } finally { old.close(); }
  const calls = [];
  let result = await run(fakePlaywright(() => 'passed', calls));
  assert.equal(result.exitCode, 0, result.output);
  assert.deepEqual([calls[0].env.SPEC_RELAY_SIDE, calls[0].env.SPEC_RELAY_E2E_UPDATE], ['new', 'none']);
  assert.deepEqual([result.e2e.tests, result.e2e.passed, result.e2e.screenshots, result.e2e.titles.length], [2, 2, 1, 2]);
  // The system was started for the run and stopped after it.
  assert.equal(await fetch(calls[0].env.SPEC_RELAY_BASE_URL).then(() => true, () => false), false);
  result = await run(fakePlaywright((side, title) => (title === TAGS.pos ? 'failed' : 'passed')));
  assert.equal(result.exitCode, 1);
  assert.match(result.output, /failed on the new system \(fix the new code, never the test or the screenshots\)/);
  assert.match(result.output, /details and screenshot differences: openspec\/spec-relay\/local\/e2e\/calc-add\/new\/results/);
  // A test edited after the old run must pass on the old system again.
  write(dir, 'ts/tests/e2e/calc-add/add.e2e.mjs', fs.readFileSync(path.join(dir, 'ts/tests/e2e/calc-add/add.e2e.mjs'), 'utf8').replace("fill('1')", "fill('2')"));
  assert.match((await run(fakePlaywright())).output, /tests\/e2e\/ changed after the tests passed on the old system \(calc-add\/add\.e2e\.mjs\): run e2e\.mjs old again/);
  // So must a screenshot replaced by hand.
  const receipt = oldReceipt(dir, 'calc/add', 'port-calc-add');
  assert.equal(receipt.receipt.capability, 'calc/add');
  write(dir, `${PORT}/${OLD_RECEIPT}`, '{"capability":"calc/other","sha256":"x","tests":[]}');
  assert.match(oldReceipt(dir, 'calc/add', 'port-calc-add').problem, /is not an old run of calc\/add/);
});

test('a test that ran only on one side fails the new run', async () => {
  const { dir, command } = await screenRepo();
  const old = http.createServer((q, r) => r.end('old')).listen(0, '127.0.0.1');
  await new Promise((resolve) => { old.once('listening', resolve); });
  try {
    assert.equal((await recordOld(dir, parseE2eOptions(['--change', 'port-calc-add', '--base', `http://127.0.0.1:${old.address().port}`], 'old'), { run: fakePlaywright() })).ok, true);
  } finally { old.close(); }
  // The stand-in reports one test fewer than the old run had.
  const fewer = async (argv, cwd, o) => {
    const r = await fakePlaywright()(argv, cwd, o);
    const report = JSON.parse(fs.readFileSync(o.env.SPEC_RELAY_E2E_REPORT, 'utf8'));
    report.suites[0].specs.pop();
    fs.writeFileSync(o.env.SPEC_RELAY_E2E_REPORT, JSON.stringify(report));
    return r;
  };
  const result = await runE2eCommand(command, dir, { root: dir, change: 'port-calc-add', capability: 'calc/add', run: fewer });
  assert.equal(result.exitCode, 1);
  assert.match(result.output, /"spec-relay: calc\/add \| Add two numbers \| Negative numbers" \(add\.e2e\.mjs\) passed on the old system but did not run on the new one/);
});

test('verify runs the screen tests as B2 (and as C with the same command), and port-done checks each scenario', async () => {
  const { dir } = await screenRepo({ c: 'yes', cCommand: true });
  const old = http.createServer((q, r) => r.end('old')).listen(0, '127.0.0.1');
  await new Promise((resolve) => { old.once('listening', resolve); });
  try {
    assert.equal((await recordOld(dir, parseE2eOptions(['--change', 'port-calc-add', '--base', `http://127.0.0.1:${old.address().port}`], 'old'), { run: fakePlaywright() })).ok, true);
  } finally { old.close(); }
  crosscheck(dir);
  const calls = [];
  const result = await verify(dir, 'port-calc-add', { ...quietly, run: withFake(fakePlaywright(() => 'passed', calls)) });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.deepEqual(result.runs.map((r) => r.level), ['A', 'boundary', 'B2', 'C']);
  // One run of the screen tests counts for both levels.
  assert.equal(calls.filter((c) => Array.isArray(c.argv)).length, 1);
  const saved = JSON.parse(fs.readFileSync(path.join(dir, PORT, 'verify.json'), 'utf8'));
  assert.equal(saved.runs[3].sameAs, 'B2');
  const done = checkPortDone(dir, 'port-calc-add');
  assert.equal(done.ok, true, done.problems.join('\n'));
  assert.deepEqual(done.scenarioChecks, { e2e: 2, compare: 0, unit: 1 });
  assert.deepEqual(done.screens, [{ level: 'B2', tests: 2, screenshots: 1 }, { level: 'C', tests: 2, screenshots: 1 }]);
  const ja = nextSteps('port-done', done, 'ja').person.join('\n');
  assert.match(ja, /B2: 画面のテスト 2 件が、元のシステムで通ったあと、新しいシステムでも通過/);
  assert.match(ja, /C: 元のシステムで撮った 1 枚のスクリーンショットと新しい画面が一致/);
  assert.match(ja, /シナリオ 3 件の確認方法: 画面のテスト（新旧の両方で実行）2 件、元のプログラムの記録との比較 0 件、単体テスト 1 件。/);
  assert.match(nextSteps('port-done', done, 'en').person.join('\n'), /B2: all 2 screen tests passed on the source program first, then on the new system/);
  // A screenshot replaced after the runs voids them.
  write(dir, 'ts/tests/e2e/calc-add/screenshots/add.e2e.mjs/result.png', 'png from new');
  assert.match(problems(dir).join('\n'), /the screen tests or their screenshots \(tests\/e2e\/\) changed after they passed on the old system/);
});

test('every scenario needs a row in Scenario checks and the evidence of its kind', async () => {
  const { dir } = await screenRepo();
  const old = http.createServer((q, r) => r.end('old')).listen(0, '127.0.0.1');
  await new Promise((resolve) => { old.once('listening', resolve); });
  try {
    assert.equal((await recordOld(dir, parseE2eOptions(['--change', 'port-calc-add', '--base', `http://127.0.0.1:${old.address().port}`], 'old'), { run: fakePlaywright() })).ok, true);
  } finally { old.close(); }
  crosscheck(dir);
  assert.equal((await verify(dir, 'port-calc-add', { ...quietly, run: withFake(fakePlaywright()) })).ok, true);
  assert.deepEqual(problems(dir), []);
  const design = path.join(dir, PORT, 'design.md');
  const text = fs.readFileSync(design, 'utf8');
  const edit = (from, to) => fs.writeFileSync(design, text.replace(from, to));
  // A scenario with no row, a row for no scenario, an unknown kind.
  edit('| Reject text | Text input | unit |\n', '| Reject text | Text inputs | unit |\n| Add two numbers | Positive numbers | manual |\n');
  const found = problems(dir).join('\n');
  assert.match(found, /Scenario checks has no row for scenario "Text input" of requirement "Reject text"/);
  assert.match(found, /names a scenario the baseline of calc\/add does not have: "Reject text \| Text inputs"/);
  assert.match(found, /"manual" for scenario "Positive numbers" is not e2e, compare or unit/);
  // A scenario said to be a screen test must be one that passed on both systems.
  edit('| Reject text | Text input | unit |', '| Reject text | Text input | e2e |');
  assert.match(problems(dir).join('\n'), /no screen test titled with the tag of scenario "Text input" of requirement "Reject text" passed on the old system/);
  // compare needs a comparison level.
  edit('| Reject text | Text input | unit |', '| Reject text | Text input | compare |');
  assert.match(problems(dir).join('\n'), /scenario "Text input" of requirement "Reject text" is checked by compare, but design\.md's Verification has no spec-relay-compare command/);
  // unit needs a tag outside the screen tests.
  edit('| Add two numbers | Positive numbers | e2e |', '| Add two numbers | Positive numbers | unit |');
  fs.writeFileSync(path.join(dir, 'ts/calc/add.test.ts'), "test(\"spec-relay: calc/add | Add two numbers | Negative numbers\", () => {});\n# spec-relay: calc/add | Reject text | Text input\n");
  assert.match(problems(dir).join('\n'), /scenario "Positive numbers" of requirement "Add two numbers" is checked by unit, but its only tags are in screen tests or data files/);
  // Without the table, a port with screen tests stops.
  fs.writeFileSync(design, text.replace(/\n## Scenario checks[\s\S]*$/, '\n'));
  assert.match(problems(dir).join('\n'), /design\.md has no filled "## Scenario checks" table/);
});

test('the parsers read the Scenario checks table in English and Japanese', () => {
  assert.deepEqual(designScenarioChecks('## Scenario checks\n| Requirement | Scenario | Check |\n|---|---|---|\n| Add | Positive | E2E (Playwright) |\n| Add | Text | Compare |\n| Add | Zero | unit |\n').map((r) => r.check), ['e2e', 'compare', 'unit']);
  assert.deepEqual(designScenarioChecks('| 要件 | シナリオ | 確認 |\n|---|---|---|\n| 加算 | 正の数 | 画面 |\n| 加算 | 文字 | 比較 |\n| 加算 | ゼロ | 単体 |\n').map((r) => r.check), ['e2e', 'compare', 'unit']);
  assert.equal(designScenarioChecks('| Requirement | Source |\n|---|---|\n| Add | src/a.php:1 |\n'), null);
});

test('a port command for the screen tests is checked like the others', async () => {
  const dir = portRepo({ designCommand: "| B2 | screens | `spec-relay-e2e --base http://localhost:3000` |\n" });
  write(dir, 'openspec/changes/archive/2026-11-02-target-design/verification.md', '| Context | A | B1 | B2 | C |\n|---|---|---|---|---|\n| calc | yes | no | yes | no |\n');
  assert.match(verifyPlan(dir, 'port-calc-add').problems.join(), /level B2: a port command needs --start/);
  const result = await runLevel('spec-relay-e2e --base http://localhost:3000', dir, {});
  assert.equal(result.exitCode, 2);
});

test('init copies the template once and never over a file', () => {
  const dir = tempDir();
  write(dir, 'openspec/config.yaml', 'context: |\n  Source root (existing code): src\n  Target root (new implementation): ts\n');
  write(dir, 'ts/tests/e2e/playwright.config.mjs', '// mine\n');
  const result = init(dir);
  assert.equal(result.ok, true);
  assert.deepEqual(result.written.sort(), ['ts/tests/e2e/.gitignore', 'ts/tests/e2e/package-lock.json', 'ts/tests/e2e/package.json', 'ts/tests/e2e/support.mjs']);
  assert.equal(fs.readFileSync(path.join(dir, 'ts/tests/e2e/playwright.config.mjs'), 'utf8'), '// mine\n');
  assert.deepEqual(init(dir).written, []);
  const pkg = JSON.parse(fs.readFileSync(path.join(KIT, 'templates/e2e/package.json'), 'utf8'));
  const lock = JSON.parse(fs.readFileSync(path.join(KIT, 'templates/e2e/package-lock.json'), 'utf8'));
  // The lock file pins the same version as package.json.
  assert.equal(lock.packages['node_modules/@playwright/test'].version, pkg.devDependencies['@playwright/test']);
});

test('the hook and the guard keep agents away from the old run\'s record', () => {
  const dir = tempDir();
  write(dir, 'openspec/config.yaml', '# spec-relay: managed\ncontext: |\n  Source root (existing code): src\n  Target root (new implementation): ts\n  Hook enforcement: on\n');
  write(dir, 'openspec/changes/port-calc-add/e2e-old.json', '{}');
  const edit = decide({ cwd: dir, toolName: 'edit', toolArgs: { path: path.join(dir, 'openspec/changes/port-calc-add/e2e-old.json') } });
  assert.match(edit ?? '', /only e2e\.mjs writes e2e-old\.json/);
  const shell = decide({ cwd: dir, toolName: 'powershell', toolArgs: { command: 'Set-Content openspec/changes/port-calc-add/e2e-old.json "{}"' } });
  assert.match(shell ?? '', /only e2e\.mjs writes e2e-old\.json/);
  assert.equal(decide({ cwd: dir, toolName: 'powershell', toolArgs: { command: 'Get-Content openspec/changes/port-calc-add/e2e-old.json' } }), null);
  assert.ok(Object.keys(guardFiles(dir)).includes('openspec/changes/port-calc-add/e2e-old.json'));
});

// The real thing: the template installed with npm ci, Playwright driving a
// browser against two small systems. Needs the network for npm ci and a
// browser: Edge on Windows (the template's default), elsewhere one named by
// SPEC_RELAY_E2E_CHANNEL (chrome) or SPEC_RELAY_E2E_EXECUTABLE (a path).
const REAL = process.env.SPEC_RELAY_E2E_REAL === '1';
test('Playwright runs the same test on the old and the new system, screenshots included', { skip: !REAL && 'set SPEC_RELAY_E2E_REAL=1 to run Playwright for real', timeout: 10 * 60 * 1000 }, async () => {
  const dir = portRepo({ designCommand: '' });
  const [oldPort, newPort] = [await freePort(), await freePort()];
  write(dir, 'ts/calc-server.cjs', String.raw`
const [port, flavor] = process.argv.slice(2);
require('http').createServer((req, res) => {
  const u = new URL(req.url, 'http://x');
  const path = flavor === 'old' ? '/calc.php' : '/calc';
  if (u.pathname !== path) { res.writeHead(404); res.end('no'); return; }
  const a = Number(u.searchParams.get('a')), b = Number(u.searchParams.get('b'));
  const result = u.searchParams.has('a') ? '<p>結果: ' + (flavor === 'broken' ? a - b : a + b) + '</p>' : '';
  // The old page and the new one name their inputs differently, as a WebForms page and its rewrite do.
  const id = flavor === 'old' ? 'ctl00_Main_txtA' : 'a';
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
  res.end('<!doctype html><html><body style="font-family:sans-serif"><form action="' + path + '"><label for="' + id + '">A</label><input id="' + id + '" name="a"><label>B <input name="b"></label><button>計算</button></form>' + result + '</body></html>');
}).listen(Number(port), '127.0.0.1');
`);
  const command = (flavor) => `spec-relay-e2e --base http://127.0.0.1:${newPort} --start '${node('calc-server.cjs')} ${newPort} ${flavor}'`;
  write(dir, 'openspec/changes/archive/2026-11-02-target-design/verification.md', '| Context | A | B1 | B2 | C |\n|---|---|---|---|---|\n| calc | yes | no | yes | yes |\n');
  const setDesign = (flavor) => write(dir, `${PORT}/design.md`, `## Verification\n| Level | Covers | Command |\n|---|---|---|\n| A scenario tests | every scenario | |\n| B2 screen tests | the calculator | \`${command(flavor)}\` |\n| C screenshots | the calculator | \`${command(flavor)}\` |\n${checksTable(['e2e', 'unit', 'unit'])}`);
  setDesign('new');
  assert.equal(init(dir).ok, true);
  const e2e = path.join(dir, 'ts/tests/e2e');
  const npm = spawnSync(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['ci', '--ignore-scripts', '--no-audit', '--no-fund'], { cwd: e2e, encoding: 'utf8', shell: process.platform === 'win32' });
  assert.equal(npm.status, 0, npm.stderr);
  if (process.env.SPEC_RELAY_E2E_EXECUTABLE) {
    const config = path.join(e2e, 'playwright.config.mjs');
    fs.writeFileSync(config, fs.readFileSync(config, 'utf8').replace("locale: 'ja-JP',", "locale: 'ja-JP',\n    launchOptions: { executablePath: process.env.SPEC_RELAY_E2E_EXECUTABLE },"));
  }
  write(dir, 'ts/tests/e2e/paths.json', '{ "/calc.php": "/calc" }\n');
  write(dir, 'ts/tests/e2e/calc-add/add.e2e.mjs', `import { test, expect } from '@playwright/test';
import { at } from '../support.mjs';

test('${TAGS.pos}', async ({ page }) => {
  await page.goto(at('/calc.php'));
  await page.getByLabel('A').fill('1');
  await page.getByLabel('B').fill('2');
  await page.getByRole('button', { name: '計算' }).click();
  await expect(page.getByText('結果: 3')).toBeVisible();
  await expect(page).toHaveScreenshot('result.png');
});
`);
  const oldSystem = spawn(process.execPath, [path.join(dir, 'ts/calc-server.cjs'), String(oldPort), 'old'], { stdio: 'ignore' });
  try {
    for (let i = 0; i < 50 && !(await fetch(`http://127.0.0.1:${oldPort}/calc.php`).then(() => true, () => false)); i += 1) await new Promise((r) => { setTimeout(r, 100); });
    const recorded = await recordOld(dir, parseE2eOptions(['--change', 'port-calc-add', '--base', `http://127.0.0.1:${oldPort}`], 'old'));
    assert.equal(recorded.ok, true, [...recorded.problems, ...recorded.lines].join('\n'));
    assert.equal(fs.existsSync(path.join(e2e, 'calc-add/screenshots/add.e2e.mjs/result.png')), true);
  } finally { oldSystem.kill(); }
  crosscheck(dir);
  const passed = await verify(dir, 'port-calc-add', quietly);
  assert.equal(passed.ok, true, JSON.stringify(passed, null, 2));
  assert.equal(checkPortDone(dir, 'port-calc-add').ok, true, checkPortDone(dir, 'port-calc-add').problems.join('\n'));
  // A new system that subtracts fails the same test.
  setDesign('broken');
  const failed = await verify(dir, 'port-calc-add', quietly);
  assert.equal(failed.ok, false);
  assert.match(failed.runs.find((r) => r.level === 'B2').tail, /failed on the new system[\s\S]*結果: 3/);
});
