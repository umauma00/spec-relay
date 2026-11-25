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
//   node finish.mjs run --change NAME [--timeout-minutes N] [--root DIR]
//        runs every command of checks.md's ## Commands and, for every context,
//        each level verification.md chose with the commands of that context's
//        archived ports (the same commands their verify runs used), over the
//        whole target root; writes pass or fail into checks.md and the target
//        hash. The cross-context flows are left to the orchestrator.
//   node finish.mjs hash [--root DIR]
//        the fingerprint of the target root that checks.md records
//
// `gate.mjs review --change finish` runs checkFinish below. Prints JSON and exits
// 0 when ok, 1 when not, 2 on bad usage, like gate.mjs. Read-only except `draft`
// and `run`.
import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  readIf, tableRows, plain, norm, contextIds, archivedChange, baseName,
  baselineHash, capabilitySegments, configValue, cleanValue, language, PLAN,
} from './gate.mjs';
// The plan is read exactly as status.mjs reads it, so "all ported" there and here agree.
import { parsePlan } from './status.mjs';

const planCapabilities = (text) => parsePlan(text ?? '').list.map((c) => c.capability);

export const FINISH = 'finish';
export const KINDS = ['todo', 'follow-up', 'risk', 'verification', 'flow'];
export const CLASSES = ['before-release', 'after-release', 'wont-fix'];
export const LEVELS = ['A', 'B1', 'B2', 'C'];
export const MARKER = /TODO\(port\)/;
// Folders that only ever hold build output, packages or editor files: left out
// everywhere, also when git does not ignore them (a target without a .gitignore).
const TOOL_DIRS = new Set(['.git', 'node_modules', 'bin', 'obj', '__pycache__', '.venv', 'venv', '.gradle', '.idea', '.vs',
  '.pytest_cache', '.mypy_cache', '.tox', '.next', '.turbo']);
// Folder names that are usually build output but may be code; left out only
// outside git, where no ignore rules decide.
const BUILD_DIRS = new Set([...TOOL_DIRS, 'target', 'build', 'dist', 'out', '.vscode', 'coverage']);
const FOLD = process.platform === 'win32' || process.platform === 'darwin';
const fold = (s) => (FOLD ? s.toLowerCase() : s);
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
  const skip = (file) => /^(\.git|openspec|\.agents|\.github)(\/|$)/i.test(file)
    || file.slice(prefix.length).split('/').slice(0, -1).some((part) => TOOL_DIRS.has(part))
    || (!prefix && source !== '.' && (fold(file) === fold(source) || fold(file).startsWith(`${fold(source)}/`)));
  const out = [];
  const visit = (dirRel, dirs) => {
    let entries = [];
    try { entries = fs.readdirSync(path.join(base, dirRel), { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const child = dirRel ? `${dirRel}/${e.name}` : e.name;
      if (skip(child)) continue;
      if (e.isDirectory()) { if (!dirs.has(e.name)) visit(child, dirs); } else if (e.isFile()) out.push(child);
    }
  };
  const git = spawnSync('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard', '--', prefix || '.'], { cwd: base, encoding: 'buffer', windowsHide: true, maxBuffer: Infinity });
  if (git.status === 0 && git.stdout) {
    const top = spawnSync('git', ['rev-parse', '--show-cdup'], { cwd: base, encoding: 'utf8', windowsHide: true });
    if (top.status === 0 && top.stdout.trim() === '') {
      const listed = git.stdout.toString('utf8').split('\0').filter(Boolean);
      // A nested repository or submodule is listed as its folder: read what is on disk in it.
      for (const f of listed.map((x) => x.replace(/\/$/, ''))) {
        if (skip(f)) continue;
        let stat;
        try { stat = fs.statSync(path.join(base, f)); } catch { continue; }
        if (stat.isDirectory()) visit(f, BUILD_DIRS); else out.push(f);
      }
      return [...new Set(out)].sort();
    }
  }
  visit(prefix.replace(/\/$/, ''), BUILD_DIRS);
  return [...new Set(out)].sort();
}

