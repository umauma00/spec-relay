#!/usr/bin/env node
// Level B1 for logic that cannot be called directly: code inside a PHP page,
// an ASP.NET WebForms code-behind, a controller that only runs inside its
// server. The running source program is asked over HTTP instead, and the new
// system is asked the same.
//
//   node http.mjs record --base URL --inputs FILE --out FILE
//                        [--charset NAME] [--allow-host HOST] [--request-seconds N]
//
// sends every request of FILE (JSONL, one `{"id": "...", "input": <request>}`
// per line, in order) to the source program at URL and writes the cases
// compare.mjs reads: `{"id", "input", "expected": <response>}`.
//
// In a port's design.md the new system answers the same requests as the B1
// driver, started and stopped by the run:
//   spec-relay-compare --cases tests/golden/<capability> --driver "spec-relay-http
//     --base http://localhost:3000 --start 'npm --silent start' [--map tests/golden/http-map.json]"
// (one line). compare.mjs runs that driver with this script, in the target root.
//
// A request: { "method": "GET", "path": "/order_list.php?page=2",
//   "query": { "q": "山田" }, "headers": { "Accept-Language": "ja" },
//   "form": { "id": "12" } | "json": <any> | "body": "<text>" (+ "contentType"),
//   "hidden": true,     the form also sends the hidden fields of the session's last page
//                       (__VIEWSTATE, a CSRF token), each side its own: those of the form
//                       that holds a field of this request, or "hidden": 2 for the
//                       second form of the page
//   "session": "clerk"  requests with the same name share cookies (default "default") }
// `{{env:NAME}}` in a string is replaced by that environment variable when the
// request is sent; the case keeps the placeholder, and a response that repeats
// the value gets the placeholder back, so a password never reaches a file.
// (Not `${env:NAME}`: PowerShell would put the value there while the file is
// written.) Each case file starts signed out: signing in is a request like any other.
//
// A response: { "status": 200, "redirect": "/login.php", "type": "text/html",
//   "title": "...", "text": ["each block of visible text", ...],
//   "fields": { "name": "value" } }   for HTML;
//   "json": <any> for JSON; "body": "<text>" for other text (CSV, XML);
//   "bytes": { "length", "sha256" } for anything else; "filename" of a download.
// Markup, styles, scripts, hidden fields, hidden text and cookies are left out:
// the two systems may differ there. What a user reads and what a form holds
// stays. Values under names like password, token or session id are replaced by
// "(left out)", in JSON, in fields and in a redirect's query. Redirects are
// recorded, not followed.
//
// --map FILE (JSON, driver only) says where the new system differs on purpose:
//   { "paths": { "/order_list.php": "/orders" }, "fields": { "ctl00$Main$txtName": "name" } }
// Request paths and field names are translated on the way in, redirects and
// field names on the way back, so the recorded cases stay as the old system gave them.
//
// Recording sends real requests, and a POST changes data: URL must be this
// machine (localhost) unless --allow-host names the host, which only the person
// decides. Exits 0 when every request was answered, 1 when not, 2 on bad usage.
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { killTree, track, windowsScript } from './run.mjs';
import { chainProblem } from './gate.mjs';

export const HTTP_DRIVER = 'spec-relay-http';
export const isHttpDriver = (command) => new RegExp(`^\\s*${HTTP_DRIVER}(\\s|$)`).test(command ?? '');

// --- options ------------------------------------------------------------------

const OPTIONS = {
  record: { '--base': 'base', '--inputs': 'inputs', '--out': 'out', '--charset': 'charset', '--allow-host': 'allow', '--request-seconds': 'seconds' },
  driver: { '--base': 'base', '--start': 'start', '--wait-seconds': 'wait', '--map': 'map', '--charset': 'charset', '--allow-host': 'allow', '--request-seconds': 'seconds' },
};

// The options of `record` or of a `spec-relay-http` driver, or { problem }.
export function parseHttpOptions(argv, mode) {
  const opts = { allow: [] };
  for (let i = 0; i < argv.length; i += 2) {
    const key = OPTIONS[mode][argv[i]];
    if (!key || argv[i + 1] === undefined) return { problem: `unknown or incomplete option ${argv[i]}` };
    if (key === 'allow') opts.allow.push(argv[i + 1].toLowerCase()); else opts[key] = argv[i + 1];
  }
  if (!opts.base) return { problem: 'no --base URL (such as http://localhost:8080)' };
  const base = baseUrl(opts.base, opts.allow);
  if (base.problem) return base;
  for (const key of ['seconds', 'wait']) {
    if (opts[key] !== undefined && !(Number(opts[key]) > 0 && Number(opts[key]) <= 3600)) return { problem: `${key === 'seconds' ? '--request-seconds' : '--wait-seconds'} ${opts[key]} is not a number of seconds (at most 3600)` };
  }
  if (opts.charset !== undefined && !encoderFor(opts.charset)) return { problem: `--charset ${opts.charset} is not an encoding this script can send (utf-8, shift_jis, euc-jp or a single-byte code page)` };
  if (mode === 'record' && (!opts.inputs || !opts.out)) return { problem: 'record needs --inputs <file> and --out <file>' };
  if (mode === 'record' && !/\.jsonl$/i.test(opts.out)) return { problem: `--out ${opts.out} must end in .jsonl (compare.mjs reads *.jsonl)` };
  if (opts.start !== undefined) {
    const chained = chainProblem(opts.start);
    if (chained) return { problem: `the --start command ${chained}` };
  }
  return { ...opts, url: base.url };
}

const LOCAL = /^(localhost|127(?:\.\d{1,3}){3}|\[::1\]|::1)$/i;

// The base URL of a system, or { problem }. Requests can change data, so the
// host is this machine unless the person named it.
export function baseUrl(text, allow = []) {
  let url;
  try { url = new URL(text); } catch { return { problem: `--base ${text} is not a URL` }; }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return { problem: `--base ${text} is not an http or https URL` };
  if (url.username || url.password) return { problem: '--base holds a user name or password; sign in with a request whose values come from {{env:NAME}}' };
  if (url.search || url.hash) return { problem: `--base ${text} has a query or a fragment; give the address the paths start from` };
  if (!LOCAL.test(url.hostname) && !allow.includes(url.hostname.toLowerCase())) {
    return { problem: `--base ${text} is not this machine. Requests can change data, so a system on another host must be one the person named as a test system: after they did, add --allow-host ${url.hostname}` };
  }
  return { url };
}

