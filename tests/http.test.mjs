import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { htmlView, encoderFor, baseUrl, parseHttpOptions, buildRequest, viewResponse, readMap, exchange, record, runHttpDriver, isHttpDriver, startSystem, withoutSecrets } from '../scripts/http.mjs';
import { casesDigest, compare, report, runCompareCommand, parseOptions, portOptionProblem } from '../scripts/compare.mjs';
import { tempDir, write } from './helpers.mjs';

const KIT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// A port nothing listens on.
function freePort() {
  return new Promise((resolve) => {
    const probe = http.createServer();
    probe.listen(0, '127.0.0.1', () => { const { port } = probe.address(); probe.close(() => resolve(port)); });
  });
}

// The old system of the tests: a page that needs a sign-in, reads its form in
// Shift_JIS and answers in Shift_JIS, as a legacy Japanese PHP page does.
// `flavor` "new" is the same system rewritten: UTF-8, other markup, other paths.
const SYSTEM = String.raw`
const http = require('node:http');
const [port, flavor = 'old'] = process.argv.slice(2);
const sjis = new TextDecoder('shift_jis');
const orders = [{ id: 1, name: '山田' }];
const page = (title, body) => flavor === 'old'
  ? '<html><head><meta http-equiv="Content-Type" content="text/html; charset=Shift_JIS"><title>' + title + '</title><style>td{color:red}</style></head><body><table><tr><td><h1>' + title + '</h1></td></tr></table>' + body + '</body></html>'
  : '<!doctype html><html><head><meta charset="utf-8"><title>' + title + '</title></head><body><main><h1>' + title + '</h1>' + body + '</main><script>var x = "<p>ignored</p>";</script></body></html>';
const encode = (text) => {
  if (flavor !== 'old') return Buffer.from(text, 'utf8');
  // Only what the fixture needs: ASCII and a few kanji.
  const table = { '注': [0x92, 0x8d], '文': [0x95, 0xb6], '一': [0x88, 0xea], '覧': [0x97, 0x97], '山': [0x8e, 0x52], '田': [0x93, 0x63], '鈴': [0x97, 0xe9], '木': [0x96, 0xd8], '登': [0x93, 0x6f], '録': [0x98, 0x5e], '件': [0x8c, 0x8f] };
  return Buffer.from([...text].flatMap((ch) => table[ch] ?? [ch.charCodeAt(0)]));
};
const paths = flavor === 'old' ? { login: '/login.php', list: '/order_list.php', csv: '/export.php' } : { login: '/login', list: '/orders', csv: '/orders.csv' };
http.createServer((req, res) => {
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => {
    const url = new URL(req.url, 'http://x');
    const raw = Buffer.concat(chunks).toString('latin1');
    const form = Object.fromEntries(raw.split('&').filter(Boolean).map((pair) => {
      const [k, v = ''] = pair.split('=');
      const bytes = (s) => Buffer.from(s.replace(/\+/g, ' ').replace(/%([0-9A-F]{2})/gi, (_, h) => String.fromCharCode(parseInt(h, 16))), 'latin1');
      return [bytes(k).toString('latin1'), flavor === 'old' ? sjis.decode(bytes(v)) : bytes(v).toString('utf8')];
    }));
    const signedIn = /sid=ok/.test(req.headers.cookie ?? '');
    const html = (status, text, headers = {}) => { res.writeHead(status, { 'Content-Type': flavor === 'old' ? 'text/html' : 'text/html; charset=utf-8', ...headers }); res.end(encode(text)); };
    if (url.pathname === paths.login) {
      if (req.method === 'POST' && form.user === 'clerk' && form.pass === 'secret') return html(302, '', { Location: paths.list, 'Set-Cookie': 'sid=ok; Path=/; HttpOnly' });
      return html(200, page('Sign in', '<form method="post"><input name="user"><input type="password" name="pass"><input type="submit" value="Sign in"></form>'));
    }
    if (url.pathname === '/api/orders') { res.writeHead(200, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify({ count: orders.length, at: Date.now() })); }
    if (!signedIn) return html(302, '', { Location: paths.login });
    if (url.pathname === paths.csv) { res.writeHead(200, { 'Content-Type': 'text/csv', 'Content-Disposition': 'attachment; filename="orders.csv"' }); return res.end(encode(orders.map((o) => o.id + ',' + o.name).join('\r\n') + '\r\n')); }
    if (url.pathname === paths.list) {
      const token = flavor === 'old' ? 'old-' + orders.length : 'new-' + orders.length;
      const nameField = flavor === 'old' ? 'ctl00$name' : 'name';
      if (req.method === 'POST') {
        if (form.token !== token) return html(400, page('Error', '<p>bad token</p>'));
        orders.push({ id: orders.length + 1, name: form[nameField] });
      }
      const rows = orders.map((o) => flavor === 'old'
        ? '<tr><td>' + o.id + '</td><td><font color="red">' + o.name + '</font></td></tr>'
        : '<li><span>' + o.id + '</span></li><li><strong>' + o.name + '</strong></li>').join('');
      const list = flavor === 'old' ? '<table>' + rows + '</table>' : '<ul>' + rows + '</ul>';
      const tail = flavor === 'broken' ? '<p>' + (orders.length + 1) + '件</p>' : '<p>' + orders.length + '件</p>';
      return html(200, page('注文一覧', list + tail + '<form method="post"><input type="hidden" name="token" value="' + token + '"><input name="' + nameField + '" value=""><input type="submit" value="登録"></form>'));
    }
    html(404, page('Not found', ''));
  });
}).listen(Number(port), '127.0.0.1');
`;

