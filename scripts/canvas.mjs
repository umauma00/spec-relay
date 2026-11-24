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
// - pass a question the person typed to the chat, marked "[canvas]";
// - on the page of an active change, write what the person changed in its
//   review.md (a tick, a decision, the reviewer's name) through review-edit.mjs,
//   which records each write in canvas-log.jsonl. It writes no other file.
// It listens on 127.0.0.1 only, every path starts with a random token, the Host
// header must be the server's own, a question or an edit must come from its own
// page (a custom header and, when sent, the same Origin), an edit is refused
// when review.md changed since the page was built, and the page runs only the
// scripts this server marked with a fresh nonce.
import http from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { view, page, labels, escapeHtml, markdown, parseReview, capabilities, timeStamp } from './render.mjs';
import { status, checklist, stepLabel, stepName, STEPS } from './status.mjs';
import { language, changeSchema, archivedChange, reviewRemarks } from './gate.mjs';
import { writeReview, sha256, utf8Text, reviewerOf, decisionOf } from './review-edit.mjs';
import { GUIDE, guidePage, modules as guideModules, saveQa, locate } from './guide.mjs';

export const VIEWS = 'openspec/spec-relay/views';

const WORDS = {
  ja: {
    kind: 'spec-relay', title: '移行の進み具合', now: 'いま', you: 'あなたの番です', agent: 'AI の番です',
    todo: 'やること', changes: '進行中の変更', change: '変更', schema: '種類', confirmed: '確認済み', open: '開く',
    byCapability: '機能ごと', capability: '機能', spec: '仕様', problems: '問題', none: 'ありません',
    nav: '画面', progress: '進み具合', specs: '仕様の一覧', guide: 'コードガイド',
    answer: 'AI の回答', helpful: '役に立った（Q&A に保存する）', qaSaved: 'Q&A に保存しました。', qaFailed: '保存できませんでした',
    ask: 'これを聞く', askPage: 'この画面について聞く', askTitle: 'チャットに質問を送る', askAbout: '対象',
    askHint: 'チャットに「[canvas]」付きで届きます。質問であって、承認や判断にはなりません。',
    tick: '確認済みにする', untick: '確認を外す', decide: '判断を書く', decideTick: '判断を書いて確認済みにする',
    reviewer: 'レビュー担当', reviewerSet: 'レビュー担当の名前を書く', save: '保存する',
    decisionTitle: '判断を書く', reviewerTitle: 'レビュー担当の名前',
    editHint: 'review.md に書き込みます。あなたが自分でファイルを直したのと同じ扱いです。変更を完了（アーカイブ）してよいかは、チャットで伝えてください。',
    saving: '保存しています…', saved: 'review.md に保存しました。', changed: 'review.md がほかで変わっていたので、読み直しました。もう一度操作してください。', saveFailed: '保存できませんでした', emptyValue: '書いてから保存してください。',
    needDecision: '先に判断を書いてください。', placeholder: '「TBD」や「-」のような書きかけは判断になりません。判断を書いてください。',
    noFile: 'この画面の review.md が見つかりません。', bad: 'この操作はできません。', notUtf8: 'review.md が UTF-8 ではないため書き込めません。UTF-8 で保存し直してください。',
    busy: 'ほかのプログラムが review.md を使っていて書き込めませんでした。閉じてからもう一度押してください。', noLine: 'review.md にこの項目の行が見つかりません。',
    howto: '正しければ「確認済みにする」、違えば「直してほしい」、今は決められなければ「保留」を押す（どれも review.md に書き込まれます）',
    fix: '直してほしい', hold: '保留', withdraw: '取り下げる', fixTitle: '直してほしいこと', holdTitle: '保留の理由',
    fixHint: 'review.md のこの項目の下に「- fix: …」として書き、確認を外します。AI に直してもらうには、左の「直してほしい項目を AI に伝える」を押すか、チャットで伝えてください。',
    holdHint: 'review.md のこの項目の下に「- hold: …」として書きます。決まったら「確認済みにする」か「直してほしい」を押してください。',
    sendFixes: (n) => `直してほしい項目を AI に伝える（${n} 件）`, fixesSent: 'チャットに送りました。AI が直すと、項目の下に直した内容が出ます。',
    openFix: 'AI がまだ直していない依頼があります。取り下げてから確認済みにしてください。', noNote: '取り下げるものがありません。',
    send: '送る', cancel: 'やめる', sending: '送っています…', sent: 'チャットに送りました。', failed: '送れませんでした', empty: '質問を書いてください。',
    notRepo: 'このフォルダには openspec/ がありません。spec-relay を導入したリポジトリでチャットを開いてください。',
    notFound: 'この画面はありません（変更や仕様が消えたか、名前が違います）。上の「進み具合」から選んでください。',
    noLink: 'canvas ではこのリンクを開けません（canvas の画面どうしのリンクだけが開きます）。',
    gone: 'チャットのセッションが終わったため、この画面はもう更新されません。',
    note: '正は Markdown のファイルです。進行中の変更の画面では、確認・判断・レビュー担当を review.md に書き込めます。そのほかの判断はチャットで伝えてください。openspec/ のファイルが変わると画面も変わります。',
    generated: '生成',
  },
  en: {
    kind: 'spec-relay', title: 'Migration progress', now: 'Now', you: 'Your turn', agent: "The agent's turn",
    todo: 'To do', changes: 'Changes in progress', change: 'Change', schema: 'Kind', confirmed: 'Confirmed', open: 'Open',
    byCapability: 'By capability', capability: 'Capability', spec: 'Spec', problems: 'Problems', none: 'None',
    nav: 'Pages', progress: 'Progress', specs: 'Specs', guide: 'Code guide',
    answer: "The agent's answer", helpful: 'Helpful (save to the Q&A)', qaSaved: 'Saved to the Q&A.', qaFailed: 'Could not save',
    ask: 'Ask about this', askPage: 'Ask about this page', askTitle: 'Send a question to the chat', askAbout: 'About',
    askHint: 'It reaches the chat marked "[canvas]". It is a question, never an approval or a decision.',
    tick: 'Mark confirmed', untick: 'Unmark', decide: 'Write the decision', decideTick: 'Write the decision and confirm',
    reviewer: 'Reviewer', reviewerSet: 'Write the reviewer name', save: 'Save',
    decisionTitle: 'Write the decision', reviewerTitle: 'Reviewer name',
    editHint: 'This writes to review.md, the same as editing the file yourself. Whether the change may be completed (archived) you tell in the chat.',
    saving: 'Saving…', saved: 'Saved to review.md.', changed: 'review.md had changed elsewhere, so the page was reloaded. Try again.', saveFailed: 'Could not save', emptyValue: 'Write something first.',
    needDecision: 'Write the decision first.', placeholder: 'A placeholder such as "TBD" or "-" is not a decision. Write the decision.',
    noFile: 'This page has no review.md.', bad: 'This cannot be done.', notUtf8: 'review.md is not UTF-8, so it cannot be written. Save it again as UTF-8.',
    busy: 'Another program is using review.md, so it could not be written. Close it and try again.', noLine: 'review.md has no line for this item.',
    howto: 'If it is right, press "Mark confirmed"; if it is wrong, "Needs a change"; if you cannot decide yet, "On hold" (each is written to review.md)',
    fix: 'Needs a change', hold: 'On hold', withdraw: 'Withdraw', fixTitle: 'What should change', holdTitle: 'Why it is on hold',
    fixHint: 'This writes "- fix: ..." under the item in review.md and unticks it. To have the agent correct it, press "Send the change requests to the agent" on the left, or say so in the chat.',
    holdHint: 'This writes "- hold: ..." under the item in review.md. When you have decided, press "Mark confirmed" or "Needs a change".',
    sendFixes: (n) => `Send the change requests to the agent (${n})`, fixesSent: 'Sent to the chat. When the agent has corrected it, what changed shows under the item.',
    openFix: 'The agent has not answered a change request yet. Withdraw it before confirming.', noNote: 'Nothing to withdraw.',
    send: 'Send', cancel: 'Cancel', sending: 'Sending…', sent: 'Sent to the chat.', failed: 'Could not send', empty: 'Write a question first.',
    notRepo: 'This folder has no openspec/. Open the chat in a repository where spec-relay is set up.',
    notFound: 'There is no such page (the change or spec is gone, or the name is wrong). Pick one from Progress above.',
    noLink: 'This link does not open in the canvas (only links between canvas pages do).',
    gone: 'The chat session has ended, so this page no longer updates.',
    note: 'The Markdown files are the source of truth. On the page of a change in progress you can write ticks, decisions and the reviewer to review.md. Other decisions go in the chat. The page follows the files under openspec/ as they change.',
    generated: 'Generated',
  },
};

