import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { recordSteps, readEvents, summarize, markdown, duration, hookRecord, hook, namedChanges, main, METRICS } from '../scripts/metrics.mjs';
import { main as statusMain, status } from '../scripts/status.mjs';
import { tempDir, write, quiet } from './helpers.mjs';

const KIT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CONFIG = '# spec-relay: managed by scripts/setup.mjs. Edit the values; keep this line.\nschema: spec-relay-extract\n\ncontext: |\n  Source root (read-only; only openspec/ and the target root may change): src\n  Target root (new implementation): ts\n  Artifact language: ja\n';

function repo(extra = '') {
  const dir = tempDir();
  write(dir, 'openspec/config.yaml', CONFIG + extra);
  return dir;
}
const at = (iso) => new Date(iso);
const report = (states, capability = 'billing/invoice') => ({
  foundation: [{ id: 'survey', status: 'completed' }, { id: 'target', status: 'completed' }],
  capabilities: [{ capability, steps: states }],
});
const steps = (analyze, review = { status: 'not-started' }, implement = { status: 'not-started' }) => ({ analyze, review, implement });
const run = (fn) => {
  let out = '';
  const log = console.log;
  console.log = (x) => { out += x; };
  try { fn(); } finally { console.log = log; }
  return out;
};

test('step records: one per change of state, time in progress apart from waiting for the person', () => {
  const dir = repo();
  // The finished survey and target design are recorded once as they are; a step not started is not.
  assert.deepEqual(recordSteps(dir, report(steps({ status: 'in-progress' })), at('2026-11-16T00:00:00Z')).map((e) => `${e.capability ?? '-'} ${e.step} ${e.state}`), ['- survey completed', '- target completed', 'billing/invoice analyze in-progress']);
  // The same state again writes nothing.
  assert.equal(recordSteps(dir, report(steps({ status: 'in-progress' })), at('2026-11-16T00:10:00Z')).length, 0);
  recordSteps(dir, report(steps({ status: 'completed' }, { status: 'not-started', waiting: true })), at('2026-11-16T01:30:00Z'));
  recordSteps(dir, report(steps({ status: 'completed' }, { status: 'completed' })), at('2026-11-16T03:30:00Z'));
  const summary = summarize(readEvents(dir), at('2026-11-16T04:00:00Z'));
  const row = (step) => summary.steps.find((x) => x.capability === 'billing/invoice' && x.step === step);
  assert.equal(row('analyze').agent, 90 * 60000);
  assert.equal(row('review').person, 120 * 60000);
  assert.equal(row('review').agent, 0);
  // Steps first seen as completed (recording began later) have no row.
  assert.equal(summary.steps.length, 2);
  // The finish step is the project's.
  recordSteps(dir, { ...report(steps({ status: 'completed' }, { status: 'completed' }, { status: 'completed' })), finish: { status: 'in-progress' } }, at('2026-11-17T00:00:00Z'));
  assert.match(markdown(summarize(readEvents(dir), at('2026-11-17T01:00:00Z')), 'ja'), /\| （プロジェクト全体） \| 仕上げ \| 1時間 \| - \|/);
  // Records stay out of git.
  assert.match(fs.readFileSync(path.join(dir, 'openspec/spec-relay/local/.gitignore'), 'utf8'), /^\*$/m);
});

test('a step that disappears from the report is closed, not left running', () => {
  const dir = repo();
  recordSteps(dir, report(steps({ status: 'in-progress' }), 'billing-invoice'), at('2026-11-16T00:00:00Z'));
  // The spec now exists, so status names the capability by its path.
  const written = recordSteps(dir, report(steps({ status: 'in-progress' })), at('2026-11-16T00:30:00Z'));
  assert.ok(written.some((e) => e.capability === 'billing-invoice' && e.state === 'gone'));
  const summary = summarize(readEvents(dir), at('2026-11-26T00:00:00Z'));
  assert.equal(summary.steps.find((s) => s.capability === 'billing-invoice').agent, 30 * 60000);
});

