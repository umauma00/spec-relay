import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { main, parseArgs, plan, CONFIG_MARKER, KIT_ROOT } from '../scripts/setup.mjs';
import { tempDir, write, quiet } from './helpers.mjs';

const LANGS = ['--source-language', 'C#', '--target-language', 'TypeScript'];
const BASE = [...LANGS, '--target-root', 'ts'];
const conflicts = (opts) => plan(opts).steps.filter((s) => s.action === 'conflict').map((s) => path.relative(opts.target, s.path).replace(/\\/g, '/'));

test('required options are enforced', () => {
  assert.throws(() => parseArgs([]), /--source-language is required/);
  assert.throws(() => parseArgs(LANGS), /--target-root is required/);
});

test('target root must be a relative, new directory outside openspec/ and .github/', () => {
  for (const bad of ['../out', '/abs', 'C:out', '.', 'openspec/out', 'openspec\\out', '.github/x']) {
    assert.throws(() => parseArgs([...LANGS, '--target-root', bad]), /relative path|new directory/, bad);
  }
});

test('source and target roots must not contain each other, except source root .', () => {
  assert.throws(() => parseArgs([...BASE, '--source-root', 'ts']), /contain each other/);
  assert.throws(() => parseArgs([...LANGS, '--source-root', 'src', '--target-root', 'src/ts']), /contain each other/);
  assert.throws(() => parseArgs([...LANGS, '--source-root', 'src/legacy', '--target-root', 'src']), /contain each other/);
  assert.equal(parseArgs([...LANGS, '--source-root', 'src', '--target-root', 'ts']).targetRoot, 'ts');
  assert.equal(parseArgs(BASE).sourceRoot, '.');
});

test('a dry run changes nothing', () => {
  const dir = tempDir();
  assert.equal(quiet(() => main(['--target', dir, ...BASE, '--skip-init'])), 0);
  assert.deepEqual(fs.readdirSync(dir), []);
});

test('apply writes schemas and a filled config, and a second run keeps them', () => {
  const dir = tempDir();
  assert.equal(quiet(() => main(['--target', dir, ...BASE, '--language', 'ja', '--skip-init', '--apply'])), 0);
  const config = fs.readFileSync(path.join(dir, 'openspec/config.yaml'), 'utf8');
  assert.ok(config.includes(CONFIG_MARKER));
  assert.match(config, /Source language: C#/);
  assert.match(config, /Target root \(new implementation\): ts/);
  assert.match(config, /Artifact language: ja/);
  assert.doesNotMatch(config, /\{\{/);
  for (const schema of ['spec-relay-extract', 'spec-relay-port']) {
    assert.ok(fs.existsSync(path.join(dir, 'openspec/schemas', schema, 'schema.yaml')));
  }
  write(dir, 'ts/index.ts', '// ported\n');
  const again = plan(parseArgs(['--target', dir, ...BASE]));
  assert.equal(again.runInit, false);
  assert.ok(again.steps.every((step) => step.action === 'keep'));
});

test('a changed schema file or a foreign config is a conflict and nothing is written', () => {
  const dir = tempDir();
  write(dir, 'openspec/config.yaml', 'schema: spec-driven\n');
  assert.equal(quiet(() => main(['--target', dir, ...BASE, '--skip-init', '--apply'])), 2);
  assert.equal(fs.readFileSync(path.join(dir, 'openspec/config.yaml'), 'utf8'), 'schema: spec-driven\n');
  assert.ok(!fs.existsSync(path.join(dir, 'openspec/schemas')));

  const dir2 = tempDir();
  quiet(() => main(['--target', dir2, ...BASE, '--skip-init', '--apply']));
  fs.appendFileSync(path.join(dir2, 'openspec/schemas/spec-relay-port/schema.yaml'), '# local edit\n');
  assert.deepEqual(conflicts(parseArgs(['--target', dir2, ...BASE])), ['openspec/schemas/spec-relay-port/schema.yaml']);
});

test('an existing config.yml or a non-empty target root is a conflict', () => {
  const dir = tempDir();
  write(dir, 'openspec/config.yml', 'schema: spec-driven\n');
  write(dir, 'ts/old.ts', '');
  assert.deepEqual(conflicts(parseArgs(['--target', dir, ...BASE, '--skip-init'])), ['openspec/config.yml', 'ts']);
});

test('files openspec init would replace or clean up are conflicts before init', () => {
  const dir = tempDir();
  write(dir, '.github/prompts/opsx-propose.prompt.md', 'mine\n');
  write(dir, '.github/skills/openspec-archive-change/SKILL.md', 'mine\n');
  write(dir, 'openspec/AGENTS.md', 'my notes\n');
  write(dir, 'AGENTS.md', '<!-- OPENSPEC:START -->\n<!-- OPENSPEC:END -->\n');
  write(dir, 'CLAUDE.md', 'unrelated\n');
  assert.deepEqual(conflicts(parseArgs(['--target', dir, ...BASE])).sort(), [
    '.github/prompts/opsx-propose.prompt.md', '.github/skills/openspec-archive-change', 'AGENTS.md', 'openspec/AGENTS.md',
  ]);
  assert.equal(quiet(() => main(['--target', dir, ...BASE, '--apply'])), 2);
  assert.equal(fs.readFileSync(path.join(dir, 'openspec/AGENTS.md'), 'utf8'), 'my notes\n');
});

test('running the script through a symlink still runs it', { skip: process.platform === 'win32' && 'symlinks need privileges on Windows' }, () => {
  const dir = tempDir();
  const link = path.join(dir, 'setup-link.mjs');
  fs.symlinkSync(path.join(KIT_ROOT, 'scripts/setup.mjs'), link);
  const result = spawnSync(process.execPath, [link, '--help'], { encoding: 'utf8' });
  assert.equal(result.status, 0);
  assert.match(result.stdout, /Usage:/);
});
