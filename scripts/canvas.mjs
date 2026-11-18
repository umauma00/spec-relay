#!/usr/bin/env node
// The spec-relay canvas: the pages of render.mjs (progress, review pages, the
// approved specs) served to a Copilot canvas, so the person sees the work next
// to the chat and can ask about any item without copying it.
//
// This file holds everything but the Copilot SDK: the extension
// (com.github.copilot/extensions/spec-relay-canvas/extension.mjs) only wires it
// to joinSession. Run it alone to try the pages in a browser:
//
//   node canvas.mjs [--root DIR] [--lang ja|en]
//
// What it may do, and nothing more:
// - read the repository's Markdown and render it with render.mjs (same design);
// - serve image files that a page shows, from inside the repository;
// - pass a question the person typed to the chat, marked "[canvas]".
// It writes no file. It listens on 127.0.0.1 only, every path starts with a
// random token, the Host header must be the server's own, and a question must
// come from its own page (a custom header and, when sent, the same Origin).
import http from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { view, page, labels, escapeHtml, markdown, parseReview, capabilities, timeStamp } from './render.mjs';
import { status, checklist, stepLabel, stepName, STEPS } from './status.mjs';
import { language, changeSchema, archivedChange } from './gate.mjs';

export const VIEWS = 'openspec/spec-relay/views';

const WORDS = {
  ja: {
    kind: 'spec-relay', title: '移行の進み具合', now: 'いま', you: 'あなたの番です', agent: 'AI が作業しています',
    todo: 'やること', reviews: 'レビュー待ちの変更', change: '変更', schema: '種類', left: '未確認', open: '開く',
    byCapability: '機能ごと', capability: '機能', spec: '仕様', problems: '問題', none: 'ありません',
    nav: '画面', progress: '進み具合', specs: '仕様の一覧',
    ask: 'これを聞く', askPage: 'この画面について聞く', askTitle: 'チャットに質問を送る', askAbout: '対象',
    askHint: '聞きたいことを書いてください。チャットに「[canvas]」付きで届きます。承認や判断は、チャットで伝えるか review.md に書いてください。',
    send: '送る', cancel: 'やめる', sent: 'チャットに送りました。', failed: '送れませんでした',
    notRepo: 'このフォルダには openspec/ がありません。spec-relay を導入したリポジトリでチャットを開いてください。',
    note: 'この画面は表示用です。正は Markdown のファイルです。判断はチャットで伝えるか review.md に書きます。ファイルが変わると画面も変わります。',
    generated: '生成',
  },
  en: {
    kind: 'spec-relay', title: 'Migration progress', now: 'Now', you: 'Your turn', agent: 'The agent is working',
    todo: 'To do', reviews: 'Changes waiting for review', change: 'Change', schema: 'Kind', left: 'Open', open: 'Open',
    byCapability: 'By capability', capability: 'Capability', spec: 'Spec', problems: 'Problems', none: 'None',
    nav: 'Pages', progress: 'Progress', specs: 'Specs',
    ask: 'Ask about this', askPage: 'Ask about this page', askTitle: 'Send a question to the chat', askAbout: 'About',
    askHint: 'Write your question. It reaches the chat marked "[canvas]". Approvals and decisions go in the chat or in review.md.',
    send: 'Send', cancel: 'Cancel', sent: 'Sent to the chat.', failed: 'Could not send',
    notRepo: 'This folder has no openspec/. Open the chat in a repository where spec-relay is set up.',
    note: 'This page is a view. The Markdown files are the source of truth. Decisions go in the chat or in review.md. The page follows the files as they change.',
    generated: 'Generated',
  },
};

const changeKey = (capability) => capability.split('/').join('-');