const changeKey = (capability) => capability.split('/').join('-');
// A change name as OpenSpec makes them (extract-billing-invoice, port-x-v2, 2026-11-10-survey).
const CHANGE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

function changeExists(root, name) {
  if (!CHANGE_NAME.test(name) || name === 'archive' || /^\.+$/.test(name)) return false;
  const has = (dir) => fs.existsSync(path.join(dir, '.openspec.yaml')) || fs.existsSync(path.join(dir, 'proposal.md'));
  return has(path.join(root, 'openspec/changes', name)) || Boolean(archivedChange(root, name)) || (/^\d{4}-\d{2}-\d{2}-/.test(name) && has(path.join(root, 'openspec/changes/archive', name)));
}

// Every active change, with how many of its review items are confirmed (null without review.md).
export function activeChanges(root) {
  const dir = path.join(root, 'openspec/changes');
  let names = [];
  try { names = fs.readdirSync(dir, { withFileTypes: true }).filter((e) => e.isDirectory() && e.name !== 'archive').map((e) => e.name).sort(); } catch { /* none */ }
  return names.map((name) => {
    let schema = '';
    try { schema = changeSchema(path.join(dir, name)); } catch { /* unknown */ }
    let text = null;
    try { text = fs.readFileSync(path.join(dir, name, 'review.md'), 'utf8'); } catch { /* no review */ }
    const items = text === null ? null : parseReview(text).flatMap((g) => g.items);
    return { name, schema, total: items ? items.length : null, done: items ? items.filter((i) => i.done).length : null };
  });
}

// The first page: where the migration is, whose turn it is, and links to every
// change page and spec page.
export function progressPage({ root, lang, now = new Date() }) {
  const W = WORDS[lang];
  const meta = `${W.generated} ${timeStamp(now)}`;
  const base = { title: W.title, kind: W.kind, meta, L: labels(lang), note: W.note, lang, mode: 'read' };
  if (!fs.existsSync(path.join(root, 'openspec'))) return page({ ...base, brief: `<p class="caution">${escapeHtml(W.notRepo)}</p>` });
  const report = status(root, { language: lang });
  const specs = new Set(capabilities(root));
  const here = report.current;
  const hereItem = here ? report.todoList.find((t) => t.key === (here.capability ? `${here.capability}:${here.step}` : here.step)) : null;
  const brief = `<header class="brief">
<div class="purpose"><span class="label">${escapeHtml(W.now)}</span><p>${escapeHtml(report.todoList[0]?.title ?? '')}</p>
${hereItem ? `<p class="next-step"><b>${escapeHtml(here.waiting ? W.you : W.agent)}</b> — ${escapeHtml(hereItem.title)}</p>` : ''}</div>
</header>`;
  const link = (href, text) => `<a href="${escapeHtml(href)}">${escapeHtml(text)}</a>`;
  const table = (head, rows) => `<div class="table"><table><thead><tr>${head.map((h) => `<th>${escapeHtml(h)}</th>`).join('')}</tr></thead><tbody>${rows.join('')}</tbody></table></div>`;
  const docs = [{ id: 'todo', title: W.todo, html: `<div class="doc">${markdown(checklist(report))}</div>` }];
  const changes = activeChanges(root);
  docs.push({ id: 'changes', title: W.changes, html: changes.length
    ? table([W.change, W.schema, W.confirmed, ''], changes.map((c) => `<tr><td class="mono">${escapeHtml(c.name)}</td><td>${escapeHtml(c.schema.replace(/^spec-relay-/, ''))}</td><td>${c.total === null ? '—' : `${c.done} / ${c.total}`}</td><td>${changeExists(root, c.name) ? link(`${encodeURIComponent(c.name)}.html`, W.open) : ''}</td></tr>`))
    : `<p>${escapeHtml(W.none)}</p>` });
  if (report.capabilities.length) {
    const grouped = report.capabilities.some((c) => c.group);
    docs.push({ id: 'capabilities', title: W.byCapability, html: table([...(grouped ? [stepName(lang, 'group')] : []), W.capability, ...STEPS.map((st) => stepName(lang, st.id)), W.spec], report.capabilities.map((c) => `<tr>${grouped ? `<td>${escapeHtml(c.group ?? '')}</td>` : ''}<td class="mono">${escapeHtml(c.capability)}${c.counted === false ? ` (${escapeHtml(stepName(lang, 'notInPlan'))})` : ''}</td>${STEPS.map((st) => `<td>${escapeHtml(stepLabel(lang, c.steps[st.id]))}</td>`).join('')}<td>${specs.has(c.capability) ? link(`spec-${encodeURIComponent(changeKey(c.capability))}.html`, W.open) : '—'}</td></tr>`)) });
  }
  if (report.problems.length) docs.push({ id: 'problems', title: W.problems, html: `<ul>${report.problems.map((p) => `<li>${escapeHtml(p)}</li>`).join('')}</ul>` });
  return page({ ...base, brief, docs });
}

function notFoundPage({ lang, now = new Date() }) {
  const W = WORDS[lang];
  return page({ title: W.title, kind: W.kind, meta: `${W.generated} ${timeStamp(now)}`, brief: `<p class="caution">${escapeHtml(W.notFound)}</p>`, L: labels(lang), note: W.note, lang, mode: 'read' });
}

// ---------------------------------------------------------------- the interactive layer

const csp = (nonce) => `default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}'; img-src 'self' data:; connect-src 'self'; form-action 'none'; base-uri 'none'`;

