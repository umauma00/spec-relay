import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { decide, main, archiveCalls, editPaths, findRoot } from '../scripts/hook.mjs';
import { tempDir, write } from './helpers.mjs';

const KIT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const HOOK = path.join(KIT, 'scripts/hook.mjs');
const SPEC = '## ADDED Requirements\n\n### Requirement: Add two numbers\nThe system SHALL add.\n\n#### Scenario: s\n- **WHEN** x\n- **THEN** y\n';

function project({ hooks = 'on', source = 'src', target = 'ts' } = {}) {
  const dir = tempDir();
  write(dir, 'openspec/config.yaml', `# spec-relay: managed by scripts/setup.mjs. Edit the values; keep this line.\nschema: spec-relay-extract\n\ncontext: |\n  Source root (read-only; only openspec/ and the target root may change): ${source}\n  Target root (new implementation): ${target}\n  Artifact language: ja\n  Hook enforcement (on or off; on denies archives that fail the gate and agent writes to protected files): ${hooks}\n`);
  write(dir, 'openspec/changes/archive/2026-11-01-survey/capabilities.md', '1. `billing/invoice`\n');
  const C = 'openspec/changes/extract-billing-invoice';
  write(dir, `${C}/.openspec.yaml`, 'schema: spec-relay-extract\n');
  write(dir, `${C}/specs/billing/invoice/spec.md`, SPEC);
  write(dir, `${C}/screens.md`, '# Screens\n\nNone\n');
  write(dir, `${C}/questions.md`, '# Questions\n\nNone\n');
  write(dir, `${C}/crosscheck.md`, '| Item | Verdict | Evidence |\n|---|---|---|\n| R1 Add two numbers | confirmed | src/a.php:1 |\n');
  write(dir, `${C}/review.md`, 'Reviewer: Uma\n- [ ] R1 Add two numbers\n');
  return dir;
}
const shell = (dir, command, extra = {}) => decide({ cwd: dir, toolName: 'powershell', toolArgs: { command }, ...extra }, { pluginRoot: KIT });
const edit = (dir, file, extra = {}) => decide({ cwd: dir, toolName: 'edit', toolArgs: { path: file }, ...extra }, { pluginRoot: KIT });

test('does nothing outside a spec-relay repository or while enforcement is off', () => {
  const plain = tempDir();
  assert.equal(findRoot(plain), null);
  assert.equal(shell(plain, 'openspec archive extract-billing-invoice --yes'), null);
  const off = project({ hooks: 'off' });
  assert.equal(shell(off, 'openspec archive extract-billing-invoice --yes'), null);
  assert.equal(edit(off, 'src/a.php'), null);
  // A config without the line (kit 0.3.0) is off.
  const old = project();
  write(old, 'openspec/config.yaml', '# spec-relay: managed\ncontext: |\n  Source root: src\n  Target root: ts\n');
  assert.equal(edit(old, 'src/a.php'), null);
});

