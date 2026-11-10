// End-to-end checks against the real OpenSpec CLI. Skipped when it is not installed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { main } from '../scripts/setup.mjs';

const env = { ...process.env, OPENSPEC_TELEMETRY: '0', NO_COLOR: '1' };
const shell = process.platform === 'win32';
const hasOpenspec = spawnSync('openspec', ['--version'], { env, shell }).status === 0;

function openspec(cwd, ...args) {
  const result = spawnSync('openspec', args, { cwd, env, shell, encoding: 'utf8' });
  assert.equal(result.status, 0, `openspec ${args.join(' ')}\n${result.stdout}\n${result.stderr}`);
  return result.stdout;
}

function setUp() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'spec-relay-e2e-'));
  const { log } = console; console.log = () => {};
  try {
    assert.equal(main(['--target', dir, '--source-language', 'Python', '--target-language', 'TypeScript', '--target-root', 'ts', '--skip-init', '--apply']), 0);
  } finally { console.log = log; }
  return dir;
}

const write = (dir, rel, text) => {
  fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
  fs.writeFileSync(path.join(dir, rel), text);
};

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

test('both schemas validate', { skip: !hasOpenspec && 'openspec CLI not installed' }, () => {
  const dir = setUp();
  for (const schema of ['spec-relay-extract', 'spec-relay-port']) openspec(dir, 'schema', 'validate', schema);
});

test('extract -> review gate -> archive -> port', { skip: !hasOpenspec && 'openspec CLI not installed' }, () => {
  const dir = setUp();
  openspec(dir, 'new', 'change', 'extract-calc', '--schema', 'spec-relay-extract');
  const change = 'openspec/changes/extract-calc';
  write(dir, `${change}/source-map.md`, '# Source map\n');
  write(dir, `${change}/specs/calc/spec.md`, SPEC);
  write(dir, `${change}/trace.md`, '# Trace\n');
  write(dir, `${change}/questions.md`, '# Questions\n');
  write(dir, `${change}/review.md`, '# Review\n\n## 1. Requirements\n- [ ] R1 Add two numbers\n');

  const status = JSON.parse(openspec(dir, 'status', '--change', 'extract-calc', '--json'));
  assert.ok(status.artifacts.every((a) => a.status === 'done'), JSON.stringify(status.artifacts));
  openspec(dir, 'validate', 'extract-calc', '--strict');

  // The review gate the skill checks before archiving.
  const remaining = () => JSON.parse(openspec(dir, 'instructions', 'apply', '--change', 'extract-calc', '--json')).progress.remaining;
  assert.equal(remaining(), 1);
  write(dir, `${change}/review.md`, '# Review\n\n## 1. Requirements\n- [x] R1 Add two numbers\n');
  assert.equal(remaining(), 0);

  openspec(dir, 'archive', 'extract-calc', '--yes');
  assert.match(fs.readFileSync(path.join(dir, 'openspec/specs/calc/spec.md'), 'utf8'), /Requirement: Add two numbers/);

  openspec(dir, 'new', 'change', 'port-calc', '--schema', 'spec-relay-port');
  assert.match(fs.readFileSync(path.join(dir, 'openspec/changes/port-calc/.openspec.yaml'), 'utf8'), /skip_specs: true/);
  const next = JSON.parse(openspec(dir, 'status', '--change', 'port-calc', '--json'));
  assert.deepEqual(next.artifacts.map((a) => a.id), ['proposal', 'design', 'tasks']);
});