const CANVAS_CSS = `
.canvas-nav{margin:12px 0 0;display:flex;flex-wrap:wrap;gap:6px 14px;font-size:14px}
.canvas-nav a[aria-current]{color:var(--ink);font-weight:700;text-decoration:none}
.ask{font:600 13px/1.2 var(--ui);padding:6px 10px;border:1.5px solid var(--ai);background:var(--paper);color:var(--ai);cursor:pointer;min-height:32px}
.ask:hover{background:var(--ai);color:var(--paper)}
.ask-row{margin:10px 0 0}
@container (min-width:860px){.ask-row{padding-left:calc(3.1em + 26px)}}
.ask-row.ask-page{margin-top:12px;padding-left:0}
dialog.ask-box{border:2px solid var(--ink);padding:16px;max-width:min(560px,calc(100vw - 32px));width:100%;background:var(--paper);color:var(--ink);font-family:var(--ui)}
dialog.ask-box::backdrop{background:rgba(0,0,0,.35)}
.ask-box h2{margin:0 0 6px;font-size:16px}
.ask-box .about{margin:0 0 8px;font-size:13px;color:var(--ink2);overflow-wrap:anywhere}
.ask-box textarea{display:block;width:100%;min-height:7em;padding:8px;border:1.5px solid var(--ink);background:var(--paper);color:var(--ink);font:15px/1.6 var(--read);resize:vertical}
.ask-box .hint{font-size:12px;color:var(--ink2);margin:6px 0 4px}
.ask-box .msg{font-size:13px;font-weight:600;color:var(--ochre);margin:0 0 8px;min-height:1.2em}
.ask-box .buttons{display:flex;gap:8px;justify-content:flex-end}
.ask-box button{font:600 14px/1.2 var(--ui);padding:8px 14px;min-height:40px;border:1.5px solid var(--ink);background:var(--paper);color:var(--ink);cursor:pointer}
.ask-box button.primary{background:var(--ink);color:var(--paper)}
.ask-box button[disabled]{opacity:.6;cursor:wait}
.canvas-toast{position:fixed;left:16px;right:16px;bottom:64px;max-width:420px;margin:0 auto;padding:10px 14px;background:var(--ink);color:var(--paper);font:600 14px/1.4 var(--ui);z-index:9}
.ask.mark{border-color:var(--ink);color:var(--ink);margin-right:8px}
.ask.mark:hover{background:var(--ink);color:var(--paper)}
.ask-row .ask{margin-bottom:6px}
.ask-box input[type=text]{display:block;width:100%;padding:8px;border:1.5px solid var(--ink);background:var(--paper);color:var(--ink);font:15px/1.6 var(--read)}
.canvas-answer{margin:10px 0 0;padding:10px 12px;border:1.5px solid var(--ai)}
.canvas-answer .q{font-weight:700;margin:4px 0}
.canvas-answer .ask{margin-top:8px}
.act{font:600 13px/1.2 var(--ui);padding:6px 12px;min-height:32px;margin:0 8px 6px 0;cursor:pointer;border:1.5px solid var(--ink);background:var(--paper);color:var(--ink)}
.act-ok{background:var(--ink);color:var(--paper)}
.act-ok:hover{background:var(--paper);color:var(--ink)}
.act-fix{border-color:var(--ochre);color:var(--ochre)}
.act-fix:hover{background:var(--ochre);color:var(--paper)}
.act-hold{border-style:dashed;border-color:var(--ink2);color:var(--ink2)}
.act-hold:hover{border-style:solid;color:var(--ink)}
.act-quiet{border-color:var(--hair);color:var(--ink2);font-weight:400}
.act-quiet:hover{border-color:var(--ink);color:var(--ink)}
.act-wide{width:100%;text-align:left;margin-right:0}
.act[disabled]{opacity:.6;cursor:wait}
.item.is-done .ask-row{margin-top:4px}
@media print{.act{display:none!important}}
.canvas-gone{position:sticky;top:0;z-index:8;margin:0;padding:8px 16px;background:var(--ochre);color:var(--paper);font:600 14px/1.4 var(--ui)}
@media print{.canvas-nav,.ask,.ask-row,dialog.ask-box,.canvas-toast,.canvas-gone{display:none!important}}
`;

