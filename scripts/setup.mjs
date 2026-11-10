#!/usr/bin/env node
// Sets up spec-relay in the repository being migrated:
//   1. copies the spec-relay OpenSpec schemas into openspec/schemas/
//   2. writes openspec/config.yaml with the migration context
//   3. runs `openspec init --tools github-copilot`, which keeps the config above
//      (the artifact language lives in that config's context, so init gets no --language)
// Without --apply it only prints the plan. It never overwrites a file whose
// content differs from the kit's; it reports the conflict and stops instead.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export const KIT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const SCHEMAS = ['spec-relay-extract', 'spec-relay-port'];
export const CONFIG_MARKER = '# spec-relay: managed';

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
    if (path.isAbsolute(opts[key]) || opts[key].split(/[\\/]/).includes('..')) {
      throw new UsageError(`${key === 'sourceRoot' ? '--source-root' : '--target-root'} must stay inside --target`);
    }
  }
  if (['.', 'openspec'].includes(path.normalize(opts.targetRoot).split(path.sep)[0])) {
    throw new UsageError('--target-root must be a new directory, not the repository root or openspec/');
  }
  if (path.normalize(opts.targetRoot) === path.normalize(opts.sourceRoot)) {
    throw new UsageError('--target-root must differ from --source-root');
  }
  opts.target = path.resolve(opts.target);
  return opts;
}

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

// Returns [{ action: 'create' | 'keep' | 'conflict', path, content?, reason? }].
export function plan(opts) {
  const steps = [];
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
  const config = path.join(opts.target, 'openspec/config.yaml');
  if (!fs.existsSync(config)) {
    steps.push({ action: 'create', path: config, content: renderConfig(opts) });
  } else if (fs.readFileSync(config, 'utf8').includes(CONFIG_MARKER)) {
    steps.push({ action: 'keep', path: config, reason: 'already managed by spec-relay; edit it to change values' });
  } else {
    steps.push({ action: 'conflict', path: config, reason: 'an existing OpenSpec config; merge templates/openspec-config.yaml into it by hand' });
  }
  return steps;
}

function runInit(opts) {
  const args = ['init', '--tools', 'github-copilot', '--no-copilot-cloud', '--no-animation', '.'];
  const result = spawnSync('openspec', args, { cwd: opts.target, stdio: 'inherit', shell: process.platform === 'win32' });
  if (result.error && result.error.code === 'ENOENT') {
    throw new Error('the openspec CLI was not found. Install it with "npm install -g @fission-ai/openspec@latest" and run setup again.');
  }
  if (result.status !== 0) throw new Error(`openspec init failed with exit code ${result.status}`);
}

export function main(argv) {
  const opts = parseArgs(argv);
  if (opts.help) { console.log(USAGE); return 0; }
  if (!fs.existsSync(opts.target) || !fs.statSync(opts.target).isDirectory()) throw new Error(`--target is not a directory: ${opts.target}`);
  const steps = plan(opts);
  for (const step of steps) {
    console.log(`${step.action.padEnd(8)} ${path.relative(opts.target, step.path)}${step.reason ? `  (${step.reason})` : ''}`);
  }
  console.log(`${opts.skipInit ? 'skip    ' : 'run     '} openspec init --tools github-copilot`);
  if (steps.some((s) => s.action === 'conflict')) {
    console.error('\nStopped: resolve the conflicts above, then run setup again. Nothing was changed.');
    return 2;
  }
  if (!opts.apply) { console.log('\nDry run. Add --apply to make these changes.'); return 0; }
  for (const step of steps.filter((s) => s.action === 'create')) {
    fs.mkdirSync(path.dirname(step.path), { recursive: true });
    fs.writeFileSync(step.path, step.content);
  }
  if (!opts.skipInit) runInit(opts);
  console.log('\nspec-relay is set up. Select the spec-relay orchestrator agent to start phase 1.');
  return 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    process.exitCode = main(process.argv.slice(2));
  } catch (error) {
    console.error(`setup: ${error.message}${error instanceof UsageError ? `\n\n${USAGE}` : ''}`);
    process.exitCode = 1;
  }
}