// --- encodings ----------------------------------------------------------------

const MULTI = new Set(['shift_jis', 'euc-jp', 'iso-2022-jp', 'big5', 'euc-kr', 'gbk', 'gb18030', 'utf-16le', 'utf-16be', 'replacement', 'x-user-defined']);
const encoders = new Map();

// A function that writes text in the named encoding (old systems read forms in
// Shift_JIS or EUC-JP, and Node.js only writes UTF-8), or null when the
// encoding is unknown or cannot be written here. The table is made by decoding
// every byte sequence of the encoding once.
export function encoderFor(label) {
  let name;
  try { name = new TextDecoder(charsetName(label)).encoding; } catch { return null; }
  if (name === 'utf-8') return (s) => Buffer.from(s, 'utf8');
  if (encoders.has(name)) return encoders.get(name);
  if (MULTI.has(name) && name !== 'shift_jis' && name !== 'euc-jp') return null;
  const decoder = new TextDecoder(name, { fatal: true });
  const table = new Map();
  const put = (bytes) => {
    let ch;
    try { ch = decoder.decode(Uint8Array.from(bytes)); } catch { return; }
    if ([...ch].length === 1 && !table.has(ch)) table.set(ch, bytes);
  };
  const leads = name === 'shift_jis' ? [[0x81, 0x9f], [0xe0, 0xfc]] : name === 'euc-jp' ? [[0xa1, 0xfe]] : [];
  const double = new Set();
  for (const [from, to] of leads) for (let b = from; b <= to; b += 1) double.add(b);
  for (let b = 0; b < 256; b += 1) if (!double.has(b) && !(name === 'euc-jp' && b >= 0x8e && b <= 0x8f)) put([b]);
  const trail = name === 'shift_jis' ? [0x40, 0xfc] : [0xa1, 0xfe];
  // The first bytes found for a character are the ones sent. The NEC rows
  // 0xED-0xEF repeat the IBM rows 0xFA-0xFC, and browsers send the IBM ones.
  const nec = (b) => name === 'shift_jis' && b >= 0xed && b <= 0xef;
  for (const lead of [...double].filter((b) => !nec(b)).concat([...double].filter(nec))) for (let b = trail[0]; b <= trail[1]; b += 1) put([lead, b]);
  if (name === 'euc-jp') for (let b = 0xa1; b <= 0xdf; b += 1) put([0x8e, b]);
  // As browsers send them (the WHATWG encoders): the yen sign and the overline
  // as their JIS X 0201 bytes, the minus sign as the fullwidth one.
  if (name === 'shift_jis' || name === 'euc-jp') {
    table.set('¥', [0x5c]); table.set('‾', [0x7e]);
    if (table.has('－')) table.set('−', table.get('－'));
  }
  const encode = (s) => {
    const out = [];
    for (const ch of s) {
      const bytes = table.get(ch);
      if (!bytes) throw new Error(`"${ch}" cannot be written in ${name}`);
      out.push(...bytes);
    }
    return Buffer.from(out);
  };
  encoders.set(name, encode);
  return encode;
}

// Names old systems give their encodings that the platform does not know.
const CHARSET_ALIASES = new Map([['cp932', 'shift_jis'], ['sjis-win', 'shift_jis'], ['mskanji', 'shift_jis'], ['cp943', 'shift_jis'], ['eucjp-win', 'euc-jp'], ['euc_jp', 'euc-jp'], ['eucjp', 'euc-jp'], ['cp51932', 'euc-jp'], ['ujis', 'euc-jp'], ['utf8', 'utf-8']]);
const charsetName = (label) => CHARSET_ALIASES.get(String(label).trim().toLowerCase()) ?? label;

// The text of bytes in the first of the encodings the platform can read.
function decodeText(bytes, labels) {
  for (const label of labels) {
    if (!label) continue;
    try { return new TextDecoder(charsetName(label)).decode(bytes); } catch { /* an unknown name: the next one */ }
  }
  return new TextDecoder('utf-8').decode(bytes);
}

// application/x-www-form-urlencoded, in the form's encoding.
function urlEncode(text, encode) {
  let out = '';
  for (const byte of encode(text)) {
    const c = String.fromCharCode(byte);
    out += /[A-Za-z0-9*\-._]/.test(c) ? c : byte === 0x20 ? '+' : `%${byte.toString(16).toUpperCase().padStart(2, '0')}`;
  }
  return out;
}
const formEncode = (pairs, encode) => pairs.map(([k, v]) => `${urlEncode(k, encode)}=${urlEncode(v, encode)}`).join('&');

// --- HTML as a user reads it ----------------------------------------------------

const ENTITIES = new Map(Object.entries({
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', ensp: ' ', emsp: ' ', thinsp: ' ', yen: '¥', copy: '©', reg: '®', trade: '™',
  laquo: '«', raquo: '»', lsquo: '‘', rsquo: '’', ldquo: '“', rdquo: '”', sbquo: '‚', bdquo: '„', middot: '·', bull: '•', hellip: '…',
  mdash: '—', ndash: '–', minus: '−', times: '×', divide: '÷', plusmn: '±', deg: '°', sect: '§', para: '¶', cent: '¢', pound: '£', euro: '€',
  larr: '←', rarr: '→', uarr: '↑', darr: '↓', harr: '↔', rArr: '⇒', lArr: '⇐', le: '≤', ge: '≥', ne: '≠', frac12: '½', frac14: '¼', frac34: '¾',
  sup2: '²', sup3: '³', micro: 'µ', iexcl: '¡', iquest: '¿', shy: '', zwnj: '', zwj: '', lrm: '', rlm: '',
}));
const CP1252 = new TextDecoder('windows-1252');
const unescape = (s) => s.replace(/&(#x[0-9a-f]+|#\d+|[a-z][a-z0-9]*);/gi, (whole, name) => {
  if (name[0] !== '#') return ENTITIES.get(name) ?? ENTITIES.get(name.toLowerCase()) ?? whole;
  const code = name[1].toLowerCase() === 'x' ? parseInt(name.slice(2), 16) : Number(name.slice(1));
  // &#150; is a dash in every browser: 128-159 are read as Windows-1252.
  if (code >= 0x80 && code <= 0x9f) return CP1252.decode(Uint8Array.of(code));
  try { return String.fromCodePoint(code); } catch { return whole; }
});
const clean = (s) => unescape(s).replace(/\s+/g, ' ').trim();

