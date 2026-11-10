import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { main, parseArgs, plan, CONFIG_MARKER, KIT_ROOT, STUB_MARKER } from '../scripts/setup.mjs';
import { findOpenspec, runOpenspec } from '../scripts/openspec.mjs';
import { tempDir, write, quiet, isolateOpenspec, crlf } from './helpers.mjs';

isolateOpenspec();

const LANGS = ['--source-language', 'C#', '--target-language', 'TypeScript'];
const BASE = [...LANGS, '--target-root', 'ts'];
const conflicts = (opts) => plan(opts).steps.filter((s) => s.action === 'conflict').map((s) => path.relative(opts.target, s.path).replace(/\\/g, '/'));

test('required options are enforced', () => {
  assert.throws(() => parseArgs([]), /--source-language is required/);
  assert.throws(() => parseArgs(LANGS), /--target-root is required/);
});

test('target root must be a relative, new directory outside openspec/ and .github/', () => {
  for (const bad of ['../out', '..\\out', '/abs', '\\abs', 'C:out', 'C:\\out', '\\\\server\\share\\out', '.', 'openspec/out', 'openspec\\out', '.github/x']) {
    assert.throws(() => parseArgs([...LANGS, '--target-root', bad]), /relative path|new directory/, bad);
  }
  for (const bad of ['con', 'NUL', 'aux\\ts', 'com1.txt', 'ts.', 'ts ', 'a/b?c', 'ts*']) {
    assert.throws(() => parseArgs([...LANGS, '--target-root', bad]), /Windows cannot use/, bad);
  }
  assert.equal(parseArgs([...LANGS, '--source-root', '.\\Legacy App\\src\\', '--target-root', 'ts']).sourceRoot, 'Legacy App/src');
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

const run = (script, args, options = {}) => spawnSync(process.execPath, [path.join(KIT_ROOT, 'scripts', script), ...args], { encoding: 'utf8', ...options });

test('the scripts run as processes and set their exit codes', () => {
  const help = run('setup.mjs', ['--help']);
  assert.equal(help.status, 0, help.stderr);
  assert.match(help.stdout, /Usage:/);
  assert.equal(run('setup.mjs', ['--nope']).status, 1);
  assert.equal(run('gate.mjs', ['review']).status, 2);
  const dir = tempDir();
  assert.equal(run('gate.mjs', ['review', '--change', 'x'], { cwd: dir }).status, 2, 'no openspec/ folder');
  write(dir, 'openspec/changes/port-x/tasks.md', '- [ ] 1.1 a\r\n');
  const gate = run('gate.mjs', ['port-done', '--change', 'port-x', '--root', dir]);
  assert.equal(gate.status, 1);
  assert.equal(JSON.parse(gate.stdout).ok, false);
});

test('running the script through a symlink still runs it', { skip: process.platform === 'win32' && 'symlinks need privileges on Windows' }, () => {
  const dir = tempDir();
  const link = path.join(dir, 'setup-link.mjs');
  fs.symlinkSync(path.join(KIT_ROOT, 'scripts/setup.mjs'), link);
  const result = spawnSync(process.execPath, [link, '--help'], { encoding: 'utf8' });
  assert.equal(result.status, 0);
  assert.match(result.stdout, /Usage:/);
});

// A stand-in for the CLI: `--version` works and everything else exits 1.
function fakeOpenspec() {
  const bin = tempDir('spec-relay-bin-');
  if (process.platform === 'win32') {
    write(bin, 'openspec.cmd', '@echo off\r\nif "%1"=="--version" (echo 1.17.0& exit /b 0)\r\nexit /b 1\r\n');
  } else {
    write(bin, 'openspec', '#!/bin/sh\n[ "$1" = "--version" ] && { echo 1.17.0; exit 0; }\nexit 1\n');
    fs.chmodSync(path.join(bin, 'openspec'), 0o755);
  }
  return bin;
}

function envWithPath(first) {
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (key.toUpperCase() === 'PATH' || key === 'APPDATA' || key === 'npm_config_prefix') delete env[key];
  // Only this folder: the real CLI often sits beside node, so node's folder stays out.
  env.PATH = first;
  return env;
}

test('a failed openspec init removes the files the run created, so a re-run starts over', () => {
  const dir = tempDir();
  const result = run('setup.mjs', ['--target', dir, ...BASE, '--apply'], { env: envWithPath(fakeOpenspec()) });
  assert.equal(result.status, 1, result.stderr + result.stdout);
  assert.match(result.stderr, /were removed/);
  assert.ok(!fs.existsSync(path.join(dir, 'openspec/config.yaml')));
  assert.equal(plan(parseArgs(['--target', dir, ...BASE])).runInit, true);
});

test('a missing openspec CLI stops setup before anything is written', () => {
  const dir = tempDir();
  const result = run('setup.mjs', ['--target', dir, ...BASE, '--apply'], { env: envWithPath(tempDir()) });
  assert.equal(result.status, 3, result.stderr + result.stdout);
  assert.match(result.stderr, /was not found/);
  assert.deepEqual(fs.readdirSync(dir), []);
});

test('on Windows the npm shim runs as node + openspec.js, never through a shell', () => {
  const npm = 'C:\\Users\\Taro Yamada\\AppData\\Roaming\\npm';
  const script = `${npm}\\node_modules\\@fission-ai\\openspec\\bin\\openspec.js`;
  const find = (files, env) => findOpenspec({ platform: 'win32', env, exists: (file) => files.includes(file) });
  assert.deepEqual(find([`${npm}\\openspec.cmd`, script], { Path: `.;relative\\bin;"${npm}"` }), { command: process.execPath, prefixArgs: [script] });
  // Not on PATH (a terminal opened before the install): npm's folder under %APPDATA% is searched.
  assert.deepEqual(find([`${npm}\\openspec.cmd`, script], { PATH: 'C:\\Windows', APPDATA: 'C:\\Users\\Taro Yamada\\AppData\\Roaming' }).prefixArgs, [script]);
  assert.deepEqual(find(['C:\\tools\\openspec.exe'], { PATH: 'C:\\tools' }), { command: 'C:\\tools\\openspec.exe', prefixArgs: [] });
  // A shim from another package manager runs through cmd.exe.
  assert.equal(find(['C:\\pnpm\\openspec.cmd'], { PATH: 'C:\\pnpm', ComSpec: 'C:\\Windows\\System32\\cmd.exe' }).batch, 'C:\\pnpm\\openspec.cmd');
  // A file in the repository being migrated is never picked up.
  assert.equal(find(['openspec.cmd', '.\\openspec.cmd'], { PATH: '.' }), null);
  assert.equal(runOpenspec(['--version'], {}, null).notFound, true);
  const refused = runOpenspec(['init', 'a&b'], {}, { command: 'cmd.exe', prefixArgs: [], batch: 'C:\\pnpm\\openspec.cmd' });
  assert.match(refused.error.message, /cannot pass/);
});

test('schema files checked out with CRLF or a BOM are the kit version, not a conflict', () => {
  const dir = tempDir();
  quiet(() => main(['--target', dir, ...BASE, '--skip-init', '--apply']));
  const schema = path.join(dir, 'openspec/schemas/spec-relay-port/schema.yaml');
  const config = path.join(dir, 'openspec/config.yaml');
  fs.writeFileSync(schema, `\uFEFF${crlf(fs.readFileSync(schema, 'utf8'))}`);
  fs.writeFileSync(config, crlf(fs.readFileSync(config, 'utf8')));
  const again = plan(parseArgs(['--target', dir, ...BASE]));
  assert.ok(again.managed);
  assert.deepEqual(again.steps.filter((step) => step.action !== 'keep'), []);
});

test('a re-run disables only OpenSpec-generated apply/archive/sync workflows', () => {
  const dir = tempDir();
  quiet(() => main(['--target', dir, ...BASE, '--skip-init', '--apply']));
  write(dir, '.github/prompts/opsx-apply.prompt.md', 'Run openspec instructions apply\n');
  write(dir, '.github/prompts/opsx-archive.prompt.md', 'my own notes\n');
  write(dir, '.github/skills/openspec-archive-change/SKILL.md', 'metadata:\n  generatedBy: "1.17.0"\n');
  write(dir, '.github/skills/openspec-propose/SKILL.md', 'metadata:\n  generatedBy: "1.17.0"\n');
  assert.equal(quiet(() => main(['--target', dir, ...BASE, '--apply'])), 0);
  const read = (rel) => fs.readFileSync(path.join(dir, rel), 'utf8');
  assert.ok(read('.github/prompts/opsx-apply.prompt.md').includes(STUB_MARKER));
  assert.match(read('.github/skills/openspec-archive-change/SKILL.md'), /name: openspec-archive-change[\s\S]*spec-relay-orchestrator/);
  assert.equal(read('.github/prompts/opsx-archive.prompt.md'), 'my own notes\n');
  assert.match(read('.github/skills/openspec-propose/SKILL.md'), /generatedBy/);
  assert.equal(plan(parseArgs(['--target', dir, ...BASE])).steps.filter((st) => st.action === 'disable').length, 0);
});
