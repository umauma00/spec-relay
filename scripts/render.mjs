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
// Prints { ok, out } (or { ok: false, problems }) as JSON. Exit 0 / 1 / 2 like gate.mjs.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkboxes } from './gate.mjs';

// ---------------------------------------------------------------- labels

const LABELS = {
  ja: {
    overview: '概要', requirements: '要件', questions: '質問', coverage: '網羅性', other: 'その他の成果物',
    reviewer: 'レビュー担当', notNamed: '（未記入）', progress: '確認済み', confirmed: '確認済み', open: '未確認',
    decision: '判断', noDecision: '（未記入）', scenario: 'シナリオ', source: '元コード', tests: '既存のテスト',
    noTrace: 'trace.md に記載がありません', showCode: '元コードを表示', unreadable: 'ファイルを読めませんでした',
    truncated: '（長いため先頭のみ表示）', onlyOpen: '未確認だけ表示', generated: '生成',
    note: 'この画面は表示用です。正は Markdown のファイルで、判断は review.md に記録します。ファイルを直したら作り直してください。',
    purpose: '目的', change: 'change', archived: 'archive 済み', items: '項目', encoding: '文字コード',
  },
  en: {
    overview: 'Overview', requirements: 'Requirements', questions: 'Questions', coverage: 'Coverage', other: 'Other artifacts',
    reviewer: 'Reviewer', notNamed: '(not named)', progress: 'confirmed', confirmed: 'Confirmed', open: 'Open',
    decision: 'Decision', noDecision: '(blank)', scenario: 'Scenario', source: 'Source', tests: 'Existing tests',
    noTrace: 'No entry in trace.md', showCode: 'Show source code', unreadable: 'Could not read the file',
    truncated: '(long; only the beginning is shown)', onlyOpen: 'Show open items only', generated: 'Generated',
    note: 'This page is a view. The Markdown files are the source of truth and decisions go into review.md. Render again after changing them.',
    purpose: 'Purpose', change: 'change', archived: 'archived', items: 'items', encoding: 'encoding',
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

export function parseSpec(text) {
  const lines = stripComments(text).split(/\r?\n/);
  const purpose = [];
  const requirements = [];
  let section = null;
  let req = null;
  let scenario = null;
  for (const line of lines) {
    const r = line.match(/^###\s*Requirement:\s*(.+?)\s*$/i);
    const s = line.match(/^####\s*Scenario:\s*(.+?)\s*$/i);
    const h2 = line.match(/^##\s+(.*)$/);
    if (r) { req = { name: r[1], body: [], scenarios: [] }; requirements.push(req); scenario = null; section = 'req'; }
    else if (s && req) { scenario = { name: s[1], body: [] }; req.scenarios.push(scenario); }
    else if (h2) { section = /purpose/i.test(h2[1]) ? 'purpose' : 'other'; req = null; scenario = null; }
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

const MAX_LINES = 80;

function snippet(root, ref, L) {
  const file = path.resolve(root, ref.file);
  const rel = path.relative(path.resolve(root), file);
  if (rel.startsWith('..') || path.isAbsolute(rel) || rel.split(/[\\/]/)[0] === '.git') return `<p class="muted">${escapeHtml(L.unreadable)}: ${escapeHtml(ref.file)}</p>`;
  let buffer;
  try { buffer = fs.readFileSync(file); } catch { return `<p class="muted">${escapeHtml(L.unreadable)}: ${escapeHtml(ref.file)}</p>`; }
  const decoded = decodeSource(buffer);
  if (!decoded) return `<p class="muted">${escapeHtml(L.unreadable)}: ${escapeHtml(ref.file)}</p>`;
  const all = decoded.text.split(/\r?\n/);
  const from = Math.max(1, ref.from ?? 1);
  const wanted = Math.max(from, Math.min(all.length, ref.to ?? all.length));
  const to = Math.min(wanted, from + MAX_LINES - 1);
  const rows = all.slice(from - 1, to).map((text, k) => `<span class="ln">${from + k}</span>${escapeHtml(text)}`).join('\n');
  const note = [to < wanted ? L.truncated : '', decoded.encoding !== 'utf-8' ? `${L.encoding}: ${decoded.encoding}` : ''].filter(Boolean).join(' ');
  return `<pre class="code numbered"><code>${rows}</code></pre>${note ? `<p class="muted">${escapeHtml(note)}</p>` : ''}`;
}

// ---------------------------------------------------------------- views

function findChange(root, name) {
  const active = path.join(root, 'openspec/changes', name);
  if (fs.existsSync(active)) return { dir: active, archived: false };
  const archive = path.join(root, 'openspec/changes/archive');
  let found = null;
  try {
    for (const entry of fs.readdirSync(archive).sort()) {
      if (entry === name || entry.endsWith(`-${name}`)) found = path.join(archive, entry);
    }
  } catch { /* none */ }
  return found ? { dir: found, archived: true } : null;
}

function reviewItems(text) {
  const items = { R: [], Q: [], C: [], other: [] };
  for (const box of checkboxes(text ?? '')) {
    const m = box.plain.match(/^([RQC])(\d+)\b\s*[.:)-]?\s*(.*)$/i);
    if (!m) { items.other.push({ id: '', done: box.done, title: box.body }); continue; }
    const kind = m[1].toUpperCase();
    const rest = box.body.replace(/^\W*[RQC]\d+\W*?\s*[.:)-]?\s*/i, '');
    const [title, decision] = rest.split(/\bdecision:/i);
    items[kind].push({ id: `${kind}${Number(m[2])}`, done: box.done, title: title.trim().replace(/:$/, ''), decision: decision?.trim() ?? null, key: norm(m[3]) });
  }
  return items;
}

const badge = (done, L) => `<span class="badge ${done ? 'ok' : 'todo'}">${done ? L.confirmed : L.open}</span>`;

function extractView(root, change, dir, L) {
  const review = readText(path.join(dir, 'review.md'));
  const items = reviewItems(review);
  const reviewer = review ? (stripComments(review).match(/^Reviewer:[ \t]*(.*)$/m)?.[1].trim() ?? '') : '';
  const trace = parseTrace(readText(path.join(dir, 'trace.md')));
  const specFiles = walk(path.join(dir, 'specs')).filter((f) => f.endsWith('.md'));
  const sections = [];

  const reqCards = [];
  let purpose = '';
  for (const file of specFiles) {
    const spec = parseSpec(readText(file) ?? '');
    purpose ||= spec.purpose;
    for (const req of spec.requirements) {
      const item = items.R.find((r) => r.key === norm(req.name));
      const done = item?.done ?? false;
      const t = trace.get(norm(req.name));
      const refs = t ? parseRefs(t.source) : [];
      const code = refs.map((ref) => `<details><summary>${escapeHtml(L.showCode)}: <code>${escapeHtml([ref.file, ref.symbol, ref.from ? `${ref.from}-${ref.to}` : ''].filter(Boolean).join(':'))}</code></summary>${snippet(root, ref, L)}</details>`).join('');
      const scenarios = req.scenarios.map((s) => `<div class="scenario"><div class="label">${escapeHtml(L.scenario)}</div><h4>${inline(s.name)}</h4>${markdown(s.body.join('\n'))}</div>`).join('');
      reqCards.push(`<article class="card${done ? ' is-done' : ' is-open'}" id="${escapeHtml(item?.id ?? '')}">
<header><span class="id">${escapeHtml(item?.id ?? '—')}</span><h3>${inline(req.name)}</h3>${badge(done, L)}</header>
${markdown(req.body.join('\n'))}
${scenarios}
<div class="trace">${t ? `<dl><dt>${escapeHtml(L.source)}</dt><dd>${inline(t.source)}</dd><dt>${escapeHtml(L.tests)}</dt><dd>${inline(t.tests || '—')}</dd></dl>${code}` : `<p class="warn">${escapeHtml(L.noTrace)}</p>`}</div>
</article>`);
    }
  }

  const qCards = items.Q.map((q) => `<article class="card${q.done ? ' is-done' : ' is-open'}" id="${escapeHtml(q.id)}">
<header><span class="id">${escapeHtml(q.id)}</span><h3>${inline(q.title)}</h3>${badge(q.done, L)}</header>
<p class="decision"><span class="label">${escapeHtml(L.decision)}</span> ${q.decision ? inline(q.decision) : `<span class="muted">${escapeHtml(L.noDecision)}</span>`}</p>
</article>`).join('\n');
  const questions = readText(path.join(dir, 'questions.md'));
  const coverage = [...items.C, ...items.other].map((c) => `<li class="task ${c.done ? 'done' : 'open'}"><span class="box">${c.done ? '✓' : ''}</span>${c.id ? `<strong>${escapeHtml(c.id)}</strong> ` : ''}${inline(c.title)}</li>`).join('');

  const all = [...items.R, ...items.Q, ...items.C, ...items.other];
  const done = all.filter((x) => x.done).length;
  sections.push({ id: 'overview', title: L.overview, html: `
<div class="stats">
  <div class="stat"><div class="num">${done}<span>/ ${all.length}</span></div><div class="label">${escapeHtml(L.progress)}</div><div class="bar"><i style="width:${all.length ? Math.round((done / all.length) * 100) : 0}%"></i></div></div>
  <div class="stat"><div class="num">${reqCards.length}</div><div class="label">${escapeHtml(L.requirements)}</div></div>
  <div class="stat"><div class="num">${items.Q.length}</div><div class="label">${escapeHtml(L.questions)}</div></div>
  <div class="stat"><div class="num small">${reviewer && !/^<.*>$/.test(reviewer) ? inline(reviewer) : escapeHtml(L.notNamed)}</div><div class="label">${escapeHtml(L.reviewer)}</div></div>
</div>
${purpose.trim() ? `<h3>${escapeHtml(L.purpose)}</h3>${markdown(purpose)}` : ''}` });
  sections.push({ id: 'requirements', title: L.requirements, html: reqCards.join('\n') });
  sections.push({ id: 'questions', title: L.questions, html: `${qCards}${questions ? `<div class="doc">${markdown(questions, { headingOffset: 2 })}</div>` : ''}` });
  if (coverage) sections.push({ id: 'coverage', title: L.coverage, html: `<ul class="checklist">${coverage}</ul>` });

  const shown = new Set(['review.md', 'trace.md', 'questions.md']);
  for (const file of walk(dir).filter((f) => f.endsWith('.md') && !f.startsWith(path.join(dir, 'specs')))) {
    const rel = path.relative(dir, file).replace(/\\/g, '/');
    if (shown.has(rel)) continue;
    sections.push({ id: `doc-${rel.replace(/[^\w-]/g, '-')}`, title: rel.replace(/\.md$/, ''), html: `<div class="doc">${markdown(readText(file) ?? '', { headingOffset: 2 })}</div>` });
  }
  sections.push({ id: 'trace', title: 'trace', html: `<div class="doc">${markdown(readText(path.join(dir, 'trace.md')) ?? '', { headingOffset: 2 })}</div>` });
  return { sections, filterable: true };
}

function genericChangeView(dir) {
  return {
    sections: walk(dir).filter((f) => f.endsWith('.md')).map((file) => {
      const rel = path.relative(dir, file).replace(/\\/g, '/');
      return { id: `doc-${rel.replace(/[^\w-]/g, '-')}`, title: rel.replace(/\.md$/, ''), html: `<div class="doc">${markdown(readText(file) ?? '', { headingOffset: 2 })}</div>` };
    }),
    filterable: false,
  };
}

// ---------------------------------------------------------------- page

const CSS = `
:root{--bg:#f6f7f9;--panel:#fff;--ink:#1d2330;--muted:#5d6675;--line:#dfe3ea;--accent:#2457c5;--accent-soft:#e8eefb;
--ok:#1f7a4d;--ok-soft:#e4f4ea;--todo:#9a5b00;--todo-soft:#fdf1dc;--warn:#b42318;--code:#f1f3f6;
--sans:"Segoe UI","Yu Gothic UI","Meiryo","Hiragino Sans","Noto Sans JP",system-ui,sans-serif;
--mono:"Cascadia Mono",Consolas,"BIZ UDGothic","MS Gothic",ui-monospace,monospace}
@media (prefers-color-scheme:dark){:root{--bg:#14171c;--panel:#1c2028;--ink:#e6e9ef;--muted:#9aa3b2;--line:#2e3440;
--accent:#7ea6ff;--accent-soft:#22304d;--ok:#5fd08f;--ok-soft:#173526;--todo:#f0b45a;--todo-soft:#3a2c14;--warn:#ff7b72;--code:#232833}}
*{box-sizing:border-box}html{scroll-behavior:smooth}
body{margin:0;background:var(--bg);color:var(--ink);font:15px/1.7 var(--sans)}
.top{position:sticky;top:0;z-index:2;background:var(--panel);border-bottom:1px solid var(--line)}
.top .in{max-width:1080px;margin:0 auto;padding:12px 16px;display:flex;flex-wrap:wrap;gap:8px 16px;align-items:center}
.top h1{font-size:17px;margin:0;font-weight:650}.top .meta{color:var(--muted);font-size:13px}
nav{display:flex;gap:4px;flex-wrap:wrap;width:100%}nav a{font-size:13px;padding:3px 10px;border-radius:999px;color:var(--ink);text-decoration:none;border:1px solid var(--line)}
nav a:hover{background:var(--accent-soft)}
.filter{margin-left:auto;font-size:13px;color:var(--muted);display:flex;gap:6px;align-items:center}
main{max-width:1080px;margin:0 auto;padding:16px}
section{margin:0 0 32px}section>h2{font-size:20px;margin:24px 0 12px;padding-bottom:6px;border-bottom:2px solid var(--line)}
.card{background:var(--panel);border:1px solid var(--line);border-left:4px solid var(--todo);border-radius:8px;padding:14px 16px;margin:0 0 14px}
.card.is-done{border-left-color:var(--ok)}
.card header{display:flex;gap:10px;align-items:baseline;flex-wrap:wrap}.card h3{font-size:16px;margin:0;flex:1 1 240px}
.id{font:600 13px var(--mono);color:var(--accent);background:var(--accent-soft);padding:1px 8px;border-radius:4px}
.badge{font-size:12px;padding:1px 10px;border-radius:999px;white-space:nowrap}.badge.ok{background:var(--ok-soft);color:var(--ok)}.badge.todo{background:var(--todo-soft);color:var(--todo)}
.scenario{background:var(--bg);border:1px solid var(--line);border-radius:6px;padding:8px 12px;margin:10px 0}
.scenario h4{margin:0 0 4px;font-size:14px}.scenario ul{margin:4px 0;padding-left:20px}
.label{font-size:11px;letter-spacing:.04em;color:var(--muted);text-transform:uppercase}
.trace{margin-top:10px;font-size:13px}.trace dl{display:grid;grid-template-columns:max-content 1fr;gap:2px 12px;margin:0}
.trace dt{color:var(--muted)}.trace dd{margin:0;word-break:break-all}
details{margin-top:8px}summary{cursor:pointer;color:var(--accent);font-size:13px}
.code{background:var(--code);border-radius:6px;padding:10px 12px;overflow:auto;font:13px/1.55 var(--mono);margin:8px 0;tab-size:4}
.numbered .ln{display:inline-block;width:3.5em;margin-right:12px;color:var(--muted);text-align:right;user-select:none}
code{font-family:var(--mono);font-size:.92em;background:var(--code);padding:0 4px;border-radius:3px}pre code{background:none;padding:0}
.decision{margin:8px 0 0}.muted{color:var(--muted);font-size:13px}.warn{color:var(--warn);font-size:13px}
.stats{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:12px}
.stat{background:var(--panel);border:1px solid var(--line);border-radius:8px;padding:12px 14px}
.stat .num{font-size:26px;font-weight:650}.stat .num span{font-size:15px;color:var(--muted);margin-left:4px}.stat .num.small{font-size:16px;padding:6px 0}
.bar{height:6px;background:var(--line);border-radius:3px;margin-top:6px;overflow:hidden}.bar i{display:block;height:100%;background:var(--ok)}
.doc{background:var(--panel);border:1px solid var(--line);border-radius:8px;padding:6px 18px}
.doc h3{font-size:16px}.doc h4{font-size:15px}
.table{overflow-x:auto}table{border-collapse:collapse;width:100%;font-size:14px;margin:8px 0}
th,td{border:1px solid var(--line);padding:6px 10px;text-align:left;vertical-align:top}th{background:var(--bg);font-weight:600}
ul.checklist{list-style:none;padding:0}li.task{list-style:none;display:flex;gap:8px;align-items:flex-start;margin:4px 0}
ul:has(>li.task){padding-left:0}
.box{flex:none;width:18px;height:18px;margin-top:3px;border:2px solid var(--todo);border-radius:4px;font-size:12px;line-height:14px;text-align:center;color:#fff}
li.done .box{background:var(--ok);border-color:var(--ok)}
blockquote{margin:8px 0;padding:2px 14px;border-left:3px solid var(--line);color:var(--muted)}
img{max-width:100%;height:auto;border:1px solid var(--line);border-radius:6px}
a{color:var(--accent)}hr{border:0;border-top:1px solid var(--line)}
footer{max-width:1080px;margin:0 auto;padding:8px 16px 40px;color:var(--muted);font-size:13px}
body.only-open .is-done{display:none}
@media print{.top{position:static}.filter{display:none}details{display:block}details>*{display:block}body{background:#fff}}
`;

const SCRIPT = `document.getElementById('only-open')?.addEventListener('change',e=>document.body.classList.toggle('only-open',e.target.checked));`;

export function page({ title, meta, sections, filterable, L, lang }) {
  const nav = sections.map((s) => `<a href="#${escapeHtml(s.id)}">${escapeHtml(s.title)}</a>`).join('');
  const body = sections.map((s) => `<section id="${escapeHtml(s.id)}"><h2>${escapeHtml(s.title)}</h2>\n${s.html}\n</section>`).join('\n');
  return `<!doctype html>
<html lang="${lang}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="generator" content="spec-relay render.mjs">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; img-src 'self' data: file:">
<title>${escapeHtml(title)}</title>
<style>${CSS}</style>
</head>
<body>
<div class="top"><div class="in">
<h1>${escapeHtml(title)}</h1><span class="meta">${escapeHtml(meta)}</span>
${filterable ? `<label class="filter"><input type="checkbox" id="only-open"> ${escapeHtml(L.onlyOpen)}</label>` : ''}
<nav>${nav}</nav>
</div></div>
<main>
${body}
</main>
<footer>${escapeHtml(L.note)}</footer>
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

export function render({ root = process.cwd(), change, file, out, lang, now = new Date() }) {
  const code = pickLang(root, lang);
  const L = LABELS[code];
  const stamp = `${L.generated} ${now.toISOString().slice(0, 16).replace('T', ' ')} UTC`;
  let html;
  let target = out;
  if (change) {
    const found = findChange(root, change);
    if (!found) return { ok: false, problems: [`change not found: ${change}`] };
    const schema = readText(path.join(found.dir, '.openspec.yaml'))?.match(/^schema:\s*(\S+)/m)?.[1] ?? '';
    const view = schema === 'spec-relay-extract' || fs.existsSync(path.join(found.dir, 'review.md'))
      ? extractView(root, change, found.dir, L) : genericChangeView(found.dir);
    const meta = [schema, found.archived ? L.archived : '', stamp].filter(Boolean).join(' · ');
    html = page({ title: change, meta, ...view, L, lang: code });
    target ??= path.join(root, 'openspec/spec-relay/views', `${change}.html`);
  } else if (file) {
    const text = readText(path.resolve(root, file));
    if (text === null) return { ok: false, problems: [`file not found: ${file}`] };
    const name = path.basename(file).replace(/\.md$/i, '');
    html = page({ title: name, meta: stamp, sections: [{ id: 'doc', title: name, html: `<div class="doc">${markdown(text, { headingOffset: 2 })}</div>` }], filterable: false, L, lang: code });
    target ??= path.join(root, 'openspec/spec-relay/views', `${name}.html`);
  } else return { ok: false, problems: ['pass --change NAME or --file PATH'] };

  const resolved = path.resolve(root, target);
  fs.mkdirSync(path.dirname(resolved), { recursive: true });
  const views = path.resolve(root, 'openspec/spec-relay/views');
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

