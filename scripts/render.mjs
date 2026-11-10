#!/usr/bin/env node
// Turns spec-relay's Markdown artifacts into one self-contained HTML page that a
// person reads during a review. The Markdown stays the source of truth: the page
// is a view, regenerated whenever the Markdown changes, and never edited.
//
//   node render.mjs --change <name>  [--root DIR] [--out FILE] [--lang ja|en]
//   node render.mjs --file <path.md> [--root DIR] [--out FILE] [--lang ja|en]
//
// The design lives in this file, not in a model's answer, so every model and
// every host produces the same page. No external packages, no network: the page
// opens offline, and nothing in the Markdown can run script in it (all text is
// escaped and only http(s) and relative links are kept).
//
// The page is a ledger for checking and ticking: one ruled row per review item of
// review.md (any `<Letter><n>` id), the claim next to its evidence, and vermilion
// only where review.md has a tick, a decision or a reviewer's name.
//
// Prints { ok, out } (or { ok: false, problems }) as JSON. Exit 0 / 1 / 2 like gate.mjs.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkboxes, questionIds, tableRows, changeSchema, archivedChange } from './gate.mjs';

// ---------------------------------------------------------------- labels

const LABELS = {
  ja: {
    kinds: { 'spec-relay-extract': '抽出レビュー', 'spec-relay-survey': '調査レビュー', 'spec-relay-target': '移行先設計レビュー', 'spec-relay-amend': '修正レビュー', 'spec-relay-port': '移植' },
    groups: { requirements: '要件', screens: '画面', questions: '質問', coverage: '網羅性', contexts: 'コンテキスト', map: 'マップ', architecture: 'アーキテクチャ', conventions: '規約', verification: '検証', impact: '影響' },
    qkinds: { 'suspected bugs': 'バグの疑い', ambiguities: 'あいまいな点', assumptions: '仮定', 'not migrated': '移行しない' },
    steps: { GIVEN: '前提', WHEN: '操作', THEN: '結果', AND: 'かつ', BUT: 'ただし' },
    deltas: { added: '＋ 追加', removed: '－ 削除', modified: '＊ 変更', renamed: '＊ 名前変更' },
    document: '文書', requirements: '要件', screens: '画面', questions: '質問', contexts: 'コンテキスト', other: 'その他',
    reviewer: 'レビュー担当', notNamed: '未記入', scope: '対象', purpose: '目的', appendix: '付録', toc: '目次', skip: '本文へ移動', railLabel: '目次と進み具合',
    confirmed: '確認済み', open: '未確認', sealDone: '済', sealOpen: '未',
    remain: (n) => `<b>${n}</b>件が未確認`, allDone: '<b>0</b>すべて確認済み', remainShort: '件が未確認',
    of: (all, done) => `${all} 件中 ${done} 件を確認済み`, left: '残り', sheet: '項目ごとの状態',
    legendDone: 'review.md でチェック済み', legendOpen: '未確認',
    firstOpen: (id) => `最初の未確認 ${id} へ ↓`, show: '表示', all: 'すべて', onlyOpen: '未確認のみ', allClear: 'この区分に未確認の項目はありません。',
    howto: ['項目を読む', '根拠と照らし合わせる', '正しければ review.md の行を <code>[x]</code> にして作り直す'],
    scenario: 'シナリオ', evidence: '根拠（元コード）', source: '元コード', tests: '既存のテスト', crosscheck: '照合（AI の再確認）', lines: '行',
    noTrace: 'trace.md に記載がありません', unreadable: 'ファイルを読めませんでした', truncated: '長いため先頭のみ表示', encoding: (e) => `文字コード ${e} を変換して表示`, dedent: (n) => `字下げを ${n} 文字詰めて表示`,
    decision: '判断', noDecision: (id) => `未記入 — review.md の ${id} の行に decision: を書きます`,
    noReviewRow: 'review.md に項目がありません', noReq: '同じ名前の要件が仕様にありません', noScreen: '同じ名前の画面が screens.md にありません', noContext: '同じ id のコンテキストが context-map.md にありません', noQuestion: 'questions.md に本文がありません',
    tickedNoDecision: 'チェック済みですが、判断が未記入です', decisionNoTick: '判断は書かれていますが、チェックされていません',
    was: '旧', now: '新', noBaseline: '現在の仕様（openspec/specs）に同じ名前の要件がありません',
    screenshot: 'スクリーンショット', openImage: '原寸で開く', noImage: '画像ファイルがありません',
    prevOpen: '前の未確認へ', nextOpen: '次の未確認 ↓',
    keysOn: '1 文字キーで移動する', keysList: 'キーの一覧', keys: [['j', 'k', '次／前の項目'], ['n', 'p', '次／前の未確認'], ['o', '', '元コードを開閉'], ['u', '', '未確認のみ表示']],
    generated: '生成', archived: 'archive 済み',
    note: 'この画面は表示用です。正は Markdown のファイルで、判断は review.md に記録します。ファイルを直したら作り直してください。',
  },
  en: {
    kinds: { 'spec-relay-extract': 'Extract review', 'spec-relay-survey': 'Survey review', 'spec-relay-target': 'Target design review', 'spec-relay-amend': 'Amend review', 'spec-relay-port': 'Port' },
    groups: {}, qkinds: {}, steps: {},
    deltas: { added: '+ Added', removed: '- Removed', modified: '* Modified', renamed: '* Renamed' },
    document: 'Document', requirements: 'Requirements', screens: 'Screens', questions: 'Questions', contexts: 'Contexts', other: 'Other',
    reviewer: 'Reviewer', notNamed: 'not named', scope: 'Scope', purpose: 'Purpose', appendix: 'Appendix', toc: 'Contents', skip: 'Skip to content', railLabel: 'Contents and progress',
    confirmed: 'Confirmed', open: 'Open', sealDone: '✓', sealOpen: '–',
    remain: (n) => `<b>${n}</b>open`, allDone: '<b>0</b>all confirmed', remainShort: 'open',
    of: (all, done) => `${done} of ${all} confirmed`, left: 'left', sheet: 'State of each item',
    legendDone: 'ticked in review.md', legendOpen: 'open',
    firstOpen: (id) => `First open item ${id} ↓`, show: 'Show', all: 'All', onlyOpen: 'Open only', allClear: 'No open items in this group.',
    howto: ['Read the item', 'Compare it with the evidence', 'If it is right, tick its line in review.md (<code>[x]</code>) and render again'],
    scenario: 'Scenario', evidence: 'Evidence (source code)', source: 'Source', tests: 'Existing tests', crosscheck: 'Crosscheck (second look by the AI)', lines: '',
    noTrace: 'No entry in trace.md', unreadable: 'Could not read the file', truncated: 'long; only the beginning is shown', encoding: (e) => `decoded from ${e}`, dedent: (n) => `indentation reduced by ${n} characters`,
    decision: 'Decision', noDecision: (id) => `blank — write decision: on the ${id} line of review.md`,
    noReviewRow: 'No item in review.md', noReq: 'No requirement of this name in the specs', noScreen: 'No screen of this name in screens.md', noContext: 'No context of this id in context-map.md', noQuestion: 'No text in questions.md',
    tickedNoDecision: 'Ticked, but the decision is blank', decisionNoTick: 'A decision is written, but the item is not ticked',
    was: 'Old', now: 'New', noBaseline: 'No requirement of this name in the current specs (openspec/specs)',
    screenshot: 'Screenshot', openImage: 'Open full size', noImage: 'Image file not found',
    prevOpen: 'Previous open item', nextOpen: 'Next open ↓',
    keysOn: 'Single-key shortcuts', keysList: 'Key list', keys: [['j', 'k', 'next / previous item'], ['n', 'p', 'next / previous open item'], ['o', '', 'fold or unfold the source'], ['u', '', 'open items only']],
    generated: 'Generated', archived: 'archived',
    note: 'This page is a view. The Markdown files are the source of truth and decisions go into review.md. Render again after changing them.',
  },
};

// ---------------------------------------------------------------- Markdown

