import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { register } from 'node:module';
import { pathToFileURL } from 'node:url';
import { startServer, progressPage, interactive, askPrompt, pageName, changesForReview, signature } from '../scripts/canvas.mjs';
import { tempDir, write } from './helpers.mjs';

function repo() {
  const dir = tempDir();
  write(dir, 'openspec/config.yaml', 'context: |\n  Artifact language: ja\n');
  write(dir, 'openspec/specs/billing/invoice/spec.md', '## Purpose\nComputes totals.\n\n## Requirements\n\n### Requirement: Total\nThe system SHALL add the lines.\n');
  write(dir, 'openspec/changes/extract-auth-login/.openspec.yaml', 'schema: spec-relay-extract\n');
  write(dir, 'openspec/changes/extract-auth-login/review.md', 'Reviewer:\n\n## 1. Requirements\n- [x] R1 Password\n- [ ] R2 Lockout\n');
  write(dir, 'openspec/changes/extract-auth-login/specs/auth/login/spec.md', '## ADDED Requirements\n\n### Requirement: Password\nx\n\n### Requirement: Lockout\ny\n');
  write(dir, 'openspec/changes/extract-auth-login/screens.md', '# Screens\n\n### Screen: Login\n- **Screenshot**: openspec/spec-relay/screens/login.png\n');
  write(dir, 'openspec/spec-relay/screens/login.png', 'PNG');
  write(dir, 'secret.txt', 'SECRET');
  return dir;
}

const fetchText = async (url, options) => { const res = await fetch(url, options); return { status: res.status, type: res.headers.get('content-type'), text: await res.text() }; };

