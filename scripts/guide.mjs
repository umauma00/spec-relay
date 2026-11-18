#!/usr/bin/env node
// The code guide (optional, after the ports): helps a person understand the new
// code. It has three ways in (by feature, by page or URL, by file), diagrams of
// the modules and the data drawn from the target design, explanations of the
// code written per module by subagents, and the questions and answers the person
// found helpful.
//
// The Markdown under openspec/spec-relay/guide/ is the source of truth:
//   stack.md            the runtime, frameworks, commands and build files (init writes it)
//   routes.md           pages and URLs: | Page or URL | Method | Handler | Capability | Screen |
//   code/<module>.md    per module: ## Overview, then "### File: <path>" blocks
//   qa/<module>.md      saved questions and answers, each with the file's hash
// The diagrams are never stored: render.mjs --guide draws them from
// architecture.md each time. The guide is an explanation: no gate reads it and
// it never approves anything.
//
//   node guide.mjs init  [--root DIR]               folders, stack.md, routes.md; prints each module's files
//   node guide.mjs stamp [--module NAME] [--file PATH]... [--root DIR]
//                                                   writes the hash under each heading that has none; --file
//                                                   (repeatable, or all) also replaces it for files explained again
//   node guide.mjs check [--root DIR]               references that do not exist, stale and missing explanations
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { archivedChange, headedRows, section, plain, targetFiles, readIf, configValue, cleanValue } from './gate.mjs';
import { escapeHtml, markdown, inline, parseRefs, capabilities, readItem } from './render.mjs';

export const GUIDE = 'openspec/spec-relay/guide';
const CODE = `${GUIDE}/code`;
const QA = `${GUIDE}/qa`;
const ROUTES = `${GUIDE}/routes.md`;
const STACK = `${GUIDE}/stack.md`;

// Files that are code (an explanation per file is worth it); other files are listed only.
const CODE_EXT = new Set(['.java', '.kt', '.kts', '.scala', '.groovy', '.cs', '.vb', '.fs', '.py', '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.vue', '.svelte', '.php', '.rb', '.go', '.rs', '.swift', '.dart', '.sql', '.html', '.cshtml', '.razor', '.jsp', '.erb', '.twig']);
const BUILD_FILES = /(^|\/)(package\.json|pom\.xml|build\.gradle(\.kts)?|settings\.gradle(\.kts)?|[^/]+\.csproj|[^/]+\.sln|Directory\.Build\.props|pyproject\.toml|requirements[^/]*\.txt|setup\.cfg|go\.mod|Cargo\.toml|composer\.json|Gemfile|tsconfig\.json)$/i;
const MODULE_KEY = /^[a-z0-9][a-z0-9-]{0,63}$/;