test('recording is off with "Record metrics: off" or any value but on, and outside a spec-relay repository', () => {
  for (const value of ['off', 'disabled', '0', '']) {
    const dir = repo(`  Record metrics: ${value}\n`);
    assert.deepEqual(recordSteps(dir, report(steps({ status: 'in-progress' }))), []);
    hook('subagent-start', JSON.stringify({ cwd: dir, sessionId: 's', agentName: 'spec-relay-analyst', timestamp: Date.now() }));
    assert.equal(quiet(() => main(['note', '--text', 'x', '--root', dir])), 1);
    assert.equal(fs.existsSync(path.join(dir, METRICS)), false, value);
    // A note's file in local/ stays out of git even when nothing is recorded.
    assert.ok(fs.existsSync(path.join(dir, 'openspec/spec-relay/local/.gitignore')), value);
  }
  assert.equal(recordSteps(repo('  Record metrics (on or off; the time of each step, kept on this machine only): on\n'), report(steps({ status: 'in-progress' }))).length, 3);
  const plain = tempDir();
  write(plain, 'openspec/config.yaml', 'schema: spec-driven\n');
  assert.deepEqual(recordSteps(plain, report(steps({ status: 'in-progress' }))), []);
  assert.equal(fs.existsSync(path.join(plain, 'openspec/spec-relay')), false);
});

test('status.mjs records step changes and prints the same output with recording on, off or broken', () => {
  const output = (dir, format) => run(() => statusMain(['--format', format, '--root', dir]));
  const make = (extra) => {
    const dir = repo(extra);
    write(dir, 'openspec/changes/survey/.openspec.yaml', 'schema: spec-relay-survey\n');
    return dir;
  };
  const on = make('');
  const off = make('  Record metrics: off\n');
  const broken = make('');
  fs.mkdirSync(path.join(broken, METRICS), { recursive: true });
  for (const format of ['todo', 'json', 'markdown']) {
    const expected = output(off, format);
    assert.equal(output(on, format).replaceAll(on, off), expected, format);
    assert.equal(output(broken, format).replaceAll(broken, off), expected, format);
  }
  assert.ok(readEvents(on).some((e) => e.kind === 'step' && e.capability === undefined && e.step === 'survey'));
  // The foundation ids status prints are the ones the report names.
  const ids = status(on).foundation.map((f) => f.id);
  const md = markdown(summarize(readEvents(on), new Date(Date.now() + 3600000)), 'ja');
  assert.deepEqual(ids, ['survey', 'target']);
  assert.match(md, /\| （プロジェクト全体） \| 調査 \| 1時間/);
});

test('subagent runs: only the kit\'s agents, paired per session and agent, counted for the change they name', () => {
  const dir = repo();
  const base = { cwd: dir, sessionId: 'host-session-1', agentName: 'spec-relay-analyst' };
  const ms = (iso) => Date.parse(iso);
  recordSteps(dir, report(steps({ status: 'in-progress' })), at('2026-11-16T00:00:00Z'));
  // A start whose stop was lost does not stretch the later runs.
  hook('subagent-start', JSON.stringify({ ...base, timestamp: ms('2026-11-16T00:00:00Z') }));
  hook('subagent-start', JSON.stringify({ ...base, timestamp: ms('2026-11-16T05:00:00Z') }));
  hook('subagent-stop', JSON.stringify({ ...base, timestamp: ms('2026-11-16T05:10:00Z'), transcriptPath: '/home/u/.copilot/session-state/x.jsonl', response: 'Wrote openspec/changes/extract-billing-invoice/source-map.md' }));
  // A BOM from PowerShell 5.1, a Windows path, and a timestamp in seconds.
  hook('subagent-start', `\uFEFF${JSON.stringify({ ...base, timestamp: ms('2026-11-16T08:00:00Z') / 1000 })}`);
  hook('subagent-stop', `\uFEFF${JSON.stringify({ ...base, timestamp: ms('2026-11-16T08:10:00Z') / 1000, response: 'Wrote openspec\\spec-relay\\work\\extract-billing-invoice\\crosscheck-01.md' })}`);
  // No change named: the one capability in progress.
  hook('subagent-start', JSON.stringify({ ...base, agentName: 'spec-relay-checker', timestamp: ms('2026-11-16T09:00:00Z') }));
  hook('subagent-stop', JSON.stringify({ ...base, agentName: 'spec-relay-checker', timestamp: ms('2026-11-16T09:05:00Z'), response: 'All confirmed.' }));
  // Other agents (and the orchestrator itself) are not recorded.
  for (const agentName of ['spec-relay-orchestrator', 'my-agent']) hook('subagent-start', JSON.stringify({ ...base, agentName }));
  const events = readEvents(dir);
  assert.equal(events.filter((e) => e.kind === 'subagent-start').length, 4);
  assert.ok(events.every((e) => !/transcript|host-session|copilot/.test(JSON.stringify(e))));
  assert.ok(events.every((e) => e.t.startsWith('2026-11-16')));
  const [runs] = summarize(events, at('2026-11-16T10:00:00Z')).subagents;
  assert.deepEqual(runs, { capability: 'billing/invoice', attributed: true, runs: 3, ms: 25 * 60000 });

  assert.deepEqual(namedChanges('see openspec/changes/survey/inventory.md, openspec/changes/port-billing-invoice-v2/tasks.md and openspec/changes/finish/checks.md'), ['survey', 'port-billing-invoice-v2', 'finish']);
  assert.equal(hookRecord('other', { agentName: 'spec-relay-analyst' }), null);
  assert.equal(hookRecord('subagent-start', { agentName: 'spec-relay:spec-relay-implementer' }).agent, 'spec-relay-implementer');
  assert.equal(hookRecord('subagent-start', { agentName: '', agentType: 'spec-relay-checker' }).agent, 'spec-relay-checker');
  const plain = tempDir();
  hook('subagent-start', JSON.stringify({ ...base, cwd: plain }));
  assert.equal(fs.existsSync(path.join(plain, METRICS)), false);
});