// Runs in the canvas. The token is the first path segment; every other address is relative to it.
const CANVAS_SCRIPT = String.raw`(() => {
  const d = document, base = '/' + location.pathname.split('/')[1], pages = base + '/r/openspec/spec-relay/views/';
  const cfg = JSON.parse(d.getElementById('canvas-config').textContent), W = cfg.words;
  const box = d.getElementById('ask-box'), text = d.getElementById('ask-text'), about = d.getElementById('ask-about'), msg = d.getElementById('ask-msg'), send = box.querySelector('.primary');
  const store = (key, value) => { try { if (value === undefined) return sessionStorage.getItem(key); if (value === null) sessionStorage.removeItem(key); else sessionStorage.setItem(key, value); } catch (e) { /* refused */ } return null; };
  const toast = (m) => { const t = d.createElement('p'); t.className = 'canvas-toast'; t.setAttribute('role', 'status'); t.textContent = m; d.body.appendChild(t); setTimeout(() => t.remove(), 4000); };
  const shut = () => { if (box.close) box.close(); else box.removeAttribute('open'); };
  let target = null, pending = false;
  const open = (item) => {
    target = item ? { label: (item.querySelector('.item-head .id') || {}).textContent || '', title: (item.querySelector('.item-head h3') || {}).textContent || '' } : null;
    about.textContent = W.askAbout + ': ' + cfg.title + (target ? ' — ' + target.label + ' ' + target.title : '');
    text.value = ''; msg.textContent = '';
    if (box.showModal) box.showModal(); else box.setAttribute('open', '');
    text.focus();
  };
  d.querySelectorAll('main .item').forEach((item) => {
    const row = d.createElement('p'); row.className = 'ask-row';
    const b = d.createElement('button'); b.type = 'button'; b.className = 'ask'; b.textContent = W.ask;
    const id = (item.querySelector('.item-head .id') || {}).textContent || '';
    b.setAttribute('aria-label', W.ask + ': ' + id + ' ' + ((item.querySelector('.item-head h3') || {}).textContent || ''));
    b.addEventListener('click', () => open(item));
    row.appendChild(b); item.appendChild(row);
  });
  const pageAsk = d.getElementById('ask-page');
  if (pageAsk) pageAsk.addEventListener('click', () => open(null));
  // Answers the agent sent back for questions asked on this page (the code guide), under their item.
  (cfg.answers || []).forEach((a) => {
    const all = [...d.querySelectorAll('main .item')], text = (x, sel) => ((x.querySelector(sel) || {}).textContent || '').trim();
    // The item by its title first (the numbers move when files are added), then by its number.
    const item = (a.title && all.find((x) => text(x, '.item-head h3') === a.title)) || all.find((x) => text(x, '.item-head .id') === a.label);
    const box2 = d.createElement('div'); box2.className = 'canvas-answer';
    const head = d.createElement('p'); head.className = 'label'; head.textContent = W.answer;
    const q = d.createElement('p'); q.className = 'q'; q.textContent = a.question;
    const body = d.createElement('div'); body.className = 'doc'; body.innerHTML = a.html;
    box2.append(head, q, body);
    if (a.savable && !a.saved) {
      const b = d.createElement('button'); b.type = 'button'; b.className = 'ask'; b.textContent = W.helpful;
      b.addEventListener('click', async () => {
        b.disabled = true;
        try {
          const res = await fetch(base + '/qa', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Spec-Relay': 'qa' }, body: JSON.stringify({ page: cfg.page, id: a.id, rev: a.rev }) });
          if (res.status === 409) { location.reload(); return; }
          if (!res.ok) throw new Error(String(res.status));
          b.remove(); toast(W.qaSaved);
        } catch (err) { b.disabled = false; toast(W.qaFailed + ' (' + err.message + ')'); }
      });
      box2.appendChild(b);
    }
    if (item) item.appendChild(box2); else (d.querySelector('main') || d.body).prepend(box2);
  });
  // Keys typed in the dialog stay in the dialog (the page has single-key shortcuts).
  box.addEventListener('keydown', (e) => e.stopPropagation());
  box.querySelector('.cancel').addEventListener('click', shut);
  box.querySelector('form').addEventListener('submit', async (e) => {
    e.preventDefault();
    if (pending) return;
    const question = text.value.trim();
    if (!question) { msg.textContent = W.empty; text.focus(); return; }
    pending = true; send.disabled = true; msg.textContent = W.sending;
    try {
      const res = await fetch(base + '/ask', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Spec-Relay': 'ask' }, body: JSON.stringify({ page: cfg.page, item: target, question }) });
      if (!res.ok) throw new Error(String(res.status));
      shut(); toast(W.sent);
    } catch (err) { msg.textContent = W.failed + ' (' + err.message + ')'; }
    finally { pending = false; send.disabled = false; }
  });
  // Writing review.md: a tick, a decision, the reviewer's name. Each write sends
  // the hash of review.md the page was built from; the server refuses a stale one.
  const R = cfg.review;
  const ebox = d.getElementById('edit-box');
  let writing = false;
  if (R && ebox) {
    const etitle = d.getElementById('edit-title'), etext = d.getElementById('edit-text'), emsg = d.getElementById('edit-msg'), esave = ebox.querySelector('.primary');
    let hash = R.hash, job = null;
    const reload = (m) => { store('spec-relay-canvas-toast', m); keepPlace(); location.reload(); };
    const post = async (action, id, value) => {
      const res = await fetch(base + '/review', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Spec-Relay': 'review' }, body: JSON.stringify({ page: cfg.page, hash, action, id, value }) });
      let j = {};
      try { j = await res.json(); } catch (e) { /* not JSON */ }
      if (res.status === 409) return false;
      if (!res.ok || !j.ok) throw new Error((j.code && W[j.code]) || j.problem || String(res.status));
      hash = j.hash;
      return true;
    };
    // A stale page reloads; what was typed in the dialog comes back with it.
    const run = async (steps, report, draft) => {
      if (writing) return;
      writing = true;
      try {
        for (const [action, id, value] of steps) {
          if (!(await post(action, id, value))) {
            if (draft) store('spec-relay-canvas-draft', JSON.stringify({ page: cfg.page, ...draft }));
            reload(W.changed);
            return;
          }
        }
        reload(W.saved);
      } catch (err) { report(W.saveFailed + ': ' + err.message); }
      finally { writing = false; }
    };
    const ehint = d.getElementById('edit-hint'), hintDefault = ehint.textContent;
    const edit = (kind, id, value, then) => {
      job = { kind, id, then };
      etitle.textContent = kind === 'reviewer' ? W.reviewerTitle : (kind === 'fix' ? W.fixTitle : kind === 'hold' ? W.holdTitle : W.decisionTitle) + ' — ' + id;
      ehint.textContent = kind === 'fix' ? W.fixHint : kind === 'hold' ? W.holdHint : hintDefault;
      etext.value = value || ''; emsg.textContent = '';
      if (ebox.showModal) ebox.showModal(); else ebox.setAttribute('open', '');
      etext.focus();
    };
    const eshut = () => { if (ebox.close) ebox.close(); else ebox.removeAttribute('open'); };
    // One row of buttons per item, each kind with its own look: confirm (filled),
    // needs a change (ochre), on hold (dashed), withdraw and unmark (quiet), ask (indigo).
    R.items.forEach((it) => {
      const item = d.getElementById(it.id);
      const row = item && item.matches('main .item') ? item.querySelector('.ask-row') : null;
      if (!row) return;
      const button = (label, cls, onClick) => { const b = d.createElement('button'); b.type = 'button'; b.className = 'act ' + cls; b.textContent = label; b.setAttribute('aria-label', label + ': ' + it.id); b.addEventListener('click', onClick); return b; };
      const first = row.firstChild;
      const add = (b) => row.insertBefore(b, first);
      // An unanswered change request comes first: it can only be withdrawn (or answered by the agent).
      if (it.state === 'fix') add(button(W.withdraw, 'act-quiet', () => run([['withdraw', it.id]], toast)));
      if (it.done) add(button(W.untick, 'act-quiet', () => run([['untick', it.id]], toast)));
      else if (it.state !== 'fix') {
        add(it.q && !it.decided ? button(W.decideTick, 'act-ok', () => edit('decision', it.id, '', 'tick')) : button(W.tick, 'act-ok', () => run([['tick', it.id]], toast)));
        add(button(W.fix, 'act-fix', () => edit('fix', it.id, '')));
        if (it.state === 'hold') add(button(W.withdraw, 'act-quiet', () => run([['withdraw', it.id]], toast)));
        else add(button(W.hold, 'act-hold', () => edit('hold', it.id, '')));
      }
      if (it.q) add(button(W.decide, 'act-quiet', () => edit('decision', it.id, it.decision)));
    });
    // The change requests the agent has not answered, sent to the chat in one message.
    const fixes = d.getElementById('send-fixes');
    if (fixes) fixes.addEventListener('click', async () => {
      fixes.disabled = true;
      try {
        const res = await fetch(base + '/fixes', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Spec-Relay': 'fixes' }, body: JSON.stringify({ page: cfg.page }) });
        if (!res.ok) throw new Error(String(res.status));
        toast(W.fixesSent);
      } catch (err) { toast(W.failed + ' (' + err.message + ')'); }
      finally { fixes.disabled = false; }
    });
    const who = d.getElementById('edit-reviewer');
    if (who) who.addEventListener('click', () => edit('reviewer', null, R.reviewer));
    ebox.addEventListener('keydown', (e) => e.stopPropagation());
    ebox.querySelector('.cancel').addEventListener('click', eshut);
    ebox.querySelector('form').addEventListener('submit', async (e) => {
      e.preventDefault();
      const value = etext.value.trim();
      if (!value) { emsg.textContent = W.emptyValue; etext.focus(); return; }
      esave.disabled = true; emsg.textContent = W.saving;
      const steps = job.kind === 'reviewer' ? [['reviewer', null, value]] : job.kind === 'fix' || job.kind === 'hold' ? [[job.kind, job.id, value]] : [['decision', job.id, value], ...(job.then ? [[job.then, job.id]] : [])];
      await run(steps, (m) => { emsg.textContent = m; }, { kind: job.kind, id: job.id, then: job.then || null, value });
      esave.disabled = false;
    });
    let draft = null;
    const kept = store('spec-relay-canvas-draft');
    if (kept) store('spec-relay-canvas-draft', null);
    try { draft = JSON.parse(kept || 'null'); } catch (e) { draft = null; }
    if (draft && typeof draft === 'object') {
      if (draft.page === cfg.page && (draft.kind === 'reviewer' || R.items.some((it) => it.id === draft.id))) {
        edit(draft.kind, draft.id, draft.value, draft.then || undefined);
        emsg.textContent = W.changed;
      }
    }
  }
  // Links the canvas cannot show (images, source files, other sites) would leave it with no way back.
  const hold = (e) => {
    const a = e.target.closest ? e.target.closest('a[href]') : null;
    if (!a || a.getAttribute('href').startsWith('#')) return;
    const u = new URL(a.href, location.href);
    if (u.origin === location.origin && u.pathname.startsWith(pages) && u.pathname.endsWith('.html') && !u.pathname.slice(pages.length).includes('/')) return;
    e.preventDefault();
    toast(W.noLink);
  };
  d.addEventListener('click', hold, true);
  d.addEventListener('auxclick', hold, true);
  // After a reload, put the focus back where it was, and say what was saved.
  const said = store('spec-relay-canvas-toast');
  if (said) { store('spec-relay-canvas-toast', null); toast(said); }
  const was = store('spec-relay-canvas-focus');
  if (was) { store('spec-relay-canvas-focus', null); const el = d.getElementById(was); if (el) el.focus({ preventScroll: true }); }
  // Before a reload, remember where the reader is: the item they acted on (or the
  // first one on screen) and how far from the top it stood. The page comes back
  // there, not at its top. Kept in sessionStorage and in history.state (either
  // may be refused); the address loses its #fragment, so the page does not jump to it.
  const keepPlace = () => {
    const active = d.activeElement && d.activeElement.closest ? d.activeElement.closest('[id]') : null;
    if (active && active !== d.body) store('spec-relay-canvas-focus', active.id);
    let el = d.activeElement && d.activeElement.closest ? d.activeElement.closest('main .item') : null;
    if (!el || el.getBoundingClientRect().bottom < 0 || el.getBoundingClientRect().top > innerHeight) el = [...d.querySelectorAll('main .item, main .group > h2')].find((x) => x.offsetParent !== null && x.getBoundingClientRect().bottom > 0) || null;
    const place = { page: cfg.page, id: el && el.id ? el.id : null, top: el ? el.getBoundingClientRect().top : 0, y: scrollY };
    store('spec-relay-canvas-place', JSON.stringify(place));
    // Only for this reload: the browser's own restore would fight ours.
    try { history.scrollRestoration = 'manual'; } catch (e) { /* not supported */ }
    try { history.replaceState(Object.assign({}, history.state, { specRelayPlace: place }), '', location.pathname + location.search); } catch (e) { /* refused */ }
  };
  let place = null;
  try { place = JSON.parse(store('spec-relay-canvas-place') || 'null'); } catch (e) { place = null; }
  if (!place && history.state && history.state.specRelayPlace) place = history.state.specRelayPlace;
  store('spec-relay-canvas-place', null);
  try { if (history.state && history.state.specRelayPlace) { const s2 = Object.assign({}, history.state); delete s2.specRelayPlace; history.replaceState(s2, ''); } } catch (e) { /* refused */ }
  if (place && place.page === cfg.page) {
    let moved = false;
    const put = () => {
      if (moved) return;
      const el = place.id ? d.getElementById(place.id) : null;
      if (el && el.offsetParent !== null) scrollTo(0, scrollY + el.getBoundingClientRect().top - place.top); else scrollTo(0, place.y);
    };
    put();
    // Late layout (fonts, images) may move it once more; a scroll by the reader ends that.
    addEventListener('wheel', () => { moved = true; }, { once: true, passive: true });
    addEventListener('keydown', () => { moved = true; }, { once: true });
    addEventListener('touchstart', () => { moved = true; }, { once: true, passive: true });
    addEventListener('mousedown', () => { moved = true; }, { once: true });
    addEventListener('hashchange', () => { moved = true; }, { once: true });
    addEventListener('load', () => { put(); setTimeout(() => { put(); moved = true; }, 80); });
    setTimeout(put, 0);
  }
  // A manual reload or Back gets the browser's own restore again.
  try { history.scrollRestoration = 'auto'; } catch (e) { /* not supported */ }
  // Follow the files: reload when they change, go where the agent sent the canvas.
  let busy = false, misses = 0;
  setInterval(async () => {
    if (busy || writing || d.hidden || box.open || (ebox && ebox.open)) return;
    busy = true;
    try {
      const res = await fetch(base + '/state', { cache: 'no-store' });
      const s = await res.json();
      misses = 0;
      // Seen once: a jump to an anchor on this same page does not reload it, so it must not repeat.
      if (s.goto && s.goto.seq > cfg.seq) { cfg.seq = s.goto.seq; location.href = base + '/r/' + s.goto.path; }
      else if (s.version !== cfg.version) { keepPlace(); location.reload(); }
    } catch (err) {
      misses += 1;
      if (misses === 3 && !d.querySelector('.canvas-gone')) { const p = d.createElement('p'); p.className = 'canvas-gone'; p.setAttribute('role', 'status'); p.textContent = W.gone; d.body.prepend(p); }
    } finally { busy = false; }
  }, 2500);
})();`;

