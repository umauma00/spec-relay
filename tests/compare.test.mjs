import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { compare, differences, parsePath, readCases, readOutputs, readRules, report, runCompareCommand, words, main } from '../scripts/compare.mjs';
import { runCommand } from '../scripts/run.mjs';
import { verify } from '../scripts/verify.mjs';
import { checkPortDone, nextSteps } from '../scripts/gate.mjs';
import { tempDir, write } from './helpers.mjs';
import { PORT, checksTable, crosscheck, portRepo } from './port-fixture.mjs';

const rules = (raw = {}) => { const problems = []; const r = readRules(JSON.stringify(raw), problems); assert.deepEqual(problems, []); return r; };
const node = (script) => `node ${JSON.stringify(script)}`;

// A driver that runs `add` on each case: { a, b } -> { sum }.
const DRIVER = `const rl = require('readline').createInterface({ input: process.stdin });
rl.on('line', (line) => {
  if (!line.trim()) return;
  const c = JSON.parse(line);
  const output = c.input.a === 'x' ? { error: 'not a number' } : { sum: c.input.a + c.input.b, at: Date.now() };
  process.stdout.write(JSON.stringify({ id: c.id, output }) + '\\n');
});
`;
const CASES = [
  '{"id":"pos","input":{"a":1,"b":2},"expected":{"sum":3,"at":0},"note":"recorded 2026-11-01"}',
  '{"id":"neg","scenario":"spec-relay: calc/add | Add two numbers | Negative numbers","input":{"a":-1,"b":-2},"expected":{"sum":-3,"at":0}}',
  '{"id":"text","input":{"a":"x","b":1},"expected":{"error":"not a number"}}',
].join('\n') + '\n';

function golden(dir, { cases = CASES, rulesJson = '{"ignore":["$.at"]}\n', driver = DRIVER } = {}) {
  write(dir, 'tests/golden/calc/add.jsonl', cases);
  if (rulesJson !== null) write(dir, 'tests/golden/calc/rules.json', rulesJson);
  write(dir, 'tests/golden/driver.cjs', driver);
}

test('command words keep quoted spaces and backslashes', () => {
  assert.deepEqual(words('--cases tests\\golden --driver "node tests\\d.js" --x \'a "b"\''), ['--cases', 'tests\\golden', '--driver', 'node tests\\d.js', '--x', 'a "b"']);
  assert.equal(words('--driver "node d.js'), null);
  assert.deepEqual(words('--driver ""'), ['--driver', '']);
});

test('paths are $ then .name, [n], [*] or .*', () => {
  assert.deepEqual(parsePath('$.lines[*].id'), ['lines', '*', 'id']);
  assert.deepEqual(parsePath('$[2].*'), [2, '*']);
  assert.deepEqual(parsePath('$'), []);
  for (const bad of ['lines', '$..x', '$.a[', '$[x]', 3]) assert.equal(parsePath(bad), null, String(bad));
});