// Active changes that have a review.md, with how many of their review items are open.
export function changesForReview(root) {
  const dir = path.join(root, 'openspec/changes');
  let names = [];
  try { names = fs.readdirSync(dir, { withFileTypes: true }).filter((e) => e.isDirectory() && e.name !== 'archive').map((e) => e.name).sort(); } catch { /* none */ }
  return names.flatMap((name) => {
    let text;
    try { text = fs.readFileSync(path.join(dir, name, 'review.md'), 'utf8'); } catch { return []; }
    const items = parseReview(text).flatMap((g) => g.items);
    let schema = '';
    try { schema = changeSchema(path.join(dir, name)); } catch { /* unknown */ }
    return [{ name, schema, total: items.length, open: items.filter((i) => !i.done).length }];
  });
}

// The first page: where the migration is, what waits for the person, and links
// to every review page and spec page.
export function progressPage({ root, lang, now = new Date() }) {
  const W = WORDS[lang];
  const meta = `${W.generated} ${timeStamp(now)}`;
  if (!fs.existsSync(path.join(root, 'openspec'))) {
    return page({ title: W.title, kind: W.kind, meta, brief: `<p class="caution">${escapeHtml(W.notRepo)}</p>`, L: labels(lang), note: W.note, lang, mode: 'read' });
  }
  const report = status(root, { language: lang });
  const specs = new Set(capabilities(root));
  const reviews = changesForReview(root);
  const here = report.current;
  const hereItem = here ? report.todoList.find((t) => t.key === (here.capability ? `${here.capability}:${here.step}` : here.step)) : null;
  const brief = `<header class="brief">
<div class="purpose"><span class="label">${escapeHtml(W.now)}</span><p>${escapeHtml(report.todoList[0]?.title ?? '')}</p>
${hereItem ? `<p class="next-step"><b>${escapeHtml(here.owner === 'person' ? W.you : W.agent)}</b> — ${escapeHtml(hereItem.title)}</p>` : ''}</div>
</header>`;
  const link = (href, text) => `<a href="${escapeHtml(href)}">${escapeHtml(text)}</a>`;
  const table = (head, rows) => `<div class="table"><table><thead><tr>${head.map((h) => `<th>${escapeHtml(h)}</th>`).join('')}</tr></thead><tbody>${rows.join('')}</tbody></table></div>`;
  const docs = [{ id: 'todo', title: W.todo, html: `<div class="doc">${markdown(checklist(report))}</div>` }];
  docs.push({ id: 'reviews', title: W.reviews, html: reviews.length
    ? table([W.change, W.schema, W.left, ''], reviews.map((r) => `<tr><td class="mono">${escapeHtml(r.name)}</td><td>${escapeHtml(r.schema.replace(/^spec-relay-/, ''))}</td><td>${r.open} / ${r.total}</td><td>${link(`${encodeURIComponent(r.name)}.html`, W.open)}</td></tr>`))
    : `<p>${escapeHtml(W.none)}</p>` });
  if (report.capabilities.length) {
    docs.push({ id: 'capabilities', title: W.byCapability, html: table([W.capability, ...STEPS.map((s) => stepName(lang, s.id)), W.spec], report.capabilities.map((c) => `<tr><td class="mono">${escapeHtml(c.capability)}</td>${STEPS.map((s) => `<td>${escapeHtml(stepLabel(lang, c.steps[s.id]))}</td>`).join('')}<td>${specs.has(c.capability) ? link(`spec-${encodeURIComponent(changeKey(c.capability))}.html`, W.open) : '—'}</td></tr>`)) });
  }
  if (report.problems.length) docs.push({ id: 'problems', title: W.problems, html: `<ul>${report.problems.map((p) => `<li>${escapeHtml(p)}</li>`).join('')}</ul>` });
  return page({ title: W.title, kind: W.kind, meta, brief, docs, L: labels(lang), note: W.note, lang, mode: 'read' });
}


// ---------------------------------------------------------------- the interactive layer

const CSP = "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; form-action 'none'; base-uri 'none'";

