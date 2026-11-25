#!/usr/bin/env node
// Sets up spec-relay in the repository being migrated:
//   1. copies the spec-relay OpenSpec schemas into openspec/schemas/
//   2. writes openspec/config.yaml with the migration context
//   3. installs the OpenSpec CLI the kit is tested with into
//      openspec/spec-relay/tools/ (package.json and package-lock.json from
//      templates/openspec-tools/, then `npm ci`), so every person and machine on
//      this repository runs the same version, whatever is installed globally
//   4. runs `openspec init --tools github-copilot --scope project` with that CLI, which keeps the
//      config above (the artifact language lives in that config's context, so
//      init gets no --language)
//   5. replaces the generic OpenSpec apply/archive/sync skills init installs in
//      .agents/skills/ (OpenSpec 2.x) with stubs that send the agent to the orchestrator, because they would
//      tick review.md and archive without the review gate. The files stay in
//      place: deleting them makes a later `openspec update` narrow the person's
//      global OpenSpec profile (%APPDATA%\\openspec or ~/.config/openspec), which
//      affects every project.
// Without --apply it only prints the plan. A schema or pinning file that an
// earlier kit version installed (its content is listed in known-files.json) is
// replaced with this version's, so a kit update needs no manual deletes. It
// never overwrites any other file whose content differs from the kit's, and it
// never lets `openspec init` replace or clean up files that already exist; it
// reports the conflict and stops instead.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runOpenspec, probeOpenspec, findNpm, runCommand, trackedModules, TOOLS_DIR } from './openspec.mjs';
import { isKnown, knownFiles } from './known-files.mjs';

export const KIT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const SCHEMAS = ['spec-relay-survey', 'spec-relay-target', 'spec-relay-extract', 'spec-relay-amend', 'spec-relay-port', 'spec-relay-finish'];
export const CONFIG_MARKER = '# spec-relay: managed';
// The first line of a config this script wrote before init finished. A run
// that stops on the way leaves it, and the next run starts over.
const PENDING_MARKER = '# spec-relay: setup did not finish; run setup again.';
// The files that pin OpenSpec in the repository, from templates/openspec-tools/.
const TOOL_FILES = ['package.json', 'package-lock.json', '.gitignore'];
// Generic OpenSpec skills. Apply (ticks the tracked file), archive (also
// bulk-archive) and sync bypass the review gate; the others (propose, explore,
// update ...) are not part of the spec-relay flow and call a bare `openspec`,
// which is whatever version is on PATH, not the one pinned here. So every
// OpenSpec-generated skill is replaced, opt-in profile workflows included.
const BYPASS_NAME = /^openspec-/;
// OpenSpec 2.x writes every skill once, here, and no command files. Copilot
// reads this folder itself, so OpenSpec makes no link for it.
export const SKILLS_DIR = '.agents/skills';
export const STUB_MARKER = '<!-- spec-relay: disabled -->';

export function stubFor(file) {
  const base = path.basename(path.dirname(file));
  const description = 'Disabled by spec-relay in this repository. Select the spec-relay-orchestrator agent to propose, apply, review, archive or sync OpenSpec changes.';
  const front = `---\nname: ${base}\ndescription: ${description}\n---\n`;
  return `${front}\n${STUB_MARKER}\n\nThis repository is migrated with spec-relay. Every OpenSpec workflow here (proposing, applying,\narchiving or syncing a change) goes through the \`spec-relay-orchestrator\` agent, which runs the\nhuman review gate and the OpenSpec version pinned in this repository.\nDo not perform this workflow. Tell the person to select \`spec-relay-orchestrator\` (Copilot CLI: \`/agent\`) and stop.\n`;
}
// The stub spec-relay 0.6.0 and earlier wrote over OpenSpec 1.x files under
// .github/ (skills and prompts). Only a file exactly like it is removed by setup.
export function legacyStubFor(file) {
  const skill = path.basename(file) === 'SKILL.md';
  const base = skill ? path.basename(path.dirname(file)) : path.basename(file, '.prompt.md');
  const description = 'Disabled by spec-relay in this repository. Select the spec-relay-orchestrator agent to apply, review, archive or sync OpenSpec changes.';
  const front = skill ? `---\nname: ${base}\ndescription: ${description}\n---\n` : `---\ndescription: "${description}"\n---\n`;
  return `${front}\n${STUB_MARKER}\n\nThis repository is migrated with spec-relay. Applying, archiving or syncing an OpenSpec change here\nmust go through the \`spec-relay-orchestrator\` agent, which runs the human review gate.\nDo not perform this workflow. Tell the person to select \`spec-relay-orchestrator\` (Copilot CLI: \`/agent\`) and stop.\n`;
}
const CASE_INSENSITIVE_FS = process.platform === 'win32' || process.platform === 'darwin';

