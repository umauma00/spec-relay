#!/usr/bin/env node
// preToolUse hook of the spec-relay plugin (com.github.copilot/hooks/hooks.json).
// Copilot CLI, VS Code (Copilot harness) and the Copilot app run it before every
// shell command and file edit, also inside subagents, with the call as JSON on stdin.
//
// It acts only in a repository that spec-relay set up and whose openspec/config.yaml
// says "Hook enforcement: on" (off by default). There it denies:
//   - `openspec archive` of a spec-relay change while its gate fails (gate.mjs review
//     or port-done), without a change name, with --skip-specs or --no-validate on an
//     extract or amend change, or from a subagent;
//   - file edits under the source root (with source root ".", everything outside
//     openspec/ and the target root), under openspec/specs/, openspec/changes/archive/,
//     openspec/schemas/, of openspec/config.yaml, and inside the kit itself;
//   - subagent edits of review.md, questions.md and the plan;
//   - shell commands that mention the "Hook enforcement" setting.
// Shell commands that write files some other way are not parsed; the wave guard
// (gate.mjs guard) still finds those changes afterwards.
//
// A deny is printed as {"permissionDecision":"deny",...}; anything else prints
// nothing. The script always exits 0, and hooks.json exits 0 when node itself is
// missing, so a broken install falls through to the normal permission prompt
// instead of blocking every tool (Copilot denies on a non-zero exit).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkReview, checkPortDone, changeSchema, configValue, cleanValue, nextSteps, language, readIf } from './gate.mjs';

const KIT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SHELL_TOOLS = new Set(['bash', 'powershell', 'shell', 'run_in_terminal']);
const EDIT_TOOLS = new Set(['edit', 'create', 'write', 'str_replace_editor', 'str_replace', 'insert', 'apply_patch', 'multi_edit', 'delete', 'rename', 'move']);
const PATH_KEYS = ['path', 'file_path', 'filePath', 'filename', 'file', 'target_file', 'new_path', 'newPath', 'old_path', 'oldPath', 'destination'];
const FOLD = process.platform === 'win32' || process.platform === 'darwin';
const REVIEWED = new Set(['spec-relay-survey', 'spec-relay-target', 'spec-relay-extract', 'spec-relay-amend']);