// A tag ends before the next "<": markup that never closes its tags stays quick to read.
const TAG = /<(\/?)([a-zA-Z][\w:-]*)((?:[^<>"']|"[^"]*"|'[^']*')*)>/g;
const ATTRIBUTE = /([^\s"'=<>/]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;
// Tags that start a new block of text. Inline tags (a, b, span, label...) do not.
const BLOCK = new Set(['address', 'article', 'aside', 'blockquote', 'body', 'br', 'button', 'caption', 'center', 'dd', 'details', 'dialog', 'div', 'dl', 'dt', 'fieldset', 'figcaption', 'figure', 'footer', 'form', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'head', 'header', 'hr', 'html', 'legend', 'li', 'main', 'menu', 'nav', 'ol', 'optgroup', 'option', 'p', 'pre', 'section', 'select', 'summary', 'table', 'tbody', 'td', 'textarea', 'tfoot', 'th', 'thead', 'title', 'tr', 'ul']);

const VOID = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'param', 'source', 'track', 'wbr']);
// An element the page does not show: text inside it is not text a user reads.
const UNSEEN = /\bhidden\b|display\s*:\s*none|visibility\s*:\s*(hidden|collapse)/i;

function attributes(raw) {
  const out = Object.create(null);
  for (const m of raw.matchAll(ATTRIBUTE)) {
    const key = m[1].toLowerCase();
    if (!(key in out)) out[key] = unescape(m[2] ?? m[3] ?? m[4] ?? '');
  }
  return out;
}

// What a page shows and holds: { title, text, fields, hidden, forms }.
// `text` is the visible text, one entry per block (a paragraph, a table cell, a
// list item, an option, a button); `fields` the form controls by name with the
// value they hold (a checked box or radio button only); `hidden` the hidden
// fields, which are sent back with "hidden" and never compared; `forms` the
// forms in page order, each with its hidden fields and the names of its controls.
// Text inside an element the page hides (the `hidden` attribute, an inline
// display:none or visibility:hidden, <noscript>) is left out.
export function htmlView(html) {
  // Comments, the doctype, CDATA marks and processing instructions are not text; scripts and styles neither.
  const src = html.replace(/<!--[\s\S]*?-->/g, '').replace(/<(script|style|template)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, ' ')
    .replace(/<!\[CDATA\[|\]\]>/g, '').replace(/<![^>]*>|<\?[\s\S]*?\?>/g, '');
  // Names come from the page: objects without a prototype, so "constructor" is a name like any other.
  const text = []; const fields = Object.create(null); const hidden = Object.create(null);
  const forms = [];
  const loose = { hidden: Object.create(null), names: [] }; // controls outside every form
  let form = null;
  let title = null;
  let buffer = '';
  let pos = 0;
  let raw = null; // { tag, attrs, from }: an element whose content is read as text (title, textarea)
  let select = null; // { name, multiple, chosen: [], first }
  let option = null; // { attrs }
  let mute = null; // { tag, depth }: inside an element the page does not show
  const flush = () => { const t = clean(buffer); buffer = ''; if (t) text.push(t); return t; };
  const add = (name, value) => {
    if (!name) return;
    (form ?? loose).names.push(name);
    if (!(name in fields)) fields[name] = value;
    else fields[name] = [...(Array.isArray(fields[name]) ? fields[name] : [fields[name]]), value];
  };
  const endOption = () => {
    if (!option) return;
    const label = clean(buffer);
    const value = 'value' in option.attrs ? option.attrs.value : label;
    if (select) { select.first ??= value; if ('selected' in option.attrs) select.chosen.push(value); }
    option = null;
  };
  const endSelect = () => {
    if (!select) return;
    const values = select.chosen.length ? select.chosen : select.multiple || select.first === undefined ? [] : [select.first];
    if (select.multiple) add(select.name, values); else if (values.length) add(select.name, values.at(-1));
    select = null;
  };
  const keepHidden = (attrs) => { if (attrs.name) { hidden[attrs.name] = attrs.value ?? ''; (form ?? loose).hidden[attrs.name] = attrs.value ?? ''; } };
  for (const m of src.matchAll(TAG)) {
    const [whole, closing, rawName, rawAttrs] = m;
    const tag = rawName.toLowerCase();
    if (raw) {
      if (!closing || tag !== raw.tag) continue;
      const inner = src.slice(raw.from, m.index);
      if (raw.tag === 'title') title ??= clean(inner);
      else add(raw.attrs.name, unescape(inner.replace(/^\r?\n/, '')).replace(/\r\n?/g, '\n'));
      raw = null;
      pos = m.index + whole.length;
      continue;
    }
    if (mute) {
      // Nothing in here is shown. A hidden field is still sent, and a form still begins or ends.
      pos = m.index + whole.length;
      if (tag === mute.tag && !/\/\s*$/.test(rawAttrs)) { mute.depth += closing ? -1 : 1; if (mute.depth === 0) mute = null; }
      else if (tag === 'input' && !closing) { const attrs = attributes(rawAttrs); if ((attrs.type ?? '').toLowerCase() === 'hidden') keepHidden(attrs); }
      else if (tag === 'form') { if (closing) form = null; else { form = { hidden: Object.create(null), names: [] }; forms.push(form); } }
      continue;
    }
    buffer += src.slice(pos, m.index);
    pos = m.index + whole.length;
    if (!closing && !VOID.has(tag) && !/\/\s*$/.test(rawAttrs) && (tag === 'noscript' || UNSEEN.test(rawAttrs))) {
      const attrs = tag === 'noscript' ? null : attributes(rawAttrs);
      if (!attrs || 'hidden' in attrs || /display\s*:\s*none|visibility\s*:\s*(hidden|collapse)/i.test(attrs.style ?? '')) { mute = { tag, depth: 1 }; continue; }
    }
    if (option && (tag === 'option' || tag === 'optgroup' || tag === 'select')) endOption();
    // Attribute values are already unescaped; the buffer is unescaped once more when it is flushed.
    const shown = (value) => value.replace(/&/g, '&amp;').replace(/</g, '&lt;');
    if (tag === 'img') {
      const alt = closing ? '' : attributes(rawAttrs).alt;
      if (alt) buffer += ` ${shown(alt)} `;
      continue;
    }
    if (tag === 'input') {
      if (closing) continue;
      const attrs = attributes(rawAttrs);
      const type = (attrs.type ?? 'text').toLowerCase();
      if (type === 'hidden') keepHidden(attrs);
      // The wording of a button is text a user reads, in its own block.
      else if (['submit', 'button', 'reset', 'image'].includes(type)) { flush(); buffer = shown((type === 'image' ? attrs.alt : attrs.value) ?? ''); flush(); if (attrs.name) (form ?? loose).names.push(attrs.name); }
      else if (type === 'checkbox' || type === 'radio') { if ('checked' in attrs) add(attrs.name, attrs.value ?? 'on'); else if (attrs.name) (form ?? loose).names.push(attrs.name); }
      else if (type !== 'password' && type !== 'file') add(attrs.name, attrs.value ?? '');
      else if (attrs.name) (form ?? loose).names.push(attrs.name);
      continue;
    }
    if (!BLOCK.has(tag)) continue;
    flush();
    if (tag === 'form') { if (closing) form = null; else { form = { hidden: Object.create(null), names: [] }; forms.push(form); } continue; }
    if (closing) { if (tag === 'select') endSelect(); continue; }
    const attrs = attributes(rawAttrs);
    if (tag === 'title' || tag === 'textarea') raw = { tag, attrs, from: pos };
    else if (tag === 'select') { endSelect(); select = { name: attrs.name, multiple: 'multiple' in attrs, chosen: [], first: undefined }; if (attrs.name) (form ?? loose).names.push(attrs.name); }
    else if (tag === 'option') option = { attrs };
    else if (tag === 'button' && attrs.name) (form ?? loose).names.push(attrs.name);
  }
  if (!mute) buffer += src.slice(pos);
  endOption(); flush(); endSelect();
  if (loose.names.length || Object.keys(loose.hidden).length) forms.push(loose);
  const plain = (object) => Object.fromEntries(Object.entries(object));
  return { title, text, fields: plain(fields), hidden: plain(hidden), forms: forms.map((f) => ({ hidden: plain(f.hidden), names: [...new Set(f.names)] })) };
}

// --- requests -------------------------------------------------------------------

const PLACEHOLDER = /\{\{env:([A-Za-z_][A-Za-z0-9_]*)\}\}/g;
// What looks like a placeholder and is none: another shell's syntax, a name with other characters.
const NEAR_PLACEHOLDER = /\$\{?env:|\{\{\s*env\b/i;

// Replaces {{env:NAME}} in every string of a value. `seen` collects the names
// without a value (`missing`), the values put in (`used`: name -> value) and
// whether a string holds a mistyped placeholder (`mistyped`).
function fill(value, env, seen) {
  if (typeof value === 'string') {
    if (NEAR_PLACEHOLDER.test(value.replace(PLACEHOLDER, ''))) seen.mistyped = true;
    return value.replace(PLACEHOLDER, (_, name) => { if (env[name] === undefined || env[name] === '') { seen.missing.add(name); return ''; } seen.used.set(name, env[name]); return env[name]; });
  }
  if (Array.isArray(value)) return value.map((v) => fill(v, env, seen));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, fill(v, env, seen)]));
  return value;
}

// A response with every value an environment variable gave replaced by its
// placeholder again: a page that repeats the user name or the password must
// not carry it into a file. Both systems' answers go through this, so they
// still compare equal.
export function withoutSecrets(value, used) {
  // Also as an address carries the value (percent-encoded, or as a form writes it).
  const forms = (v) => [...new Set([v, encodeURIComponent(v), new URLSearchParams({ v }).toString().slice(2), encodeURI(v)])];
  const pairs = [...used].flatMap(([name, v]) => forms(v).map((text) => [text, `{{env:${name}}}`])).sort((a, b) => b[0].length - a[0].length);
  if (pairs.length === 0) return value;
  const walk = (v) => {
    if (typeof v === 'string') return pairs.reduce((text, [secret, mark]) => text.split(secret).join(mark), v);
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, one]) => [k, walk(one)]));
    return v;
  };
  return walk(value);
}

