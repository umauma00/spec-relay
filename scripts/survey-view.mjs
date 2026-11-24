// The survey's review page, drawn from its tables: each context as a card with
// its connections, data and files; the map items (M1-M5, C1, D) with the very
// material they ask about (a diagram of the relationships, a table of the data
// and its contexts, the capability list, the carried and the excluded files);
// and the inventory as counts with every row one click away.
//
// Everything is computed from the Markdown by this script, so every model and
// every host draws the same picture. Nothing here decides anything: the person
// reads, compares and ticks review.md.
import { headedRows, inventoryRows, section, plain } from './gate.mjs';
import { escapeHtml, inline, markdown } from './render.mjs';

const WORDS = {
  ja: {
    fields: { name: '名前', type: '種類', responsibility: '責務', 'owned data': '所有データ', 'entry points': '入口', evidence: '根拠' },
    types: { core: '中核', supporting: '補助', generic: '汎用' },
    connections: 'つながり', upstream: '上流（使う相手）', downstream: '下流（使われる相手）', none: 'なし',
    data: 'データ', owns: '所有', writes: '書く', reads: '読む', alsoWrite: 'ほかにも書く', readBy: '読む',
    files: 'ファイル', fileCount: (port, carry) => `移行 ${port}・そのまま持っていく（carry）${carry}`, showFiles: (n) => `ファイルを表示（${n} 件）`,
    capabilities: 'capability', more: (n) => `ほか ${n} 件を表示`,
    diagram: (n, e) => `コンテキスト ${n} 個とつながり ${e} 本の図`,
    legend: [['call', '呼び出し'], ['table', 'テーブルを共有'], ['event', 'イベント・ファイル']],
    relHead: ['上流', '下流', 'パターン', '経路'], noRelations: 'context-map.md の Relationships に行がありません。',
    dataHead: 'データ', manyWriters: '複数が書き込む', noShared: 'context-map.md の Shared data に行がありません。',
    order: '順番', capHead: ['capability', '名前', '元コード'], noCaps: 'capabilities.md に capability がありません。',
    carryHead: ['パス', 'コンテキスト', '備考'], noCarry: 'carry のファイルはありません。',
    excludedHead: ['パス', '理由'], noExcluded: '移行しない（excluded）ファイルはありません。', noReason: '理由がありません',
    conflicts: '用語の衝突', noConflicts: 'glossary.md に Conflicts の節がありません。',
    noDatabase: 'database.md に同じ名前のデータベースがありません。', logic: 'データベースの中のロジック', missing: '読めなかった定義',
    invSummary: (rows) => `inventory の行 ${rows}（パスの数）。コンテキストごとの数は下の表、すべての行は「すべての行を表示」で開きます。`,
    invHead: ['コンテキスト', '移行（port）', 'そのまま（carry）', '計'], excluded: '移行しない（excluded）', allRows: (n) => `すべての行を表示（${n} 行）`,
    total: '計',
  },
  en: {
    fields: { name: 'Name', type: 'Type', responsibility: 'Responsibility', 'owned data': 'Owned data', 'entry points': 'Entry points', evidence: 'Evidence' },
    types: {},
    connections: 'Connections', upstream: 'Upstream (it uses)', downstream: 'Downstream (uses it)', none: 'none',
    data: 'Data', owns: 'owns', writes: 'writes', reads: 'reads', alsoWrite: 'also written by', readBy: 'read by',
    files: 'Files', fileCount: (port, carry) => `${port} to port, ${carry} to carry`, showFiles: (n) => `Show the files (${n})`,
    capabilities: 'Capabilities', more: (n) => `Show ${n} more`,
    diagram: (n, e) => `Diagram of ${n} contexts and ${e} connections`,
    legend: [['call', 'call'], ['table', 'shared table'], ['event', 'event or file']],
    relHead: ['Upstream', 'Downstream', 'Pattern', 'Channel'], noRelations: 'context-map.md has no row under Relationships.',
    dataHead: 'Data', manyWriters: 'several write it', noShared: 'context-map.md has no row under Shared data.',
    order: 'Order', capHead: ['Capability', 'Name', 'Source'], noCaps: 'capabilities.md lists no capability.',
    carryHead: ['Path', 'Context', 'Notes'], noCarry: 'No file is marked carry.',
    excludedHead: ['Path', 'Reason'], noExcluded: 'No file is excluded.', noReason: 'no reason',
    conflicts: 'Glossary conflicts', noConflicts: 'glossary.md has no Conflicts section.',
    noDatabase: 'database.md has no database of this name.', logic: 'Logic in the database', missing: 'Missing definitions',
    invSummary: (rows) => `${rows} inventory rows (paths). The table counts them per context; "Show every row" opens the list.`,
    invHead: ['Context', 'Port', 'Carry', 'Total'], excluded: 'excluded', allRows: (n) => `Show every row (${n})`,
    total: 'Total',
  },
};

