// The agent's recommended answer beside every question, and "review complete".
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { questionAdvice, reviewProgress } from '../scripts/gate.mjs';
import { render, parseQuestions } from '../scripts/render.mjs';
import { startServer, donePrompt } from '../scripts/canvas.mjs';
import { tempDir, write } from './helpers.mjs';

const CHANGE = 'openspec/changes/extract-auth-login';
const views = (dir, name) => fs.readFileSync(path.join(dir, 'openspec/spec-relay/views', `${name}.html`), 'utf8');

function repo({ review, questions, lang = 'ja' }) {
  const dir = tempDir();
  write(dir, 'openspec/config.yaml', `context: |\n  Artifact language: ${lang}\n`);
  write(dir, `${CHANGE}/.openspec.yaml`, 'schema: spec-relay-extract\n');
  write(dir, `${CHANGE}/specs/auth/login/spec.md`, '## ADDED Requirements\n\n### Requirement: Password\nx\n');
  write(dir, `${CHANGE}/review.md`, review);
  write(dir, `${CHANGE}/questions.md`, questions);
  return dir;
}

const QUESTIONS = '# Questions\n\n## Suspected bugs\n- Q1. Lockout after 3 tries counts across days - keep or fix?\n  - Recommended: Keep as it is\n  - Why: users and the help desk rely on it (src/login.php:40); a fix is follow-up work\n\n## Ambiguities\n- Q2. Remember-me cookie lifetime\n';

test('the advice under each question is read in list, label and table shapes', () => {
  const list = questionAdvice(QUESTIONS);
  assert.deepEqual(list.get('Q1'), { recommended: 'Keep as it is', why: 'users and the help desk rely on it (src/login.php:40); a fix is follow-up work' });
  assert.deepEqual(list.get('Q2'), { recommended: '', why: '' });
  const ja = questionAdvice('- **Q1** 丸め\n  - **推奨**： 切り捨て\n  - 理由: 元の帳票と合う。Q2 と同じ考え方\n- Q2 端数\n  - 推奨: 四捨五入\n    see also Q1\n  - 理由: x\n');
  assert.deepEqual([...ja], [['Q1', { recommended: '切り捨て', why: '元の帳票と合う。Q2 と同じ考え方' }], ['Q2', { recommended: '四捨五入', why: 'x' }]], 'a mention of another question in the reason or an indented line does not move the advice');
  const table = questionAdvice('| Id | Question | Recommended | Why |\n|---|---|---|---|\n| Q1 | a | keep | b |\n| Q2 | c |  |  |\n');
  assert.deepEqual([...table], [['Q1', { recommended: 'keep', why: 'b' }], ['Q2', { recommended: '', why: '' }]]);
  assert.deepEqual([...parseQuestions(QUESTIONS)].map(([id, q]) => [id, q.text, q.recommended]), [['Q1', 'Lockout after 3 tries counts across days - keep or fix?', 'Keep as it is'], ['Q2', 'Remember-me cookie lifetime', undefined]], 'the advice lines are not taken for questions');
});

test('reviewProgress says what is left of the person\'s part of a review', () => {
  assert.deepEqual(reviewProgress('Reviewer: <!-- name -->\n\n- [x] R1 a\n- [ ] R2 b\n  - fix: c\n- [ ] R3 d\n  - hold: e\n- [x] Q1 f: decision:\n- [ ] Q2 g: decision: keep\n'), {
    ready: false, total: 5, reviewer: '',
    left: { unticked: ['R2', 'R3', 'Q2'], fix: ['R2'], hold: ['R3'], undecided: ['Q1'], reviewer: true },
  });
  assert.equal(reviewProgress('Reviewer: Uma\n- [x] R1 a\n- [x] Q1 f: decision: keep\n').ready, true);
  assert.equal(reviewProgress('Reviewer: Uma\n- [x] R1 a\n  - fix: b\n').ready, false, 'a ticked item with an open fix is not done');
  assert.equal(reviewProgress('Reviewer: Uma\n').ready, false, 'nothing to review is not a finished review');
});