const INPUTS = [
  { id: 'list-signed-out', input: { path: '/order_list.php' } },
  { id: 'sign-in', input: { path: '/login.php', form: { user: 'clerk', pass: '{{env:SR_TEST_PASS}}' } } },
  { id: 'list', input: { path: '/order_list.php' } },
  { id: 'add', input: { path: '/order_list.php', hidden: true, form: { ctl00$name: '鈴木' } } },
  { id: 'csv', input: { path: '/export.php' } },
  { id: 'api', input: { path: '/api/orders' } },
].map((c) => JSON.stringify(c)).join('\n');

// Starts the fixture system in this process's own child and waits for it.
async function started(dir, port, flavor = 'old') {
  write(dir, 'system.cjs', SYSTEM);
  const { spawn } = await import('node:child_process');
  const child = spawn(process.execPath, [path.join(dir, 'system.cjs'), String(port), flavor], { stdio: 'ignore' });
  for (let k = 0; k < 100; k += 1) {
    try { await fetch(`http://127.0.0.1:${port}/api/orders`); break; } catch { await new Promise((r) => { setTimeout(r, 50); }); }
  }
  return () => new Promise((resolve) => { child.once('exit', resolve); child.kill(); });
}

test('a page is read as a user reads it: blocks of text, the fields, never markup or scripts', () => {
  const view = htmlView('<html><head><title>注文 &amp; 一覧</title><style>x{}</style></head><body><!-- <p>no</p> --><h1>注文一覧</h1><p>合計 <b>1,080</b>&nbsp;円<br>次</p><table><tr><th>ID</th><th>名前</th></tr><tr><td>1</td><td>山田 <a href=x>編集</a></td></tr></table>'
    + '<form><input type=hidden name=__VIEWSTATE value=abc><input name=q value="a&amp;b"><input type=checkbox name=c value=1 checked><input type=checkbox name=d><input type=radio name=r value=x><input type=radio name=r value=y CHECKED><input type=password name=p value=secret>'
    + '<select name=s><option value=1>一<option value=2 selected>二</select><select name=t><option>A</option><option>B</option></select><select name=m multiple><option selected>a<option>b<option selected>c</select><textarea name=memo>\nline1\r\nline2</textarea>'
    + '<input type=submit value="検索 &amp; 表示"><button>戻る</button><img alt="logo"></form><script>var a="<p>no</p>"</script></body></html>');
  assert.deepEqual(view, {
    title: '注文 & 一覧',
    text: ['注文一覧', '合計 1,080 円', '次', 'ID', '名前', '1', '山田 編集', '一', '二', 'A', 'B', 'a', 'b', 'c', '検索 & 表示', '戻る', 'logo'],
    fields: { q: 'a&b', c: '1', r: 'y', s: '2', t: 'A', m: ['a', 'c'], memo: 'line1\nline2' },
    hidden: { __VIEWSTATE: 'abc' },
    forms: [{ hidden: { __VIEWSTATE: 'abc' }, names: ['q', 'c', 'd', 'r', 'p', 's', 't', 'm', 'memo'] }],
  });
  // The same words in other markup read the same.
  assert.deepEqual(htmlView('<table><tr><td><font color=red>山田</font></td><td>1,080 円</td></tr></table>').text, htmlView('<ul><li><strong>山田</strong></li><li>1,080&#x20;円</li></ul>').text);
  assert.deepEqual(htmlView('plain &lt;b&gt; &#12354; &unknown;').text, ['plain <b> あ &unknown;']);
  assert.deepEqual(htmlView('<?xml version="1.0"?><!DOCTYPE html><p>a<![CDATA[b]]></p>').text, ['ab']);
  // Entities old pages use; &#150; is a dash in every browser.
  assert.deepEqual(htmlView('<p>a &rarr; b &bull; &ldquo;c&rdquo; 1&#150;2 &constructor;</p>').text, ['a → b • “c” 1–2 &constructor;']);
});

test('text the page hides is not text a user reads, and names from the page are only names', () => {
  // A WebForms validator that did not fire, a panel that is closed, the fallback for no script.
  const view = htmlView('<p>名前<span id="v1" style="color:Red;visibility:hidden;">必須です</span></p><div hidden><p>閉じたパネル<div>中</div></p></div><p>住所<span style="color:red">必須です</span></p>'
    + '<noscript>JavaScript を有効にしてください</noscript><div style="display: none"><input type=hidden name=__EVENTTARGET value=""><input name=shadow value=1></div><br hidden><p>末尾</p>');
  assert.deepEqual(view.text, ['名前', '住所必須です', '末尾']);
  assert.deepEqual(view.hidden, { __EVENTTARGET: '' });
  assert.deepEqual(view.fields, {});
  // A field called like a property of every object is a field like any other.
  const odd = htmlView('<form><input name=constructor value=a><input name=toString value=b><input name=__proto__ value=c><input type=hidden name=valueOf value=d></form>');
  assert.deepEqual(Object.entries(odd.fields), [['constructor', 'a'], ['toString', 'b'], ['__proto__', 'c']]);
  assert.deepEqual(Object.entries(odd.hidden), [['valueOf', 'd']]);
  // Markup that never closes a tag is read in a time that grows with its length, not its square.
  const started = Date.now();
  htmlView('<a '.repeat(60000));
  assert.ok(Date.now() - started < 3000, `took ${Date.now() - started} ms`);
});

