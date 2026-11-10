#!/usr/bin/env node
// Sets up spec-relay in the repository being migrated:
//   1. copies the spec-relay OpenSpec schemas into openspec/schemas/
//   2. writes openspec/config.yaml with the migration context
//   3. runs `openspec init --tools github-copilot`, which keeps the config above
//      (the artifact language lives in that config's context, so init gets no --language)
//   4. removes the generic OpenSpec apply/archive/sync workflows init installs,
//      because they would tick review.md and archive without the review gate
// Without --apply it only prints the plan. It never overwrites a file whose
// content differs from the kit's, and it never lets `openspec init` replace or
// clean up files that already exist; it reports the conflict and stops instead.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export const KIT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const SCHEMAS = ['spec-relay-extract', 'spec-relay-port'];
export const CONFIG_MARKER = '# spec-relay: managed';
// Generic OpenSpec workflows that bypass the spec-relay review gate: anything
// that applies (ticks the tracked file), archives (including bulk-archive) or
// syncs specs. Matched by name so opt-in profile workflows are covered too.
const BYPASS_NAME = /apply|archive|sync/;
const CASE_INSENSITIVE_FS = process.platform === 'win32' || process.platform === 'darwin';

const USAGE = `Usage: node scripts/setup.mjs --target DIR --source-language LANG --target-language LANG
         --target-root DIR [--source-root DIR] [--language LANG] [--skip-init] [--apply]

  --target           repository being migrated (default: current directory)
  --source-language  language of the existing code, e.g. "C#"
  --target-language  language of the new implementation, e.g. "TypeScript"
  --source-root      directory of the existing code, relative to --target (default: .)
  --target-root      directory for the new implementation, relative to --target
  --language         language OpenSpec artifacts are written in (default: en)
  --skip-init        do not run "openspec init" (for tests or a manual init)
  --apply            make the changes; without it only the plan is printed`;

class UsageError extends Error {}

export function parseArgs(argv) {
  const opts = { target: process.cwd(), sourceRoot: '.', language: 'en', apply: false, skipInit: false };
  const keys = {
    '--target': 'target', '--source-language': 'sourceLanguage', '--target-language': 'targetLanguage',
    '--source-root': 'sourceRoot', '--target-root': 'targetRoot', '--language': 'language',
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--apply') opts.apply = true;
    else if (arg === '--skip-init') opts.skipInit = true;
    else if (arg === '--help' || arg === '-h') opts.help = true;
    else if (keys[arg]) {
      const value = argv[++i];
      if (value === undefined || value.startsWith('--')) throw new UsageError(`${arg} needs a value`);
      opts[keys[arg]] = value;
    } else throw new UsageError(`unknown option: ${arg}`);
  }
  if (opts.help) return opts;
  for (const [flag, key] of [['--source-language', 'sourceLanguage'], ['--target-language', 'targetLanguage'], ['--target-root', 'targetRoot']]) {
    if (!opts[key]) throw new UsageError(`${flag} is required`);
  }
  for (const key of ['sourceLanguage', 'targetLanguage', 'sourceRoot', 'targetRoot', 'language']) {
    if (/[\r\n]/.test(opts[key])) throw new UsageError(`--${key} must be a single line`);
  }
  for (const key of ['sourceRoot', 'targetRoot']) {
    const flag = key === 'sourceRoot' ? '--source-root' : '--target-root';
    if (path.isAbsolute(opts[key]) || /^[A-Za-z]:/.test(opts[key]) || opts[key].split(/[\\/]/).includes('..')) {
      throw new UsageError(`${flag} must be a relative path inside --target`);
    }
    opts[key] = segments(opts[key]).join('/') || '.';
  }
  const source = segments(opts.sourceRoot);
  const target = segments(opts.targetRoot);
  if (target.length === 0 || fold(target[0]) === 'openspec' || fold(target[0]) === '.github') {
    throw new UsageError('--target-root must be a new directory, not the repository root, openspec/ or .github/');
  }
  if (source.length > 0 && (isPrefix(source, target) || isPrefix(target, source))) {
    throw new UsageError('--target-root and --source-root must not contain each other (only --source-root . may contain the target)');
  }
  opts.target = path.resolve(opts.target);
  return opts;
}

// Windows ignores trailing dots and spaces in names ("openspec." is openspec/).
const fold = (name) => {
  const trimmed = process.platform === 'win32' ? name.replace(/[. ]+$/, '') : name;
  return CASE_INSENSITIVE_FS ? trimmed.toLowerCase() : trimmed;
};
// Splits on both separators so "a\\b" is checked the same way on every platform.
const segments = (rel) => rel.split(/[\\/]+/).filter((part) => part && part !== '.');
const isPrefix = (a, b) => a.length <= b.length && a.every((part, i) => fold(part) === fold(b[i]));