const rel = (p) => p.replace(/\\/g, '/').replace(/^\.\//, '').replace(/^\/+/, '').replace(/\/+$/, '');
const fold = (p) => (process.platform === 'win32' || process.platform === 'darwin' ? p.toLowerCase() : p);
// A file's hash as the rest of the kit hashes text: without a BOM and with CRLF
// read as LF, so a Windows checkout (core.autocrlf) hashes the same as any other.
export const fileHash = (buffer) => {
  const text = Buffer.from(buffer).toString('latin1').replace(/^\xEF\xBB\xBF/, '').replace(/\r\n/g, '\n');
  return crypto.createHash('sha256').update(text, 'latin1').digest('hex').slice(0, 16);
};
// A path under the repository that really is inside it (no link out of it), or null.
function inRepo(root, file) {
  try {
    const base = fs.realpathSync(root);
    const real = fs.realpathSync(path.join(root, file));
    const r = path.relative(base, real);
    return r && !r.startsWith('..') && !path.isAbsolute(r) ? real : null;
  } catch { return null; }
}
const hashOf = (root, file) => { const real = inRepo(root, file); try { return real ? fileHash(fs.readFileSync(real)) : null; } catch { return null; } };
const read = (root, file) => { const real = inRepo(root, file); try { return real ? fs.readFileSync(real, 'utf8').replace(/^\uFEFF/, '') : null; } catch { return null; } };
const stripComments = (text) => text.replace(/<!--[\s\S]*?-->/g, '');
// Code fences as Markdown reads them: an opening run of three or more ` or ~ (a
// backtick run with no backtick after it), closed by a run of the same character,
// at least as long, with nothing after it. `open` is the opening run, or null.
function fence(line, open) {
  if (open) { const m = line.match(/^ {0,3}(`{3,}|~{3,})\s*$/); return m && m[1][0] === open[0] && m[1].length >= open.length ? null : open; }
  const m = line.match(/^ {0,3}(`{3,}|~{3,})(.*)$/);
  return m && !(m[1][0] === '`' && m[2].includes('`')) ? m[1] : null;
}

// A module's file name: its context in lower case, words joined by hyphens.
export const moduleKey = (context) => plain(String(context)).toLowerCase().normalize('NFKC').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');

// ---------------------------------------------------------------- the target design

const designText = (root, name) => {
  const dir = archivedChange(root, 'target-design');
  return dir ? readIf(path.join(dir, name), []) ?? '' : '';
};
const column = (row, re) => { const i = row.header.findIndex((h) => re.test(h)); return i >= 0 ? (row.cells[i] ?? '').trim() : ''; };
const listCell = (cell) => plain(cell).split(/[,、;]|<br\s*\/?>/i).map((s) => s.trim()).filter((s) => s && s !== '-' && !/^(none|なし)$/i.test(s));

// The target root as configured, relative to the repository ('' when none).
const targetRoot = (root) => rel(cleanValue(configValue(root, 'Target root', '') ?? ''));

// A module path as written: from the repository root, or from the target root.
function modulePath(root, written) {
  const p = rel(written);
  const target = targetRoot(root);
  if (!p || !target || target === '.' || fold(p) === fold(target) || fold(p).startsWith(`${fold(target)}/`)) return p;
  // Target files all start with the target root, so a path outside it would match nothing.
  return fs.existsSync(path.join(root, target, p)) ? `${target}/${p}` : p;
}

// The modules of architecture.md's "## Modules" table.
export function modules(root) {
  const text = section(designText(root, 'architecture.md'), /^modules$/i) ?? '';
  const out = [];
  for (const row of headedRows(text)) {
    const context = plain(column(row, /^context/));
    const key = moduleKey(context);
    if (!context || !MODULE_KEY.test(key) || out.some((m) => m.key === key)) continue;
    out.push({
      key, context,
      path: modulePath(root, plain(column(row, /^module path/))),
      api: plain(column(row, /^public api/)),
      events: listCell(column(row, /^events/)),
      dependsOn: listCell(column(row, /^depends/)).map(moduleKey),
    });
  }
  return out;
}

// The rows of architecture.md's "## Data ownership" table.
export function dataOwnership(root) {
  const text = section(designText(root, 'architecture.md'), /^data ownership$/i) ?? '';
  return headedRows(text).map((row) => ({ table: plain(column(row, /^table/)), owner: moduleKey(column(row, /^owning/)) })).filter((r) => r.table && r.owner);
}

// What runs the new system: conventions.md's runtime lines and commands, and the build files.
export function stackFacts(root) {
  const conventions = designText(root, 'conventions.md');
  const runtime = (section(conventions, /^runtime/i) ?? '').split(/\r?\n/).map((l) => l.match(/^\s*[-*]\s+(.*)$/)?.[1]?.trim()).filter(Boolean);
  const commands = headedRows(section(conventions, /^commands$/i) ?? '').map((row) => ({ purpose: plain(column(row, /^purpose/)), command: column(row, /^command/).replace(/^`|`$/g, '') })).filter((c) => c.purpose && c.command);
  const files = targetFiles(root) ?? [];
  return { runtime, commands, buildFiles: files.filter((f) => BUILD_FILES.test(f)).sort() };
}

// The files of a module: the target files under its module path.
export function moduleFiles(root, mod, files = targetFiles(root) ?? []) {
  if (!mod.path) return [];
  const prefix = `${fold(mod.path)}/`;
  return files.filter((f) => fold(f).startsWith(prefix)).sort();
}
const isCode = (file) => CODE_EXT.has(path.extname(file).toLowerCase());
// Code files of the target that no module's path covers (an entry point, shared configuration code).
function unassigned(mods, files) {
  return files.filter((f) => isCode(f) && !mods.some((m) => m.path && fold(f).startsWith(`${fold(m.path)}/`))).sort();
}

// ---------------------------------------------------------------- the guide's own files

// code/<module>.md: the overview and the "### File: <path>" blocks, each with the hash it was written against.
export function parseCodeGuide(text) {
  const out = { overview: '', files: [] };
  if (!text) return out;
  const overview = section(text, /^overview$/i);
  out.overview = overview ? overview.split(/\n(?=###\s)/)[0].trim() : '';
  let block = null;
  let fenced = false;
  for (const line of text.replace(/^\uFEFF/, '').split(/\r?\n/)) {
    fenced = fence(line, fenced);
    const head = fenced ? null : line.match(/^###\s+File:\s*(.+?)\s*$/i);
    if (head) { block = { file: rel(head[1].replace(/`/g, '')), hash: null, body: [] }; out.files.push(block); continue; }
    if (!fenced && /^#{1,3}\s/.test(line)) { block = null; continue; }
    if (!block) continue;
    const stamp = line.match(/^<!--\s*hash:\s*([0-9a-f]{16})\s*-->\s*$/i);
    if (stamp && block.hash === null && !block.body.some((l) => l.trim())) { block.hash = stamp[1].toLowerCase(); continue; }
    block.body.push(line);
  }
  for (const b of out.files) b.body = b.body.join('\n').trim();
  return out;
}

// routes.md: | Page or URL | Method | Handler | Capability | Screen |
export function parseRoutes(text) {
  return headedRows(text ?? '').map((row) => ({
    url: column(row, /^(page|url)/).replace(/^`|`$/g, ''),
    method: plain(column(row, /^method/)).toUpperCase(),
    handler: column(row, /^handler/),
    refs: parseRefs(column(row, /^handler/)),
    capability: plain(column(row, /^capability/)),
    screen: plain(column(row, /^screen/)),
  })).filter((r) => r.url);
}

// qa/<module>.md: "### Q: <question>", then "- File:", "- Hash:", "- Saved:" and the answer.
// The fields are the lines right under the heading, up to the first other line:
// a "- File:" line in the answer stays answer text. A heading inside a code fence
// is answer text too.
export function parseQa(text) {
  const out = [];
  let entry = null;
  let fields = false;
  let fenced = false;
  for (const line of (text ?? '').replace(/^\uFEFF/, '').split(/\r?\n/)) {
    const q = !fenced && line.match(/^###\s+Q:\s*(.*)$/);
    if (q) { entry = { question: q[1].trim(), file: '', hash: '', saved: '', answer: [] }; out.push(entry); fields = true; continue; }
    if (!entry) continue;
    const field = fields && line.match(/^-\s+(File|Hash|Saved):\s*(.*)$/i);
    if (field) { entry[field[1].toLowerCase()] = field[2].trim().replace(/^`|`$/g, ''); continue; }
    fields = false;
    fenced = fence(line, fenced);
    entry.answer.push(line);
  }
  for (const e of out) e.answer = e.answer.join('\n').trim();
  return out;
}

// ---------------------------------------------------------------- commands

const STACK_HEAD = '# Stack\n\n<!-- Written by guide.mjs init from conventions.md and the build files; edit it freely. -->\n';
const ROUTES_TEMPLATE = `# Routes

<!-- Every page, URL or endpoint of the new system. Handler: path:line or path:Symbol under the target root.
     guide.mjs check confirms the file, the line and the symbol exist. -->

| Page or URL | Method | Handler | Capability | Screen |
|---|---|---|---|---|
`;

function stackMarkdown(facts) {
  const lines = [STACK_HEAD, '## Runtime and frameworks', ...(facts.runtime.length ? facts.runtime.map((r) => `- ${r}`) : ['- (conventions.md lists none)']), '', '## Commands', '| Purpose | Command |', '|---|---|',
    ...facts.commands.map((c) => `| ${c.purpose} | \`${c.command.replace(/\|/g, '\\|')}\` |`), '', '## Build files', ...(facts.buildFiles.length ? facts.buildFiles.map((f) => `- ${f}`) : ['- (none found)']), ''];
  return lines.join('\n');
}

// Makes the folders and the two starting files (never over an existing one), and
// lists each module's files: the assignments for the writers.
export function init(root) {
  const mods = modules(root);
  if (!mods.length) return { ok: false, problems: ['no modules: the archived target-design change has no "## Modules" table in architecture.md (run the target design first)'] };
  const files = targetFiles(root);
  if (files === null) return { ok: false, problems: ['openspec/config.yaml names no target root inside the repository'] };
  for (const dir of [CODE, QA]) fs.mkdirSync(path.join(root, dir), { recursive: true });
  const wrote = [];
  if (!fs.existsSync(path.join(root, STACK))) { fs.writeFileSync(path.join(root, STACK), stackMarkdown(stackFacts(root))); wrote.push(STACK); }
  if (!fs.existsSync(path.join(root, ROUTES))) { fs.writeFileSync(path.join(root, ROUTES), ROUTES_TEMPLATE); wrote.push(ROUTES); }
  return {
    ok: true, wrote,
    unassigned: unassigned(mods, files),
    modules: mods.map((m) => {
      const all = moduleFiles(root, m, files);
      return { module: m.key, context: m.context, path: m.path, guide: `${CODE}/${m.key}.md`, code: all.filter(isCode), other: all.filter((f) => !isCode(f)).length };
    }),
  };
}

// Writes "<!-- hash: ... -->" under every "### File:" heading that has none, so a
// later check knows which explanations the code has moved away from. A hash that
// is there is changed only for the files named in `files` (explanations written
// again), or for all with files 'all': stamping never hides a stale explanation.
// A saved Q&A entry whose
// "- Hash:" is empty (one the orchestrator wrote on the person's word) gets the
// file's hash now; a filled one is never changed.
function stampQa(root, key) {
  const file = path.join(root, QA, `${key}.md`);
  let text;
  try { text = fs.readFileSync(file, 'utf8'); } catch { return 0; }
  const eol = /\r\n/.test(text) ? '\r\n' : '\n';
  const lines = text.split(/\r?\n/);
  // Read as parseQa reads it: fields only right under the heading, headings only outside fences.
  let target = null, empty = -1, fields = false, fenced = false, filled = 0;
  const fill = () => { const hash = target && empty >= 0 ? hashOf(root, target) : null; if (hash) { lines[empty] = `- Hash: ${hash}`; filled += 1; } };
  for (let i = 0; i < lines.length; i += 1) {
    if (!fenced && /^###\s+Q:/.test(lines[i])) { fill(); target = null; empty = -1; fields = true; continue; }
    const f = fields && lines[i].match(/^-\s+(File|Hash|Saved):\s*(.*)$/i);
    if (f) {
      if (/^file$/i.test(f[1])) target = rel(f[2].trim().replace(/^`|`$/g, ''));
      else if (/^hash$/i.test(f[1]) && !f[2].trim()) empty = i;
      continue;
    }
    if (fields) { fill(); target = null; empty = -1; fields = false; }
    fenced = fence(lines[i], fenced);
  }
  fill();
  if (filled) fs.writeFileSync(file, lines.join(eol));
  return filled;
}

export function stamp(root, { module, files = [] } = {}) {
  const again = files === 'all' ? null : new Set((Array.isArray(files) ? files : [files]).filter(Boolean).map((f) => fold(rel(String(f)))));
  const mods = modules(root).filter((m) => !module || m.key === moduleKey(module));
  if (module && !mods.length) return { ok: false, problems: [`no module ${module} in architecture.md`] };
  const result = [];
  for (const m of mods) {
    const file = path.join(root, CODE, `${m.key}.md`);
    let text;
    try { text = fs.readFileSync(file, 'utf8'); } catch { continue; }
    const eol = /\r\n/.test(text) ? '\r\n' : '\n';
    const lines = text.split(/\r?\n/);
    let fenced = false;
    let stamped = 0;
    for (let i = 0; i < lines.length; i += 1) {
      fenced = fence(lines[i], fenced);
      const head = !fenced && lines[i].match(/^###\s+File:\s*(.+?)\s*$/i);
      if (!head) continue;
      const named = rel(head[1].replace(/`/g, ''));
      const hash = hashOf(root, named);
      if (!hash) continue;
      const line = `<!-- hash: ${hash} -->`;
      if (/^<!--\s*hash:\s*[0-9a-f]{16}\s*-->\s*$/i.test(lines[i + 1] ?? '')) {
        if (lines[i + 1] !== line && (again === null || again.has(fold(named)))) { lines[i + 1] = line; stamped += 1; }
      } else { lines.splice(i + 1, 0, line); stamped += 1; }
    }
    if (stamped) fs.writeFileSync(file, lines.join(eol));
    result.push({ module: m.key, stamped, qa: stampQa(root, m.key) });
  }
  return { ok: true, modules: result };
}

// "- `name` (line 42): ..." in an explanation: the name must be in the file and the line must exist.
const MENTION = /^\s*[-*]\s+`([^`]+)`\s*[（(]\s*(?:line|行)\s*(\d+)\s*[)）]/i;
const lastName = (name) => name.replace(/\(.*$/, '').split(/[.#:]/).filter(Boolean).pop() ?? '';

// What the guide says that the code no longer bears out.
export function check(root) {
  const problems = [];
  const mods = modules(root);
  if (!mods.length) return { ok: false, problems: ['no modules in the archived target design (architecture.md)'], modules: [] };
  const files = targetFiles(root) ?? [];
  const known = new Set(files.map(fold));
  const lineCount = new Map();
  const textOf = (file) => read(root, file);
  const linesIn = (file) => { if (!lineCount.has(file)) { const t = textOf(file); lineCount.set(file, t === null ? null : t.split(/\r?\n/).length); } return lineCount.get(file); };
  const report = mods.map((m) => {
    const guideFile = `${CODE}/${m.key}.md`;
    const guide = parseCodeGuide(read(root, guideFile));
    const own = moduleFiles(root, m, files);
    const explained = new Set(guide.files.map((b) => fold(b.file)));
    const stale = [];
    const gone = [];
    for (const b of guide.files) {
      const hash = hashOf(root, b.file);
      if (!hash || !known.has(fold(b.file))) { gone.push(b.file); problems.push(`${guideFile}: ${b.file} does not exist under the target root`); continue; }
      if (b.hash !== hash) stale.push(b.file);
      const text = textOf(b.file) ?? '';
      for (const line of b.body.split(/\r?\n/)) {
        const m2 = line.match(MENTION);
        if (!m2) continue;
        const name = lastName(m2[1]);
        if (Number(m2[2]) > (linesIn(b.file) ?? 0)) problems.push(`${guideFile}: ${b.file} has no line ${m2[2]} (named for \`${m2[1]}\`)`);
        else if (name && !text.includes(name)) problems.push(`${guideFile}: \`${m2[1]}\` does not appear in ${b.file}`);
      }
    }
    const qa = parseQa(read(root, `${QA}/${m.key}.md`));
    return {
      // A module with no code yet (not ported) is no problem: it is shown, not failed.
      module: m.key, path: m.path, noCode: !own.some(isCode), guide: fs.existsSync(path.join(root, guideFile)),
      files: own.filter(isCode).length, explained: own.filter((f) => isCode(f) && explained.has(fold(f))).length,
      unexplained: own.filter((f) => isCode(f) && !explained.has(fold(f))), stale, gone,
      qa: qa.length, staleQa: qa.filter((q) => q.hash && hashOf(root, q.file) !== q.hash).length,
    };
  });
  for (const r of parseRoutes(read(root, ROUTES))) {
    if (!r.refs.length) { problems.push(`routes.md: ${r.url} names no handler file (path:line or path:Symbol)`); continue; }
    for (const ref of r.refs) {
      const text = known.has(fold(rel(ref.file))) ? textOf(rel(ref.file)) : null;
      if (text === null) { problems.push(`routes.md: ${r.url}: ${ref.file} does not exist under the target root`); continue; }
      if (ref.from && ref.from > text.split(/\r?\n/).length) problems.push(`routes.md: ${r.url}: ${ref.file} has no line ${ref.from}`);
      if (ref.symbol && !text.includes(lastName(ref.symbol))) problems.push(`routes.md: ${r.url}: \`${ref.symbol}\` does not appear in ${ref.file}`);
    }
  }
  return { ok: problems.length === 0, modules: report, unassigned: unassigned(mods, files), problems };
}

// How far the guide is, for the to-do list: null when there is no guide.
export function summary(root) {
  if (!fs.existsSync(path.join(root, GUIDE))) return null;
  const mods = modules(root);
  if (!mods.length) return null;
  const files = targetFiles(root) ?? [];
  let total = 0, explained = 0, stale = 0;
  for (const m of mods) {
    const guide = parseCodeGuide(read(root, `${CODE}/${m.key}.md`));
    const own = moduleFiles(root, m, files).filter(isCode);
    total += own.length;
    explained += own.filter((f) => guide.files.some((b) => fold(b.file) === fold(f))).length;
    stale += guide.files.filter((b) => { const h = hashOf(root, b.file); return !h || b.hash !== h; }).length;
  }
  return { files: total, explained, stale, unassigned: unassigned(mods, files).length };
}

// Saves one question and its answer under the module, with the file's hash now,
// so the guide can say when the code has changed since. Only the canvas's
// "helpful" button (the person) or the orchestrator on the person's word calls it.
export function saveQa(root, { module, file, question, answer, now = new Date() }) {
  const key = moduleKey(module ?? '');
  const mod = modules(root).find((m) => m.key === key);
  if (!mod) return { ok: false, problem: `no module ${module}` };
  const guide = parseCodeGuide(read(root, `${CODE}/${key}.md`));
  const target = rel(String(file ?? ''));
  const block = guide.files.find((b) => fold(b.file) === fold(target));
  if (!block) return { ok: false, problem: `${target} is not explained in ${CODE}/${key}.md` };
  const q = String(question ?? '').replace(/[\u0000-\u001f\u007f\u2028\u2029]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 500);
  // Only a "### Q:" line outside a code fence would start another entry: it stays as text.
  let fenced = false;
  const a = String(answer ?? '').replace(/\r\n?/g, '\n').trim().slice(0, 20000).split('\n').map((line) => {
    fenced = fence(line, fenced);
    return !fenced && /^###\s+Q:/.test(line) ? `\\${line}` : line;
  }).join('\n') + (fenced ? `\n${fenced}` : '');
  if (!q || !a) return { ok: false, problem: 'the question and the answer are both needed' };
  const out = path.join(root, QA, `${key}.md`);
  fs.mkdirSync(path.dirname(out), { recursive: true });
  // Never append through a link out of the repository.
  let link = false;
  try { const st = fs.lstatSync(out); link = st.isSymbolicLink() || !inRepo(root, `${QA}/${key}.md`); } catch { /* not there yet */ }
  if (!inRepo(root, QA) || link) return { ok: false, problem: `${QA}/${key}.md is a link or outside the repository` };
  const head = fs.existsSync(out) ? '' : `# Questions and answers: ${mod.context}\n\n<!-- Saved from the canvas when the person found an answer helpful. -->\n`;
  fs.appendFileSync(out, `${head}\n### Q: ${q}\n- File: ${block.file}\n- Hash: ${hashOf(root, block.file) ?? ''}\n- Saved: ${now.toISOString().slice(0, 10)}\n\n${a}\n`);
  return { ok: true, file: `${QA}/${key}.md` };
}

// ---------------------------------------------------------------- the pages

const WORDS = {
  ja: {
    kind: 'コードガイド', title: 'コードガイド', moduleKind: 'コードガイド・モジュール', toIndex: '← コードガイド',
    stack: '技術スタック', runtime: '実行環境とフレームワーク', commands: 'コマンド', buildFiles: 'ビルドファイル',
    architecture: 'アーキテクチャ', data: 'データの持ち主', modules: 'モジュール', routes: '画面と URL', features: '機能から探す', files: 'ファイル',
    overview: '概要', dependsOn: '依存先', events: '発行するイベント', api: '公開 API', path: '場所', owns: '持っているテーブル',
    explained: (a, b) => `説明 ${a} / ${b} ファイル`, staleCount: (n) => `古い説明 ${n}`, open: '開く',
    stale: 'この説明を書いた後にコードが変わりました。古いかもしれません。', gone: 'このファイルは移行先にありません。', noExplanation: 'まだ説明がありません。',
    qa: '保存した Q&A', qaStale: '保存した後にコードが変わりました', handler: '処理', capability: '機能', screen: '画面', method: 'メソッド',
    noGuide: 'コードガイドはまだありません（guide.mjs init で始めます）。', noModules: '移行先の設計（architecture.md）にモジュールがありません。',
    searchHint: 'モジュール・ファイル・URL で絞り込む',
    diagramArch: (n) => `モジュール ${n} 個と、その依存の図`, diagramData: 'モジュールとテーブルの図',
    note: 'この画面は説明です。正は openspec/spec-relay/guide/ の Markdown と、移行先のコードです。承認や gate には使いません。',
  },
  en: {
    kind: 'Code guide', title: 'Code guide', moduleKind: 'Code guide: module', toIndex: '← Code guide',
    stack: 'Stack', runtime: 'Runtime and frameworks', commands: 'Commands', buildFiles: 'Build files',
    architecture: 'Architecture', data: 'Data owners', modules: 'Modules', routes: 'Pages and URLs', features: 'By feature', files: 'Files',
    overview: 'Overview', dependsOn: 'Depends on', events: 'Events published', api: 'Public API', path: 'Path', owns: 'Tables owned',
    explained: (a, b) => `${a} of ${b} files explained`, staleCount: (n) => `${n} stale`, open: 'Open',
    stale: 'The code changed after this was written. It may be out of date.', gone: 'This file is not in the target.', noExplanation: 'No explanation yet.',
    qa: 'Saved Q&A', qaStale: 'The code changed after this was saved', handler: 'Handler', capability: 'Capability', screen: 'Screen', method: 'Method',
    noGuide: 'No code guide yet (start it with guide.mjs init).', noModules: 'The target design (architecture.md) names no modules.',
    searchHint: 'Filter by module, file or URL',
    diagramArch: (n) => `${n} modules and what they depend on`, diagramData: 'Modules and the tables they own',
    note: 'This page explains. The Markdown under openspec/spec-relay/guide/ and the target code are the source of truth. No approval or gate uses it.',
  },
};
export const guideWords = (lang) => WORDS[lang === 'ja' ? 'ja' : 'en'];
export const guidePage = (key) => (key ? `guide-${key}` : 'guide');
// The same anchor however the path's case is written where case does not count (Windows, macOS).
export const fileAnchor = (file) => `f-${fileHash(Buffer.from(fold(rel(file)))).slice(0, 10)}`;

// The guide page for a module (its name or key), a file under the target root, or a page or URL of routes.md.
export function locate(root, wanted) {
  const name = String(wanted ?? '').trim();
  const mods = modules(root);
  if (!name) return { page: guidePage(), anchor: null };
  const mod = mods.find((m) => m.key === moduleKey(name));
  if (mod && !/[/\\.]/.test(name)) return { page: guidePage(mod.key), anchor: null };
  const byFile = (file) => {
    const f = rel(file);
    for (const m of mods) {
      const g = parseCodeGuide(read(root, `${CODE}/${m.key}.md`));
      if (g.files.some((b) => fold(b.file) === fold(f))) return { page: guidePage(m.key), anchor: fileAnchor(g.files.find((b) => fold(b.file) === fold(f)).file) };
    }
    // A file not explained yet: only one that is there, under a module's path.
    const there = (targetFiles(root) ?? []).find((x) => fold(x) === fold(f));
    const m = there && mods.find((x) => x.path && fold(there).startsWith(`${fold(x.path)}/`));
    return m ? { page: guidePage(m.key), anchor: fileAnchor(there) } : null;
  };
  const route = parseRoutes(read(root, ROUTES)).find((r) => r.url === name || `${r.method} ${r.url}` === name);
  if (route) return (route.refs[0] && byFile(route.refs[0].file)) ?? { page: guidePage(), anchor: null };
  return byFile(name);
}

// Boxes in rows, arrows for "Depends on": drawn here so every model draws the same picture.
function architectureSvg(mods, W) {
  if (!mods.length) return '';
  const cols = Math.min(4, Math.ceil(Math.sqrt(mods.length)));
  const bw = 168, bh = 52, gx = 64, gy = 56, pad = 16;
  const at = new Map(mods.map((m, i) => [m.key, { x: pad + (i % cols) * (bw + gx), y: pad + Math.floor(i / cols) * (bh + gy) }]));
  const width = pad * 2 + cols * bw + (cols - 1) * gx;
  const height = pad * 2 + Math.ceil(mods.length / cols) * (bh + gy) - gy;
  const edge = (a, b) => {
    const p = at.get(a), q = at.get(b);
    const cx1 = p.x + bw / 2, cy1 = p.y + bh / 2, cx2 = q.x + bw / 2, cy2 = q.y + bh / 2;
    const dx = cx2 - cx1, dy = cy2 - cy1;
    // From the edge of one box to the edge of the other.
    const clip = (sx, sy) => { const t = Math.min(Math.abs((bw / 2) / (sx || 1e-9)), Math.abs((bh / 2) / (sy || 1e-9))); return [sx * t, sy * t]; };
    const [ox, oy] = clip(dx, dy);
    return `<line x1="${(cx1 + ox).toFixed(1)}" y1="${(cy1 + oy).toFixed(1)}" x2="${(cx2 - ox).toFixed(1)}" y2="${(cy2 - oy).toFixed(1)}" class="gd-dep" marker-end="url(#arrow)"/>`;
  };
  const lines = mods.flatMap((m) => m.dependsOn.filter((d) => at.has(d) && d !== m.key).map((d) => edge(m.key, d)));
  const short = (s, n) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
  const boxes = mods.map((m) => { const p = at.get(m.key); return `<g><title>${escapeHtml(m.context)}${m.path ? ` — ${escapeHtml(m.path)}` : ''}</title><rect x="${p.x}" y="${p.y}" width="${bw}" height="${bh}" class="gd-box"/><text x="${p.x + bw / 2}" y="${p.y + 22}" class="gd-name">${escapeHtml(short(m.context, 20))}</text><text x="${p.x + bw / 2}" y="${p.y + 40}" class="gd-sub">${escapeHtml(short(m.path, 26))}</text></g>`; });
  return `<figure class="diagram"><svg viewBox="0 0 ${width} ${height}" style="max-width:${width}px;min-width:${Math.min(width, 560)}px" role="img" aria-label="${escapeHtml(W.diagramArch(mods.length))}" preserveAspectRatio="xMidYMin meet"><defs><marker id="arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0,0 L10,5 L0,10 z" class="gd-head"/></marker></defs>${lines.join('')}${boxes.join('')}</svg></figure>`;
}

function dataSvg(mods, owned, W) {
  const used = mods.filter((m) => owned.some((o) => o.owner === m.key));
  if (!used.length) return '';
  const tables = [...new Set(owned.filter((o) => used.some((m) => m.key === o.owner)).map((o) => o.table))];
  const rowH = 34, bw = 168, tw = 200, gap = 140, pad = 16;
  const height = pad * 2 + Math.max(used.length, tables.length) * rowH;
  const my = (i) => pad + i * rowH + (rowH - 26) / 2;
  const tx = pad + bw + gap;
  const short = (s, n) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
  const lines = owned.filter((o) => used.some((m) => m.key === o.owner)).map((o) => {
    const i = used.findIndex((m) => m.key === o.owner), j = tables.indexOf(o.table);
    return `<line x1="${pad + bw}" y1="${my(i) + 13}" x2="${tx}" y2="${my(j) + 13}" class="gd-dep"/>`;
  });
  const left = used.map((m, i) => `<g><title>${escapeHtml(m.context)}</title><rect x="${pad}" y="${my(i)}" width="${bw}" height="26" class="gd-box"/><text x="${pad + bw / 2}" y="${my(i) + 17}" class="gd-name">${escapeHtml(short(m.context, 20))}</text></g>`);
  const right = tables.map((t, j) => `<g><title>${escapeHtml(t)}</title><rect x="${tx}" y="${my(j)}" width="${tw}" height="26" class="gd-box gd-table"/><text x="${tx + tw / 2}" y="${my(j) + 17}" class="gd-sub">${escapeHtml(short(t, 28))}</text></g>`);
  return `<figure class="diagram"><svg viewBox="0 0 ${tx + tw + pad} ${height}" style="max-width:${tx + tw + pad}px;min-width:${Math.min(tx + tw + pad, 560)}px" role="img" aria-label="${escapeHtml(W.diagramData)}" preserveAspectRatio="xMidYMin meet">${lines.join('')}${left.join('')}${right.join('')}</svg></figure>`;
}

export const GUIDE_CSS = `
.diagram{margin:8px 0 16px;overflow-x:auto}
.diagram svg{display:block;width:100%;height:auto;font-family:var(--ui)}
.diagram .gd-box{fill:var(--paper);stroke:var(--ink);stroke-width:1.5}
.diagram .gd-table{stroke-dasharray:4 3}
.diagram .gd-name{font:700 13px var(--ui);fill:var(--ink);text-anchor:middle}
.diagram .gd-sub{font:12px var(--mono);fill:var(--ink2);text-anchor:middle}
.diagram .gd-dep{stroke:var(--ink2);stroke-width:1.2}
.diagram .gd-head{fill:var(--ink2)}
.guide-facts{display:grid;grid-template-columns:max-content 1fr;gap:2px 14px;margin:6px 0 0;font-size:14px}
.guide-facts dt{color:var(--ink2)}
.guide-facts dd{margin:0;overflow-wrap:anywhere}
.qa-saved{margin:12px 0 0;padding:8px 12px;border-left:3px solid var(--hair)}
.qa-saved .q{font-weight:700;margin:0 0 4px}
`;

const table = (head, rows) => `<div class="table"><table><thead><tr>${head.map((h) => `<th>${escapeHtml(h)}</th>`).join('')}</tr></thead><tbody>${rows.join('')}</tbody></table></div>`;

// The page parts (brief, groups, docs) of the guide's first page, or of one module's page.
// `href(page, anchor)` makes links between the guide's pages and to the spec pages.
export function guideView({ root, module, L, lang, href = (name, anchor) => `${encodeURIComponent(name)}.html${anchor ? `#${anchor}` : ''}` }) {
  const W = guideWords(lang);
  const mods = modules(root);
  if (!mods.length) return { title: W.title, kind: W.kind, brief: `<p class="caution">${escapeHtml(W.noModules)}</p>`, groups: [], docs: [] };
  const files = targetFiles(root) ?? [];
  const routes = parseRoutes(read(root, ROUTES));
  const guides = new Map(mods.map((m) => [m.key, parseCodeGuide(read(root, `${CODE}/${m.key}.md`))]));
  // Which module explains a file, for links from routes and features.
  const where = (file) => { for (const [key, g] of guides) if (g.files.some((b) => fold(b.file) === fold(rel(file)))) return key; return mods.find((m) => m.path && fold(rel(file)).startsWith(`${fold(m.path)}/`))?.key ?? null; };
  const fileLink = (file, text = file) => { const key = where(file); return key ? `<a href="${escapeHtml(href(guidePage(key), fileAnchor(rel(file))))}" class="mono">${escapeHtml(text)}</a>` : `<span class="mono">${escapeHtml(text)}</span>`; };

  if (module) {
    const m = mods.find((x) => x.key === moduleKey(module));
    if (!m) return null;
    const guide = guides.get(m.key);
    const qa = parseQa(read(root, `${QA}/${m.key}.md`));
    const own = moduleFiles(root, m, files).filter(isCode);
    const listed = [...guide.files.map((b) => b.file), ...own.filter((f) => !guide.files.some((b) => fold(b.file) === fold(f)))];
    const items = listed.map((file, k) => {
      const block = guide.files.find((b) => fold(b.file) === fold(file));
      const hash = hashOf(root, file);
      const notes = [];
      if (!block) notes.push(W.noExplanation);
      else if (!hash) notes.push(W.gone);
      else if (block.hash !== hash) notes.push(W.stale);
      const saved = qa.filter((q) => fold(q.file) === fold(file));
      const qaHtml = saved.length ? `<p class="label">${escapeHtml(W.qa)}</p>${saved.map((q) => `<div class="qa-saved"><p class="q">${inline(q.question)}</p>${q.hash && q.hash !== hash ? `<p class="caution">${escapeHtml(W.qaStale)} (${escapeHtml(q.saved)})</p>` : ''}<div class="doc">${markdown(q.answer, { headingOffset: 3 })}</div></div>`).join('')}` : '';
      const html = block?.body || qaHtml ? `<div class="q-body">${block?.body ? `<div class="doc">${markdown(block.body, { headingOffset: 3 })}</div>` : ''}${qaHtml}</div>` : '';
      return readItem(`F${k + 1}`, fileAnchor(file), file, 'file', { tag: '', notes: [], html }, notes, `<span class="mono">${escapeHtml(file)}</span>`);
    });
    const facts = `<dl class="guide-facts"><dt>${escapeHtml(W.path)}</dt><dd class="mono">${escapeHtml(m.path || '—')}</dd>${m.api ? `<dt>${escapeHtml(W.api)}</dt><dd>${inline(m.api)}</dd>` : ''}${m.dependsOn.length ? `<dt>${escapeHtml(W.dependsOn)}</dt><dd>${m.dependsOn.map((d) => (mods.some((x) => x.key === d) ? `<a href="${escapeHtml(href(guidePage(d)))}">${escapeHtml(mods.find((x) => x.key === d).context)}</a>` : escapeHtml(d))).join('、')}</dd>` : ''}${m.events.length ? `<dt>${escapeHtml(W.events)}</dt><dd>${m.events.map(escapeHtml).join('、')}</dd>` : ''}<dt>${escapeHtml(W.files)}</dt><dd>${escapeHtml(W.explained(own.filter((f) => guide.files.some((b) => fold(b.file) === fold(f))).length, own.length))}</dd></dl>`;
    const brief = `<header class="brief">${guide.overview ? `<div class="purpose"><span class="label">${escapeHtml(W.overview)}</span>${markdown(guide.overview)}</div>` : ''}${facts}</header>`;
    const groups = items.length ? [{ id: 'g1', title: W.files, items }] : [];
    return { title: m.context, kind: W.moduleKind, brief, groups, docs: [], module: m.key, files: guide.files.map((b) => b.file) };
  }

  const facts = stackFacts(root);
  const stackText = read(root, STACK);
  const stackHtml = stackText !== null
    ? `<div class="doc">${markdown(stripComments(stackText).replace(/^#\s+.*$/m, ''), { headingOffset: 1 })}</div>`
    : `<div class="doc">${facts.runtime.length ? `<p class="label">${escapeHtml(W.runtime)}</p><ul>${facts.runtime.map((r) => `<li>${inline(r)}</li>`).join('')}</ul>` : ''}${facts.commands.length ? `<p class="label">${escapeHtml(W.commands)}</p>${table([W.commands, ''], facts.commands.map((c) => `<tr><td>${escapeHtml(c.purpose)}</td><td class="mono">${escapeHtml(c.command)}</td></tr>`))}` : ''}${facts.buildFiles.length ? `<p class="label">${escapeHtml(W.buildFiles)}</p><ul>${facts.buildFiles.map((f) => `<li class="mono">${escapeHtml(f)}</li>`).join('')}</ul>` : ''}</div>`;
  const owned = dataOwnership(root);
  const docs = [
    { id: 'stack', title: W.stack, html: stackHtml },
    { id: 'architecture', title: W.architecture, html: `${architectureSvg(mods, W)}${table([W.modules, W.path, W.dependsOn, W.events], mods.map((m) => `<tr><td><a href="${escapeHtml(href(guidePage(m.key)))}">${escapeHtml(m.context)}</a></td><td class="mono">${escapeHtml(m.path)}</td><td>${escapeHtml(m.dependsOn.join(', ') || '—')}</td><td>${escapeHtml(m.events.join(', ') || '—')}</td></tr>`))}` },
    ...(owned.length ? [{ id: 'data', title: W.data, html: `${dataSvg(mods, owned, W)}${table([W.modules, W.owns], mods.filter((m) => owned.some((o) => o.owner === m.key)).map((m) => `<tr><td>${escapeHtml(m.context)}</td><td class="mono">${owned.filter((o) => o.owner === m.key).map((o) => escapeHtml(o.table)).join('<br>')}</td></tr>`))}` }] : []),
  ];
  let n = 0;
  const moduleItems = mods.map((m) => {
    const g = guides.get(m.key);
    const own = moduleFiles(root, m, files).filter(isCode);
    const done = own.filter((f) => g.files.some((b) => fold(b.file) === fold(f))).length;
    const stale = g.files.filter((b) => { const h = hashOf(root, b.file); return h && b.hash !== h; }).length;
    const first = g.overview.split(/\n\s*\n/)[0] ?? '';
    const html = `<div class="q-body">${first ? `<div class="doc">${markdown(first)}</div>` : ''}<p class="tests"><span class="label">${escapeHtml(W.files)}</span><span>${escapeHtml(W.explained(done, own.length))}${stale ? ` · <span class="caution">${escapeHtml(W.staleCount(stale))}</span>` : ''}</span></p></div>`;
    n += 1;
    return readItem(`M${n}`, `m-${m.key}`, m.context, 'module', { tag: '', notes: [], html }, [], `<a href="${escapeHtml(href(guidePage(m.key)))}">${escapeHtml(m.context)}</a>`);
  });
  const routeItems = routes.map((r, k) => {
    const html = `<div class="q-body"><dl class="guide-facts">${r.method ? `<dt>${escapeHtml(W.method)}</dt><dd>${escapeHtml(r.method)}</dd>` : ''}<dt>${escapeHtml(W.handler)}</dt><dd>${r.refs.length ? r.refs.map((ref) => fileLink(ref.file, `${ref.file}${ref.symbol ? `:${ref.symbol}` : ''}${ref.from ? `:${ref.from}` : ''}`)).join('<br>') : escapeHtml(plain(r.handler) || '—')}</dd>${r.capability ? `<dt>${escapeHtml(W.capability)}</dt><dd class="mono">${escapeHtml(r.capability)}</dd>` : ''}${r.screen ? `<dt>${escapeHtml(W.screen)}</dt><dd>${escapeHtml(r.screen)}</dd>` : ''}</dl></div>`;
    return readItem(`U${k + 1}`, `u${k + 1}`, r.url, 'route', { tag: '', notes: [], html }, [], `<span class="mono">${escapeHtml(r.url)}</span>`);
  });
  const caps = capabilities(root);
  const featureItems = caps.map((capability, k) => {
    const context = moduleKey(capability.split('/')[0]);
    const m = mods.find((x) => x.key === context);
    const urls = routes.filter((r) => r.capability === capability);
    const html = `<div class="q-body"><dl class="guide-facts">${m ? `<dt>${escapeHtml(W.modules)}</dt><dd><a href="${escapeHtml(href(guidePage(m.key)))}">${escapeHtml(m.context)}</a></dd>` : ''}${urls.length ? `<dt>${escapeHtml(W.routes)}</dt><dd>${urls.map((r) => `<span class="mono">${escapeHtml(`${r.method ? `${r.method} ` : ''}${r.url}`)}</span>`).join('<br>')}</dd>` : ''}</dl></div>`;
    return readItem(`C${k + 1}`, `c${k + 1}`, capability, 'cap', { tag: '', notes: [], html }, [], `<a href="${escapeHtml(href(`spec-${capability.split('/').join('-')}`))}">${escapeHtml(capability)}</a>`);
  });
  const groups = [
    { title: W.modules, items: moduleItems },
    { title: W.routes, items: routeItems },
    { title: W.features, items: featureItems },
  ].filter((g) => g.items.length).map((g, i) => ({ ...g, id: `g${i + 1}` }));
  const brief = fs.existsSync(path.join(root, GUIDE)) ? '' : `<p class="caution">${escapeHtml(W.noGuide)}</p>`;
  return { title: W.title, kind: W.kind, brief, groups, docs };
}

// ---------------------------------------------------------------- CLI

export function main(argv) {
  const [command, ...rest] = argv;
  const opts = { root: process.cwd() };
  const files = [];
  for (let i = 0; i < rest.length; i += 2) {
    if (rest[i] === '--file' && rest[i + 1] !== undefined) { files.push(rest[i + 1]); continue; }
    const key = { '--root': 'root', '--module': 'module' }[rest[i]];
    if (!key || rest[i + 1] === undefined) return usage();
    opts[key] = rest[i + 1];
  }
  const root = path.resolve(opts.root);
  let result;
  if (command === 'init') result = init(root);
  else if (command === 'stamp') result = stamp(root, { module: opts.module, files: files.includes('all') ? 'all' : files });
  else if (command === 'check') result = check(root);
  else return usage();
  // ASCII with \uXXXX escapes, so a console code page (CP932 on Japanese Windows) cannot garble it.
  console.log(JSON.stringify(result, null, 2).replace(/[\u007f-\uffff]/g, (ch) => `\\u${ch.charCodeAt(0).toString(16).padStart(4, '0')}`));
  return result.ok ? 0 : 1;
}

function usage() {
  console.error('Usage: node guide.mjs init|stamp|check [--module NAME] [--file PATH|all]... [--root DIR]');
  return 2;
}

function invokedDirectly() {
  if (!process.argv[1]) return false;
  try { return fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url)); } catch { return false; }
}

if (invokedDirectly()) process.exitCode = main(process.argv.slice(2));