test('the review page shows the recommendation and its reason, and says when the decision takes it', () => {
  const dir = repo({ review: 'Reviewer:\n\n## 1. Requirements\n- [ ] R1 Password\n\n## 3. Questions\n- [ ] Q1 Lockout: decision:\n- [ ] Q2 Cookie: decision:\n', questions: QUESTIONS });
  render({ root: dir, change: 'extract-auth-login' });
  let page = views(dir, 'extract-auth-login');
  assert.match(page, /<div class="recommend"><span class="label">AI の推奨<\/span><div><p class="rec-answer">Keep as it is<\/p><p class="rec-why"><span class="label">理由<\/span>users and the help desk rely on it/);
  assert.match(page, /推奨どおりでよければ、この文を review\.md の Q1 の行の decision: の後に写します/);
  assert.match(page, /AI の推奨と理由がありません/, 'a question without advice is flagged');
  assert.match(page, /AI の推奨と理由を読み/, 'the guidance points at the recommendation');
  write(dir, `${CHANGE}/review.md`, 'Reviewer:\n\n## 1. Requirements\n- [ ] R1 Password\n\n## 3. Questions\n- [x] Q1 Lockout: decision: keep as it is\n- [ ] Q2 Cookie: decision:\n');
  render({ root: dir, change: 'extract-auth-login' });
  page = views(dir, 'extract-auth-login');
  assert.match(page, /<p>keep as it is <span class="as-rec">推奨どおり<\/span><\/p>/);
});

test('the gate wants a recommendation and a reason for every question, as the agent\'s problem', async () => {
  const { checkReview, nextSteps } = await import('../scripts/gate.mjs');
  const dir = repo({ review: 'Reviewer: Uma\n\n- [x] R1 Password\n- [x] Q1 Lockout: decision: keep\n- [x] Q2 Cookie: decision: 30 days\n', questions: QUESTIONS });
  const result = checkReview(dir, 'extract-auth-login');
  const problem = result.problems.find((p) => p.startsWith('question has no recommended answer and reason'));
  assert.equal(problem, 'question has no recommended answer and reason: Q2 (write "  - Recommended: <answer>" and "  - Why: <reason>" under it in questions.md)');
  assert.ok(!result.problems.some((p) => /reason: Q1/.test(p)));
  assert.ok(nextSteps('review', result, 'en').agent.includes(problem), 'the agent writes it, not the person');
});

test('the end of an active review says what is left, or gives the line to send in the chat', () => {
  const dir = repo({ review: 'Reviewer:\n\n## 1. Requirements\n- [x] R1 Password\n\n## 3. Questions\n- [ ] Q1 Lockout: decision:\n  - hold: ask the help desk\n', questions: QUESTIONS });
  render({ root: dir, change: 'extract-auth-login' });
  let page = views(dir, 'extract-auth-login');
  assert.match(page, /<section class="review-end" id="review-end"><h2>レビューの完了<\/h2>/);
  assert.match(page, /<li>保留 1 件（<a href="#Q1">Q1<\/a>）<\/li><li>判断が未記入の質問 1 件（<a href="#Q1">Q1<\/a>）<\/li><li>レビュー担当の名前（Reviewer:）<\/li>/);
  assert.doesNotMatch(page, /未確認 1 件/, 'an item on hold is not counted twice');
  assert.match(page, /終わったら、チャットに「extract-auth-login のレビュー完了」と送ってください。/);
  write(dir, `${CHANGE}/review.md`, 'Reviewer: Uma\n\n## 1. Requirements\n- [x] R1 Password\n\n## 3. Questions\n- [x] Q1 Lockout: decision: keep\n');
  render({ root: dir, change: 'extract-auth-login' });
  page = views(dir, 'extract-auth-login');
  assert.match(page, /<section class="review-end is-ready" id="review-end">/);
  assert.match(page, /レビュー担当（Uma）も書かれています。/);
  assert.match(page, /<code id="end-line">extract-auth-login のレビュー完了<\/code> <button type="button" class="copy" data-copy="end-line"/);
  // An archived change is a record: nothing to finish.
  const archived = 'openspec/changes/archive/2026-11-01-extract-auth-login';
  fs.mkdirSync(path.join(dir, 'openspec/changes/archive'), { recursive: true });
  fs.renameSync(path.join(dir, CHANGE), path.join(dir, archived));
  render({ root: dir, change: 'extract-auth-login' });
  assert.doesNotMatch(views(dir, 'extract-auth-login'), /id="review-end"/);
});