test('values compare exactly unless a rule loosens them', () => {
  const strict = rules();
  assert.deepEqual(differences({ a: 1, b: [1, 2] }, { a: 1, b: [1, 2] }, strict), []);
  assert.deepEqual(differences(1, '1', strict).map((d) => d.what), ['number vs string']);
  assert.deepEqual(differences({ a: 1 }, { a: 1, b: null }, strict).map((d) => [d.path, d.expected, d.actual]), [['$.b', '(missing)', 'null']]);
  assert.equal(differences([1, 2], [2, 1], strict).length, 2, 'order counts');
  assert.match(differences([1], [1, 2], strict)[0].what, /1 items vs 2/);
  assert.equal(differences(0.1 + 0.2, 0.3, strict).length, 0, 'floating point noise is not a difference');
  // Large integers (epoch milliseconds, ids, ticks, big amounts) compare exactly.
  for (const [e, a] of [[1700000000000, 1700000000001], [1234567890123456, 1234567890123999], [1e12, 1e12 + 1]]) assert.equal(differences(e, a, strict).length, 1, `${e} vs ${a}`);
  assert.equal(differences(1e6 + 0.5, 1e6 + 0.25, strict).length, 1);
  // numbersAsText reads text as a number only against a number.
  const text = rules({ numbersAsText: true });
  assert.equal(differences('0123', '123', text).length, 1, 'leading zeros are text');
  assert.equal(differences('1e3', '1000', text).length, 1);
  assert.equal(differences('0123', 123, text).length, 0);
  // Keys named like Object's own properties are data.
  assert.equal(differences({ constructor: 1 }, {}, strict)[0].path, '$.constructor');
  assert.equal(differences({}, { toString: 'x' }, strict)[0].actual, '"x"');
  assert.equal(differences(JSON.parse('{"__proto__":{}}'), {}, strict).length, 1);
  assert.equal(differences(10.004, 10, strict).length, 1);
  assert.equal(differences(10.004, 10, rules({ tolerance: 0.005 })).length, 0);
  assert.equal(differences({ n: '12.50' }, { n: 12.5 }, rules({ numbersAsText: true })).length, 0);
  assert.equal(differences(' ab ', 'ab', rules({ trim: true })).length, 0);
  assert.equal(differences({ a: null }, {}, rules({ missingIsNull: true })).length, 0);
  assert.equal(differences({ a: 0 }, {}, rules({ missingIsNull: true })).length, 1, 'only null equals missing');
  const loose = rules({ unordered: ['$.lines'], ignore: ['$.lines[*].id', '$.at'] });
  assert.deepEqual(differences({ at: 1, lines: [{ id: 1, v: 'a' }, { id: 2, v: 'b' }] }, { at: 2, lines: [{ id: 9, v: 'b' }, { id: 8, v: 'a' }] }, loose), []);
  assert.deepEqual(differences({ lines: [{ v: 'a' }, { v: 'a' }] }, { lines: [{ v: 'a' }, { v: 'b' }] }, loose).map((d) => [d.path, d.actual]), [['$.lines[1]', '(no matching item)']]);
  assert.match(differences('x'.repeat(200), 'y', strict)[0].expected, /^"x{76}\.\.\.$/);
  assert.equal(differences({ 'a.b': 1 }, { 'a.b': 2 }, strict)[0].path, '$["a.b"]');
});

test('rules.json is checked: unknown rules, bad paths and wrong types are problems', () => {
  const problems = [];
  readRules('{"ignor":["$.a"],"ignore":["at"],"tolerance":-1,"trim":"yes","unordered":"$.x"}', problems);
  assert.deepEqual(problems, [
    'rules.json has the unknown rule "ignor" (rules: ignore, tolerance, numbersAsText, trim, unordered, missingIsNull)',
    'rules.json "ignore" has the path "at"; write $ then .name, [n], [*] or .*',
    'rules.json "unordered" must be a list of paths',
    'rules.json "tolerance" must be a finite number of 0 or more',
    'rules.json "trim" must be true or false',
  ]);
  const p2 = [];
  readRules('[1]', p2);
  assert.deepEqual(p2, ['rules.json must be one JSON object']);
  // Rules that would switch the comparison off.
  for (const off of ['{"ignore":["$"]}', '{"ignore":["$.*"]}', '{"ignore":["$[*]"]}', '{"tolerance":1e999}']) {
    const p3 = [];
    readRules(off, p3);
    assert.equal(p3.length, 1, off);
    assert.match(p3[0], /leaves nothing to compare|finite number/);
  }
  assert.deepEqual(rules({ ignore: ['$.at'], tolerance: 0.01, trim: true, unordered: ['$.x'] }).text, ['ignore $.at', 'unordered $.x', 'tolerance 0.01', 'trim']);
});

test('case files: ids are unique, input and expected are required, bad lines are named', () => {
  const dir = tempDir();
  write(dir, 'g/a.jsonl', '{"id":"1","input":1,"expected":1}\n\nnot json\n[1]\n{"input":1,"expected":1}\n{"id":"2","expected":1}\n{"id":"3","input":1}\n');
  write(dir, 'g/sub/b.jsonl', '{"id":"1","input":2,"expected":2}\n');
  write(dir, 'g/notes.txt', 'ignored');
  const problems = [];
  const read = readCases(path.join(dir, 'g'), problems, dir);
  assert.deepEqual(read.cases.map((c) => [c.id, c.file, c.line]), [['1', 'g/a.jsonl', 1], ['2', 'g/a.jsonl', 6]]);
  assert.deepEqual(read.files, ['g/a.jsonl', 'g/sub/b.jsonl']);
  assert.match(problems[0], /^g\/a\.jsonl:3 is not JSON/);
  assert.deepEqual(problems.slice(1), [
    'g/a.jsonl:4 is not a JSON object',
    'g/a.jsonl:5 has no "id" (a non-empty string)',
    'g/a.jsonl:6 (case 2) has no "input"',
    'g/a.jsonl:7 (case 3) has no "expected"',
    'g/sub/b.jsonl:1: case 1 is also at g/a.jsonl:1',
  ]);
  const none = [];
  readCases(path.join(dir, 'missing'), none, dir);
  assert.match(none.join(), /does not exist/);
  const empty = [];
  fs.mkdirSync(path.join(dir, 'e'));
  readCases(path.join(dir, 'e'), empty, dir);
  assert.match(empty.join(), /no \*\.jsonl case files/);
});

test('the hash covers the cases and the rules, not CRLF or a BOM', () => {
  const dir = tempDir();
  write(dir, 'g/a.jsonl', '{"id":"1","input":1,"expected":1}\n');
  const hash = () => readCases(path.join(dir, 'g'), [], dir).sha256;
  const first = hash();
  write(dir, 'g/a.jsonl', '\uFEFF{"id":"1","input":1,"expected":1}\r\n');
  assert.equal(hash(), first);
  write(dir, 'g/rules.json', '{"trim":true}');
  assert.notEqual(hash(), first);
});

test('outputs need an id and an output, once per case', () => {
  const problems = [];
  const out = readOutputs('{"id":"a","output":1}\nlog line\n{"id":"b"}\n{"id":"a","output":2}\n', 'driver', problems);
  assert.deepEqual([...out], [['a', 1]]);
  assert.equal(problems.length, 3);
  assert.match(problems[0], /^driver:2 is not JSON/);
});

test('compare runs the driver on every case and shows what differs', async () => {
  const dir = tempDir();
  golden(dir);
  let r = await compare({ cases: 'tests/golden/calc', driver: node('tests/golden/driver.cjs'), cwd: dir });
  assert.equal(r.ok, true, report(r));
  assert.deepEqual([r.count, r.passed, r.failed.length], [3, 3, 0]);
  // A recorded value the new code does not give.
  golden(dir, { cases: CASES.replace('"sum":-3', '"sum":-4') });
  r = await compare({ cases: 'tests/golden/calc', driver: node('tests/golden/driver.cjs'), cwd: dir });
  assert.equal(r.ok, false);
  assert.deepEqual([r.count, r.passed], [3, 2]);
  assert.match(report(r), /case neg \(tests\/golden\/calc\/add\.jsonl:2\):\n {2}\$\.sum: expected -4, got -3/);
  // Without the rule, the time stamp differs in every case.
  golden(dir, { rulesJson: '{}' });
  r = await compare({ cases: 'tests/golden/calc', driver: node('tests/golden/driver.cjs'), cwd: dir });
  assert.equal(r.failed.length, 2);
});

test('a driver that fails, prints other lines, skips or invents cases fails the comparison', async () => {
  const dir = tempDir();
  golden(dir, { driver: 'console.error("boom"); process.exit(4);\n' });
  let r = await compare({ cases: 'tests/golden/calc', driver: node('tests/golden/driver.cjs'), cwd: dir });
  assert.equal(r.ok, false);
  assert.match(r.problems.join(), /the driver failed \(exit code 4\)/);
  assert.match(report(r), /boom/);
  golden(dir, { driver: DRIVER.replace("process.stdout.write(JSON.stringify({ id: c.id, output }) + '\\n');", "if (c.id !== 'neg') process.stdout.write(JSON.stringify({ id: c.id, output }) + '\\n'); console.log('done'); console.log(JSON.stringify({ id: 'extra', output: 1 }));") });
  r = await compare({ cases: 'tests/golden/calc', driver: node('tests/golden/driver.cjs'), cwd: dir });
  const text = r.problems.join('\n');
  assert.match(text, /the driver output:\d+ is not JSON/);
  assert.match(text, /an output names the case extra, which no case file has/);
  assert.match(text, /no output for case neg \(tests\/golden\/calc\/add\.jsonl:2\)/);
  assert.equal(r.ok, false);
});

test('--actual compares with outputs the new code wrote to a file', async () => {
  const dir = tempDir();
  golden(dir);
  write(dir, 'out/actual.jsonl', '{"id":"pos","output":{"sum":3}}\n{"id":"neg","output":{"sum":-3}}\n{"id":"text","output":{"error":"not a number"}}\n');
  assert.equal((await compare({ cases: 'tests/golden/calc', actual: 'out/actual.jsonl', cwd: dir })).ok, true);
  assert.match((await compare({ cases: 'tests/golden/calc', actual: 'out/none.jsonl', cwd: dir })).problems.join(), /does not exist/);
});

test('the port command form refuses what it cannot run', async () => {
  const dir = tempDir();
  golden(dir);
  const run = (command) => runCompareCommand(command, dir, {});
  assert.match((await run('spec-relay-compare --cases tests/golden/calc')).output, /give one of --driver/);
  assert.match((await run('spec-relay-compare --cases tests/golden/calc --driver "node a.js; node b.js"')).output, /the driver "node a\.js; node b\.js" chains commands/);
  assert.match((await run('spec-relay-compare --cases tests/golden/calc --driver "node d.js')).output, /an unclosed quote/);
  assert.match((await run('spec-relay-compare --cases tests/golden/calc --driver x --cwd ..')).output, /--cwd is not allowed/);
  assert.match((await run('spec-relay-compare --cases tests/golden/calc --actual out.jsonl')).output, /--actual is not allowed in a port command/);
  assert.match((await run('spec-relay-compare --cases x --driver d --timeout-minutes soon')).output, /not a number of minutes/);
  const ok = await run(`spec-relay-compare --cases tests/golden/calc --driver '${node('tests/golden/driver.cjs')}'`);
  assert.equal(ok.exitCode, 0, ok.output);
  assert.equal(ok.cases.count, 3);
  assert.match(ok.cases.sha256, /^[0-9a-f]{64}$/);
});

test('the CLI exits 0, 1 or 2', async () => {
  const dir = tempDir();
  golden(dir);
  const log = console.log; const error = console.error;
  console.log = () => {}; console.error = () => {};
  try {
    assert.equal(await main(['--cases', 'tests/golden/calc', '--driver', node('tests/golden/driver.cjs'), '--cwd', dir]), 0);
    assert.equal(await main(['--cases', 'tests/golden/none', '--driver', node('tests/golden/driver.cjs'), '--cwd', dir]), 1);
    assert.equal(await main(['--cases']), 2);
  } finally { console.log = log; console.error = error; }
});

test('verify runs a B1 compare command, and port-done reports the cases it matched', async () => {
  const B1 = `| B1 logic comparison | add | \`spec-relay-compare --cases tests/golden/calc --driver '${node('tests/golden/driver.cjs')}'\` |\n`;
  const dir = portRepo({ levels: 'yes', designCommand: B1 });
  golden(path.join(dir, 'ts'));
  crosscheck(dir);
  // With a comparison level, design.md says how each scenario is checked.
  assert.match(checkPortDone(dir, 'port-calc-add').problems.join(), /design\.md has no filled "## Scenario checks" table/);
  fs.appendFileSync(path.join(dir, PORT, 'design.md'), checksTable(['unit', 'compare', 'compare']));
  assert.match(checkPortDone(dir, 'port-calc-add').problems.join(), /no recorded case in tests\/golden\/calc carries the tag of scenario "Text input"/);
  fs.writeFileSync(path.join(dir, PORT, 'design.md'), fs.readFileSync(path.join(dir, PORT, 'design.md'), 'utf8').replace('| Text input | compare |', '| Text input | unit |'));
  const result = await verify(dir, 'port-calc-add', { progress: () => {} });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.deepEqual(result.runs.map((r) => r.level), ['A', 'boundary', 'B1']);
  const saved = JSON.parse(fs.readFileSync(path.join(dir, PORT, 'verify.json'), 'utf8'));
  assert.equal(saved.runs[2].cases.count, 3);
  const done = checkPortDone(dir, 'port-calc-add');
  assert.equal(done.ok, true, done.problems.join('\n'));
  assert.deepEqual(done.cases, [{ level: 'B1', count: 3, rules: ['ignore $.at'] }]);
  assert.equal(done.cases[0].count, 3);
  assert.match(nextSteps('port-done', done, 'en').person.join(' '), /compared as well \(B1: all 3 recorded cases match, with the rules ignore \$\.at \(design\.md's Decisions should say why\)\)/);
  assert.match(nextSteps('port-done', done, 'ja').person.join(' '), /B1: 記録された 3 件がすべて一致。比べ方をゆるめる規則 ignore \$\.at を使用/);
  assert.deepEqual(done.scenarioChecks, { e2e: 0, compare: 1, unit: 2 });
  assert.match(nextSteps('port-done', done, 'ja').person.join(' '), /シナリオ 3 件の確認方法: 画面のテスト（新旧の両方で実行）0 件、元のプログラムの記録との比較 1 件、単体テスト 2 件。/);
  // A recorded case changed after the run voids it, like a change to the code.
  write(dir, 'ts/tests/golden/calc/add.jsonl', CASES.replace('"sum":3', '"sum":30'));
  assert.match(checkPortDone(dir, 'port-calc-add').problems.join(), /the target code changed after the last verify run \(ts\/tests\/golden\/calc\/add\.jsonl\)/);
  const failed = await verify(dir, 'port-calc-add', { progress: () => {} });
  assert.equal(failed.ok, false);
  assert.match(failed.runs[2].tail, /case pos .*\n {2}\$\.sum: expected 30, got 3/);
});

test('recorded cases must be inside the target root', () => {
  const dir = portRepo({ levels: 'yes', designCommand: "| B1 | add | `spec-relay-compare --cases ../golden --driver 'node d.js'` |\n" });
  assert.match(checkPortDone(dir, 'port-calc-add').problems.join(), /level B1: the cases folder \.\.\/golden is not inside the target root/);
  const bad = portRepo({ levels: 'yes', designCommand: '| B1 | add | `spec-relay-compare --driver x` |\n' });
  assert.match(checkPortDone(bad, 'port-calc-add').problems.join(), /level B1: no --cases folder/);
  // A file of outputs proves nothing about the code as it is now.
  const actual = portRepo({ levels: 'yes', designCommand: '| B1 | add | `spec-relay-compare --cases tests/golden/calc --actual ../outside.jsonl` |\n' });
  assert.match(checkPortDone(actual, 'port-calc-add').problems.join(), /level B1: --actual is not allowed in a port command/);
});

test('cases git ignores, or a build folder holds, still void the run when they change', async () => {
  // Without git, a build folder right under the target root is not in the target hash.
  const B1 = `| B1 logic comparison | add | \`spec-relay-compare --cases out/golden --driver '${node('tests/golden/driver.cjs')}'\` |\n`;
  const dir = portRepo({ levels: 'yes', designCommand: B1 + checksTable() });
  golden(path.join(dir, 'ts'));
  fs.cpSync(path.join(dir, 'ts/tests/golden/calc'), path.join(dir, 'ts/out/golden'), { recursive: true });
  crosscheck(dir);
  assert.equal((await verify(dir, 'port-calc-add', { progress: () => {} })).ok, true);
  assert.equal(checkPortDone(dir, 'port-calc-add').ok, true);
  write(dir, 'ts/out/golden/rules.json', '{"ignore":["$.at","$.sum"]}\n');
  assert.match(checkPortDone(dir, 'port-calc-add').problems.join(), /the recorded cases, rules\.json or the map of level B1 changed after the last verify run/);
});

test('text that is not UTF-8 is a problem, not replacement characters', async () => {
  const dir = tempDir();
  // 東京 and 京東 in Shift_JIS (CP932).
  fs.mkdirSync(path.join(dir, 'g'));
  fs.writeFileSync(path.join(dir, 'g/a.jsonl'), Buffer.concat([Buffer.from('{"id":"1","input":1,"expected":"'), Buffer.from([0x93, 0x8c, 0x8b, 0x9e]), Buffer.from('"}\n')]));
  let problems = [];
  readCases(path.join(dir, 'g'), problems, dir);
  assert.deepEqual(problems, ['g/a.jsonl is not UTF-8 (Shift_JIS or another code page?); write it as UTF-8']);
  fs.writeFileSync(path.join(dir, 'g/a.jsonl'), Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('{"id":"1","input":1,"expected":1}\n', 'utf16le')]));
  problems = [];
  readCases(path.join(dir, 'g'), problems, dir);
  assert.match(problems[0], /g\/a\.jsonl is UTF-16; write it as UTF-8/);
  write(dir, 'g/a.jsonl', '{"id":"1","input":1,"expected":"東京"}\n');
  write(dir, 'd.cjs', 'process.stdin.resume(); process.stdin.on("end", () => { process.stdout.write(Buffer.concat([Buffer.from(\'{"id":"1","output":"\'), Buffer.from([0x8b, 0x9e, 0x93, 0x8c]), Buffer.from(\'"}\\n\')])); console.error("sjis out"); });\n');
  const r = await compare({ cases: 'g', driver: node('d.cjs'), cwd: dir });
  assert.equal(r.ok, false);
  assert.match(r.problems.join(), /the driver output is not UTF-8/);
  assert.match(report(r), /sjis out/, 'the driver output is shown when it could not be read');
});

test('a rules.json below the cases folder is reported, not silently ignored', () => {
  const dir = tempDir();
  write(dir, 'g/a/x.jsonl', '{"id":"1","input":1,"expected":1}\n');
  write(dir, 'g/a/rules.json', '{"trim":true}');
  const problems = [];
  readCases(path.join(dir, 'g'), problems, dir);
  assert.deepEqual(problems, ['g/a/rules.json is not read: only the cases folder\'s own rules.json counts']);
});

test('unordered arrays of many rows compare quickly, and fixed-index rules still apply', () => {
  const n = 20000;
  const e = { rows: Array.from({ length: n }, (_, i) => ({ id: i, v: `r${i}` })) };
  const a = { rows: [...e.rows].reverse() };
  const started = Date.now();
  assert.deepEqual(differences(e, a, rules({ unordered: ['$.rows'] })), []);
  assert.ok(Date.now() - started < 5000, `${Date.now() - started} ms`);
  a.rows[0] = { id: -1, v: 'x' };
  assert.equal(differences(e, a, rules({ unordered: ['$.rows'] })).length, 1);
  // A rule with a fixed index: rows pair up one by one, by their real index.
  const fixed = rules({ unordered: ['$.rows'], ignore: ['$.rows[0].v'] });
  assert.equal(fixed.byKey, false);
  assert.equal(differences({ rows: [{ v: 1 }, { v: 2 }] }, { rows: [{ v: 2 }, { v: 3 }] }, fixed).length, 1);
});

test('a driver that runs too long is stopped and the comparison fails', async () => {
  const dir = tempDir();
  golden(dir, { driver: 'setTimeout(() => {}, 60000);\n' });
  const r = await compare({ cases: 'tests/golden/calc', driver: node('tests/golden/driver.cjs'), cwd: dir, timeoutMs: 1000 });
  assert.equal(r.ok, false);
  assert.equal(r.timedOut, true);
  assert.match(r.problems.join(), /the driver timed out/);
});

test('a command can be given input on stdin, and stdout is kept whole', async () => {
  const dir = tempDir();
  write(dir, 'echo.cjs', 'let s = ""; process.stdin.on("data", (d) => { s += d; }); process.stdin.on("end", () => { process.stdout.write(s.toUpperCase() + "x".repeat(300000)); });\n');
  const r = await runCommand('node echo.cjs', dir, { input: 'héllo\n', captureStdout: true });
  assert.equal(r.exitCode, 0, r.output);
  const out = r.stdout.toString('utf8');
  assert.ok(out.startsWith('HÉLLO\n'));
  assert.equal(out.length, 6 + 300000, 'not cut to the tail');
  // Without input, stdin is closed and the command does not wait for it.
  const none = await runCommand('node echo.cjs', dir, { captureStdout: true, timeoutMs: 10000 });
  assert.equal(none.timedOut, false);
});

test('on Windows, input goes to the command through a pipe', async () => {
  const calls = [];
  const exec = (file, args, options) => {
    calls.push(options.stdio);
    let written = '';
    return { pid: 1, stdin: { on() {}, end(text) { written = text; } }, stdout: { on(event, fn) { if (event === 'data') setImmediate(() => fn(Buffer.from(`${written}`))); } }, stderr: { on() {} }, on(event, fn) { if (event === 'exit' || event === 'close') setTimeout(() => fn(0), 5); } };
  };
  const r = await runCommand('node d.js', 'C:/repo/ts', { platform: 'win32', exec, input: '{"id":"a"}\n', captureStdout: true });
  assert.deepEqual(calls[0], ['pipe', 'pipe', 'pipe']);
  assert.equal(r.stdout.toString(), '{"id":"a"}\n');
});