function listFiles(dir, base = dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    return entry.isDirectory() ? listFiles(full, base) : [path.relative(base, full)];
  });
}

export function renderConfig(opts) {
  const template = fs.readFileSync(path.join(KIT_ROOT, 'templates/openspec-config.yaml'), 'utf8');
  const values = {
    SOURCE_LANGUAGE: opts.sourceLanguage, TARGET_LANGUAGE: opts.targetLanguage,
    SOURCE_ROOT: opts.sourceRoot, TARGET_ROOT: opts.targetRoot, ARTIFACT_LANGUAGE: opts.language,
  };
  return template.replace(/\{\{([A-Z_]+)\}\}/g, (_, key) => {
    if (!(key in values)) throw new Error(`unknown placeholder ${key}`);
    return values[key];
  });
}

function exists(file) {
  try { fs.lstatSync(file); return true; } catch { return false; }
}

function isDirWithEntries(dir) {
  try { return fs.statSync(dir).isDirectory() ? fs.readdirSync(dir).length > 0 : true; } catch { return false; }
}

// Files `openspec init` would replace, delete or edit in a repository that is
// not yet set up. Any of them existing is a conflict for the person to resolve.
function initConflicts(target) {
  const found = [];
  for (const dir of ['.github/skills', '.github/prompts']) {
    let names = [];
    try { names = fs.readdirSync(path.join(target, dir)); } catch { /* absent */ }
    for (const name of names) {
      if (/^(openspec-|opsx-)/.test(name)) found.push(path.join(target, dir, name));
    }
  }
  for (const rel of ['openspec/AGENTS.md', 'openspec/project.md']) {
    if (exists(path.join(target, rel))) found.push(path.join(target, rel));
  }
  for (const rel of ['AGENTS.md', 'CLAUDE.md', '.github/copilot-instructions.md']) {
    const file = path.join(target, rel);
    if (exists(file) && fs.readFileSync(file, 'utf8').includes('OPENSPEC:START')) found.push(file);
  }
  return found;
}

// The OpenSpec workflow files in a repository that bypass the review gate.
// Skills are recognised by OpenSpec's generatedBy metadata, prompts by name and
// by invoking the openspec CLI. Every removal is shown in the dry run first.
export function bypassFiles(target) {
  const found = [];
  const read = (file) => { try { return fs.readFileSync(file, 'utf8'); } catch { return ''; } };
  let names = [];
  try { names = fs.readdirSync(path.join(target, '.github/skills')); } catch { /* absent */ }
  for (const name of names.filter((n) => n.startsWith('openspec-') && BYPASS_NAME.test(n))) {
    const file = path.join(target, '.github/skills', name, 'SKILL.md');
    if (/generatedBy:/.test(read(file))) found.push(file);
  }
  names = [];
  try { names = fs.readdirSync(path.join(target, '.github/prompts')); } catch { /* absent */ }
  for (const name of names.filter((n) => /^opsx-.*\.prompt\.md$/.test(n) && BYPASS_NAME.test(n))) {
    const file = path.join(target, '.github/prompts', name);
    if (/\bopenspec /.test(read(file))) found.push(file);
  }
  return found;
}

// Returns [{ action: 'create' | 'keep' | 'remove' | 'conflict', path, content?, reason? }]
// and whether `openspec init` will run.
export function plan(opts) {
  const steps = [];
  const configYaml = path.join(opts.target, 'openspec/config.yaml');
  const managed = exists(configYaml) && fs.readFileSync(configYaml, 'utf8').includes(CONFIG_MARKER);
  for (const schema of SCHEMAS) {
    const from = path.join(KIT_ROOT, 'openspec-schemas', schema);
    for (const rel of listFiles(from)) {
      const dest = path.join(opts.target, 'openspec/schemas', schema, rel);
      const content = fs.readFileSync(path.join(from, rel), 'utf8');
      if (!fs.existsSync(dest)) steps.push({ action: 'create', path: dest, content });
      else if (fs.readFileSync(dest, 'utf8') === content) steps.push({ action: 'keep', path: dest });
      else steps.push({ action: 'conflict', path: dest, reason: 'differs from the kit version' });
    }
  }
  const configYml = path.join(opts.target, 'openspec/config.yml');
  if (exists(configYml)) {
    steps.push({ action: 'conflict', path: configYml, reason: 'an existing OpenSpec config; merge templates/openspec-config.yaml into it by hand' });
  }
  if (managed) {
    steps.push({ action: 'keep', path: configYaml, reason: 'already managed by spec-relay; edit it to change values' });
  } else if (exists(configYaml)) {
    steps.push({ action: 'conflict', path: configYaml, reason: 'an existing OpenSpec config; merge templates/openspec-config.yaml into it by hand' });
  } else {
    steps.push({ action: 'create', path: configYaml, content: renderConfig(opts) });
  }
  if (!managed && isDirWithEntries(path.join(opts.target, opts.targetRoot))) {
    steps.push({ action: 'conflict', path: path.join(opts.target, opts.targetRoot), reason: 'the target root already exists and is not empty' });
  }
  const runInit = !managed && !opts.skipInit;
  if (runInit) {
    for (const file of initConflicts(opts.target)) {
      steps.push({ action: 'conflict', path: file, reason: 'openspec init would replace, remove or edit it; back it up and move it away first' });
    }
  }
  // Before a first init nothing can match (existing openspec-*/opsx-* files are
  // conflicts above); after init, main() looks again and removes what init added.
  for (const file of bypassFiles(opts.target)) {
    steps.push({ action: 'remove', path: file, reason: 'generic OpenSpec workflow; bypasses the review gate' });
  }
  return { steps, runInit, managed };
}