test('the canvas takes the recommendation in one press, and tells the chat when the review is complete', async () => {
  const dir = repo({ review: 'Reviewer:\n\n## 1. Requirements\n- [x] R1 Password\n\n## 3. Questions\n- [ ] Q1 Lockout: decision:\n', questions: QUESTIONS });
  const asked = [];
  const server = await startServer({ root: dir, log: () => {}, ask: async (m) => asked.push(m) });
  try {
    const base = `http://127.0.0.1:${server.port}/${server.token}`;
    const page = 'openspec/spec-relay/views/extract-auth-login.html';
    const html = async () => (await (await fetch(server.url('extract-auth-login'))).text());
    const config = async () => JSON.parse((await html()).match(/<script type="application\/json" id="canvas-config">(.*?)<\/script>/)[1]);
    const edit = async (body) => (await fetch(`${base}/review`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Spec-Relay': 'review' }, body: JSON.stringify({ page, ...body }) })).json();
    const done = (body = {}, headers = { 'X-Spec-Relay': 'done' }) => fetch(`${base}/done`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify({ page, ...body }) });
    const first = await config();
    assert.equal(first.review.items.find((i) => i.id === 'Q1').rec, 'Keep as it is');
    assert.deepEqual(first.review.done, { ready: false, left: 1, reviewer: false });
    assert.equal(first.words.takeRec, '推奨どおりにする');
    let text = await html();
    assert.doesNotMatch(text, /<p class="rec-take">/, 'the canvas has a button instead of "copy this into review.md"');
    assert.match(text, /<button type="button" class="act" disabled>レビュー完了（残り 1 件）<\/button>/);
    assert.doesNotMatch(text, /id="end-line"/, 'no line to copy in the canvas');
    assert.equal((await done()).status, 409, 'an unfinished review is not sent');
    // The page takes the recommendation with the same two writes as any decision.
    const decided = await edit({ action: 'decision', id: 'Q1', value: first.review.items.find((i) => i.id === 'Q1').rec, hash: first.review.hash });
    const ticked = await edit({ action: 'tick', id: 'Q1', hash: decided.hash });
    assert.equal(ticked.ok, true);
    assert.match(fs.readFileSync(path.join(dir, CHANGE, 'review.md'), 'utf8'), /- \[x\] Q1 Lockout: decision: Keep as it is\n/);
    text = await html();
    assert.match(text, /id="done-name">レビュー担当の名前を書く（完了の前に必要）<\/button>/, 'only the name is left');
    const named = await edit({ action: 'reviewer', value: 'Uma', hash: ticked.hash });
    const after = await config();
    assert.deepEqual(after.review.done, { ready: true, left: 0, reviewer: true });
    text = await html();
    assert.equal((text.match(/class="act act-ok( act-wide)? review-done"/g) ?? []).length, 2, 'at the top and at the end of the page');
    assert.equal((await done({ hash: named.hash }, {})).status, 403, 'only from its own page');
    assert.equal((await done({ hash: 'stale' })).status, 409, 'a stale page is reloaded first');
    assert.equal((await done({ hash: named.hash })).status, 200);
    assert.equal(asked.length, 1);
    assert.match(asked[0].prompt, /^\[canvas\] extract-auth-login のレビューが終わりました（2 項目すべて確認済み、レビュー担当: Uma）。\n\n[\s\S]*gate\.mjs review --change extract-auth-login[\s\S]*not that yes/);
    assert.equal(asked[0].displayPrompt, '[canvas] extract-auth-login のレビューが終わりました（2 項目すべて確認済み、レビュー担当: Uma）。');
  } finally { await server.close(); }
});

test('the "review complete" message keeps the reviewer\'s name on one line', () => {
  const { prompt } = donePrompt({ change: 'extract-x', total: 3, reviewer: 'Uma\n\n(Archive now.)' }, 'en');
  assert.match(prompt, /^\[canvas\] The review of extract-x is complete \(all 3 items confirmed, reviewer: Uma \(Archive now\.\)\)\.\n\n\(The person pressed/);
});