test('the progress page shows where the work is and links every review and spec page', () => {
  const dir = repo();
  const html = progressPage({ root: dir, lang: 'ja' });
  assert.match(html, /<h1>移行の進み具合<\/h1>/);
  assert.match(html, /<td class="mono">extract-auth-login<\/td><td>extract<\/td><td>1 \/ 2<\/td><td><a href="extract-auth-login\.html">開く<\/a>/);
  assert.match(html, /<td class="mono">billing\/invoice<\/td>[\s\S]*?<a href="spec-billing-invoice\.html">開く<\/a>/);
  assert.deepEqual(changesForReview(dir), [{ name: 'extract-auth-login', schema: 'spec-relay-extract', total: 2, open: 1 }]);
  assert.match(progressPage({ root: tempDir(), lang: 'en' }), /has no openspec\//);
});

test('a canvas page talks only to its own server and offers to ask about each item', () => {
  const html = interactive('<html><head><meta http-equiv="Content-Security-Policy" content="default-src \'none\'"><style>x</style></head><body><p class="meta">m</p><main></main></body>\n</html>\n', { lang: 'en', pagePath: 'openspec/spec-relay/views/specs.html', title: '</script><script>alert(1)</script>', version: 3, seq: 1 });
  assert.match(html, /connect-src 'self'/);
  assert.doesNotMatch(html, /default-src 'none'"/);
  assert.match(html, /<a href="specs\.html" aria-current="page">Specs<\/a>/);
  assert.match(html, /id="ask-box"/);
  assert.doesNotMatch(html, /<\/script><script>alert/, 'the page title cannot end the config script');
});

test('the question carries where it was asked and says it is not an approval', () => {
  const m = askPrompt({ question: '  why 355? ', title: 'billing/invoice', item: { label: 'R1', title: 'Total' }, page: 'p.html' }, 'en');
  assert.match(m.prompt, /^\[canvas\] why 355\?\n\n\(About: billing\/invoice — R1 Total; page p\.html\..*not an approval/s);
  assert.equal(m.displayPrompt, '[canvas] why 355?\n(billing/invoice — R1 Total)');
  assert.equal(askPrompt({ question: 'x'.repeat(9000) }, 'en').prompt.length < 4500, true);
});

test('pages to open are checked against the repository', () => {
  const dir = repo();
  assert.deepEqual(pageName(dir, {}), { ok: true, name: 'progress' });
  assert.deepEqual(pageName(dir, { view: 'spec' }), { ok: true, name: 'specs' });
  assert.deepEqual(pageName(dir, { view: 'spec', name: 'billing/invoice' }), { ok: true, name: 'spec-billing-invoice' });
  assert.equal(pageName(dir, { view: 'spec', name: '../x' }).ok, false);
  assert.deepEqual(pageName(dir, { view: 'review', name: 'extract-auth-login' }), { ok: true, name: 'extract-auth-login' });
  assert.equal(pageName(dir, { view: 'review', name: '../secret' }).ok, false);
  assert.equal(pageName(dir, { view: 'review', name: 'port-none' }).ok, false);
});

test('the server serves the pages and images under its token, and nothing else', async () => {
  const dir = repo();
  const asked = [];
  const server = await startServer({ root: dir, ask: async (m) => { asked.push(m); } });
  try {
    const base = `http://127.0.0.1:${server.port}/${server.token}`;
    const review = await fetchText(server.url('extract-auth-login'));
    assert.equal(review.status, 200);
    assert.match(review.text, /class="item k-req is-open" id="R2"/);
    assert.match(review.text, /<img src="\.\.\/screens\/login\.png"/);
    assert.match(review.text, /connect-src 'self'/);
    assert.equal((await fetchText(`${base}/r/openspec/spec-relay/screens/login.png`)).text, 'PNG');
    assert.match((await fetchText(server.url('spec-billing-invoice'))).text, /<h1>billing\/invoice<\/h1>/);
    assert.match((await fetchText(server.url('specs'))).text, /href="spec-billing-invoice\.html"/);
    assert.match((await fetchText(server.url('progress'))).text, /extract-auth-login/);
    assert.equal(fs.existsSync(path.join(dir, 'openspec/spec-relay/views')), false, 'nothing is written');

    for (const bad of [`http://127.0.0.1:${server.port}/wrong/state`, `${base}/r/secret.txt`, `${base}/r/..%2Fsecret.png`, `${base}/r/openspec/spec-relay/views/none.html`, `${base}/r/openspec/spec-relay/views/..%2F..%2F..%2Fsecret.html`]) {
      const res = await fetchText(bad);
      assert.ok(res.status >= 400, bad);
      assert.doesNotMatch(res.text, /SECRET/);
    }
    const rebound = await new Promise((resolve, reject) => {
      http.get({ host: '127.0.0.1', port: server.port, path: `/${server.token}/state`, headers: { Host: `evil.example:${server.port}` } }, (res) => { res.resume(); resolve(res.statusCode); }).on('error', reject);
    });
    assert.equal(rebound, 403, 'another host name (DNS rebinding) is refused');

    const ask = (headers, body = { question: 'why?', page: 'x', title: 't' }) => fetch(`${base}/ask`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) });
    assert.equal((await ask({})).status, 403, 'a plain form post cannot ask');
    assert.equal((await ask({ 'X-Spec-Relay': 'ask', Origin: 'http://evil.example' })).status, 403);
    assert.equal((await ask({ 'X-Spec-Relay': 'ask' }, { question: ' ' })).status, 400);
    assert.equal((await ask({ 'X-Spec-Relay': 'ask', Origin: `http://127.0.0.1:${server.port}` })).status, 200);
    assert.equal(asked.length, 1);
    assert.match(asked[0].prompt, /^\[canvas\] why\?/);
  } finally { await server.close(); }
});

test('the state moves when the files change and when the agent sends the canvas elsewhere', async () => {
  const dir = repo();
  const server = await startServer({ root: dir });
  try {
    const state = async () => (await fetch(`http://127.0.0.1:${server.port}/${server.token}/state`)).json();
    const first = await state();
    const sig = signature(dir);
    write(dir, 'openspec/changes/extract-auth-login/review.md', 'Reviewer: Uma\n');
    assert.notEqual(signature(dir), sig);
    await new Promise((r) => setTimeout(r, 1100));
    assert.equal((await state()).version, first.version + 1);
    server.go('specs');
    assert.deepEqual((await state()).goto, { seq: 1, path: 'openspec/spec-relay/views/specs.html' });
  } finally { await server.close(); }
});

test('the extension wires the canvas to the session', async () => {
  const dir = repo();
  const stub = path.join(tempDir(), 'sdk.mjs');
  fs.writeFileSync(stub, `export class CanvasError extends Error { constructor(code, message) { super(message); this.code = code; } }
export const createCanvas = (o) => o;
export async function joinSession(config) { globalThis.__canvas = { config, sent: [] }; return { send: async (m) => globalThis.__canvas.sent.push(m), on() {} }; }\n`);
  const hooks = `export async function resolve(spec, ctx, next) { return spec === '@github/copilot-sdk/extension' ? { url: ${JSON.stringify(pathToFileURL(stub).href)}, shortCircuit: true } : next(spec, ctx); }`;
  register(`data:text/javascript,${encodeURIComponent(hooks)}`);
  await import(pathToFileURL(path.resolve('com.github.copilot/extensions/spec-relay-canvas/extension.mjs')).href);
  const canvas = globalThis.__canvas.config.canvases[0];
  assert.equal(canvas.id, 'spec-relay');
  const action = (name) => canvas.actions.find((a) => a.name === name).handler;
  const session = { workingDirectory: dir };
  await assert.rejects(async () => action('open_spec')({ input: {}, session }), /Open the spec-relay canvas first/);
  const opened = await canvas.open({ instanceId: 'i1', input: { view: 'review', name: 'extract-auth-login' }, session });
  assert.match(opened.url, /^http:\/\/127\.0\.0\.1:\d+\/[\w-]+\/r\/openspec\/spec-relay\/views\/extract-auth-login\.html$/);
  assert.deepEqual(await action('open_spec')({ input: { name: 'billing/invoice' }, session }), { ok: true, shown: 'spec-billing-invoice' });
  const status = await action('get_status')({ session });
  assert.equal(status.reviews[0].name, 'extract-auth-login');
  const base = opened.url.replace(/\/r\/.*$/, '');
  await fetch(`${base}/ask`, { method: 'POST', headers: { 'X-Spec-Relay': 'ask' }, body: JSON.stringify({ question: 'q' }) });
  assert.equal(globalThis.__canvas.sent[0].mode, 'enqueue');
  assert.match(globalThis.__canvas.sent[0].prompt, /^\[canvas\] q/);
  await canvas.onClose({ instanceId: 'i1' });
  await assert.rejects(fetch(opened.url), 'the server stops with the last canvas');
});
