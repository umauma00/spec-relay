// End-to-end checks against the real OpenSpec CLI. Skipped when it is not installed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { main, BYPASS_FILES } from '../scripts/setup.mjs';
import { checkReview, checkPortReady, checkPortDone } from '../scripts/gate.mjs';
import { tempDir, write, quiet } from './helpers.mjs';

const env = { ...process.env, OPENSPEC_TELEMETRY: '0', NO_COLOR: '1' };
const shell = process.platform === 'win32';
const hasOpenspec = spawnSync('openspec', ['--version'], { env, shell }).status === 0;

function openspec(cwd, ...args) {
  const result = spawnSync('openspec', args, { cwd, env, shell, encoding: 'utf8' });
  assert.equal(result.status, 0, `openspec ${args.join(' ')}\n${result.stdout}\n${result.stderr}`);
  return result.stdout;
}

const SETUP = ['--source-language', 'Python', '--target-language', 'TypeScript', '--target-root', 'ts'];

function setUp() {
  const dir = tempDir('spec-relay-e2e-');
  // Runs the real `openspec init`, with the process env (telemetry is off in CI).
  assert.equal(quiet(() => main(['--target', dir, ...SETUP, '--apply'])), 0);
  return dir;
}

const SPEC = `# Spec Delta

## Purpose

Provides addition of two numbers for callers that need an exact sum.

## ADDED Requirements

### Requirement: Add two numbers
The system SHALL return the sum of its two inputs.

#### Scenario: Positive numbers
- **GIVEN** the inputs 1 and 2
- **WHEN** the sum is requested
- **THEN** the result is 3
`;

test('setup runs openspec init, keeps the config and removes the gate-bypassing workflows', { skip: !hasOpenspec && 'openspec CLI not installed' }, () => {
  const dir = setUp();
  for (const schema of ['spec-relay-extract', 'spec-relay-port']) openspec(dir, 'schema', 'validate', schema);
  assert.match(fs.readFileSync(path.join(dir, 'openspec/config.yaml'), 'utf8'), /spec-relay: managed[\s\S]*Source language: Python/);
  assert.ok(fs.existsSync(path.join(dir, '.github/skills/openspec-propose/SKILL.md')));
  for (const rel of BYPASS_FILES) assert.ok(!fs.existsSync(path.join(dir, rel)), `${rel} should be removed`);
  assert.ok(!fs.existsSync(path.join(dir, '.github/skills/openspec-apply-change')));

  // `openspec update` brings them back; running setup again removes them again.
  openspec(dir, 'update');
  assert.ok(BYPASS_FILES.some((rel) => fs.existsSync(path.join(dir, rel))));
  assert.equal(quiet(() => main(['--target', dir, ...SETUP, '--apply'])), 0);
  for (const rel of BYPASS_FILES) assert.ok(!fs.existsSync(path.join(dir, rel)), `${rel} should be removed again`);
});

test('extract -> review gate -> archive -> port', { skip: !hasOpenspec && 'openspec CLI not installed' }, () => {
  const dir = setUp();
  openspec(dir, 'new', 'change', 'extract-calc', '--schema', 'spec-relay-extract');
  const change = 'openspec/changes/extract-calc';
  write(dir, `${change}/source-map.md`, '# Source map\n');
  write(dir, `${change}/specs/calc/spec.md`, SPEC);
  write(dir, `${change}/trace.md`, '# Trace\n');
  write(dir, `${change}/questions.md`, '# Questions\n');
  write(dir, `${change}/review.md`, '# Review\n\nReviewer: Uma\n\n## 1. Requirements\n- [ ] R1 Add two numbers\n');

  const status = JSON.parse(openspec(dir, 'status', '--change', 'extract-calc', '--json'));
  assert.ok(status.artifacts.every((a) => a.status === 'done'), JSON.stringify(status.artifacts));
  openspec(dir, 'validate', 'extract-calc', '--strict');

  // The review gate the skill runs before archiving.
  assert.equal(checkReview(dir, 'extract-calc').ok, false);
  assert.equal(checkPortReady(dir, 'calc').ok, false);
  write(dir, `${change}/review.md`, '# Review\n\nReviewer: Uma\n\n## 1. Requirements\n- [x] R1 Add two numbers\n');
  assert.deepEqual(checkReview(dir, 'extract-calc'), { ok: true, problems: [] });

  openspec(dir, 'archive', 'extract-calc', '--yes');
  assert.match(fs.readFileSync(path.join(dir, 'openspec/specs/calc/spec.md'), 'utf8'), /Requirement: Add two numbers/);

  assert.deepEqual(checkPortReady(dir, 'calc'), { ok: true, problems: [] });
  openspec(dir, 'new', 'change', 'port-calc', '--schema', 'spec-relay-port');
  assert.match(fs.readFileSync(path.join(dir, 'openspec/changes/port-calc/.openspec.yaml'), 'utf8'), /skip_specs: true/);
  const next = JSON.parse(openspec(dir, 'status', '--change', 'port-calc', '--json'));
  assert.deepEqual(next.artifacts.map((a) => a.id), ['proposal', 'design', 'tasks']);
  write(dir, 'openspec/changes/port-calc/tasks.md', '# Tasks\n\n## 1. Core\n\n- [ ] 1.1 Implement add; verify with its test\n');
  assert.equal(checkPortDone(dir, 'port-calc').ok, false);
});