const stripComments = (text) => String(text ?? '').replace(/<!--[\s\S]*?-->/g, '');
const key = (s) => plain(String(s)).toLowerCase();
// A cell as text, keeping underscores (table names) that plain() would drop.
const clean = (s) => stripComments(s).replace(/`/g, '').replace(/\*\*/g, '').trim();
const table = (head, rows, cls = '') => `<div class="table"><table${cls ? ` class="${cls}"` : ''}><thead><tr>${head.map((h) => `<th>${escapeHtml(h)}</th>`).join('')}</tr></thead><tbody>${rows.join('')}</tbody></table></div>`;
const cell = (row, pattern, fallback) => { const i = row.header.findIndex((h) => pattern.test(h)); return (row.cells[i >= 0 ? i : fallback] ?? '').trim(); };
// A cell that lists contexts: "billing, order", "billing、order", "billing<br>order".
const ids = (text) => plain(stripComments(text).replace(/\([^)]*\)|（[^）]*）/g, ' ')).split(/[,、;／/]|<br\s*\/?>|\s+and\s+/i).map((s) => s.trim().toLowerCase()).filter((s) => s && !/^(-|—|none|なし|n\/a)$/.test(s));

// Splits a value at its top-level separators (not inside brackets or code).
function topLevel(text) {
  const parts = [];
  let depth = 0;
  let code = false;
  let cur = '';
  for (const ch of String(text)) {
    if (ch === '`') code = !code;
    if (!code && '(（[「'.includes(ch)) depth += 1;
    if (!code && ')）]」'.includes(ch)) depth = Math.max(0, depth - 1);
    if (!code && depth === 0 && '、,;；'.includes(ch)) { if (cur.trim()) parts.push(cur.trim()); cur = ''; continue; }
    cur += ch;
  }
  if (cur.trim()) parts.push(cur.trim().replace(/[。.]$/, ''));
  return parts;
}

