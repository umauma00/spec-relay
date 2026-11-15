#!/usr/bin/env node
// The sites of a capability's source files: the places whose behavior a spec
// must cover. A site is a method, function, constructor, property with a body,
// constant, stored procedure, or `(file)`: the lines of a file that are in no
// other site and still do something (old PHP pages and their HTML, scripts,
// top-level statements, field initializers, SQL outside procedures, code the
// scanner did not recognize). A file in a language the scanner does not read,
// such as an .aspx page or a config file, is one `(file)` site.
//
//   node sites.mjs --change extract-<capability> [--per N] [--root DIR]
//
// Writes openspec/spec-relay/work/<change>/sites/<nn>.md, tables of at most N
// sites (default 40) with their lines and markers, so each omission checker gets
// one file, and prints { ok, change, sites, files, parts, problems } as JSON.
// `gate.mjs review` scans again and needs one row per site in coverage.md.
//
// The scanner reads text, not syntax trees: it blanks out comments and string
// literals, follows braces, and takes the declarations it recognizes. Only
// lines it knows do nothing by themselves (using/import lines, type headers,
// field declarations without a value, declarations without a body, closing
// braces) may be in no site; every other line is in a member's site or in
// `(file)`. So unusual code (macros, eval, generated members) makes a site
// coarser, never lost. Markers are lines with words that usually mean an
// observable effect (a database write, an error, a redirect, a mail, the
// current time...). They tell the checker where to look; they prove nothing.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readIf, sourceFiles, archivedChange, tableRows } from './gate.mjs';
import { sourceMapPaths, covers, contextOf, inventoryRows } from './coverage.mjs';

// ---------------------------------------------------------------- reading

// UTF-16 without a byte order mark: ASCII text has a zero in every other byte.
function utf16Order(buffer) {
  const n = Math.min(buffer.length, 4096) & ~1;
  if (n < 4) return null;
  let even = 0; let odd = 0;
  for (let k = 0; k < n; k += 2) { if (buffer[k] === 0) even += 1; if (buffer[k + 1] === 0) odd += 1; }
  const half = n / 2;
  if (odd > half * 0.3 && even < half * 0.05) return 'utf-16le';
  if (even > half * 0.3 && odd < half * 0.05) return 'utf-16be';
  return null;
}

// The text of a file, or null when it is binary. Legacy code in Japan is often
// Shift_JIS; decoding it as UTF-8 would turn the second byte of 「ソ」 (0x5C)
// into a backslash that escapes a closing quote.
export function decode(buffer) {
  if (buffer.length >= 2 && buffer[0] === 0xff && buffer[1] === 0xfe) return new TextDecoder('utf-16le').decode(buffer.subarray(2));
  if (buffer.length >= 2 && buffer[0] === 0xfe && buffer[1] === 0xff) return new TextDecoder('utf-16be').decode(buffer.subarray(2));
  const order = utf16Order(buffer);
  if (order) return new TextDecoder(order).decode(buffer);
  if (buffer.includes(0)) return null;
  for (const encoding of ['utf-8', 'shift_jis', 'euc-jp']) {
    try { return new TextDecoder(encoding, { fatal: true }).decode(buffer).replace(/^﻿/, ''); } catch { /* next */ }
  }
  return new TextDecoder('windows-1252').decode(buffer);
}

// Files that hold no code: images, fonts, media, archives, compiled output.
// Office and database files are not here: they can hold macros and queries, so
// they are one `(file)` site that the checker opens.
const NO_CODE = /\.(png|jpe?g|gif|bmp|ico|webp|tiff?|svgz|pdf|zip|gz|tgz|7z|rar|jar|war|ear|dll|exe|pdb|so|dylib|class|o|obj|lib|a|nupkg|ttf|otf|woff2?|eot|mp3|mp4|wav|avi|mov|wmv|swf|fla|psd|snk|pfx|p12|cer)$/i;

const LANGS = [
  [/\.(cs|csx)$/i, 'csharp'],
  [/\.java$/i, 'java'],
  [/\.vb$/i, 'vb'],
  [/\.(php\d?|phtml|inc)$/i, 'php'],
  [/\.(js|mjs|cjs|jsx|ts|tsx|mts|cts)$/i, 'js'],
  [/\.sql$/i, 'sql'],
];
export const languageOf = (file) => LANGS.find(([re]) => re.test(file))?.[1] ?? 'text';

// ---------------------------------------------------------------- masking

