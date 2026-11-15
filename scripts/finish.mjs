#!/usr/bin/env node
// Step 6 of spec-relay: after every capability is ported, check the whole new
// system once, list what is left, and hand it over (schema spec-relay-finish).
//
//   node finish.mjs ready [--root DIR] [--lang ja|en]
//        before creating the finish change: every planned capability is ported
//        against its current baseline, and no other change is open
//   node finish.mjs collect [--root DIR]
//        what the finish change must account for, as ASCII-only JSON: the
//        TODO(port) markers under the target root, the plan's follow-up items,
//        the risks of the archived ports, the verification levels each context
//        chose, the context relationships, the commands, and the target hash
//   node finish.mjs draft --change NAME [--root DIR]
//        writes checks.md and leftovers.md of the finish change from `collect`
//        (only the ones that do not exist yet), so no model retypes the lists
//   node finish.mjs hash [--root DIR]
//        the fingerprint of the target root that checks.md records
//
// `gate.mjs review --change finish` runs checkFinish below. Prints JSON and exits
// 0 when ok, 1 when not, 2 on bad usage, like gate.mjs. Read-only except `draft`.
import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  readIf, tableRows, plain, norm, contextIds, planCapabilities, archivedChange, baseName,
  baselineHash, capabilitySegments, configValue, cleanValue, language, PLAN,
} from './gate.mjs';

export const FINISH = 'finish';
export const KINDS = ['todo', 'follow-up', 'risk', 'verification', 'flow'];
export const CLASSES = ['before-release', 'after-release', 'wont-fix'];
export const LEVELS = ['A', 'B1', 'B2', 'C'];
export const MARKER = /TODO\(port\)/;
// Folders that hold build output or local tools, never ported code. Used only
// outside git; in a git repository the ignore rules decide.
const BUILD_DIRS = new Set(['node_modules', 'bin', 'obj', 'target', 'build', 'dist', 'out', '__pycache__', '.venv', 'venv',
  '.gradle', '.idea', '.vs', '.vscode', 'coverage', '.pytest_cache', '.mypy_cache', '.tox', '.next', '.turbo']);
const MAX_SCAN = 2 * 1024 * 1024;