// "- **Owned data**: ..." lines of a context block as { field: value }, with
// continuation lines joined. Null when the block holds anything else (a
// paragraph, a nested list, a table): the card then shows the block as written,
// so nothing the analyst wrote is hidden from the reviewer.
export function contextFields(body) {
  const fields = {};
  let last = null;
  for (const line of stripComments(body.join('\n')).split(/\r?\n/)) {
    if (!line.trim()) { last = null; continue; }
    // "- **Key**: value", "- **Key:** value", "- Key: value" (a known key only).
    const m = line.match(/^[-*+]\s+(\*\*|__)(.+?)\1\s*(.*)$/);
    let key = null;
    let value = null;
    if (m && (/[:：]\s*$/.test(m[2]) || /^[:：]/.test(m[3]))) { key = m[2].replace(/[:：]\s*$/, ''); value = m[3].replace(/^[:：]\s*/, ''); }
    else {
      const p = line.match(/^[-*+]\s+([^:：`*_]+?)\s*[:：]\s*(.*)$/);
      if (p && Object.values(FIELD_KEYS).some((re) => re.test(p[1].trim().toLowerCase()))) { key = p[1]; value = p[2]; }
    }
    if (key !== null) { last = key.trim().toLowerCase(); fields[last] = value.trim(); continue; }
    // A continuation of the value above, never a list of its own.
    if (last && /^\s+\S/.test(line) && !/^\s+(?:[-*+]|\d+[.)])\s/.test(line)) { fields[last] += ` ${line.trim()}`; continue; }
    return null;
  }
  return fields;
}

const FIELD_KEYS = {
  name: /^(name|名前|名称)$/, type: /^(type|種類|種別)$/, responsibility: /^(responsibility|責務)$/,
  'owned data': /^(owned data|所有データ)$/, 'entry points': /^(entry points?|入口)$/, evidence: /^(evidence|根拠)$/,
};
const field = (fields, name) => { const k = Object.keys(fields).find((f) => FIELD_KEYS[name].test(f)); return k ? fields[k] : ''; };

// Everything the survey's pages need, read once per page.
export function surveyFacts({ contexts, mapText, inventoryText, capabilitiesText, glossaryText, databaseText }) {
  const rel = headedRows(section(mapText ?? '', /^relationships$/i) ?? '').map((r) => ({
    up: key(cell(r, /^(upstream|上流)/, 0)), down: key(cell(r, /^(downstream|下流)/, 1)), pattern: cell(r, /^(pattern|パターン)/, 2), channel: cell(r, /^(channel|経路|チャネル)/, 3),
  })).filter((r) => r.up && r.down && !/^</.test(r.up));
  const shared = headedRows(section(mapText ?? '', /^shared data$/i) ?? '').map((r) => ({
    data: cell(r, /^(data|データ)/, 0), owner: ids(cell(r, /^(owner|所有)/, 1)), writers: ids(cell(r, /^(also written|ほかに書|書き込)/, 2)), readers: ids(cell(r, /^(read|読)/, 3)),
  })).filter((r) => plain(stripComments(r.data)));
  const inventory = inventoryRows(inventoryText ?? '');
  // capabilities.md: "### <context>" then "1. `context/name` Name" with source lines under it.
  const caps = [];
  let ctx = '';
  for (const line of stripComments(capabilitiesText ?? '').split(/\r?\n/)) {
    const h = line.match(/^###\s+(.*?)\s*$/);
    if (h) { ctx = key(h[1]); continue; }
    const m = line.match(/^ ?(?:[-*+]|\d+[.)])\s+`([^`]+)`\s*(.*)$/);
    if (m) { caps.push({ context: ctx || key(m[1].split('/')[0]), path: m[1], name: m[2].trim(), sources: [] }); continue; }
    const s = line.match(/^\s+[-*+]\s+(.*)$/);
    if (s && caps.length) caps[caps.length - 1].sources.push(s[1].trim());
  }
  const conflicts = section(glossaryText ?? '', /^conflicts|衝突/i);
  const databases = headedRows(section(databaseText ?? '', /^databases$|^データベース$/i) ?? '');
  const logic = section(databaseText ?? '', /^logic in the database|^データベースの中のロジック/i);
  const missing = section(databaseText ?? '', /^missing definitions|^読めなかった定義/i);
  return { contexts: contexts.map((c) => ({ id: key(c.name), body: c.body, fields: contextFields(c.body) })), rel, shared, inventory, caps, conflicts, databases, logic, missing };
}

// A list that shows its first few entries and folds the rest.
function folded(entries, W, first = 5) {
  if (entries.length <= first + 1) return `<ul class="flat">${entries.map((e) => `<li>${e}</li>`).join('')}</ul>`;
  return `<ul class="flat">${entries.slice(0, first).map((e) => `<li>${e}</li>`).join('')}</ul><details class="more"><summary>${escapeHtml(W.more(entries.length - first))}</summary><ul class="flat">${entries.slice(first).map((e) => `<li>${e}</li>`).join('')}</ul></details>`;
}

const chip = (id) => `<span class="ctx-chip">${escapeHtml(id)}</span>`;

// One context as a card: what it says (responsibility, owned data, entry points,
// evidence) next to what the tables say about it (connections, data, files).
export function contextCard(facts, item, code) {
  const W = WORDS[code === 'ja' ? 'ja' : 'en'];
  const ctx = facts.contexts.find((c) => c.id === key(item.name)) ?? { id: key(item.name), fields: contextFields(item.body), body: item.body };
  const f = ctx.fields ?? {};
  const type = plain(field(f, 'type')).toLowerCase();
  const said = [];
  const name = field(f, 'name');
  if (name) said.push([W.fields.name, inline(name)]);
  if (type) said.push([W.fields.type, `<span class="ctx-type t-${escapeHtml(type.replace(/[^a-z]/g, ''))}">${escapeHtml(W.types[type] ? `${W.types[type]}（${type}）` : type)}</span>`]);
  const resp = field(f, 'responsibility');
  if (resp) said.push([W.fields.responsibility, `<span class="resp">${inline(resp)}</span>`]);
  const owned = field(f, 'owned data');
  if (owned) said.push([W.fields['owned data'], inline(owned)]);
  const entries = field(f, 'entry points');
  if (entries) { const parts = topLevel(entries); said.push([W.fields['entry points'], parts.length > 2 ? folded(parts.map(inline), W) : inline(entries)]); }
  const evidence = field(f, 'evidence');
  if (evidence) said.push([W.fields.evidence, inline(evidence)]);
  // Fields the card does not know stay too (an analyst may add one).
  for (const [k, v] of Object.entries(f)) if (!Object.values(FIELD_KEYS).some((re) => re.test(k)) && v) said.push([k, inline(v)]);
  // Anything but plain fields: the block as written, beside the same facts.
  const asWritten = ctx.fields === null || !said.length ? `<div class="doc">${markdown(item.body.join('\n'), { headingOffset: 2 })}</div>` : null;

  const up = facts.rel.filter((r) => r.down === ctx.id && r.up !== ctx.id);
  const down = facts.rel.filter((r) => r.up === ctx.id && r.down !== ctx.id);
  const how = (r) => [r.pattern, r.channel].map(clean).filter(Boolean).join(' · ');
  const link = (other, r) => `<li>${chip(other)}${how(r) ? ` <span class="sub">${escapeHtml(how(r))}</span>` : ''}</li>`;
  const owns = facts.shared.filter((s) => s.owner.includes(ctx.id));
  const writes = facts.shared.filter((s) => s.writers.includes(ctx.id));
  const reads = facts.shared.filter((s) => s.readers.includes(ctx.id));
  const dataLine = (label, list, extra) => (list.length ? `<li><span class="sub">${escapeHtml(label)}</span> ${list.map((s) => `${inline(s.data)}${extra ? extra(s) : ''}`).join('、')}</li>` : '');
  const others = (s) => { const o = s.writers.filter((x) => x !== ctx.id); return o.length ? ` <span class="sub">（${escapeHtml(W.alsoWrite)}: ${o.map(escapeHtml).join(', ')}）</span>` : ''; };
  const files = facts.inventory.filter((r) => r.context === ctx.id);
  const caps = facts.caps.filter((c) => c.context === ctx.id);
  const side = (label, list, other) => `<dt>${escapeHtml(label)}</dt><dd>${list.length ? `<ul class="plain-list">${list.map((r) => link(other(r), r)).join('')}</ul>` : `<span class="sub">${escapeHtml(W.none)}</span>`}</dd>`;
  const connections = facts.rel.length ? `${side(W.upstream, up, (r) => r.up)}${side(W.downstream, down, (r) => r.down)}` : '';
  const data = owns.length + writes.length + reads.length ? `<dt>${escapeHtml(W.data)}</dt><dd><ul class="plain-list">${dataLine(W.owns, owns, others)}${dataLine(W.writes, writes)}${dataLine(W.reads, reads)}</ul></dd>` : '';
  const capList = caps.length ? `<dt>${escapeHtml(W.capabilities)}</dt><dd><ol class="flat">${caps.map((c) => `<li><code>${escapeHtml(c.path)}</code> ${inline(c.name)}</li>`).join('')}</ol></dd>` : '';
  const fileList = files.length ? `<dt>${escapeHtml(W.files)}</dt><dd>${escapeHtml(W.fileCount(files.filter((r) => r.handling !== 'carry').length, files.filter((r) => r.handling === 'carry').length))}<details class="more"><summary>${escapeHtml(W.showFiles(files.length))}</summary><ul class="flat mono">${files.map((r) => `<li>${escapeHtml(r.path)}${r.handling === 'carry' ? ' <span class="sub">carry</span>' : ''}</li>`).join('')}</ul></details></dd>` : '';
  return `<div class="ctx-card">
${asWritten ?? `<dl class="ctx-said">${said.map(([k, v]) => `<dt>${escapeHtml(k)}</dt><dd>${v}</dd>`).join('')}</dl>`}
${connections || data || capList || fileList ? `<dl class="ctx-facts">${connections}${data}${capList}${fileList}</dl>` : ''}
</div>`;
}

// ---------------------------------------------------------------- the relationships diagram

const channelKind = (channel) => (/table|テーブル|db|database|データベース|共有/i.test(channel) ? 'table' : /event|イベント|file|ファイル|queue|キュー|message/i.test(channel) ? 'event' : 'call');

// Contexts in columns from upstream (left) to downstream (right): each column is
// the longest chain of upstreams before it. An edge that skips columns goes through
// a slot of its own in each column it crosses, so it never runs under a box. An edge
// that points back (a cycle) is laid out the other way and drawn with its arrow at
// the start. Same input, same picture.
export function relationsSvg(facts, code) {
  const W = WORDS[code === 'ja' ? 'ja' : 'en'];
  const order = [...facts.contexts.map((c) => c.id)];
  for (const r of facts.rel) for (const id of [r.up, r.down]) if (!order.includes(id)) order.push(id);
  if (!order.length || !facts.rel.length) return '';
  const edges = [];
  const seenEdge = new Set();
  for (const r of facts.rel) {
    const k = `${r.up}\0${r.down}`;
    if (r.up === r.down || seenEdge.has(k)) continue;
    seenEdge.add(k);
    edges.push(r);
  }
  // Back edges (a cycle) are found by a walk in map order and left out of the columns.
  const state = new Map();
  const back = new Set();
  const visit = (n) => {
    state.set(n, 1);
    for (const e of edges.filter((x) => x.up === n)) {
      if (state.get(e.down) === 1) back.add(e);
      else if (!state.has(e.down)) visit(e.down);
    }
    state.set(n, 2);
  };
  for (const n of order) if (!state.has(n)) visit(n);
  const forward = edges.filter((e) => !back.has(e));
  const layer = new Map();
  const depth = (n, seen = new Set()) => {
    if (layer.has(n)) return layer.get(n);
    if (seen.has(n)) return 0;
    seen.add(n);
    const ups = forward.filter((e) => e.down === n).map((e) => depth(e.up, seen) + 1);
    const d = ups.length ? Math.max(...ups) : 0;
    layer.set(n, d);
    return d;
  };
  order.forEach((n) => depth(n));
  const cols = [];
  for (const n of order) { const d = layer.get(n); (cols[d] ??= []).push(n); }
  for (let c = 0; c < cols.length; c += 1) cols[c] ??= [];
  // Each edge as a chain from its left end to its right end, with a slot in every
  // column between. A back edge runs from its downstream (left) to its upstream.
  const dummy = new Set();
  const pred = new Map(), succ = new Map();
  const link = (a, b) => { (succ.get(a) ?? succ.set(a, []).get(a)).push(b); (pred.get(b) ?? pred.set(b, []).get(b)).push(a); };
  const chains = edges.map((e, i) => {
    const rev = back.has(e);
    const [a, b] = rev ? [e.down, e.up] : [e.up, e.down];
    const chain = [a];
    for (let c = layer.get(a) + 1; c < layer.get(b); c += 1) {
      const d = `\0${i}:${c}`;
      dummy.add(d);
      cols[c].push(d);
      chain.push(d);
    }
    chain.push(b);
    for (let k = 1; k < chain.length; k += 1) link(chain[k - 1], chain[k]);
    return { e, rev, chain };
  });
  // Order each column by the average row of its neighbours, sweeping right then left.
  const rowOf = new Map();
  const first = new Map();
  cols.forEach((col) => col.forEach((n, i) => { rowOf.set(n, i); first.set(n, i); }));
  const sweep = (c, side) => {
    const col = cols[c];
    const score = (n) => { const ns = side.get(n) ?? []; return ns.length ? ns.reduce((s, m) => s + rowOf.get(m), 0) / ns.length : rowOf.get(n); };
    const scored = new Map(col.map((n) => [n, score(n)]));
    col.sort((a, b) => scored.get(a) - scored.get(b) || first.get(a) - first.get(b));
    col.forEach((n, i) => rowOf.set(n, i));
  };
  for (let pass = 0; pass < 3; pass += 1) {
    for (let c = 1; c < cols.length; c += 1) sweep(c, pred);
    for (let c = cols.length - 2; c >= 0; c -= 1) sweep(c, succ);
  }
  for (let c = 1; c < cols.length; c += 1) sweep(c, pred);
  const bw = 168, bh = 36, dh = 8, gx = 96, gy = 14, pad = 16;
  const tall = (n) => (dummy.has(n) ? dh : bh);
  const colHeight = (col) => col.reduce((s, n) => s + tall(n), 0) + Math.max(0, col.length - 1) * gy;
  const tallest = Math.max(...cols.map(colHeight));
  const height = pad * 2 + tallest;
  const width = pad * 2 + cols.length * bw + (cols.length - 1) * gx;
  const at = new Map();
  cols.forEach((col, c) => {
    let y = pad + (tallest - colHeight(col)) / 2;
    for (const n of col) { at.set(n, { x: pad + c * (bw + gx), y, cy: y + tall(n) / 2 }); y += tall(n) + gy; }
  });
  const short = (s, n) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
  const nameOf = (id) => plain(field(facts.contexts.find((c) => c.id === id)?.fields ?? {}, 'name') || '') || '';
  const title = (e) => `${e.up} → ${e.down}${clean(e.pattern) ? ` · ${clean(e.pattern)}` : ''}${clean(e.channel) ? ` · ${clean(e.channel)}` : ''}`;
  const curve = (x1, y1, x2, y2) => { const mid = (x1 + x2) / 2; return ` C${mid},${y1} ${mid},${y2} ${x2},${y2}`; };
  // Edges leave a box's right side and enter its left side at spread-out points,
  // ordered by where they go, so two edges between the same boxes do not overlap.
  const ports = new Map();
  const port = (n, side, i, other) => { const k = `${n}\0${side}`; (ports.get(k) ?? ports.set(k, []).get(k)).push({ i, other }); };
  chains.forEach(({ chain }, i) => { port(chain[0], 'out', i, chain[1]); port(chain.at(-1), 'in', i, chain.at(-2)); });
  const offset = new Map();
  for (const [k, list] of ports) {
    list.sort((a, b) => at.get(a.other).cy - at.get(b.other).cy || a.i - b.i);
    const step = list.length > 1 ? Math.min(6, (bh - 12) / (list.length - 1)) : 0;
    list.forEach(({ i }, j) => offset.set(`${k}\0${i}`, (j - (list.length - 1) / 2) * step));
  }
  const lines = chains.map(({ e, rev, chain }, i) => {
    const kind = channelKind(clean(e.channel));
    const p = at.get(chain[0]);
    let x = p.x + bw + (rev ? 2 : 0), y = p.cy + offset.get(`${chain[0]}\0out\0${i}`);
    let d = `M${x},${y}`;
    for (const n of chain.slice(1)) {
      const q = at.get(n);
      if (dummy.has(n)) {
        d += `${curve(x, y, q.x, q.cy)} L${q.x + bw},${q.cy}`;
        x = q.x + bw; y = q.cy;
      } else {
        d += curve(x, y, q.x - (rev ? 0 : 2), q.cy + offset.get(`${n}\0in\0${i}`));
      }
    }
    const arrow = rev ? 'marker-start="url(#rel-arrow)"' : 'marker-end="url(#rel-arrow)"';
    return `<path d="${d}" class="rel-edge rel-${kind}${rev ? ' rel-back' : ''}" ${arrow}><title>${escapeHtml(title(e))}</title></path>`;
  });
  const boxes = order.map((id) => {
    const p = at.get(id);
    const label = nameOf(id);
    return `<g><title>${escapeHtml(id)}${label ? ` — ${escapeHtml(label)}` : ''}</title><rect x="${p.x}" y="${p.y}" width="${bw}" height="${bh}" class="rel-box"/><text x="${p.x + 10}" y="${p.y + 15}" class="rel-id">${escapeHtml(short(id, 22))}</text>${label ? `<text x="${p.x + 10}" y="${p.y + 29}" class="rel-name">${escapeHtml(short(label, 13))}</text>` : ''}</g>`;
  });
  const legend = `<p class="rel-legend">${W.legend.map(([k, label]) => `<span><svg width="34" height="10" aria-hidden="true"><line x1="0" y1="5" x2="34" y2="5" class="rel-edge rel-${k}"/></svg>${escapeHtml(label)}</span>`).join('')}</p>`;
  return `<figure class="diagram rel"><svg viewBox="0 0 ${width} ${height}" style="max-width:${width}px;min-width:${Math.min(width, 520)}px" role="img" aria-label="${escapeHtml(W.diagram(order.length, edges.length))}" preserveAspectRatio="xMidYMin meet"><defs><marker id="rel-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0,0 L10,5 L0,10 z" class="rel-head"/></marker></defs>${lines.join('')}${boxes.join('')}</svg>${legend}</figure>`;
}

// ---------------------------------------------------------------- the map items

function relationsTable(facts, W) {
  if (!facts.rel.length) return `<p class="caution">${escapeHtml(W.noRelations)}</p>`;
  return table(W.relHead, facts.rel.map((r) => `<tr><td>${chip(r.up)}</td><td>${chip(r.down)}</td><td>${inline(stripComments(r.pattern))}</td><td>${inline(stripComments(r.channel))}</td></tr>`));
}

// Data down, contexts across: who owns, who else writes, who reads.
function sharedMatrix(facts, W) {
  if (!facts.shared.length) return `<p class="caution">${escapeHtml(W.noShared)}</p>`;
  const order = facts.contexts.map((c) => c.id);
  const used = [...new Set(facts.shared.flatMap((s) => [...s.owner, ...s.writers, ...s.readers]))];
  const cols = [...order.filter((id) => used.includes(id)), ...used.filter((id) => !order.includes(id))];
  const rows = facts.shared.map((s) => {
    const many = s.owner.length + s.writers.filter((w) => !s.owner.includes(w)).length > 1;
    return `<tr><th scope="row">${inline(stripComments(s.data))}${many ? `<span class="caution-inline">${escapeHtml(W.manyWriters)}</span>` : ''}</th>${cols.map((id) => {
      const what = s.owner.includes(id) ? 'owns' : s.writers.includes(id) ? 'writes' : s.readers.includes(id) ? 'reads' : '';
      return `<td class="m-${what || 'none'}">${what ? escapeHtml(W[what]) : ''}</td>`;
    }).join('')}</tr>`;
  });
  return `<div class="table"><table class="matrix"><thead><tr><th>${escapeHtml(W.dataHead)}</th>${cols.map((id) => `<th>${escapeHtml(id)}</th>`).join('')}</tr></thead><tbody>${rows.join('')}</tbody></table></div>`;
}

function capabilityTable(facts, W) {
  if (!facts.caps.length) return `<p class="caution">${escapeHtml(W.noCaps)}</p>`;
  return table([W.order, ...W.capHead], facts.caps.map((c, i) => `<tr><td class="num">${i + 1}</td><td><code>${escapeHtml(c.path)}</code></td><td>${inline(c.name)}</td><td>${c.sources.map(inline).join('<br>')}</td></tr>`));
}

const pathCell = (p) => `<td class="mono">${escapeHtml(p)}</td>`;

// The extra body of a survey review item: the material it asks the person to judge. '' when none.
export function surveyAid(facts, item, code, row = null) {
  const W = WORDS[code === 'ja' ? 'ja' : 'en'];
  if (item.id === 'M1') return `${relationsSvg(facts, code)}${relationsTable(facts, W)}`;
  if (item.id === 'M2') return sharedMatrix(facts, W);
  if (item.id === 'M3') return facts.conflicts === null ? `<p class="caution">${escapeHtml(W.noConflicts)}</p>` : `<div class="doc">${markdown(facts.conflicts, { headingOffset: 2 })}</div>`;
  if (item.id === 'M4') return capabilityTable(facts, W);
  if (item.id === 'M5') {
    const carry = facts.inventory.filter((r) => r.handling === 'carry');
    return carry.length ? table(W.carryHead, carry.map((r) => `<tr>${pathCell(r.path)}<td>${escapeHtml(r.context)}</td><td>${escapeHtml(r.notes)}</td></tr>`)) : `<p>${escapeHtml(W.noCarry)}</p>`;
  }
  if (item.id === 'C1') {
    const out = facts.inventory.filter((r) => r.context === 'excluded');
    return out.length ? table(W.excludedHead, out.map((r) => `<tr>${pathCell(r.path)}<td>${r.notes ? escapeHtml(r.notes) : `<span class="caution-inline">${escapeHtml(W.noReason)}</span>`}</td></tr>`)) : `<p>${escapeHtml(W.noExcluded)}</p>`;
  }
  if (item.id === 'D90') return facts.missing === null ? '' : `<div class="doc">${markdown(facts.missing, { headingOffset: 2 })}</div>`;
  if (item.letter === 'D') {
    const name = key(plain(item.title).split(/[:：]/)[0]);
    const db = facts.databases.find((r) => key(r.cells[0] ?? '') === name);
    const facts1 = db ? `<dl class="facts">${db.header.map((h, i) => (i === 0 ? '' : `<dt>${escapeHtml(h)}</dt><dd>${inline(stripComments(db.cells[i] ?? ''))}</dd>`)).join('')}</dl>` : `<p class="caution">${escapeHtml(W.noDatabase)}</p>`;
    return `${facts1}${facts.logic ? `<h4 class="aid-h">${escapeHtml(W.logic)}</h4><div class="doc">${markdown(facts.logic)}</div>` : ''}`;
  }
  return row ?? '';
}

// The inventory for the appendix: counts per context, every row folded.
export function inventorySummary(facts, text, code) {
  const W = WORDS[code === 'ja' ? 'ja' : 'en'];
  const rows = facts.inventory;
  const order = [...facts.contexts.map((c) => c.id), ...new Set(rows.map((r) => r.context).filter((c) => c !== 'excluded' && !facts.contexts.some((x) => x.id === c)))];
  const count = (ctx, h) => rows.filter((r) => r.context === ctx && (h === 'carry' ? r.handling === 'carry' : r.handling !== 'carry')).length;
  const body = order.map((ctx) => `<tr><td>${escapeHtml(ctx)}</td><td class="num">${count(ctx, 'port')}</td><td class="num">${count(ctx, 'carry')}</td><td class="num">${count(ctx, 'port') + count(ctx, 'carry')}</td></tr>`);
  const excluded = rows.filter((r) => r.context === 'excluded').length;
  if (excluded) body.push(`<tr><td>${escapeHtml(W.excluded)}</td><td></td><td></td><td class="num">${excluded}</td></tr>`);
  body.push(`<tr class="sum"><td>${escapeHtml(W.total)}</td><td class="num">${rows.filter((r) => r.context !== 'excluded' && r.handling !== 'carry').length}</td><td class="num">${rows.filter((r) => r.handling === 'carry').length}</td><td class="num">${rows.length}</td></tr>`);
  return `<div class="doc"><p>${escapeHtml(W.invSummary(rows.length))}</p>${table(W.invHead, body)}<details class="more"><summary>${escapeHtml(W.allRows(rows.length))}</summary>${markdown(text, { headingOffset: 2 })}</details></div>`;
}

export const SURVEY_CSS = `
.ctx-card{display:grid;grid-template-columns:minmax(0,1fr);gap:12px 32px}
@container (min-width:860px){.ctx-card{grid-template-columns:minmax(0,1.5fr) minmax(0,1fr)}}
.ctx-said,.ctx-facts{margin:0;display:grid;grid-template-columns:max-content minmax(0,1fr);gap:6px 14px;font-size:15px;align-content:start}
.ctx-said>dt,.ctx-facts>dt{font:600 12px/1.9 var(--ui);color:var(--ink2);letter-spacing:.04em}
.ctx-said>dd,.ctx-facts>dd{margin:0;min-width:0;overflow-wrap:anywhere}
.ctx-facts{padding:10px 14px;background:var(--desk);border-left:3px solid var(--rule);grid-template-columns:minmax(0,1fr);gap:2px}
.ctx-facts>dt{margin-top:6px}.ctx-facts>dt:first-child{margin-top:0}
ul.plain-list{list-style:none;margin:0;padding:0}ul.plain-list li{margin:2px 0;line-height:1.5}
.ctx-said .resp{font-size:16px}
.ctx-type{display:inline-block;font:600 12px/1.4 var(--ui);padding:1px 8px;border:1.5px solid var(--ink)}
.ctx-type.t-core{background:var(--ink);color:var(--paper)}
.ctx-type.t-generic{border-style:dashed}
.ctx-rel{margin:0;display:grid;grid-template-columns:max-content minmax(0,1fr);gap:2px 10px}
.ctx-rel dt{font-size:12px;color:var(--ink2)}.ctx-rel dd{margin:0}
.ctx-chip{display:inline-block;font:600 12px/1.5 var(--mono);padding:0 6px;border:1px solid var(--rule);background:var(--paper);white-space:nowrap}
ul.flat,ol.flat{margin:0;padding-left:1.2em}ul.flat li,ol.flat li{margin:1px 0}
ul.flat.mono{font:12px/1.6 var(--mono)}
.sub{font-size:12px;color:var(--ink2)}
details.more>summary{cursor:pointer;color:var(--ai);font-size:13px;margin-top:2px}
.diagram.rel{margin:12px 0 8px;overflow-x:auto}
.diagram.rel>svg{display:block;width:100%;height:auto}
.rel-box{fill:var(--paper);stroke:var(--ink);stroke-width:1.5}
.rel-id{font:700 12px var(--mono);fill:var(--ink)}
.rel-name{font:12px var(--ui);fill:var(--ink2)}
.rel-edge{fill:none;stroke:var(--ink2);stroke-width:1.4}
.rel-table{stroke-dasharray:6 4;stroke:var(--ochre);stroke-width:1.8}
.rel-event{stroke-dasharray:2 3}
.rel-head{fill:var(--ink2)}
.rel-legend{display:flex;flex-wrap:wrap;gap:4px 16px;margin:4px 0 0;font-size:12px;color:var(--ink2)}
.rel-legend span{display:inline-flex;gap:6px;align-items:center}
table.matrix td{text-align:center;min-width:4.5em;font-size:13px}
table.matrix th[scope=row]{font:400 14px/1.5 var(--read);color:var(--ink);letter-spacing:0;white-space:normal;border-bottom:1px solid var(--hair);min-width:10em}
table.matrix th:not([scope]){text-align:center}
table.matrix td.m-owns{font-weight:700;background:var(--desk)}
table.matrix td.m-writes{font-weight:600;color:var(--ochre)}
table.matrix td.m-reads{color:var(--ink2)}
.caution-inline{display:inline-block;margin-left:8px;font:600 12px/1.4 var(--ui);color:var(--ochre)}
.caution-inline::before{content:"△ "}
td.num{text-align:right;font-family:var(--mono)}
tr.sum td{font-weight:700;border-top:1.5px solid var(--ink)}
.aid-h{font-size:14px;margin:14px 0 4px}
`;
