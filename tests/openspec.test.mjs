// End-to-end checks against the real OpenSpec CLI. Skipped when it is not installed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { main, bypassFiles, STUB_MARKER } from '../scripts/setup.mjs';
import { checkReview, checkPortReady, checkPortDone } from '../scripts/gate.mjs';
import { status as progress } from '../scripts/status.mjs';
import { runOpenspec, probeOpenspec } from '../scripts/openspec.mjs';
import { tempDir, write, quiet, isolateOpenspec, crlf } from './helpers.mjs';

isolateOpenspec();
const probe = probeOpenspec();
const hasOpenspec = probe.ok;
// In CI the CLI is installed, so a skip there would hide every check below.
if (process.env.CI && !hasOpenspec) throw new Error(`OpenSpec is required in CI: ${probe.reason}`);

function openspec(cwd, ...args) {
  const result = runOpenspec(args, { cwd });
  assert.equal(result.status, 0, `openspec ${args.join(' ')}\n${result.stdout}\n${result.stderr}\n${result.error ?? ''}`);
  return result.stdout;
}

const SETUP = ['--source-language', 'Python', '--target-language', 'TypeScript', '--target-root', 'ts'];

function setUp() {
  // A folder name with a space, as in C:\\Users\\Taro Yamada\\...
  const dir = path.join(tempDir('spec-relay-e2e-'), 'my repo');
  fs.mkdirSync(dir);
  // Runs the real `openspec init`.
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
  assert.deepEqual(bypassFiles(dir), []);
  for (const rel of ['.github/skills/openspec-apply-change/SKILL.md', '.github/skills/openspec-archive-change/SKILL.md', '.github/prompts/opsx-archive.prompt.md']) {
    assert.ok(fs.readFileSync(path.join(dir, rel), 'utf8').includes(STUB_MARKER), `${rel} should be a stub`);
  }

  // The stubs keep the files in place, so `openspec update` never narrows the
  // person's global profile. If update restores a workflow, setup disables it again.
  openspec(dir, 'update');
  assert.ok(fs.existsSync(path.join(dir, '.github/skills/openspec-archive-change/SKILL.md')));
  // A Windows checkout (core.autocrlf=true) turns the copied schemas into CRLF.
  // Setup must still recognise them, or it would stop before disabling anything.
  const schema = path.join(dir, 'openspec/schemas/spec-relay-extract/schema.yaml');
  fs.writeFileSync(schema, crlf(fs.readFileSync(schema, 'utf8')));
  assert.equal(quiet(() => main(['--target', dir, ...SETUP, '--apply'])), 0);
  assert.deepEqual(bypassFiles(dir), []);
  openspec(dir, 'schema', 'validate', 'spec-relay-extract');
});

test('extract -> review gate -> archive -> port', { skip: !hasOpenspec && 'openspec CLI not installed' }, () => {
  const dir = setUp();
  openspec(dir, 'new', 'change', 'extract-calc', '--schema', 'spec-relay-extract');
  const change = 'openspec/changes/extract-calc';
  write(dir, `${change}/source-map.md`, '# Source map\n');
  // CRLF and a UTF-8 BOM, as Windows editors write them.
  write(dir, `${change}/specs/calc/spec.md`, crlf(SPEC));
  write(dir, `${change}/trace.md`, '# Trace\r\n');
  write(dir, `${change}/questions.md`, '\uFEFF# Questions\r\n');
  write(dir, `${change}/review.md`, crlf('\uFEFF# Review\n\nReviewer: Uma\n\n## 1. Requirements\n- [ ] R1 Add two numbers\n'));

  const status = JSON.parse(openspec(dir, 'status', '--change', 'extract-calc', '--json'));
  assert.ok(status.artifacts.every((a) => a.status === 'done'), JSON.stringify(status.artifacts));
  openspec(dir, 'validate', 'extract-calc', '--strict');

  // The review gate the skill runs before archiving.
  assert.equal(checkReview(dir, 'extract-calc').ok, false);
  assert.equal(checkPortReady(dir, 'calc').ok, false);
  write(dir, `${change}/review.md`, crlf('\uFEFFReviewer: Uma\n\n## 1. Requirements\n- [x] R1 Add two numbers\n'));
  assert.deepEqual(checkReview(dir, 'extract-calc'), { ok: true, problems: [] });

  const steps = () => progress(dir).todoList.slice(1).map((item) => item.status);
  assert.deepEqual(steps(), ['completed', 'not-started', 'not-started']);
  assert.equal(progress(dir).current.step, 'review');
  openspec(dir, 'archive', 'extract-calc', '--yes');
  // The real archive folder name (YYYY-MM-DD-<change>) and baseline layout.
  assert.deepEqual(steps(), ['completed', 'completed', 'not-started']);
  assert.match(fs.readFileSync(path.join(dir, 'openspec/specs/calc/spec.md'), 'utf8'), /Requirement: Add two numbers/);

  assert.deepEqual(checkPortReady(dir, 'calc'), { ok: true, problems: [] });
  openspec(dir, 'new', 'change', 'port-calc', '--schema', 'spec-relay-port');
  assert.match(fs.readFileSync(path.join(dir, 'openspec/changes/port-calc/.openspec.yaml'), 'utf8'), /skip_specs: true/);
  const next = JSON.parse(openspec(dir, 'status', '--change', 'port-calc', '--json'));
  assert.deepEqual(next.artifacts.map((a) => a.id), ['proposal', 'design', 'tasks']);
  write(dir, 'openspec/changes/port-calc/tasks.md', '# Tasks\n\n## 1. Core\n\n- [ ] 1.1 Implement add; verify with its test\n');
  assert.equal(checkPortDone(dir, 'port-calc').ok, false);
  assert.deepEqual(steps(), ['completed', 'completed', 'in-progress']);
  write(dir, 'openspec/changes/port-calc/tasks.md', '# Tasks\n\n## 1. Core\n\n- [x] 1.1 Implement add; verify with its test\n');
  for (const file of ['proposal.md', 'design.md']) write(dir, `openspec/changes/port-calc/${file}`, `# ${file}\n`);
  openspec(dir, 'archive', 'port-calc', '--yes');
  assert.deepEqual(progress(dir).todoList.map((item) => item.status), ['completed']);
});