// Turns a page of render.mjs into a canvas page: only scripts carrying this
// response's nonce run, the page talks only to this server, and it gets links
// between the pages and the ask buttons. `review` ({ hash, items, reviewer }) is
// given for an active change with a review.md: its page also gets the buttons
// that write review.md.
export function interactive(html, { lang, pagePath, title, version, seq, nonce, review = null, answers = null, guide = false }) {
  const W = WORDS[lang];
  const L = labels(lang);
  const current = path.posix.basename(pagePath);
  const nav = `<nav class="canvas-nav" aria-label="${escapeHtml(W.nav)}"><a href="progress.html"${current === 'progress.html' ? ' aria-current="page"' : ''}>${escapeHtml(W.progress)}</a><a href="specs.html"${current === 'specs.html' ? ' aria-current="page"' : ''}>${escapeHtml(W.specs)}</a>${guide ? `<a href="guide.html"${current === 'guide.html' ? ' aria-current="page"' : ''}>${escapeHtml(W.guide)}</a>` : ''}</nav>
<p class="ask-row ask-page"><button type="button" class="ask" id="ask-page">${escapeHtml(W.askPage)}</button>${review ? ` <button type="button" class="ask mark" id="edit-reviewer">${escapeHtml(review.reviewer ? `${W.reviewer}: ${review.reviewer}` : W.reviewerSet)}</button>` : ''}</p>${review?.fixes ? `\n<p class="ask-row ask-page"><button type="button" class="act act-fix act-wide" id="send-fixes">${escapeHtml(W.sendFixes(review.fixes))}</button></p>` : ''}`;
  const words = Object.fromEntries(['ask', 'askAbout', 'sending', 'sent', 'failed', 'empty', 'noLink', 'gone', ...(answers ? ['answer', 'helpful', 'qaSaved', 'qaFailed'] : []),
    ...(review ? ['tick', 'untick', 'decide', 'decideTick', 'decisionTitle', 'reviewerTitle', 'saving', 'saved', 'changed', 'saveFailed', 'emptyValue', 'needDecision', 'notUtf8', 'busy', 'noLine', 'placeholder', 'noFile', 'bad',
      'fix', 'hold', 'withdraw', 'fixTitle', 'holdTitle', 'fixHint', 'holdHint', 'fixesSent', 'openFix', 'noNote'] : [])].map((k) => [k, W[k]]));
  const config = JSON.stringify({ page: pagePath, title, version, seq, words, review, ...(answers ? { answers } : {}) }).replace(/</g, '\\u003c').replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');
  const dialog = `<dialog class="ask-box" id="ask-box" aria-labelledby="ask-title" aria-describedby="ask-about"><form method="dialog"><h2 id="ask-title">${escapeHtml(W.askTitle)}</h2><p class="about" id="ask-about"></p>
<textarea id="ask-text" maxlength="4000" aria-labelledby="ask-title" aria-describedby="ask-about ask-hint ask-msg"></textarea>
<p class="hint" id="ask-hint">${escapeHtml(W.askHint)}</p><p class="msg" id="ask-msg" role="status"></p><div class="buttons"><button type="button" class="cancel">${escapeHtml(W.cancel)}</button><button type="submit" class="primary">${escapeHtml(W.send)}</button></div></form></dialog>
${review ? `<dialog class="ask-box" id="edit-box" aria-labelledby="edit-title"><form method="dialog"><h2 id="edit-title"></h2>
<input type="text" id="edit-text" maxlength="500" autocomplete="off" aria-labelledby="edit-title" aria-describedby="edit-hint edit-msg">
<p class="hint" id="edit-hint">${escapeHtml(W.editHint)}</p><p class="msg" id="edit-msg" role="status"></p><div class="buttons"><button type="button" class="cancel">${escapeHtml(W.cancel)}</button><button type="submit" class="primary">${escapeHtml(W.save)}</button></div></form></dialog>
` : ''}<script type="application/json" id="canvas-config">${config}</script>
<script nonce="${nonce}">${CANVAS_SCRIPT}</script>`;
  return html
    .replace(/<meta http-equiv="Content-Security-Policy" content="[^"]*">/, () => `<meta http-equiv="Content-Security-Policy" content="${csp(nonce)}">`)
    // Only render.mjs's own script (the last one on its page) runs; anything else stays inert.
    .replace(/<script>(?![\s\S]*<script>)/, () => `<script nonce="${nonce}">`)
    .replace('</style>', () => `${CANVAS_CSS}</style>`)
    // The canvas follows the files: no "render again", and the tick is a button here.
    .replace(`<footer>${escapeHtml(L.note)}</footer>`, () => `<footer>${escapeHtml(W.note)}</footer>`)
    .replace(`<li>${L.howto[2]}</li>`, () => (review ? `<li>${escapeHtml(W.howto)}</li>` : `<li>${L.howto[2]}</li>`))
    .replace(/(<p class="meta">[^<]*<\/p>)/, (m) => `${m}\n${nav}`)
    .replace(/<\/body>\s*<\/html>\s*$/, () => `${dialog}\n</body>\n</html>\n`);
}