// Names whose values are secrets of one run (a token the server issued, a
// session id): never written, never compared.
const SECRET_NAME = /pass(word|wd)?$|^pwd$|secret|token|api[-_]?key|sess(ion)?[-_]?id|^sid$/i;
const LEFT_OUT = '(left out)';
function leaveOut(value) {
  if (Array.isArray(value)) return value.map(leaveOut);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, SECRET_NAME.test(k) && (typeof v === 'string' || typeof v === 'number') && v !== '' ? LEFT_OUT : leaveOut(v)]));
  return value;
}

const pairsOf = (object, rename = (k) => k) => Object.entries(object).flatMap(([k, v]) => (Array.isArray(v) ? v : [v]).map((one) => [rename(k), one === null || one === undefined ? '' : String(one)]));
const isPlain = (v) => Boolean(v) && typeof v === 'object' && !Array.isArray(v);

// Names come from pages and files: objects without a prototype, so a field called "constructor" finds nothing.
function emptyMap() {
  const table = () => Object.create(null);
  return { paths: table(), fields: table(), back: { paths: table(), fields: table() } };
}

// The map of a driver: { paths, fields, back: { paths, fields } }, or { problem }.
export function readMap(text) {
  let raw;
  try { raw = JSON.parse(text); } catch (error) { return { problem: `the map is not JSON: ${error.message}` }; }
  if (!isPlain(raw)) return { problem: 'the map must be one JSON object' };
  const unknown = Object.keys(raw).filter((k) => k !== 'paths' && k !== 'fields');
  if (unknown.length) return { problem: `the map has the unknown key "${unknown[0]}" (keys: paths, fields)` };
  const out = emptyMap();
  for (const key of ['paths', 'fields']) {
    if (raw[key] === undefined) continue;
    if (!isPlain(raw[key]) || Object.values(raw[key]).some((v) => typeof v !== 'string' || !v)) return { problem: `the map's "${key}" must be an object of old name to new name` };
    for (const [from, to] of Object.entries(raw[key])) {
      if (key === 'paths' && (!from.startsWith('/') || !to.startsWith('/') || /[?#]/.test(from + to))) return { problem: `the map's path ${from} -> ${to} must be two paths that start with / and hold no query` };
      // Two old names for one new name cannot be told apart on the way back.
      if (to in out.back[key]) return { problem: `the map gives ${out.back[key][to]} and ${from} the same new ${key === 'paths' ? 'path' : 'field'} ${to}; a response could not be translated back` };
      out[key][from] = to;
      out.back[key][to] = from;
    }
  }
  return out;
}

const NO_MAP = emptyMap();

// The hidden fields a "hidden" request sends along: those of one form of the
// session's last page, or { problem } when the page leaves the choice open.
function carriedFields(want, given, session) {
  const forms = session.forms ?? [{ hidden: session.hidden ?? {}, names: [] }];
  if (typeof want === 'number') {
    if (!forms[want - 1]) return { problem: `"hidden": ${want} asks for form ${want}, but the last page of this session has ${forms.length} form${forms.length === 1 ? '' : 's'}` };
    return forms[want - 1].hidden;
  }
  const filled = forms.filter((f) => Object.keys(f.hidden).length > 0);
  const named = forms.filter((f) => given.some(([k]) => f.names.includes(k)));
  const same = (a, b) => JSON.stringify(Object.entries(a.hidden).sort()) === JSON.stringify(Object.entries(b.hidden).sort());
  // Several forms with the same field (a delete button per row): which row is the request's to say.
  if (named.length > 1 && !named.every((f) => same(f, named[0]))) return { problem: `${named.length} forms of the last page hold a field of this request, with different hidden fields; write "hidden": <the number of the form on the page, from 1>` };
  if (named.length) return named[0].hidden;
  if (filled.length > 1 && !filled.every((f) => same(f, filled[0]))) return { problem: `the last page of this session has ${filled.length} forms with hidden fields and none holds a field of this request; write "hidden": <the number of the form on the page, from 1>` };
  return filled[0]?.hidden ?? {};
}

// The request a case asks for, ready to send: { url, method, headers, body, used }, or { problem }.
// `used` holds the environment values put in (name -> value). With `dry`, what
// depends on the session's last page is not looked at (the check before anything is sent).
export function buildRequest(input, { base, session, env = process.env, encode = encoderFor('utf-8'), map = NO_MAP, dry = false }) {
  if (!isPlain(input)) return { problem: 'the input is not a request object' };
  const known = ['method', 'path', 'query', 'headers', 'form', 'json', 'body', 'contentType', 'hidden', 'session', 'note'];
  const unknown = Object.keys(input).filter((k) => !known.includes(k));
  if (unknown.length) return { problem: `the request has the unknown key "${unknown[0]}" (keys: ${known.slice(0, -1).join(', ')})` };
  if (typeof input.path !== 'string' || !/^\/(?!\/)/.test(input.path)) return { problem: 'the request needs a "path" that starts with one / (the address comes from --base)' };
  for (const key of ['query', 'headers', 'form']) if (input[key] !== undefined && !isPlain(input[key])) return { problem: `the request's "${key}" must be an object` };
  const bodies = ['form', 'json', 'body'].filter((k) => input[k] !== undefined);
  if (bodies.length > 1) return { problem: `the request has ${bodies.join(' and ')}; give one body` };
  if (input.hidden !== undefined && typeof input.hidden !== 'boolean' && !(Number.isInteger(input.hidden) && input.hidden >= 1)) return { problem: 'the request\'s "hidden" must be true, false or the number of a form on the page (from 1)' };
  if (input.hidden && (input.json !== undefined || input.body !== undefined)) return { problem: '"hidden" goes with "form" (the hidden fields are form fields)' };
  const seen = { missing: new Set(), used: new Map(), mistyped: false };
  const filled = fill({ path: input.path, query: input.query ?? {}, headers: input.headers ?? {}, form: input.form, json: input.json, body: input.body }, env, seen);
  if (seen.mistyped) return { problem: 'a value holds something like a placeholder that is none; write {{env:NAME}} (letters, digits and _), not ${env:NAME} or $env:NAME' };
  if (seen.missing.size) return { problem: `the environment variable ${[...seen.missing].join(', ')} is not set (the person sets it; never write its value into a file)` };
  let url;
  try { url = new URL(filled.path, base); } catch { return { problem: `the path ${input.path} is not a URL path` }; }
  if (url.origin !== base.origin) return { problem: `the path ${input.path} leaves ${base.origin}` };
  const rename = (k) => map.fields[k] ?? k;
  let body = null;
  const headers = {};
  try {
    const pathname = map.paths[url.pathname] ?? url.pathname;
    const prefix = base.pathname.replace(/\/$/, '');
    const extra = formEncode(pairsOf(filled.query, rename), encode);
    const search = [url.search.replace(/^\?/, ''), extra].filter(Boolean).join('&');
    url = new URL(`${base.origin}${prefix}${pathname}${search ? `?${search}` : ''}`);
    if (input.form !== undefined || input.hidden) {
      const given = pairsOf(filled.form ?? {}, rename);
      const names = new Set(given.map(([k]) => k));
      const hidden = input.hidden && !dry ? carriedFields(input.hidden, given, session) : {};
      if (hidden.problem) return hidden;
      body = Buffer.from(formEncode([...Object.entries(hidden).filter(([k]) => !names.has(k)), ...given], encode), 'latin1');
      headers['content-type'] = 'application/x-www-form-urlencoded';
    } else if (input.json !== undefined) {
      body = Buffer.from(JSON.stringify(filled.json), 'utf8');
      headers['content-type'] = 'application/json';
    } else if (input.body !== undefined) {
      if (typeof filled.body !== 'string') return { problem: 'the request\'s "body" must be a string' };
      body = encode(filled.body);
      headers['content-type'] = typeof input.contentType === 'string' ? input.contentType : 'text/plain';
    }
  } catch (error) {
    // The character may come from a variable's value: it is not shown then.
    return { problem: seen.used.size ? 'a value holds a character the --charset cannot write' : error.message };
  }
  for (const [k, v] of Object.entries(filled.headers)) {
    // What fetch would refuse is refused before anything is sent.
    if (!/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(k) || /[^\t\x20-\x7e\x80-\xff]/.test(String(v))) return { problem: `the header ${k} holds characters a header cannot carry (a non-ASCII value goes into the body or the query)` };
    headers[k.toLowerCase()] = String(v);
  }
  if (session.cookies.size) headers.cookie = [...session.cookies].map(([k, v]) => `${k}=${v}`).join('; ');
  const method = typeof input.method === 'string' ? input.method.toUpperCase() : body ? 'POST' : 'GET';
  if (!/^[A-Z]+$/.test(method)) return { problem: `the method ${input.method} is not an HTTP method` };
  if (body && (method === 'GET' || method === 'HEAD')) return { problem: `a ${method} request cannot carry a body; put the values in "query"` };
  return { url, method, headers, body, used: seen.used };
}

function keepCookies(session, response) {
  for (const line of response.headers.getSetCookie?.() ?? []) {
    const [pair, ...rest] = line.split(';');
    const eq = pair.indexOf('=');
    if (eq < 1) continue;
    const name = pair.slice(0, eq).trim(); const value = pair.slice(eq + 1).trim();
    const attrs = Object.fromEntries(rest.map((a) => { const i = a.indexOf('='); return i < 0 ? [a.trim().toLowerCase(), ''] : [a.slice(0, i).trim().toLowerCase(), a.slice(i + 1).trim()]; }));
    const gone = (attrs['max-age'] !== undefined && Number(attrs['max-age']) <= 0) || (attrs.expires && Date.parse(attrs.expires) < Date.now());
    if (gone) session.cookies.delete(name); else session.cookies.set(name, value);
  }
}

// --- responses ------------------------------------------------------------------

const textual = (type) => /^text\//.test(type) || /(^|[/+])(xml|javascript|csv)$/.test(type) || type === 'application/x-www-form-urlencoded';

// What a response says, in the shape the cases keep. `session.hidden` gets the
// page's hidden fields for the next "hidden": true request.
export function viewResponse({ status, headers, bytes, requestUrl }, { base, charset = 'utf-8', map = NO_MAP, session = null }) {
  const out = { status };
  const location = headers.get('location');
  if (location) {
    let to = null;
    try { to = new URL(location, requestUrl); } catch { /* kept as written */ }
    if (to) {
      // A session id in the address (PHP's trans_sid, ;jsessionid=) is this run's own.
      to.pathname = to.pathname.replace(/;jsessionid=[^/;]*/gi, '');
      const decoded = (text) => { try { return decodeURIComponent(text.replace(/\+/g, ' ')); } catch { return text; } };
      const secret = (pair) => { const name = decoded(pair.split('=')[0]); return SECRET_NAME.test(name) || Boolean(session?.cookies.has(name)); };
      // Only the pairs left out change; the rest of the query stays as the system wrote it.
      if (to.search) to.search = to.search.slice(1).split('&').map((pair) => (secret(pair) ? `${pair.split('=')[0]}=${LEFT_OUT}` : pair)).join('&');
    }
    if (to && to.origin === base.origin) {
      const prefix = base.pathname.replace(/\/$/, '');
      const pathname = prefix && to.pathname.startsWith(`${prefix}/`) ? to.pathname.slice(prefix.length) : to.pathname;
      out.redirect = `${map.back.paths[pathname] ?? pathname}${to.search}${to.hash}`;
    } else out.redirect = to ? to.href : location;
  }
  const contentType = headers.get('content-type') ?? '';
  const type = contentType.split(';')[0].trim().toLowerCase();
  // The type of an empty body says nothing (PHP names text/html on every redirect).
  if (type && bytes.length) out.type = type;
  const filename = (headers.get('content-disposition') ?? '').match(/filename\*?=(?:UTF-8'')?"?([^";]+)"?/i)?.[1];
  if (filename) { try { out.filename = decodeURIComponent(filename); } catch { out.filename = filename; } }
  if (!bytes.length) return out;
  const named = contentType.match(/charset\s*=\s*"?([\w.:-]+)/i)?.[1];
  const html = type === 'text/html' || type === 'application/xhtml+xml';
  const sniffed = html ? Buffer.from(bytes.subarray(0, 4096)).toString('latin1').match(/<meta[^>]+charset\s*=\s*["']?\s*([\w.:-]+)/i)?.[1] : null;
  // A name the platform does not know (CP932 is read, "x-sjis-old" is not) falls back to the next one.
  const read = () => decodeText(bytes, [named, sniffed, charset]);
  if (html) {
    const view = htmlView(read());
    if (session) { session.hidden = view.hidden; session.forms = view.forms; }
    // An empty title shows nothing, like no title.
    if (view.title) out.title = view.title;
    out.text = view.text;
    out.fields = leaveOut(Object.fromEntries(Object.entries(view.fields).map(([k, v]) => [map.back.fields[k] ?? k, v])));
  } else if (type === 'application/json' || type.endsWith('+json')) {
    const text = read();
    try { out.json = leaveOut(JSON.parse(text)); } catch { out.body = text.replace(/\r\n?/g, '\n'); }
  } else if (textual(type)) out.body = read().replace(/^﻿/, '').replace(/\r\n?/g, '\n');
  else out.bytes = { length: bytes.length, sha256: crypto.createHash('sha256').update(bytes).digest('hex') };
  return out;
}

// --- running --------------------------------------------------------------------

const newSession = () => ({ cookies: new Map(), hidden: {}, forms: [] });

// Sends the requests of the cases in order: { outputs: Map<id, response>, problems, timedOut }.
// It stops at the first request that gets no answer or cannot be built. Cases
// of one file share their sessions; the next file starts signed out again.
export async function exchange(cases, { base, charset = 'utf-8', map = NO_MAP, env = process.env, requestMs = 30000, deadline = Infinity, send = fetch }) {
  const outputs = new Map();
  const problems = [];
  const encode = encoderFor(charset);
  // Nothing is sent while a request cannot be built: with the sign-in left out
  // (a variable that is not set), the requests after it would act signed out.
  const used = new Map();
  for (const c of cases) {
    const request = buildRequest(c.input, { base, session: newSession(), env, encode, map, dry: true });
    if (request.problem) problems.push(`case ${c.id}: ${request.problem}`);
    else for (const [name, value] of request.used) used.set(name, value);
  }
  if (problems.length) { problems.push('no request was sent'); return { outputs, problems, timedOut: false }; }
  let timedOut = false;
  let sessions = new Map();
  let file;
  for (const c of cases) {
    if (c.file !== file) { sessions = new Map(); file = c.file; }
    const name = isPlain(c.input) && typeof c.input.session === 'string' && c.input.session ? c.input.session : 'default';
    if (!sessions.has(name)) sessions.set(name, newSession());
    const session = sessions.get(name);
    const request = buildRequest(c.input, { base, session, env, encode, map });
    // The requests after it would act on a state this one was to make.
    if (request.problem) { problems.push(`case ${c.id}: ${request.problem}; this request and the ones after it were not sent`); break; }
    if (Date.now() > deadline) { timedOut = true; problems.push(`case ${c.id}: the run's time limit passed; this request and the ones after it were not sent`); break; }
    let response; let bytes;
    try {
      response = await send(request.url, { method: request.method, headers: request.headers, body: request.body, redirect: 'manual', signal: AbortSignal.timeout(requestMs) });
      bytes = new Uint8Array(await response.arrayBuffer());
    } catch (error) {
      const why = error?.name === 'TimeoutError' ? `no answer within ${requestMs / 1000} seconds` : error?.cause?.code ?? error?.cause?.message ?? error?.message ?? String(error);
      problems.push(`case ${c.id}: ${request.method} ${request.url.pathname} got no answer from ${base.origin} (${why}); the requests after it were not sent`);
      break;
    }
    keepCookies(session, response);
    outputs.set(c.id, withoutSecrets(viewResponse({ status: response.status, headers: response.headers, bytes, requestUrl: request.url }, { base, charset, map, session }), used));
  }
  return { outputs, problems, timedOut };
}

const sleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });

// Whether anything answers at the URL (any status counts: it is listening).
async function answers(url, send = fetch) {
  try { const r = await send(url, { redirect: 'manual', signal: AbortSignal.timeout(2000) }); await r.arrayBuffer().catch(() => {}); return true; } catch { return false; }
}

// Starts the new system with its command and waits until it answers:
// { stop, tail } or { problem, output }. Something that already answers would
// be code from an earlier run, not the code as it is now, so that is a problem.
// `stop()` resolves to whether something still answers afterwards (a server the
// command started outside its own process tree).
export async function startSystem(command, cwd, base, { waitMs = 60000, settleMs = 5000, platform = process.platform, send = fetch } = {}) {
  if (await answers(base, send)) return { problem: `something already answers at ${base.origin} before --start ran; stop it, so the comparison runs the code as it is now` };
  const [file, args, extra] = platform === 'win32'
    ? ['powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', windowsScript(command)], {}]
    : ['/bin/sh', ['-c', command], { detached: true }];
  const chunks = [];
  let size = 0;
  const keep = (chunk) => { chunks.push(chunk); size += chunk.length; while (size > 64 * 1024 && chunks.length > 1) size -= chunks.shift().length; };
  const tail = () => Buffer.concat(chunks).toString('utf8');
  let child;
  let exited = null;
  try { child = spawn(file, args, { cwd, env: process.env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], ...extra }); } catch (error) { return { problem: `could not start \`${command}\`: ${error.message}`, output: '' }; }
  const untrack = track(child);
  child.stdout.on('data', keep); child.stderr.on('data', keep);
  child.on('error', (error) => { exited ??= error.message; });
  child.on('exit', (code) => { exited ??= `exit code ${code}`; });
  const stop = async () => {
    // Also after the command's own process ended: what it started may still run.
    killTree(child, platform);
    untrack();
    child.stdout.destroy(); child.stderr.destroy();
    // The port is free again before the next run asks whether something answers.
    for (const until = Date.now() + settleMs; ;) { if (!await answers(base, send)) return false; if (Date.now() >= until) return true; await sleep(200); }
  };
  const deadline = Date.now() + waitMs;
  while (Date.now() < deadline) {
    if (exited !== null) { await stop(); return { problem: `the --start command ended before ${base.origin} answered (${exited}): ${command}`, output: tail() }; }
    if (await answers(base, send)) return { stop, tail };
    await sleep(300);
  }
  await stop();
  return { problem: `${base.origin} did not answer within ${waitMs / 1000} seconds of starting \`${command}\` (--wait-seconds changes the limit)`, output: tail() };
}

// The B1 driver `spec-relay-http ...`: the new system answers the recorded
// requests. { outputs, problems, output, rules, timedOut } for compare.mjs.
export async function runHttpDriver(argv, cases, cwd, { timeoutMs, send = fetch, env = process.env, platform = process.platform } = {}) {
  const deadline = timeoutMs ? Date.now() + timeoutMs : Infinity;
  const none = (problem, extra = {}) => ({ outputs: new Map(), problems: [`${HTTP_DRIVER}: ${problem}`], timedOut: false, ...extra });
  const opts = parseHttpOptions(argv, 'driver');
  if (opts.problem) return none(opts.problem);
  let map = NO_MAP;
  if (opts.map) {
    const read = readMapFile(cwd, opts.map);
    if (read.problem) return none(read.problem);
    map = read.map;
  }
  let system = null;
  if (opts.start) {
    // The run's own time limit also ends the wait for the system.
    const wait = Number(opts.wait ?? 60) * 1000;
    const left = deadline - Date.now();
    system = await startSystem(opts.start, cwd, opts.url, { waitMs: Math.max(1000, Math.min(wait, left)), platform, send });
    if (system.problem) return none(system.problem, { output: system.output, timedOut: left < wait && Date.now() >= deadline });
  }
  let result;
  let survives = false;
  try {
    const ran = await exchange(cases, { base: opts.url, charset: opts.charset ?? 'utf-8', map, env, requestMs: Number(opts.seconds ?? 30) * 1000, deadline, send });
    const failed = ran.problems.length > 0;
    if (failed && !opts.start && ran.outputs.size === 0) ran.problems.push(`${HTTP_DRIVER}: nothing was read from ${opts.url.origin}; give --start '<command>' so the run starts the new system itself`);
    result = { ...ran, ...(failed && system ? { output: system.tail() } : {}), rules: map === NO_MAP ? [] : [`map ${Object.keys(map.paths).length} paths, ${Object.keys(map.fields).length} fields`] };
  } finally { survives = system ? await system.stop() : false; }
  // The next run would refuse to start beside it, and it may hold the test database open.
  if (survives) result.problems.push(`${HTTP_DRIVER}: ${opts.url.origin} still answers after the --start command was stopped (it started the system outside its own process tree); use a command that runs the system in the foreground, and stop the one that is running`);
  return result;
}

// The map file of a driver, inside the target root: { map, text } or { problem }.
export function readMapFile(cwd, name) {
  const file = path.resolve(cwd, name);
  const rel = path.relative(cwd, file);
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return { problem: `the map ${name} is not inside the target root` };
  let text;
  try { text = fs.readFileSync(file, 'utf8').replace(/^﻿/, ''); } catch { return { problem: `the map ${name} does not exist` }; }
  const map = readMap(text);
  return map.problem ? { problem: `${name}: ${map.problem}` } : { map, text };
}

// --- recording ------------------------------------------------------------------

// Reads the requests to record: [{ id, input }], with problems for bad lines.
export function readInputs(text, label, problems) {
  const out = [];
  const seen = new Set();
  text.replace(/^﻿/, '').split(/\r?\n/).forEach((line, i) => {
    if (!line.trim()) return;
    let value;
    try { value = JSON.parse(line); } catch (error) { problems.push(`${label}:${i + 1} is not JSON (${error.message})`); return; }
    if (!isPlain(value) || typeof value.id !== 'string' || !value.id) { problems.push(`${label}:${i + 1} has no "id" (a non-empty string)`); return; }
    if (!('input' in value)) { problems.push(`${label}:${i + 1} (case ${value.id}) has no "input"`); return; }
    if (seen.has(value.id)) { problems.push(`${label}:${i + 1}: case ${value.id} is there twice`); return; }
    seen.add(value.id);
    out.push({ id: value.id, input: value.input, ...('note' in value ? { note: value.note } : {}) });
  });
  return out;
}

// Records the source program's answers: { ok, count, problems, summary }.
// Nothing is written unless every request was answered: half a recording
// would pass for the whole.
export async function record(opts, { cwd = process.cwd(), send = fetch, env = process.env } = {}) {
  const problems = [];
  const file = path.resolve(cwd, opts.inputs);
  let text = null;
  try {
    const bytes = fs.readFileSync(file);
    if ((bytes[0] === 0xff && bytes[1] === 0xfe) || (bytes[0] === 0xfe && bytes[1] === 0xff)) problems.push(`${opts.inputs} is UTF-16; write it as UTF-8`);
    else text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch (error) { problems.push(error.code === 'ENOENT' ? `the inputs file ${opts.inputs} does not exist` : `${opts.inputs} is not UTF-8; write it as UTF-8`); }
  const out = path.resolve(cwd, opts.out);
  if (out === file) problems.push('--out is the inputs file; keep the inputs outside the cases folder');
  const inputs = text === null ? [] : readInputs(text, opts.inputs, problems);
  if (text !== null && inputs.length === 0 && problems.length === 0) problems.push(`${opts.inputs} holds no requests`);
  if (problems.length) return { ok: false, count: 0, problems };
  const ran = await exchange(inputs.map((c) => ({ ...c, file: opts.out })), { base: opts.url, charset: opts.charset ?? 'utf-8', env, requestMs: Number(opts.seconds ?? 30) * 1000, send });
  if (ran.problems.length) return { ok: false, count: ran.outputs.size, problems: ran.problems };
  const lines = inputs.map((c) => JSON.stringify({ id: c.id, ...('note' in c ? { note: c.note } : {}), input: c.input, expected: ran.outputs.get(c.id) }));
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, `${lines.join('\n')}\n`);
  const statuses = new Map();
  for (const r of ran.outputs.values()) statuses.set(r.status, (statuses.get(r.status) ?? 0) + 1);
  const hasBody = (input) => ['form', 'json', 'body'].some((k) => input[k] !== undefined) || Boolean(input.hidden);
  const writes = inputs.filter((c) => !/^(GET|HEAD)$/i.test(typeof c.input.method === 'string' ? c.input.method : hasBody(c.input) ? 'POST' : 'GET')).length;
  return { ok: true, count: inputs.length, problems: [], summary: `recorded ${inputs.length} cases from ${opts.url.origin} to ${opts.out} (${[...statuses].sort((a, b) => a[0] - b[0]).map(([s, n]) => `${s} x${n}`).join(', ')}; ${writes} request${writes === 1 ? '' : 's'} other than GET)` };
}

export async function main(argv) {
  const usage = () => { console.error('Usage: node http.mjs record --base URL --inputs FILE --out FILE [--charset NAME] [--allow-host HOST] [--request-seconds N]'); return 2; };
  if (argv[0] !== 'record') return usage();
  const opts = parseHttpOptions(argv.slice(1), 'record');
  if (opts.problem) { console.error(`http: ${opts.problem}`); return usage(); }
  const result = await record(opts);
  for (const p of result.problems) console.error(`http: ${p}`);
  if (result.ok) console.log(`http: ${result.summary}`);
  else console.error(`http: nothing was written (${result.count} of the requests were answered)`);
  return result.ok ? 0 : 1;
}

function invokedDirectly() {
  if (!process.argv[1]) return false;
  try { return fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url)); } catch { return false; }
}

if (invokedDirectly()) Promise.resolve(main(process.argv.slice(2))).then((code) => { process.exitCode = code; });