const CS_IF = { open: /^\s*#\s*if\b/, alt: /^\s*#\s*(elif|else)\b/, close: /^\s*#\s*endif\b/ };
const VB_IF = { open: /^\s*#\s*If\b/i, alt: /^\s*#\s*(ElseIf|Else)\b/i, close: /^\s*#\s*End\s+If\b/i };
const VB_DIRECTIVE = /^\s*#\s*(If|ElseIf|Else|End|Region|Const|ExternalSource|Disable|Enable)\b/i;

// Two copies of the text with the same length and newlines: `code` with
// comments, string literals and (in PHP) inline HTML blanked, and `plain` with
// only comments blanked (markers look there, since SQL lives in strings).
// `html` holds the offsets of PHP's inline HTML, and `hidden` the lines of
// `#else` and `#elif` branches, which are blanked in `code` so their braces do
// not count twice.
export function mask(text, lang) {
  const code = text.split('');
  const plain = text.split('');
  const n = text.length;
  let htmlChars = 0;
  const html = [];
  const hidden = new Set();
  const blank = (from, to, both) => {
    for (let k = from; k < to && k < n; k += 1) {
      if (text[k] === '\n' || text[k] === '\r') continue;
      code[k] = ' ';
      if (both) plain[k] = ' ';
    }
  };
  const lineEnd = (k) => { const e = text.indexOf('\n', k); return e < 0 ? n : e; };
  // A quoted string from `i` (the opening quote); returns the offset after it.
  const quoted = (i, quote, { escapes = true, doubled = false, holes = null } = {}) => {
    let k = i + 1;
    let depth = 0;
    while (k < n) {
      const ch = text[k];
      if (holes === '{' && depth === 0 && text[k] === '{' && text[k + 1] === '{') { k += 2; continue; } // C# {{ is a brace character
      if (holes && depth === 0 && text.startsWith(holes, k)) { depth = 1; k += holes.length; continue; }
      if (depth > 0) {
        if (ch === '{') depth += 1;
        else if (ch === '}') depth -= 1;
        else if (ch === '"' || ch === "'") { k = quoted(k, ch); continue; }
        k += 1; continue;
      }
      if (escapes && ch === '\\') { k += 2; continue; }
      if (ch === quote) {
        if (doubled && text[k + 1] === quote) { k += 2; continue; }
        return k + 1;
      }
      if (ch === '\n' && quote === "'" && lang !== 'php' && lang !== 'sql') return k; // an unclosed char literal ends at the line
      k += 1;
    }
    return n;
  };
  let i = 0;
  let inPhp = lang !== 'php';
  let prev = ''; // last significant code character, for JavaScript regex literals
  while (i < n) {
    if (lang === 'php' && !inPhp) {
      const open = text.slice(i).search(/<\?(php\b|=)?/i);
      const end = open < 0 ? n : i + open;
      for (let k = i; k < end; k += 1) if (!/\s/.test(text[k])) htmlChars += 1;
      html.push([i, end]);
      blank(i, end, false);
      if (open < 0) break;
      const tag = text.slice(end).match(/^<\?(php\b|=)?/i)[0];
      blank(end, end + tag.length, true);
      i = end + tag.length;
      inPhp = true;
      continue;
    }
    const ch = text[i];
    const next = text[i + 1];
    if (lang === 'php' && ch === '?' && next === '>') { blank(i, i + 2, true); i += 2; inPhp = false; continue; }
    // Line comments. PHP's end at ?> too.
    const lineComment = (ch === '/' && next === '/' && lang !== 'vb' && lang !== 'sql')
      || (ch === '#' && lang === 'php' && next !== '[')
      || (ch === '-' && next === '-' && lang === 'sql')
      || (ch === "'" && lang === 'vb')
      || (ch === '#' && lang === 'csharp' && /(^|\n)[ \t]*$/.test(text.slice(Math.max(0, i - 200), i))) // #if, #region
      || (lang === 'vb' && /^rem\b/i.test(text.slice(i, i + 4)) && /(^|[\s:])$/.test(text.slice(Math.max(0, i - 1), i)));
    if (lineComment) {
      let end = lineEnd(i);
      if (lang === 'php') { const close = text.slice(i, end).indexOf('?>'); if (close >= 0) end = i + close; }
      blank(i, end, true); i = end; continue;
    }
    if (ch === '/' && next === '*' && lang !== 'vb') {
      const close = text.indexOf('*/', i + 2);
      const end = close < 0 ? n : close + 2;
      blank(i, end, true); i = end; continue;
    }
    let end = -1;
    const raw = lang === 'csharp' && (ch === '"' || ch === '$') ? /^\$*("{3,})/.exec(text.slice(i, i + 40)) : null;
    if (lang === 'csharp' && ch === '@' && next === '"') end = quoted(i + 1, '"', { escapes: false, doubled: true });
    else if (raw) {
      // C# 11 raw string: """...""" (or more quotes), maybe interpolated with $.
      const close = text.indexOf(raw[1], i + raw[0].length);
      end = close < 0 ? n : close + raw[1].length;
      while (end < n && text[end] === '"') end += 1;
    } else if (lang === 'csharp' && ch === '$' && (next === '"' || (next === '@' && text[i + 2] === '"'))) {
      const verbatim = next === '@';
      end = quoted(i + (verbatim ? 2 : 1), '"', { escapes: !verbatim, doubled: verbatim, holes: '{' });
    } else if (lang === 'csharp' && ch === '@' && next === '$' && text[i + 2] === '"') end = quoted(i + 2, '"', { escapes: false, doubled: true, holes: '{' });
    else if (ch === '"') {
      if (lang === 'vb' || lang === 'sql') end = quoted(i, '"', { escapes: false, doubled: true });
      else end = quoted(i, '"', { holes: lang === 'php' ? '{$' : null });
    } else if (ch === "'" && lang !== 'vb') end = quoted(i, "'", lang === 'sql' ? { escapes: false, doubled: true } : {});
    else if (ch === '`' && lang === 'js') end = quoted(i, '`', { holes: '${' });
    else if (lang === 'php' && ch === '<' && text.startsWith('<<<', i)) {
      const m = text.slice(i).match(/^<<<[ \t]*(["']?)([A-Za-z_]\w*)\1\r?\n/);
      if (m) {
        const close = new RegExp(`^[ \\t]*${m[2]}\\b`, 'm');
        const rest = text.slice(i + m[0].length);
        const at = rest.search(close);
        end = at < 0 ? n : i + m[0].length + at + rest.slice(at).match(close)[0].length;
      }
    } else if (lang === 'js' && ch === '/' && /^$|[(,=:[!&|?{};+\-*%<>~^]$/.test(prev)) {
      // A regex literal: up to the next unescaped / outside a class, on the same line.
      let k = i + 1; let inClass = false;
      while (k < n && text[k] !== '\n') {
        if (text[k] === '\\') { k += 2; continue; }
        if (text[k] === '[') inClass = true; else if (text[k] === ']') inClass = false;
        else if (text[k] === '/' && !inClass) break;
        k += 1;
      }
      if (text[k] === '/') end = k + 1;
    }
    if (end > i) {
      // Strings are blanked in the code copy only; their quotes stay, so the
      // structure around them still reads.
      blank(i + 1, end - 1, false);
      prev = '"';
      i = end; continue;
    }
    if (!/\s/.test(ch)) prev = ch;
    i += 1;
  }
  // Conditional compilation: only the first branch is read as structure; the
  // others are blanked in `code`, and their lines are kept as `hidden`.
  if (lang === 'csharp' || lang === 'vb') {
    const re = lang === 'csharp' ? CS_IF : VB_IF;
    const branches = [];
    let offset = 0;
    for (const [index, line] of text.split('\n').entries()) {
      if (lang === 'vb' && VB_DIRECTIVE.test(line)) blank(offset, offset + line.length, true);
      if (re.open.test(line)) branches.push(false);
      else if (re.alt.test(line)) { if (branches.length) branches[branches.length - 1] = true; }
      else if (re.close.test(line)) branches.pop();
      else if (branches.some(Boolean)) {
        if (plain.slice(offset, offset + line.length).join('').trim()) hidden.add(index + 1);
        blank(offset, offset + line.length, false);
      }
      offset += line.length + 1;
    }
  }
  return { code: code.join(''), plain: plain.join(''), htmlChars, html, hidden };
}

// ---------------------------------------------------------------- markers

const MARKERS = [
  ['db-write', /\b(insert\s+into|update\s+[\w.[\]"`]+\s+set|delete\s+from|merge\s+into|truncate\s+table)\b|ExecuteNonQuery|SaveChanges|SqlBulkCopy|BulkInsert|->exec\s*\(|mysqli?_query|pg_query|sqlsrv_query|odbc_exec|oci_execute/i],
  ['db-read', /\bselect\b[\s\S]*?\bfrom\b|ExecuteReader|ExecuteScalar|\.Fill\s*\(|->query\s*\(|->fetch|mysqli?_fetch|pg_fetch|sqlsrv_fetch/i],
  ['transaction', /BeginTransaction|TransactionScope|beginTransaction|\bcommit\b|\brollback\b|mysqli_autocommit/i],
  ['error', /\bthrow\b|\bcatch\b|trigger_error|set_error_handler|\bOn\s+Error\b|Err\.Raise|\bRAISERROR\b|\bTHROW\b/i],
  ['exit', /\bdie\s*\(|\bexit\s*[(;]|Response\.End\s*\(|Environment\.Exit|Application\.Exit/],
  ['redirect', /Response\.Redirect|Server\.Transfer|RedirectToAction|\bRedirect\s*\(|header\s*\(\s*["']\s*Location|location\.href\s*=|window\.location/i],
  ['mail', /SmtpClient|MailMessage|\bmail\s*\(|PHPMailer|mb_send_mail|Swift_Mailer/],
  ['file', /File\.(Write|Append|Delete|Move|Copy|Create|Open)|StreamWriter|FileStream|Directory\.(Create|Delete|Move)|file_put_contents|\bfwrite\s*\(|\bfputcsv\s*\(|\bunlink\s*\(|\brename\s*\(|move_uploaded_file|\bmkdir\s*\(|\bfopen\s*\(/],
  ['session', /Session\s*\[|HttpContext\.Session|\$_SESSION|session_start|setcookie|Response\.Cookies|Request\.Cookies|\$_COOKIE|document\.cookie|localStorage|sessionStorage/],
  ['input', /\$_(GET|POST|REQUEST|FILES|SERVER)\b|Request\.(Form|QueryString|Params|Files)\b|Request\s*\[|\bFromBody\b|\bFromQuery\b/],
  ['config', /ConfigurationManager|AppSettings|ConnectionStrings|Environment\.GetEnvironmentVariable|IConfiguration|\bgetenv\s*\(|\$_ENV|\bini_get\s*\(|\bdefine\s*\(/],
  ['time', /DateTime\.(Now|Today|UtcNow)|DateTimeOffset\.(Now|UtcNow)|\bdate\s*\(|\btime\s*\(\s*\)|\bmktime\s*\(|\bstrtotime\s*\(|\bnew\s+Date\s*\(|\bGETDATE\s*\(|\bSYSDATE\b|CURRENT_TIMESTAMP|\bNOW\s*\(\s*\)/i],
  ['rounding', /Math\.(Round|Floor|Ceiling|Truncate)|Math\.(round|floor|ceil|trunc)\b|\bround\s*\(|\bfloor\s*\(|\bceil\s*\(|\bintval\s*\(|number_format|\bbcadd|\bbcmul|\bbcdiv|toFixed\s*\(|Decimal\.Round|\bROUND\s*\(|\bCInt\s*\(|\bFix\s*\(|\bInt\s*\(/],
  ['external', /HttpClient|WebClient|WebRequest|curl_exec|SoapClient|Process\.Start|shell_exec|\bexec\s*\(|\bsystem\s*\(|\bpassthru\s*\(|\bproc_open\s*\(|XMLHttpRequest|\bfetch\s*\(|\$\.ajax|\$\.(get|post)\s*\(/],
];

function markersIn(plainLines, lines) {
  const found = [];
  for (const line of lines) {
    const text = plainLines[line - 1] ?? '';
    if (!text.trim()) continue;
    for (const [kind, re] of MARKERS) if (re.test(text)) found.push({ kind, line });
  }
  return found;
}

// ---------------------------------------------------------------- scanning

const lineAt = (starts, offset) => {
  let lo = 0; let hi = starts.length - 1;
  while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (starts[mid] <= offset) lo = mid; else hi = mid - 1; }
  return lo + 1;
};
const lineStarts = (text) => { const out = [0]; for (let i = 0; i < text.length; i += 1) if (text[i] === '\n') out.push(i + 1); return out; };
const range = (from, to) => Array.from({ length: Math.max(0, to - from + 1) }, (_, k) => from + k);

// Words that are never the name of a declaration, compared case-sensitively
// (Add, Get and Remove are ordinary method names).
const RESERVED = new Set(['if', 'else', 'for', 'foreach', 'while', 'do', 'switch', 'case', 'catch', 'try', 'finally', 'using', 'lock', 'fixed', 'return', 'new', 'typeof', 'sizeof', 'nameof', 'default', 'checked', 'unchecked', 'when', 'synchronized', 'function', 'throw', 'await', 'yield', 'elseif', 'base', 'this', 'super', 'goto', 'delete', 'void']);
// The last word before a name that makes it a call or an expression, not a declaration.
const NOT_BEFORE_NAME = /(?:^|[^\w])(new|return|await|throw|yield|else|case|in|is|as|typeof|nameof|sizeof|when|using|lock|fixed|checked|unchecked|goto|out)$/;
// A `=` that assigns (not ==, !=, <=, >= or =>).
const ASSIGN = /(?<![=!<>])=(?![=>])/;
const TYPE = /\b(record\s+(?:class|struct)|class|struct|interface|record|enum|trait)\s+([A-Za-z_]\w*)/;
// Modifiers, attributes and annotations before a type keyword.
const LEAD = /(?:(?:\[[^\]]*\]|@\w+(?:\([^)]*\))?|\b(?:export|default|declare|abstract|final|public|private|protected|internal|static|sealed|partial|readonly|unsafe|new|file|strictfp|ref|data)\b)\s*)*$/;
// Leading attributes ([HttpPost]) and annotations (@Override) of a member.
const withoutAttributes = (header) => header.trim().replace(/^(?:\[[^\]]*\]\s*)+/, '').replace(/^(?:@\w+(?:\([^)]*\))?\s*)+/, '').trim();
// The text without attributes ([Route("x")]) and annotations (@Table(name = "x")).
const withoutMarks = (text) => text.replace(/\[[^[\]]*(?:\[[^[\]]*\][^[\]]*)*\]/g, ' ').replace(/@\w+(?:\.\w+)*(?:\((?:[^()]|\([^()]*\))*\))?/g, ' ');
const fieldName = (header) => header.split(ASSIGN)[0].match(/([A-Za-z_$][\w$]*)\s*[!?]?\s*(?::[^:]*)?$/)?.[1] ?? null;
const lastWord = (text) => text.match(/([A-Za-z_]\w*)\s*$/)?.[1] ?? null;
const AUTO_ACCESSORS = /^(?:\s*(?:(?:public|private|protected|internal|required)\s+)*(?:get|set|init)\s*;)+\s*$/;
const SIGNIFICANT = /[^\s{}();,]/;

// The name of a method or constructor whose header (masked, ending before `{`
// or `;`) ends in its parameter list, optionally followed by a constructor
// initializer, generic constraints or a throws clause; or null.
export function memberName(header) {
  let h = header.replace(/\s+$/, '');
  h = h.replace(/\s+throws\s+[\w.,\s<>]+$/, '').replace(/\)\s*where\s[\s\S]*$/, ')');
  for (let pass = 0; pass < 2; pass += 1) {
    if (!h.endsWith(')')) return null;
    let depth = 0; let k = h.length - 1;
    for (; k >= 0; k -= 1) { if (h[k] === ')') depth += 1; else if (h[k] === '(') { depth -= 1; if (depth === 0) break; } }
    if (k < 0) return null;
    const before = h.slice(0, k).replace(/\s+$/, '');
    const init = before.match(/:\s*(base|this|super)$/);
    if (init && pass === 0) { h = before.slice(0, init.index).replace(/\s+$/, ''); continue; }
    const m = before.match(/(operator\s*[^\s(]+|~?[A-Za-z_]\w*)\s*(<[^<>()]*(?:<[^<>()]*>[^<>()]*)*>)?$/);
    if (!m) return null;
    const name = m[1].startsWith('operator') ? m[1].replace(/^operator\s*/, 'operator ') : m[1];
    if (RESERVED.has(name)) return null;
    // A call or a lambda is not a declaration: what is before a declaration's
    // name (modifiers, a return type) has no `=` and does not end in `new`.
    const prefix = before.slice(0, m.index).trimEnd();
    if (/=/.test(prefix) || NOT_BEFORE_NAME.test(prefix) || /\.$/.test(prefix)) return null;
    return name;
  }
  return null;
}

// The name of a constant field (const, static readonly, static final) whose
// header ends in its initializer, or null. Constants such as a tax rate or a
// maximum length are behavior; other fields are state, read by the members.
function constantName(header) {
  if (!/\bconst\b|\bstatic\s+readonly\b|\breadonly\s+static\b|\bstatic\s+final\b|\bfinal\s+static\b/.test(header)) return null;
  return fieldName(header);
}

// Claim the header of a type or namespace from its modifiers and attributes.
function claimHeader(claims, headerFrom, header, matchIndex, end) {
  const lead = header.slice(0, matchIndex).match(LEAD);
  claims.push([headerFrom + (lead ? lead.index : matchIndex), end]);
}

const CS_TRIVIAL_ROOT = /^\s*(?:(?:global\s+)?using\s+(?!\(|var\b|await\b)[^;]*|namespace\s+[\w.]+|package\s+[\w.]+|import\s+(?:static\s+)?[\w.*]+|extern\s+alias\s+\w+|\[\s*(?:assembly|module)\s*:[\s\S]*\])\s*$/;

// C#, Java: members of types. Returns { sites, claims }: the members, and the
// offsets of the text that does nothing by itself.
function scanBraces(code) {
  const starts = lineStarts(code);
  const sites = [];
  const claims = [];
  const stack = [{ kind: 'root' }];
  let boundary = 0;
  const top = () => stack[stack.length - 1];
  const typeName = () => stack.filter((f) => f.kind === 'type').map((f) => f.name).join('.');
  const firstCodeLine = (from) => { let k = from; while (k < code.length && /\s/.test(code[k])) k += 1; return lineAt(starts, k); };
  const site = (name, from, to) => sites.push({ symbol: `${typeName()}.${name}`, from, to });
  for (let i = 0; i < code.length; i += 1) {
    const ch = code[i];
    if (ch !== '{' && ch !== '}' && ch !== ';') continue;
    const frame = top();
    // Long headers (generated code) are read from their last 2000 characters.
    const headerFrom = Math.max(boundary, i - 2000);
    const header = code.slice(headerFrom, i);
    if (ch === '{') {
      const type = header.match(TYPE);
      const typeHere = type && !/[=(]/.test(withoutMarks(header.slice(0, type.index)));
      if (frame.kind === 'root' || frame.kind === 'namespace') {
        const ns = header.match(/\bnamespace\s+[\w.]+\s*$/);
        if (ns) { stack.push({ kind: 'namespace' }); claimHeader(claims, headerFrom, header, ns.index, i + 1); }
        else if (typeHere) { stack.push({ kind: 'type', name: type[2], enumHead: /^enum$/.test(type[1]) }); claimHeader(claims, headerFrom, header, type.index, i + 1); }
        else stack.push({ kind: 'block' });
      } else if (frame.kind === 'type') {
        const trimmed = withoutAttributes(header);
        if (frame.pending || frame.enumHead) stack.push({ kind: 'block' });
        else if (typeHere) { stack.push({ kind: 'type', name: type[2], enumHead: /^enum$/.test(type[1]) }); claimHeader(claims, headerFrom, header, type.index, i + 1); }
        else {
          let name = memberName(trimmed);
          if (!name && /\bthis\s*\[[^\]]*\]\s*$/.test(trimmed)) name = 'this[]';
          if (name) stack.push({ kind: 'member', name, from: firstCodeLine(boundary), start: headerFrom, open: i });
          else if (ASSIGN.test(trimmed)) {
            // A field whose value has braces (an array, an object, a lambda): a site named after the field.
            frame.pending = { name: fieldName(trimmed), from: firstCodeLine(boundary) };
            stack.push({ kind: 'block' });
          } else if (/=>/.test(trimmed)) {
            const left = trimmed.split('=>')[0];
            frame.pending = { name: memberName(left) ?? lastWord(left), from: firstCodeLine(boundary) };
            stack.push({ kind: 'block' });
          } else {
            const prop = trimmed.match(/^(?:[\w<>[\],.?\s]+\s)?(?:[A-Za-z_]\w*\.)*([A-Za-z_]\w*)\s*$/);
            if (trimmed === '') name = '(init)';
            else if (trimmed === 'static') name = '(static init)';
            else if (prop && !RESERVED.has(prop[1])) name = prop[1];
            stack.push(name ? { kind: 'member', name, from: firstCodeLine(boundary), start: headerFrom, open: i } : { kind: 'block' });
          }
        }
      } else stack.push({ kind: 'block' });
      boundary = i + 1;
    } else if (ch === '}') {
      const done = stack.length > 1 ? stack.pop() : null;
      if (done?.kind === 'member') {
        // An auto-property ({ get; set; }) holds no behavior; a value after it is (file).
        if (AUTO_ACCESSORS.test(code.slice(done.open + 1, i))) claims.push([done.start, i + 1]);
        else site(done.name, done.from, lineAt(starts, i));
      } else if (done?.kind === 'type' && done.enumHead) claims.push([boundary, i]);
      if (!top().pending) boundary = i + 1;
    } else if (ch === ';') {
      if (frame.kind === 'type') {
        const trimmed = withoutAttributes(header);
        if (frame.pending) {
          if (frame.pending.name) site(frame.pending.name, frame.pending.from, lineAt(starts, i));
          frame.pending = null;
        } else if (frame.enumHead) { claims.push([boundary, i + 1]); frame.enumHead = false; } // Java: the constants end at ;
        else {
          const arrow = trimmed.indexOf('=>');
          const left = arrow > 0 ? trimmed.slice(0, arrow) : '';
          let name = arrow > 0 ? memberName(left) ?? (ASSIGN.test(left) ? null : lastWord(left)) : null;
          if (!name && ASSIGN.test(trimmed) && (constantName(trimmed) || /=>/.test(trimmed.split(ASSIGN).slice(1).join('=')))) name = fieldName(trimmed);
          if (name) site(name, firstCodeLine(boundary), lineAt(starts, i));
          else if (memberName(trimmed) || !/=/.test(trimmed.replace(/[=!<>]=/g, ''))) claims.push([boundary, i + 1]); // a declaration without a body or a value
        }
      } else if (frame.kind === 'root' || frame.kind === 'namespace') {
        const trimmed = withoutAttributes(header);
        if (CS_TRIVIAL_ROOT.test(trimmed) || (/\bdelegate\b|^(?:[\w\s]*\s)?(?:record|interface|class|struct)\s/.test(trimmed) && !ASSIGN.test(trimmed) && !/=>/.test(trimmed))) claims.push([boundary, i + 1]);
      }
      boundary = i + 1;
    }
  }
  return { sites, claims };
}

const JS_TRIVIAL_TOP = /^\s*(?:namespace\s+[\w\\]+|use\s+[^;$]+|declare\s*\([^)]*\)|(?:require|include)(?:_once)?\b[^;$]*|(["'])\s*\1|export\s*(?:type\s*)?\{[^}]*\}(?:\s*from\s*["']\s*["'])?|export\s+\*[^;]*|import(?!\s*\()\b[^;]*|(?:export\s+)?declare\s[^;]*|(?:export\s+)?type\s+[A-Za-z_$][\w$]*[^;]*)\s*$/;
const JS_CLASS_METHOD = /(?:^|[\s;}])(?:(?:public|private|protected|static|async|get|set|readonly|override|abstract)\s+)*(?:\*\s*)?#?([A-Za-z_$][\w$]*)\s*[?!]?\s*(?:<[^(){}]*>)?\s*\([^]*\)\s*(?::\s*[^{};=]*)?$/;
const JS_ARROW_FIELD = /(?:^|[\s;}])(?:(?:public|private|protected|static|readonly|override)\s+)*#?([A-Za-z_$][\w$]*)\s*[!?]?\s*(?::\s*[^=;{}]*)?=\s*(?:async\s*)?(?:<[^(){}]*>\s*)?(?:\([^]*\)|[A-Za-z_$][\w$]*)\s*(?::\s*[^=;{}]*)?=>\s*$/;
const JS_ARROW_CONST = /(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?::\s*[^=;{}]*)?=\s*(?:async\s*)?(?:<[^(){}]*>\s*)?(?:\([^]*\)|[A-Za-z_$][\w$]*)\s*(?::\s*[^=;{}]*)?=>/;

// Import and export lists, and PHP group use, have braces that are not blocks.
const LISTS = /(?<=^|[\n;}])[ \t]*(?:(?:import|export)(?:\s+type)?\s*(?:[\w$]+\s*,?\s*)?(?:\*\s*as\s+[\w$]+\s*)?\{[^{}]*\}\s*(?:from\s*(["'])\s*\1)?\s*;?|use\s+[\w\\]+\\\{[^{}]*\}\s*;)/g;

// PHP and JavaScript/TypeScript: functions and methods. Returns { sites, claims }.
function scanFunctions(text, lang) {
  const claims = [];
  // The braces of import lists are blanked; the lists do nothing by themselves.
  const code = text.replace(LISTS, (list, _q, offset) => {
    claims.push([offset, offset + list.length]);
    return list.replace(/[{}]/g, ' ');
  });
  const starts = lineStarts(code);
  const sites = [];
  const stack = [{ kind: 'root' }];
  let boundary = 0;
  const top = () => stack[stack.length - 1];
  const inFunction = () => stack.some((f) => f.kind === 'function' || f.kind === 'typedef');
  const className = () => stack.filter((f) => f.kind === 'class').map((f) => f.name).join('.');
  const firstCodeLine = (from) => { let k = from; while (k < code.length && /\s/.test(code[k])) k += 1; return lineAt(starts, k); };
  const named = (name) => { const cls = className(); return cls ? `${cls}.${name}` : name; };
  for (let i = 0; i < code.length; i += 1) {
    const ch = code[i];
    if (ch !== '{' && ch !== '}' && ch !== ';') continue;
    const headerFrom = Math.max(boundary, i - 2000);
    const header = code.slice(headerFrom, i);
    const frame = top();
    if (ch === '{') {
      const atTop = !inFunction();
      const type = atTop && header.match(/\b(class|trait|interface|enum)\s+([A-Za-z_$][\w$]*)[^(){};]*$/);
      const typedef = atTop && lang === 'js' && header.match(/(?:^|[\s;}])(?:export\s+)?(?:(?:declare\s+)?type\s+[A-Za-z_$][\w$]*(?:<[^]*>)?\s*=|declare\s+(?:module|global|namespace)\b[^;{}]*)\s*$/);
      const ns = atTop && header.match(/\bnamespace\s+[\w\\.]*\s*$/);
      let fn = null;
      if (atTop && !type && !typedef) {
        const m = header.match(/\bfunction\b\s*&?\s*\*?\s*([A-Za-z_$][\w$]*)\s*(?:<[^(){}]*>)?\s*\([^]*\)\s*(?::\s*[^{};=]*)?$/)
          ?? header.match(/([A-Za-z_$][\w$]*)\s*(?::\s*[^=;{}]*)?[:=]\s*(?:async\s+)?function\b\s*\*?\s*[\w$]*\s*\([^]*\)\s*(?::\s*[^{};=]*)?$/)
          ?? (lang === 'js' ? header.match(new RegExp(`${JS_ARROW_CONST.source}\\s*$`)) : null)
          ?? (lang === 'js' && frame.kind === 'class' ? header.match(JS_ARROW_FIELD) ?? header.match(JS_CLASS_METHOD) : null);
        if (m && !(lang === 'js' && RESERVED.has(m[1]))) fn = m[1];
      }
      if (type && !(lang === 'js' && type[1] === 'enum')) {
        claimHeader(claims, headerFrom, header, type.index, i + 1);
        stack.push({ kind: 'class', name: type[2] });
      } else if (typedef || type) {
        // A TypeScript type, enum or ambient declaration: nothing runs.
        stack.push({ kind: 'typedef', start: headerFrom + (typedef ? typedef.index : header.slice(0, type.index).match(LEAD).index) });
      } else if (fn) {
        stack.push({ kind: 'function', name: named(fn), from: firstCodeLine(boundary) });
      } else {
        if (ns) claimHeader(claims, headerFrom, header, ns.index, i + 1);
        stack.push({ kind: 'block' });
      }
      boundary = i + 1;
    } else if (ch === '}') {
      const done = stack.length > 1 ? stack.pop() : null;
      if (done?.kind === 'function') sites.push({ symbol: done.name, from: done.from, to: lineAt(starts, i) });
      if (done?.kind === 'typedef') claims.push([done.start, i + 1]);
      boundary = i + 1;
    } else if (!inFunction()) {
      if (frame.kind === 'class') {
        // A class constant is behavior (a rate, a limit), and so is a method written as an arrow field.
        const constant = header.match(/^\s*(?:(?:public|private|protected|final|static)\s+)*(?:const|readonly\s+static|static\s+readonly)\s+(?:[\w\\?]+\s+)?([A-Za-z_]\w*)\s*(?::[^=]*)?=/);
        const arrow = lang === 'js' && !constant && header.match(new RegExp(`${JS_ARROW_FIELD.source.replace(/\\s\*\$$/, '')}`));
        if (constant) sites.push({ symbol: named(constant[1]), from: firstCodeLine(boundary), to: lineAt(starts, i) });
        else if (arrow) sites.push({ symbol: named(arrow[1]), from: firstCodeLine(boundary), to: lineAt(starts, i) });
        else if (!ASSIGN.test(header) || /^\s*case\s/.test(header)) claims.push([boundary, i + 1]); // a declaration without a value, an enum case
      } else {
        const arrow = lang === 'js' && header.match(JS_ARROW_CONST);
        if (arrow) sites.push({ symbol: named(arrow[1]), from: firstCodeLine(boundary), to: lineAt(starts, i) });
        else if (JS_TRIVIAL_TOP.test(header)) claims.push([boundary, i + 1]);
      }
      boundary = i + 1;
    } else boundary = i + 1;
  }
  return { sites, claims };
}

// VB.NET: Sub, Function, Property, Operator and Custom Event blocks of classes
// and modules, and Const lines. Returns { sites, trivial }: the members, and
// the lines that do nothing by themselves.
function scanVb(code) {
  const lines = code.split('\n');
  const sites = [];
  const trivial = new Set();
  const types = [];
  const ATTR = '(?:<[^>]*>\\s*_?\\s*)*';
  const MODS = '(?:(?:Public|Private|Protected|Friend|Shared|Overrides|Overridable|NotOverridable|MustOverride|Overloads|Shadows|Async|Partial|Static|ReadOnly|WriteOnly|Default|Iterator|Widening|Narrowing|Custom)\\s+)*';
  const DECL = new RegExp(`^\\s*${ATTR}${MODS}(Sub|Function|Property|Operator|Event)\\s+([\\w[\\]]+|[+\\-*/\\\\&=<>^]+)`, 'i');
  const TYPE_LINE = new RegExp(`^\\s*${ATTR}(?:(?:Public|Private|Protected|Friend|Partial|Shared|MustInherit|NotInheritable|Shadows)\\s+)*(Class|Module|Structure|Interface|Enum)\\s+(\\w+)`, 'i');
  const CONST = new RegExp(`^\\s*${ATTR}(?:(?:Public|Private|Protected|Friend|Shadows)\\s+)*(?:Const|Shared\\s+ReadOnly|ReadOnly\\s+Shared)\\s+(?:(?:Public|Private|Protected|Friend|Shadows)\\s+)*(\\w+)[^=]*=`, 'i');
  const FIELD = new RegExp(`^\\s*${ATTR}(?:(?:Public|Private|Protected|Friend|Shared|ReadOnly|Dim|Static|WithEvents|Shadows)\\s+)+\\w`, 'i');
  const TRIVIAL = /^\s*(?:Imports\b|Option\s+(?:Strict|Explicit|Compare|Infer)\b|Namespace\b|End\s+(?:Namespace|Class|Module|Structure|Interface|Enum)\b|Inherits\b|Implements\b|<\s*(?:Assembly|Module)\s*:)/i;
  const LAMBDA = /\b(Sub|Function)\s*\((?:[^()]|\([^()]*\))*\)\s*(?:As\s+[\w.]+(?:\s*\([^)]*\))?)?\s*$/i;
  const continued = (line) => /\s_\s*$/.test(line);
  const qualified = (name) => `${types.map((t) => t.name).join('.')}${types.length ? '.' : ''}${name}`;
  let open = null;
  let carry = false; // the previous trivial line goes on with ` _`
  for (let k = 0; k < lines.length; k += 1) {
    const line = lines[k];
    if (open) {
      const end = line.match(/^\s*End\s+(Sub|Function|Property|Operator|Event)\b/i);
      const kind = end ? end[1][0].toUpperCase() + end[1].slice(1).toLowerCase() : null;
      if (kind && open.nested[kind] > 0) open.nested[kind] -= 1;
      else if (kind === open.kind) { sites.push({ symbol: open.name, from: open.from, to: k + 1 }); open = null; }
      else if (!kind) { const lambda = line.match(LAMBDA); if (lambda) { const l = lambda[1][0].toUpperCase() + lambda[1].slice(1).toLowerCase(); open.nested[l] = (open.nested[l] ?? 0) + 1; } }
      continue;
    }
    if (carry) { trivial.add(k + 1); carry = continued(line); continue; }
    if (!line.trim()) continue;
    const type = line.match(TYPE_LINE);
    if (type) { types.push({ name: type[2], plain: /interface|enum/i.test(type[1]) }); trivial.add(k + 1); carry = continued(line); continue; }
    if (/^\s*End\s+(Class|Module|Structure|Interface|Enum)\b/i.test(line)) { types.pop(); trivial.add(k + 1); continue; }
    if (types.at(-1)?.plain || TRIVIAL.test(line)) { trivial.add(k + 1); carry = continued(line); continue; } // interface members, enum values
    if (new RegExp(`^\\s*${ATTR}$`).test(line)) { trivial.add(k + 1); continue; } // an attribute on its own line
    const constant = line.match(CONST);
    if (constant) { sites.push({ symbol: qualified(constant[1]), from: k + 1, to: k + 1 }); continue; }
    const decl = line.match(DECL);
    if (decl) {
      const kind = decl[1][0].toUpperCase() + decl[1].slice(1).toLowerCase();
      const bodiless = /\bMustOverride\b|\bDeclare\b/i.test(line) || (kind === 'Event' && !/\bCustom\s+Event\b/i.test(line));
      let hasBody = !bodiless;
      if (hasBody && kind === 'Property') {
        // An auto-property has no End Property before the next declaration.
        hasBody = false;
        for (let j = k + 1; j < lines.length; j += 1) {
          if (/^\s*End\s+Property\b/i.test(lines[j])) { hasBody = true; break; }
          if (DECL.test(lines[j]) || /^\s*End\s+(Class|Module|Structure)\b/i.test(lines[j])) break;
        }
      }
      if (hasBody) { open = { kind, name: qualified(decl[2].replace(/[[\]]/g, '')), from: k + 1, nested: {} }; continue; }
      // A declaration without a body; an auto-property with a value is (file).
      if (!/=/.test(line)) { trivial.add(k + 1); carry = continued(line); }
      continue;
    }
    if (/^\s*Declare\b/i.test(line) || (FIELD.test(line) && !/=|\bNew\b/i.test(line))) { trivial.add(k + 1); carry = continued(line); }
  }
  if (open) sites.push({ symbol: open.name, from: open.from, to: lines.length });
  return { sites, trivial };
}

// SQL: stored procedures, functions, triggers and views. Returns { sites, trivial }.
function scanSql(code) {
  const lines = code.split('\n');
  const sites = [];
  const trivial = new Set();
  let open = null;
  const close = (to) => { if (open) sites.push({ symbol: open.name, from: open.from, to }); open = null; };
  for (let k = 0; k < lines.length; k += 1) {
    const m = lines[k].match(/^\s*(?:CREATE|ALTER)\s+(?:OR\s+(?:REPLACE|ALTER)\s+)?(?:DEFINER\s*=\s*\S+\s+)?(PROC(?:EDURE)?|FUNCTION|TRIGGER|VIEW|PACKAGE(?:\s+BODY)?)\s+([\w.[\]"`]+)/i);
    if (m) { close(k); open = { name: m[2].replace(/[[\]"`]/g, ''), from: k + 1 }; continue; }
    if (/^\s*GO\s*;?\s*$/i.test(lines[k])) { close(k); trivial.add(k + 1); continue; }
    if (!open && /^\s*(?:USE\s|SET\s+(?:ANSI_NULLS|QUOTED_IDENTIFIER|NOCOUNT|ANSI_PADDING|ANSI_WARNINGS|ARITHABORT|CONCAT_NULL_YIELDS_NULL|NUMERIC_ROUNDABORT|XACT_ABORT)\b|DELIMITER\b)/i.test(lines[k])) trivial.add(k + 1);
  }
  let last = lines.length;
  while (last > 1 && !lines[last - 1].trim()) last -= 1;
  close(last);
  return { sites, trivial };
}

// The lines of `code` that are in no site, hold more than punctuation, and are
// neither claimed nor trivial; with `extra` (inline HTML, hidden branches).
function residualLines(code, sites, { claims = [], trivial = null, extra = [] }) {
  const starts = lineStarts(code);
  const total = starts.length;
  const inSite = new Uint8Array(total + 2);
  for (const s of sites) inSite.fill(1, s.from, Math.min(total, s.to) + 1);
  const claimed = new Uint8Array(code.length + 1);
  for (const [a, b] of claims) claimed.fill(1, Math.max(0, a), Math.min(code.length, b));
  const out = new Set();
  for (let l = 1; l <= total; l += 1) {
    if (inSite[l] || trivial?.has(l)) continue;
    const end = l < total ? starts[l] - 1 : code.length;
    for (let k = starts[l - 1]; k < end; k += 1) {
      if (!claimed[k] && SIGNIFICANT.test(code[k])) { out.add(l); break; }
    }
  }
  for (const l of extra) if (l >= 1 && l <= total && !inSite[l]) out.add(l);
  return [...out].sort((a, b) => a - b);
}

// The sites of one file: [{ id, file, symbol, from, to, lines?, markers }].
// `id` is `<path>:<symbol>`, with `#2`, `#3` for overloads in file order.
// `(file)` comes first and lists its `lines`.
export function scanText(text, file) {
  const lang = languageOf(file);
  const normalized = text.replace(/\r\n?/g, '\n');
  const all = normalized.split('\n');
  const fileSite = (lines, extra = {}) => ({ id: `${file}:(file)`, file, symbol: '(file)', from: lines[0] ?? 1, to: lines.at(-1) ?? 1, lines, markers: [], ...extra });
  // Minified or generated one-line code has no members worth reading apart.
  if (all.some((line) => line.length > 5000) || (normalized.length > 20000 && normalized.length / all.length > 300)) {
    return [fileSite(range(1, all.length), { minified: true })];
  }
  const { code, plain, html, hidden } = mask(normalized, lang);
  let found;
  if (lang === 'csharp' || lang === 'java') found = scanBraces(code);
  else if (lang === 'php' || lang === 'js') found = scanFunctions(code, lang);
  else if (lang === 'vb') found = scanVb(code);
  else if (lang === 'sql') found = scanSql(code);
  else found = { sites: [] };
  const starts = lineStarts(normalized);
  const extra = [...hidden];
  for (const [a, b] of html) {
    for (let k = a; k < b; k += 1) if (!/\s/.test(normalized[k])) extra.push(lineAt(starts, k));
  }
  const rest = residualLines(lang === 'text' ? normalized : code, found.sites, { ...found, extra });
  const plainLines = (lang === 'text' ? normalized : plain).split('\n');
  const seen = new Map();
  const sites = found.sites.sort((a, b) => a.from - b.from || a.to - b.to).map((s) => {
    const count = (seen.get(s.symbol) ?? 0) + 1;
    seen.set(s.symbol, count);
    const symbol = count === 1 ? s.symbol : `${s.symbol}#${count}`;
    return { id: `${file}:${symbol}`, file, symbol, from: s.from, to: s.to, markers: markersIn(plainLines, range(s.from, s.to)) };
  });
  if (rest.length) sites.unshift({ ...fileSite(rest), markers: markersIn(plainLines, rest) });
  return sites;
}

export function scanFile(root, file) {
  if (NO_CODE.test(file)) return [];
  let buffer;
  try { buffer = fs.readFileSync(path.join(root, file)); } catch { return []; }
  const text = decode(buffer);
  if (text === null) return [{ id: `${file}:(file)`, file, symbol: '(file)', from: 1, to: 1, lines: [], markers: [], binary: true }];
  return scanText(text, file);
}

// ---------------------------------------------------------------- a change

// The kept source files a change's source map names (a folder row stands for
// the files below it), in path order.
export function changeFiles(root, dir) {
  const listed = sourceMapPaths(readIf(path.join(dir, 'source-map.md'), []) ?? '', root);
  const all = sourceFiles(root) ?? [];
  const survey = archivedChange(root, 'survey');
  const inventory = survey ? inventoryRows(readIf(path.join(survey, 'inventory.md'), []) ?? '') : [];
  return all.filter((file) => listed.some((p) => covers(p, file)) && contextOf(inventory, file) !== 'excluded');
}

export function changeSites(root, dir) {
  return changeFiles(root, dir).flatMap((file) => scanFile(root, file));
}

const cell = (s) => String(s).replace(/\|/g, '\\|');
export const markerText = (markers) => {
  const byKind = new Map();
  for (const m of markers) byKind.set(m.kind, [...(byKind.get(m.kind) ?? []), m.line]);
  return [...byKind].map(([kind, lines]) => `${kind} ${lines.join(',')}`).join('; ');
};

// The lines of a site as ranges: `3-5, 9, 12-40`.
export function lineText(site) {
  if (site.binary) return 'binary';
  if (!site.lines) return `${site.from}-${site.to}`;
  const parts = [];
  for (let k = 0; k < site.lines.length; k += 1) {
    let j = k;
    while (j + 1 < site.lines.length && site.lines[j + 1] === site.lines[j] + 1) j += 1;
    parts.push(j === k ? `${site.lines[k]}` : `${site.lines[k]}-${site.lines[j]}`);
    k = j;
  }
  return parts.join(', ');
}

// ---------------------------------------------------------------- the ledger

// Rows are matched by site id: the path ignores letter case (Windows), the
// symbol does not (Total and total are two methods).
const ledgerKey = (text) => {
  const id = text.replace(/<!--[\s\S]*?-->/g, '').trim().replace(/^`(.*)`$/, '$1').trim().replace(/\\\|/g, '|').replace(/\\/g, '/');
  const colon = id.indexOf(':');
  return colon < 0 ? id.toLowerCase() : `${id.slice(0, colon).toLowerCase()}${id.slice(colon)}`;
};

// One verdict cell: { kind, refs, capability, question } or { kind: 'invalid' }.
// A short note after the verdict, in parentheses or after a colon or dash, is
// allowed for "no behavior", "gap" and "question".
export function parseVerdict(text) {
  const v = text.replace(/<!--[\s\S]*?-->/g, '').replace(/[*_`]/g, '').trim().replace(/[.。]$/, '').trim();
  const NOTE = '(?:\\s*(?:\\(.*\\)|[:：—–-]\\s.*))?$';
  let m = v.match(/^covered\s*:?\s*(.+)$/i);
  if (m) {
    const tokens = m[1].replace(/\s*\([^)]*\)\s*$/, '').split(/[\s,、;/]+|\band\b/i).filter(Boolean);
    const refs = [];
    for (const token of tokens) {
      const one = token.match(/^([RS])0*(\d+)$/i);
      const span = token.match(/^([RS])0*(\d+)[-–~〜]([RS])?0*(\d+)$/i);
      if (one) refs.push(`${one[1].toUpperCase()}${one[2]}`);
      else if (span && (!span[3] || span[3].toUpperCase() === span[1].toUpperCase()) && Number(span[2]) <= Number(span[4]) && Number(span[4]) - Number(span[2]) <= 200) {
        for (let k = Number(span[2]); k <= Number(span[4]); k += 1) refs.push(`${span[1].toUpperCase()}${k}`);
      } else return { kind: 'invalid' };
    }
    return refs.length ? { kind: 'covered', refs } : { kind: 'invalid' };
  }
  if (new RegExp(`^no[\\s-]+behaviou?r${NOTE}`, 'i').test(v)) return { kind: 'no-behavior' };
  m = v.match(/^other[\s-]+capability\s*:?\s*([a-z0-9]+(?:-[a-z0-9]+)*(?:\/[a-z0-9]+(?:-[a-z0-9]+)*)+)$/i);
  if (m) return { kind: 'other', capability: m[1].toLowerCase() };
  m = v.match(new RegExp(`^question\\s*:?\\s*Q0*(\\d+)${NOTE}`, 'i'));
  if (m) return { kind: 'question', question: `Q${Number(m[1])}` };
  if (new RegExp(`^gap${NOTE}`, 'i').test(v)) return { kind: 'gap' };
  return { kind: v ? 'invalid' : 'blank' };
}

// The ledger of an extract change: every site the scanner finds now in the
// files of its source map, with the row coverage.md gives it.
export function readLedger(root, dir, problems = []) {
  const files = changeFiles(root, dir);
  const sites = files.flatMap((file) => scanFile(root, file));
  const text = readIf(path.join(dir, 'coverage.md'), problems);
  const rows = new Map();
  const duplicates = new Set();
  for (const [site = '', verdict = '', evidence = ''] of tableRows(text ?? '')) {
    const key = ledgerKey(site);
    if (!key) continue;
    if (rows.has(key)) duplicates.add(key);
    rows.set(key, { site, verdict, evidence, parsed: parseVerdict(verdict) });
  }
  return { text, files, sites, rows, duplicates };
}

const NO_FILES = 'source-map.md names no kept source file, so the omission check has nothing to scan: check its Source files table';

function capped(problems, list, say, max = 20) {
  for (const item of list.slice(0, max)) problems.push(say(item));
  if (list.length > max) problems.push(`...and ${list.length - max} more`);
}

// Extract review: one row per site with a verdict that holds. `requirements`
// and `screens` are the names in spec and screens.md order (R1, S1...), `asked`
// the question ids with a review item, `assignment` the plan's capabilities
// with their source paths, and `own` this change's capability.
export function checkLedger(root, dir, { requirements, screens, asked, assignment, own }, problems) {
  const { text, files, sites, rows, duplicates } = readLedger(root, dir, problems);
  if (text === null) { problems.push('coverage.md is missing (the omission check: run sites.mjs, then the checkers)'); return; }
  if (files.length === 0) { problems.push(NO_FILES); return; }
  const ids = new Set(sites.map((s) => ledgerKey(s.id)));
  capped(problems, sites.filter((s) => !rows.has(ledgerKey(s.id))).map((s) => s.id), (id) => `site has no row in coverage.md: ${id}`);
  capped(problems, [...duplicates], (key) => `site has more than one row in coverage.md: ${rows.get(key).site}; keep only the current verdict`);
  capped(problems, [...rows.keys()].filter((key) => !ids.has(key)).map((key) => rows.get(key).site), (site) => `coverage.md has a row for a site the scanner does not find: ${site} (a mistyped id, a renamed member, or a file no longer in source-map.md; delete the row)`);
  const bad = [];
  for (const site of sites) {
    const row = rows.get(ledgerKey(site.id));
    if (!row) continue;
    const v = row.parsed;
    if (v.kind === 'covered') {
      for (const ref of v.refs) {
        const n = Number(ref.slice(1));
        const max = ref[0] === 'R' ? requirements.length : screens.length;
        if (n < 1 || n > max) bad.push(`coverage of ${site.id} names ${ref}, but the change has ${max === 0 ? 'no' : `only ${ref[0]}1-${ref[0]}${max} as`} ${ref[0] === 'R' ? 'requirements' : 'screens'}`);
      }
    } else if (v.kind === 'other') {
      const paths = assignment.get(v.capability);
      if (v.capability === own) bad.push(`coverage of ${site.id} names its own capability as "other capability"`);
      else if (!paths) bad.push(`coverage of ${site.id} names ${v.capability}, which is not a capability of the plan`);
      else if (!paths.some((p) => covers(p, site.file))) bad.push(`coverage of ${site.id} names ${v.capability}, but the plan does not give ${site.file} to that capability (list the file under it too, or judge the site here)`);
    } else if (v.kind === 'question') {
      if (!asked.has(v.question)) bad.push(`coverage of ${site.id} points to ${v.question}, which is not in questions.md with a review item`);
    } else if (v.kind === 'gap') bad.push(`site ${site.id} is a gap: add the requirement it needs (then check it again), or move it to questions.md as "question Q<n>"`);
    else if (v.kind !== 'no-behavior') bad.push(`coverage of ${site.id} is "${row.verdict.trim() || 'blank'}"; write covered R<n>/S<n>, no behavior, other capability <path>, question Q<n> or gap`);
  }
  capped(problems, bad, (p) => p);
}

// What the review page shows: counts per verdict, the sites that went to
// questions, and the sites judged "no behavior" although they hold markers.
export function ledgerSummary(root, dir) {
  const { text, sites, rows } = readLedger(root, dir);
  if (text === null) return null;
  const counts = { covered: 0, 'no-behavior': 0, other: 0, question: 0, gap: 0, open: 0 };
  const questions = []; const unmarked = []; const open = [];
  for (const site of sites) {
    const row = rows.get(ledgerKey(site.id));
    const kind = row ? row.parsed.kind : 'missing';
    if (kind in counts) counts[kind] += 1; else { counts.open += 1; open.push(site.id); }
    if (kind === 'gap') open.push(site.id);
    if (kind === 'question') questions.push({ site: site.id, question: row.parsed.question, evidence: row.evidence });
    if (kind === 'no-behavior' && site.markers.length) unmarked.push({ site: site.id, markers: markerText(site.markers), evidence: row.evidence });
  }
  return { sites: sites.length, files: new Set(sites.map((s) => s.file)).size, counts, questions, unmarked, open };
}

export function writeParts(root, change, per = 40) {
  const dir = path.join(root, 'openspec/changes', change);
  if (!fs.existsSync(dir)) return { ok: false, problems: [`change not found: ${change}`] };
  if (!fs.existsSync(path.join(dir, 'source-map.md'))) return { ok: false, problems: ['source-map.md is missing: the sites come from the files it lists'] };
  const files = changeFiles(root, dir);
  const sites = files.flatMap((file) => scanFile(root, file));
  if (files.length === 0) return { ok: false, change, sites: 0, files: 0, parts: [], problems: [NO_FILES] };
  const out = path.join(root, 'openspec/spec-relay/work', change, 'sites');
  fs.rmSync(out, { recursive: true, force: true });
  fs.mkdirSync(out, { recursive: true });
  const parts = [];
  for (let k = 0; k * per < sites.length; k += 1) {
    const chunk = sites.slice(k * per, (k + 1) * per);
    const name = `${String(k + 1).padStart(2, '0')}.md`;
    const rows = chunk.map((s) => `| \`${cell(s.id)}\` | ${lineText(s)} | ${cell(markerText(s.markers)) || (s.minified ? 'minified: not scanned' : '-')} |`);
    fs.writeFileSync(path.join(out, name), `# Sites ${k * per + 1}-${k * per + chunk.length} of ${sites.length} (${change})\n\n| Site | Lines | Markers |\n|---|---|---|\n${rows.join('\n')}\n`);
    parts.push(`openspec/spec-relay/work/${change}/sites/${name}`);
  }
  return { ok: true, change, sites: sites.length, files: files.length, parts, problems: [] };
}

export function main(argv) {
  const opts = { root: process.cwd(), per: 40 };
  for (let i = 0; i < argv.length; i += 2) {
    const key = { '--change': 'change', '--per': 'per', '--root': 'root' }[argv[i]];
    if (!key || argv[i + 1] === undefined) return usage();
    opts[key] = argv[i + 1];
  }
  const per = Number(opts.per);
  if (!opts.change || !Number.isInteger(per) || per < 1) return usage();
  if (!fs.existsSync(path.join(opts.root, 'openspec'))) {
    console.error(`sites: no openspec/ folder in ${path.resolve(opts.root)}. Run this from the repository root or pass --root DIR.`);
    return 2;
  }
  const result = writeParts(opts.root, opts.change, per);
  console.log(JSON.stringify(result, null, 2));
  return result.ok ? 0 : 1;
}

function usage() {
  console.error('Usage: node sites.mjs --change NAME [--per N] [--root DIR]');
  return 2;
}

function invokedDirectly() {
  if (!process.argv[1]) return false;
  try { return fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url)); } catch { return false; }
}

if (invokedDirectly()) process.exitCode = main(process.argv.slice(2));