test('form values are written in the old system\'s encoding', () => {
  assert.equal(encoderFor('shift_jis')('山田ｱ\\~').toString('hex'), '8e529363b15c7e');
  assert.equal(encoderFor('Windows-31J')('鈴木').toString('hex'), '97e996d8');
  assert.equal(encoderFor('euc-jp')('山田ｱ').toString('hex'), 'bbb3c5c48eb1');
  assert.equal(encoderFor('windows-1252')('é€').toString('hex'), 'e980');
  assert.equal(encoderFor('utf-8')('山').toString('hex'), 'e5b1b1');
  assert.equal(encoderFor('big5'), null);
  assert.equal(encoderFor('no-such-encoding'), null);
  assert.throws(() => encoderFor('shift_jis')('한'), /cannot be written in shift_jis/);
  // As a browser sends them: the yen sign and the overline as single bytes, the minus sign as the fullwidth one, the IBM rows for 髙 and 﨑.
  assert.equal(encoderFor('shift_jis')('¥‾−髙﨑').toString('hex'), '5c7e817cfbfcfab1');
  assert.equal(encoderFor('euc-jp')('¥−').toString('hex'), '5ca1dd');
  // The names PHP and Java give the same encodings.
  assert.equal(encoderFor('CP932')('山').toString('hex'), '8e52');
  assert.equal(encoderFor('eucJP-win')('山').toString('hex'), 'bbb3');
});

test('the base URL is this machine unless the person named the host', () => {
  assert.equal(baseUrl('http://localhost:8080').url.origin, 'http://localhost:8080');
  assert.equal(baseUrl('http://127.0.0.1:8080/app/').url.pathname, '/app/');
  assert.equal(baseUrl('http://[::1]:8080').url.port, '8080');
  assert.match(baseUrl('http://old.example.test').problem, /is not this machine.*--allow-host old\.example\.test/);
  assert.equal(baseUrl('http://old.example.test', ['old.example.test']).url.hostname, 'old.example.test');
  assert.match(baseUrl('ftp://localhost').problem, /not an http or https URL/);
  assert.match(baseUrl('http://user:pw@localhost').problem, /user name or password/);
  assert.match(baseUrl('http://localhost/?a=1').problem, /query/);
  assert.match(baseUrl('nonsense').problem, /is not a URL/);
  assert.match(parseHttpOptions(['--base', 'http://localhost:1', '--inputs', 'a.jsonl'], 'record').problem, /--inputs <file> and --out <file>/);
  assert.match(parseHttpOptions(['--base', 'http://localhost:1', '--inputs', 'a.jsonl', '--out', 'a.json'], 'record').problem, /must end in \.jsonl/);
  assert.match(parseHttpOptions(['--base', 'http://localhost:1', '--start', 'a; b'], 'driver').problem, /--start command "a; b" chains commands/);
  assert.match(parseHttpOptions(['--base', 'http://localhost:1', '--charset', 'big5'], 'driver').problem, /--charset big5/);
  assert.match(parseHttpOptions(['--base', 'http://localhost:1', '--inputs', 'x'], 'driver').problem, /unknown or incomplete option --inputs/);
  assert.match(parseHttpOptions(['--inputs', 'x'], 'record').problem, /no --base/);
  assert.equal(parseHttpOptions(['--base', 'http://old.test', '--allow-host', 'OLD.test', '--inputs', 'a.jsonl', '--out', 'b.jsonl'], 'record').url.hostname, 'old.test');
});