const CANVAS_CSS = `
.canvas-nav{margin:12px 0 0;display:flex;flex-wrap:wrap;gap:6px 14px;font-size:14px}
.canvas-nav a[aria-current]{color:var(--ink);font-weight:700;text-decoration:none}
.ask{font:600 13px/1.2 var(--ui);padding:6px 10px;border:1.5px solid var(--ai);background:var(--paper);color:var(--ai);cursor:pointer;min-height:32px}
.ask:hover{background:var(--ai);color:var(--paper)}
.ask-row{margin:10px 0 0}
@container (min-width:860px){.ask-row{padding-left:calc(3.1em + 26px)}}
.ask-page{margin-top:12px}
dialog.ask-box{border:2px solid var(--ink);padding:16px;max-width:min(560px,calc(100vw - 32px));width:100%;background:var(--paper);color:var(--ink);font-family:var(--ui)}
dialog.ask-box::backdrop{background:rgba(0,0,0,.35)}
.ask-box h2{margin:0 0 6px;font-size:16px}
.ask-box .about{margin:0 0 8px;font-size:13px;color:var(--ink2);overflow-wrap:anywhere}
.ask-box textarea{display:block;width:100%;min-height:7em;padding:8px;border:1.5px solid var(--ink);background:var(--paper);color:var(--ink);font:15px/1.6 var(--read);resize:vertical}
.ask-box .hint{font-size:12px;color:var(--ink2);margin:6px 0 10px}
.ask-box .buttons{display:flex;gap:8px;justify-content:flex-end}
.ask-box button{font:600 14px/1.2 var(--ui);padding:8px 14px;min-height:40px;border:1.5px solid var(--ink);background:var(--paper);color:var(--ink);cursor:pointer}
.ask-box button.primary{background:var(--ink);color:var(--paper)}
.ask-done{position:fixed;left:16px;right:16px;bottom:16px;max-width:420px;margin:0 auto;padding:10px 14px;background:var(--ink);color:var(--paper);font:600 14px/1.4 var(--ui);z-index:9}
@media print{.canvas-nav,.ask,.ask-row,dialog.ask-box,.ask-done{display:none!important}}
`;

// Runs in the canvas. The token is the first path segment; every other address is relative to it.
const CANVAS_SCRIPT = String.raw`(() => {
  const d = document, base = '/' + location.pathname.split('/')[1];
  const cfg = JSON.parse(d.getElementById('canvas-config').textContent);
  const box = d.getElementById('ask-box'), text = box.querySelector('textarea'), about = box.querySelector('.about');
  let target = null;
  const toast = (msg) => { const t = d.createElement('p'); t.className = 'ask-done'; t.setAttribute('role', 'status'); t.textContent = msg; d.body.appendChild(t); setTimeout(() => t.remove(), 4000); };
  const open = (item) => {
    target = item ? { anchor: item.id, label: (item.querySelector('.item-head .id') || {}).textContent || '', title: (item.querySelector('.item-head h3') || {}).textContent || '' } : null;
    about.textContent = cfg.words.askAbout + ': ' + cfg.title + (target ? ' — ' + target.label + ' ' + target.title : '');
    text.value = '';
    if (box.showModal) box.showModal(); else box.setAttribute('open', '');
    text.focus();
  };
  d.querySelectorAll('main .item').forEach((item) => {
    const row = d.createElement('p'); row.className = 'ask-row';
    const b = d.createElement('button'); b.type = 'button'; b.className = 'ask'; b.textContent = cfg.words.ask;
    b.addEventListener('click', () => open(item));
    row.appendChild(b); item.appendChild(row);
  });
  const pageAsk = d.getElementById('ask-page');
  if (pageAsk) pageAsk.addEventListener('click', () => open(null));
  box.querySelector('.cancel').addEventListener('click', () => box.close ? box.close() : box.removeAttribute('open'));
  box.querySelector('form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const question = text.value.trim();
    if (!question) { text.focus(); return; }
    try {
      const res = await fetch(base + '/ask', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Spec-Relay': 'ask' }, body: JSON.stringify({ page: cfg.page, title: cfg.title, item: target, question }) });
      if (!res.ok) throw new Error(String(res.status));
      box.close ? box.close() : box.removeAttribute('open');
      toast(cfg.words.sent);
    } catch (err) { toast(cfg.words.failed + ' (' + err.message + ')'); }
  });
  // Follow the files: reload when they change, go where the agent sent the canvas.
  let busy = false;
  setInterval(async () => {
    if (busy || d.hidden || (box.open)) return;
    busy = true;
    try {
      const res = await fetch(base + '/state', { cache: 'no-store' });
      const s = await res.json();
      if (s.goto && s.goto.seq > cfg.seq) location.href = base + '/r/' + s.goto.path;
      else if (s.version !== cfg.version) location.reload();
    } catch (err) { /* the session may have ended */ } finally { busy = false; }
  }, 2500);
})();`;

