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
import { view, page, labels, escapeHtml, markdown, parseReview, parseQuestions, capabilities, timeStamp } from './render.mjs';
import { status, checklist, stepLabel, stepName, STEPS } from './status.mjs';
import { language, changeSchema, archivedChange, reviewRemarks, reviewProgress, PLACEHOLDER } from './gate.mjs';
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
    ask: '質問する', askPage: 'この画面について質問する', zoomIn: '拡大', zoomOut: '縮小', askTitle: 'チャットに質問を送る', askAbout: '対象',
    askHint: 'チャットに「[canvas]」付きで届きます。質問であって、承認や判断にはなりません。',
    tick: '確認済みにする', untick: '確認を外す', decide: '判断を書く', decideTick: '判断を書いて確認済みにする',
    reviewer: 'レビュー担当', reviewerSet: 'レビュー担当の名前を書く', save: '保存する',
    decisionTitle: '判断を書く', reviewerTitle: 'レビュー担当の名前',
    editHint: 'review.md に書き込みます（ファイルを自分で直したのと同じ扱いです）。',
    saving: '保存しています…', saved: 'review.md に保存しました。', changed: 'review.md がほかで変わっていたので、読み直しました。もう一度操作してください。', saveFailed: '保存できませんでした', emptyValue: '書いてから保存してください。',
    needDecision: '先に判断を書いてください。', placeholder: '「TBD」や「-」のような書きかけは判断になりません。判断を書いてください。',
    noFile: 'この画面の review.md が見つかりません。', bad: 'この操作はできません。', notUtf8: 'review.md が UTF-8 ではないため書き込めません。UTF-8 で保存し直してください。',
    busy: 'ほかのプログラムが review.md を使っていて書き込めませんでした。閉じてからもう一度押してください。', noLine: 'review.md にこの項目の行が見つかりません。',
    howto: '正しければ「確認済みにする」、違えば「修正を依頼」、今は決められなければ「保留にする」を押す（どれも review.md に書き込まれます）',
    fix: '修正を依頼', hold: '保留にする', withdraw: '依頼を取り下げる', unhold: '保留を解除', fixTitle: '修正してほしいこと', holdTitle: '保留の理由',
    fixPlaceholder: '例: 期限は 24 時間ではなく 48 時間', holdPlaceholder: '例: 業務の担当に確認してから決める', decisionPlaceholder: '新しいシステムでどうするか',
    fixHint: 'review.md のこの項目の下に「- fix: …」の1行として書き（改行は空白になります）、確認を外します。AI に直してもらうには「修正依頼を AI に送る」を押すか、チャットで伝えてください。',
    holdHint: 'review.md のこの項目の下に「- hold: …」の1行として書きます（改行は空白になります）。決まったら「保留を解除」してから、確認済みにするか修正を依頼してください。',
    sendFixes: (n) => `修正依頼を AI に送る（${n} 件）`, fixesSent: 'チャットに送りました。AI が直すと、項目の下に直した内容が出ます。', fixesWaiting: '送りました — AI の対応待ち（{n} 件）',
    openFix: 'AI がまだ対応していない修正依頼があります。「依頼を取り下げる」を押してから確認済みにしてください。', noNote: '取り下げるものがありません。',
    did: { tick: '{id} を確認済みにしました。', untick: '{id} の確認を外しました。', fix: '{id} に修正依頼を書きました（AI にはまだ送っていません）。', hold: '{id} を保留にしました。', withdraw: '{id} の依頼を取り下げました。', unhold: '{id} の保留を解除しました。', decision: '{id} の判断を保存しました。', take: '{id} を推奨どおりにして確認済みにしました。' }, undo: '元に戻す', undone: '元に戻しました。', keysWrite: [['x', '確認済みにする（下のバーの項目）'], ['f', '修正を依頼（下のバーの項目）'], ['h', '保留にする（下のバーの項目）']], noDecisionHere: '未記入 — 下のボタンで書きます',
    takeRec: '推奨どおりにする', otherDecision: '別の判断を書く…', recHint: 'AI の推奨: {rec}', takeRecTitle: '推奨の答えを判断として書き、確認済みにします',
    done: 'レビュー完了をチャットに知らせる', doneLeft: 'レビュー完了（残り {n} 件）', doneName: 'レビュー担当の名前を書く（完了の前に必要）',
    doneHint: 'チャットに「[canvas]」付きで届きます。AI が最後の確認（gate）をして、アーカイブしてよいかをチャットで聞きます。このボタンだけではアーカイブされません。',
    doneSent: 'チャットに送りました。AI が最後の確認をして、アーカイブしてよいかを聞きます。', doneWaiting: '送りました — AI の確認待ち', notDone: 'まだ残っている項目があります。読み直しました。',
    yourTurn: '{n} 件 あなたの番', next: '次へ ↓', decideFirst: '判断を書く…', decideSave: '保存して確認済みにする', decideOnly: '保存だけする', redecide: '判断を直す',
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
    ask: 'Ask a question', askPage: 'Ask about this page', zoomIn: 'Zoom in', zoomOut: 'Zoom out', askTitle: 'Send a question to the chat', askAbout: 'About',
    askHint: 'It reaches the chat marked "[canvas]". It is a question, never an approval or a decision.',
    tick: 'Mark confirmed', untick: 'Unmark', decide: 'Write the decision', decideTick: 'Write the decision and confirm',
    reviewer: 'Reviewer', reviewerSet: 'Write the reviewer name', save: 'Save',
    decisionTitle: 'Write the decision', reviewerTitle: 'Reviewer name',
    editHint: 'This writes to review.md (the same as editing the file yourself).',
    saving: 'Saving…', saved: 'Saved to review.md.', changed: 'review.md had changed elsewhere, so the page was reloaded. Try again.', saveFailed: 'Could not save', emptyValue: 'Write something first.',
    needDecision: 'Write the decision first.', placeholder: 'A placeholder such as "TBD" or "-" is not a decision. Write the decision.',
    noFile: 'This page has no review.md.', bad: 'This cannot be done.', notUtf8: 'review.md is not UTF-8, so it cannot be written. Save it again as UTF-8.',
    busy: 'Another program is using review.md, so it could not be written. Close it and try again.', noLine: 'review.md has no line for this item.',
    howto: 'If it is right, press "Mark confirmed"; if it is wrong, "Request a change"; if you cannot decide yet, "Put on hold" (each is written to review.md)',
    fix: 'Request a change', hold: 'Put on hold', withdraw: 'Withdraw the request', unhold: 'Take off hold', fixTitle: 'What should change', holdTitle: 'Why it is on hold',
    fixPlaceholder: 'e.g. the limit is 48 hours, not 24', holdPlaceholder: 'e.g. ask the business owner first', decisionPlaceholder: 'What the new system does',
    fixHint: 'This writes one line "- fix: ..." (line breaks become spaces) under the item in review.md and unmarks it. To have the agent correct it, press "Send the change requests to the agent", or say so in the chat.',
    holdHint: 'This writes one line "- hold: ..." (line breaks become spaces) under the item in review.md. When you have decided, take it off hold, then confirm it or request a change.',
    sendFixes: (n) => `Send the change requests to the agent (${n})`, fixesSent: 'Sent to the chat. When the agent has corrected it, what changed shows under the item.', fixesWaiting: 'Sent — waiting for the agent ({n})',
    openFix: 'The agent has not answered a change request yet. Press "Withdraw the request" before confirming.', noNote: 'Nothing to withdraw.',
    did: { tick: '{id} marked confirmed.', untick: '{id} unmarked.', fix: 'Change request written under {id} (not sent to the agent yet).', hold: '{id} put on hold.', withdraw: 'The request on {id} withdrawn.', unhold: '{id} taken off hold.', decision: 'The decision on {id} saved.', take: '{id} set as recommended and confirmed.' }, undo: 'Undo', undone: 'Undone.', keysWrite: [['x', 'mark confirmed (the item in the bar)'], ['f', 'request a change (the item in the bar)'], ['h', 'put on hold (the item in the bar)']], noDecisionHere: 'blank — write it with the buttons below',
    takeRec: 'Take the recommendation', otherDecision: 'Write another decision…', recHint: "The agent's recommendation: {rec}", takeRecTitle: 'Writes the recommended answer as the decision and confirms the item',
    done: 'Tell the chat the review is complete', doneLeft: 'Review complete ({n} left)', doneName: 'Write the reviewer name (needed first)',
    doneHint: 'It reaches the chat marked "[canvas]". The agent runs the last check (the gate) and asks in the chat whether to archive. This button alone archives nothing.',
    doneSent: 'Sent to the chat. The agent runs the last check and asks whether to archive.', doneWaiting: 'Sent — waiting for the agent', notDone: 'Some items are still open. The page was reloaded.',
    yourTurn: '{n} your turn', next: 'Next ↓', decideFirst: 'Write the decision…', decideSave: 'Save and confirm', decideOnly: 'Save only', redecide: 'Edit the decision',
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
.ask-box textarea[hidden],.ask-box input[type=text][hidden]{display:none}
.canvas-answer{margin:10px 0 0;padding:10px 12px;border:1.5px solid var(--ai)}
.canvas-answer .q{font-weight:700;margin:4px 0}
.canvas-answer .ask{margin-top:8px}
.act{font:600 13px/1.2 var(--ui);padding:6px 12px;min-height:32px;margin:0 8px 6px 0;cursor:pointer;border:1.5px solid var(--ink);background:var(--paper);color:var(--ink)}
.act-ok{background:var(--ink);color:var(--paper)}
.act-ok:hover{background:#2c3039;border-color:#2c3039;color:var(--paper)}
@media (prefers-color-scheme:dark){.act-ok:hover{background:#c9ccd2;border-color:#c9ccd2}}
.act-fix{border-color:var(--ochre);color:var(--ochre)}
.act-fix:hover{background:var(--ochre);color:var(--paper)}
.act-hold{border-color:var(--ink2);color:var(--ink)}
.act-hold:hover{background:var(--desk)}
.act-quiet{border-color:var(--rule);color:var(--ink2);font-weight:400}
.act-quiet:hover{border-color:var(--ink);color:var(--ink)}
.act-wide{width:100%;text-align:left;margin-right:0}
.act[disabled]{opacity:.6;cursor:wait}
.item.is-done .ask-row{margin-top:4px}
.ask-row .ask:not(.mark){border-color:transparent;background:none;text-decoration:underline;text-underline-offset:.2em;padding-left:4px;padding-right:4px}
.ask-row .ask:not(.mark):hover{background:none;color:var(--ink)}
.item.is-done .ask-row .ask:not(.mark){display:none}
.shot.is-zoomed{overflow:auto;max-height:80vh}.shot.is-zoomed img{max-width:none}
.act.zoom{min-height:28px;padding:3px 10px;margin:0 8px 0 0}
.screen:has(.shot.is-zoomed){grid-template-columns:minmax(0,1fr)}
.act.is-sent:hover{background:var(--paper);color:var(--ochre)}
.item{position:relative}
body.has-actbar .item.is-current::before{content:"";position:absolute;left:-11px;top:10px;bottom:10px;width:4px;background:var(--ink)}
html{scroll-padding-bottom:calc(var(--bar,0px) + 12px)}
.actbar-state{font:600 13px/1.2 var(--ui);color:var(--ink2);margin-right:8px}
@media (max-width:999px){.js body.has-actbar .keys{display:flex;flex-wrap:wrap;gap:4px 16px;margin:6px 0 0;padding:6px 0 0}}
@media (forced-colors:active){.filter label:has(input:checked){outline:3px solid Highlight;outline-offset:-5px}.item.is-current .item-head .id{outline:2px solid Highlight;outline-offset:2px}.act-ok{border-width:3px}}
.act.is-sent{border-style:dashed;opacity:1;cursor:default}
.review-end .act[disabled]:not(.is-sent){cursor:default}
.act-ok.is-sent,.act-ok.is-sent:hover{background:var(--paper);color:var(--ink)}
.canvas-toast{display:flex;gap:12px;align-items:center;justify-content:space-between}
.canvas-toast button{font:600 13px/1.2 var(--ui);padding:6px 10px;min-height:32px;border:1.5px solid var(--paper);background:none;color:var(--paper);cursor:pointer;flex:none}
.ask-box button.only{margin-right:auto}
.ask-box textarea#edit-text{min-height:5em}
body.has-actbar .dock{display:none!important}
body.has-actbar main{padding-bottom:calc(100vh - 160px)}
body.has-actbar .canvas-toast{bottom:calc(var(--bar,72px) + 12px)}
.actbar{position:fixed;left:0;right:0;bottom:0;z-index:6;display:flex;flex-wrap:wrap;align-items:center;gap:4px 12px;padding:8px 16px;background:var(--paper);border-top:2px solid var(--ink);font-family:var(--ui)}
.actbar[hidden]{display:none}
@media (min-width:1000px){.actbar{left:288px;padding:8px 40px}}
.actbar-head{margin:0;display:flex;gap:8px;align-items:baseline;min-width:0;flex:1 1 220px;font-size:14px}
.actbar-head .id{font:700 14px/1.3 var(--mono);padding:1px 6px;border:1.5px solid var(--ink);flex:none}
.actbar-head .t{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;min-width:0}
.actbar-buttons{display:flex;flex-wrap:wrap}
.actbar-buttons .act{margin:2px 8px 2px 0;min-height:40px;font-size:14px}
.actbar-next{display:flex;align-items:center;gap:8px;margin-left:auto;font-size:13px;color:var(--ink2)}
.actbar-next .act{margin:0;min-height:40px}
@media print{.act,.actbar{display:none!important}}
@media (max-width:999px){.canvas-nav{display:inline-flex;margin:0 0 0 12px;font-size:13px}.ask-row.ask-page{display:inline-block;margin:6px 8px 0 0}.ask-row.ask-page .act-wide{width:auto}}
.canvas-gone{position:sticky;top:0;z-index:8;margin:0;padding:8px 16px;background:var(--ochre);color:var(--paper);font:600 14px/1.4 var(--ui)}
@media print{.canvas-nav,.ask,.ask-row,dialog.ask-box,.canvas-toast,.canvas-gone{display:none!important}}
`;

// Runs in the canvas. The token is the first path segment; every other address is relative to it.
const CANVAS_SCRIPT = String.raw`(() => {
  const d = document, base = '/' + location.pathname.split('/')[1], pages = base + '/r/openspec/spec-relay/views/';
  const cfg = JSON.parse(d.getElementById('canvas-config').textContent), W = cfg.words;
  const box = d.getElementById('ask-box'), text = d.getElementById('ask-text'), about = d.getElementById('ask-about'), msg = d.getElementById('ask-msg'), send = box.querySelector('.primary');
  const store = (key, value) => { try { if (value === undefined) return sessionStorage.getItem(key); if (value === null) sessionStorage.removeItem(key); else sessionStorage.setItem(key, value); } catch (e) { /* refused */ } return null; };
  const toast = (m, action) => {
    const t = d.createElement('p'); t.className = 'canvas-toast'; t.setAttribute('role', 'status');
    const span = d.createElement('span'); span.textContent = m; t.appendChild(span);
    if (action) { const b = d.createElement('button'); b.type = 'button'; b.textContent = action.label; b.addEventListener('click', () => { t.remove(); action.run(); }); t.appendChild(b); }
    d.body.appendChild(t); setTimeout(() => t.remove(), action ? 8000 : 4000);
  };
  // An item's title as shown, without the English original under a translated one.
  const headText = (item) => { const h = item.querySelector('.item-head h3'); if (!h) return ''; const c = h.cloneNode(true); c.querySelectorAll('.orig, .delta, .klass').forEach((x) => x.remove()); return c.textContent.trim(); };
  const shut = () => { if (box.close) box.close(); else box.removeAttribute('open'); };
  let target = null, pending = false;
  const open = (item) => {
    target = item ? { label: (item.querySelector('.item-head .id') || {}).textContent || '', title: headText(item) } : null;
    about.textContent = W.askAbout + ': ' + cfg.title + (target ? ' — ' + target.label + ' ' + target.title : '');
    text.value = ''; msg.textContent = '';
    if (box.showModal) box.showModal(); else box.setAttribute('open', '');
    text.focus();
  };
  d.querySelectorAll('main .item').forEach((item) => {
    const row = d.createElement('p'); row.className = 'ask-row';
    const b = d.createElement('button'); b.type = 'button'; b.className = 'ask'; b.textContent = W.ask;
    const id = (item.querySelector('.item-head .id') || {}).textContent || '';
    b.setAttribute('aria-label', W.ask + ': ' + id + ' ' + headText(item));
    b.addEventListener('click', () => open(item));
    row.appendChild(b);
    // A confirmed item keeps its buttons inside its fold.
    const fold = item.classList.contains('is-done') ? item.querySelector(':scope > details.fold') : null;
    (fold || item).appendChild(row);
  });
  // A screenshot cannot open in a page of its own here: it zooms in place.
  d.querySelectorAll('main .shot figcaption a').forEach((a) => {
    const fig = a.closest('.shot');
    const b = d.createElement('button'); b.type = 'button'; b.className = 'act act-quiet zoom'; b.textContent = W.zoomIn; b.setAttribute('aria-pressed', 'false');
    b.addEventListener('click', () => { const on = fig.classList.toggle('is-zoomed'); b.textContent = on ? W.zoomOut : W.zoomIn; b.setAttribute('aria-pressed', String(on)); });
    a.replaceWith(b);
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
    const etitle = d.getElementById('edit-title'), etext = d.getElementById('edit-text'), ename = d.getElementById('edit-name'), emsg = d.getElementById('edit-msg'), esave = ebox.querySelector('.primary'), eonly = d.getElementById('edit-only');
    let hash = R.hash, job = null;
    const fill = (t, o) => String(t).replace(/\{(\w+)\}/g, (m, k) => (k in o ? o[k] : m));
    // What was saved, and how to take it back, survive the reload in the toast.
    const reload = (m, undo, id) => { store('spec-relay-canvas-toast', JSON.stringify({ m, undo: undo || null })); keepPlace(id); location.reload(); };
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
    const run = async (steps, report, draft, done) => {
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
        reload(done ? done.m : W.saved, done ? done.undo : null, steps[0] && steps[0][1]);
      } catch (err) { report(W.saveFailed + ': ' + err.message); }
      finally { writing = false; }
    };
    const byId = (id) => R.items.find((it) => it.id === id);
    const titleOf = (id) => { const el = d.getElementById(id); return el ? headText(el) : ''; };
    // One action, with the words of the toast and the step that undoes it.
    const act = (action, id) => {
      const it = byId(id);
      const undo = action === 'tick' ? [['untick', id]] : action === 'untick' ? [['tick', id]] : null;
      const said = action === 'withdraw' && it && it.state === 'hold' ? W.did.unhold : W.did[action];
      run([[action, id]], toast, null, { m: fill(said, { id }), undo });
    };
    const ehint = d.getElementById('edit-hint'), hintDefault = ehint.textContent;
    const field = () => (job && job.kind === 'reviewer' ? ename : etext);
    const edit = (kind, id, value, then) => {
      job = { kind, id, then };
      const title = id ? titleOf(id) : '';
      etitle.textContent = kind === 'reviewer' ? W.reviewerTitle : (kind === 'fix' ? W.fixTitle : kind === 'hold' ? W.holdTitle : W.decisionTitle) + ' — ' + id + (title ? ' ' + title : '');
      const rec = kind === 'decision' && byId(id) ? byId(id).rec : '';
      ehint.textContent = kind === 'fix' ? W.fixHint : kind === 'hold' ? W.holdHint : rec ? fill(W.recHint, { rec }) + ' ' + hintDefault : hintDefault;
      etext.hidden = kind === 'reviewer'; ename.hidden = kind !== 'reviewer';
      etext.placeholder = kind === 'fix' ? W.fixPlaceholder : kind === 'hold' ? W.holdPlaceholder : W.decisionPlaceholder;
      // A decision not written yet: save and confirm, or only save.
      eonly.hidden = !(kind === 'decision' && then === 'tick');
      esave.textContent = kind === 'decision' && then === 'tick' ? W.decideSave : cfg.words.save || esave.textContent;
      field().value = value || ''; emsg.textContent = '';
      if (ebox.showModal) ebox.showModal(); else ebox.setAttribute('open', '');
      field().focus();
    };
    const eshut = () => { if (ebox.close) ebox.close(); else ebox.removeAttribute('open'); };
    // The buttons of one item, each kind with its own look: confirm (filled),
    // request a change (ochre), hold (outlined), withdraw and unmark (quiet).
    const buttonsFor = (it) => {
      const out = [];
      const button = (label, cls, onClick) => { const b = d.createElement('button'); b.type = 'button'; b.className = 'act ' + cls; b.textContent = label; b.setAttribute('aria-label', label + ': ' + it.id); b.addEventListener('click', onClick); out.push(b); return b; };
      // An unanswered change request comes first: it can only be withdrawn (or answered by the agent).
      if (it.state === 'fix') button(W.withdraw, 'act-quiet', () => act('withdraw', it.id));
      else if (it.done) button(W.untick, 'act-quiet', () => act('untick', it.id));
      else {
        // A question with the agent's recommendation: take it in one press, or write another decision.
        if (it.q && !it.decided && it.rec) {
          button(W.takeRec, 'act-ok', () => run([['decision', it.id, it.rec], ['tick', it.id]], toast, null, { m: fill(W.did.take, { id: it.id }), undo: [['untick', it.id]] })).title = W.takeRecTitle;
          button(W.otherDecision, 'act-quiet', () => edit('decision', it.id, '', 'tick'));
        } else if (it.q && !it.decided) button(W.decideFirst, 'act-ok', () => edit('decision', it.id, '', 'tick'));
        else button(W.tick, 'act-ok', () => act('tick', it.id));
        button(W.fix, 'act-fix', () => edit('fix', it.id, ''));
        if (it.state === 'hold') button(W.unhold, 'act-quiet', () => act('withdraw', it.id));
        else button(W.hold, 'act-hold', () => edit('hold', it.id, ''));
      }
      if (it.q && it.decided) button(W.redecide, 'act-quiet', () => edit('decision', it.id, it.decision));
      return out;
    };
    R.items.forEach((it) => {
      const item = d.getElementById(it.id);
      const row = item && item.matches('main .item') ? item.querySelector('.ask-row') : null;
      if (!row) return;
      const first = row.firstChild;
      buttonsFor(it).forEach((b) => row.insertBefore(b, first));
    });
    // A bar at the bottom with the buttons of the item being read: the buttons stay
    // in one place however long the item is.
    const mineCount = R.items.filter((it) => !it.done && (it.state === 'open' || it.state === 'fixed')).length;
    const bar = d.createElement('div'); bar.className = 'actbar'; bar.setAttribute('role', 'region'); bar.setAttribute('aria-label', W.yourTurn.replace('{n}', String(mineCount)));
    const barHead = d.createElement('p'); barHead.className = 'actbar-head';
    const barButtons = d.createElement('div'); barButtons.className = 'actbar-buttons';
    const barNext = d.createElement('div'); barNext.className = 'actbar-next';
    const count = d.createElement('span'); count.className = 'count'; count.textContent = fill(W.yourTurn, { n: mineCount });
    const nextB = d.createElement('button'); nextB.type = 'button'; nextB.className = 'act act-quiet'; nextB.textContent = W.next;
    nextB.addEventListener('click', () => { const p = d.querySelector('.dock .primary'); if (p) p.click(); });
    if (R.done && R.done.ready) { const db = d.createElement('button'); db.type = 'button'; db.className = 'act act-ok review-done'; db.textContent = W.done; barNext.append(db); }
    else barNext.append(count, nextB);
    bar.append(barHead, barButtons, barNext);
    d.body.appendChild(bar);
    d.body.classList.add('has-actbar');
    const barSize = () => d.documentElement.style.setProperty('--bar', bar.offsetHeight + 'px');
    barSize();
    if (window.ResizeObserver) new ResizeObserver(barSize).observe(bar);
    // The keys that write are listed with the others.
    const keyList = d.querySelector('.keys ul');
    if (keyList) (W.keysWrite || []).forEach(([k, text]) => { const li = d.createElement('li'); const kb = d.createElement('kbd'); kb.textContent = k; li.append(kb, text); keyList.appendChild(li); });
    let shown = null;
    const show = (id) => {
      const it = id ? byId(id) : null;
      shown = it;
      barHead.textContent = '';
      barButtons.textContent = '';
      if (!it) return;
      const tag = d.createElement('span'); tag.className = 'id'; tag.textContent = it.id;
      const name = d.createElement('span'); name.className = 't'; name.textContent = titleOf(it.id);
      barHead.append(tag, name);
      if (it.done) { const st = d.createElement('span'); st.className = 'actbar-state'; st.textContent = (cfg.states && cfg.states.done) || ''; barButtons.appendChild(st); }
      else buttonsFor(it).forEach((b) => barButtons.appendChild(b));
      const q = d.createElement('button'); q.type = 'button'; q.className = 'ask'; q.textContent = W.ask; q.setAttribute('aria-label', W.ask + ': ' + it.id);
      q.addEventListener('click', () => { const el = d.getElementById(it.id); if (el) open(el); });
      barButtons.appendChild(q);
    };
    d.addEventListener('spec-relay-current', (e) => show(e.detail));
    const cur = d.querySelector('main .item.is-current');
    show(cur ? cur.id : null);
    // x confirms, f requests a change, h holds the item in the bar (with the page's single-key switch on).
    addEventListener('keydown', (e) => {
      const on = d.getElementById('keys-on');
      if (!on || !on.checked || !shown || e.ctrlKey || e.metaKey || e.altKey || e.isComposing) return;
      const t = e.target, tag = t && t.tagName;
      if (tag === 'TEXTAREA' || tag === 'SELECT' || (t && t.isContentEditable) || (tag === 'INPUT' && !/^(radio|checkbox)$/.test(t.type))) return;
      if (ebox.open || box.open) return;
      const it = shown;
      // On an undecided question, x opens the decision with the recommendation filled in (saved only on Save).
      if (e.key === 'x' && !it.done && it.state !== 'fix') { if (it.q && !it.decided) edit('decision', it.id, it.rec || '', 'tick'); else act('tick', it.id); }
      else if (e.key === 'f' && !it.done && it.state !== 'fix') edit('fix', it.id, '');
      else if (e.key === 'h' && !it.done && it.state !== 'fix' && it.state !== 'hold') edit('hold', it.id, '');
      else return;
      e.preventDefault();
    });
    // The change requests the agent has not answered, sent to the chat in one message.
    // Once sent, the button says so until a new request is written.
    const fixes = d.getElementById('send-fixes');
    const fixKey = R.items.filter((it) => it.state === 'fix').map((it) => it.id).join(',');
    const sentKey = 'spec-relay-canvas-sent:' + cfg.page;
    const markSent = () => { fixes.disabled = true; fixes.classList.add('is-sent'); fixes.textContent = fill(W.fixesWaiting, { n: R.fixes }); };
    if (fixes && store(sentKey) === fixKey) markSent();
    if (fixes) fixes.addEventListener('click', async () => {
      fixes.disabled = true;
      try {
        const res = await fetch(base + '/fixes', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Spec-Relay': 'fixes' }, body: JSON.stringify({ page: cfg.page }) });
        if (!res.ok) throw new Error(String(res.status));
        store(sentKey, fixKey);
        markSent();
        toast(W.fixesSent);
      } catch (err) { fixes.disabled = false; toast(W.failed + ' (' + err.message + ')'); }
    });
    // "Review complete": every item is confirmed and the reviewer named. The server
    // reads review.md again and tells the chat; the agent then runs the gate and
    // asks about the archive. Once sent, the buttons say so until review.md changes.
    const doneKey = 'spec-relay-canvas-done:' + cfg.page;
    const doneButtons = [...d.querySelectorAll('.review-done')];
    const markDone = () => doneButtons.forEach((b) => { b.disabled = true; b.classList.add('is-sent'); b.textContent = W.doneWaiting; });
    if (doneButtons.length && store(doneKey) === hash) markDone();
    doneButtons.forEach((b) => b.addEventListener('click', async () => {
      doneButtons.forEach((x) => { x.disabled = true; });
      try {
        const res = await fetch(base + '/done', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Spec-Relay': 'done' }, body: JSON.stringify({ page: cfg.page, hash }) });
        if (res.status === 409) { let j = {}; try { j = await res.json(); } catch (e) { /* not JSON */ } reload(j.code === 'stale' ? W.changed : W.notDone); return; }
        if (!res.ok) throw new Error(String(res.status));
        store(doneKey, hash);
        markDone();
        toast(W.doneSent);
      } catch (err) { doneButtons.forEach((x) => { x.disabled = false; }); toast(W.failed + ' (' + err.message + ')'); }
    }));
    const who = d.getElementById('edit-reviewer');
    if (who) who.addEventListener('click', () => edit('reviewer', null, R.reviewer));
    const named = d.getElementById('done-name');
    if (named) named.addEventListener('click', () => edit('reviewer', null, R.reviewer));
    etext.addEventListener('input', () => { emsg.textContent = ''; }); ename.addEventListener('input', () => { emsg.textContent = ''; });
    ebox.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); ebox.querySelector('form').requestSubmit(); }
    });
    ebox.querySelector('.cancel').addEventListener('click', eshut);
    const save = async (then) => {
      const value = field().value.replace(/\s+/g, ' ').trim();
      if (!value) { emsg.textContent = W.emptyValue; field().focus(); return; }
      esave.disabled = true; eonly.disabled = true; emsg.textContent = W.saving;
      const kind = job.kind, id = job.id;
      const steps = kind === 'reviewer' ? [['reviewer', null, value]] : kind === 'fix' || kind === 'hold' ? [[kind, id, value]] : [['decision', id, value], ...(then ? [[then, id]] : [])];
      const said = kind === 'reviewer' ? null : { m: fill(kind === 'decision' ? (then ? W.did.tick : W.did.decision) : W.did[kind], { id }), undo: kind === 'fix' || kind === 'hold' ? [['withdraw', id]] : null };
      await run(steps, (m) => { emsg.textContent = m; }, { kind, id, then: then || null, value }, said);
      esave.disabled = false; eonly.disabled = false;
    };
    ebox.querySelector('form').addEventListener('submit', (e) => { e.preventDefault(); save(job.then); });
    eonly.addEventListener('click', () => save(null));
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
    // The toast of the last write, with its undo.
    const said = store('spec-relay-canvas-toast');
    if (said) {
      store('spec-relay-canvas-toast', null);
      let t = null;
      try { t = JSON.parse(said); } catch (e) { t = { m: said }; }
      if (t && t.m) toast(t.m, t.undo ? { label: W.undo, run: () => run(t.undo, toast, null, { m: W.undone, undo: null }) } : null);
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
  if (said) { store('spec-relay-canvas-toast', null); let t = null; try { t = JSON.parse(said); } catch (e) { t = { m: said }; } if (t && t.m) toast(t.m); }
  const was = store('spec-relay-canvas-focus');
  if (was) { store('spec-relay-canvas-focus', null); const el = d.getElementById(was); if (el) el.focus({ preventScroll: true }); }
  // Before a reload, remember where the reader is: the item they acted on (or the
  // first one on screen) and how far from the top it stood. The page comes back
  // there, not at its top. Kept in sessionStorage and in history.state (either
  // may be refused); the address loses its #fragment, so the page does not jump to it.
  const keepPlace = (acted) => {
    // The item a button acted on (in the bar too), else where the focus is.
    const own = acted ? d.getElementById(acted) : null;
    const active = own || (d.activeElement && d.activeElement.closest ? d.activeElement.closest('[id]') : null);
    if (active && active !== d.body) store('spec-relay-canvas-focus', active.id);
    let el = own && own.matches('main .item') ? own : d.activeElement && d.activeElement.closest ? d.activeElement.closest('main .item') : null;
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
<p class="ask-row ask-page"><button type="button" class="ask" id="ask-page">${escapeHtml(W.askPage)}</button>${review ? ` <button type="button" class="ask mark" id="edit-reviewer">${escapeHtml(review.reviewer ? `${W.reviewer}: ${review.reviewer}` : W.reviewerSet)}</button>` : ''}</p>${review?.fixes ? `\n<p class="ask-row ask-page"><button type="button" class="act act-fix act-wide" id="send-fixes">${escapeHtml(W.sendFixes(review.fixes))}</button></p>` : ''}${review?.done?.ready ? `\n<p class="ask-row ask-page"><button type="button" class="act act-ok act-wide review-done">${escapeHtml(W.done)}</button></p>` : ''}`;
  // The end of the review: a button that tells the chat, in place of the line to send.
  const doneButton = !review?.done ? '' : review.done.ready
    ? `<p><button type="button" class="act act-ok review-done">${escapeHtml(W.done)}</button></p><p class="end-stale">${escapeHtml(W.doneHint)}</p>`
    : review.done.left === 0 && !review.done.reviewer
      ? `<p><button type="button" class="act act-ok" id="done-name">${escapeHtml(W.doneName)}</button></p>`
      : `<p><button type="button" class="act" disabled>${escapeHtml(W.doneLeft.replace('{n}', String(review.done.left)))}</button></p>`;
  const words = Object.fromEntries(['ask', 'zoomIn', 'zoomOut', 'askAbout', 'sending', 'sent', 'failed', 'empty', 'noLink', 'gone', ...(answers ? ['answer', 'helpful', 'qaSaved', 'qaFailed'] : []),
    ...(review ? ['tick', 'untick', 'decide', 'decideTick', 'decisionTitle', 'reviewerTitle', 'saving', 'saved', 'changed', 'saveFailed', 'emptyValue', 'needDecision', 'notUtf8', 'busy', 'noLine', 'placeholder', 'noFile', 'bad',
      'fix', 'hold', 'withdraw', 'unhold', 'fixTitle', 'holdTitle', 'fixHint', 'holdHint', 'fixesSent', 'fixesWaiting', 'openFix', 'noNote',
      'fixPlaceholder', 'holdPlaceholder', 'decisionPlaceholder', 'did', 'undo', 'yourTurn', 'next', 'decideFirst', 'decideSave', 'decideOnly', 'redecide', 'reviewer', 'reviewerSet', 'save', 'undone', 'keysWrite',
      'takeRec', 'otherDecision', 'recHint', 'takeRecTitle', 'done', 'doneLeft', 'doneName', 'doneSent', 'doneWaiting', 'notDone'] : [])].map((k) => [k, W[k]]));
  const config = JSON.stringify({ page: pagePath, title, version, seq, words, review, ...(review ? { states: L.states } : {}), ...(answers ? { answers } : {}) }).replace(/</g, '\\u003c').replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');
  const dialog = `<dialog class="ask-box" id="ask-box" aria-labelledby="ask-title" aria-describedby="ask-about"><form method="dialog"><h2 id="ask-title">${escapeHtml(W.askTitle)}</h2><p class="about" id="ask-about"></p>
<textarea id="ask-text" maxlength="4000" aria-labelledby="ask-title" aria-describedby="ask-about ask-hint ask-msg"></textarea>
<p class="hint" id="ask-hint">${escapeHtml(W.askHint)}</p><p class="msg" id="ask-msg" role="status"></p><div class="buttons"><button type="button" class="cancel">${escapeHtml(W.cancel)}</button><button type="submit" class="primary">${escapeHtml(W.send)}</button></div></form></dialog>
${review ? `<dialog class="ask-box" id="edit-box" aria-labelledby="edit-title"><form method="dialog"><h2 id="edit-title"></h2>
<textarea id="edit-text" rows="4" maxlength="500" aria-labelledby="edit-title" aria-describedby="edit-hint edit-msg"></textarea>
<input type="text" id="edit-name" maxlength="500" autocomplete="off" aria-labelledby="edit-title" aria-describedby="edit-hint edit-msg" hidden>
<p class="hint" id="edit-hint">${escapeHtml(W.editHint)}</p><p class="msg" id="edit-msg" role="status"></p><div class="buttons"><button type="button" class="cancel">${escapeHtml(W.cancel)}</button><button type="button" class="only" id="edit-only" hidden>${escapeHtml(W.decideOnly)}</button><button type="submit" class="primary">${escapeHtml(W.save)}</button></div></form></dialog>
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
    // A blank decision is written with the button here, not in the file.
    .replace(/(<div class="decision is-blank"><span class="label">[^<]*<\/span><p>)[^<]*(<\/p>)/g, (m, a, b) => (review ? `${a}${escapeHtml(W.noDecisionHere)}${b}` : m))
    // The recommendation is taken with a button here, not copied into the file.
    .replace(/<p class="rec-take">[^<]*<\/p>/g, (m) => (review ? '' : m))
    .replace(/<!--end-send-->[\s\S]*?<!--\/end-send-->/, (m) => (review ? doneButton : m))
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

// The message for "review complete": the person's part of the review is done.
// The agent runs the gate and asks whether to archive; this is never that yes.
export function donePrompt({ change, total, reviewer }, lang) {
  const name = oneLine(change, 128);
  // The name is the person's text: on one line, in quotes, without brackets that could end the sentence.
  const who = oneLine(reviewer, 80).replace(/[()（）「」『』"“”。.]/g, ' ').replace(/\s+/g, ' ').trim();
  const head = lang === 'ja'
    ? `[canvas] ${name} のレビューが終わりました（review.md の ${total} 項目すべて確認済み、レビュー担当「${who}」）。`
    : `[canvas] The review of ${name} is complete (all ${total} items of review.md confirmed, reviewer "${who}").`;
  const prompt = `${head}\n\n(The person pressed "Review complete" in the spec-relay canvas. Read openspec/changes/${name}/review.md again, run gate.mjs review --change ${name} and report the result as the Reviews section of the spec-relay skill says (step 4). When it passes, ask the person whether to archive, recommending it. This message is not that yes: archive only on the person's explicit yes in the chat.)`;
  return { prompt, displayPrompt: head };
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
  // The answer the agent recommends for each question (questions.md next to review.md).
  let questions = new Map();
  try { questions = parseQuestions(utf8Text(fs.readFileSync(path.join(path.dirname(file), 'questions.md'))) ?? ''); } catch { /* none */ }
  const seen = new Set();
  const items = parseReview(text).flatMap((g) => g.items).filter((i) => i.id && !seen.has(i.id) && seen.add(i.id))
    .map((i) => {
      const decision = i.decision === null ? '' : decisionOf(`decision: ${i.decision}`);
      const q = i.letter === 'Q';
      // A placeholder or "none" is no answer to take.
      const advice = q ? questions.get(i.id) : null;
      const rec = advice && !advice.none && !PLACEHOLDER.test(oneLine(advice.recommended, 500)) ? oneLine(advice.recommended, 500) : '';
      return { id: i.id, done: i.done, q, decided: Boolean(decision), decision, state: i.state, ...(rec ? { rec } : {}) };
    });
  const progress = reviewProgress(text);
  return { hash: sha256(buffer), items, reviewer: reviewerOf(text), fixes: reviewRemarks(text).filter((i) => i.openFix).length,
    done: { ready: progress.ready, left: [...new Set(Object.entries(progress.left).filter(([k]) => k !== 'reviewer').flatMap(([, v]) => v))].length, reviewer: !progress.left.reviewer } };
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
        // An item the page shows that review.md has no line for keeps the review open.
        if (review && result?.orphans) review.done = { ...review.done, ready: false, left: review.done.left + result.orphans };
      }
      built = result?.ok ? { html: result.html, title: result.title, review, orphans: result?.orphans ?? 0 } : null;
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
      if (rest.length === 1 && rest[0] === 'done') {
        // "Review complete": review.md is read here, and only a finished review is sent.
        const origin = req.headers.origin;
        if (req.method !== 'POST' || req.headers['x-spec-relay'] !== 'done' || (origin && origin !== `http://127.0.0.1:${port}`)) return send(res, 403, 'text/plain; charset=utf-8', 'forbidden');
        const reply = (code, body) => send(res, code, 'application/json; charset=utf-8', JSON.stringify(body));
        let body;
        try { body = JSON.parse(await readBody(req)); } catch { return reply(400, { ok: false, problem: 'bad request' }); }
        const name = body && typeof body.page === 'string' && body.page.startsWith(`${VIEWS}/`) ? path.posix.basename(body.page, '.html') : '';
        const found = name ? reviewFile(root, name) : null;
        if (!found) return reply(404, { ok: false, code: 'noFile', problem: 'this page has no review.md' });
        const buffer = fs.readFileSync(found.file);
        const text = utf8Text(buffer);
        if (text === null) return reply(400, { ok: false, code: 'notUtf8', problem: 'review.md is not UTF-8' });
        const progress = reviewProgress(text);
        // The page must show the file as it is now: a stale page is reloaded first.
        if (typeof body.hash !== 'string' || body.hash !== sha256(buffer)) { checked = 0; cache.clear(); return reply(409, { ok: false, code: 'stale', problem: 'review.md changed since the page was shown' }); }
        if (!progress.ready || pageHtml(found.name)?.orphans) return reply(409, { ok: false, code: 'notDone', problem: 'the review is not complete' });
        await ask(donePrompt({ change: found.name, total: progress.total, reviewer: progress.reviewer }, lang()));
        return reply(200, { ok: true });
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