// sha256 over every target file's path and content, with CRLF read as LF so a
// Windows checkout gives the same hash.
// A file that cannot be read (locked, too large) is reported in `problems`, so it
// never hashes as a constant and lets a change through.
export function targetHash(root, files = targetFiles(root), problems = []) {
  if (files === null) return null;
  const lines = files.map((f) => {
    try {
      const data = fs.readFileSync(path.join(root, f));
      const text = data.includes(0) ? data : Buffer.from(data.toString('latin1').replace(/\r\n/g, '\n'), 'latin1');
      return `${f}\0${crypto.createHash('sha256').update(text).digest('hex')}`;
    } catch (error) {
      problems.push(`could not read ${f} under the target root (${error.code ?? error.message}); close the program that holds it and run again`);
      return `${f}\0?`;
    }
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
// The rows come from its Levels section, or from any table whose first cell is a
// known context (what gate.mjs checked when the target design was reviewed).
export function chosenLevels(text, contexts = null) {
  const yes = /^(yes|y|true|on|required|✓|✔|○|◯|〇|必須|必要|要|あり|はい|する|使う|実施|採用)/i;
  let rows = tableRows(section(text, /levels?\b|レベル|方式|比べ方/i));
  if (contexts && !rows.some(([c = '']) => contexts.includes(plain(c).toLowerCase()))) rows = tableRows(text);
  return rows.filter(([context = '']) => plain(context) && (!contexts || contexts.includes(plain(context).toLowerCase())))
    .map(([context, ...cells]) => ({
      context: plain(context).toLowerCase(),
      chosen: LEVELS.filter((level, i) => level === 'A' || yes.test(plain(cells[i] ?? ''))),
    }));
}

// The relationships of the context map: its Relationships section, or any table
// row whose first two cells are both context ids.
function relationsOf(map, contexts) {
  const read = (rows) => rows.map(([upstream = '', downstream = '', pattern = '', channel = '']) => ({ upstream: plain(upstream), downstream: plain(downstream), pattern: plain(pattern), channel: plain(channel) }))
    .filter((r) => contexts.includes(r.upstream.toLowerCase()) && contexts.includes(r.downstream.toLowerCase()));
  const found = read(tableRows(section(map, /relationships?\b|関係/i)));
  return found.length ? found : read(tableRows(map));
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
  const contexts = contextIds(map);
  const relations = relationsOf(map, contexts);
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
  if (files && files.length === 0) problems.push(`the target root "${rootValue(root, 'Target root')}" holds no files`);
  const sha256 = files ? targetHash(root, files, problems) : null;
  return {
    ok: problems.length === 0,
    target: { root: rootValue(root, 'Target root'), files: files?.length ?? 0, sha256 },
    markers: files ? portMarkers(root, files) : [],
    followUps: planFollowUps(plan),
    risks,
    contexts,
    levels: chosenLevels(verification, contexts),
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
const whereFile = (where) => relPath(where.replace(/:\d+(?:-\d+)?$/, ''));
// A cell as written: comments and the table's `\|` escapes undone. Paths keep
// every character (invoice_service.py, [id].tsx, (shop)/cart.tsx).
const raw = (s) => stripComments(s ?? '').replace(/\\\|/g, '|').trim();

export function leftoverRows(text) {
  return tableRows(text).map(([id = '', kind = '', where = '', what = '', klass = '', reason = '']) => ({
    id: plain(id).toUpperCase(), kind: cell(kind), where: raw(where).replace(/^`(.*)`$/, '$1').trim(), what: raw(what), klass: cell(klass), reason: raw(reason),
  })).filter((r) => r.id || r.kind || r.what);
}

// Called by gate.mjs review for a change of schema spec-relay-finish.
export function checkFinish(root, change, dir, boxes, problems) {
  if (baseName(change) !== FINISH) problems.push(`a change of schema spec-relay-finish is named ${FINISH} (or ${FINISH}-v<n>), not ${change}`);
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
      else if (/^not[- ]?run/.test(value) && level === 'A') problems.push(`level A of context ${context} is the new system's own scenario tests; they always run (record pass or fail)`);
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
    if (id && !ids.has(id)) { problems.push(`review item ${id} has no row in leftovers.md`); continue; }
    // The class the person accepted is the one in leftovers.md.
    const said = id && box.plain.match(/\bclass:\s*([\w-]+)/i)?.[1]?.toLowerCase();
    const row = id && rows.find((r) => r.id === id);
    if (said && row && CLASSES.includes(said) && said !== row.klass) problems.push(`review item ${id} says class ${said}, and leftovers.md says ${row.klass || 'nothing'}; make them the same`);
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
  // A marker inside an HTML or XML comment would end or open a comment in the table.
  const esc = (s) => s.replace(/<!--|-->/g, ' ').replace(/\|/g, '\\|').trim();
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

// ---------------------------------------------------------------- run

const cellsOf = (line) => line.trim().replace(/^\|/, '').replace(/\|$/, '').split(/(?<!\\)\|/).map((c) => c.trim());
const rowLine = (cells) => `| ${cells.join(' | ')} |`;
// A command written in a table cell, without code marks; '' for a placeholder.
const commandIn = (cell = '') => {
  const text = stripComments(cell).replace(/\\\|/g, '|').trim().replace(/^`+([\s\S]*?)`+$/, '$1').trim();
  return /^(<.*>|tbd|todo|-|none|なし|\.\.\.|…)?$/i.test(text) ? '' : text;
};
const RUN_NOTE = /\s*(?:;\s*)?finish\.mjs run [^;|]*/g;
// The Notes cell with this run's note in place of an earlier one.
const noted = (cell, note) => {
  const kept = stripComments(cell ?? '').replace(RUN_NOTE, '').replace(/^\s*;\s*|\s*;\s*$/g, '').trim();
  return kept ? `${kept}; ${note}` : note;
};

// The table rows of the `## <heading>` section of checks.md, with their line
// indexes: { header, at: [index], rows: [cells] }, or null.
function tableIn(lines, heading) {
  let inside = false;
  let fenced = false;
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    if (/^\s*(```|~~~)/.test(line)) { fenced = !fenced; continue; }
    if (fenced) continue;
    const h2 = line.match(/^##\s+(.*?)\s*#*\s*$/);
    if (h2) { inside = heading.test(h2[1].trim()); continue; }
    if (!inside || !/^\s*\|/.test(line) || !/^\s*\|?\s*:?-{2,}/.test(lines[i + 1] ?? '')) continue;
    const table = { header: cellsOf(line).map((c) => plain(c).toLowerCase()), at: [], rows: [] };
    for (i += 2; i < lines.length && /^\s*\|/.test(lines[i]); i += 1) { table.at.push(i); table.rows.push(cellsOf(lines[i])); }
    return table;
  }
  return null;
}

const TAIL = 40;
const tailOf = (text) => (text ?? '').replace(/\s+$/, '').split(/\r?\n/).slice(-TAIL).join('\n');
const say = (line) => process.stderr.write(`finish: ${line}\n`);

// Runs every check of checks.md over the whole target root and writes the
// results into it: each command of ## Commands, and for every context each
// level verification.md chose, with the commands of that context's archived
// ports (A and the boundary check from their design.md or conventions.md, B1,
// B2 and C from their design.md). A command the Commands table already ran is
// not run again for a level. Every check runs, also after a failure, so that
// one run shows everything to fix. Then it writes the target hash. The
// cross-context flows stay the orchestrator's: which test covers a flow is a
// reading of the tests, not a run.
export async function runChecks(root, change, { timeoutMs = 60 * 60 * 1000, run = null, progress = say } = {}) {
  if (!change || baseName(change) !== FINISH) return { ok: false, problems: [`the finish change is named ${FINISH} (or ${FINISH}-v<n>), not ${change}`] };
  const dir = path.join(root, 'openspec/changes', change);
  const file = path.join(dir, 'checks.md');
  const problems = [];
  const text = readIf(file, problems);
  if (text === null) return { ok: false, problems: [`openspec/changes/${change}/checks.md is missing; run finish.mjs draft --change ${change} first`] };
  if (problems.length) return { ok: false, problems };
  const files = targetFiles(root);
  if (files === null) return { ok: false, problems: ['the target root in openspec/config.yaml is not a folder inside the repository'] };
  const cwd = path.resolve(root, rootValue(root, 'Target root'));
  const { runLevel } = await import('./verify.mjs');
  const { chainProblem, verifyPlan } = await import('./gate.mjs');
  const runOne = run ?? runLevel;
  const date = new Date().toISOString().slice(0, 10);
  const crlf = /\r\n/.test(text);
  const lines = text.replace(/\r\n/g, '\n').split('\n');

  // ## Commands
  const ran = new Map();
  const commands = [];
  const table = tableIn(lines, /^commands?\b|^コマンド/i);
  if (!table) problems.push('checks.md has no table under ## Commands');
  else {
    const at = (pattern, fallback) => { const i = table.header.findIndex((h) => pattern.test(h)); return i >= 0 ? i : fallback; };
    const [cCommand, cResult, cNotes] = [at(/^(command|コマンド)/, 1), at(/^(result|結果)/, 2), at(/^(notes?|備考|メモ)/, 3)];
    for (const [n, cells] of table.rows.entries()) {
      const purpose = plain(cells[0] ?? '');
      const command = commandIn(cells[cCommand]);
      if (!purpose && !command) continue;
      if (!command) { problems.push(`checks.md: the ${purpose || 'unnamed'} row names no command`); continue; }
      const chained = chainProblem(command);
      if (chained) { problems.push(`checks.md ${purpose}: ${chained}`); continue; }
      progress(`${purpose}: ${command}`);
      const result = await runOne(command, cwd, { timeoutMs, root });
      progress(`${purpose}: ${result.exitCode === 0 ? 'passed' : result.timedOut ? 'timed out' : `failed, exit code ${result.exitCode}`} in ${result.seconds}s`);
      ran.set(command, result);
      commands.push({ purpose, command, exitCode: result.exitCode, seconds: result.seconds, ...(result.timedOut ? { timedOut: true } : {}), ...(result.exitCode !== 0 ? { tail: tailOf(result.output) } : {}) });
      while (cells.length <= Math.max(cResult, cNotes)) cells.push('');
      cells[cResult] = result.exitCode === 0 ? 'pass' : 'fail';
      cells[cNotes] = noted(cells[cNotes], `finish.mjs run ${date}, ${result.seconds} s`);
      lines[table.at[n]] = rowLine(cells);
    }
  }

  // ## Verification levels, per context, over its archived ports.
  const changes = path.join(root, 'openspec/changes');
  const byContext = new Map();
  for (const capability of planCapabilities(readIf(path.join(root, PLAN), problems))) {
    const portDir = archivedChange(root, `port-${capabilitySegments(capability).join('-')}`);
    if (!portDir) continue;
    const context = capabilitySegments(capability)[0];
    if (!byContext.has(context)) byContext.set(context, []);
    byContext.get(context).push({ capability, change: path.relative(changes, portDir).split(path.sep).join('/') });
  }
  const levels = [];
  const outcome = new Map();
  for (const [context, ports] of byContext) {
    for (const port of ports) {
      const plan = verifyPlan(root, port.change, port.capability);
      for (const p of plan.problems) problems.push(`${port.capability}: ${p}`);
      const done = new Map();
      for (const { level, command } of plan.runs) {
        if (level === 'boundary') continue;
        let result = ran.get(command) ?? done.get(command);
        const again = Boolean(result);
        if (!result) {
          progress(`${context} ${level} (${port.capability}): ${command}`);
          result = await runOne(command, cwd, { timeoutMs, root, change: null, capability: port.capability });
          progress(`${context} ${level}: ${result.exitCode === 0 ? 'passed' : result.timedOut ? 'timed out' : `failed, exit code ${result.exitCode}`} in ${result.seconds}s`);
          done.set(command, result);
        }
        levels.push({ context, capability: port.capability, level, command, exitCode: result.exitCode, ...(again ? { sameAs: 'an earlier run' } : { seconds: result.seconds }), ...(result.exitCode !== 0 && !again ? { tail: tailOf(result.output) } : {}) });
        const key = `${context}\0${level}`;
        const was = outcome.get(key) ?? { pass: true, failed: [] };
        if (result.exitCode !== 0) { was.pass = false; was.failed.push(port.capability); }
        outcome.set(key, was);
      }
    }
  }
  const lt = tableIn(lines, /^verification\b|^検証|^比べ方/i);
  if (!lt) problems.push('checks.md has no table under ## Verification levels');
  else {
    const colOf = (level) => lt.header.findIndex((h) => new RegExp(`^${level.toLowerCase()}(?![0-9a-z])`).test(h));
    const notesAt = lt.header.findIndex((h) => /^(notes?|備考|メモ)/.test(h));
    for (const [n, cells] of lt.rows.entries()) {
      const context = plain(cells[0] ?? '').toLowerCase();
      const failedNotes = [];
      let touched = false;
      for (const level of LEVELS) {
        const result = outcome.get(`${context}\0${level}`);
        const c = colOf(level);
        if (!result || c < 0) continue;
        while (cells.length <= c) cells.push('');
        cells[c] = result.pass ? 'pass' : 'fail';
        touched = true;
        if (!result.pass) failedNotes.push(`${level} failed in ${result.failed.join(', ')}`);
      }
      if (touched && notesAt >= 0) {
        while (cells.length <= notesAt) cells.push('');
        cells[notesAt] = noted(cells[notesAt], `finish.mjs run ${date}${failedNotes.length ? `: ${failedNotes.join(', ')}` : ''}`);
      }
      if (touched) lines[lt.at[n]] = rowLine(cells);
    }
    for (const context of byContext.keys()) if (!lt.rows.some((cells) => plain(cells[0] ?? '').toLowerCase() === context)) problems.push(`checks.md has no verification row for context ${context}`);
  }

  // The fingerprint of the code the checks ran on.
  const sha256 = targetHash(root, targetFiles(root), problems);
  const hashAt = lines.findIndex((l) => /^Target:\s*sha256:/i.test(l));
  if (hashAt >= 0) lines[hashAt] = `Target: sha256:${sha256}`;
  else lines.splice(1, 0, '', `Target: sha256:${sha256}`);
  const out = lines.join('\n');
  try { fs.writeFileSync(file, crlf ? out.replace(/\n/g, '\r\n') : out); } catch (error) { problems.push(`could not write checks.md: ${error.message}`); }
  const failed = [...commands, ...levels].filter((r) => r.exitCode !== 0);
  for (const r of failed) problems.push(`${r.purpose ?? `level ${r.level} of ${r.capability}`} failed: ${r.command}`);
  return { ok: problems.length === 0, file: `openspec/changes/${change}/checks.md`, target: sha256, commands, levels, problems };
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
    const key = { '--change': 'change', '--root': 'root', '--lang': 'lang', '--timeout-minutes': 'timeout' }[rest[i]];
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
  else if (command === 'run' && opts.change) {
    const minutes = Number(opts.timeout ?? 60);
    if (!(minutes > 0) || minutes * 60 * 1000 > 2 ** 31 - 1) return usage();
    return runChecks(opts.root, opts.change, { timeoutMs: minutes * 60 * 1000 }).then((r) => {
      console.log(ascii(JSON.stringify(r, null, 2)));
      return r.ok ? 0 : 1;
    });
  }
  else if (command === 'hash') {
    const files = targetFiles(opts.root);
    result = files ? { ok: true, target: rootValue(opts.root, 'Target root'), files: files.length, sha256: targetHash(opts.root, files) } : { ok: false, problems: ['the target root in openspec/config.yaml is not a folder inside the repository'] };
  } else return usage();
  console.log(ascii(JSON.stringify(result, null, 2)));
  return result.ok ? 0 : 1;
}

function usage() {
  console.error('Usage: node finish.mjs ready | collect | draft --change NAME | run --change NAME [--timeout-minutes N] | hash [--root DIR] [--lang ja|en]');
  return 2;
}

function invokedDirectly() {
  if (!process.argv[1]) return false;
  try { return fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url)); } catch { return false; }
}

if (invokedDirectly()) Promise.resolve(main(process.argv.slice(2))).then((code) => { process.exitCode = code; });