test('a run that names no change goes to the capability whose step that agent works on, or to none', () => {
  const t = (iso) => at(iso).toISOString();
  const events = [
    { t: t('2026-11-16T00:00:00Z'), kind: 'step', capability: 'a/x', step: 'implement', state: 'not-started:waiting' },
    { t: t('2026-11-16T00:00:00Z'), kind: 'step', capability: 'b/y', step: 'analyze', state: 'in-progress' },
    // A start 2 days old whose stop never came is dropped, not paired.
    { t: t('2026-11-14T00:00:00Z'), kind: 'subagent-start', agent: 'spec-relay-implementer', session: 's' },
    { t: t('2026-11-16T01:00:00Z'), kind: 'subagent-stop', agent: 'spec-relay-implementer', session: 's' },
    { t: t('2026-11-16T02:00:00Z'), kind: 'subagent-start', agent: 'spec-relay-implementer', session: 's' },
    { t: t('2026-11-16T02:40:00Z'), kind: 'subagent-stop', agent: 'spec-relay-implementer', session: 's' },
    { t: t('2026-11-16T03:00:00Z'), kind: 'subagent-start', agent: 'spec-relay-analyst', session: 's' },
    { t: t('2026-11-16T03:20:00Z'), kind: 'subagent-stop', agent: 'spec-relay-analyst', session: 's' },
    { t: t('2026-11-16T04:00:00Z'), kind: 'step', capability: 'c/z', step: 'analyze', state: 'in-progress' },
    { t: t('2026-11-16T05:00:00Z'), kind: 'subagent-start', agent: 'spec-relay-checker', session: 's' },
    { t: t('2026-11-16T05:10:00Z'), kind: 'subagent-stop', agent: 'spec-relay-checker', session: 's' },
  ];
  const runs = summarize(events, at('2026-11-16T06:00:00Z')).subagents;
  assert.deepEqual(runs.find((r) => r.capability === 'a/x'), { capability: 'a/x', attributed: true, runs: 2, ms: 40 * 60000 });
  assert.deepEqual(runs.find((r) => r.capability === 'b/y'), { capability: 'b/y', attributed: true, runs: 1, ms: 20 * 60000 });
  // Two capabilities being analyzed: the checker's run is not guessed.
  assert.deepEqual(runs.find((r) => !r.attributed), { capability: null, attributed: false, runs: 1, ms: 10 * 60000 });
});