// Turns a page of render.mjs into a canvas page: a CSP that lets the page talk
// to this server only, links between the pages, and the ask buttons.
export function interactive(html, { lang, pagePath, title, version, seq }) {
  const W = WORDS[lang];
  const current = path.posix.basename(pagePath);
  const nav = `<nav class="canvas-nav" aria-label="${escapeHtml(W.nav)}"><a href="progress.html"${current === 'progress.html' ? ' aria-current="page"' : ''}>${escapeHtml(W.progress)}</a><a href="specs.html"${current === 'specs.html' ? ' aria-current="page"' : ''}>${escapeHtml(W.specs)}</a></nav>
<button type="button" class="ask ask-page" id="ask-page">${escapeHtml(W.askPage)}</button>`;
  const config = JSON.stringify({ page: pagePath, title, version, seq, words: { ask: W.ask, askAbout: W.askAbout, sent: W.sent, failed: W.failed } }).replace(/</g, '\\u003c');
  const dialog = `<dialog class="ask-box" id="ask-box" aria-labelledby="ask-title"><form method="dialog"><h2 id="ask-title">${escapeHtml(W.askTitle)}</h2><p class="about"></p>
<label class="vh" for="ask-text">${escapeHtml(W.askTitle)}</label><textarea id="ask-text" maxlength="4000"></textarea>
<p class="hint">${escapeHtml(W.askHint)}</p><div class="buttons"><button type="button" class="cancel">${escapeHtml(W.cancel)}</button><button type="submit" class="primary">${escapeHtml(W.send)}</button></div></form></dialog>
<script type="application/json" id="canvas-config">${config}</script>
<script>${CANVAS_SCRIPT}</script>`;
  return html
    .replace(/<meta http-equiv="Content-Security-Policy" content="[^"]*">/, `<meta http-equiv="Content-Security-Policy" content="${CSP}">`)
    .replace('</style>', `${CANVAS_CSS}</style>`)
    .replace(/(<p class="meta">[^<]*<\/p>)/, `$1\n${nav}`)
    .replace(/<\/body>\s*<\/html>\s*$/, `${dialog}\n</body>\n</html>\n`);
}

// The text the chat receives. It says where it came from and that it is a question.
export function askPrompt({ question, title, item, page: pagePath }, lang) {
  const q = String(question ?? '').trim().slice(0, 4000);
  const where = [String(title ?? '').slice(0, 200), item ? `${String(item.label ?? '').slice(0, 20)} ${String(item.title ?? '').slice(0, 300)}`.trim() : ''].filter(Boolean).join(' — ');
  const prompt = `[canvas] ${q}\n\n(${lang === 'ja' ? '対象' : 'About'}: ${where}; page ${String(pagePath ?? '').slice(0, 300)}. The person typed this question in the spec-relay canvas. Answer it in the chat. It is a question, not an approval: do not tick review.md, record a decision or archive because of it.)`;
  return { prompt, displayPrompt: `[canvas] ${q}${where ? `\n(${where})` : ''}` };
}

// ---------------------------------------------------------------- the server

const IMAGES = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.bmp': 'image/bmp' };