export const escapeHtml = (s) => String(s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');

const safeHref = (href) => {
  const h = href.trim();
  if (/^https?:\/\//i.test(h)) return h;
  if (/^[a-z][a-z0-9+.-]*:/i.test(h) || h.startsWith('//')) return null; // javascript:, data:, file:, ...
  return h;
};

export function inline(text) {
  const codes = [];
  let s = String(text).replace(/`([^`]+)`/g, (_, code) => { codes.push(code); return `\u0000${codes.length - 1}\u0000`; });
  s = escapeHtml(s);
  s = s.replace(/!\[([^\]]*)\]\(([^)\s]+)\)/g, (all, alt, src) => {
    const url = safeHref(src.replace(/&amp;/g, '&'));
    return url === null || /^https?:/i.test(url) ? alt : `<img src="${escapeHtml(url)}" alt="${alt}" loading="lazy">`;
  });
  s = s.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (all, label, href) => {
    const url = safeHref(href.replace(/&amp;/g, '&'));
    return url === null ? label : `<a href="${escapeHtml(url)}">${label}</a>`;
  });
  s = s.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>').replace(/__([^_]+)__/g, '<strong>$1</strong>');
  s = s.replace(/(^|[^*\w])\*([^*\s][^*]*)\*/g, '$1<em>$2</em>');
  s = s.replace(/&lt;br\s*\/?&gt;/gi, '<br>');
  return s.replace(/\u0000(\d+)\u0000/g, (_, i) => `<code>${escapeHtml(codes[Number(i)])}</code>`);
}

const stripComments = (text) => text.replace(/<!--[\s\S]*?-->/g, '');
const LIST = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/;
const TASK = /^\[(.?)\]\s*(.*)$/;
const splitRow = (line) => line.trim().replace(/^\|/, '').replace(/\|$/, '').split(/(?<!\\)\|/).map((c) => c.trim().replace(/\\\|/g, '|'));

// Renders the Markdown subset the kit's templates use: headings, paragraphs,
// lists (nested, with task boxes), GFM tables, fenced code, quotes and rules.
export function markdown(text, { headingOffset = 0 } = {}) {
  const lines = stripComments(text.replace(/^﻿/, '')).split(/\r?\n/);
  const out = [];
  let i = 0;
  const isTableStart = (k) => /^\s*\|/.test(lines[k] ?? '') && /^\s*\|?\s*:?-{2,}/.test(lines[k + 1] ?? '');
  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim()) { i += 1; continue; }
    const fence = line.match(/^\s*(```|~~~)\s*([\w+-]*)/);
    if (fence) {
      const body = [];
      i += 1;
      while (i < lines.length && !lines[i].trim().startsWith(fence[1])) { body.push(lines[i]); i += 1; }
      i += 1;
      out.push(`<pre class="code"><code>${escapeHtml(body.join('\n'))}</code></pre>`);
      continue;
    }
    const heading = line.match(/^(#{1,6})\s+(.*?)\s*#*\s*$/);
    if (heading) {
      const level = Math.min(6, heading[1].length + headingOffset);
      out.push(`<h${level}>${inline(heading[2])}</h${level}>`);
      i += 1; continue;
    }
    if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) { out.push('<hr>'); i += 1; continue; }
    if (isTableStart(i)) {
      const head = splitRow(lines[i]);
      i += 2;
      const rows = [];
      while (i < lines.length && /^\s*\|/.test(lines[i])) { rows.push(splitRow(lines[i])); i += 1; }
      out.push(table(head, rows));
      continue;
    }
    if (/^\s*>/.test(line)) {
      const body = [];
      while (i < lines.length && /^\s*>/.test(lines[i])) { body.push(lines[i].replace(/^\s*>\s?/, '')); i += 1; }
      out.push(`<blockquote>${markdown(body.join('\n'))}</blockquote>`);
      continue;
    }
    if (LIST.test(line)) {
      const items = [];
      while (i < lines.length && (LIST.test(lines[i]) || (lines[i].trim() && /^\s{2,}\S/.test(lines[i]) && items.length))) {
        const m = lines[i].match(LIST);
        if (m) items.push({ indent: m[1].replace(/\t/g, '    ').length, ordered: /\d/.test(m[2]), text: m[3] });
        else items[items.length - 1].text += ` ${lines[i].trim()}`;
        i += 1;
      }
      out.push(list(items));
      continue;
    }
    const para = [];
    while (i < lines.length && lines[i].trim() && !LIST.test(lines[i]) && !/^(#{1,6})\s/.test(lines[i])
      && !/^\s*(```|~~~|>)/.test(lines[i]) && !isTableStart(i)) { para.push(lines[i].trim()); i += 1; }
    out.push(`<p>${inline(para.join(' '))}</p>`);
  }
  return out.join('\n');
}

function table(head, rows) {
  const th = head.map((c) => `<th>${inline(c)}</th>`).join('');
  const tr = rows.map((r) => `<tr>${head.map((_, k) => `<td>${inline(r[k] ?? '')}</td>`).join('')}</tr>`).join('\n');
  return `<div class="table"><table><thead><tr>${th}</tr></thead><tbody>${tr}</tbody></table></div>`;
}

function list(items) {
  let html = '';
  const stack = [];
  for (const item of items) {
    while (stack.length && item.indent < stack[stack.length - 1].indent) html += `</li></${stack.pop().tag}>`;
    const top = stack[stack.length - 1];
    if (!top || item.indent > top.indent) {
      const tag = item.ordered ? 'ol' : 'ul';
      stack.push({ indent: item.indent, tag });
      html += `<${tag}>`;
    } else html += '</li>';
    const task = item.text.match(TASK);
    if (task) {
      const done = task[1].trim().toLowerCase() === 'x';
      html += `<li class="task ${done ? 'done' : 'open'}"><span class="box" aria-label="${done ? 'done' : 'open'}">${done ? '✓' : ''}</span>${inline(task[2])}`;
    } else html += `<li>${inline(item.text)}`;
  }
  while (stack.length) html += `</li></${stack.pop().tag}>`;
  return html;
}

// ---------------------------------------------------------------- reading

function readText(file) {
  try { return fs.readFileSync(file, 'utf8').replace(/^﻿/, ''); } catch { return null; }
}

// Legacy C# and PHP code in Japan is often Shift_JIS; the view shows it anyway.
function decodeSource(buffer) {
  if (buffer.includes(0) && !(buffer[0] === 0xff || buffer[0] === 0xfe)) return null;
  for (const encoding of ['utf-8', 'utf-16le', 'shift_jis', 'euc-jp', 'windows-1252']) {
    if (encoding === 'utf-16le' && !(buffer[0] === 0xff && buffer[1] === 0xfe)) continue;
    try { return { text: new TextDecoder(encoding, { fatal: true }).decode(buffer).replace(/^﻿/, ''), encoding }; } catch { /* next */ }
  }
  return null;
}

function walk(dir) {
  let entries = [];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return []; }
  return entries.sort((a, b) => a.name.localeCompare(b.name))
    .flatMap((e) => (e.isDirectory() ? walk(path.join(dir, e.name)) : [path.join(dir, e.name)]));
}

const norm = (s) => s.replace(/<!--|-->/g, ' ').replace(/[*_`[\]()]/g, '').replace(/\s+/g, ' ').trim().toLowerCase();

const plainText = (s) => stripComments(String(s)).replace(/[*`]/g, '').replace(/\s+/g, ' ').trim();
const oneLine = (lines) => stripComments(lines.join('\n')).split(/\r?\n/).map((l) => l.trim()).filter(Boolean).join(' ');
// The wording as it reads, without emphasis and code marks, for comparing two versions.
const wording = (s) => s.replace(/\*\*|__|`/g, '');
const BLANK = /^(<.*>|tbd|todo|tba|n\/a|-|—|\.\.\.|…)?$/i;

// Requirements of a spec or a spec delta. `kind` is the delta section a
// requirement stands in: added, modified, removed, renamed, or '' in a baseline.
export function parseSpec(text) {
  const lines = stripComments(text).split(/\r?\n/);
  const purpose = [];
  const requirements = [];
  let section = null;
  let kind = '';
  let req = null;
  let scenario = null;
  for (const line of lines) {
    const r = line.match(/^###\s*Requirement:\s*(.+?)\s*$/i);
    const s = line.match(/^####\s*Scenario:\s*(.+?)\s*$/i);
    const h2 = line.match(/^##\s+(.*)$/);
    if (r) { req = { name: r[1], kind, body: [], scenarios: [] }; requirements.push(req); scenario = null; section = 'req'; }
    else if (s && req) { scenario = { name: s[1], body: [] }; req.scenarios.push(scenario); }
    else if (h2) {
      section = /purpose/i.test(h2[1]) ? 'purpose' : 'other';
      kind = h2[1].trim().match(/^(added|modified|removed|renamed)\b/i)?.[1].toLowerCase() ?? '';
      req = null; scenario = null;
    }
    else if (section === 'purpose') purpose.push(line);
    else if (scenario) scenario.body.push(line);
    else if (req) req.body.push(line);
  }
  return { purpose: purpose.join('\n'), requirements };
}

export function parseTrace(text) {
  const map = new Map();
  if (!text) return map;
  const lines = stripComments(text).split(/\r?\n/);
  for (let i = 0; i < lines.length; i += 1) {
    if (!/^\s*\|/.test(lines[i]) || !/^\s*\|?\s*:?-{2,}/.test(lines[i + 1] ?? '')) continue;
    for (i += 2; i < lines.length && /^\s*\|/.test(lines[i]); i += 1) {
      const [name, source = '', tests = ''] = splitRow(lines[i]);
      if (name) map.set(norm(name), { source, tests });
    }
  }
  return map;
}

// "src/a/Invoice.cs:Invoice.Total:10-42" -> { file, symbol, from, to }. Several
// references may share a cell, separated by <br>, ";" or ",".
export function parseRefs(cell) {
  const refs = [];
  for (const part of cell.replace(/`/g, '').split(/<br\s*\/?>|;|,(?=\s*[\w./-]+\.\w+:)/i)) {
    const m = part.trim().match(/^([\w.\/@~+-]+\.\w+)(?::([^:]+?))?(?::(\d+)(?:\s*-\s*(\d+))?)?\s*$/);
    if (m) refs.push({ file: m[1], symbol: m[2] ?? '', from: m[3] ? Number(m[3]) : null, to: m[4] ? Number(m[4]) : (m[3] ? Number(m[3]) : null) });
  }
  return refs;
}

// A path named in the Markdown, resolved inside the repository: never outside
// the root and never inside .git. Null when it is not allowed.
function insideRoot(root, file) {
  const abs = path.resolve(root, file);
  const rel = path.relative(path.resolve(root), abs);
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel) || rel.split(/[\\/]/)[0] === '.git') return null;
  return abs;
}

const MAX_LINES = 80;

// The whitespace every non-blank line starts with. Removing it lets deeply
// nested legacy code fit beside its requirement; line numbers stay the file's.
export function commonIndent(lines) {
  let indent = null;
  for (const line of lines) {
    if (!line.trim()) continue;
    const lead = line.match(/^[ \t]*/)[0];
    if (indent === null) indent = lead;
    else { let k = 0; while (k < indent.length && k < lead.length && indent[k] === lead[k]) k += 1; indent = indent.slice(0, k); }
    if (!indent) return 0;
  }
  return indent ? indent.length : 0;
}

function snippet(root, ref, L) {
  const range = ref.from ? (ref.to !== ref.from ? `${ref.from}–${ref.to}` : `${ref.from}`) : '';
  const summary = `<summary><span class="f">${escapeHtml(ref.file)}</span>${ref.symbol ? `<span class="sym">${escapeHtml(ref.symbol)}</span>` : ''}${range ? `<span class="ln-range">${range}${L.lines ? ` ${escapeHtml(L.lines)}` : ''}</span>` : ''}</summary>`;
  const fail = `<details class="src" open>${summary}<p class="src-note caution">${escapeHtml(L.unreadable)}: ${escapeHtml(ref.file)}</p></details>`;
  const file = insideRoot(root, ref.file);
  if (!file) return fail;
  let buffer;
  try { buffer = fs.readFileSync(file); } catch { return fail; }
  const decoded = decodeSource(buffer);
  if (!decoded) return fail;
  const all = decoded.text.split(/\r?\n/);
  const from = Math.max(1, ref.from ?? 1);
  const wanted = Math.max(from, Math.min(all.length, ref.to ?? all.length));
  const to = Math.min(wanted, from + MAX_LINES - 1);
  const shown = all.slice(from - 1, to);
  const cut = commonIndent(shown);
  const rows = shown.map((text, k) => `<span class="l"><span class="ln">${from + k}</span>${escapeHtml(text.slice(text.trim() ? cut : 0))}\n</span>`).join('');
  const note = [to < wanted ? L.truncated : '', decoded.encoding !== 'utf-8' ? L.encoding(decoded.encoding) : '', cut ? L.dedent(cut) : ''].filter(Boolean).join(' · ');
  return `<details class="src" open>${summary}<pre class="code numbered"><code>${rows}</code></pre>${note ? `<p class="src-note">${escapeHtml(note)}</p>` : ''}</details>`;
}

// ---------------------------------------------------------------- differences

const DIFF_CELLS = 1_000_000;

// Character-level difference by longest common subsequence: a list of
// [op, text] with op '=', '-' (only in a) or '+' (only in b). Null when the
// texts are too long for the table; the caller then shows whole sentences.
export function diffChars(a, b) {
  const A = [...a];
  const B = [...b];
  let head = 0;
  while (head < A.length && head < B.length && A[head] === B[head]) head += 1;
  let tail = 0;
  while (tail < A.length - head && tail < B.length - head && A[A.length - 1 - tail] === B[B.length - 1 - tail]) tail += 1;
  const x = A.slice(head, A.length - tail);
  const y = B.slice(head, B.length - tail);
  if (x.length * y.length > DIFF_CELLS) return null;
  const w = y.length + 1;
  const t = new Uint32Array((x.length + 1) * w);
  for (let i = 1; i <= x.length; i += 1) {
    for (let j = 1; j <= y.length; j += 1) {
      t[i * w + j] = x[i - 1] === y[j - 1] ? t[(i - 1) * w + j - 1] + 1 : Math.max(t[(i - 1) * w + j], t[i * w + j - 1]);
    }
  }
  const ops = [];
  let i = x.length;
  let j = y.length;
  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && x[i - 1] === y[j - 1]) { ops.push(['=', x[i - 1]]); i -= 1; j -= 1; }
    else if (j > 0 && (i === 0 || t[i * w + j - 1] >= t[(i - 1) * w + j])) { ops.push(['+', y[j - 1]]); j -= 1; }
    else { ops.push(['-', x[i - 1]]); i -= 1; }
  }
  ops.reverse();
  const out = [];
  const push = (op, text) => { if (!text) return; if (out.length && out[out.length - 1][0] === op) out[out.length - 1][1] += text; else out.push([op, text]); };
  push('=', A.slice(0, head).join(''));
  for (const [op, ch] of ops) push(op, ch);
  push('=', A.slice(A.length - tail).join(''));
  return out;
}

const diffSide = (ops, side) => ops.filter(([op]) => op === '=' || op === side)
  .map(([op, text]) => (op === '=' ? escapeHtml(text) : side === '-' ? `<del>${escapeHtml(text)}</del>` : `<ins>${escapeHtml(text)}</ins>`)).join('');

// Old and new wording on two lines, the changed characters marked.
function wasNow(oldText, newText, L) {
  const ops = diffChars(oldText, newText);
  const was = ops ? diffSide(ops, '-') : `<del>${escapeHtml(oldText)}</del>`;
  const now = ops ? diffSide(ops, '+') : `<ins>${escapeHtml(newText)}</ins>`;
  return `<p class="was"><span class="label">${escapeHtml(L.was)}</span><span>${was}</span></p><p class="now"><span class="label">${escapeHtml(L.now)}</span><span>${now}</span></p>`;
}

// ---------------------------------------------------------------- review items

// review.md as groups (its `##` headings) of items (its check boxes). An item
// with a `<Letter><n>` id carries it; `decision:` splits off a recorded decision.
export function parseReview(text) {
  const groups = [];
  let group = null;
  let fenced = false;
  for (const line of (text ?? '').split(/\r?\n/)) {
    if (/^\s*(```|~~~)/.test(line)) { fenced = !fenced; continue; }
    if (fenced) continue;
    const h = line.match(/^##\s+(.*?)\s*#*\s*$/);
    if (h) { group = { title: plainText(h[1]).replace(/^\d+[.)]\s*/, ''), items: [] }; groups.push(group); continue; }
    const [box] = checkboxes(line);
    if (!box) continue;
    if (!group) { group = { title: '', items: [] }; groups.push(group); }
    const m = box.plain.match(/^([A-Za-z])(\d+)\b\s*[.:)-]?\s*(.*)$/);
    if (!m) { group.items.push({ id: '', letter: '', done: box.done, title: stripComments(box.body).trim(), decision: null, key: norm(box.plain), plain: box.plain }); continue; }
    const rest = stripComments(box.body).replace(/^\W*[A-Za-z]\d+[\s*_\]`).:-]*/, '');
    const [title, decision] = rest.split(/\bdecision:/i);
    group.items.push({
      id: `${m[1].toUpperCase()}${Number(m[2])}`, letter: m[1].toUpperCase(), done: box.done,
      title: title.trim().replace(/:$/, '').trim(), decision: decision === undefined ? null : decision.trim(),
      key: norm(m[3].split(/\bdecision:/i)[0]).replace(/:$/, '').trim(), plain: box.plain,
    });
  }
  return groups;
}

// "### <Word>: <name>" blocks of a file, each with the lines up to the next
// heading of the same or a higher level.
function blocks(text, word) {
  const out = [];
  let block = null;
  let fenced = false;
  for (const line of stripComments(text ?? '').split(/\r?\n/)) {
    if (/^\s*(```|~~~)/.test(line)) fenced = !fenced;
    const start = fenced ? null : line.match(new RegExp(`^###\\s*${word}:\\s*(.+?)\\s*$`, 'i'));
    if (start) { block = { name: start[1], body: [] }; out.push(block); }
    else if (!fenced && /^#{1,3}\s/.test(line)) block = null;
    else if (block) block.body.push(line);
  }
  return out;
}

// Each question's text and the section it stands under. The id is found the way
// the gate finds it (any Q<n> on the line), so "- Q1. x", "1. **Q2** x",
// "- [Q3] x" and a table row all work; the first line that names an id wins.
export function parseQuestions(text) {
  const map = new Map();
  let kind = '';
  let fenced = false;
  for (const line of stripComments(text ?? '').split(/\r?\n/)) {
    if (/^\s*(```|~~~)/.test(line)) { fenced = !fenced; continue; }
    if (fenced) continue;
    const h = line.match(/^#{1,6}\s+(.*?)\s*#*\s*$/);
    if (h) { kind = /^#\s/.test(line) ? '' : plainText(h[1]); continue; }
    const m = line.match(/\bQ(\d+)\b/i);
    if (!m) continue;
    const id = `Q${Number(m[1])}`;
    if (map.has(id)) continue;
    let body;
    if (/^\s*\|/.test(line)) body = splitRow(line).filter((cell) => !/^\W*Q\d+\W*$/i.test(cell) && cell).join(' — ');
    else body = line.replace(/^\s*(?:[-*+]|\d+[.)])\s+/, '').replace(/^\W*Q\d+[\s*_\]`).:-]*/i, '');
    map.set(id, { kind, text: body.trim() });
  }
  return map;
}

// "**GIVEN** x" list lines of a scenario as steps, or null when a line is
// anything else (the scenario is then shown as plain Markdown).
function parseSteps(body) {
  const steps = [];
  for (const line of stripComments(body.join('\n')).split(/\r?\n/)) {
    if (!line.trim()) continue;
    const m = line.match(/^\s*[-*+]\s+\*\*(GIVEN|WHEN|THEN|AND|BUT)\*\*\s*:?\s*(.*)$/i);
    if (m) steps.push({ word: m[1].toUpperCase(), text: m[2].trim() });
    else if (steps.length && /^\s{2,}\S/.test(line) && !LIST.test(line)) steps[steps.length - 1].text += ` ${line.trim()}`;
    else return null;
  }
  return steps.length ? steps : null;
}

function stepsHtml(body, L, oldBody) {
  const steps = parseSteps(body);
  if (!steps) return markdown(body.join('\n'));
  const old = oldBody ? parseSteps(oldBody) : null;
  const aligned = old && old.length === steps.length && old.every((s, k) => s.word === steps[k].word);
  let phase = '';
  return `<dl class="gwt">${steps.map((s, k) => {
    if (s.word !== 'AND' && s.word !== 'BUT') phase = s.word;
    const ja = L.steps[s.word];
    let text = inline(s.text);
    if (aligned && old[k].text !== s.text) {
      const [a, b] = [wording(old[k].text), wording(s.text)];
      const ops = diffChars(a, b);
      text = ops ? ops.map(([op, t]) => (op === '=' ? escapeHtml(t) : op === '-' ? `<del>${escapeHtml(t)}</del>` : `<ins>${escapeHtml(t)}</ins>`)).join('') : `<del>${escapeHtml(a)}</del> <ins>${escapeHtml(b)}</ins>`;
    }
    return `<div class="${(phase || s.word).toLowerCase()}"><dt>${ja ? `${escapeHtml(ja)}<small>${s.word}</small>` : s.word}</dt><dd>${text}</dd></div>`;
  }).join('')}</dl>`;
}

// ---------------------------------------------------------------- views

function findChange(root, name) {
  const active = path.join(root, 'openspec/changes', name);
  if (fs.existsSync(active)) return { dir: active, archived: false };
  const newest = archivedChange(root, name);
  if (newest) return { dir: newest, archived: true };
  const archive = path.join(root, 'openspec/changes/archive');
  let found = null;
  try {
    for (const entry of fs.readdirSync(archive).sort()) {
      if (entry === name || entry.endsWith(`-${name}`)) found = path.join(archive, entry);
    }
  } catch { /* none */ }
  return found ? { dir: found, archived: true } : null;
}

const seal = (done, L) => `<span class="seal ${done ? 'is-done' : 'is-open'}"><b aria-hidden="true">${escapeHtml(done ? L.sealDone : L.sealOpen)}</b><span>${escapeHtml(done ? L.confirmed : L.open)}</span></span>`;
const cautionsHtml = (list) => list.map((c) => `<p class="caution">${escapeHtml(c)}</p>`).join('');
const deltaTag = (kind, L) => (L.deltas[kind] ? `<span class="delta ${kind}">${escapeHtml(L.deltas[kind])}</span>` : '');
const withoutId = (s) => norm(s).replace(/^[a-z]\d+\s*[.:)-]?\s*/, '');

function crossLine(row, L) {
  if (!row) return '';
  const ok = /^confirmed\b/i.test(row.verdict);
  return `<p class="tests"><span class="label">${escapeHtml(L.crosscheck)}</span><span><span${ok ? '' : ' class="caution"'}>${inline(row.verdict || '—')}</span>${row.evidence ? ` — ${inline(row.evidence)}` : ''}</span></p>`;
}

function scenariosHtml(req, old, c) {
  const { L } = c;
  const marked = req.kind === 'modified' && old;
  const same = (a, b) => oneLine(a.body) === oneLine(b.body);
  const out = req.scenarios.map((s, k) => {
    const before = marked ? old.scenarios.find((o) => norm(o.name) === norm(s.name)) : null;
    const kind = !marked ? '' : !before ? 'added' : same(before, s) ? '' : 'modified';
    const lines = kind === 'modified' && parseSteps(s.body) && parseSteps(before.body)
      && parseSteps(s.body).length === parseSteps(before.body).length && parseSteps(s.body).every((x, n) => x.word === parseSteps(before.body)[n].word);
    const oldBlock = kind === 'modified' && !lines ? `<div class="gone"><span class="label">${escapeHtml(L.was)}</span>${stepsHtml(before.body, L)}</div>` : '';
    return `<section class="scenario"><h4><span class="label">${escapeHtml(L.scenario)} ${k + 1}</span>${deltaTag(kind, L)}<span>${inline(s.name)}</span></h4>${oldBlock}${stepsHtml(s.body, L, lines ? before.body : null)}</section>`;
  });
  if (marked) {
    for (const o of old.scenarios.filter((x) => !req.scenarios.some((s) => norm(s.name) === norm(x.name)))) {
      out.push(`<section class="scenario gone"><h4><span class="label">${escapeHtml(L.scenario)}</span>${deltaTag('removed', L)}<span>${inline(o.name)}</span></h4>${stepsHtml(o.body, L)}</section>`);
    }
  }
  return out.join('\n');
}

function requirementBody(it, c) {
  const { L, root } = c;
  const req = it.data;
  const old = c.amend ? c.baseline(req) : null;
  const notes = [];
  let claim;
  if (req.kind === 'removed') {
    if (!old) notes.push(L.noBaseline);
    claim = `${old ? `<div class="statement gone">${markdown(old.body.join('\n'))}</div>${old.scenarios.map((s, k) => `<section class="scenario gone"><h4><span class="label">${escapeHtml(L.scenario)} ${k + 1}</span><span>${inline(s.name)}</span></h4>${stepsHtml(s.body, L)}</section>`).join('\n')}` : ''}
${oneLine(req.body) ? `<div class="statement">${markdown(req.body.join('\n'))}</div>` : ''}`;
  } else {
    if (req.kind === 'modified' && c.amend && !old) notes.push(L.noBaseline);
    const changed = req.kind === 'modified' && old && oneLine(old.body) !== oneLine(req.body);
    claim = `${changed ? wasNow(wording(oneLine(old.body)), wording(oneLine(req.body)), L) : `<div class="statement">${markdown(req.body.join('\n'))}</div>`}
${scenariosHtml(req, old, c)}`;
  }
  const t = c.trace.get(norm(req.name));
  const refs = t ? parseRefs(t.source) : [];
  let evidence = '';
  if (t) {
    evidence += refs.map((ref) => snippet(root, ref, L)).join('\n');
    if (!refs.length && plainText(t.source)) evidence += `<p class="tests"><span class="label">${escapeHtml(L.source)}</span><span>${inline(t.source)}</span></p>`;
    const none = /^(none|なし|無し|-|—)?$/i.test(plainText(t.tests));
    evidence += `<p class="tests"><span class="label">${escapeHtml(L.tests)}</span><span${none ? ' class="caution"' : ''}>${inline(t.tests || '—')}</span></p>`;
  } else if (req.kind !== 'removed') evidence += `<p class="caution">${escapeHtml(L.noTrace)}</p>`;
  evidence += crossLine(c.cross.get(norm(req.name)), L);
  return { tag: c.amend || req.kind === 'modified' || req.kind === 'removed' ? deltaTag(req.kind, L) : '', removed: req.kind === 'removed', notes,
    html: `<div class="pair">
<div class="claim">
${claim}
</div>
<div class="evidence"><span class="label">${escapeHtml(L.evidence)}</span>
${evidence}
</div>
</div>` };
}

const IMAGE = /\.(png|jpe?g|gif|webp|bmp)$/i;

// The screenshot is a file of its own next to the page, not part of it: the page
// links it by a path relative to where the page is written.
function screenshot(value, c) {
  const { L, root, outDir } = c;
  const raw = stripComments(value).replace(/`/g, '').trim();
  if (BLANK.test(raw) || /^(none|なし)$/i.test(raw)) return '';
  const abs = /^[a-z][a-z0-9+.-]*:/i.test(raw) || !IMAGE.test(raw) ? null : insideRoot(root, raw);
  if (!abs || !fs.existsSync(abs)) return `<figure class="shot"><figcaption class="caution">${escapeHtml(L.noImage)}: ${escapeHtml(raw)}</figcaption></figure>`;
  const src = escapeHtml(path.relative(outDir, abs).split(path.sep).map(encodeURIComponent).join('/'));
  return `<figure class="shot"><img src="${src}" alt="${escapeHtml(`${L.screenshot}: ${raw}`)}" loading="lazy"><figcaption><a href="${src}">${escapeHtml(L.openImage)}</a> <span class="mono">${escapeHtml(raw)}</span></figcaption></figure>`;
}

function screenBody(it, c) {
  const shotLine = /^\s*[-*+]\s+\*\*Screenshot\*\*\s*:?\s*(.*)$/i;
  const value = it.data.body.map((l) => l.match(shotLine)).find(Boolean)?.[1] ?? '';
  const rest = it.data.body.filter((l) => !shotLine.test(l)).join('\n');
  const shot = screenshot(value, c);
  return { tag: '', notes: [], html: `<div class="screen${shot ? '' : ' no-shot'}">${shot}<div class="doc">${markdown(rest, { headingOffset: 2 })}${crossLine(c.cross.get(norm(it.data.name)), c.L)}</div></div>` };
}

function questionBody(it, c) {
  const { L } = c;
  const q = it.data;
  const notes = [];
  const written = it.decision !== null && !BLANK.test(plainText(it.decision));
  if (it.done && !written) notes.push(L.tickedNoDecision);
  if (!it.done && written) notes.push(L.decisionNoTick);
  const kind = q?.kind ? `<span class="q-kind">${escapeHtml(L.qkinds[q.kind.toLowerCase()] ?? q.kind)}</span>` : '';
  return { tag: '', notes, html: `<div class="q-body">
${q?.text || kind ? `<p class="q-text">${kind}${q?.text && q.text !== it.title ? inline(q.text) : ''}</p>` : ''}
<div class="decision ${written ? 'is-filled' : 'is-blank'}"><span class="label">${escapeHtml(L.decision)}</span><p>${written ? inline(it.decision) : escapeHtml(L.noDecision(it.label))}</p></div>
</div>` };
}

function reviewView({ root, dir, schema, L, outDir }) {
  const groups = parseReview(readText(path.join(dir, 'review.md')) ?? '');
  const review = stripComments(readText(path.join(dir, 'review.md')) ?? '');
  const reviewer = review.match(/^Reviewer:[ \t]*(.*)$/m)?.[1].trim() ?? '';
  const amend = schema === 'spec-relay-amend';

  const specFiles = walk(path.join(dir, 'specs')).filter((f) => f.endsWith('.md'));
  const reqs = [];
  let purpose = '';
  for (const file of specFiles) {
    const spec = parseSpec(readText(file) ?? '');
    purpose ||= spec.purpose;
    for (const req of spec.requirements) reqs.push({ ...req, capability: path.relative(path.join(dir, 'specs'), path.dirname(file)) });
  }
  const baselines = new Map();
  const baseline = (req) => {
    if (!baselines.has(req.capability)) baselines.set(req.capability, parseSpec(readText(path.join(root, 'openspec/specs', req.capability, 'spec.md')) ?? '').requirements);
    return baselines.get(req.capability).find((r) => norm(r.name) === norm(req.name)) ?? null;
  };
  const cross = new Map(tableRows(readText(path.join(dir, 'crosscheck.md')) ?? '').map(([item = '', verdict = '', evidence = '']) => [withoutId(item), { verdict, evidence }]));
  const screensText = readText(path.join(dir, 'screens.md'));
  const screens = blocks(screensText, 'Screen');
  const mapText = readText(path.join(dir, 'context-map.md'));
  const contexts = blocks(mapText, 'Context');
  const questionsText = readText(path.join(dir, 'questions.md'));
  const questions = parseQuestions(questionsText);
  const c = { root, L, outDir, amend, baseline, cross, trace: parseTrace(readText(path.join(dir, 'trace.md'))) };

  // Tie each review row to the thing it names.
  const used = new Set();
  const take = (list, test) => { const hit = list.find((x) => !used.has(x) && test(x)); if (hit) used.add(hit); return hit; };
  for (const item of groups.flatMap((g) => g.items)) {
    item.notes = [];
    if (item.letter === 'R' && specFiles.length) {
      item.data = take(reqs, (r) => norm(r.name) === item.key);
      if (item.data) item.kind = 'req'; else item.notes.push(L.noReq);
    } else if (item.letter === 'S' && screensText !== null) {
      item.data = take(screens, (s) => norm(s.name) === item.key);
      if (item.data) item.kind = 'screen'; else item.notes.push(L.noScreen);
    } else if (item.letter === 'K' && mapText !== null) {
      item.data = take(contexts, (k) => new RegExp(`^k\\d+\\s*[.:)-]?\\s*${k.name.replace(/[^\w-]/g, '\\$&')}(?![\\w-])`, 'i').test(item.plain));
      if (item.data) item.kind = 'context'; else item.notes.push(L.noContext);
    } else if (item.letter === 'Q') {
      item.kind = 'q';
      item.data = questions.get(item.id);
      if (!item.data && questionsText !== null) item.notes.push(L.noQuestion);
    }
  }
  // Things no review row names still need a decision: they are open items.
  const orphan = (letter, fallback, extra) => {
    let group = groups.find((g) => g.items.some((i) => i.letter === letter));
    if (!group) { group = { title: fallback, items: [] }; groups.push(group); }
    group.items.push({ id: '', letter, done: false, decision: null, notes: [L.noReviewRow], ...extra });
  };
  for (const req of reqs.filter((r) => !used.has(r))) orphan('R', L.requirements, { kind: 'req', data: req, title: req.name });
  for (const screen of screens.filter((s) => !used.has(s))) orphan('S', L.screens, { kind: 'screen', data: screen, title: screen.name });
  for (const context of contexts.filter((k) => !used.has(k))) orphan('K', L.contexts, { kind: 'context', data: context, title: context.name });
  const reviewed = new Set(groups.flatMap((g) => g.items).map((i) => i.id));
  for (const id of questionsText === null ? [] : questionIds(questionsText).sort((a, b) => Number(a.slice(1)) - Number(b.slice(1)))) {
    if (!reviewed.has(id)) orphan('Q', L.questions, { kind: 'q', data: questions.get(id), title: questions.get(id)?.text ?? '', label: id });
  }

  const ids = new Set();
  let unnamed = 0;
  const shown = groups.filter((g) => g.items.length);
  shown.forEach((group, n) => {
    group.id = `g${n + 1}`;
    group.title = L.groups[group.title.toLowerCase()] ?? (group.title || L.other);
    for (const item of group.items) {
      item.label ??= item.id || '—';
      let anchor = item.id || `x${unnamed += 1}`;
      for (let k = 2; ids.has(anchor); k += 1) anchor = `${item.id}-${k}`;
      ids.add(anchor);
      item.anchor = anchor;
      const body = item.kind === 'req' ? requirementBody(item, c) : item.kind === 'screen' ? screenBody(item, c) : item.kind === 'q' ? questionBody(item, c)
        : item.kind === 'context' ? { tag: '', notes: [], html: `<div class="q-body"><div class="doc">${markdown(item.data.body.join('\n'), { headingOffset: 2 })}</div></div>` } : { tag: '', notes: [], html: '' };
      const notes = [...item.notes, ...body.notes];
      item.name = plainText(item.title) || plainText(item.data?.text ?? '') || item.label;
      item.html = `<article class="item${body.html ? '' : ' small'}${item.kind ? ` k-${item.kind}` : ''} ${item.done ? 'is-done' : 'is-open'}${body.removed ? ' is-removed' : ''}" id="${escapeHtml(anchor)}" tabindex="-1">
<header class="item-head"><span class="id">${escapeHtml(item.label)}</span><h3>${body.tag}${inline(item.title)}</h3>${seal(item.done, L)}</header>
${cautionsHtml(notes)}${body.html}
</article>`;
    }
  });

  const named = reviewer && !/^<.*>$/.test(reviewer);
  const brief = `<header class="brief">
${purpose.trim() ? `<div class="purpose"><span class="label">${escapeHtml(L.purpose)}</span>${markdown(purpose)}</div>` : ''}
<dl class="facts"><dt>${escapeHtml(L.reviewer)}</dt><dd><span class="sign${named ? '' : ' is-blank'}">${named ? inline(reviewer) : escapeHtml(L.notNamed)}</span></dd><dt>${escapeHtml(L.scope)}</dt><dd>${shown.map((g) => `${escapeHtml(g.title)} ${g.items.length}`).join('・')}</dd></dl>
<ol class="howto">${L.howto.map((step) => `<li>${step}</li>`).join('')}</ol>
</header>`;

  // Everything else the change holds, as documents. What is already shown in
  // full as items (the screens, the contexts) is not repeated.
  const docs = [];
  for (const file of walk(dir).filter((f) => f.endsWith('.md') && !f.startsWith(path.join(dir, 'specs') + path.sep))) {
    const rel = path.relative(dir, file).replace(/\\/g, '/');
    if (rel === 'review.md' || (rel === 'screens.md' && screens.length)) continue;
    let text = readText(file) ?? '';
    if (rel === 'context-map.md' && contexts.length) text = withoutSection(text, /^##\s+Contexts\s*$/i);
    docs.push({ id: `doc-${rel.replace(/[^\w-]/g, '-')}`, title: rel.replace(/\.md$/, ''), html: `<div class="doc">${markdown(text, { headingOffset: 2 })}</div>` });
  }
  return { groups: shown, docs, brief };
}

function withoutSection(text, heading) {
  const out = [];
  let skip = false;
  for (const line of text.split(/\r?\n/)) {
    if (/^##\s/.test(line)) skip = heading.test(line.trim());
    if (!skip) out.push(line);
  }
  return out.join('\n');
}

function genericChangeView(dir) {
  return {
    groups: [], brief: '',
    docs: walk(dir).filter((f) => f.endsWith('.md')).map((file) => {
      const rel = path.relative(dir, file).replace(/\\/g, '/');
      return { id: `doc-${rel.replace(/[^\w-]/g, '-')}`, title: rel.replace(/\.md$/, ''), html: `<div class="doc">${markdown(readText(file) ?? '', { headingOffset: 2 })}</div>` };
    }),
  };
}

// ---------------------------------------------------------------- page

// Colour rule: ink is what the artifacts say, vermilion (--shu) marks only what
// review.md records (a tick, a decision, the reviewer), indigo (--ai) is links
// and focus, ochre is a caution. No status is told by colour alone.
const CSS = `
:root{--paper:#ffffff;--desk:#f1f2f4;--ink:#15171c;--ink2:#4b505b;--rule:#7b808b;--hair:#d9dce1;
--shu:#b5301a;--ai:#1b4f93;--ochre:#7d5200;--code:#f4f5f7;
--ui:"Yu Gothic UI","Segoe UI","Meiryo","Hiragino Sans","Noto Sans JP","Noto Sans CJK JP",system-ui,sans-serif;
--read:"BIZ UDPGothic","Yu Gothic UI","Meiryo","Hiragino Sans","Noto Sans JP","Noto Sans CJK JP",system-ui,sans-serif;
--mono:"BIZ UDGothic","MS Gothic","Cascadia Mono",Consolas,"Osaka-Mono","SF Mono",Menlo,"Noto Sans Mono CJK JP",ui-monospace,monospace}
@media (prefers-color-scheme:dark){:root{--paper:#17191d;--desk:#0f1114;--ink:#e9eaed;--ink2:#a6abb6;--rule:#6d7380;--hair:#30343d;
--shu:#ff8f73;--ai:#8fbaf7;--ochre:#e2b25c;--code:#1f2228}}
*{box-sizing:border-box}
html{-webkit-text-size-adjust:100%}
body{margin:0;background:var(--paper);color:var(--ink);font:16px/1.75 var(--read);overflow-wrap:anywhere}
a{color:var(--ai);text-underline-offset:.2em}
:focus-visible{outline:3px solid var(--ai);outline-offset:2px}
code,.mono{font-family:var(--mono);font-size:.92em}
img{max-width:100%;height:auto}
hr{border:0;border-top:1px solid var(--hair)}
blockquote{margin:8px 0;padding:2px 14px;border-left:3px solid var(--hair);color:var(--ink2)}
.label{font:600 12px/1.4 var(--ui);color:var(--ink2);letter-spacing:.06em;white-space:nowrap}
.skip{position:absolute;left:-999px}.skip:focus{left:8px;top:8px;z-index:9;background:var(--paper);padding:6px 10px}
.vh{position:absolute;width:1px;height:1px;overflow:hidden;clip-path:inset(50%);white-space:nowrap}
.caution{color:var(--ochre);font-weight:600;font-size:14px;margin:6px 0 0}
.caution::before{content:"△ "}

.shell{display:grid;grid-template-columns:minmax(0,1fr)}
.rail{background:var(--desk);border-bottom:2px solid var(--ink);padding:16px;font-family:var(--ui);min-width:0}
main{padding:8px 16px 96px;min-width:0}
@media (min-width:1000px){
.shell{grid-template-columns:288px minmax(0,1fr)}
.rail{position:sticky;top:0;height:100vh;overflow-y:auto;display:flex;flex-direction:column;border-bottom:0;border-right:1px solid var(--rule);padding:24px 20px}
.rail>*{flex:none}
.rail>.toc[open]{flex:1 1 auto;min-height:220px;overflow-y:auto;margin-right:-20px;padding-right:20px}
main{padding:16px 40px 120px;max-width:1640px}}

.kind{margin:0;font:600 12px/1.4 var(--ui);letter-spacing:.06em;color:var(--ink2)}
.rail h1{margin:2px 0 0;font:700 17px/1.4 var(--mono);overflow-wrap:anywhere}
.meta{margin:2px 0 0;font-size:12px;color:var(--ink2)}
.left{margin:16px 0 0;padding:12px 0 0;border-top:2px solid var(--ink)}
.remain{margin:0;font-size:14px;line-height:1.3}
.remain b{font:700 34px/1 var(--mono);margin-right:6px;font-variant-numeric:tabular-nums}
.remain-sub{margin:4px 0 0;font-size:13px;color:var(--ink2)}
.next{display:inline-block;margin:10px 0 0;padding:7px 12px;border:1.5px solid var(--ink);color:var(--ink);font:600 14px/1.3 var(--ui);text-decoration:none}
.next:hover{background:var(--ink);color:var(--paper)}

.sheet{margin:14px 0 0;padding:0;list-style:none;display:grid;grid-template-columns:1.6em minmax(0,1fr);gap:6px 4px;align-items:start}
.sheet .g{font:600 12px/18px var(--mono);color:var(--ink2)}
.cells{display:flex;flex-wrap:wrap;gap:3px}
.cells a,.legend i{display:block;width:18px;height:18px;border:1.5px dashed var(--rule);text-decoration:none;font:700 12px/15px var(--ui);text-align:center;color:var(--paper)}
.cells a.is-done,.legend i.is-done{border:1.5px solid var(--shu);background:var(--shu)}
.cells a:hover{border-color:var(--ink)}
.cells a[aria-current]{outline:2px solid var(--ink);outline-offset:2px}
.cells a:focus-visible{outline:3px solid var(--ai);outline-offset:2px}
.legend{margin:8px 0 0;display:flex;flex-wrap:wrap;gap:4px 12px;font-size:12px;color:var(--ink2);align-items:center}
.legend span{display:inline-flex;gap:5px;align-items:center}.legend i{width:12px;height:12px}
@media (forced-colors:active){.cells a.is-done::after{content:"✓";color:CanvasText}.cells a.is-done{border-style:solid}}

.filter{margin:16px 0 0;padding:0;border:0;display:flex;min-width:0}
.filter legend{padding:0;margin-bottom:4px}
.filter label{flex:1;position:relative;text-align:center;font-size:13px;line-height:1.3;padding:7px 4px;border:1.5px solid var(--ink);cursor:pointer}
.filter label+label{border-left:0}
.filter input{position:absolute;opacity:0;inset:0;margin:0;cursor:pointer}
.filter label:has(input:checked){background:var(--ink);color:var(--paper);font-weight:600}
.filter label:has(input:focus-visible){outline:3px solid var(--ai);outline-offset:2px;z-index:1}
.filter .n{font-family:var(--mono);margin-left:4px}
body:has(#f-open:checked) main .item.is-done,body:has(#f-open:checked) .toc li.is-done{display:none}
.all-clear{display:none;margin:0;padding:10px 0;border-top:1px solid var(--rule);color:var(--ink2);font-size:14px}
body:has(#f-open:checked) .group:not(:has(.item.is-open)) .all-clear{display:block}

.toc{margin:16px 0 0;position:relative}
.toc>summary,.keys summary{font:600 13px/1.4 var(--ui);cursor:pointer;padding:6px 0}
.toc h2{display:flex;justify-content:space-between;align-items:baseline;gap:8px;margin:10px 0 2px;padding-top:6px;border-top:1px solid var(--rule);font:600 12px/1.4 var(--ui);letter-spacing:.06em;color:var(--ink2)}
.toc h2 a{color:inherit;text-decoration:none;overflow-wrap:anywhere}.toc h2 a:hover{text-decoration:underline}
.toc h2 .n{font-family:var(--mono);letter-spacing:0;white-space:nowrap}
.toc ol{margin:0;padding:0;list-style:none}
.toc li a{display:grid;grid-template-columns:2.8em minmax(0,1fr) auto;gap:6px;align-items:baseline;padding:5px 6px;color:var(--ink);text-decoration:none;font-size:14px;line-height:1.45}
.toc li a:hover{background:var(--paper)}
.toc li a[aria-current]{background:var(--ink);color:var(--paper)}
.toc li a[aria-current] .st,.toc li a[aria-current] .t{color:inherit;border-color:currentColor}
.toc li a:focus-visible{outline:3px solid var(--ai);outline-offset:-3px}
.toc .id{font:600 13px/1.45 var(--mono)}
.toc .t{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.toc li.is-done .t{color:var(--ink2)}
.toc li.is-open .t{font-weight:600}
.st{font:700 12px/15px var(--ui);width:18px;height:18px;text-align:center;border:1.5px dashed var(--rule);color:var(--ink2)}
.is-done>a>.st{border:1.5px solid var(--shu);color:var(--shu)}
.toc .plain a{grid-template-columns:minmax(0,1fr)}
.keys{display:none;margin:12px 0 0;padding:10px 0 0;border-top:1px solid var(--rule);font-size:13px;color:var(--ink2)}
.js .keys{display:block}
.keys label{display:flex;gap:6px;align-items:center;color:var(--ink);cursor:pointer}
.keys ul{margin:4px 0 0;padding:0;list-style:none;line-height:2;font-size:12px}
.keys kbd{font:600 12px/1 var(--mono);color:var(--ink);border:1px solid var(--rule);border-bottom-width:2px;padding:1px 5px;margin-right:3px;background:var(--paper)}

.brief{padding:8px 0 20px;display:grid;gap:14px 40px}
.brief p{margin:0}
.purpose p{font-size:18px;line-height:1.7;max-width:38em;overflow-wrap:anywhere}
.facts{margin:0;display:grid;grid-template-columns:max-content minmax(0,1fr);gap:4px 14px;font-size:14px;align-content:start}
.facts dt{font:600 12px/1.9 var(--ui);color:var(--ink2);letter-spacing:.06em}.facts dd{margin:0;overflow-wrap:anywhere}
.sign{font-weight:700;border-bottom:2px solid var(--shu);padding:0 10px 0 2px}
.sign.is-blank{color:var(--ink2);font-weight:400;border-bottom:1.5px dashed var(--rule)}
.howto{grid-column:1/-1;margin:0;padding:10px 0 0;border-top:1px solid var(--hair);list-style:none;display:flex;flex-wrap:wrap;gap:4px 22px;font-size:14px;color:var(--ink2);counter-reset:s}
.howto li{counter-increment:s}.howto li::before{content:counter(s);font:700 12px/1 var(--mono);color:var(--ink);border:1.5px solid var(--ink);padding:1px 5px;margin-right:6px}
@media (min-width:1000px){.brief:has(.purpose){grid-template-columns:minmax(0,1.4fr) minmax(0,1fr)}}

.group{margin:0 0 40px}
.group>h2{display:flex;justify-content:space-between;align-items:baseline;gap:12px;margin:0;padding:8px 0;border-top:3px solid var(--ink);font:700 15px/1.4 var(--ui);letter-spacing:.08em;overflow-wrap:anywhere;scroll-margin-top:8px}
.group>h2 .n{font:600 13px/1.4 var(--mono);letter-spacing:0;color:var(--ink2);white-space:nowrap}
.item{border-top:1px solid var(--rule);padding:16px 0 22px;scroll-margin-top:8px;container-type:inline-size}
.item:focus{outline:none}
.item-head{display:grid;grid-template-columns:auto minmax(0,1fr) auto;gap:4px 12px;align-items:start}
.item-head .id{font:700 15px/1.3 var(--mono);padding:3px 7px;border:1.5px solid var(--ink);margin-top:2px;min-width:3.1em;text-align:center}
.item.is-current .item-head .id{background:var(--ink);color:var(--paper)}
.item-head h3{margin:0;font-size:20px;line-height:1.45;font-weight:700;min-width:0;overflow-wrap:anywhere}
.item.small .item-head h3{font-size:16px;line-height:1.7;font-weight:400}
@media (max-width:520px){.item-head{grid-template-columns:auto minmax(0,1fr)}.item-head .id{justify-self:start}.item-head .seal{justify-self:end}.item-head h3{grid-row:2;grid-column:1/-1}}
.item>.caution{margin:8px 0 0}

.seal{display:inline-flex;align-items:center;gap:7px;font:600 13px/1.2 var(--ui);color:var(--ink);white-space:nowrap;margin-top:1px}
.seal b{display:grid;place-items:center;width:32px;height:32px;font:700 16px/1 var(--ui);border:1.5px dashed var(--rule);color:var(--ink2)}
.seal.is-done b{border:2px solid var(--shu);color:var(--shu);border-radius:50%}

.pair{margin-top:12px;display:grid;grid-template-columns:minmax(0,1fr);gap:18px 40px}
.claim,.evidence{min-width:0}
@container (min-width:860px){.pair{grid-template-columns:minmax(0,1fr) minmax(0,1.2fr);padding-left:calc(3.1em + 26px)}
.claim{position:sticky;top:12px;align-self:start;max-height:calc(100vh - 24px);overflow-y:auto}}
.statement{font-size:17px;max-width:38em;overflow-wrap:anywhere}
.statement p{margin:0 0 .5em}
.statement.gone,.gone h4>span:last-child,.gone dd,.gone>p,.gone>ul,.gone>ol{color:var(--ink2);text-decoration:line-through}

.scenario{margin-top:16px}
.scenario h4{margin:0 0 4px;font-size:15px;line-height:1.5;font-weight:700;display:flex;flex-wrap:wrap;gap:2px 10px;align-items:baseline;overflow-wrap:anywhere}
.scenario h4>span:last-child{min-width:0}
.gwt{margin:0;border-top:1px solid var(--hair)}
.gwt>div{display:grid;grid-template-columns:5.2em minmax(0,1fr);gap:10px;padding:5px 0;border-bottom:1px solid var(--hair)}
.gwt dt{font:600 13px/1.4 var(--ui);padding-top:5px}
.gwt dt small{display:block;font:400 12px/1.3 var(--mono);color:var(--ink2);letter-spacing:.04em}
.gwt dd{margin:0;font-size:15px;overflow-wrap:anywhere}
.gwt .then dd{font-weight:700}

.evidence>.label{display:block;margin-bottom:4px}
.src{border:1px solid var(--rule)}
.src+.src{margin-top:10px}
.src summary{display:flex;flex-wrap:wrap;gap:2px 12px;align-items:baseline;padding:6px 10px;cursor:pointer;font:13px/1.5 var(--mono);background:var(--code)}
.src[open] summary{border-bottom:1px solid var(--rule)}
.src summary .f{font-weight:700;overflow-wrap:anywhere;min-width:0}
.src summary .sym{color:var(--ink2);overflow-wrap:anywhere;min-width:0}
.src summary .ln-range{margin-left:auto;color:var(--ink2);white-space:nowrap}
.code{margin:0;padding:8px 0;overflow-x:auto;font:13px/1.65 var(--mono);tab-size:4;background:var(--paper)}
.code code{font-size:inherit;display:block;min-width:max-content}
.code .l{display:block;padding-right:12px}
.code .l:hover{background:var(--code)}
.code .ln{display:inline-block;width:3.6em;padding-right:10px;margin-right:12px;text-align:right;color:var(--ink2);border-right:1px solid var(--hair);user-select:none}
.src-note{margin:0;padding:4px 10px;border-top:1px solid var(--hair);font:400 12px/1.5 var(--ui);color:var(--ink2)}
.src-note.caution{color:var(--ochre);font-weight:600}
.tests{margin:8px 0 0;font-size:14px;display:grid;grid-template-columns:auto minmax(0,1fr);gap:10px;align-items:baseline;overflow-wrap:anywhere}
.tests .caution{font-size:inherit;margin:0}

.q-body{margin-top:10px;min-width:0}
@container (min-width:860px){.q-body{padding-left:calc(3.1em + 26px)}}
.q-kind{display:inline-block;font:600 12px/1.4 var(--ui);border:1px solid var(--rule);padding:1px 7px;margin-right:8px}
.q-text{margin:0 0 10px;max-width:46em;overflow-wrap:anywhere}
.decision{display:grid;grid-template-columns:5.2em minmax(0,1fr);gap:10px;align-items:baseline;max-width:46em;border:1.5px solid var(--shu);padding:8px 12px}
.decision p{margin:0;color:var(--shu);font-weight:700;overflow-wrap:anywhere}
.decision.is-blank{border:1.5px dashed var(--rule)}
.decision.is-blank p{color:var(--ink2);font-weight:400;font-size:14px}

.doc{max-width:64em;font-size:15px;overflow-wrap:anywhere;min-width:0}
.doc h3{font-size:17px;margin:18px 0 6px}.doc h4{font-size:15px;margin:16px 0 4px}.doc h5,.doc h6{font-size:14px;margin:12px 0 4px}
.doc p,.doc ul,.doc ol{margin:4px 0}.doc ul,.doc ol{padding-left:1.4em}
.doc pre.code{border:1px solid var(--hair);padding:8px 12px;background:var(--code)}
.doc pre.code code{min-width:0}
.table{overflow-x:auto}
table{border-collapse:collapse;width:100%;font-size:14px;margin:6px 0}
th,td{padding:6px 12px 6px 0;text-align:left;vertical-align:top;border-bottom:1px solid var(--hair);overflow-wrap:normal}
th{font:600 12px/1.6 var(--ui);color:var(--ink2);letter-spacing:.04em;border-bottom:1.5px solid var(--ink);white-space:nowrap}
td{min-width:6em}
li.task{list-style:none;display:flex;gap:8px;align-items:flex-start;margin:4px 0}
ul:has(>li.task),ol:has(>li.task){padding-left:0}
.box{flex:none;width:18px;height:18px;margin-top:5px;border:1.5px dashed var(--rule);font:700 12px/15px var(--ui);text-align:center}
li.done .box{border:1.5px solid var(--ink)}

.delta{display:inline-block;font:700 12px/1.4 var(--ui);padding:1px 7px;border:1.5px solid var(--ink);margin-right:8px;white-space:nowrap;vertical-align:.15em}
.delta.added{border-style:double;border-width:3px}
.delta.removed{border-style:dashed}
.was,.now{display:grid;grid-template-columns:2.4em minmax(0,1fr);gap:8px;margin:0;padding:6px 0;max-width:40em;font-size:17px;overflow-wrap:anywhere;align-items:baseline}
.was{color:var(--ink2)}
del{text-decoration:line-through;text-decoration-thickness:2px;color:var(--ink2);background:var(--code)}
ins{text-decoration:none;font-weight:700;border-bottom:3px double var(--ink)}
.item.is-removed .pair{background:repeating-linear-gradient(135deg,transparent 0 9px,var(--hair) 9px 10px)}

.screen{display:grid;grid-template-columns:minmax(0,1fr);gap:14px 28px;margin-top:10px}
@container (min-width:860px){.screen{grid-template-columns:minmax(0,420px) minmax(0,1fr);padding-left:calc(3.1em + 26px)}.screen.no-shot{grid-template-columns:minmax(0,1fr)}}
.shot{margin:0;min-width:0;align-self:start}
.shot img{display:block;border:1px solid var(--rule)}
.shot figcaption{font-size:13px;margin-top:4px;overflow-wrap:anywhere}

.dock{display:none}
@media (max-width:999px){.js .dock{position:fixed;left:0;right:0;bottom:0;z-index:5;display:grid;grid-template-columns:48px minmax(0,1fr) auto;align-items:stretch;background:var(--paper);border-top:2px solid var(--ink);font-family:var(--ui)}
.dock button{font:600 15px/1.2 var(--ui);min-height:48px;padding:0 16px;border:0;background:var(--paper);color:var(--ink);cursor:pointer}
.dock button.prev{border-right:1px solid var(--rule)}
.dock button.primary{background:var(--ink);color:var(--paper)}
.dock .count{align-self:center;padding:0 12px;font-size:13px}.dock .count b{font:700 18px/1 var(--mono);margin-right:4px}}

footer{border-top:1px solid var(--rule);padding:12px 0 0;color:var(--ink2);font-size:13px;max-width:60em}

@media print{
:root{--paper:#fff;--desk:#fff;--ink:#000;--ink2:#333;--rule:#666;--hair:#bbb;--shu:#b5301a;--ai:#000;--ochre:#000;--code:#fff}
body{font-size:10.5pt}
@page{margin:14mm}
.shell{display:block}.rail{display:block;position:static;height:auto;overflow:visible;border:0;border-bottom:2px solid #000;padding:0 0 8pt;background:none}
.filter,.toc,.keys,.dock,.next,.skip{display:none!important}
main{padding:0;max-width:none}
body:has(#f-open:checked) main .item.is-done{display:block}
.claim{position:static;max-height:none;overflow:visible}
.item-head{break-after:avoid}.item.small,.item.k-q,.src,.scenario,.decision{break-inside:avoid}
.group>h2{break-after:avoid}
.item.is-current .item-head .id{background:none;color:#000}.cells a[aria-current]{outline:0}
details::details-content{content-visibility:visible;display:block}
.code{overflow:visible;white-space:pre-wrap;overflow-wrap:anywhere}.code code{min-width:0}
.cells a.is-done,.legend i.is-done{-webkit-print-color-adjust:exact;print-color-adjust:exact}
a{color:inherit;text-decoration:none}}
`;

// Everything here is a convenience: with script off the page still reads, the
// filter still works (CSS), and every link still goes where it says.
const SCRIPT = String.raw`(() => {
  const d = document, wide = matchMedia('(min-width:1000px)');
  d.documentElement.classList.add('js');
  const store = (area, key, value) => { try { if (value === undefined) return window[area].getItem(key); window[area].setItem(key, value); } catch (e) { /* storage may be refused on file:// */ } return null; };
  const toc = d.querySelector('details.toc');
  if (wide.matches) { if (toc) toc.open = true; } else d.querySelectorAll('details.src').forEach((x) => { x.open = false; });
  addEventListener('beforeprint', () => d.querySelectorAll('details').forEach((x) => { x.open = true; }));

  const items = () => [...d.querySelectorAll('main .item')].filter((x) => x.offsetParent !== null);
  let current = null, pinned = null;
  const mark = (el) => {
    if (el === current) return;
    current = el;
    d.querySelectorAll('.is-current').forEach((x) => x.classList.remove('is-current'));
    d.querySelectorAll('[aria-current]').forEach((x) => x.removeAttribute('aria-current'));
    if (!el) return;
    el.classList.add('is-current');
    d.querySelectorAll('.rail a[href="#' + CSS.escape(el.id) + '"]').forEach((a) => {
      a.setAttribute('aria-current', 'true');
      const box = a.closest('.toc');
      if (!box || !wide.matches) return;
      const r = a.getBoundingClientRect(), b = box.getBoundingClientRect();
      if (r.top < b.top + 8 || r.bottom > b.bottom - 8) box.scrollTop += r.top - b.top - b.height / 2;
    });
  };
  // The item a key or a link went to stays the current one until the reader
  // scrolls, also when the page cannot scroll far enough to bring it to the top.
  const sync = () => {
    if (pinned !== null) { if (Math.abs(scrollY - pinned) < 2) return; pinned = null; }
    const list = items();
    let hit = list[0] || null;
    for (const el of list) { if (el.getBoundingClientRect().top <= innerHeight * 0.3) hit = el; else break; }
    mark(hit);
  };
  let tick = false;
  addEventListener('scroll', () => { if (!tick) { tick = true; requestAnimationFrame(() => { tick = false; sync(); }); } }, { passive: true });
  addEventListener('resize', () => { pinned = null; sync(); });
  const fOpen = d.getElementById('f-open'), fAll = d.getElementById('f-all');
  const go = (el) => {
    if (!el) return;
    if (el.offsetParent === null && fAll) { fAll.checked = true; store('sessionStorage', 'spec-relay-filter', 'all'); }
    el.scrollIntoView({ block: 'start' });
    el.focus({ preventScroll: true });
    mark(el);
    pinned = scrollY;
  };
  const step = (dir, onlyOpen) => {
    const all = items(), at = all.indexOf(current);
    const list = all.filter((x) => !onlyOpen || x.classList.contains('is-open'));
    const next = dir > 0 ? list.find((x) => all.indexOf(x) > at) : list.reverse().find((x) => all.indexOf(x) < at);
    go(next || null);
  };
  const itemOf = (hash) => { let el = null; try { el = d.getElementById(decodeURIComponent(hash.slice(1))); } catch (e) { /* bad escape */ } return el && el.classList.contains('item') ? el : null; };
  d.addEventListener('click', (e) => {
    const a = e.target.closest ? e.target.closest('a[href^="#"]') : null;
    const el = a ? itemOf(a.getAttribute('href')) : null;
    if (!el || e.ctrlKey || e.metaKey || e.shiftKey || e.altKey) return;
    e.preventDefault();
    go(el);
    try { history.replaceState(null, '', '#' + el.id); } catch (err) { /* not allowed on some file:// setups */ }
  });

  const remember = () => { store('sessionStorage', 'spec-relay-filter', fOpen.checked ? 'open' : 'all'); pinned = null; sync(); };
  if (fOpen && fAll) {
    if (store('sessionStorage', 'spec-relay-filter') === 'open') fOpen.checked = true;
    fOpen.addEventListener('change', remember); fAll.addEventListener('change', remember);
  }
  const keysOn = d.getElementById('keys-on');
  if (keysOn) {
    if (store('localStorage', 'spec-relay-keys') === 'off') keysOn.checked = false;
    keysOn.addEventListener('change', () => store('localStorage', 'spec-relay-keys', keysOn.checked ? 'on' : 'off'));
  }
  addEventListener('keydown', (e) => {
    if (!keysOn || !keysOn.checked || e.ctrlKey || e.metaKey || e.altKey || e.isComposing) return;
    const t = e.target, tag = t && t.tagName;
    if (tag === 'TEXTAREA' || tag === 'SELECT' || (t && t.isContentEditable) || (tag === 'INPUT' && !/^(radio|checkbox)$/.test(t.type))) return;
    const k = e.key;
    if (k === 'j') step(1, false);
    else if (k === 'k') step(-1, false);
    else if (k === 'n') step(1, true);
    else if (k === 'p') step(-1, true);
    else if (k === 'o' && current) current.querySelectorAll('details.src').forEach((x) => { x.open = !x.open; });
    else if (k === 'u' && fOpen && fAll) { (fOpen.checked ? fAll : fOpen).checked = true; remember(); }
    else return;
    e.preventDefault();
  });
  const dock = d.querySelector('.dock');
  if (dock) {
    dock.querySelector('.prev').addEventListener('click', () => step(-1, true));
    dock.querySelector('.primary').addEventListener('click', () => step(1, true));
  }
  // The browser scrolls to the fragment by itself after loading; pin the item once that is done.
  const fromHash = () => { const el = location.hash ? itemOf(location.hash) : null; if (el) go(el); else { pinned = null; sync(); } };
  addEventListener('hashchange', fromHash);
  addEventListener('load', () => setTimeout(fromHash, 0));
  fromHash();
})();`;

export function page({ title, kind, meta, brief = '', groups = [], docs = [], L, lang }) {
  const all = groups.flatMap((g) => g.items);
  const open = all.filter((x) => !x.done);
  const reviewed = all.length > 0;
  const count = (list) => `${list.filter((x) => x.done).length} / ${list.length}`;
  const state = (x) => (x.done ? 'is-done' : 'is-open');
  const word = (x) => escapeHtml(x.done ? L.confirmed : L.open);
  const letter = (g) => g.items.find((i) => i.letter)?.letter ?? '·';

  const progress = reviewed ? `<div class="left">
<p class="remain">${open.length ? L.remain(open.length) : L.allDone}</p>
<p class="remain-sub">${escapeHtml(L.of(all.length, all.length - open.length))}${open.length ? `（${escapeHtml(L.left)}: ${groups.filter((g) => g.items.some((i) => !i.done)).map((g) => `${escapeHtml(g.title)} ${g.items.filter((i) => !i.done).length}`).join('・')}）` : ''}</p>
<ol class="sheet" aria-label="${escapeHtml(L.sheet)}">${groups.map((g) => `<li class="g" aria-hidden="true">${escapeHtml(letter(g))}</li><li class="cells">${g.items.map((x) => `<a href="#${escapeHtml(x.anchor)}" class="${state(x)}" title="${escapeHtml(`${x.label} ${x.name}`)} — ${word(x)}"><span class="vh">${escapeHtml(x.label)} ${word(x)}</span></a>`).join('')}</li>`).join('')}</ol>
<p class="legend"><span><i class="is-done" aria-hidden="true"></i>${escapeHtml(L.legendDone)}</span><span><i aria-hidden="true"></i>${escapeHtml(L.legendOpen)}</span></p>
${open.length ? `<a class="next" href="#${escapeHtml(open[0].anchor)}">${escapeHtml(L.firstOpen(open[0].label))}</a>` : ''}
</div>
<fieldset class="filter"><legend class="label">${escapeHtml(L.show)}</legend>
<label><input type="radio" name="f" id="f-all" checked>${escapeHtml(L.all)}<span class="n">${all.length}</span></label>
<label><input type="radio" name="f" id="f-open">${escapeHtml(L.onlyOpen)}<span class="n">${open.length}</span></label>
</fieldset>` : '';

  const toc = `<details class="toc"><summary>${escapeHtml(L.toc)}</summary>
<nav aria-label="${escapeHtml(L.toc)}">
${groups.map((g) => `<h2><a href="#${g.id}">${escapeHtml(g.title)}</a><span class="n">${count(g.items)}</span></h2>
<ol>${g.items.map((x) => `<li class="${state(x)}"><a href="#${escapeHtml(x.anchor)}"><span class="id">${escapeHtml(x.label)}</span><span class="t">${escapeHtml(x.name)}</span><span class="st" aria-hidden="true">${escapeHtml(x.done ? L.sealDone : L.sealOpen)}</span><span class="vh">${word(x)}</span></a></li>`).join('')}</ol>`).join('\n')}
${docs.length ? `${reviewed ? `<h2><span>${escapeHtml(L.appendix)}</span></h2>` : ''}
<ol>${docs.map((s) => `<li class="plain"><a href="#${escapeHtml(s.id)}"><span class="t">${escapeHtml(s.title)}</span></a></li>`).join('')}</ol>` : ''}
</nav></details>`;

  const keys = reviewed ? `<div class="keys"><label><input type="checkbox" id="keys-on" checked>${escapeHtml(L.keysOn)}</label>
<details><summary>${escapeHtml(L.keysList)}</summary><ul>${L.keys.map(([a, b, text]) => `<li><kbd>${a}</kbd>${b ? `<kbd>${b}</kbd>` : ''}${escapeHtml(text)}</li>`).join('')}</ul></details></div>` : '';

  const body = [
    brief,
    ...groups.map((g) => `<section class="group"><h2 id="${g.id}">${escapeHtml(g.title)}<span class="n">${escapeHtml(L.confirmed)} ${count(g.items)}</span></h2>
${g.items.map((x) => x.html).join('\n')}
<p class="all-clear">${escapeHtml(L.allClear)}</p>
</section>`),
    ...docs.map((s) => `<section class="group" id="${escapeHtml(s.id)}"><h2>${reviewed ? `${escapeHtml(L.appendix)} — ` : ''}${escapeHtml(s.title)}</h2>
${s.html}
</section>`),
  ].filter(Boolean).join('\n');

  return `<!doctype html>
<html lang="${lang}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="generator" content="spec-relay render.mjs">
<meta name="color-scheme" content="light dark">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; img-src 'self' data: file:">
<title>${escapeHtml(title)}</title>
<style>${CSS}</style>
</head>
<body>
<a class="skip" href="#main">${escapeHtml(L.skip)}</a>
<div class="shell">
<aside class="rail" aria-label="${escapeHtml(L.railLabel)}">
<p class="kind">${escapeHtml(kind)}</p>
<h1>${escapeHtml(title)}</h1>
<p class="meta">${escapeHtml(meta)}</p>
${progress}
${toc}
${keys}
</aside>
<main id="main">
${body}
<footer>${escapeHtml(L.note)}</footer>
</main>
</div>
${reviewed ? `<div class="dock"><button type="button" class="prev" aria-label="${escapeHtml(L.prevOpen)}">↑</button><span class="count"><b>${open.length}</b>${escapeHtml(L.remainShort)}</span><button type="button" class="primary">${escapeHtml(L.nextOpen)}</button></div>` : ''}
<script>${SCRIPT}</script>
</body>
</html>
`;
}

// ---------------------------------------------------------------- CLI

function pickLang(root, wanted) {
  if (wanted) return wanted.toLowerCase().startsWith('ja') ? 'ja' : 'en';
  const config = readText(path.join(root, 'openspec/config.yaml')) ?? '';
  const value = config.match(/Artifact language:\s*(.+)/i)?.[1] ?? '';
  return /^ja|japanese|日本/i.test(value.trim()) ? 'ja' : 'en';
}

// Local time with its offset from UTC: "2026-11-10 22:41 UTC+09:00".
export function timeStamp(now) {
  const p = (n) => String(n).padStart(2, '0');
  const offset = -now.getTimezoneOffset();
  const abs = Math.abs(offset);
  return `${now.getFullYear()}-${p(now.getMonth() + 1)}-${p(now.getDate())} ${p(now.getHours())}:${p(now.getMinutes())} UTC${offset < 0 ? '-' : '+'}${p(Math.floor(abs / 60))}:${p(abs % 60)}`;
}

export function render({ root = process.cwd(), change, file, out, lang, now = new Date() }) {
  const code = pickLang(root, lang);
  const L = LABELS[code];
  const stamp = `${L.generated} ${timeStamp(now)}`;
  const views = path.resolve(root, 'openspec/spec-relay/views');
  let build;
  let name;
  if (change) {
    const found = findChange(root, change);
    if (!found) return { ok: false, problems: [`change not found: ${change}`] };
    const schema = readText(path.join(found.dir, '.openspec.yaml')) === null ? '' : changeSchema(found.dir);
    const reviewed = fs.existsSync(path.join(found.dir, 'review.md'));
    name = change;
    build = (outDir) => {
      const view = reviewed ? reviewView({ root, dir: found.dir, schema: schema || 'spec-relay-extract', L, outDir }) : genericChangeView(found.dir);
      const meta = [schema, found.archived ? L.archived : '', stamp].filter(Boolean).join(' · ');
      return page({ title: change, kind: L.kinds[schema || (reviewed ? 'spec-relay-extract' : '')] ?? L.document, meta, ...view, L, lang: code });
    };
  } else if (file) {
    const text = readText(path.resolve(root, file));
    if (text === null) return { ok: false, problems: [`file not found: ${file}`] };
    name = path.basename(file).replace(/\.md$/i, '');
    build = () => page({ title: name, kind: L.document, meta: stamp, docs: [{ id: 'doc', title: name, html: `<div class="doc">${markdown(text, { headingOffset: 2 })}</div>` }], L, lang: code });
  } else return { ok: false, problems: ['pass --change NAME or --file PATH'] };

  const resolved = path.resolve(root, out ?? path.join(views, `${name}.html`));
  const html = build(path.dirname(resolved));
  fs.mkdirSync(path.dirname(resolved), { recursive: true });
  if (path.dirname(resolved) === views && !fs.existsSync(path.join(views, '.gitignore'))) {
    fs.writeFileSync(path.join(views, '.gitignore'), '# Generated by spec-relay render.mjs; the Markdown is the source of truth.\n*\n');
  }
  fs.writeFileSync(resolved, html);
  return { ok: true, out: path.relative(root, resolved).replace(/\\/g, '/') };
}

export function main(argv) {
  const opts = {};
  for (let i = 0; i < argv.length; i += 2) {
    const key = { '--change': 'change', '--file': 'file', '--root': 'root', '--out': 'out', '--lang': 'lang' }[argv[i]];
    if (!key || argv[i + 1] === undefined) return usage();
    opts[key] = argv[i + 1];
  }
  if (!opts.change === !opts.file) return usage();
  const result = render(opts);
  console.log(JSON.stringify(result, null, 2));
  return result.ok ? 0 : 1;
}

function usage() {
  console.error('Usage: node render.mjs --change NAME | --file PATH.md [--root DIR] [--out FILE] [--lang ja|en]');
  return 2;
}

function invokedDirectly() {
  if (!process.argv[1]) return false;
  try { return fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url)); } catch { return false; }
}

if (invokedDirectly()) process.exitCode = main(process.argv.slice(2));
