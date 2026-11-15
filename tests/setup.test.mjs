import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { main, parseArgs, plan, renderConfig, CONFIG_MARKER, KIT_ROOT, STUB_MARKER } from '../scripts/setup.mjs';
import { findOpenspec, runOpenspec, findNpm, runCommand, OPENSPEC_VERSION } from '../scripts/openspec.mjs';
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

test('--parallel and --ahead take whole numbers in range', () => {
  const opts = parseArgs([...BASE, '--parallel', '16', '--ahead', '3']);
  assert.deepEqual([opts.parallel, opts.ahead], [16, 3]);
  for (const bad of ['0', '33', '4.5', 'many']) assert.throws(() => parseArgs([...BASE, '--parallel', bad]), /--parallel must be a whole number from 1 to 32/, bad);
  assert.throws(() => parseArgs([...BASE, '--ahead', '11']), /--ahead must be a whole number from 1 to 10/);
});

test('subagent models: one for all roles, a role overrides it, default session', () => {
  assert.deepEqual(['analystModel', 'checkerModel', 'implementerModel'].map((k) => parseArgs(BASE)[k]), ['session', 'session', 'session']);
  const opts = parseArgs([...BASE, '--subagent-model', 'claude-sonnet-5.5', '--checker-model', 'Claude Opus 5.5']);
  assert.deepEqual([opts.analystModel, opts.checkerModel, opts.implementerModel], ['claude-sonnet-5.5', 'Claude Opus 5.5', 'claude-sonnet-5.5']);
  assert.throws(() => parseArgs([...BASE, '--checker-model', 'a # b']), /--checker-model must be a model name/);
  assert.throws(() => parseArgs([...BASE, '--subagent-model', ' ']), /--subagent-model must be a model name/);
  assert.equal(parseArgs([...BASE, '--subagent-model', 'Session']).analystModel, 'session');
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
  assert.match(config, /Parallel subagents \(at once, whole session\): 4\n  Analyses ahead of review: 2\n  Analyst model: session\n  Checker model: session\n  Implementer model: session\n/);
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
  // OpenSpec 2.x writes its skills here, and deletes the files 1.x wrote under .github/.
  write(dir, '.agents/skills/openspec-explore/SKILL.md', 'mine\n');
  write(dir, '.agents/skills/.openspec-target', 'claude\n');
  write(dir, '.agents/skills/my-own-skill/SKILL.md', 'mine\n');
  write(dir, '.github/prompts/opsx-propose.prompt.md', 'mine\n');
  write(dir, '.github/prompts/openspec-review.prompt.md', 'mine\n');
  write(dir, '.github/prompts/my-own.prompt.md', 'mine\n');
  write(dir, '.github/skills/openspec-archive-change/SKILL.md', 'mine\n');
  // Other tools' 1.x files: init deletes them and links the shared skills there.
  write(dir, '.claude/skills/openspec-propose/SKILL.md', 'mine\n');
  write(dir, '.claude/commands/opsx/apply.md', 'mine\n');
  write(dir, '.cursor/commands/opsx-apply.md', 'mine\n');
  write(dir, 'openspec/AGENTS.md', 'my notes\n');
  write(dir, 'AGENTS.md', '<!-- OPENSPEC:START -->\n<!-- OPENSPEC:END -->\n');
  write(dir, 'CLAUDE.md', 'unrelated\n');
  assert.deepEqual(conflicts(parseArgs(['--target', dir, ...BASE])).sort(), [
    '.agents/skills/.openspec-target', '.agents/skills/openspec-explore',
    '.claude/commands/opsx', '.claude/skills/openspec-propose', '.cursor/commands/opsx-apply.md',
    '.github/prompts/openspec-review.prompt.md', '.github/prompts/opsx-propose.prompt.md', '.github/skills/openspec-archive-change',
    'AGENTS.md', 'openspec/AGENTS.md',
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

// A stand-in for npm: `--version` works, and `ci` "installs" an OpenSpec that
// answers `--version` and fails everything else. Run by absolute node, since
// PATH holds only this folder.
function fakeNpm(version = '2.0.0') {
  const bin = tempDir('spec-relay-bin-');
  const openspec = `if (process.argv[2] === '--version') { console.log(${JSON.stringify(version)}); } else { process.exitCode = 1; }\n`;
  write(bin, 'fake-npm.js', `const fs = require('fs'); const path = require('path');
if (process.argv[2] === '--version') { console.log('10.9.0'); process.exit(0); }
const dir = path.join(process.cwd(), 'node_modules/@fission-ai/openspec');
fs.mkdirSync(path.join(dir, 'bin'), { recursive: true });
fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ version: ${JSON.stringify(version)} }));
fs.writeFileSync(path.join(dir, 'bin/openspec.js'), ${JSON.stringify(openspec)});
`);
  if (process.platform === 'win32') {
    write(bin, 'npm.cmd', `@echo off\r\n"${process.execPath}" "${path.join(bin, 'fake-npm.js')}" %*\r\n`);
  } else {
    write(bin, 'npm', `#!/bin/sh\nexec "${process.execPath}" "${path.join(bin, 'fake-npm.js')}" "$@"\n`);
    fs.chmodSync(path.join(bin, 'npm'), 0o755);
  }
  return bin;
}

function envWithPath(first) {
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (key.toUpperCase() === 'PATH' || key === 'APPDATA' || key === 'npm_config_prefix') delete env[key];
  // Only this folder: a real npm or openspec often sits beside node, so node's folder stays out.
  env.PATH = first;
  return env;
}

test('setup installs the pinned OpenSpec into the repository and runs init with it', () => {
  const dir = tempDir();
  const result = run('setup.mjs', ['--target', dir, ...BASE, '--apply'], { env: envWithPath(fakeNpm()) });
  // The fake OpenSpec fails init, so the run is undone: files and node_modules.
  assert.equal(result.status, 1, result.stderr + result.stdout);
  assert.match(result.stdout, /npm ci in openspec\/spec-relay\/tools \(installs OpenSpec 2\.0\.0/);
  assert.match(result.stderr, /openspec init failed[\s\S]*were removed/);
  assert.ok(!fs.existsSync(path.join(dir, 'openspec/config.yaml')));
  assert.ok(!fs.existsSync(path.join(dir, 'openspec/spec-relay/tools/package.json')));
  assert.ok(!fs.existsSync(path.join(dir, 'openspec/spec-relay/tools/node_modules')));
  assert.equal(plan(parseArgs(['--target', dir, ...BASE])).runInit, true);
});

test('the kit pins OpenSpec with its own package.json and lock, compared like the schemas', () => {
  const dir = tempDir();
  assert.equal(quiet(() => main(['--target', dir, ...BASE, '--skip-init', '--apply'])), 0);
  const tools = path.join(dir, 'openspec/spec-relay/tools');
  for (const rel of ['package.json', 'package-lock.json', '.gitignore']) {
    assert.equal(fs.readFileSync(path.join(tools, rel), 'utf8'), fs.readFileSync(path.join(KIT_ROOT, 'templates/openspec-tools', rel), 'utf8'), rel);
  }
  const pinned = JSON.parse(fs.readFileSync(path.join(tools, 'package-lock.json'), 'utf8'));
  assert.equal(pinned.packages['node_modules/@fission-ai/openspec'].version, OPENSPEC_VERSION);
  assert.equal(JSON.parse(fs.readFileSync(path.join(tools, 'package.json'), 'utf8')).dependencies['@fission-ai/openspec'], OPENSPEC_VERSION);
  assert.equal(fs.readFileSync(path.join(tools, '.gitignore'), 'utf8'), 'node_modules/\n');
  // Not installed yet: a run without --skip-init installs it; once installed and running it does not.
  const install = () => plan(parseArgs(['--target', dir, ...BASE])).install;
  assert.equal(install(), true);
  const fake = (version) => {
    write(tools, 'node_modules/@fission-ai/openspec/package.json', JSON.stringify({ version }));
    write(tools, 'node_modules/@fission-ai/openspec/bin/openspec.js', `console.log(${JSON.stringify(version)})\n`);
  };
  fake(OPENSPEC_VERSION);
  // npm writes node_modules/.package-lock.json last: without it the install did not finish.
  assert.equal(install(), true);
  write(tools, 'node_modules/.package-lock.json', '{}');
  assert.equal(install(), false);
  fake('1.17.0');
  assert.equal(install(), true);
  // A damaged tree (a file quarantined, an interrupted npm ci) that no longer runs is reinstalled.
  fake(OPENSPEC_VERSION);
  write(tools, 'node_modules/@fission-ai/openspec/bin/openspec.js', "import 'missing-module';\n");
  assert.equal(install(), true);
  // A reformatted package.json is still the kit's; a raised version is a conflict, as with a changed schema.
  const pkg = path.join(tools, 'package.json');
  fs.writeFileSync(pkg, JSON.stringify(JSON.parse(fs.readFileSync(pkg, 'utf8')), null, 4));
  assert.deepEqual(conflicts(parseArgs(['--target', dir, ...BASE])), []);
  fs.writeFileSync(pkg, fs.readFileSync(pkg, 'utf8').replace(OPENSPEC_VERSION, '2.1.0'));
  assert.deepEqual(conflicts(parseArgs(['--target', dir, ...BASE])), ['openspec/spec-relay/tools/package.json']);
});

test('files 0.6.0 and OpenSpec 1.x left under .github/ are reported and keep a re-run from finishing', () => {
  const dir = tempDir();
  quiet(() => main(['--target', dir, ...BASE, '--skip-init', '--apply']));
  write(dir, '.github/skills/openspec-archive-change/SKILL.md', `---\nname: openspec-archive-change\n---\n${STUB_MARKER}\n`);
  write(dir, '.github/skills/openspec-propose/SKILL.md', 'metadata:\n  generatedBy: "1.17.0"\n');
  write(dir, '.github/prompts/opsx-apply.prompt.md', 'Run openspec instructions apply\n');
  write(dir, '.github/skills/openspec-my-notes/SKILL.md', 'mine\n');
  const opts = parseArgs(['--target', dir, ...BASE, '--skip-init']);
  assert.deepEqual(conflicts(opts), []);
  assert.deepEqual(plan(opts).steps.filter((s) => s.action === 'leftover').map((s) => path.relative(dir, s.path).replace(/\\/g, '/')).sort(), [
    '.github/prompts/opsx-apply.prompt.md', '.github/skills/openspec-archive-change', '.github/skills/openspec-propose',
  ]);
  // The rest of the run still happens (it installs the OpenSpec that `update` needs), but it does not finish.
  assert.equal(quiet(() => main(['--target', dir, ...BASE, '--skip-init', '--apply'])), 2);
});

test('--target-root may not be .agents, where OpenSpec keeps its skills', () => {
  assert.throws(() => parseArgs(['--target', tempDir(), '--source-language', 'PHP', '--target-language', 'Java', '--target-root', '.agents/new']), /\.agents/);
});

test('a missing npm stops setup before anything is written', () => {
  const dir = tempDir();
  const result = run('setup.mjs', ['--target', dir, ...BASE, '--apply'], { env: envWithPath(tempDir()) });
  assert.equal(result.status, 3, result.stderr + result.stdout);
  assert.match(result.stderr, /npm was not found/);
  assert.deepEqual(fs.readdirSync(dir), []);
});

test('OpenSpec runs only from the repository, as node + openspec.js', () => {
  const dir = tempDir();
  const none = findOpenspec(dir);
  assert.equal(none.launch, null);
  assert.equal(none.pinned, false);
  assert.match(none.reason, /no OpenSpec of its own/);
  const result = runOpenspec(['--version'], { cwd: dir });
  assert.equal(result.notInstalled, true);
  write(dir, 'openspec/spec-relay/tools/package.json', '{}');
  assert.match(findOpenspec(dir).reason, /pinned in openspec\/spec-relay\/tools but not installed/);
  const script = path.join(dir, 'openspec/spec-relay/tools/node_modules/@fission-ai/openspec/bin/openspec.js');
  write(dir, 'openspec/spec-relay/tools/node_modules/@fission-ai/openspec/package.json', '{"version":"2.0.0"}');
  write(dir, 'openspec/spec-relay/tools/node_modules/@fission-ai/openspec/bin/openspec.js', "console.log(process.argv.slice(2).join(' '))\n");
  assert.deepEqual(findOpenspec(dir), { launch: { command: process.execPath, prefixArgs: [script] }, pinned: true, version: '2.0.0' });
  assert.equal(runOpenspec(['list', '--json'], { cwd: dir }).stdout.trim(), 'list --json');
  // The command line form, from a subfolder, with a global openspec nowhere on PATH.
  fs.mkdirSync(path.join(dir, 'src/deep'), { recursive: true });
  const cli = spawnSync(process.execPath, [path.join(KIT_ROOT, 'scripts/openspec.mjs'), 'status', '--change', 'a b'], { cwd: path.join(dir, 'src/deep'), encoding: 'utf8', env: envWithPath(tempDir()) });
  assert.equal(cli.status, 0, cli.stderr);
  assert.equal(cli.stdout.trim(), 'status --change a b');
  const outside = spawnSync(process.execPath, [path.join(KIT_ROOT, 'scripts/openspec.mjs'), '--version'], { cwd: tempDir(), encoding: 'utf8' });
  assert.equal(outside.status, 1);
  assert.match(outside.stderr, /no OpenSpec of its own/);
});

test('on Windows an npm shim runs as node + its script, never through a shell', () => {
  const nodejs = 'C:\\Program Files\\nodejs';
  const script = `${nodejs}\\node_modules\\npm\\bin\\npm-cli.js`;
  const find = (files, env) => findNpm({ platform: 'win32', env, exists: (file) => files.includes(file) });
  assert.deepEqual(find([`${nodejs}\\npm.cmd`, script], { Path: `.;relative\\bin;"${nodejs}"` }), { command: process.execPath, prefixArgs: [script] });
  assert.deepEqual(find(['C:\\tools\\npm.exe'], { PATH: 'C:\\tools' }), { command: 'C:\\tools\\npm.exe', prefixArgs: [] });
  // A shim from another manager runs through cmd.exe.
  assert.equal(find(['C:\\volta\\npm.cmd'], { PATH: 'C:\\volta', ComSpec: 'C:\\Windows\\System32\\cmd.exe' }).batch, 'C:\\volta\\npm.cmd');
  // A file in the repository being migrated is never picked up.
  assert.equal(find(['npm.cmd', '.\\npm.cmd'], { PATH: '.' }), null);
  assert.equal(runCommand(null, ['--version']).notFound, true);
  const refused = runCommand({ command: 'cmd.exe', prefixArgs: [], batch: 'C:\\volta\\npm.cmd' }, ['ci', 'a&b']);
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

test('a re-run disables every OpenSpec-generated skill and leaves the person\'s own', () => {
  const dir = tempDir();
  quiet(() => main(['--target', dir, ...BASE, '--skip-init', '--apply']));
  write(dir, '.agents/skills/openspec-apply-change/SKILL.md', 'metadata:\n  generatedBy: "2.0.0"\n');
  write(dir, '.agents/skills/openspec-archive-change/SKILL.md', 'metadata:\n  generatedBy: "2.0.0"\n');
  write(dir, '.agents/skills/openspec-sync-specs/SKILL.md', 'my own notes\n');
  write(dir, '.agents/skills/openspec-propose/SKILL.md', 'metadata:\n  generatedBy: "2.0.0"\n');
  assert.equal(quiet(() => main(['--target', dir, ...BASE, '--skip-init', '--apply'])), 0);
  const read = (rel) => fs.readFileSync(path.join(dir, rel), 'utf8');
  assert.ok(read('.agents/skills/openspec-apply-change/SKILL.md').includes(STUB_MARKER));
  assert.match(read('.agents/skills/openspec-archive-change/SKILL.md'), /name: openspec-archive-change[\s\S]*spec-relay-orchestrator/);
  assert.equal(read('.agents/skills/openspec-sync-specs/SKILL.md'), 'my own notes\n');
  // Propose, explore and the rest call a bare `openspec`, not the pinned one.
  assert.ok(read('.agents/skills/openspec-propose/SKILL.md').includes(STUB_MARKER));
  assert.equal(plan(parseArgs(['--target', dir, ...BASE])).steps.filter((st) => st.action === 'disable').length, 0);
});

test('--hooks writes the Hook enforcement line the hook reads, off by default', () => {
  const base = ['--source-language', 'PHP', '--target-language', 'Java', '--target-root', 'java'];
  assert.match(renderConfig(parseArgs(base)), /^  Hook enforcement \(on or off;[^:\n]*\): off$/m);
  assert.match(renderConfig(parseArgs([...base, '--hooks', 'ON'])), /^  Hook enforcement [^:\n]*: on$/m);
  assert.throws(() => parseArgs([...base, '--hooks', 'maybe']), /--hooks must be on or off/);
  // On a repository set up before, the config is kept and setup says what to change.
  const dir = tempDir();
  write(dir, 'openspec/config.yaml', renderConfig(parseArgs(base)));
  const keep = plan(parseArgs([...base, '--target', dir, '--hooks', 'on'])).steps.find((s) => s.path.endsWith('config.yaml'));
  assert.equal(keep.action, 'keep');
  assert.match(keep.reason, /--hooks on is not applied: change the "Hook enforcement" line in it yourself \(it says off\)/);
  assert.doesNotMatch(plan(parseArgs([...base, '--target', dir])).steps.find((s) => s.path.endsWith('config.yaml')).reason, /--hooks/);
});

test('a set-up repository re-runs with --target alone: the values come from its config', () => {
  const dir = tempDir();
  quiet(() => main(['--target', dir, ...LANGS, '--source-root', 'src', '--target-root', 'ts', '--skip-init', '--apply']));
  const opts = parseArgs(['--target', dir, '--skip-init']);
  assert.deepEqual([opts.sourceLanguage, opts.targetLanguage, opts.sourceRoot, opts.targetRoot], ['C#', 'TypeScript', 'src', 'ts']);
  assert.equal(quiet(() => main(['--target', dir, '--skip-init', '--apply'])), 0);
  // Before setup the options stay required.
  assert.throws(() => parseArgs(['--target', tempDir()]), /--source-language is required/);
});

test('a setup that stopped before init finished starts over on the next run', () => {
  const dir = tempDir();
  quiet(() => main(['--target', dir, ...BASE, '--skip-init', '--apply']));
  const config = path.join(dir, 'openspec/config.yaml');
  fs.writeFileSync(config, fs.readFileSync(config, 'utf8').replace(/^.*\n/, '# spec-relay: setup did not finish; run setup again.\n'));
  const again = plan(parseArgs(['--target', dir, ...BASE]));
  assert.equal(again.managed, false);
  assert.equal(again.runInit, true);
  assert.deepEqual(again.steps.filter((s) => s.path === config).map((s) => s.action), ['create']);
  assert.deepEqual(conflicts(parseArgs(['--target', dir, ...BASE])), []);
  // The finished run marks it as managed again.
  assert.equal(quiet(() => main(['--target', dir, ...BASE, '--skip-init', '--apply'])), 0);
  assert.ok(fs.readFileSync(config, 'utf8').startsWith(CONFIG_MARKER));
});

test('a node_modules that git tracks in the tools folder is a conflict, never run', () => {
  const dir = tempDir();
  assert.equal(spawnSync('git', ['init', '-q'], { cwd: dir }).status, 0);
  write(dir, 'openspec/spec-relay/tools/node_modules/@fission-ai/openspec/bin/openspec.js', 'require("fs").writeFileSync("ran", "")\n');
  assert.equal(spawnSync('git', ['add', '-f', '.'], { cwd: dir }).status, 0);
  assert.deepEqual(conflicts(parseArgs(['--target', dir, ...BASE])), ['openspec/spec-relay/tools/node_modules/@fission-ai/openspec/bin/openspec.js']);
});

test('the pinned version is the same in the template, the launcher and doctor', async () => {
  const { OPENSPEC_TESTED } = await import('../scripts/doctor.mjs');
  const pkg = JSON.parse(fs.readFileSync(path.join(KIT_ROOT, 'templates/openspec-tools/package.json'), 'utf8'));
  const lock = JSON.parse(fs.readFileSync(path.join(KIT_ROOT, 'templates/openspec-tools/package-lock.json'), 'utf8'));
  assert.equal(pkg.dependencies['@fission-ai/openspec'], OPENSPEC_VERSION);
  assert.equal(lock.packages['node_modules/@fission-ai/openspec'].version, OPENSPEC_VERSION);
  assert.equal(lock.packages[''].dependencies['@fission-ai/openspec'], OPENSPEC_VERSION);
  assert.equal(OPENSPEC_TESTED, OPENSPEC_VERSION);
});