test('a request: placeholders from the environment, the form in its encoding, hidden fields, the map', () => {
  const base = new URL('http://localhost:8080/app/');
  const session = { cookies: new Map([['sid', 'ok']]), hidden: { __VIEWSTATE: 'abc', token: 't1' } };
  const build = (input, extra = {}) => buildRequest(input, { base, session, env: { PASS: 'p&w', EMPTY: '' }, ...extra });
  let r = build({ path: '/login.php?x=1', query: { q: '山田' }, form: { user: 'clerk', pass: '{{env:PASS}}', tags: ['a', 'b'] } }, { encode: encoderFor('shift_jis') });
  assert.equal(r.url.href, 'http://localhost:8080/app/login.php?x=1&q=%8ER%93c');
  assert.equal(r.method, 'POST');
  assert.equal(r.body.toString('latin1'), 'user=clerk&pass=p%26w&tags=a&tags=b');
  assert.equal(r.headers.cookie, 'sid=ok');
  assert.equal(r.headers['content-type'], 'application/x-www-form-urlencoded');
  // Hidden fields of the last page go first; a given value of the same name wins.
  r = build({ path: '/save.aspx', hidden: true, form: { token: 'mine', name: 'x y' } });
  assert.equal(r.body.toString('latin1'), '__VIEWSTATE=abc&token=mine&name=x+y');
  r = build({ path: '/a', json: { key: '{{env:PASS}}' }, headers: { 'X-Token': '{{env:PASS}}' } });
  assert.deepEqual([r.body.toString(), r.headers['content-type'], r.headers['x-token']], ['{"key":"p&w"}', 'application/json', 'p&w']);
  r = build({ path: '/a', method: 'put', body: '<x/>', contentType: 'application/xml' });
  assert.deepEqual([r.method, r.body.toString(), r.headers['content-type']], ['PUT', '<x/>', 'application/xml']);
  assert.equal(build({ path: '/a' }).method, 'GET');
  // The map: where the new system differs on purpose.
  const map = readMap('{"paths": {"/order_list.php": "/orders"}, "fields": {"ctl00$name": "name"}}');
  r = build({ path: '/order_list.php?page=2', query: { ctl00$name: 'a' }, form: { ctl00$name: 'b', other: 'c' } }, { map });
  assert.equal(r.url.href, 'http://localhost:8080/app/orders?page=2&name=a');
  assert.equal(r.body.toString('latin1'), 'name=b&other=c');

  assert.match(build({ path: '/a', form: { p: '{{env:NOPE}}' } }).problem, /environment variable NOPE is not set/);
  assert.match(build({ path: 'http://evil.test/a' }).problem, /"path" that starts with one \//);
  assert.match(build({ path: '//evil.test/a' }).problem, /"path" that starts with one \//);
  assert.match(build({ path: '/a', form: {}, json: {} }).problem, /form and json; give one body/);
  assert.match(build({ path: '/a', method: 'GET', form: { a: '1' } }).problem, /GET request cannot carry a body/);
  assert.match(build({ path: '/a', url: 'x' }).problem, /unknown key "url"/);
  assert.match(build({ path: '/a', hidden: true, json: {} }).problem, /"hidden" goes with "form"/);
  assert.match(build({ path: '/a', hidden: true, body: 'x' }).problem, /"hidden" goes with "form"/);
  assert.match(build({ path: '/a', hidden: 0 }).problem, /"hidden" must be true, false or the number of a form/);
  assert.match(build({ path: '/a', form: { n: '한' } }, { encode: encoderFor('shift_jis') }).problem, /cannot be written in shift_jis/);
  // A character from a variable's value is not shown.
  assert.equal(build({ path: '/a', form: { n: '{{env:PASS}}한' } }, { encode: encoderFor('shift_jis') }).problem, 'a value holds a character the --charset cannot write');
  // The values put in are reported, so that an answer that repeats them can be cleaned.
  assert.deepEqual([...build({ path: '/a', form: { p: '{{env:PASS}}' } }).used], [['PASS', 'p&w']]);
  // PowerShell's own syntax would be filled in by the shell that writes the file; a mistyped name would be sent as it is.
  for (const typo of ['${env:PASS}', '$env:PASS', '{{ env:PASS }}', '{{env:OLD-PASS}}', '{{ENV:PASS}}']) assert.match(build({ path: '/a', form: { p: typo } }).problem, /something like a placeholder that is none; write \{\{env:NAME\}\}/, typo);
  assert.match(build({ path: '/a', form: { p: '{{env:EMPTY}}' } }).problem, /environment variable EMPTY is not set/);
  // What fetch would refuse is refused before anything is sent.
  assert.match(build({ path: '/a', headers: { 'X-Name': '山田' } }).problem, /the header X-Name holds characters a header cannot carry/);
  assert.match(build({ path: '/a', headers: { 'X Name': 'a' } }).problem, /the header X Name holds characters/);
  // A field called like a property of every object is a name like any other.
  assert.equal(build({ path: '/a', form: { constructor: 'a', __proto__x: 'b' } }).body.toString(), 'constructor=a&__proto__x=b');

  // Hidden fields are those of one form: the one that holds a field of the request, or the numbered one.
  const page = (html) => { const s = { cookies: new Map() }; viewResponse({ status: 200, headers: new Headers({ 'content-type': 'text/html' }), bytes: Buffer.from(html), requestUrl: new URL('http://localhost:8080/app/x') }, { base, session: s }); return s; };
  const two = page('<form><input type=hidden name=mode value=search><input name=q></form><form><input type=hidden name=mode value=delete><input type=hidden name=id value=7><button name=del>削除</button></form>');
  const hidden = (input, s) => { const b = buildRequest(input, { base, session: s }); return b.problem ?? b.body.toString(); };
  assert.equal(hidden({ path: '/s', hidden: true, form: { q: 'x' } }, two), 'mode=search&q=x');
  assert.equal(hidden({ path: '/s', hidden: true, form: { del: '' } }, two), 'mode=delete&id=7&del=');
  assert.equal(hidden({ path: '/s', hidden: 2, form: { other: '1' } }, two), 'mode=delete&id=7&other=1');
  assert.match(hidden({ path: '/s', hidden: true, form: { other: '1' } }, two), /2 forms with hidden fields and none holds a field of this request; write "hidden": <the number/);
  assert.match(hidden({ path: '/s', hidden: 3 }, two), /"hidden": 3 asks for form 3, but the last page of this session has 2 forms/);
  // A delete button per row: the same field in every form, another id in each.
  const rows = page('<form><input type=hidden name=id value=1><button name=del>x</button></form><form><input type=hidden name=id value=2><button name=del>x</button></form>');
  assert.match(hidden({ path: '/s', hidden: true, form: { del: '' } }, rows), /2 forms of the last page hold a field of this request, with different hidden fields/);
  assert.equal(hidden({ path: '/s', hidden: 2, form: { del: '' } }, rows), 'id=2&del=');
  // One form (WebForms), or fields outside any form: nothing to choose.
  assert.equal(hidden({ path: '/s', hidden: true, form: { a: '1' } }, page('<form><input type=hidden name=__VIEWSTATE value=v></form>')), '__VIEWSTATE=v&a=1');
  assert.equal(hidden({ path: '/s', hidden: true }, page('<input type=hidden name=t value=1>')), 't=1');
  // Before anything is sent there is no last page: the check then leaves the choice alone.
  assert.equal(buildRequest({ path: '/s', hidden: 3, form: { a: '1' } }, { base, session: { cookies: new Map(), forms: [] }, dry: true }).body.toString(), 'a=1');
  assert.match(build('GET /a').problem, /not a request object/);

  assert.match(readMap('[]').problem, /one JSON object/);
  assert.match(readMap('{"routes": {}}').problem, /unknown key "routes"/);
  assert.match(readMap('{"paths": {"a.php": "/a"}}').problem, /must be two paths that start with \//);
  assert.match(readMap('{"paths": {"/a.php": "/x", "/b.php": "/x"}}').problem, /\/a\.php and \/b\.php the same new path \/x/);
  assert.match(readMap('{"fields": {"a": 1}}').problem, /object of old name to new name/);
  assert.match(readMap('{').problem, /not JSON/);
});

test('a response: status, redirect, and the body by its type', () => {
  const base = new URL('http://localhost:8080/app/');
  const view = (status, headers, body, extra = {}) => viewResponse({ status, headers: new Headers(headers), bytes: Buffer.isBuffer(body) ? body : Buffer.from(body), requestUrl: new URL('http://localhost:8080/app/list.php') }, { base, ...extra });
  assert.deepEqual(view(302, { location: 'login.php?next=%2Flist' }, ''), { status: 302, redirect: '/login.php?next=%2Flist' });
  assert.deepEqual(view(302, { location: 'http://localhost:8080/app/orders' }, '', { map: readMap('{"paths": {"/order_list.php": "/orders"}}') }), { status: 302, redirect: '/order_list.php' });
  assert.deepEqual(view(302, { location: 'https://sso.example.test/login' }, ''), { status: 302, redirect: 'https://sso.example.test/login' });
  // What a user cannot see is no difference: the type of an empty body (PHP names one on every redirect), an empty title.
  assert.deepEqual(view(302, { location: '/app/login.php', 'content-type': 'text/html; charset=UTF-8' }, ''), { status: 302, redirect: '/login.php' });
  assert.deepEqual(view(200, { 'content-type': 'text/html' }, '<title> </title><p>a</p>'), { status: 200, type: 'text/html', text: ['a'], fields: {} });
  const session = { cookies: new Map(), hidden: {} };
  // Shift_JIS named only in the page, as old pages do.
  const sjis = Buffer.concat([Buffer.from('<meta http-equiv="Content-Type" content="text/html; charset=Shift_JIS"><title>'), Buffer.from([0x92, 0x8d, 0x95, 0xb6]), Buffer.from('</title><input type=hidden name=t value=1><input name="name" value="x">')]);
  // The new system's field name is translated back to the recorded one.
  assert.deepEqual(view(200, { 'content-type': 'text/html' }, sjis, { session, map: readMap('{"fields": {"ctl00$name": "name"}}') }), { status: 200, type: 'text/html', title: '注文', text: [], fields: { ctl00$name: 'x' } });
  assert.deepEqual(session.hidden, { t: '1' });
  assert.deepEqual(view(200, { 'content-type': 'application/json; charset=utf-8' }, '{"a":[1,"山"]}'), { status: 200, type: 'application/json', json: { a: [1, '山'] } });
  assert.deepEqual(view(200, { 'content-type': 'application/json' }, 'oops'), { status: 200, type: 'application/json', body: 'oops' });
  // A CSV without a charset is read in the system's encoding (--charset).
  assert.deepEqual(view(200, { 'content-type': 'text/csv', 'content-disposition': 'attachment; filename="orders.csv"' }, Buffer.from([0x31, 0x2c, 0x8e, 0x52, 0x0d, 0x0a]), { charset: 'shift_jis' }), { status: 200, type: 'text/csv', filename: 'orders.csv', body: '1,山\n' });
  const pdf = view(200, { 'content-type': 'application/pdf' }, '%PDF-1.4');
  assert.deepEqual([pdf.bytes.length, pdf.bytes.sha256.length], [8, 64]);
  assert.deepEqual(view(204, {}, ''), { status: 204 });
});

test('record: the old system answers the requests, and the cases keep the placeholder, never the password', async () => {
  const dir = tempDir();
  const port = await freePort();
  const stop = await started(dir, port);
  try {
    write(dir, 'tests/golden/inputs/orders.jsonl', `${INPUTS}\n`);
    const opts = parseHttpOptions(['--base', `http://127.0.0.1:${port}`, '--inputs', 'tests/golden/inputs/orders.jsonl', '--out', 'tests/golden/shop-orders/recorded.jsonl', '--charset', 'shift_jis'], 'record');
    // Without the variable no request is sent at all (the ones after the sign-in would act signed out), and nothing is written.
    let r = await record(opts, { cwd: dir, env: {} });
    assert.equal(r.ok, false);
    assert.equal(r.count, 0);
    assert.deepEqual(r.problems, ['case sign-in: the environment variable SR_TEST_PASS is not set (the person sets it; never write its value into a file)', 'no request was sent']);
    assert.equal(fs.existsSync(path.join(dir, 'tests/golden/shop-orders/recorded.jsonl')), false);

    r = await record(opts, { cwd: dir, env: { SR_TEST_PASS: 'secret' } });
    assert.deepEqual([r.ok, r.problems], [true, []]);
    assert.match(r.summary, /recorded 6 cases from http:\/\/127\.0\.0\.1:\d+ to tests\/golden\/shop-orders\/recorded\.jsonl \(200 x4, 302 x2; 2 requests other than GET\)/);
    const text = fs.readFileSync(path.join(dir, 'tests/golden/shop-orders/recorded.jsonl'), 'utf8');
    assert.doesNotMatch(text, /secret/);
    const cases = Object.fromEntries(text.trim().split('\n').map((line) => { const c = JSON.parse(line); return [c.id, c]; }));
    assert.deepEqual(cases['list-signed-out'].expected, { status: 302, redirect: '/login.php' });
    assert.equal(cases['sign-in'].input.form.pass, '{{env:SR_TEST_PASS}}');
    assert.deepEqual(cases['sign-in'].expected, { status: 302, redirect: '/order_list.php' });
    assert.deepEqual(cases.list.expected, { status: 200, type: 'text/html', title: '注文一覧', text: ['注文一覧', '1', '山田', '1件', '登録'], fields: { ctl00$name: '' } });
    // The hidden token went back with the form, and the Shift_JIS name arrived whole.
    assert.deepEqual(cases.add.expected.text, ['注文一覧', '1', '山田', '2', '鈴木', '2件', '登録']);
    assert.deepEqual(cases.csv.expected, { status: 200, type: 'text/csv', filename: 'orders.csv', body: '1,山田\n2,鈴木\n' });
    assert.equal(cases.api.expected.json.count, 2);
  } finally { await stop(); }

  // Nothing answers: the run says so and writes nothing.
  write(dir, 'in.jsonl', '{"id":"a","input":{"path":"/"}}\n{"id":"b","input":{"path":"/"}}\n');
  const dead = await record(parseHttpOptions(['--base', `http://127.0.0.1:${port}`, '--inputs', 'in.jsonl', '--out', 'out/x.jsonl'], 'record'), { cwd: dir });
  assert.equal(dead.ok, false);
  assert.match(dead.problems.join(), /case a: GET \/ got no answer from http:\/\/127\.0\.0\.1:\d+ \(.+\); the requests after it were not sent/);
  assert.equal(dead.problems.length, 1);
  assert.equal(fs.existsSync(path.join(dir, 'out/x.jsonl')), false);
  write(dir, 'bad.jsonl', '{"id":"a","input":{"path":"/"}}\nnot json\n{"id":"a","input":{}}\n{"input":{}}\n');
  assert.deepEqual((await record(parseHttpOptions(['--base', `http://127.0.0.1:${port}`, '--inputs', 'bad.jsonl', '--out', 'out/x.jsonl'], 'record'), { cwd: dir })).problems.map((p) => p.replace(/\(.*\)/, '()')), ['bad.jsonl:2 is not JSON ()', 'bad.jsonl:3: case a is there twice', 'bad.jsonl:4 has no "id" ()']);
  assert.match((await record(parseHttpOptions(['--base', `http://127.0.0.1:${port}`, '--inputs', 'none.jsonl', '--out', 'out/x.jsonl'], 'record'), { cwd: dir })).problems.join(), /inputs file none\.jsonl does not exist/);
});

test('compare: the new system, started by the run, answers the recorded requests', async () => {
  const dir = tempDir();
  const oldPort = await freePort();
  const stop = await started(dir, oldPort);
  process.env.SR_TEST_PASS = 'secret';
  try {
    write(dir, 'inputs.jsonl', `${INPUTS}\n`);
    const recorded = await record(parseHttpOptions(['--base', `http://127.0.0.1:${oldPort}`, '--inputs', 'inputs.jsonl', '--out', 'tests/golden/shop-orders/recorded.jsonl', '--charset', 'shift_jis'], 'record'), { cwd: dir });
    assert.equal(recorded.ok, true, recorded.problems.join('\n'));
  } finally { await stop(); }
  write(dir, 'tests/golden/shop-orders/rules.json', '{"ignore": ["$.json.at"]}');
  write(dir, 'tests/golden/http-map.json', '{"paths": {"/login.php": "/login", "/order_list.php": "/orders", "/export.php": "/orders.csv"}, "fields": {"ctl00$name": "name"}}');
  const port = await freePort();
  const driver = (flavor, extra = '') => `spec-relay-http --base http://127.0.0.1:${port} --start 'node system.cjs ${port} ${flavor}' --map tests/golden/http-map.json${extra}`;
  try {
    // Other markup, other paths, other field names, UTF-8: the same answers.
    let r = await compare({ cases: 'tests/golden/shop-orders', driver: driver('new'), cwd: dir });
    assert.equal(r.ok, true, report(r));
    assert.deepEqual([r.count, r.passed], [6, 6]);
    assert.deepEqual(r.rules, ['ignore $.json.at', 'map 3 paths, 1 fields']);
    // The system was stopped again: the same port starts a second time.
    r = await compare({ cases: 'tests/golden/shop-orders', driver: driver('broken'), cwd: dir });
    assert.equal(r.ok, false);
    assert.match(report(r), /case list \(tests\/golden\/shop-orders\/recorded\.jsonl:3\):\n {2}\$\.text\[3\]: expected "1件", got "2件"/);
    // Without the map the new system does not know the old paths.
    r = await compare({ cases: 'tests/golden/shop-orders', driver: `spec-relay-http --base http://127.0.0.1:${port} --start 'node system.cjs ${port} new'`, cwd: dir });
    assert.equal(r.ok, false);
    assert.match(report(r), /\$\.redirect: expected "\/login\.php", got "\/login"/);

    // A start command that ends, or never listens, is a problem with its output.
    write(dir, 'dies.cjs', 'console.error("cannot bind"); process.exit(3);\n');
    r = await compare({ cases: 'tests/golden/shop-orders', driver: `spec-relay-http --base http://127.0.0.1:${port} --start 'node dies.cjs'`, cwd: dir });
    assert.match(r.problems.join(), /the --start command ended before http:\/\/127\.0\.0\.1:\d+ answered \(exit code 3\): node dies\.cjs/);
    assert.match(report(r), /cannot bind/);
    write(dir, 'idle.cjs', 'setInterval(() => {}, 1000);\n');
    r = await compare({ cases: 'tests/golden/shop-orders', driver: `spec-relay-http --base http://127.0.0.1:${port} --start 'node idle.cjs' --wait-seconds 1`, cwd: dir });
    assert.match(r.problems.join(), /did not answer within 1 seconds of starting `node idle\.cjs`/);
    assert.match((await compare({ cases: 'tests/golden/shop-orders', driver: `spec-relay-http --base http://127.0.0.1:${port} --start 'node system.cjs ${port} new' --map ../map.json`, cwd: dir })).problems.join(), /the map \.\.\/map\.json is not inside the target root/);
    assert.match((await compare({ cases: 'tests/golden/shop-orders', driver: `spec-relay-http --base http://127.0.0.1:${port} --start 'node system.cjs ${port} new' --map none.json`, cwd: dir })).problems.join(), /the map none\.json does not exist/);

    // Something that already answers is not the code as it is now.
    const stale = await started(dir, port, 'new');
    try {
      r = await compare({ cases: 'tests/golden/shop-orders', driver: driver('new'), cwd: dir });
      assert.match(r.problems.join(), /something already answers at http:\/\/127\.0\.0\.1:\d+ before --start ran/);
      // Outside a port, a system someone started may be asked as it is.
      r = await compare({ cases: 'tests/golden/shop-orders', driver: `spec-relay-http --base http://127.0.0.1:${port} --map tests/golden/http-map.json`, cwd: dir });
      assert.equal(r.ok, true, report(r));
    } finally { await stale(); }
    r = await compare({ cases: 'tests/golden/shop-orders', driver: `spec-relay-http --base http://127.0.0.1:${port}`, cwd: dir });
    assert.match(r.problems.join('\n'), /got no answer from[^\n]+\n[^\n]*give --start '<command>'/);
    // Nothing was compared, so no case counts as matching.
    assert.deepEqual([r.count, r.passed, r.timedOut], [6, 0, false]);
  } finally { delete process.env.SR_TEST_PASS; }
});

test('a port command needs --start, and the options are checked before anything runs', async () => {
  const dir = tempDir();
  write(dir, 'tests/golden/x/a.jsonl', '{"id":"a","input":{"path":"/"},"expected":{"status":200}}\n');
  assert.equal(isHttpDriver('spec-relay-http --base http://localhost:1'), true);
  assert.equal(isHttpDriver('node spec-relay-http.js'), false);
  const port = (driver) => portOptionProblem(parseOptions(['--cases', 'tests/golden/x', '--driver', driver]));
  assert.match(port('spec-relay-http --base http://localhost:3000'), /needs --start '<command>'/);
  assert.equal(port("spec-relay-http --base http://localhost:3000 --start 'npm --silent start'"), null);
  // The run starts the new system here, so a port command never names another host.
  assert.match(port("spec-relay-http --base http://staging.example.test --allow-host staging.example.test --start 'npm start'"), /--allow-host is not allowed in a port command/);
  assert.equal(port('node driver.mjs'), null);
  assert.match(parseOptions(['--cases', 'x', '--driver', 'spec-relay-http --base http://prod.example.test --start x']).problem, /the driver spec-relay-http: --base http:\/\/prod\.example\.test is not this machine/);
  assert.match(parseOptions(['--cases', 'x', '--driver', 'spec-relay-http --start x']).problem, /no --base URL/);
  assert.match((await runCompareCommand('spec-relay-compare --cases tests/golden/x --driver "spec-relay-http --base http://localhost:3000"', dir, {})).output, /needs --start/);
  const r = await runHttpDriver(['--base', 'http://localhost:1', '--bogus', 'x'], [], dir);
  assert.match(r.problems.join(), /spec-relay-http: unknown or incomplete option --bogus/);
});

test('exchange stops at the time limit and keeps sessions apart', async () => {
  const seen = [];
  const send = async (url, init) => {
    seen.push(`${init.method} ${url.pathname}${url.search} cookie=${init.headers.cookie ?? '-'}`);
    return new Response('ok', { status: 200, headers: [['content-type', 'text/plain'], ['set-cookie', `who=${url.searchParams.get('as') ?? 'x'}; Path=/`], ['set-cookie', 'gone=1; Max-Age=0']] });
  };
  const base = new URL('http://localhost:9');
  const cases = [
    { id: 'a1', file: 'a.jsonl', input: { path: '/in?as=ann', session: 'ann' } },
    { id: 'b1', file: 'a.jsonl', input: { path: '/in?as=bob', session: 'bob' } },
    { id: 'a2', file: 'a.jsonl', input: { path: '/me', session: 'ann' } },
    { id: 'c1', file: 'b.jsonl', input: { path: '/me', session: 'ann' } },
  ];
  const ran = await exchange(cases, { base, send });
  assert.deepEqual(ran.problems, []);
  assert.deepEqual(seen, ['GET /in?as=ann cookie=-', 'GET /in?as=bob cookie=-', 'GET /me cookie=who=ann', 'GET /me cookie=-']);
  assert.deepEqual(ran.outputs.get('a1'), { status: 200, type: 'text/plain', body: 'ok' });
  const late = await exchange(cases, { base, send, deadline: Date.now() - 1 });
  assert.match(late.problems.join(), /case a1: the run's time limit passed/);
  assert.deepEqual([late.outputs.size, late.timedOut, ran.timedOut], [0, true, false]);
  // The comparison reports a run that stopped half way as timed out, with no case passed.
  const dir = tempDir();
  write(dir, 'cases/a.jsonl', '{"id":"a","input":{"path":"/"},"expected":{"status":200}}\n{"id":"b","input":{"path":"/"},"expected":{"status":200}}\n');
  const half = await compare({ cases: 'cases', driver: 'spec-relay-http --base http://localhost:9', cwd: dir, http: async () => ({ outputs: new Map([['a', { status: 200 }]]), problems: ['case b: the run\'s time limit passed'], timedOut: true }) });
  assert.deepEqual([half.ok, half.passed, half.timedOut], [false, 0, true]);

  // A request that cannot be built stops everything before the first one is sent.
  seen.length = 0;
  const unsent = await exchange([{ id: 'ok', file: 'a.jsonl', input: { path: '/delete', form: { id: '1' } } }, { id: 'bad', file: 'a.jsonl', input: { path: '/x', headers: { 'X-Name': '山田' } } }], { base, send });
  assert.deepEqual([seen.length, unsent.problems.at(-1)], [0, 'no request was sent']);
  // One that cannot be built from the page it follows stops the rest.
  const pages = async (url) => new Response(url.pathname === '/list' ? '<form><input type=hidden name=id value=1><button name=del>x</button></form><form><input type=hidden name=id value=2><button name=del>x</button></form>' : 'ok', { headers: [['content-type', 'text/html']] });
  const row = await exchange([{ id: 'list', file: 'a.jsonl', input: { path: '/list' } }, { id: 'del', file: 'a.jsonl', input: { path: '/list', hidden: true, form: { del: '' } } }, { id: 'after', file: 'a.jsonl', input: { path: '/list' } }], { base, send: pages });
  assert.deepEqual([...row.outputs.keys()], ['list']);
  assert.match(row.problems.join(), /case del: 2 forms of the last page hold a field of this request.*; this request and the ones after it were not sent/);
});

test('what an answer repeats or issues as a secret never reaches the cases', async () => {
  const base = new URL('http://localhost:9');
  const env = { OLD_USER: 'clerk01', OLD_PASS: 'hunter2 & co' };
  // A sign-in page that echoes the form, a JSON sign-in that issues a token, a session id in the address.
  const send = async (url, init) => {
    const form = new URLSearchParams(init.body?.toString() ?? '');
    if (url.pathname === '/echo') return new Response(`<p>ログインできません: ${form.get('pass').replace(/&/g, '&amp;')}</p><form><input name="user" value="${form.get('user')}"><input name="csrf_token" value="abc123"></form>`, { headers: [['content-type', 'text/html'], ['set-cookie', 'PHPSID=s3cr3t; Path=/']] });
    if (url.pathname === '/api/login') return Response.json({ user: 'clerk01', token: 'eyJhbGciOi.SERVER', profile: { apiKey: 'k-1', sessionId: 42, name: 'x', note: null } });
    return new Response(null, { status: 302, headers: [['location', `/home.php;jsessionid=ABC?PHPSID=s3cr3t&next=${new URLSearchParams({ n: 'hunter2 & co' }).toString().slice(2)}&again=${encodeURIComponent('hunter2 & co')}&page=2`]] });
  };
  const cases = [
    { id: 'echo', file: 'a.jsonl', input: { path: '/echo', form: { user: '{{env:OLD_USER}}', pass: '{{env:OLD_PASS}}' } } },
    { id: 'api', file: 'a.jsonl', input: { path: '/api/login', json: { user: '{{env:OLD_USER}}', pass: '{{env:OLD_PASS}}' } } },
    { id: 'go', file: 'a.jsonl', input: { path: '/go' } },
  ];
  const ran = await exchange(cases, { base, send, env });
  assert.deepEqual(ran.problems, []);
  const text = JSON.stringify([...ran.outputs]);
  for (const secret of ['clerk01', 'hunter2', 'eyJhbGciOi', 'k-1', 's3cr3t', 'abc123', 'ABC']) assert.doesNotMatch(text, new RegExp(secret), secret);
  assert.deepEqual(ran.outputs.get('echo'), { status: 200, type: 'text/html', text: ['ログインできません: {{env:OLD_PASS}}'], fields: { user: '{{env:OLD_USER}}', csrf_token: '(left out)' } });
  assert.deepEqual(ran.outputs.get('api').json, { user: '{{env:OLD_USER}}', token: '(left out)', profile: { apiKey: '(left out)', sessionId: '(left out)', name: 'x', note: null } });
  assert.equal(ran.outputs.get('go').redirect, '/home.php?PHPSID=(left%20out)&next={{env:OLD_PASS}}&again={{env:OLD_PASS}}&page=2');
  // The new system's answers go through the same, so the two still compare equal; without a value nothing changes.
  assert.deepEqual(withoutSecrets({ a: ['x clerk01 y'], n: 1 }, new Map([['U', 'clerk01']])), { a: ['x {{env:U}} y'], n: 1 });
  assert.deepEqual(withoutSecrets({ a: 'b' }, new Map()), { a: 'b' });
});

test('a system that outlives its start command is reported, and the map is part of what a verify run records', async () => {
  const dir = tempDir();
  write(dir, 'idle.cjs', 'setInterval(() => {}, 1000);\n');
  // Nothing answers before the start, then something does, and still does after the stop.
  let calls = 0;
  const send = async () => { calls += 1; if (calls === 1) throw new Error('refused'); return new Response('ok'); };
  const system = await startSystem(`"${process.execPath}" idle.cjs`, dir, new URL('http://localhost:9'), { send, settleMs: 300 });
  assert.equal(system.problem, undefined);
  assert.equal(await system.stop(), true);

  write(dir, 'tests/golden/http-map.json', '{"paths": {"/a.php": "/a"}}\n');
  const driver = "spec-relay-http --base http://localhost:9 --start 'x' --map tests/golden/http-map.json";
  const first = casesDigest('abc', driver, dir);
  assert.notEqual(first, 'abc');
  assert.equal(casesDigest('abc', 'node driver.mjs', dir), 'abc');
  assert.equal(casesDigest('abc', "spec-relay-http --base http://localhost:9 --start 'x'", dir), 'abc');
  assert.equal(casesDigest(null, driver, dir), null);
  // Line endings are not a change; another mapping of the same size is.
  write(dir, 'tests/golden/http-map.json', '{"paths": {"/a.php": "/a"}}\r\n');
  assert.equal(casesDigest('abc', driver, dir), first);
  write(dir, 'tests/golden/http-map.json', '{"paths": {"/a.php": "/b"}}\n');
  assert.notEqual(casesDigest('abc', driver, dir), first);
});

test('the CLI records, and exits 2 on bad usage', async () => {
  const dir = tempDir();
  const port = await freePort();
  const stop = await started(dir, port);
  try {
    write(dir, 'in.jsonl', '{"id":"api","input":{"path":"/api/orders"}}\n');
    const run = (...args) => spawnSync(process.execPath, [path.join(KIT, 'scripts/http.mjs'), ...args], { cwd: dir, encoding: 'utf8' });
    const ok = run('record', '--base', `http://127.0.0.1:${port}`, '--inputs', 'in.jsonl', '--out', 'cases/api.jsonl');
    assert.equal(ok.status, 0, ok.stderr);
    assert.match(ok.stdout, /http: recorded 1 cases/);
    assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'cases/api.jsonl'), 'utf8')).expected.json.count, 1);
    assert.equal(run('record', '--base', 'http://old.example.test', '--inputs', 'in.jsonl', '--out', 'cases/api.jsonl').status, 2);
    assert.equal(run('replay').status, 2);
    assert.equal(run('record', '--base', `http://127.0.0.1:${port}`, '--inputs', 'none.jsonl', '--out', 'cases/x.jsonl').status, 1);
  } finally { await stop(); }
});