// One line of text from the page: no line breaks or control characters, so it
// cannot pose as a separate part of the message.
const oneLine = (value, max) => String(value ?? '').replace(/[\u0000-\u001f\u007f\u2028\u2029]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);

// The text the chat receives. It says where it came from and that it is a question.
export function askPrompt({ question, title, item, page: pagePath, id }, lang) {
  const q = String(question ?? '').replace(/\r\n?/g, '\n').trim().slice(0, 4000);
  const where = [oneLine(title, 200), item ? oneLine(`${oneLine(item.label, 20)} ${oneLine(item.title, 300)}`, 330) : ''].filter(Boolean).join(' — ');
  // A question from the code guide gets an id: the answer can be shown under the item, and the person may save it.
  const back = id ? ` Then also send the answer to the canvas: invoke_canvas_action, actionName post_answer, input {"id": "${oneLine(id, 20)}", "answer": "<the answer, Markdown>"}; it shows under the item, and the person decides whether to save it.` : '';
  const prompt = `[canvas] ${q}\n\n(${lang === 'ja' ? '対象' : 'About'}: ${where}; page ${oneLine(pagePath, 300)}. The person typed this question in the spec-relay canvas. Answer it in the chat.${back} It is a question, not an approval: do not tick review.md, record a decision or archive because of it.)`;
  return { prompt, displayPrompt: `[canvas] ${q}${where ? `\n(${where})` : ''}` };
}

// The message for "send the change requests to the agent": what the person wrote
// under each item, and what the agent does with it. A request for work, never an approval.
export function fixPrompt({ change, items }, lang) {
  const list = items.map((i) => `- ${i.id}: ${oneLine(i.remarks.filter((r) => r.kind === 'fix').pop()?.text, 500)}`).join('\n');
  const head = lang === 'ja' ? `[canvas] ${change} のレビューで、直してほしい項目が ${items.length} 件あります。` : `[canvas] ${items.length} change request${items.length === 1 ? '' : 's'} in the review of ${change}.`;
  const prompt = `${head}\n${list}\n\n(The person wrote these under the items of openspec/changes/${oneLine(change, 128)}/review.md with the canvas ("- fix: ..."). Read review.md again, correct the artifacts as the Reviews section of the spec-relay skill says, write "  - fixed: <what you changed>" under each fix line, keep the items unticked, render again and tell the person. It is a request for a change, not an approval: do not tick review.md or archive because of it.)`;
  return { prompt, displayPrompt: `${head}\n${list}` };
}

// ---------------------------------------------------------------- the server

const IMAGES = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.bmp': 'image/bmp' };

// A cheap signature of what the pages show: every file under openspec/changes
// (the archive by its folder names only), openspec/specs and the screenshots,
// the config and the plan. Source files are not watched.
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
  walk(path.join(root, 'openspec/spec-relay/screens'), null);
  walk(path.join(root, GUIDE), null);
  add(path.join(root, 'openspec/config.yaml'));
  add(path.join(root, 'openspec/spec-relay/plan.md'));
  return h.digest('hex').slice(0, 16);
}