const stripComments = (text) => text.replace(/<!--[\s\S]*?-->/g, '');
const relPath = (p) => p.replace(/\\/g, '/').replace(/^\.\//, '').replace(/^\/+/, '').replace(/\/+$/, '');
const rootValue = (root, label) => relPath(cleanValue(configValue(root, label, '') ?? '')) || '.';
const dirs = (dir) => { try { return fs.readdirSync(dir, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name); } catch { return []; } };

// The lines of the `## <heading>` section (up to the next `##`), outside code fences.
export function section(text, heading) {
  const out = [];
  let inside = false;
  let fenced = false;
  for (const line of stripComments(text ?? '').split(/\r?\n/)) {
    if (/^\s*(```|~~~)/.test(line)) { fenced = !fenced; continue; }
    if (fenced) continue;
    const h2 = line.match(/^##\s+(.*?)\s*#*\s*$/);
    if (h2) { inside = heading.test(h2[1].trim()); continue; }
    if (inside) out.push(line);
  }
  return out.join('\n');
}

const listItems = (text) => text.split(/\r?\n/)
  .map((line) => line.match(/^ ?(?:[-*+]|\d+[.)])\s+(?:\[.?\]\s+)?(.*)$/)?.[1]?.trim())
  .filter((item) => item && !/^(none\.?|なし。?|-|…|\.\.\.)$/i.test(plain(item)));

// ---------------------------------------------------------------- the target root

// The files of the target root: in a git repository the ones git tracks or would
// track (build output is ignored there), otherwise every file outside the usual
// build folders. With the target root ".", openspec/, the source root and the
// tool folders are left out.
export function targetFiles(root) {
  const target = rootValue(root, 'Target root');
  const source = rootValue(root, 'Source root');
  const base = path.resolve(root);
  const dir = path.resolve(base, target);
  const rel = path.relative(base, dir);
  if (rel.startsWith('..') || path.isAbsolute(rel)) return null;
  try { if (!fs.statSync(dir).isDirectory()) return null; } catch { return null; }
  const prefix = rel ? `${rel.split(path.sep).join('/')}/` : '';
  const skip = (file) => /^(\.git|openspec|\.agents|\.github)(\/|$)/.test(file)
    || (!prefix && source !== '.' && (file === source || file.startsWith(`${source}/`)));
  const git = spawnSync('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard', '--', prefix || '.'], { cwd: base, encoding: 'buffer', windowsHide: true, maxBuffer: Infinity });
  if (git.status === 0 && git.stdout) {
    const top = spawnSync('git', ['rev-parse', '--show-cdup'], { cwd: base, encoding: 'utf8', windowsHide: true });
    if (top.status === 0 && top.stdout.trim() === '') {
      const listed = git.stdout.toString('utf8').split('\0').filter(Boolean);
      return [...new Set(listed.filter((f) => !skip(f) && fs.existsSync(path.join(base, f))))].sort();
    }
  }
  const out = [];
  const visit = (dirRel) => {
    let entries = [];
    try { entries = fs.readdirSync(path.join(base, dirRel), { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const child = dirRel ? `${dirRel}/${e.name}` : e.name;
      if (skip(child)) continue;
      if (e.isDirectory()) { if (!BUILD_DIRS.has(e.name)) visit(child); } else if (e.isFile()) out.push(child);
    }
  };
  visit(prefix.replace(/\/$/, ''));
  return out.sort();
}

// sha256 over every target file's path and content, with CRLF read as LF so a
// Windows checkout gives the same hash.
export function targetHash(root, files = targetFiles(root)) {
  if (files === null) return null;
  const lines = files.map((f) => {
    let data;
    try { data = fs.readFileSync(path.join(root, f)); } catch { return `${f}\0?`; }
    const text = data.includes(0) ? data : Buffer.from(data.toString('latin1').replace(/\r\n/g, '\n'), 'latin1');
    return `${f}\0${crypto.createHash('sha256').update(text).digest('hex')}`;
  });
  return crypto.createHash('sha256').update(lines.join('\n')).digest('hex');
}

// Every `TODO(port)` under the target root: { file, line, text }.
export function portMarkers(root, files = targetFiles(root)) {
  const found = [];
  for (const file of files ?? []) {
    let data;
    try { const stat = fs.statSync(path.join(root, file)); if (stat.size > MAX_SCAN) continue; data = fs.readFileSync(path.join(root, file)); } catch { continue; }
    if (data.includes(0)) continue;
    data.toString('utf8').split(/\r?\n/).forEach((line, i) => {
      if (MARKER.test(line)) found.push({ file, line: i + 1, text: line.trim().slice(0, 200) });
    });
  }
  return found;
}

// ---------------------------------------------------------------- the plan and the archive

const FOLLOW_UP = /^(?:\d+[.)]?\s*)?(?:follow[- ]?ups?\b|後回し|フォローアップ|移行後)/i;

// The top-level items of the plan's "## Follow-up" section, as written.
export function planFollowUps(text) {
  return listItems(section(text, FOLLOW_UP).split(/\r?\n/).filter((line) => /^ ?\S/.test(line)).join('\n'));
}

// The newest archived port of each capability (port-<key> or port-<key>-v<n>).
function archivedPorts(root) {
  const names = new Set(dirs(path.join(root, 'openspec/changes/archive'))
    .map((entry) => entry.match(/^\d{4}-\d{2}-\d{2}-(port-.+)$/)?.[1]).filter(Boolean).map(baseName));
  return [...names].sort().map((name) => ({ name, dir: archivedChange(root, name) })).filter((p) => p.dir);
}

// Whether the newest archived port of `capability` recorded the current baseline hash.
function portIsCurrent(root, capability) {
  const key = capabilitySegments(capability).join('-');
  const dir = archivedChange(root, `port-${key}`);
  if (!dir) return { ported: false };
  const proposal = stripComments(readIf(path.join(dir, 'proposal.md'), []) ?? '');
  const recorded = [...proposal.matchAll(/`([^`]+)`\s*sha256:\s*([0-9a-f]{64})/gi)].find(([, cap]) => capabilitySegments(cap).join('-') === key);
  const now = baselineHash(root, capability);
  return { ported: true, stale: Boolean(recorded && now && recorded[2].toLowerCase() !== now) };
}

// The verification levels verification.md chose per context: { context, chosen: ['A', 'B1'] }.
export function chosenLevels(text) {
  const yes = /^(yes|y|true|on|required|x|✓|✔|○|◯|必須|あり|はい|する|使う)/i;
  return tableRows(section(text, /^levels\b|^レベル|^方式/i)).filter(([context = '']) => plain(context))
    .map(([context, ...cells]) => ({
      context: plain(context).toLowerCase(),
      chosen: LEVELS.filter((level, i) => level === 'A' || yes.test(plain(cells[i] ?? ''))),
    }));
}

export function collect(root) {
  const problems = [];
  const files = targetFiles(root);
  if (files === null) problems.push(`the target root "${configValue(root, 'Target root', '')}" in openspec/config.yaml is not a folder inside the repository`);
  const survey = archivedChange(root, 'survey');
  const design = archivedChange(root, 'target-design');
  if (!survey) problems.push('no archived survey change');
  if (!design) problems.push('no archived target-design change');
  const map = survey ? readIf(path.join(survey, 'context-map.md'), problems) ?? '' : '';
  const relations = tableRows(section(map, /^relationships?\b|^関係/i))
    .map(([upstream = '', downstream = '', pattern = '', channel = '']) => ({ upstream: plain(upstream), downstream: plain(downstream), pattern: plain(pattern), channel: plain(channel) }))
    .filter((r) => r.upstream && r.downstream);
  const conventions = design ? readIf(path.join(design, 'conventions.md'), problems) ?? '' : '';
  const commands = tableRows(section(conventions, /^commands?\b|^コマンド/i))
    .map(([purpose = '', command = '']) => ({ purpose: plain(purpose), command: command.trim().replace(/^`(.*)`$/, '$1') }))
    .filter((c) => c.purpose && c.command);
  const verification = design ? readIf(path.join(design, 'verification.md'), problems) ?? '' : '';
  const risks = [];
  const plan = readIf(path.join(root, PLAN), problems) ?? '';
  const byKey = new Map(planCapabilities(plan).map((c) => [capabilitySegments(c).join('-'), c]));
  for (const port of archivedPorts(root)) {
    const key = port.name.replace(/^port-/, '');
    const capability = byKey.get(key) ?? key;
    const text = readIf(path.join(port.dir, 'design.md'), problems) ?? '';
    for (const item of listItems(section(text, /^risks?\b|^リスク/i))) risks.push({ port: port.name, capability, text: item });
  }
  return {
    ok: problems.length === 0,
    target: { root: rootValue(root, 'Target root'), files: files?.length ?? 0, sha256: files ? targetHash(root, files) : null },
    markers: files ? portMarkers(root, files) : [],
    followUps: planFollowUps(plan),
    risks,
    contexts: contextIds(map),
    levels: chosenLevels(verification),
    relations,
    commands,
    problems,
  };
}

// ---------------------------------------------------------------- ready

export function checkFinishReady(root, { self } = {}) {
  const problems = [];
  if (!archivedChange(root, 'survey')) problems.push('no archived survey change: the migration has not started');
  if (!archivedChange(root, 'target-design')) problems.push('no archived target-design change: decide the target design first');
  const planned = planCapabilities(readIf(path.join(root, PLAN), problems));
  if (planned.length === 0) problems.push(`${PLAN} has no capability list ("## Capabilities")`);
  for (const capability of planned) {
    const parts = capabilitySegments(capability);
    if (!readIf(path.join(root, 'openspec/specs', ...parts, 'spec.md'), [])) { problems.push(`capability ${capability} has no baseline spec yet: analyze, review and port it first`); continue; }
    const port = portIsCurrent(root, capability);
    if (!port.ported) problems.push(`capability ${capability} is not ported yet (no archived port-${parts.join('-')})`);
    else if (port.stale) problems.push(`capability ${capability} was amended after its port; port it again (port-${parts.join('-')}-v<n>)`);
  }
  const listed = new Set(planned.map((c) => capabilitySegments(c).join('/')));
  const specs = [];
  const walkSpecs = (dir, prefix) => {
    for (const name of dirs(dir)) {
      const parts = [...prefix, name];
      if (fs.existsSync(path.join(dir, name, 'spec.md'))) specs.push(parts.join('/'));
      walkSpecs(path.join(dir, name), parts);
    }
  };
  walkSpecs(path.join(root, 'openspec/specs'), []);
  for (const cap of specs.filter((c) => !listed.has(c))) problems.push(`baseline spec ${cap} is not in the plan's capability list; add it to the plan (and port it) or tell the person`);
  for (const name of dirs(path.join(root, 'openspec/changes')).filter((n) => n !== 'archive' && n !== self)) {
    if (baseName(name) !== FINISH) problems.push(`change ${name} is still active; finish or archive it first`);
  }
  return { ok: problems.length === 0, problems };
}

// ---------------------------------------------------------------- the review gate

const cell = (s) => norm(stripComments(s ?? '')).replace(/[.。]$/, '');
const whereFile = (where) => relPath(plain(where).replace(/:\d+(?:-\d+)?$/, ''));

export function leftoverRows(text) {
  return tableRows(text).map(([id = '', kind = '', where = '', what = '', klass = '', reason = '']) => ({
    id: plain(id).toUpperCase(), kind: cell(kind), where: plain(stripComments(where)), what: plain(stripComments(what)), klass: cell(klass), reason: plain(stripComments(reason)),
  })).filter((r) => r.id || r.kind || r.what);
}

// Called by gate.mjs review for a change of schema spec-relay-finish.
export function checkFinish(root, change, dir, boxes, problems) {
  problems.push(...checkFinishReady(root, { self: change }).problems);
  const facts = collect(root);
  for (const p of facts.problems) if (!problems.includes(p)) problems.push(p);

  // checks.md
  const checks = readIf(path.join(dir, 'checks.md'), problems);
  if (checks === null) problems.push('checks.md is missing');
  const recorded = stripComments(checks ?? '').match(/^Target:\s*sha256:\s*([0-9a-f]{64})\b/mi)?.[1];
  if (checks !== null && !recorded) problems.push('checks.md records no target hash ("Target: sha256:<hash>"; get it with finish.mjs hash after the checks)');
  else if (recorded && facts.target.sha256 && recorded.toLowerCase() !== facts.target.sha256) {
    problems.push('the target code changed after the checks were recorded; run every check again and record the new hash (finish.mjs hash)');
  }
  const commandRows = tableRows(section(checks, /^commands?\b|^コマンド/i)).map(([purpose = '', command = '', result = '']) => ({ purpose: plain(purpose), command: plain(command), result: cell(result) })).filter((r) => r.purpose || r.command);
  if (checks !== null && commandRows.length === 0) problems.push('checks.md lists no command under ## Commands (the build and test commands of conventions.md)');
  for (const c of facts.commands) if (!commandRows.some((r) => norm(r.purpose) === norm(c.purpose))) problems.push(`checks.md has no row for the ${c.purpose} command of conventions.md`);
  for (const r of commandRows) {
    if (!r.result) problems.push(`checks.md records no result for the ${r.purpose} command`);
    else if (!/^(pass|passed|ok)\b/.test(r.result)) problems.push(`the ${r.purpose} command did not pass ("${r.result}"); fix it through a port change and run the checks again`);
  }
  const levelRows = new Map(tableRows(section(checks, /^verification\b|^検証|^比べ方/i)).map(([context = '', ...cells]) => [plain(context).toLowerCase(), cells.map(cell)]));
  const leftovers = readIf(path.join(dir, 'leftovers.md'), problems);
  if (leftovers === null) problems.push('leftovers.md is missing');
  const rows = leftoverRows(leftovers ?? '');
  const hasRow = (kind, test) => rows.some((r) => r.kind === kind && test(norm(r.where)));
  const chosen = new Map(facts.levels.map((l) => [l.context, l.chosen]));
  for (const context of facts.contexts) {
    const cells = levelRows.get(context);
    if (!cells) { problems.push(`checks.md has no verification row for context ${context}`); continue; }
    LEVELS.forEach((level, i) => {
      const value = cells[i] ?? '';
      const wanted = (chosen.get(context) ?? ['A']).includes(level);
      if (!value || value === '-' || value === '–') {
        if (wanted) problems.push(`context ${context} chose level ${level} in verification.md; record pass, fail or not-run: <reason> in checks.md`);
      } else if (/^fail/.test(value)) problems.push(`level ${level} of context ${context} failed; fix it through a port change and run the checks again`);
      else if (/^not[- ]?run/.test(value)) {
        if (!hasRow('verification', (w) => new RegExp(`(^|\\W)${context}(?![\\w-])`).test(w) && new RegExp(`(^|\\W)${level.toLowerCase()}(?!\\w)`).test(w))) {
          problems.push(`level ${level} of context ${context} did not run; add a verification row "${context} ${level}" to leftovers.md`);
        }
      } else if (!/^(pass|passed|ok)\b/.test(value)) problems.push(`level ${level} of context ${context} is "${value}"; write pass, fail or not-run: <reason>`);
    });
  }
  const flowRows = tableRows(section(checks, /^cross[- ]context\b|^コンテキストをまたぐ|^またぐ/i)).map(([flow = '', covered = '']) => ({ flow: norm(flow), covered: cell(covered) }));
  for (const r of facts.relations) {
    const key = norm(`${r.upstream} -> ${r.downstream}`);
    const row = flowRows.find((f) => f.flow.replace(/\s+/g, '') === key.replace(/\s+/g, ''));
    if (!row || !row.covered) problems.push(`checks.md names no test for the flow ${r.upstream} -> ${r.downstream} (write the test, or none)`);
    else if (/^(none|なし)$/.test(row.covered) && !hasRow('flow', (w) => w.replace(/\s+/g, '') === key.replace(/\s+/g, ''))) {
      problems.push(`the flow ${r.upstream} -> ${r.downstream} has no test; add a flow row "${r.upstream} -> ${r.downstream}" to leftovers.md`);
    }
  }

  // leftovers.md
  const ids = new Set();
  for (const r of rows) {
    const label = r.id || r.what || '(row without id)';
    if (!/^L\d+$/.test(r.id)) problems.push(`leftovers.md row "${label}" has no id L<n>`);
    else if (ids.has(r.id)) problems.push(`leftovers.md has two rows ${r.id}`);
    ids.add(r.id);
    if (!KINDS.includes(r.kind)) problems.push(`leftovers.md ${label}: kind "${r.kind}" is not one of ${KINDS.join(', ')}`);
    if (!CLASSES.includes(r.klass)) problems.push(`leftovers.md ${label}: class "${r.klass || 'blank'}" is not one of ${CLASSES.join(', ')}`);
    if (!r.reason) problems.push(`leftovers.md ${label} gives no reason`);
    if (!r.what) problems.push(`leftovers.md ${label} says nothing under What`);
  }
  // Every TODO(port) is listed, file by file, and no row lists one that is gone.
  const byFile = new Map();
  for (const m of facts.markers) byFile.set(m.file, (byFile.get(m.file) ?? 0) + 1);
  const listedByFile = new Map();
  for (const r of rows.filter((x) => x.kind === 'todo')) listedByFile.set(whereFile(r.where), (listedByFile.get(whereFile(r.where)) ?? 0) + 1);
  for (const [file, n] of byFile) {
    const listed = listedByFile.get(file) ?? 0;
    if (listed < n) problems.push(`${file} has ${n} TODO(port), and leftovers.md lists ${listed}; run finish.mjs collect and add the missing ones`);
  }
  for (const [file, listed] of listedByFile) {
    if (listed > (byFile.get(file) ?? 0)) problems.push(`leftovers.md lists ${listed} TODO(port) in ${file || '(no file)'}, and the code has ${byFile.get(file) ?? 0}; drop the rows that were fixed`);
  }
  for (const item of facts.followUps) {
    if (!rows.some((r) => r.kind === 'follow-up' && norm(r.what) === norm(item))) problems.push(`the plan's follow-up item is not in leftovers.md: "${plain(item)}"`);
  }
  // One review item per leftover, with the same id.
  for (const id of ids) {
    const count = boxes.filter((b) => new RegExp(`^${id}(?!\\d)`, 'i').test(b.plain)).length;
    if (count !== 1) problems.push(`leftover ${id} has ${count === 0 ? 'no' : 'more than one'} review item (${id} <what> - class: <class>)`);
  }
  for (const box of boxes) {
    const id = box.plain.match(/^(L\d+)\b/i)?.[1]?.toUpperCase();
    if (id && !ids.has(id)) problems.push(`review item ${id} has no row in leftovers.md`);
  }

  // handover.md
  const handover = readIf(path.join(dir, 'handover.md'), problems);
  if (handover === null) problems.push('handover.md is missing');
  else if (!plain(section(handover, /^verdict\b|^結論/i))) problems.push('handover.md has no verdict (## Verdict)');
}

// ---------------------------------------------------------------- status

// The finish step for status.mjs: { status, waiting?, detail? }, like the survey's.
export function finishState(root, { checkReview, artifactCount }) {
  const changes = path.join(root, 'openspec/changes');
  const active = dirs(changes).filter((n) => n !== 'archive' && baseName(n) === FINISH).sort().pop();
  if (active) {
    const dir = path.join(changes, active);
    const artifacts = artifactCount(dir);
    if (artifacts.done < artifacts.total) return { status: 'in-progress', detail: ['writing', artifacts.done, artifacts.total] };
    if (checkReview(root, active).ok) return { status: 'not-started', waiting: true, detail: ['waitingArchive'] };
    return { status: 'not-started', waiting: true, detail: ['finishReview'] };
  }
  const archived = archivedChange(root, FINISH);
  if (!archived) return { status: 'not-started' };
  const recorded = stripComments(readIf(path.join(archived, 'checks.md'), []) ?? '').match(/^Target:\s*sha256:\s*([0-9a-f]{64})\b/mi)?.[1];
  const now = targetHash(root);
  if (recorded && now && recorded.toLowerCase() !== now) return { status: 'not-started', detail: ['changedAfterFinish'] };
  return { status: 'completed' };
}

// ---------------------------------------------------------------- draft

function draftChecks(facts) {
  const lines = ['# Whole-system checks', '', `Target: sha256:${facts.target.sha256 ?? ''}`, '',
    `<!-- ${facts.target.files} files under ${facts.target.root}. Run finish.mjs hash after the last fix and replace the hash. -->`, '',
    '## Commands', '| Purpose | Command | Result | Notes |', '|---|---|---|---|'];
  for (const c of facts.commands) lines.push(`| ${c.purpose} | \`${c.command.replace(/\|/g, '\\|')}\` | <!-- pass / fail --> | |`);
  if (facts.commands.length === 0) lines.push('| <!-- purpose --> | <!-- command from conventions.md --> | <!-- pass / fail --> | |');
  lines.push('', '## Verification levels', '| Context | A | B1 | B2 | C | Notes |', '|---|---|---|---|---|---|');
  const chosen = new Map(facts.levels.map((l) => [l.context, l.chosen]));
  for (const context of facts.contexts) {
    const wanted = chosen.get(context) ?? ['A'];
    lines.push(`| ${context} | ${LEVELS.map((level) => (wanted.includes(level) ? '<!-- pass / fail / not-run: reason -->' : '-')).join(' | ')} | |`);
  }
  lines.push('', '## Cross-context flows', '| Upstream -> downstream | Covered by |', '|---|---|');
  for (const r of facts.relations) lines.push(`| ${r.upstream} -> ${r.downstream} | <!-- test (${r.channel || r.pattern || 'relation'}), or none --> |`);
  return `${lines.join('\n')}\n`;
}

function draftLeftovers(facts) {
  const lines = ['# Leftovers', '', '| ID | Kind | Where | What | Class | Reason |', '|---|---|---|---|---|---|'];
  let n = 0;
  const esc = (s) => s.replace(/\|/g, '\\|');
  const row = (kind, where, what) => lines.push(`| L${n += 1} | ${kind} | ${where} | ${esc(what)} | <!-- before-release / after-release / wont-fix --> | |`);
  for (const m of facts.markers) row('todo', `\`${m.file}:${m.line}\``, m.text);
  for (const item of facts.followUps) row('follow-up', item.match(/^`([^`]+)`/)?.[1] ?? 'plan', item);
  for (const r of facts.risks) row('risk', r.capability, r.text);
  lines.push('', '<!-- Add a verification row for each not-run level and a flow row for each flow without a test (checks.md). -->');
  return `${lines.join('\n')}\n`;
}

export function draft(root, change) {
  if (!change || baseName(change) !== FINISH) return { ok: false, problems: [`the finish change is named ${FINISH} (or ${FINISH}-v<n>), not ${change}`] };
  const dir = path.join(root, 'openspec/changes', change);
  if (!fs.existsSync(dir)) return { ok: false, problems: [`change not found: ${change}; create it first (openspec.mjs new change ${change} --schema spec-relay-finish)`] };
  const facts = collect(root);
  const written = [];
  const kept = [];
  for (const [file, text] of [['checks.md', draftChecks(facts)], ['leftovers.md', draftLeftovers(facts)]]) {
    const target = path.join(dir, file);
    if (fs.existsSync(target)) { kept.push(file); continue; }
    fs.writeFileSync(target, text);
    written.push(file);
  }
  return { ok: facts.problems.length === 0, written, kept, markers: facts.markers.length, followUps: facts.followUps.length, risks: facts.risks.length, problems: facts.problems };
}

// ---------------------------------------------------------------- CLI

const NEXT = {
  en: {
    ready: 'Every capability is ported. I will now check the whole system and list what is left; you review the hand-over at the end.',
    notReady: 'The finish step waits until every capability in the plan is ported and no other change is open.',
  },
  ja: {
    ready: 'すべての機能の移行が終わりました。これから全体を確認し、残りものを一覧にします。最後に引き渡しの報告をレビューしてください。',
    notReady: '仕上げは、計画のすべての機能の移行が終わり、ほかの change がなくなってから始めます。',
  },
};

const ascii = (json) => json.replace(/[\u007f-\uffff]/g, (ch) => `\\u${ch.charCodeAt(0).toString(16).padStart(4, '0')}`);

export function main(argv) {
  const [command, ...rest] = argv;
  const opts = { root: process.cwd() };
  for (let i = 0; i < rest.length; i += 2) {
    const key = { '--change': 'change', '--root': 'root', '--lang': 'lang' }[rest[i]];
    if (!key || rest[i + 1] === undefined) return usage();
    opts[key] = rest[i + 1];
  }
  if (!fs.existsSync(path.join(opts.root, 'openspec'))) {
    console.error(`finish: no openspec/ folder in ${path.resolve(opts.root)}. Run this from the repository root or pass --root DIR.`);
    return 2;
  }
  let result;
  if (command === 'ready') {
    result = checkFinishReady(opts.root);
    const words = NEXT[language(opts.root, opts.lang)] ?? NEXT.en;
    result.next = { person: [result.ok ? words.ready : words.notReady], agent: result.problems };
  } else if (command === 'collect') result = collect(opts.root);
  else if (command === 'draft' && opts.change) result = draft(opts.root, opts.change);
  else if (command === 'hash') {
    const files = targetFiles(opts.root);
    result = files ? { ok: true, target: rootValue(opts.root, 'Target root'), files: files.length, sha256: targetHash(opts.root, files) } : { ok: false, problems: ['the target root in openspec/config.yaml is not a folder inside the repository'] };
  } else return usage();
  console.log(ascii(JSON.stringify(result, null, 2)));
  return result.ok ? 0 : 1;
}

function usage() {
  console.error('Usage: node finish.mjs ready | collect | draft --change NAME | hash [--root DIR] [--lang ja|en]');
  return 2;
}

function invokedDirectly() {
  if (!process.argv[1]) return false;
  try { return fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url)); } catch { return false; }
}

if (invokedDirectly()) process.exitCode = main(process.argv.slice(2));
