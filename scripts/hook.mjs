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
//   - subagent edits of review.md, questions.md, the plan and the lessons;
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
import { checkReview, checkPortDone, changeSchema, configValue, cleanValue, nextSteps, language, readIf, PLAN, LESSONS } from './gate.mjs';

const KIT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// Tool names of the Copilot runtime (CLI hooks reference; VS Code's Copilot
// harness and the Copilot app run the same runtime). hooks.json's matcher is
// built from the same two lists (a test keeps them equal).
export const SHELL_TOOLS = ['bash', 'powershell', 'write_bash', 'write_powershell'];
export const EDIT_TOOLS = ['edit', 'create', 'str_replace_editor', 'apply_patch'];
const PATH_KEYS = ['path', 'file_path', 'filePath', 'new_path', 'newPath', 'old_path', 'oldPath'];
const FOLD = process.platform === 'win32' || process.platform === 'darwin';
const REVIEWED = new Set(['spec-relay-survey', 'spec-relay-target', 'spec-relay-extract', 'spec-relay-amend']);
// A shell command that may write a file (PowerShell and POSIX forms).
const WRITES = /(?:^|[\s;&|(])(?:set-content|add-content|out-file|clear-content|new-item|ni|copy-item|cp|copy|move-item|mv|move|rename-item|ren|remove-item|rm|del|erase|sed|perl|tee|truncate|dd)\b|-replace\b|\[io\.file\]|>/i;

// The repository root above `start` that spec-relay set up, or null.
export function findRoot(start) {
  let dir = path.resolve(start || '.');
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
// of a patch: `*** Add/Update/Delete File:` and `*** Move to:` in the apply_patch
// format, or `--- a/x` directly followed by `+++ b/x` in a unified diff.
export function editPaths(args) {
  const found = [];
  for (const key of PATH_KEYS) if (typeof args[key] === 'string' && args[key].trim()) found.push(args[key].trim());
  const patch = ['input', 'patch', 'diff'].map((k) => args[k]).find((v) => typeof v === 'string') ?? '';
  const lines = patch.split(/\r?\n/);
  const applyPatch = lines.some((line) => /^\*\*\* (?:Begin Patch|(?:Add|Update|Delete) File:)/.test(line));
  lines.forEach((line, i) => {
    let m;
    if (applyPatch) m = line.match(/^\*\*\* (?:Add|Update|Delete) File:\s*(.+?)\s*$/) || line.match(/^\*\*\* Move to:\s*(.+?)\s*$/);
    else if (/^--- /.test(line) && /^\+\+\+ /.test(lines[i + 1] ?? '')) {
      for (const header of [line, lines[i + 1]]) {
        const h = header.match(/^(?:---|\+\+\+) (?:[ab]\/)?(.+?)(?:\t.*)?\s*$/);
        if (h && h[1] !== '/dev/null') found.push(h[1]);
      }
    }
    if (m) found.push(m[1]);
  });
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
  if (subagent && (/^openspec\/changes\/[^/]+\/(review|questions)\.md$/i.test(rel) || [PLAN, LESSONS].includes(fold(rel)))) {
    return 'only the orchestrator writes review.md, questions.md, the plan and the lessons';
  }
  if (source === '.') {
    if (!under(rel, 'openspec') && !(target !== '.' && under(rel, target))) return 'with the source root ".", agents change only openspec/ and the target root';
  } else if (under(rel, source) && !(target !== '.' && under(rel, target))) return `it is under the source root ${source}, which is read-only`;
  return null;
}

// Whether position `at` of `text` is inside a quoted string, and the text before
// that quote opened.
function quoted(text, at) {
  let quote = null; let opened = 0;
  for (let i = 0; i < at; i++) {
    const c = text[i];
    if (quote) { if (c === quote && text[i - 1] !== '`' && text[i - 1] !== '\\') quote = null; }
    else if (c === '"' || c === "'") { quote = c; opened = i; }
  }
  return quote ? text.slice(0, opened) : null;
}

// `openspec archive <change> ...` calls in a shell command line. A mention inside
// a quoted argument (a commit message, a search pattern) is not a call, unless the
// quote is a command for another shell (-c, -Command, /c, Invoke-Expression).
// `name` is null when the call names no change, and `literal` false when the name
// is not a plain change name (a variable, a subexpression).
export function archiveCalls(command) {
  const calls = [];
  const re = /(?:^|[\s;&|(`'"/\\@])openspec(?:@[\w.-]+)?(?:\.cmd|\.exe|\.ps1|\.js|\.mjs)?(?<close>["'])?(?<opts>(?:\s+-[\w-]+(?:[=\s]+(?!archive\b)[^\s;&|-][^\s;&|]*)?)*)\s+archive\b(?<rest>[^;&|\r\n]*)/gi;
  for (const m of command.matchAll(re)) {
    const before = quoted(command, m.index + m[0].indexOf('openspec'));
    // A quoted program path ("C:/kit/openspec.mjs" archive) closes right after the name.
    const program = before !== null && m.groups.close === command[before.length];
    if (before !== null && !program && !/(?:^|\s)(?:-c|-command|\/c|invoke-expression|iex)\s*$/i.test(before)) continue;
    const tokens = m.groups.rest.trim().split(/\s+/).filter(Boolean).map((t) => t.replace(/^["']+|["')]+$/g, ''));
    const flags = [];
    let name = null;
    for (let i = 0; i < tokens.length; i++) {
      const t = tokens[i];
      if (t.startsWith('-')) { flags.push(t.toLowerCase()); if (/^--store$/i.test(t)) i++; continue; }
      if (name === null && t) name = t;
    }
    calls.push({ name, literal: name === null || /^[\w.-]+$/.test(name), flags });
  }
  return calls;
}

function archiveDenial(root, { name, literal, flags }, subagent) {
  if (flags.some((f) => f === '--help' || f === '-h')) return null;
  if (subagent) return 'only the orchestrator archives a change, after the person agrees in the chat';
  if (!name) return 'name the change: openspec archive <change> --yes, after its gate passes and the person agrees';
  if (!literal) return `write the change name itself in the command (not ${name}), so the kit can check its gate`;
  const dir = path.join(root, 'openspec/changes', name);
  if (!fs.existsSync(dir)) return null;
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

// The folders a shell command runs in: its cwd, and every `cd`/`Set-Location`
// target in it, so `cd repo; openspec archive x` is checked in repo.
function shellDirs(cwd, command) {
  const dirs = [cwd];
  for (const m of command.matchAll(/(?:^|[;&|(]\s*)(?:cd|chdir|set-location|sl|push-location|pushd)\s+(?:-(?:literal)?path\s+)?("[^"]+"|'[^']+'|[^\s;&|)]+)/gi)) {
    dirs.push(path.resolve(cwd, m[1].replace(/^["']|["']$/g, '')));
  }
  return dirs;
}

// The orchestrator may itself run as a subagent of the default agent; it keeps
// its rights. Every other subagent (the kit's analyst, checker and implementer,
// or any other) does not.
const isSubagent = (payload) => {
  const type = String(payload.agentType ?? payload.agent_type ?? payload.agentName ?? payload.agent_name ?? '');
  if (/spec-relay-orchestrator$/i.test(type)) return false;
  return Boolean(payload.agentId ?? payload.agent_id ?? type);
};

// Why the call is denied, or null. `payload` is the hook input (camelCase, or the
// VS Code compatible snake_case form).
export function decide(payload, { pluginRoot = process.env.PLUGIN_ROOT || process.env.COPILOT_PLUGIN_ROOT || KIT_ROOT } = {}) {
  const cwd = path.resolve(payload.cwd ?? process.cwd());
  const tool = String(payload.toolName ?? payload.tool_name ?? '').toLowerCase();
  const args = parsedArgs(payload.toolArgs ?? payload.tool_input);
  const subagent = isSubagent(payload);
  if (SHELL_TOOLS.includes(tool)) {
    const command = String(args.command ?? args.input ?? '');
    for (const dir of shellDirs(cwd, command)) {
      const root = findRoot(dir);
      if (!root || !enforced(root)) continue;
      if (WRITES.test(command) && (/hook\s+enforcement/i.test(command) || /openspec[\\/]config\.yaml/i.test(command))) {
        return 'openspec/config.yaml holds the person\'s settings, the Hook enforcement line included; ask the person to change it themselves';
      }
      for (const call of archiveCalls(command)) {
        const why = archiveDenial(root, call, subagent);
        if (why) return why;
      }
    }
    return null;
  }
  if (!EDIT_TOOLS.includes(tool)) return null;
  if (tool === 'str_replace_editor' && /^view$/i.test(String(args.command ?? ''))) return null;
  for (const p of editPaths(args)) {
    const file = path.resolve(cwd, p);
    const root = findRoot(path.dirname(file)) ?? findRoot(cwd);
    if (!root || !enforced(root)) continue;
    const why = protectedPath(root, file, { subagent, pluginRoot });
    if (why) return `spec-relay does not let agents write ${relTo(root, file) || p}: ${why}.`;
  }
  return null;
}

// JSON with every non-ASCII character escaped, so a console code page (CP932 in
// Japanese Windows PowerShell) cannot garble the decision into unreadable output.
const ascii = (value) => JSON.stringify(value).replace(/[\u0080-￿]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`);

export function main(input, options) {
  let payload;
  try { payload = JSON.parse(String(input || '{}').replace(/^﻿/, '')); } catch { return ''; }
  if (!payload || typeof payload !== 'object') return '';
  const why = decide(payload, options);
  return why ? ascii({ permissionDecision: 'deny', permissionDecisionReason: `spec-relay: ${why}` }) : '';
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