const USAGE = `Usage: node scripts/setup.mjs --target DIR --source-language LANG --target-language LANG
         --target-root DIR [--source-root DIR] [--language LANG]
         [--parallel N] [--ahead N] [--subagent-model ID]
         [--analyst-model ID] [--checker-model ID] [--implementer-model ID]
         [--hooks on|off] [--skip-init] [--apply]

  --target           repository being migrated (default: current directory)
  --source-language  language of the existing code, e.g. "C#"
  --target-language  language of the new implementation, e.g. "TypeScript"
  --source-root      directory of the existing code, relative to --target (default: .)
  --target-root      directory for the new implementation, relative to --target
  --language         language OpenSpec artifacts are written in (default: en)
  --parallel         subagents the orchestrator runs at once, 1-32 (default: 4;
                     Copilot Business allows 16, Enterprise 32)
  --ahead            capabilities analyzed ahead of the person's review, 1-10 (default: 2)
  --subagent-model   model of every subagent, e.g. "claude-sonnet-5.5" (default: session,
                     the model of the session that runs the orchestrator)
  --analyst-model, --checker-model, --implementer-model
                     model of one role, overriding --subagent-model
  --hooks            on: the plugin hook denies an archive that fails its gate and
                     agent writes to the source root, baseline specs and settings
                     (default: off until it is checked on each Copilot client)
  --skip-init        do not install OpenSpec or run "openspec init" (for tests)
  --apply            make the changes; without it only the plan is printed`;

class UsageError extends Error {}

