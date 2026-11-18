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
//                       (__VIEWSTATE, a CSRF token), each side its own
//   "session": "clerk"  requests with the same name share cookies (default "default") }
// `${env:NAME}` in a string is replaced by that environment variable when the
// request is sent; the case keeps the placeholder, so a password never reaches
// a file. Each case file starts signed out: signing in is a request like any other.
//
// A response: { "status": 200, "redirect": "/login.php", "type": "text/html",
//   "title": "...", "text": ["each block of visible text", ...],
//   "fields": { "name": "value" } }   for HTML;
//   "json": <any> for JSON; "body": "<text>" for other text (CSV, XML);
//   "bytes": { "length", "sha256" } for anything else; "filename" of a download.
// Markup, styles, scripts, hidden fields and cookies are left out: the two
// systems may differ there. What a user reads and what a form holds stays.
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
  if (url.username || url.password) return { problem: '--base holds a user name or password; sign in with a request whose values come from ${env:NAME}' };
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
  try { name = new TextDecoder(label).encoding; } catch { return null; }
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
  for (const lead of double) for (let b = trail[0]; b <= trail[1]; b += 1) put([lead, b]);
  if (name === 'euc-jp') for (let b = 0xa1; b <= 0xdf; b += 1) put([0x8e, b]);
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