function openspecAvailable() {
  const result = spawnSync('openspec', ['--version'], { encoding: 'utf8', shell: process.platform === 'win32' });
  return !result.error && result.status === 0;
}

function runInit(opts) {
  const args = ['init', '--tools', 'github-copilot', '--no-copilot-cloud', '--no-animation', '.'];
  const result = spawnSync('openspec', args, { cwd: opts.target, stdio: 'inherit', shell: process.platform === 'win32' });
  if (result.error || result.status !== 0) throw new Error(`openspec init failed with exit code ${result.status}`);
}

export function main(argv) {
  const opts = parseArgs(argv);
  if (opts.help) { console.log(USAGE); return 0; }
  if (!fs.existsSync(opts.target) || !fs.statSync(opts.target).isDirectory()) throw new Error(`--target is not a directory: ${opts.target}`);
  const { steps, runInit: willInit, managed } = plan(opts);
  const show = (step) => console.log(`${step.action.padEnd(8)} ${path.relative(opts.target, step.path)}${step.reason ? `  (${step.reason})` : ''}`);
  const removals = steps.filter((s) => s.action === 'remove');
  steps.filter((s) => s.action !== 'remove').forEach(show);
  if (willInit) console.log('run      openspec init --tools github-copilot (adds OpenSpec skills and prompts under .github/)');
  else console.log(`skip     openspec init (${managed ? 'already set up; run "openspec update" to refresh, then this setup again' : '--skip-init'})`);
  removals.forEach(show);
  if (willInit) console.log('remove   the apply, archive and sync workflows openspec init adds (they bypass the review gate)');
  if (steps.some((s) => s.action === 'conflict')) {
    console.error('\nStopped: resolve the conflicts above, then run setup again. Nothing was changed.');
    return 2;
  }
  if (willInit && !openspecAvailable()) {
    console.error('\nStopped: the openspec CLI was not found. Install it with "npm install -g @fission-ai/openspec@1.17.0" and run setup again. Nothing was changed.');
    return 3;
  }
  if (!opts.apply) { console.log('\nDry run. Add --apply to make these changes.'); return 0; }
  const created = steps.filter((s) => s.action === 'create');
  for (const step of created) {
    fs.mkdirSync(path.dirname(step.path), { recursive: true });
    fs.writeFileSync(step.path, step.content);
  }
  if (willInit) {
    try {
      runInit(opts);
    } catch (error) {
      // Undo this run's files so the next run is a first run again (the config
      // marker would otherwise make it skip init).
      for (const step of created) fs.rmSync(step.path, { force: true });
      throw new Error(`${error.message}. The files this run created were removed; fix the problem and run setup again.`);
    }
  }
  for (const file of willInit ? bypassFiles(opts.target) : removals.map((s) => s.path)) {
    fs.rmSync(file, { force: true });
    const dir = path.dirname(file);
    if (path.basename(path.dirname(dir)) === 'skills' && exists(dir) && fs.readdirSync(dir).length === 0) fs.rmdirSync(dir);
    if (willInit) console.log(`removed  ${path.relative(opts.target, file)}`);
  }
  console.log('\nspec-relay is set up. Select the spec-relay orchestrator agent to start phase 1.');
  return 0;
}

function invokedDirectly() {
  if (!process.argv[1]) return false;
  try { return fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url)); } catch { return false; }
}

if (invokedDirectly()) {
  try {
    process.exitCode = main(process.argv.slice(2));
  } catch (error) {
    console.error(`setup: ${error.message}${error instanceof UsageError ? `\n\n${USAGE}` : ''}`);
    process.exitCode = 1;
  }
}