export function parseArgs(argv) {
  const opts = { target: process.cwd(), sourceRoot: '.', language: 'en', parallel: '4', ahead: '2', subagentModel: 'session', hooks: 'off', apply: false, skipInit: false };
  const keys = {
    '--target': 'target', '--source-language': 'sourceLanguage', '--target-language': 'targetLanguage',
    '--source-root': 'sourceRoot', '--target-root': 'targetRoot', '--language': 'language',
    '--parallel': 'parallel', '--ahead': 'ahead', '--subagent-model': 'subagentModel',
    '--analyst-model': 'analystModel', '--checker-model': 'checkerModel', '--implementer-model': 'implementerModel',
    '--hooks': 'hooks',
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
  // A repository set up already keeps these in its config (they are not
  // applied again), so `setup.mjs --target . --apply` is enough to re-run.
  const managedConfig = readText(path.join(path.resolve(opts.target), 'openspec/config.yaml'));
  if (managedConfig.includes(CONFIG_MARKER)) {
    const value = (label) => managedConfig.match(new RegExp(`^\\s*${label}[^:\\n]*:[ \\t]*(.+?)\\s*$`, 'm'))?.[1];
    opts.sourceLanguage ??= value('Source language');
    opts.targetLanguage ??= value('Target language');
    opts.targetRoot ??= value('Target root');
    if (!argv.includes('--source-root')) opts.sourceRoot = value('Source root') ?? opts.sourceRoot;
  }
  for (const [flag, key] of [['--source-language', 'sourceLanguage'], ['--target-language', 'targetLanguage'], ['--target-root', 'targetRoot']]) {
    if (!opts[key]) throw new UsageError(`${flag} is required`);
  }
  for (const key of ['sourceLanguage', 'targetLanguage', 'sourceRoot', 'targetRoot', 'language']) {
    if (/[\r\n]/.test(opts[key])) throw new UsageError(`--${key} must be a single line`);
  }
  for (const [flag, key, max] of [['--parallel', 'parallel', 32], ['--ahead', 'ahead', 10]]) {
    const n = Number(opts[key]);
    if (!/^\d+$/.test(String(opts[key])) || n < 1 || n > max) throw new UsageError(`${flag} must be a whole number from 1 to ${max}`);
    opts[key] = n;
  }
  opts.hooksGiven = argv.includes('--hooks');
  opts.hooks = String(opts.hooks).toLowerCase();
  if (!['on', 'off'].includes(opts.hooks)) throw new UsageError('--hooks must be on or off');
  const model = (value) => /^[^\r\n#{}"'`]{1,80}$/.test(value);
  const modelHelp = 'must be a model name on one line (no #, quotes or braces), or "session"';
  opts.subagentModel = opts.subagentModel.trim();
  if (!model(opts.subagentModel)) throw new UsageError(`--subagent-model ${modelHelp}`);
  for (const role of ['analyst', 'checker', 'implementer']) {
    const key = `${role}Model`;
    opts[key] = (opts[key] ?? opts.subagentModel).trim();
    if (!model(opts[key])) throw new UsageError(`--${role}-model ${modelHelp}`);
    if (opts[key].toLowerCase() === 'session') opts[key] = 'session';
  }
  for (const key of ['sourceRoot', 'targetRoot']) {
    const flag = key === 'sourceRoot' ? '--source-root' : '--target-root';
    if (path.isAbsolute(opts[key]) || /^([A-Za-z]:|[\\/])/.test(opts[key]) || opts[key].split(/[\\/]/).includes('..')) {
      throw new UsageError(`${flag} must be a relative path inside --target`);
    }
    for (const part of segments(opts[key])) {
      // The repository is shared with Windows machines even when setup runs elsewhere.
      if (/[<>:"|?*]/.test(part) || /[. ]$/.test(part) || WINDOWS_RESERVED.test(part)) {
        throw new UsageError(`${flag} contains a name Windows cannot use: "${part}"`);
      }
    }
    opts[key] = segments(opts[key]).join('/') || '.';
  }
  const source = segments(opts.sourceRoot);
  const target = segments(opts.targetRoot);
  if (target.length === 0 || ['openspec', '.github', '.agents'].includes(fold(target[0]))) {
    throw new UsageError('--target-root must be a new directory, not the repository root, openspec/, .github/ or .agents/');
  }
  if (source.length > 0 && (isPrefix(source, target) || isPrefix(target, source))) {
    throw new UsageError('--target-root and --source-root must not contain each other (only --source-root . may contain the target)');
  }
  opts.target = path.resolve(opts.target);
  return opts;
}

const WINDOWS_RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i;
const fold = (name) => (CASE_INSENSITIVE_FS ? name.toLowerCase() : name);
// The same text whatever the checkout did to it: Git for Windows converts LF to
// CRLF by default (core.autocrlf=true), and some editors add a UTF-8 BOM.
export const normalizeText = (text) => text.replace(/^\uFEFF/, '').replace(/\r\n/g, '\n');
const readText = (file) => { try { return normalizeText(fs.readFileSync(file, 'utf8')); } catch { return ''; } };
// Splits on both separators so "a\\b" is checked the same way on every platform.
const segments = (rel) => rel.split(/[\\/]+/).filter((part) => part && part !== '.');
const isPrefix = (a, b) => a.length <= b.length && a.every((part, i) => fold(part) === fold(b[i]));

function listFiles(dir, base = dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    return entry.isDirectory() ? listFiles(full, base) : [path.relative(base, full)];
  });
}

// The skillsScope key of openspec/config.yaml (OpenSpec 2.1+): 'project',
// another value, or null when it is not there.
export function skillsScope(text) {
  const match = text.replace(/^\uFEFF/, '').match(/^(["']?)skillsScope\1[ \t]*:[ \t]*(?:"([^"\r\n]*)"|'([^'\r\n]*)'|(\S*?))[ \t]*(?:[ \t]#.*)?$/m);
  return match ? (match[2] ?? match[3] ?? match[4]) : null;
}

// The config with `skillsScope: project` after its schema line (or at the end),
// in the file's own line endings.
export function withProjectScope(text) {
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  const line = `skillsScope: project${eol}`;
  if (/^schema:.*$/m.test(text)) return text.replace(/^(schema:[^\r\n]*)(\r?\n|$)/m, (_, schema, end) => `${schema}${end || eol}${line}`);
  return `${text}${text === '' || text.endsWith('\n') ? '' : eol}${line}`;
}

export function renderConfig(opts) {
  const template = fs.readFileSync(path.join(KIT_ROOT, 'templates/openspec-config.yaml'), 'utf8');
  const values = {
    SOURCE_LANGUAGE: opts.sourceLanguage, TARGET_LANGUAGE: opts.targetLanguage,
    SOURCE_ROOT: opts.sourceRoot, TARGET_ROOT: opts.targetRoot, ARTIFACT_LANGUAGE: opts.language,
    PARALLEL: opts.parallel ?? 4, AHEAD: opts.ahead ?? 2,
    ANALYST_MODEL: opts.analystModel ?? 'session', CHECKER_MODEL: opts.checkerModel ?? 'session',
    IMPLEMENTER_MODEL: opts.implementerModel ?? 'session', HOOKS: opts.hooks ?? 'off',
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

// OpenSpec files that tools' own folders (.github/, .claude/, .cursor/ ...) may
// hold from OpenSpec 1.x: skills, commands, prompts and workflows named
// openspec-* or opsx*. OpenSpec 2.x init deletes the unedited ones and links
// the shared skills into some of these folders.
const TOOL_SUBDIRS = ['skills', 'commands', 'prompts', 'workflows'];
const OPENSPEC_NAME = /^(openspec-|opsx)/;
function toolFiles(target, only) {
  const found = [];
  let tools = [];
  try { tools = fs.readdirSync(target, { withFileTypes: true }); } catch { /* absent */ }
  for (const tool of tools) {
    if (!tool.isDirectory() || !tool.name.startsWith('.') || ['.git', '.agents'].includes(tool.name)) continue;
    if (only && tool.name !== only) continue;
    for (const sub of TOOL_SUBDIRS) {
      let names = [];
      try { names = fs.readdirSync(path.join(target, tool.name, sub)); } catch { /* absent */ }
      for (const name of names) if (OPENSPEC_NAME.test(name)) found.push(path.join(target, tool.name, sub, name));
    }
  }
  return found;
}

// What OpenSpec 1.x (and spec-relay 0.6.0, which stubbed them) left under
// .github/. This kit no longer disables anything there, so in a set-up
// repository they are leftovers for the person to remove (docs/UPGRADING.md in the kit, "0.6.0").
// Skills count when OpenSpec generated them or this kit stubbed them, so a
// skill of the person's own that happens to start with openspec- is left alone.
export function legacyFiles(target) {
  return toolFiles(target, '.github').filter((file) => {
    if (/[\\/]prompts[\\/]opsx-/.test(file)) return true;
    if (!/[\\/]skills[\\/]openspec-/.test(file)) return false;
    const text = readText(path.join(file, 'SKILL.md'));
    return generatedByOpenspec(text) || text.includes(STUB_MARKER);
  });
}

// A legacy file (a skill folder or a prompt) that is exactly the 0.6.0 stub;
// a skill folder holds nothing else.
export function isLegacyStub(file) {
  try {
    if (fs.lstatSync(file).isDirectory()) {
      const names = fs.readdirSync(file);
      if (names.length !== 1 || names[0] !== 'SKILL.md' || !fs.lstatSync(path.join(file, 'SKILL.md')).isFile()) return false;
      return readText(path.join(file, 'SKILL.md')) === legacyStubFor(path.join(file, 'SKILL.md'));
    }
    return fs.lstatSync(file).isFile() && readText(file) === legacyStubFor(file);
  } catch { return false; }
}

// A SKILL.md OpenSpec wrote: up to 2.0 its frontmatter says
// `generatedBy: "<version>"`; from 2.1 that line is gone and only
// `metadata: author: openspec` is left (OpenSpec's skill-generation.js).
export function generatedByOpenspec(text) {
  if (/generatedBy:/.test(text)) return true;
  const front = text.replace(/^\uFEFF/, '').match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/)?.[1];
  return front !== undefined && /^[ \t]+author:[ \t]*(["']?)openspec\1[ \t]*$/m.test(front);
}

// Files `openspec init` would replace, delete or edit in a repository that is
// not yet set up. Any of them existing is a conflict for the person to resolve.
function initConflicts(target) {
  const found = [];
  let names = [];
  try { names = fs.readdirSync(path.join(target, SKILLS_DIR)); } catch { /* absent */ }
  for (const name of names) {
    if (/^(openspec-|\.openspec-target$)/.test(name)) found.push(path.join(target, SKILLS_DIR, name));
  }
  found.push(...toolFiles(target));
  for (const rel of ['openspec/AGENTS.md', 'openspec/project.md']) {
    if (exists(path.join(target, rel))) found.push(path.join(target, rel));
  }
  for (const rel of ['AGENTS.md', 'CLAUDE.md', '.github/copilot-instructions.md']) {
    const file = path.join(target, rel);
    if (exists(file) && readText(file).includes('OPENSPEC:START')) found.push(file);
  }
  return found;
}

// Every OpenSpec skill in the repository, stubbed or not.
export function repoSkills(target) {
  let names = [];
  try { names = fs.readdirSync(path.join(target, SKILLS_DIR)); } catch { /* absent */ }
  return names.filter((n) => n.startsWith('openspec-')).map((n) => path.join(target, SKILLS_DIR, n, 'SKILL.md')).filter((f) => exists(f));
}

// The OpenSpec skills in a repository that bypass the review gate, recognised
// by OpenSpec's frontmatter (generatedByOpenspec); a stub this script wrote is skipped.
// Every change is shown in the dry run first.
export function bypassFiles(target) {
  return openspecSkills(path.join(target, SKILLS_DIR));
}

function openspecSkills(dir) {
  const found = [];
  let names = [];
  try { names = fs.readdirSync(dir); } catch { /* absent */ }
  for (const name of names.filter((n) => n.startsWith('openspec-') && BYPASS_NAME.test(n))) {
    const file = path.join(dir, name, 'SKILL.md');
    const text = readText(file);
    if (generatedByOpenspec(text) && !text.includes(STUB_MARKER)) found.push(file);
  }
  return found;
}

// Personal skill folders Copilot reads in every repository (GitHub's "About
// agent skills"). From 2.1.0, `openspec init` in any other project puts its
// skills in ~/.agents/skills by default (an `openspec update` answered with
// "Switch to global" too); ~/.copilot/skills is Copilot's own personal folder.
// Setup cannot disable skills there. Which of two skills with the same name
// Copilot uses is not documented, so doctor warns about these.
export const PERSONAL_SKILL_DIRS = ['.agents/skills', '.copilot/skills'];

export function personalBypassFiles(home) {
  if (!home) return [];
  return PERSONAL_SKILL_DIRS.flatMap((rel) => openspecSkills(path.join(home, rel)));
}

// Returns [{ action: 'create' | 'keep' | 'update' | 'replace' | 'remove' | 'disable' | 'leftover' | 'conflict', path, content?, reason? }],
// whether `openspec init` runs and whether OpenSpec is (re)installed.
export function plan(opts) {
  const steps = [];
  const configYaml = path.join(opts.target, 'openspec/config.yaml');
  const managed = exists(configYaml) && readText(configYaml).includes(CONFIG_MARKER);
  const pending = exists(configYaml) && readText(configYaml).startsWith(PENDING_MARKER);
  const stamped = stampVersion(opts.target);
  if (stamped && compareKitVersions(stamped, KIT_VERSION) > 0) {
    steps.push({ action: 'conflict', path: path.join(opts.target, STAMP), reason: `spec-relay ${stamped} set up this repository, a newer version than this kit (${KIT_VERSION}); update the kit first (someone else on this repository updated it)` });
  }
  // A file an earlier kit version installed is replaced; any other content is
  // someone's edit (or a newer kit's file), which setup never overwrites.
  const EDITED = `differs from this kit version (${KIT_VERSION}) and from every earlier one: someone edited it, or a newer kit wrote it. If someone updated the kit for this repository, update yours first; otherwise restore it (or delete it) and run setup again`;
  const earlier = (kitRel, dest) => isKnown(kitRel, readText(dest));
  const shipped = new Set();
  for (const schema of SCHEMAS) {
    const from = path.join(KIT_ROOT, 'openspec-schemas', schema);
    for (const rel of listFiles(from)) {
      const kitRel = `openspec-schemas/${schema}/${rel.replace(/\\/g, '/')}`;
      shipped.add(kitRel);
      const dest = path.join(opts.target, 'openspec/schemas', schema, rel);
      const content = fs.readFileSync(path.join(from, rel), 'utf8');
      if (!fs.existsSync(dest)) steps.push({ action: 'create', path: dest, content });
      else if (readText(dest) === normalizeText(content)) steps.push({ action: 'keep', path: dest });
      else if (earlier(kitRel, dest)) steps.push({ action: 'replace', path: dest, content, reason: 'from an earlier spec-relay version' });
      else steps.push({ action: 'conflict', path: dest, reason: EDITED });
    }
  }
  // Schema files earlier versions had and this one does not, left as installed.
  for (const kitRel of Object.keys(knownFiles())) {
    if (!kitRel.startsWith('openspec-schemas/') || shipped.has(kitRel)) continue;
    const dest = path.join(opts.target, 'openspec/schemas', ...kitRel.split('/').slice(1));
    if (exists(dest) && earlier(kitRel, dest)) steps.push({ action: 'remove', path: dest, reason: 'from an earlier spec-relay version; this version has no such file' });
  }
  // The pinned OpenSpec: the kit's package.json and lock, compared like the schemas.
  // JSON is compared parsed, so a reformatted file is still the kit's.
  for (const rel of TOOL_FILES) {
    const kitRel = `templates/openspec-tools/${rel}`;
    const dest = path.join(opts.target, TOOLS_DIR, rel);
    const content = fs.readFileSync(path.join(KIT_ROOT, kitRel), 'utf8');
    if (!fs.existsSync(dest)) steps.push({ action: 'create', path: dest, content, tool: true });
    else if (sameFile(readText(dest), normalizeText(content), rel)) steps.push({ action: 'keep', path: dest });
    else if (earlier(kitRel, dest)) steps.push({ action: 'replace', path: dest, content, tool: true, reason: `from an earlier spec-relay version; this one pins OpenSpec ${PINNED_VERSION}` });
    else steps.push({ action: 'conflict', path: dest, reason: EDITED });
  }
  for (const file of trackedModules(opts.target).slice(0, 3)) {
    steps.push({ action: 'conflict', path: path.join(opts.target, file), reason: 'git tracks files under the pinned OpenSpec\'s node_modules; setup runs OpenSpec from there, so remove them from the repository (git rm -r --cached) first' });
  }
  const configYml = path.join(opts.target, 'openspec/config.yml');
  if (exists(configYml)) {
    steps.push({ action: 'conflict', path: configYml, reason: 'an existing OpenSpec config; merge templates/openspec-config.yaml into it by hand' });
  }
  if (managed) {
    const hooks = readText(configYaml).match(/^\s*Hook enforcement[^:\n]*:[ \t]*(\S+)/m)?.[1]?.toLowerCase() ?? 'off';
    const note = opts.hooksGiven && hooks !== opts.hooks
      ? `; --hooks ${opts.hooks} is not applied: change the "Hook enforcement" line in it yourself (it says ${hooks})` : '';
    const text = fs.readFileSync(configYaml, 'utf8');
    const scope = skillsScope(text);
    if (scope === null) {
      steps.push({ action: 'update', path: configYaml, content: withProjectScope(text), reason: `adds skillsScope: project (OpenSpec 2.1+ would otherwise offer to move the skills out of the repository)${note}` });
    } else if (scope !== 'project') {
      steps.push({ action: 'conflict', path: configYaml, reason: `skillsScope is ${scope || '(empty)'}; it must be project, because setup can disable the gate-bypassing skills only in this repository` });
    } else {
      steps.push({ action: 'keep', path: configYaml, reason: `already managed by spec-relay; edit it to change values${note}` });
    }
  } else if (exists(configYaml) && !pending) {
    steps.push({ action: 'conflict', path: configYaml, reason: 'an existing OpenSpec config; merge templates/openspec-config.yaml into it by hand' });
  } else {
    steps.push({ action: 'create', path: configYaml, content: renderConfig(opts), config: true, reason: pending ? 'replaces the config of a setup that did not finish' : undefined });
  }
  if (!managed && isDirWithEntries(path.join(opts.target, opts.targetRoot))) {
    steps.push({ action: 'conflict', path: path.join(opts.target, opts.targetRoot), reason: 'the target root already exists and is not empty' });
  }
  // Reported, not a conflict: removing them needs `openspec update`, which needs
  // the OpenSpec this run installs. The 0.6.0 stubs among them are removed, but
  // only once that update ran (the skills are in .agents/skills/): before it,
  // OpenSpec reads a missing workflow as one the person turned off and narrows
  // their global profile, which affects every project.
  if (managed) {
    const updated = repoSkills(opts.target).length > 0;
    for (const file of legacyFiles(opts.target)) {
      if (updated && isLegacyStub(file)) steps.push({ action: 'remove', path: file, reason: 'a stub spec-relay 0.6.0 wrote; OpenSpec 2.x keeps its skills in .agents/skills/' });
      else steps.push({ action: 'leftover', path: file, reason: updated ? 'left by OpenSpec 1.x and not like the kit\'s stub (someone edited it); move what you need out of it and delete it' : 'left by OpenSpec 1.x or spec-relay 0.6.0; run node <kit>/scripts/openspec.mjs update, then setup again ("0.6.0 から更新するとき" in docs/UPGRADING.md of the kit)' });
    }
  }
  const install = !opts.skipInit && (steps.some((s) => s.action === 'replace' && s.tool) || !installedOk(opts.target));
  const runInit = !managed && !opts.skipInit;
  if (runInit) {
    for (const file of initConflicts(opts.target)) {
      steps.push({ action: 'conflict', path: file, reason: 'openspec init would replace, remove or edit it; back it up and move it away first' });
    }
  }
  // Before a first init nothing can match (existing openspec-* skills are
  // conflicts above); after init, main() looks again and disables what init added.
  for (const file of bypassFiles(opts.target)) {
    steps.push({ action: 'disable', path: file, reason: 'generic OpenSpec workflow; bypasses the review gate' });
  }
  return { steps, runInit, managed, install };
}

// The kit version that last set the repository up, so an older kit run by
// someone who has not updated yet stops instead of taking the newer files for edits.
export const KIT_VERSION = JSON.parse(fs.readFileSync(path.join(KIT_ROOT, 'package.json'), 'utf8')).version;
export const STAMP = 'openspec/spec-relay/kit.json';
export function stampVersion(target) {
  try { return JSON.parse(normalizeText(fs.readFileSync(path.join(target, STAMP), 'utf8'))).version ?? null; } catch { return null; }
}
const stampText = () => `${JSON.stringify({ kit: 'spec-relay', version: KIT_VERSION, note: 'Written by setup.mjs: the kit version that last set up this repository. Commit it.' }, null, 2)}\n`;
export function compareKitVersions(a, b) {
  const parts = (v) => String(v).split(/[.+-]/).slice(0, 3).map((n) => Number.parseInt(n, 10) || 0);
  const [x, y] = [parts(a), parts(b)];
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] < y[i] ? -1 : 1;
  return 0;
}

const PINNED_VERSION = JSON.parse(fs.readFileSync(path.join(KIT_ROOT, 'templates/openspec-tools/package.json'), 'utf8')).dependencies['@fission-ai/openspec'];

// Whether the pinned OpenSpec is installed and runs: a damaged tree (an
// interrupted npm ci, a quarantined file) is reinstalled, not kept.
function installedOk(target) {
  if (!exists(path.join(target, TOOLS_DIR, 'node_modules/.package-lock.json'))) return false;
  const probe = probeOpenspec({ cwd: target, timeout: 60000 });
  return probe.ok && probe.version === PINNED_VERSION;
}

function sameFile(theirs, ours, rel) {
  if (!rel.endsWith('.json')) return theirs === ours;
  try { return JSON.stringify(sortKeys(JSON.parse(theirs))) === JSON.stringify(sortKeys(JSON.parse(ours))); } catch { return false; }
}
function sortKeys(value) {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.keys(value).sort().map((k) => [k, sortKeys(value[k])]));
}

// --workspaces=false: a workspaces glob in a package.json above must not make
// npm install the repository's own project instead.
const NPM_CI = ['ci', '--ignore-scripts', '--no-audit', '--no-fund', '--no-update-notifier', '--workspaces=false'];

function npmProblem() {
  const result = runCommand(findNpm(), ['--version'], { timeout: 60000 });
  if (result.notFound || result.error?.code === 'ENOENT') return 'npm was not found. It comes with Node.js 22.20 or later (Windows: winget install OpenJS.NodeJS.LTS); open a new terminal after installing it.';
  if (result.error || result.status !== 0) return `"npm --version" failed: ${(result.error?.message || result.stderr || '').trim().split(/\r?\n/)[0]}`;
  return null;
}

function runInstall(opts) {
  const result = runCommand(findNpm(), NPM_CI, { cwd: path.join(opts.target, TOOLS_DIR), stdio: 'inherit' });
  if (result.error || result.status !== 0) {
    throw new Error(`npm ci in ${TOOLS_DIR} failed${result.error ? `: ${result.error.message}` : ` with exit code ${result.status}`} (see npm's message above; it downloads OpenSpec ${PINNED_VERSION} from the npm registry, so a network or proxy problem is a common cause)`);
  }
}

function runInit(opts) {
  // The target is passed as init's path and as cwd, so nothing depends on a shell.
  // --scope project: from OpenSpec 2.1.0 init otherwise installs the skills in
  // the home folder, where the kit cannot disable apply, archive and sync.
  const args = ['init', '--tools', 'github-copilot', '--scope', 'project', '--no-copilot-cloud', '--no-animation', '.'];
  const result = runOpenspec(args, { cwd: opts.target, stdio: 'inherit' });
  if (result.error || result.status !== 0) {
    throw new Error(`openspec init failed${result.error ? `: ${result.error.message}` : ` with exit code ${result.status}`}`);
  }
}

export function main(argv) {
  const opts = parseArgs(argv);
  if (opts.help) { console.log(USAGE); return 0; }
  if (!fs.existsSync(opts.target) || !fs.statSync(opts.target).isDirectory()) throw new Error(`--target is not a directory: ${opts.target}`);
  const { steps, runInit: willInit, managed, install } = plan(opts);
  const show = (step) => console.log(`${step.action.padEnd(8)} ${path.relative(opts.target, step.path)}${step.reason ? `  (${step.reason})` : ''}`);
  const removals = steps.filter((s) => s.action === 'disable');
  const leftovers = steps.filter((s) => s.action === 'leftover');
  steps.filter((s) => s.action !== 'disable' && s.action !== 'leftover').forEach(show);
  if (install) console.log(`run      npm ci in ${TOOLS_DIR} (installs OpenSpec ${PINNED_VERSION} into this repository)`);
  else if (!opts.skipInit) console.log(`keep     OpenSpec ${PINNED_VERSION} in ${TOOLS_DIR}`);
  if (willInit) console.log('run      openspec init --tools github-copilot --scope project (adds OpenSpec skills under .agents/skills/)');
  else console.log(`skip     openspec init (${managed ? 'already set up; to refresh, run node <kit>/scripts/openspec.mjs update, then this setup again' : '--skip-init'})`);
  removals.forEach(show);
  if (willInit) console.log('disable  every OpenSpec skill openspec init adds (apply, archive and sync bypass the review gate; the rest call an unpinned openspec)');
  leftovers.forEach(show);
  if (steps.some((s) => s.action === 'conflict')) {
    console.error('\nStopped: resolve the conflicts above, then run setup again. Nothing was changed.');
    return 2;
  }
  const problem = install ? npmProblem() : null;
  if (problem) {
    console.error(`\nStopped: ${problem}\nThen run setup again. Nothing was changed.`);
    return 3;
  }
  if (!opts.apply) { console.log('\nDry run. Add --apply to make these changes.'); return 0; }
  const created = steps.filter((s) => s.action === 'create');
  // Replaced files keep their old content here, so a failed run puts them back.
  const replaced = steps.filter((s) => s.action === 'replace').map((s) => ({ ...s, previous: fs.readFileSync(s.path) }));
  const modules = path.join(opts.target, TOOLS_DIR, 'node_modules');
  const hadModules = exists(modules);
  // npm ci deletes node_modules first, so the OpenSpec that ran before is moved
  // aside and put back if this run fails (named node_modules so the tools
  // folder's .gitignore covers it).
  const previous = path.join(opts.target, TOOLS_DIR, '.previous/node_modules');
  let movedAside = false;
  const write = (step, content = step.content) => {
    fs.mkdirSync(path.dirname(step.path), { recursive: true });
    fs.writeFileSync(step.path, content);
  };
  // Undo this run so the next run is a first run again. The config goes
  // first; files a virus scanner still holds get retries, and what cannot be
  // removed is named instead of hiding the real error.
  const undo = (error) => {
    const left = [];
    for (const step of [...created.filter((s) => s.config), ...created.filter((s) => !s.config)]) {
      try { fs.rmSync(step.path, { force: true, maxRetries: 5, retryDelay: 200 }); } catch { left.push(path.relative(opts.target, step.path)); }
    }
    for (const step of replaced) {
      try { fs.writeFileSync(step.path, step.previous); } catch { left.push(path.relative(opts.target, step.path)); }
    }
    let gone = false;
    if (movedAside) {
      try {
        fs.rmSync(modules, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
        fs.renameSync(previous, modules);
        fs.rmSync(path.dirname(previous), { recursive: true, force: true });
      } catch { left.push(path.relative(opts.target, modules)); gone = true; }
    } else if (!hadModules) {
      try { fs.rmSync(modules, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); } catch { left.push(path.relative(opts.target, modules)); }
    } else if (install) gone = true;
    const reinstall = gone ? ' The OpenSpec that was installed in the tools folder could not be kept, so the kit cannot run OpenSpec until setup succeeds.' : '';
    return new Error(`${error.message}. The files this run created were removed and the ones it replaced were put back${left.length ? `, except ${left.join(', ')}` : ''}.${reinstall} Fix the problem and run setup again.`);
  };
  // The pinned OpenSpec first, then the rest. A new config is written with a
  // pending first line and marked as managed only after init, so a run that
  // stops on the way (a lost network, a closed terminal) is a first run again.
  const config = created.find((s) => s.config);
  try {
    for (const step of [...created, ...replaced].filter((s) => s.tool)) write(step);
    if (install && hadModules) {
      fs.rmSync(path.dirname(previous), { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
      try {
        fs.mkdirSync(path.dirname(previous), { recursive: true });
        fs.renameSync(modules, previous);
        movedAside = true;
      } catch { /* held open (a virus scanner): npm ci replaces it in place */ }
    }
    if (install) runInstall(opts);
    for (const step of created.filter((s) => !s.tool)) write(step, step.config ? step.content.replace(/^.*\n/, `${PENDING_MARKER}\n`) : step.content);
    for (const step of replaced.filter((s) => !s.tool)) write(step);
    if (willInit) runInit(opts);
    if (config) write(config);
    for (const step of steps.filter((s) => s.action === 'update')) write(step);
  } catch (error) {
    throw undo(error);
  }
  if (movedAside) fs.rmSync(path.dirname(previous), { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  for (const file of willInit ? bypassFiles(opts.target) : removals.map((s) => s.path)) {
    fs.writeFileSync(file, stubFor(file));
    if (willInit) console.log(`disabled ${path.relative(opts.target, file)}`);
  }
  // Files of earlier versions go last, after the skills are disabled.
  const stuck = [];
  for (const step of steps.filter((s) => s.action === 'remove')) {
    try {
      fs.rmSync(step.path, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    } catch { stuck.push(path.relative(opts.target, step.path)); continue; }
    console.log(`removed  ${path.relative(opts.target, step.path)}`);
    // Folders this emptied (.github/prompts/, then .github/ itself; a schema's
    // templates/), never openspec/schemas/ or anything above it.
    for (let dir = path.dirname(step.path); dir.startsWith(opts.target + path.sep) && dir !== path.join(opts.target, 'openspec/schemas'); dir = path.dirname(dir)) {
      try { if (fs.readdirSync(dir).length) break; fs.rmdirSync(dir); } catch { break; }
    }
  }
  if (stampVersion(opts.target) !== KIT_VERSION) {
    fs.mkdirSync(path.dirname(path.join(opts.target, STAMP)), { recursive: true });
    fs.writeFileSync(path.join(opts.target, STAMP), stampText());
  }
  if (stuck.length) {
    console.error(`\nNot finished: could not remove ${stuck.join(', ')} (a program may hold it open). Close it or delete it yourself, then run setup again.`);
    return 2;
  }
  if (leftovers.length) {
    console.error(steps.some((s) => s.action === 'leftover' && !/someone edited/.test(s.reason))
      ? '\nNot finished: OpenSpec is installed, but OpenSpec 1.x left the files listed as leftover under .github/. In this repository run node "<kit>/scripts/openspec.mjs" update, then run setup again: it removes what update leaves of the kit\'s old stubs ("0.6.0 から更新するとき" in docs/UPGRADING.md of the kit).'
      : '\nNot finished: the files listed as leftover are still under .github/. Move what you need out of them, delete them, then run setup again ("0.6.0 から更新するとき" in docs/UPGRADING.md of the kit).');
    return 2;
  }
  console.log('\nspec-relay is set up. Select the spec-relay orchestrator agent to start with the survey (step 1).');
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