function decodeText(bytes, label) {
  try { return new TextDecoder(label).decode(bytes); } catch { return new TextDecoder('utf-8').decode(bytes); }
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

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', yen: '¥', copy: '©', reg: '®', laquo: '«', raquo: '»', middot: '·', hellip: '…', mdash: '—', ndash: '–', times: '×', deg: '°' };
const unescape = (s) => s.replace(/&(#x[0-9a-f]+|#\d+|[a-z][a-z0-9]*);/gi, (whole, name) => {
  if (name[0] !== '#') return ENTITIES[name.toLowerCase()] ?? whole;
  const code = name[1].toLowerCase() === 'x' ? parseInt(name.slice(2), 16) : Number(name.slice(1));
  try { return String.fromCodePoint(code); } catch { return whole; }
});
const clean = (s) => unescape(s).replace(/\s+/g, ' ').trim();

const TAG = /<(\/?)([a-zA-Z][\w:-]*)((?:[^>"']|"[^"]*"|'[^']*')*)>/g;
const ATTRIBUTE = /([^\s"'=<>/]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;
// Tags that start a new block of text. Inline tags (a, b, span, label...) do not.
const BLOCK = new Set(['address', 'article', 'aside', 'blockquote', 'body', 'br', 'button', 'caption', 'center', 'dd', 'details', 'dialog', 'div', 'dl', 'dt', 'fieldset', 'figcaption', 'figure', 'footer', 'form', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'head', 'header', 'hr', 'html', 'legend', 'li', 'main', 'menu', 'nav', 'ol', 'optgroup', 'option', 'p', 'pre', 'section', 'select', 'summary', 'table', 'tbody', 'td', 'textarea', 'tfoot', 'th', 'thead', 'title', 'tr', 'ul']);

function attributes(raw) {
  const out = {};
  for (const m of raw.matchAll(ATTRIBUTE)) {
    const key = m[1].toLowerCase();
    if (!(key in out)) out[key] = unescape(m[2] ?? m[3] ?? m[4] ?? '');
  }
  return out;
}

// What a page shows and holds: { title, text, fields, hidden }.
// `text` is the visible text, one entry per block (a paragraph, a table cell, a
// list item, an option, a button); `fields` the form controls by name with the
// value they hold (a checked box or radio button only); `hidden` the hidden
// fields, which are sent back with "hidden": true and never compared.
export function htmlView(html) {
  // Comments, the doctype, CDATA marks and processing instructions are not text; scripts and styles neither.
  const src = html.replace(/<!--[\s\S]*?-->/g, '').replace(/<(script|style|template)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, ' ')
    .replace(/<!\[CDATA\[|\]\]>/g, '').replace(/<![^>]*>|<\?[\s\S]*?\?>/g, '');
  const text = []; const fields = {}; const hidden = {};
  let title = null;
  let buffer = '';
  let pos = 0;
  let raw = null; // { tag, attrs, from }: an element whose content is read as text (title, textarea)
  let select = null; // { name, multiple, chosen: [], first }
  let option = null; // { attrs }
  const flush = () => { const t = clean(buffer); buffer = ''; if (t) text.push(t); return t; };
  const add = (name, value) => {
    if (!name) return;
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
    buffer += src.slice(pos, m.index);
    pos = m.index + whole.length;
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
      if (type === 'hidden') { if (attrs.name) hidden[attrs.name] = attrs.value ?? ''; }
      // The wording of a button is text a user reads, in its own block.
      else if (['submit', 'button', 'reset', 'image'].includes(type)) { flush(); buffer = shown((type === 'image' ? attrs.alt : attrs.value) ?? ''); flush(); }
      else if (type === 'checkbox' || type === 'radio') { if ('checked' in attrs) add(attrs.name, attrs.value ?? 'on'); }
      else if (type !== 'password' && type !== 'file') add(attrs.name, attrs.value ?? '');
      continue;
    }
    if (!BLOCK.has(tag)) continue;
    flush();
    if (closing) { if (tag === 'select') endSelect(); continue; }
    const attrs = attributes(rawAttrs);
    if (tag === 'title' || tag === 'textarea') raw = { tag, attrs, from: pos };
    else if (tag === 'select') { endSelect(); select = { name: attrs.name, multiple: 'multiple' in attrs, chosen: [], first: undefined }; }
    else if (tag === 'option') option = { attrs };
  }
  buffer += src.slice(pos);
  endOption(); flush(); endSelect();
  return { title, text, fields, hidden };
}

// --- requests -------------------------------------------------------------------

// Replaces ${env:NAME} in every string of a value; names without a value go to `missing`.
function fill(value, env, missing) {
  if (typeof value === 'string') return value.replace(/\$\{env:([A-Za-z_][A-Za-z0-9_]*)\}/g, (_, name) => { if (env[name] === undefined) { missing.add(name); return ''; } return env[name]; });
  if (Array.isArray(value)) return value.map((v) => fill(v, env, missing));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, fill(v, env, missing)]));
  return value;
}

const pairsOf = (object, rename = (k) => k) => Object.entries(object).flatMap(([k, v]) => (Array.isArray(v) ? v : [v]).map((one) => [rename(k), one === null || one === undefined ? '' : String(one)]));
const isPlain = (v) => Boolean(v) && typeof v === 'object' && !Array.isArray(v);

// The map of a driver: { paths, fields, back: { paths, fields } }, or { problem }.
export function readMap(text) {
  let raw;
  try { raw = JSON.parse(text); } catch (error) { return { problem: `the map is not JSON: ${error.message}` }; }
  if (!isPlain(raw)) return { problem: 'the map must be one JSON object' };
  const unknown = Object.keys(raw).filter((k) => k !== 'paths' && k !== 'fields');
  if (unknown.length) return { problem: `the map has the unknown key "${unknown[0]}" (keys: paths, fields)` };
  const out = { paths: {}, fields: {}, back: { paths: {}, fields: {} } };
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

const NO_MAP = { paths: {}, fields: {}, back: { paths: {}, fields: {} } };

// The request a case asks for, ready to send: { url, method, headers, body }, or { problem }.
export function buildRequest(input, { base, session, env = process.env, encode = encoderFor('utf-8'), map = NO_MAP }) {
  if (!isPlain(input)) return { problem: 'the input is not a request object' };
  const known = ['method', 'path', 'query', 'headers', 'form', 'json', 'body', 'contentType', 'hidden', 'session', 'note'];
  const unknown = Object.keys(input).filter((k) => !known.includes(k));
  if (unknown.length) return { problem: `the request has the unknown key "${unknown[0]}" (keys: ${known.slice(0, -1).join(', ')})` };
  if (typeof input.path !== 'string' || !/^\/(?!\/)/.test(input.path)) return { problem: 'the request needs a "path" that starts with one / (the address comes from --base)' };
  for (const key of ['query', 'headers', 'form']) if (input[key] !== undefined && !isPlain(input[key])) return { problem: `the request's "${key}" must be an object` };
  const bodies = ['form', 'json', 'body'].filter((k) => input[k] !== undefined);
  if (bodies.length > 1) return { problem: `the request has ${bodies.join(' and ')}; give one body` };
  if (input.hidden !== undefined && typeof input.hidden !== 'boolean') return { problem: 'the request\'s "hidden" must be true or false' };
  if (input.hidden && input.json !== undefined) return { problem: '"hidden": true goes with "form" (the hidden fields are form fields)' };
  const missing = new Set();
  const filled = fill({ path: input.path, query: input.query ?? {}, headers: input.headers ?? {}, form: input.form, json: input.json, body: input.body }, env, missing);
  if (missing.size) return { problem: `the environment variable ${[...missing].join(', ')} is not set (the person sets it; never write its value into a file)` };
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
      const carried = input.hidden ? Object.entries(session.hidden).filter(([k]) => !names.has(k)) : [];
      body = Buffer.from(formEncode([...carried, ...given], encode), 'latin1');
      headers['content-type'] = 'application/x-www-form-urlencoded';
    } else if (input.json !== undefined) {
      body = Buffer.from(JSON.stringify(filled.json), 'utf8');
      headers['content-type'] = 'application/json';
    } else if (input.body !== undefined) {
      if (typeof filled.body !== 'string') return { problem: 'the request\'s "body" must be a string' };
      body = encode(filled.body);
      headers['content-type'] = typeof input.contentType === 'string' ? input.contentType : 'text/plain';
    }
  } catch (error) { return { problem: error.message }; }
  for (const [k, v] of Object.entries(filled.headers)) headers[k.toLowerCase()] = String(v);
  if (session.cookies.size) headers.cookie = [...session.cookies].map(([k, v]) => `${k}=${v}`).join('; ');
  const method = typeof input.method === 'string' ? input.method.toUpperCase() : body ? 'POST' : 'GET';
  if (!/^[A-Z]+$/.test(method)) return { problem: `the method ${input.method} is not an HTTP method` };
  if (body && (method === 'GET' || method === 'HEAD')) return { problem: `a ${method} request cannot carry a body; put the values in "query"` };
  return { url, method, headers, body };
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
  const read = () => decodeText(bytes, named ?? sniffed ?? charset);
  if (html) {
    const view = htmlView(read());
    if (session) session.hidden = view.hidden;
    // An empty title shows nothing, like no title.
    if (view.title) out.title = view.title;
    out.text = view.text;
    out.fields = Object.fromEntries(Object.entries(view.fields).map(([k, v]) => [map.back.fields[k] ?? k, v]));
  } else if (type === 'application/json' || type.endsWith('+json')) {
    const text = read();
    try { out.json = JSON.parse(text); } catch { out.body = text.replace(/\r\n?/g, '\n'); }
  } else if (textual(type)) out.body = read().replace(/^﻿/, '').replace(/\r\n?/g, '\n');
  else out.bytes = { length: bytes.length, sha256: crypto.createHash('sha256').update(bytes).digest('hex') };
  return out;
}

// --- running --------------------------------------------------------------------

const newSession = () => ({ cookies: new Map(), hidden: {} });

// Sends the requests of the cases in order: { outputs: Map<id, response>, problems }.
// It stops at the first request that gets no answer. Cases of one file share
// their sessions; the next file starts signed out again.
export async function exchange(cases, { base, charset = 'utf-8', map = NO_MAP, env = process.env, requestMs = 30000, deadline = Infinity, send = fetch }) {
  const outputs = new Map();
  const problems = [];
  const encode = encoderFor(charset);
  // Nothing is sent while a request cannot be built: with the sign-in left out
  // (a variable that is not set), the requests after it would act signed out.
  for (const c of cases) {
    const request = buildRequest(c.input, { base, session: newSession(), env, encode, map });
    if (request.problem) problems.push(`case ${c.id}: ${request.problem}`);
  }
  if (problems.length) { problems.push('no request was sent'); return { outputs, problems }; }
  let sessions = new Map();
  let file;
  for (const c of cases) {
    if (c.file !== file) { sessions = new Map(); file = c.file; }
    const name = isPlain(c.input) && typeof c.input.session === 'string' && c.input.session ? c.input.session : 'default';
    if (!sessions.has(name)) sessions.set(name, newSession());
    const session = sessions.get(name);
    const request = buildRequest(c.input, { base, session, env, encode, map });
    if (request.problem) { problems.push(`case ${c.id}: ${request.problem}`); continue; }
    if (Date.now() > deadline) { problems.push(`case ${c.id}: the run's time limit passed; this request and the ones after it were not sent`); break; }
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
    outputs.set(c.id, viewResponse({ status: response.status, headers: response.headers, bytes, requestUrl: request.url }, { base, charset, map, session }));
  }
  return { outputs, problems };
}

const sleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });

// Whether anything answers at the URL (any status counts: it is listening).
async function answers(url, send = fetch) {
  try { const r = await send(url, { redirect: 'manual', signal: AbortSignal.timeout(2000) }); await r.arrayBuffer().catch(() => {}); return true; } catch { return false; }
}

// Starts the new system with its command and waits until it answers:
// { stop, tail } or { problem, output }. Something that already answers would
// be code from an earlier run, not the code as it is now, so that is a problem.
export async function startSystem(command, cwd, base, { waitMs = 60000, platform = process.platform, send = fetch } = {}) {
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
    for (let k = 0; k < 25 && await answers(base, send); k += 1) await sleep(200);
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
// requests. { outputs, problems, output } for compare.mjs.
export async function runHttpDriver(argv, cases, cwd, { timeoutMs, send = fetch, env = process.env, platform = process.platform } = {}) {
  const deadline = timeoutMs ? Date.now() + timeoutMs : Infinity;
  const opts = parseHttpOptions(argv, 'driver');
  if (opts.problem) return { outputs: new Map(), problems: [`${HTTP_DRIVER}: ${opts.problem}`] };
  let map = NO_MAP;
  if (opts.map) {
    const file = path.resolve(cwd, opts.map);
    const rel = path.relative(cwd, file);
    if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return { outputs: new Map(), problems: [`${HTTP_DRIVER}: the map ${opts.map} is not inside the target root`] };
    let text;
    try { text = fs.readFileSync(file, 'utf8').replace(/^﻿/, ''); } catch { return { outputs: new Map(), problems: [`${HTTP_DRIVER}: the map ${opts.map} does not exist`] }; }
    map = readMap(text);
    if (map.problem) return { outputs: new Map(), problems: [`${HTTP_DRIVER}: ${opts.map}: ${map.problem}`] };
  }
  let system = null;
  if (opts.start) {
    system = await startSystem(opts.start, cwd, opts.url, { waitMs: Number(opts.wait ?? 60) * 1000, platform, send });
    if (system.problem) return { outputs: new Map(), problems: [`${HTTP_DRIVER}: ${system.problem}`], output: system.output };
  }
  try {
    const ran = await exchange(cases, { base: opts.url, charset: opts.charset ?? 'utf-8', map, env, requestMs: Number(opts.seconds ?? 30) * 1000, deadline, send });
    const failed = ran.problems.length > 0;
    if (failed && !opts.start && ran.outputs.size === 0) ran.problems.push(`${HTTP_DRIVER}: nothing was read from ${opts.url.origin}; give --start "<command>" so the run starts the new system itself`);
    return { ...ran, ...(failed && system ? { output: system.tail() } : {}), rules: map === NO_MAP ? [] : [`map ${Object.keys(map.paths).length} paths, ${Object.keys(map.fields).length} fields`] };
  } finally { await system?.stop(); }
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
  const hasBody = (input) => ['form', 'json', 'body'].some((k) => input[k] !== undefined) || input.hidden === true;
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