// A cheap signature of what the pages show: every file under openspec/changes
// (the archive by its folder names only) and openspec/specs, the config and the plan.
export function signature(root) {
  const h = crypto.createHash('sha1');
  const add = (file) => { try { const st = fs.statSync(file); h.update(`${file}\0${st.size}\0${st.mtimeMs}\n`); } catch { h.update(`${file}\0-\n`); } };
  const walk = (dir, skip) => {
    let entries = [];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }).sort((x, y) => (x.name < y.name ? -1 : x.name > y.name ? 1 : 0)); } catch { return; }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) { h.update(`${full}/\n`); if (full !== skip) walk(full, skip); } else add(full);
    }
  };
  const archive = path.join(root, 'openspec/changes/archive');
  walk(path.join(root, 'openspec/changes'), archive);
  try { h.update(fs.readdirSync(archive).sort().join('\n')); } catch { /* none */ }
  walk(path.join(root, 'openspec/specs'), null);
  add(path.join(root, 'openspec/config.yaml'));
  add(path.join(root, 'openspec/spec-relay/plan.md'));
  return h.digest('hex').slice(0, 16);
}

const send = (res, code, type, body) => {
  res.writeHead(code, { 'Content-Type': type, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer', 'X-Frame-Options': 'SAMEORIGIN' });
  res.end(body);
};

async function readBody(req, limit = 32 * 1024) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw new Error('too large');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
}

function insideRoot(root, rel) {
  const real = fs.realpathSync(root);
  const abs = path.resolve(real, rel);
  if (abs !== real && !abs.startsWith(real + path.sep)) return null;
  let resolved;
  try { resolved = fs.realpathSync(abs); } catch { return null; }
  if (resolved !== real && !resolved.startsWith(real + path.sep)) return null;
  return resolved;
}

// Starts the server. `ask(message)` receives { prompt, displayPrompt } for the chat.
export async function startServer({ root, ask = async () => {}, lang: wanted, now = () => new Date() }) {
  const token = crypto.randomBytes(24).toString('base64url');
  let version = 0;
  let seen = null;
  let checked = 0;
  let goto = { seq: 0, path: null };
  const lang = () => (wanted ?? language(root));
  // The version moves when the files move (checked at most once a second) or when told.
  const currentVersion = () => {
    if (Date.now() - checked > 1000) {
      checked = Date.now();
      const sig = signature(root);
      if (seen !== null && sig !== seen) version += 1;
      seen = sig;
    }
    return version;
  };

  const pageHtml = (name) => {
    const code = lang();
    if (name === 'progress') return { html: progressPage({ root, lang: code, now: now() }), title: WORDS[code].title };
    const at = path.join(root, VIEWS, `${name}.html`);
    let result;
    if (name === 'specs') result = view({ root, spec: 'all', lang: code, now: now(), at });
    else if (name.startsWith('spec-')) {
      const capability = capabilities(root).find((c) => `spec-${changeKey(c)}` === name);
      if (!capability) return null;
      result = view({ root, spec: capability, lang: code, now: now(), at });
    } else result = view({ root, change: name, lang: code, now: now(), at });
    return result.ok ? { html: result.html, title: result.title } : null;
  };

  const server = http.createServer(async (req, res) => {
    try {
      const host = req.headers.host;
      if (host !== `127.0.0.1:${server.address().port}`) return send(res, 403, 'text/plain; charset=utf-8', 'forbidden');
      const url = new URL(req.url, 'http://127.0.0.1');
      const parts = url.pathname.split('/');
      if (parts[1] !== token) return send(res, 403, 'text/plain; charset=utf-8', 'forbidden');
      const rest = parts.slice(2).map((p) => { try { return decodeURIComponent(p); } catch { return '\0'; } });
      if (rest.some((p) => p.includes('\0') || p.includes('/') || p.includes('\\'))) return send(res, 400, 'text/plain; charset=utf-8', 'bad path');

      if (req.method === 'GET' && rest.length === 1 && rest[0] === 'state') {
        return send(res, 200, 'application/json; charset=utf-8', JSON.stringify({ version: currentVersion(), goto }));
      }
      if (rest.length === 1 && rest[0] === 'ask') {
        const origin = req.headers.origin;
        if (req.method !== 'POST' || req.headers['x-spec-relay'] !== 'ask' || (origin && origin !== `http://127.0.0.1:${server.address().port}`)) return send(res, 403, 'text/plain; charset=utf-8', 'forbidden');
        let body;
        try { body = JSON.parse(await readBody(req)); } catch { return send(res, 400, 'text/plain; charset=utf-8', 'bad request'); }
        if (!body || typeof body.question !== 'string' || !body.question.trim()) return send(res, 400, 'text/plain; charset=utf-8', 'no question');
        await ask(askPrompt(body, lang()));
        return send(res, 200, 'application/json; charset=utf-8', '{"ok":true}');
      }
      if (req.method !== 'GET' || rest[0] !== 'r') return send(res, 404, 'text/plain; charset=utf-8', 'not found');
      const rel = rest.slice(1).join('/');
      const views = `${VIEWS}/`;
      if (rel.startsWith(views) && rel.endsWith('.html') && !rel.slice(views.length).includes('/')) {
        const name = rel.slice(views.length, -'.html'.length);
        const built = pageHtml(name);
        if (!built) return send(res, 404, 'text/plain; charset=utf-8', 'not found');
        return send(res, 200, 'text/html; charset=utf-8', interactive(built.html, { lang: lang(), pagePath: rel, title: built.title, version: currentVersion(), seq: goto.seq }));
      }
      const type = IMAGES[path.extname(rel).toLowerCase()];
      const file = type && !rest.slice(1).some((p) => p === '.git' || p === '..' || p === '.') ? insideRoot(root, rel) : null;
      if (!file || !fs.statSync(file).isFile()) return send(res, 404, 'text/plain; charset=utf-8', 'not found');
      return send(res, 200, type, fs.readFileSync(file));
    } catch (err) {
      return send(res, 500, 'text/plain; charset=utf-8', 'error');
    }
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const port = server.address().port;
  const address = (name) => `http://127.0.0.1:${port}/${token}/r/${VIEWS}/${encodeURIComponent(name)}.html`;
  return {
    root, port, token,
    url: address,
    // Sends every open canvas page to this page.
    go: (name) => { goto = { seq: goto.seq + 1, path: `${VIEWS}/${encodeURIComponent(name)}.html` }; return address(name); },
    refresh: () => { version += 1; },
    close: () => new Promise((resolve) => { server.closeAllConnections?.(); server.close(() => resolve()); }),
  };
}

// The page a canvas opens on, from what the agent or the person asked for.
export function pageName(root, { view: which = 'progress', name } = {}) {
  if (which === 'specs' || (which === 'spec' && (!name || name === 'all'))) return { ok: true, name: 'specs' };
  if (which === 'spec') {
    const capability = String(name).replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
    if (!capabilities(root).includes(capability)) return { ok: false, problem: `spec not found: openspec/specs/${capability}/spec.md` };
    return { ok: true, name: `spec-${changeKey(capability)}` };
  }
  if (which === 'review') {
    if (!name || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name)) return { ok: false, problem: 'name the change to review, such as extract-billing-invoice' };
    if (!fs.existsSync(path.join(root, 'openspec/changes', name)) && !archivedChange(root, name)) return { ok: false, problem: `change not found: ${name}` };
    return { ok: true, name };
  }
  return { ok: true, name: 'progress' };
}

export async function main(argv) {
  const opts = { root: process.cwd() };
  for (let i = 0; i < argv.length; i += 2) {
    const key = { '--root': 'root', '--lang': 'lang' }[argv[i]];
    if (!key || argv[i + 1] === undefined) { console.error('Usage: node canvas.mjs [--root DIR] [--lang ja|en]'); return 2; }
    opts[key] = argv[i + 1];
  }
  const server = await startServer({ root: path.resolve(opts.root), lang: opts.lang, ask: async (m) => console.log(m.prompt) });
  console.log(JSON.stringify({ ok: true, url: server.url('progress') }, null, 2));
  return null;
}

function invokedDirectly() {
  if (!process.argv[1]) return false;
  try { return fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url)); } catch { return false; }
}

if (invokedDirectly()) {
  const code = await main(process.argv.slice(2));
  if (code !== null) process.exit(code);
}