test('an archive waits for a passing gate, a change name and the orchestrator', () => {
  const dir = project();
  const why = shell(dir, 'openspec.cmd archive "extract-billing-invoice" --yes');
  assert.match(why, /gate.mjs review fails for extract-billing-invoice/);
  assert.match(why, /not ticked: R1 Add two numbers/);
  assert.match(why, /Tell the person: レビューで未承認の項目が 1 件あります/);
  assert.match(shell(dir, 'openspec archive --yes'), /name the change/);
  write(dir, 'openspec/changes/extract-billing-invoice/review.md', 'Reviewer: Uma\n- [x] R1 Add two numbers\n');
  assert.equal(shell(dir, 'openspec archive extract-billing-invoice --yes'), null);
  // In a subfolder of the repository too.
  fs.mkdirSync(path.join(dir, 'ts/app'), { recursive: true });
  assert.equal(shell(path.join(dir, 'ts/app'), 'openspec archive extract-billing-invoice --yes'), null);
  assert.match(shell(dir, 'openspec archive extract-billing-invoice --yes --skip-specs'), /drop --skip-specs/);
  assert.match(shell(dir, 'openspec archive extract-billing-invoice --yes', { agentType: 'spec-relay-analyst' }), /only the orchestrator archives/);
  // Changes that are not spec-relay's are left to OpenSpec.
  write(dir, 'openspec/changes/add-login/.openspec.yaml', 'schema: spec-driven\n');
  assert.equal(shell(dir, 'openspec archive add-login --yes'), null);
  assert.equal(shell(dir, 'openspec list --json'), null);
  // A port archive needs gate.mjs port-done.
  write(dir, 'openspec/changes/port-billing-invoice/.openspec.yaml', 'schema: spec-relay-port\n');
  write(dir, 'openspec/changes/port-billing-invoice/tasks.md', '- [ ] 1.1 a\n');
  assert.match(shell(dir, 'node x.js; openspec archive port-billing-invoice --yes'), /gate.mjs port-done fails for port-billing-invoice, so it cannot be archived yet: not done: 1.1 a/);
  assert.match(shell(dir, '(Get-Content openspec/config.yaml) -replace "Hook enforcement.*", "off"'), /setting is the person's/);
});

test('agents may not write the source, baselines, archives, schemas, settings or the kit', () => {
  const dir = project();
  assert.match(edit(dir, 'src/billing/Invoice.php'), /under the source root src, which is read-only/);
  assert.match(edit(dir, path.join(dir, 'openspec/specs/billing/invoice/spec.md')), /baseline specs change only/);
  assert.match(edit(dir, 'openspec/changes/archive/2026-11-01-survey/capabilities.md'), /record of what was reviewed/);
  assert.match(edit(dir, 'openspec/schemas/spec-relay-extract/schema.yaml'), /installed by setup.mjs/);
  assert.match(edit(dir, 'openspec/config.yaml'), /person's settings/);
  assert.match(edit(dir, path.join(KIT, 'scripts/gate.mjs')), /part of the spec-relay kit/);
  assert.equal(edit(dir, 'ts/billing/invoice.ts'), null);
  assert.equal(edit(dir, 'openspec/changes/extract-billing-invoice/review.md'), null);
  assert.equal(edit(dir, path.join(path.dirname(dir), 'elsewhere.txt')), null);
  // Subagents leave review.md, questions.md and the plan to the orchestrator.
  const sub = { agentId: 'a1', agentType: 'spec-relay-analyst' };
  assert.match(edit(dir, 'openspec/changes/extract-billing-invoice/review.md', sub), /only the orchestrator writes/);
  assert.match(edit(dir, 'openspec/spec-relay/plan.md', sub), /only the orchestrator writes/);
  assert.equal(edit(dir, 'openspec/changes/extract-billing-invoice/trace.md', sub), null);
  // An apply_patch text and the VS Code compatible payload are read too.
  assert.match(decide({ cwd: dir, toolName: 'apply_patch', toolArgs: '*** Begin Patch\n*** Update File: src/a.php\n@@\n-a\n+b\n*** End Patch\n' }, { pluginRoot: KIT }), /source root src/);
  assert.match(decide({ cwd: dir, tool_name: 'create', tool_input: { file_path: 'src/new.php' } }, { pluginRoot: KIT }), /source root src/);
});

test('with the source root ".", agents write only openspec/ and the target root', () => {
  const dir = project({ source: '.', target: 'ts' });
  assert.match(edit(dir, 'Invoice.cs'), /with the source root "\."/);
  assert.match(edit(dir, '.github/agents/x.agent.md'), /with the source root "\."/);
  assert.equal(edit(dir, 'ts/Invoice.ts'), null);
  assert.equal(edit(dir, 'openspec/changes/extract-billing-invoice/trace.md'), null);
});

test('parses archive calls and patch paths', () => {
  assert.deepEqual(archiveCalls('npx @fission-ai/openspec archive survey -y && echo ok'), [{ name: 'survey', flags: ['-y'] }]);
  assert.deepEqual(archiveCalls('node "C:/kit/scripts/openspec.mjs" archive port-a --yes'), [{ name: 'port-a', flags: ['--yes'] }]);
  assert.deepEqual(archiveCalls('openspec archived-list; myopenspec archive x'), []);
  assert.deepEqual(editPaths({ input: '--- a/src/x.php\n+++ b/src/x.php\n' }), ['src/x.php']);
  assert.deepEqual(editPaths({ edits: [{ path: 'a' }, { filePath: 'b' }] }), ['a', 'b']);
});

test('prints one deny object or nothing, and always exits 0', () => {
  const dir = project();
  assert.equal(main('not json'), '');
  const out = JSON.parse(main(JSON.stringify({ cwd: dir, toolName: 'edit', toolArgs: JSON.stringify({ path: 'src/a.php' }) }), { pluginRoot: KIT }));
  assert.equal(out.permissionDecision, 'deny');
  assert.match(out.permissionDecisionReason, /^spec-relay: spec-relay does not let agents write src\/a.php/);
  const run = spawnSync(process.execPath, [HOOK], { input: JSON.stringify({ cwd: dir, toolName: 'edit', toolArgs: { path: 'src/a.php' } }), encoding: 'utf8' });
  assert.equal(run.status, 0);
  assert.equal(JSON.parse(run.stdout).permissionDecision, 'deny');
  const quiet = spawnSync(process.execPath, [HOOK], { input: '', encoding: 'utf8' });
  assert.equal(quiet.status, 0);
  assert.equal(quiet.stdout, '');
});

test('hooks.json runs the hook for shell and edit tools and never exits non-zero', () => {
  const config = JSON.parse(fs.readFileSync(path.join(KIT, 'com.github.copilot/hooks/hooks.json'), 'utf8'));
  assert.equal(config.version, 1);
  const [entry] = config.hooks.preToolUse;
  for (const tool of ['bash', 'powershell', 'edit', 'create', 'apply_patch']) assert.match(tool, new RegExp(`^(?:${entry.matcher})$`));
  assert.doesNotMatch('view', new RegExp(`^(?:${entry.matcher})$`));
  assert.match(entry.bash, /\$PLUGIN_ROOT\/scripts\/hook\.mjs" \|\| true$/);
  assert.match(entry.powershell, /\$env:PLUGIN_ROOT\/scripts\/hook\.mjs"; exit 0$/);
  // Run the entry the way the host does: through the platform's shell, with the
  // payload on stdin. A missing hook script must still exit 0.
  const payload = JSON.stringify({ cwd: project(), toolName: 'edit', toolArgs: { path: 'src/a.php' } });
  const shells = process.platform === 'win32'
    ? [['powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', entry.powershell]], ['pwsh', ['-NoProfile', '-NonInteractive', '-Command', entry.powershell]]]
    : [['bash', ['-c', entry.bash]]];
  for (const [exe, args] of shells) {
    if (spawnSync(exe, [...args.slice(0, -1), 'exit 0'], { encoding: 'utf8' }).error) continue;
    const denied = spawnSync(exe, args, { env: { ...process.env, PLUGIN_ROOT: KIT }, input: payload, encoding: 'utf8' });
    assert.equal(denied.status, 0, exe);
    assert.equal(JSON.parse(denied.stdout.trim()).permissionDecision, 'deny', exe);
    const missing = spawnSync(exe, args, { env: { ...process.env, PLUGIN_ROOT: path.join(KIT, 'nonexistent') }, input: payload, encoding: 'utf8' });
    assert.equal(missing.status, 0, exe);
    assert.equal(missing.stdout.trim(), '', exe);
  }
});