const send = (res, code, type, body, extra = {}) => {
  res.writeHead(code, { 'Content-Type': type, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer', ...extra });
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
  const prefix = real.endsWith(path.sep) ? real : real + path.sep;
  const within = (p) => p.startsWith(prefix);
  const abs = path.resolve(real, rel);
  if (!within(abs)) return null;
  let resolved;
  try { resolved = fs.realpathSync(abs); } catch { return null; }
  return within(resolved) ? resolved : null;
}

// The review.md of an active change, when it is a plain file at its own path
// (no link out of the change folder): the only file the canvas writes. The name
// is the folder's own, as read from the disk (on Windows a name in another case
// opens the same folder, and the log and the guard must name it the same way).
function reviewFile(root, wanted) {
  if (!CHANGE_NAME.test(wanted) || wanted === 'archive' || /^\.+$/.test(wanted)) return null;
  let names = [];
  try { names = fs.readdirSync(path.join(root, 'openspec/changes'), { withFileTypes: true }).filter((e) => e.isDirectory() && e.name !== 'archive').map((e) => e.name); } catch { return null; }
  const name = names.find((n) => n === wanted) ?? (process.platform === 'win32' ? names.find((n) => n.toLowerCase() === wanted.toLowerCase()) : undefined);
  if (!name) return null;
  const dir = path.join(root, 'openspec/changes', name);
  if (!fs.existsSync(path.join(dir, '.openspec.yaml')) && !fs.existsSync(path.join(dir, 'proposal.md'))) return null;
  const rel = `openspec/changes/${name}/review.md`;
  const file = insideRoot(root, rel);
  if (!file) return null;
  const expected = path.join(fs.realpathSync(root), ...rel.split('/'));
  const same = process.platform === 'win32' ? file.toLowerCase() === expected.toLowerCase() : file === expected;
  try { return same && fs.lstatSync(expected).isFile() ? { file: expected, name } : null; } catch { return null; }
}

// What the page needs to write review.md: the hash it was built from, its items
// and the reviewer, read as the gate reads them. Null for a file that is not
// UTF-8: the canvas never rewrites one.
function reviewState(file) {
  const buffer = fs.readFileSync(file);
  const text = utf8Text(buffer);
  if (text === null) return null;
  const seen = new Set();
  const items = parseReview(text).flatMap((g) => g.items).filter((i) => i.id && !seen.has(i.id) && seen.add(i.id))
    .map((i) => {
      const decision = i.decision === null ? '' : decisionOf(`decision: ${i.decision}`);
      return { id: i.id, done: i.done, q: i.letter === 'Q', decided: Boolean(decision), decision, state: i.state };
    });
  return { hash: sha256(buffer), items, reviewer: reviewerOf(text), fixes: reviewRemarks(text).filter((i) => i.openFix).length };
}

const sameToken = (a, b) => {
  const x = Buffer.from(String(a)), y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
};

// Starts the server. `ask(message)` receives { prompt, displayPrompt } for the chat.
export async function startServer({ root, ask = async () => {}, lang: wanted, now = () => new Date(), log = (e) => console.error(e) }) {
  const token = crypto.randomBytes(24).toString('base64url');
  let version = 0;
  let seen = null;
  let checked = 0;
  let goto = { seq: 0, path: null };
  const cache = new Map();
  const lang = () => language(root, wanted);
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

  // Questions asked on the code guide's pages, and the answers the agent sent back
  // (kept while the server runs; only the ones the person saves reach a file).
  const questions = new Map();
  let asked = 0;
  // Ids differ from one server to the next, so a late answer to a question asked before a restart finds nothing.
  const salt = crypto.randomBytes(2).toString('hex');
  const guideModule = (name) => (name.startsWith('guide-') ? guideModules(root).find((m) => `guide-${m.key}` === name) ?? null : null);
  const isGuidePage = (name) => name === 'guide' || Boolean(guideModule(name));
  const hasGuide = () => guideModules(root).length > 0 && fs.existsSync(path.join(root, GUIDE));

  // A page by name: progress, specs, spec-<capability key>, guide, guide-<module>, or a change. Null when there is none.
  const pageHtml = (name) => {
    const code = lang();
    const key = `${code}\0${currentVersion()}\0${name}`;
    if (cache.has(key)) return cache.get(key);
    let built = null;
    if (name === 'progress') built = { html: progressPage({ root, lang: code, now: now() }), title: WORDS[code].title };
    else if (isGuidePage(name)) {
      const mod = guideModule(name);
      const result = view({ root, guide: mod ? mod.key : true, lang: code, now: now(), at: path.join(root, VIEWS, `${name}.html`) });
      built = result?.ok ? { html: result.html, title: result.title, guide: true, module: result.module, files: result.files } : null;
    } else {
      const at = path.join(root, VIEWS, `${name}.html`);
      const capability = name.startsWith('spec-') ? capabilities(root).find((c) => `spec-${changeKey(c)}` === name) : null;
      let result = null;
      if (name === 'specs') result = view({ root, spec: 'all', lang: code, now: now(), at });
      else if (capability) result = view({ root, spec: capability, lang: code, now: now(), at });
      let review = null;
      if (!capability && name !== 'specs' && changeExists(root, name)) {
        // The hash is read before the page, so a file that changes meanwhile makes the edit stale, never wrong.
        const found = reviewFile(root, name);
        try { review = found ? reviewState(found.file) : null; } catch { review = null; }
        result = view({ root, change: name, lang: code, now: now(), at });
      }
      built = result?.ok ? { html: result.html, title: result.title, review } : null;
    }
    if (cache.size > 30) cache.clear();
    cache.set(key, built);
    return built;
  };

  const server = http.createServer(async (req, res) => {
    try {
      const port = server.address().port;
      if (req.headers.host !== `127.0.0.1:${port}`) return send(res, 403, 'text/plain; charset=utf-8', 'forbidden');
      const url = new URL(req.url, 'http://127.0.0.1');
      const parts = url.pathname.split('/');
      if (!sameToken(parts[1], token)) return send(res, 403, 'text/plain; charset=utf-8', 'forbidden');
      const rest = parts.slice(2).map((p) => { try { return decodeURIComponent(p); } catch { return '\0'; } });
      if (rest.some((p) => p.includes('\0') || p.includes('/') || p.includes('\\'))) return send(res, 400, 'text/plain; charset=utf-8', 'bad path');

      if (req.method === 'GET' && rest.length === 1 && rest[0] === 'state') {
        return send(res, 200, 'application/json; charset=utf-8', JSON.stringify({ version: currentVersion(), goto }));
      }
      if (rest.length === 1 && rest[0] === 'ask') {
        const origin = req.headers.origin;
        if (req.method !== 'POST' || req.headers['x-spec-relay'] !== 'ask' || (origin && origin !== `http://127.0.0.1:${port}`)) return send(res, 403, 'text/plain; charset=utf-8', 'forbidden');
        let body;
        try { body = JSON.parse(await readBody(req)); } catch { return send(res, 400, 'text/plain; charset=utf-8', 'bad request'); }
        if (!body || typeof body.question !== 'string' || !body.question.trim()) return send(res, 400, 'text/plain; charset=utf-8', 'no question');
        // The page is named by the server, not by what the page sent.
        const name = typeof body.page === 'string' && body.page.startsWith(`${VIEWS}/`) ? path.posix.basename(body.page, '.html') : '';
        const built = name && CHANGE_NAME.test(name) ? pageHtml(name) : null;
        let id;
        if (built?.guide) {
          // A question on the code guide gets an id, so its answer can come back to this page.
          asked += 1;
          id = `q${asked}-${salt}`;
          const item = body.item && typeof body.item === 'object' ? { label: oneLine(body.item.label, 20), title: oneLine(body.item.title, 300) } : null;
          questions.set(id, { id, page: name, item, question: oneLine(body.question, 500), answer: null, rev: 0, saved: false });
          if (questions.size > 200) questions.delete(questions.keys().next().value);
        }
        await ask(askPrompt({ ...body, id, page: built ? `${VIEWS}/${name}.html` : '', title: built?.title ?? '' }, lang()));
        return send(res, 200, 'application/json; charset=utf-8', JSON.stringify(id ? { ok: true, id } : { ok: true }));
      }
      if (rest.length === 1 && rest[0] === 'qa') {
        // "This helped": the person saves a question and its answer to the guide's Q&A file.
        const origin = req.headers.origin;
        if (req.method !== 'POST' || req.headers['x-spec-relay'] !== 'qa' || (origin && origin !== `http://127.0.0.1:${port}`)) return send(res, 403, 'text/plain; charset=utf-8', 'forbidden');
        const reply = (code, body) => send(res, code, 'application/json; charset=utf-8', JSON.stringify(body));
        let body;
        try { body = JSON.parse(await readBody(req)); } catch { return reply(400, { ok: false, problem: 'bad request' }); }
        const name = body && typeof body.page === 'string' && body.page.startsWith(`${VIEWS}/`) ? path.posix.basename(body.page, '.html') : '';
        const entry = body && typeof body.id === 'string' ? questions.get(body.id) : null;
        const mod = name ? guideModule(name) : null;
        if (!entry || entry.page !== name || !mod || entry.answer === null || !entry.item) return reply(404, { ok: false, problem: 'no answer to save on this page' });
        if (entry.saved) return reply(200, { ok: true, file: entry.file });
        // Only the answer the person read: one the agent replaced since is shown first.
        if (body.rev !== entry.rev) return reply(409, { ok: false, problem: 'the answer changed since the page was shown' });
        const result = saveQa(root, { module: mod.key, file: entry.item.title, question: entry.question, answer: entry.answer, now: now() });
        if (!result.ok) return reply(400, { ok: false, problem: result.problem });
        entry.saved = true;
        entry.file = result.file;
        version += 1;
        cache.clear();
        seen = signature(root);
        checked = Date.now();
        return reply(200, { ok: true, file: result.file });
      }
      if (rest.length === 1 && rest[0] === 'fixes') {
        // "Send the change requests to the agent": the open fix notes of this page's review.md, read here, in one message.
        const origin = req.headers.origin;
        if (req.method !== 'POST' || req.headers['x-spec-relay'] !== 'fixes' || (origin && origin !== `http://127.0.0.1:${port}`)) return send(res, 403, 'text/plain; charset=utf-8', 'forbidden');
        const reply = (code, body) => send(res, code, 'application/json; charset=utf-8', JSON.stringify(body));
        let body;
        try { body = JSON.parse(await readBody(req)); } catch { return reply(400, { ok: false, problem: 'bad request' }); }
        const name = body && typeof body.page === 'string' && body.page.startsWith(`${VIEWS}/`) ? path.posix.basename(body.page, '.html') : '';
        const found = name ? reviewFile(root, name) : null;
        if (!found) return reply(404, { ok: false, code: 'noFile', problem: 'this page has no review.md' });
        const text = utf8Text(fs.readFileSync(found.file));
        const open = text === null ? [] : reviewRemarks(text).filter((i) => i.openFix);
        if (!open.length) return reply(409, { ok: false, problem: 'no change request is open' });
        await ask(fixPrompt({ change: found.name, items: open }, lang()));
        return reply(200, { ok: true, count: open.length });
      }
      if (rest.length === 1 && rest[0] === 'review') {
        const origin = req.headers.origin;
        if (req.method !== 'POST' || req.headers['x-spec-relay'] !== 'review' || (origin && origin !== `http://127.0.0.1:${port}`)) return send(res, 403, 'text/plain; charset=utf-8', 'forbidden');
        const reply = (code, body) => send(res, code, 'application/json; charset=utf-8', JSON.stringify(body));
        let body;
        try { body = JSON.parse(await readBody(req)); } catch { return reply(400, { ok: false, problem: 'bad request' }); }
        if (!body || typeof body !== 'object') return reply(400, { ok: false, problem: 'bad request' });
        const { action, id, value, hash } = body;
        if (!['tick', 'untick', 'decision', 'reviewer', 'fix', 'hold', 'withdraw'].includes(action) || typeof hash !== 'string'
          || (action === 'reviewer' ? typeof value !== 'string' : typeof id !== 'string')
          || (['decision', 'fix', 'hold'].includes(action) && typeof value !== 'string')) return reply(400, { ok: false, problem: 'bad request' });
        const name = typeof body.page === 'string' && body.page.startsWith(`${VIEWS}/`) ? path.posix.basename(body.page, '.html') : '';
        const found = name ? reviewFile(root, name) : null;
        if (!found) return reply(404, { ok: false, code: 'noFile', problem: 'this page has no review.md to write' });
        const result = writeReview(root, found.name, { action, id: action === 'reviewer' ? undefined : id, value, hash });
        if (!result.ok) {
          // A stale page is reloaded next: look at the files again at once, so it gets today's file.
          if (result.status === 409) { checked = 0; cache.clear(); }
          return reply(result.status, { ok: false, code: result.code, problem: result.problem });
        }
        if (!result.unchanged) {
          // The pages show the new file at once, and the next look at the files does not count this write twice.
          version += 1;
          cache.clear();
          seen = signature(root);
          checked = Date.now();
        }
        return reply(200, { ok: true, hash: result.hash });
      }
      if (req.method !== 'GET' || rest[0] !== 'r') return send(res, 404, 'text/plain; charset=utf-8', 'not found');
      const rel = rest.slice(1).join('/');
      if (rel.startsWith(`${VIEWS}/`) && rel.endsWith('.html') && rest.length === 5) {
        const name = rest[4].slice(0, -'.html'.length);
        const code = lang();
        const nonce = crypto.randomBytes(16).toString('base64');
        const built = pageHtml(name);
        // A saved answer is shown from the Q&A file instead.
        const answers = built?.guide ? [...questions.values()].filter((q) => q.page === name && q.answer !== null && !q.saved).map((q) => ({
          id: q.id, rev: q.rev, label: q.item?.label ?? '', title: q.item?.title ?? '', question: q.question, html: markdown(q.answer), saved: q.saved,
          savable: Boolean(built.module && q.item && built.files.includes(q.item.title)),
        })) : null;
        const html = interactive(built ? built.html : notFoundPage({ lang: code, now: now() }), { lang: code, pagePath: rel, title: built ? built.title : WORDS[code].title, version: currentVersion(), seq: goto.seq, nonce, review: built?.review ?? null, answers, guide: hasGuide() });
        return send(res, built ? 200 : 404, 'text/html; charset=utf-8', html, { 'Content-Security-Policy': csp(nonce) });
      }
      const type = IMAGES[path.extname(rel).toLowerCase()];
      const file = type && !rest.slice(1).some((p) => p.toLowerCase() === '.git' || p === '..' || p === '.') ? insideRoot(root, rel) : null;
      if (!file || !fs.statSync(file).isFile()) return send(res, 404, 'text/plain; charset=utf-8', 'not found');
      return send(res, 200, type, fs.readFileSync(file));
    } catch (err) {
      log(err);
      return send(res, 500, 'text/plain; charset=utf-8', 'error');
    }
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  // The server alone does not keep the process alive: the extension's connection to the session does.
  server.unref();
  const port = server.address().port;
  const address = (name) => `http://127.0.0.1:${port}/${token}/r/${VIEWS}/${encodeURIComponent(name)}.html`;
  return {
    root, port, token,
    url: address,
    // Sends every page of this server to this page (and to `anchor` on it).
    go: (name, anchor) => {
      const hash = anchor && /^[A-Za-z0-9_-]{1,64}$/.test(anchor) ? `#${anchor}` : '';
      goto = { seq: goto.seq + 1, path: `${VIEWS}/${encodeURIComponent(name)}.html${hash}` };
      return address(name) + hash;
    },
    // The agent's answer to a question asked on the code guide: shown under its item.
    answer: (id, text) => {
      const entry = questions.get(String(id ?? ''));
      if (!entry) return { ok: false, problem: `no question ${id} (asked on the code guide since the canvas started)` };
      const answer = String(text ?? '').replace(/\r\n?/g, '\n').trim().slice(0, 20000);
      if (!answer) return { ok: false, problem: 'the answer is empty' };
      entry.answer = answer;
      entry.rev += 1;
      version += 1;
      cache.clear();
      return { ok: true, page: entry.page };
    },
    refresh: () => { version += 1; },
    close: () => new Promise((resolve) => { server.closeAllConnections?.(); server.close(() => resolve()); }),
  };
}

// The page a canvas opens on, from what the agent or the person asked for.
export function pageName(root, { view: which = 'progress', name } = {}) {
  if (name !== undefined && name !== null && typeof name !== 'string') return { ok: false, problem: 'name must be a string' };
  if (which === 'specs' || (which === 'spec' && (!name || name === 'all'))) return { ok: true, name: 'specs' };
  if (which === 'spec') {
    const wanted = name.replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
    const list = capabilities(root);
    const capability = list.find((c) => c === wanted) ?? list.find((c) => c.toLowerCase() === wanted.toLowerCase());
    if (!capability) return { ok: false, problem: `spec not found: openspec/specs/${wanted}/spec.md` };
    return { ok: true, name: `spec-${changeKey(capability)}` };
  }
  if (which === 'guide') {
    if (!fs.existsSync(path.join(root, GUIDE))) return { ok: false, problem: `no code guide yet: ${GUIDE} (node scripts/guide.mjs init)` };
    const found = locate(root, name);
    if (!found) return { ok: false, problem: `not in the code guide: ${name}` };
    return { ok: true, name: found.page, anchor: found.anchor };
  }
  if (which === 'review') {
    if (!name) return { ok: false, problem: 'name the change to review, such as extract-billing-invoice' };
    if (!changeExists(root, name)) return { ok: false, problem: `change not found: ${name}` };
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
  // Keep serving until Ctrl+C (the server itself does not hold the process).
  setInterval(() => {}, 1 << 30);
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
