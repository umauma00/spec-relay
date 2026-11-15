// A repository with one port change that passes gate.mjs port-done, for the
// tests of the port's evidence (verify run, scenario tags, TODO(port), crosscheck).
import fs from 'node:fs';
import path from 'node:path';
import { baselineHash, targetHash, targetHashes, targetFiles } from '../scripts/gate.mjs';
import { tempDir, write } from './helpers.mjs';

export const PORT = 'openspec/changes/port-calc-add';
export const PORT_SPEC = '## Purpose\n\nAdds numbers for the calculator.\n\n## Requirements\n\n### Requirement: Add two numbers\nThe system SHALL add.\n\n#### Scenario: Positive numbers\n- **WHEN** 1 and 2\n- **THEN** 3\n\n#### Scenario: Negative numbers\n- **WHEN** -1 and -2\n- **THEN** -3\n\n### Requirement: Reject text\nThe system SHALL reject text.\n\n#### Scenario: Text input\n- **WHEN** "a"\n- **THEN** an error\n';
export const PORT_CROSSCHECK = '| Item | Verdict | Evidence |\n|---|---|---|\n| R1 Add two numbers | confirmed | src/calc.py:2 vs ts/calc/add.ts:3 |\n| R2 Reject text | confirmed | src/calc.py:5 vs ts/calc/add.ts:8 |\n| S1 Calculator | confirmed | src/calc.php:1 vs ts/calc/page.ts:1 |\n';
export const CODE = 'export function add(a, b) {\n  return a + b;\n}\n';
export const TESTS = [
  '// spec-relay: calc/add | Add two numbers | Positive numbers',
  'test("spec-relay: calc/add | Add two numbers | Negative numbers", () => {});',
  '# spec-relay: calc/add | Reject text | Text input',
].join('\n');

export function config(dir, target = 'ts') {
  write(dir, 'openspec/config.yaml', `# spec-relay: managed\nschema: spec-relay-extract\ncontext: |\n  Source root (existing code): src\n  Target root (new implementation): ${target}\n`);
}

// Writes the receipt verify.mjs would write after a run on the current code.
export function receipt(dir, runs, change = 'port-calc-add') {
  const files = targetFiles(dir);
  const hashes = targetHashes(dir, files);
  write(dir, `openspec/changes/${change}/verify.json`, `${JSON.stringify({ kit: 'spec-relay', change, ok: runs.every((r) => r.exitCode === 0), target: { count: files.length, sha256: targetHash(dir, files, hashes), files: hashes }, runs }, null, 2)}\n`);
}

// Writes crosscheck.md as merge.mjs leaves it: stamped with the current code's hash.
export function crosscheck(dir, text = PORT_CROSSCHECK, change = 'port-calc-add') {
  write(dir, `openspec/changes/${change}/crosscheck.md`, `# Crosscheck\n\n<!-- spec-relay: code checked sha256:${targetHash(dir)} -->\n\n${text}`);
}

// Both, after a change to the code: the checkers and verify.mjs ran again.
export function refresh(dir, runs = RUNS) {
  crosscheck(dir);
  receipt(dir, runs);
}

export const RUNS = [
  { level: 'A', command: 'node test.js', exitCode: 0, seconds: 1, timedOut: false },
  { level: 'boundary', command: 'node boundary.js', exitCode: 0, seconds: 1, timedOut: false },
];

export function portRepo({ levels = 'no', designCommand = '' } = {}) {
  const dir = tempDir();
  config(dir);
  write(dir, 'src/calc.py', 'def add(a, b):\n    return a + b\n');
  write(dir, 'openspec/changes/archive/2026-11-01-survey/context-map.md', '### Context: calc\n');
  write(dir, 'openspec/changes/archive/2026-11-02-target-design/architecture.md', '| Context | Module |\n|---|---|\n| calc | ts/calc |\n');
  write(dir, 'openspec/changes/archive/2026-11-02-target-design/conventions.md', '# Conventions\n\n## Commands\n| Purpose | Command |\n|---|---|\n| Build | `npm run build` |\n| Test | `node test.js` |\n| Lint | |\n| Boundary check | `node boundary.js` |\n');
  write(dir, 'openspec/changes/archive/2026-11-02-target-design/verification.md', `# Verification\n\n## Levels\n| Context | A scenario tests | B1 logic comparison | B2 screen replay | C screenshots | Notes |\n|---|---|---|---|---|---|\n| calc | yes | ${levels} | no | no | |\n`);
  write(dir, 'openspec/changes/archive/2026-11-03-extract-calc-add/screens.md', '# Screens\n\n### Screen: Calculator\n- labels\n');
  write(dir, 'openspec/specs/calc/add/spec.md', PORT_SPEC);
  write(dir, `${PORT}/.openspec.yaml`, 'schema: spec-relay-port\n');
  write(dir, `${PORT}/proposal.md`, `## Baseline\n- \`calc/add\` sha256:${baselineHash(dir, 'calc/add')}\n`);
  write(dir, `${PORT}/design.md`, `## Verification\n| Level | Covers | Command |\n|---|---|---|\n| A scenario tests | every scenario | |\n${designCommand}`);
  write(dir, `${PORT}/tasks.md`, '# Tasks\n\n## 1. Core\n- [x] 1.1 add\n');
  write(dir, 'ts/calc/add.ts', CODE);
  write(dir, 'ts/calc/add.test.ts', TESTS);
  write(dir, 'ts/test.js', 'process.exit(0);\n');
  write(dir, 'ts/boundary.js', 'process.exit(0);\n');
  refresh(dir);
  return dir;
}

export const remove = (dir, rel) => fs.rmSync(path.join(dir, rel), { recursive: true, force: true });