test('the report reads in the person\'s language and as ASCII JSON; notes come from a file', () => {
  const dir = repo();
  recordSteps(dir, report(steps({ status: 'in-progress' })), at('2026-11-16T00:00:00Z'));
  recordSteps(dir, report(steps({ status: 'completed' }, { status: 'not-started', waiting: true })), at('2026-11-16T02:05:00Z'));
  const md = markdown(summarize(readEvents(dir), at('2026-11-17T03:05:00Z')), 'ja');
  assert.match(md, /\| `billing\/invoice` \| 解析 \| 2時間5分 \| - \|/);
  assert.match(md, /\| `billing\/invoice` \| レビュー \| - \| 1日1時間 \|/);
  assert.match(md, /\| \*\*合計\*\* \| \| \*\*2時間5分\*\* \| \*\*1日1時間\*\* \|/);
  assert.match(md, /2026-11-16 00:00 UTC から/);
  assert.match(md, /トークン数を渡しません/);
  assert.equal(duration(30 * 1000, 'en'), '<1m');
  assert.equal(duration(0, 'en'), '-');
  assert.match(markdown(summarize([]), 'en'), /Nothing recorded yet/);

  const out = run(() => assert.equal(main(['report', '--format', 'json', '--root', dir]), 0));
  assert.match(out, /^[\x00-\x7e]*$/);
  assert.match(JSON.parse(out).markdown, /かかった時間/);
  assert.match(run(() => main(['report', '--language', 'en', '--root', dir])), /Time spent/);

  write(dir, 'openspec/spec-relay/local/usage.txt', '\uFEFFclaude-sonnet  120k in, 30k out\n$total "quoted" `tick`\n');
  assert.equal(quiet(() => main(['note', '--file', 'openspec/spec-relay/local/usage.txt', '--capability', 'billing/invoice', '--root', dir])), 0);
  assert.match(markdown(summarize(readEvents(dir)), 'en'), /`billing\/invoice`: claude-sonnet {2}120k in, 30k out \/ \$total "quoted" `tick`/);
  assert.equal(quiet(() => main(['note', '--file', 'missing.txt', '--root', dir])), 2);
  assert.equal(quiet(() => main(['note', '--root', dir])), 2);
  assert.equal(quiet(() => main(['report', '--format', 'html', '--root', dir])), 2);
  // A torn or bad line is skipped.
  fs.appendFileSync(path.join(dir, METRICS), '{"t":"not a time","kind":"step"}\n{"t":\n');
  assert.ok(readEvents(dir).every((e) => Number.isFinite(Date.parse(e.t))));
});

test('hooks.json records subagent runs through the platform shell and never exits non-zero', () => {
  const config = JSON.parse(fs.readFileSync(path.join(KIT, 'com.github.copilot/hooks/hooks.json'), 'utf8'));
  for (const [event, kind] of [['subagentStart', 'subagent-start'], ['subagentStop', 'subagent-stop']]) {
    const [entry] = config.hooks[event];
    assert.match(entry.bash, new RegExp(`metrics\\.mjs" hook ${kind} \\|\\| true$`));
    assert.match(entry.powershell, new RegExp(`metrics\\.mjs" hook ${kind}; exit 0$`));
    const dir = repo();
    const payload = JSON.stringify({ cwd: dir, sessionId: 's', agentName: 'spec-relay-checker', timestamp: Date.now() });
    const shells = process.platform === 'win32'
      ? [['powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', entry.powershell]], ['pwsh', ['-NoProfile', '-NonInteractive', '-Command', entry.powershell]]]
      : [['bash', ['-c', entry.bash]]];
    for (const [exe, args] of shells) {
      if (spawnSync(exe, [...args.slice(0, -1), 'exit 0'], { encoding: 'utf8' }).error) continue;
      const ran = spawnSync(exe, args, { env: { ...process.env, PLUGIN_ROOT: KIT }, input: payload, encoding: 'utf8' });
      assert.equal(ran.status, 0, exe);
      assert.equal(ran.stdout.trim(), '', exe);
      assert.ok(readEvents(dir).some((e) => e.kind === kind), exe);
      const missing = spawnSync(exe, args, { env: { ...process.env, PLUGIN_ROOT: path.join(KIT, 'nonexistent') }, input: payload, encoding: 'utf8' });
      assert.equal(missing.status, 0, exe);
    }
  }
});