// The repository root above `cwd` that spec-relay set up, or null.
export function findRoot(cwd) {
  let dir = path.resolve(cwd || '.');
  for (;;) {
    const config = readIf(path.join(dir, 'openspec/config.yaml'), []);
    if (config !== null && /#\s*spec-relay: managed/.test(config)) return dir;
    const up = path.dirname(dir);
    if (up === dir) return null;
    dir = up;
  }
}

export function enforced(root) {
  return /^(on|true|yes|enforce)$/i.test(cleanValue(configValue(root, 'Hook enforcement', 'off')));
}

function parsedArgs(raw) {
  if (typeof raw !== 'string') return raw && typeof raw === 'object' ? raw : {};
  try { const v = JSON.parse(raw); return v && typeof v === 'object' ? v : { input: raw }; } catch { return { input: raw }; }
}

// The paths an edit call writes: the usual argument names, and the file headers
// of an apply_patch text (*** Update File:, +++ b/...).
export function editPaths(args) {
  const found = [];
  for (const key of PATH_KEYS) if (typeof args[key] === 'string' && args[key].trim()) found.push(args[key].trim());
  for (const key of ['edits', 'files', 'changes']) {
    if (Array.isArray(args[key])) for (const item of args[key]) if (item && typeof item === 'object') found.push(...editPaths(item));
  }
  const patch = ['input', 'patch', 'diff'].map((k) => args[k]).find((v) => typeof v === 'string') ?? '';
  for (const line of patch.split(/\r?\n/)) {
    const m = line.match(/^\*\*\* (?:Add|Update|Delete) File:\s*(.+?)\s*$/) || line.match(/^\*\*\* Move to:\s*(.+?)\s*$/) || line.match(/^(?:\+\+\+|---) (?:[ab]\/)?(.+?)\s*$/);
    if (m && m[1] !== '/dev/null') found.push(m[1]);
  }
  return [...new Set(found)];
}

const fold = (s) => (FOLD ? s.toLowerCase() : s);
const relTo = (root, file) => path.relative(root, file).split(path.sep).join('/');
const under = (rel, dir) => dir === '' || dir === '.' || fold(rel) === fold(dir) || fold(rel).startsWith(`${fold(dir)}/`);
const inside = (rel) => rel !== '' && !rel.startsWith('../') && rel !== '..' && !path.isAbsolute(rel);
const rootValue = (root, label) => cleanValue(configValue(root, label, '') ?? '').replace(/\\/g, '/').replace(/^\.\/+/, '').replace(/\/+$/, '') || '.';

// Why an agent may not write this path, or null.
export function protectedPath(root, file, { subagent = false, pluginRoot = KIT_ROOT } = {}) {
  for (const kit of new Set([pluginRoot, KIT_ROOT].filter(Boolean))) {
    const k = relTo(path.resolve(kit), file);
    if (k === '' || inside(k)) return 'it is part of the spec-relay kit, which agents never change';
  }
  const rel = relTo(root, file);
  if (!inside(rel)) return null;
  const source = rootValue(root, 'Source root');
  const target = rootValue(root, 'Target root');
  if (fold(rel) === 'openspec/config.yaml') return 'openspec/config.yaml holds the person\'s settings; ask the person to edit it themselves';
  for (const [dir, why] of [
    ['openspec/specs', 'baseline specs change only when a reviewed change is archived'],
    ['openspec/changes/archive', 'archived changes are the record of what was reviewed'],
    ['openspec/schemas', 'the kit\'s schemas are installed by setup.mjs'],
  ]) if (under(rel, dir)) return why;
  if (subagent && (/^openspec\/changes\/[^/]+\/(review|questions)\.md$/i.test(rel) || fold(rel) === 'openspec/spec-relay/plan.md')) {
    return 'only the orchestrator writes review.md, questions.md and the plan';
  }
  if (source === '.') {
    if (!under(rel, 'openspec') && !(target !== '.' && under(rel, target))) return 'with the source root ".", agents change only openspec/ and the target root';
  } else if (under(rel, source) && !(target !== '.' && under(rel, target))) return `it is under the source root ${source}, which is read-only`;
  return null;
}

// `openspec archive <change> ...` calls in a shell command line.
export function archiveCalls(command) {
  const calls = [];
  for (const m of command.matchAll(/(?:^|[\s;&|(`'"/\\])openspec(?:\.cmd|\.exe|\.js|\.mjs)?["']?\s+archive\b([^;&|\r\n]*)/gi)) {
    const tokens = m[1].trim().split(/\s+/).filter(Boolean).map((t) => t.replace(/^["']|["']$/g, ''));
    calls.push({ name: tokens.find((t) => !t.startsWith('-')) ?? null, flags: tokens.filter((t) => t.startsWith('-')).map((t) => t.toLowerCase()) });
  }
  return calls;
}

function archiveDenial(root, { name, flags }, subagent) {
  if (subagent) return 'only the orchestrator archives a change, after the person agrees in the chat';
  if (!name) return 'name the change: openspec archive <change> --yes, after its gate passes and the person agrees';
  const dir = path.join(root, 'openspec/changes', name);
  if (!/^[\w.-]+$/.test(name) || !fs.existsSync(dir)) return null;
  const schema = changeSchema(dir);
  if (!REVIEWED.has(schema) && schema !== 'spec-relay-port') return null;
  if ((schema === 'spec-relay-extract' || schema === 'spec-relay-amend') && flags.some((f) => f === '--skip-specs' || f === '--no-validate')) {
    return `${name} must be archived with its specs and validation: drop --skip-specs and --no-validate`;
  }
  const port = schema === 'spec-relay-port';
  const result = port ? checkPortDone(root, name) : checkReview(root, name);
  if (result.ok) return null;
  const next = nextSteps(port ? 'port-done' : 'review', result, language(root));
  const shown = result.problems.slice(0, 5).join('; ') + (result.problems.length > 5 ? `; and ${result.problems.length - 5} more` : '');
  const ask = next.person.length ? ` Tell the person: ${next.person.join(' ')}` : '';
  return `gate.mjs ${port ? 'port-done' : 'review'} fails for ${name}, so it cannot be archived yet: ${shown}.${ask} Fix what is yours, run the gate again, and archive only when it passes and the person agrees.`;
}

// Why the call is denied, or null. `payload` is the hook input (camelCase, or the
// VS Code compatible snake_case form).
export function decide(payload, { pluginRoot = process.env.PLUGIN_ROOT || process.env.COPILOT_PLUGIN_ROOT || KIT_ROOT } = {}) {
  const cwd = payload.cwd ?? process.cwd();
  const root = findRoot(cwd);
  if (!root || !enforced(root)) return null;
  const tool = String(payload.toolName ?? payload.tool_name ?? '').toLowerCase();
  const args = parsedArgs(payload.toolArgs ?? payload.tool_input);
  const subagent = Boolean(payload.agentId ?? payload.agent_id ?? payload.agentType ?? payload.agent_type);
  if (SHELL_TOOLS.has(tool) || (!EDIT_TOOLS.has(tool) && typeof args.command === 'string')) {
    const command = String(args.command ?? args.cmd ?? args.input ?? '');
    if (/hook\s+enforcement/i.test(command)) return 'the "Hook enforcement" setting is the person\'s; ask them to change openspec/config.yaml themselves';
    for (const call of archiveCalls(command)) {
      const why = archiveDenial(root, call, subagent);
      if (why) return why;
    }
    return null;
  }
  if (!EDIT_TOOLS.has(tool)) return null;
  for (const p of editPaths(args)) {
    const file = path.resolve(cwd, p);
    const why = protectedPath(root, file, { subagent, pluginRoot });
    if (why) return `spec-relay does not let agents write ${relTo(root, file) || p}: ${why}.`;
  }
  return null;
}

export function main(input, options) {
  let payload;
  try { payload = JSON.parse(input || '{}'); } catch { return ''; }
  const why = decide(payload, options);
  return why ? JSON.stringify({ permissionDecision: 'deny', permissionDecisionReason: `spec-relay: ${why}` }) : '';
}

function invokedDirectly() {
  if (!process.argv[1]) return false;
  try { return fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url)); } catch { return false; }
}

if (invokedDirectly()) {
  try {
    const out = main(fs.readFileSync(0, 'utf8'));
    if (out) process.stdout.write(`${out}\n`);
  } catch (error) {
    process.stderr.write(`spec-relay hook: ${error.message}; the tool call goes through the normal permission flow\n`);
  }
  process.exitCode = 0;
}
