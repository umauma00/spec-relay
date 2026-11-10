// End-to-end checks against the real OpenSpec CLI. Skipped when it is not installed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { main, bypassFiles, STUB_MARKER, SCHEMAS } from '../scripts/setup.mjs';
import { checkReview, checkPortReady, checkPortDone, baselineHash } from '../scripts/gate.mjs';
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
  for (const schema of SCHEMAS) openspec(dir, 'schema', 'validate', schema);
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

// Writes every artifact of a change, then checks OpenSpec counts them all done.
function fill(dir, change, files) {
  for (const [rel, text] of Object.entries(files)) write(dir, `openspec/changes/${change}/${rel}`, text);
  const status = JSON.parse(openspec(dir, 'status', '--change', change, '--json'));
  assert.ok(status.artifacts.every((a) => a.status === 'done'), JSON.stringify(status.artifacts));
  openspec(dir, 'validate', change, '--strict');
}

test('survey -> target design -> extract -> review gate -> archive -> port -> amend', { skip: !hasOpenspec && 'openspec CLI not installed' }, () => {
  const dir = setUp();
  write(dir, 'src/calc.py', 'def add(a, b):\n    return a + b\n');
  const steps = () => progress(dir).todoList.slice(1).map((item) => item.status);
  const keys = () => progress(dir).todoList.slice(1).map((item) => item.key);

  // 1. Survey: contexts, inventory, capabilities. No spec deltas.
  openspec(dir, 'new', 'change', 'survey', '--schema', 'spec-relay-survey');
  assert.deepEqual(keys(), ['survey', 'target']);
  fill(dir, 'survey', {
    'inventory.md': '| Path | Context | Notes |\n|---|---|---|\n| src/ | calc | |\n',
    'context-map.md': '## Contexts\n\n### Context: platform\n- generic\n\n### Context: calc\n- core\n',
    'glossary.md': '# Glossary\n',
    'capabilities.md': '# Capabilities\n\n### calc\n1. `calc/add` 足し算\n',
    'review.md': 'Reviewer: Uma\n\n- [x] K1 platform\n- [x] K2 calc\n- [x] C1 inventory\n',
  });
  assert.deepEqual(checkReview(dir, 'survey'), { ok: true, problems: [] });
  openspec(dir, 'archive', 'survey', '--yes');
  write(dir, 'openspec/spec-relay/plan.md', '## Capabilities\n\n### calc\n1. `calc/add` 足し算\n');

  // 2. Target design.
  openspec(dir, 'new', 'change', 'target-design', '--schema', 'spec-relay-target');
  fill(dir, 'target-design', {
    'architecture.md': '| Context | Module path |\n|---|---|\n| platform | ts/platform |\n| calc | ts/calc |\n',
    'conventions.md': '# Conventions\n',
    'verification.md': '| Context | A |\n|---|---|\n| platform | yes |\n| calc | yes |\n',
    'review.md': 'Reviewer: Uma\n\n- [x] A0 style\n- [x] A1 platform\n- [x] A2 calc\n- [x] E1 platform: levels\n- [x] E2 calc: levels\n',
  });
  assert.deepEqual(checkReview(dir, 'target-design'), { ok: true, problems: [] });
  openspec(dir, 'archive', 'target-design', '--yes');
  assert.deepEqual(keys(), ['calc/add:analyze', 'calc/add:review', 'calc/add:implement']);

  // 3. Extract, with CRLF and a UTF-8 BOM as Windows editors write them.
  openspec(dir, 'new', 'change', 'extract-calc-add', '--schema', 'spec-relay-extract');
  const review = (box) => crlf(`﻿# Review\n\nReviewer: Uma\n\n## 1. Requirements\n- [${box}] R1 Add two numbers\n`);
  fill(dir, 'extract-calc-add', {
    'source-map.md': '# Source map\n',
    'specs/calc/add/spec.md': crlf(SPEC),
    'screens.md': '# Screens\r\n\r\nNone\r\n',
    'trace.md': '# Trace\r\n',
    'crosscheck.md': '| Item | Verdict | Evidence |\n|---|---|---|\n| R1 Add two numbers | confirmed | src/calc.py:2 |\n',
    'questions.md': '﻿# Questions\r\n',
    'review.md': review(' '),
  });
  assert.equal(checkReview(dir, 'extract-calc-add').ok, false);
  assert.equal(checkPortReady(dir, 'calc/add').ok, false);
  write(dir, 'openspec/changes/extract-calc-add/review.md', review('x'));
  assert.deepEqual(checkReview(dir, 'extract-calc-add'), { ok: true, problems: [] });
  assert.deepEqual(steps(), ['completed', 'not-started', 'not-started']);
  assert.equal(progress(dir).current.step, 'review');
  openspec(dir, 'archive', 'extract-calc-add', '--yes');
  // The real archive folder name (YYYY-MM-DD-<change>) and baseline layout.
  assert.deepEqual(steps(), ['completed', 'completed', 'not-started']);
  assert.match(fs.readFileSync(path.join(dir, 'openspec/specs/calc/add/spec.md'), 'utf8'), /Requirement: Add two numbers/);

  // 4. Port.
  assert.deepEqual(checkPortReady(dir, 'calc/add'), { ok: true, problems: [] });
  openspec(dir, 'new', 'change', 'port-calc-add', '--schema', 'spec-relay-port');
  assert.match(fs.readFileSync(path.join(dir, 'openspec/changes/port-calc-add/.openspec.yaml'), 'utf8'), /skip_specs: true/);
  const next = JSON.parse(openspec(dir, 'status', '--change', 'port-calc-add', '--json'));
  assert.deepEqual(next.artifacts.map((a) => a.id), ['proposal', 'design', 'tasks']);
  const hash = baselineHash(dir, 'calc/add');
  write(dir, 'openspec/changes/port-calc-add/proposal.md', `## Baseline\n- \`calc/add\` sha256:${hash}\n`);
  write(dir, 'openspec/changes/port-calc-add/design.md', '# design\n');
  write(dir, 'openspec/changes/port-calc-add/tasks.md', '# Tasks\n\n## 1. Core\n\n- [ ] 1.1 Implement add; verify with its test\n');
  assert.equal(checkPortDone(dir, 'port-calc-add').ok, false);
  // No task ticked yet: the design waits for the person's agreement.
  assert.deepEqual(steps(), ['completed', 'completed', 'not-started']);
  write(dir, 'openspec/changes/port-calc-add/tasks.md', '# Tasks\n\n## 1. Core\n\n- [x] 1.1 Implement add; verify with its test\n');
  assert.deepEqual(checkPortDone(dir, 'port-calc-add'), { ok: true, problems: [] });
  openspec(dir, 'archive', 'port-calc-add', '--yes');
  assert.deepEqual(progress(dir).todoList.map((item) => item.status), ['completed']);

  // 5. Amend: OpenSpec merges the MODIFIED requirement into the baseline, which
  // changes the hash a later port must record.
  openspec(dir, 'new', 'change', 'amend-calc-add', '--schema', 'spec-relay-amend');
  fill(dir, 'amend-calc-add', {
    'reason.md': '# Reason\n\nThe code truncates (src/calc.py:2).\n',
    'specs/calc/add/spec.md': '## MODIFIED Requirements\n\n### Requirement: Add two numbers\nThe system SHALL return the sum of its two inputs, truncated.\n\n#### Scenario: Positive numbers\n- **GIVEN** the inputs 1 and 2.5\n- **WHEN** the sum is requested\n- **THEN** the result is 3\n',
    'trace.md': '# Trace\n',
    'crosscheck.md': '| Item | Verdict | Evidence |\n|---|---|---|\n| R1 Add two numbers | confirmed | src/calc.py:2 |\n',
    'impact.md': '# Impact\n',
    'review.md': 'Reviewer: Uma\n\n- [x] R1 Add two numbers\n- [x] I1 impact\n',
  });
  assert.equal(progress(dir, { capability: 'calc/add' }).todoList[2].status, 'not-started');
  assert.equal(checkPortReady(dir, 'calc/add').ok, false);
  assert.deepEqual(checkReview(dir, 'amend-calc-add'), { ok: true, problems: [] });
  openspec(dir, 'archive', 'amend-calc-add', '--yes');
  assert.match(fs.readFileSync(path.join(dir, 'openspec/specs/calc/add/spec.md'), 'utf8'), /truncated/);
  assert.notEqual(baselineHash(dir, 'calc/add'), hash);
});
