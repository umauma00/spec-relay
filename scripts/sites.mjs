#!/usr/bin/env node
// The sites of a capability's source files: the places whose behavior a spec
// must cover. A site is a method, function, constructor, property with a body,
// stored procedure, or the code of a file that runs outside any function (old
// PHP pages, scripts). A file in a language the scanner does not read, such as
// an .aspx page or a config file, is one site.
//
//   node sites.mjs --change extract-<capability> [--per N] [--root DIR]
//
// Writes openspec/spec-relay/work/<change>/sites/<nn>.md, tables of at most N
// sites (default 40) with their lines and markers, so each omission checker gets
// one file, and prints { ok, change, sites, files, parts, problems } as JSON.
// `gate.mjs review` scans again and needs one row per site in coverage.md.
//
// The scanner reads text, not syntax trees: it blanks out comments and string
// literals, follows braces, and takes the declarations it recognizes. Unusual
// code (macros, eval, generated members) can make a site coarser, never lost:
// what is not a recognized member stays in its enclosing site or in the file's
// own site. Markers are lines with words that usually mean an observable effect
// (a database write, an error, a redirect, a mail, the current time...). They
// tell the checker where to look; they prove nothing.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readIf, sourceFiles, archivedChange, tableRows } from './gate.mjs';
import { sourceMapPaths, covers, contextOf, inventoryRows } from './coverage.mjs';

// ---------------------------------------------------------------- reading

// Legacy code in Japan is often Shift_JIS. Decoding it as UTF-8 would turn the
// second byte of 「ソ」 (0x5C) into a backslash that escapes a closing quote.
export function decode(buffer) {
  if (buffer.length >= 2 && buffer[0] === 0xff && buffer[1] === 0xfe) return new TextDecoder('utf-16le').decode(buffer.subarray(2));
  if (buffer.includes(0)) return null; // binary
  for (const encoding of ['utf-8', 'shift_jis', 'euc-jp']) {
    try { return new TextDecoder(encoding, { fatal: true }).decode(buffer).replace(/^﻿/, ''); } catch { /* next */ }
  }
  return new TextDecoder('windows-1252').decode(buffer);
}

const BINARY = /\.(png|jpe?g|gif|bmp|ico|webp|tiff?|pdf|zip|gz|7z|rar|jar|war|dll|exe|pdb|so|dylib|class|o|obj|lib|a|mdb|accdb|xlsx?|docx?|pptx?|ttf|otf|woff2?|eot|mp3|mp4|wav|avi|mov|swf|fla|psd|snk|pfx|p12|cer)$/i;

const LANGS = [
  [/\.(cs|csx)$/i, 'csharp'],
  [/\.java$/i, 'java'],
  [/\.vb$/i, 'vb'],
  [/\.(php\d?|phtml|inc)$/i, 'php'],
  [/\.(js|mjs|cjs|jsx|ts|tsx)$/i, 'js'],
  [/\.sql$/i, 'sql'],
];
export const languageOf = (file) => LANGS.find(([re]) => re.test(file))?.[1] ?? 'text';

// ---------------------------------------------------------------- masking

// Two copies of the text with the same length and newlines: `code` with
// comments, string literals and (in PHP) inline HTML blanked, and `plain` with
// only comments blanked (markers look there, since SQL lives in strings).
// `html` marks the offsets of PHP's inline HTML.
export function mask(text, lang) {
  const code = text.split('');
  const plain = text.split('');
  const n = text.length;
  let htmlChars = 0;
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
        else if (ch === '"' || ch === "'") { k = quoted(k, ch) ; continue; }
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
  let inPhp = lang !== 'php' || false;
  let prev = ''; // last significant code character, for JavaScript regex literals
  while (i < n) {
    if (lang === 'php' && !inPhp) {
      const open = text.slice(i).search(/<\?(php\b|=)?/i);
      const end = open < 0 ? n : i + open;
      for (let k = i; k < end; k += 1) if (!/\s/.test(text[k])) htmlChars += 1;
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
    if (lang === 'csharp' && ch === '@' && next === '"') end = quoted(i + 1, '"', { escapes: false, doubled: true });
    else if (lang === 'csharp' && ch === '$' && (next === '"' || (next === '@' && text[i + 2] === '"'))) {
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
  return { code: code.join(''), plain: plain.join(''), htmlChars };
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

function markersIn(plainLines, from, to) {
  const found = [];
  for (let line = from; line <= to; line += 1) {
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

const KEYWORDS = new Set(['if', 'else', 'for', 'foreach', 'while', 'do', 'switch', 'case', 'catch', 'try', 'finally', 'using', 'lock', 'fixed', 'return', 'new', 'typeof', 'sizeof', 'nameof', 'default', 'checked', 'unchecked', 'when', 'synchronized', 'function', 'get', 'set', 'init', 'add', 'remove', 'value', 'await', 'yield', 'throw', 'in', 'is', 'as', 'with', 'elseif', 'declare', 'match', 'fn', 'static']);
const TYPE = /\b(class|struct|interface|record|enum|trait)\s+([A-Za-z_]\w*)/;
// Leading attributes ([HttpPost]) and annotations (@Override) of a member.
const withoutAttributes = (header) => header.trim().replace(/^(?:\[[^\]]*\]\s*)+/, '').replace(/^(?:@\w+(?:\([^)]*\))?\s*)+/, '').trim();

// The name of a method or constructor whose header (masked, ending before `{`
// or `;`) ends in its parameter list, optionally followed by a constructor
// initializer, generic constraints or a throws clause; or null.
export function memberName(header) {
  let h = header.replace(/\s+$/, '');
  h = h.replace(/\s+throws\s+[\w.,\s<>]+$/, '').replace(/\s+where\s+[^()]*$/, '');
  for (let pass = 0; pass < 2; pass += 1) {
    if (!h.endsWith(')')) return null;
    let depth = 0; let k = h.length - 1;
    for (; k >= 0; k -= 1) { if (h[k] === ')') depth += 1; else if (h[k] === '(') { depth -= 1; if (depth === 0) break; } }
    if (k < 0) return null;
    const before = h.slice(0, k).replace(/\s+$/, '');
    const init = before.match(/:\s*(base|this|super)$/);
    if (init && pass === 0) { h = before.slice(0, init.index).replace(/\s+$/, ''); continue; }
    const m = before.match(/(operator\s*\S+|~?[A-Za-z_]\w*)\s*(<[^<>()]*(?:<[^<>()]*>[^<>()]*)*>)?$/);
    if (!m) return null;
    const name = m[1].replace(/\s+/g, '');
    if (KEYWORDS.has(name.toLowerCase())) return null;
    // A call or a lambda at type level is not a declaration: a declaration has
    // something (a type, a modifier) before its name, or is a constructor.
    if (/[=>]$/.test(before.slice(0, m.index).trimEnd())) return null;
    return name;
  }
  return null;
}

// The name of a constant field (const, static readonly, static final) whose
// header ends in its initializer, or null. Constants such as a tax rate or a
// maximum length are behavior; other fields are state, read by the members.
function constantName(header) {
  if (!/\bconst\b|\bstatic\s+readonly\b|\breadonly\s+static\b|\bstatic\s+final\b|\bfinal\s+static\b/.test(header)) return null;
  return header.split('=')[0].match(/([A-Za-z_]\w*)\s*$/)?.[1] ?? null;
}

// C#, Java: members of types.
function scanBraces(code, lang) {
  const starts = lineStarts(code);
  const sites = [];
  const stack = [{ kind: 'root', name: '' }];
  let boundary = 0;
  const top = () => stack[stack.length - 1];
  const typeName = () => stack.filter((f) => f.kind === 'type').map((f) => f.name).join('.');
  const firstCodeLine = (from) => { let k = from; while (k < code.length && /\s/.test(code[k])) k += 1; return lineAt(starts, k); };
  for (let i = 0; i < code.length; i += 1) {
    const ch = code[i];
    if (ch !== '{' && ch !== '}' && ch !== ';') continue;
    const frame = top();
    const header = code.slice(boundary, i);
    if (ch === '{') {
      if (frame.kind === 'root' || frame.kind === 'namespace') {
        const type = header.match(TYPE);
        if (/\bnamespace\s+[\w.]+\s*$/.test(header)) stack.push({ kind: 'namespace' });
        else if (type) stack.push({ kind: type[1] === 'enum' ? 'enum' : 'type', name: type[2] });
        else stack.push({ kind: 'block' });
      } else if (frame.kind === 'type') {
        const type = header.match(TYPE);
        const trimmed = withoutAttributes(header);
        if (type && !/[=(]/.test(header.slice(0, type.index))) stack.push({ kind: type[1] === 'enum' ? 'enum' : 'type', name: type[2] });
        else if (frame.pending) stack.push({ kind: 'block' });
        else if (/=>/.test(trimmed) && !memberName(trimmed)) { frame.pending = { name: memberName(trimmed.split('=>')[0]) ?? trimmed.split('=>')[0].trim().match(/(\w+)\s*$/)?.[1], from: firstCodeLine(boundary) }; stack.push({ kind: 'block' }); }
        else {
          let name = memberName(trimmed);
          if (!name && /\bthis\s*\[[^\]]*\]\s*$/.test(trimmed)) name = 'this[]';
          const field = !name && /=/.test(trimmed.replace(/[=!<>]=|=>/g, ''));
          if (!name && !field) { const prop = trimmed.match(/^(?:[\w<>[\],.?\s]+\s)?([A-Za-z_]\w*)\s*$/); if (prop && !KEYWORDS.has(prop[1].toLowerCase())) name = prop[1]; }
          if (!name && trimmed === '') name = '(init)';
          if (!name && /^static$/.test(trimmed)) name = '(static init)';
          // A field initializer with braces (an array, an object, a lambda): its field's site when it is a constant, else none.
          if (field) {
            const constant = constantName(trimmed);
            if (constant) frame.pending = { name: constant, from: firstCodeLine(boundary) };
            stack.push({ kind: 'block' });
          } else stack.push(name ? { kind: 'member', name: `${typeName()}.${name}`, from: firstCodeLine(boundary) } : { kind: 'block' });
        }
      } else stack.push({ kind: 'block' });
      boundary = i + 1;
    } else if (ch === '}') {
      const done = stack.length > 1 ? stack.pop() : null;
      if (done?.kind === 'member') sites.push({ symbol: done.name, from: done.from, to: lineAt(starts, i) });
      if (!top().pending) boundary = i + 1;
    } else if (ch === ';') {
      if (frame.kind === 'type') {
        if (frame.pending) {
          if (frame.pending.name) sites.push({ symbol: `${typeName()}.${frame.pending.name}`, from: frame.pending.from, to: lineAt(starts, i) });
          frame.pending = null;
        } else {
          const trimmed = withoutAttributes(header);
          const arrow = trimmed.indexOf('=>');
          let name = null;
          if (arrow > 0) {
            const left = trimmed.slice(0, arrow);
            name = memberName(left) ?? (/=/.test(left) ? null : left.match(/([A-Za-z_]\w*)\s*$/)?.[1]);
          } else name = constantName(trimmed);
          if (name) sites.push({ symbol: `${typeName()}.${name}`, from: firstCodeLine(boundary), to: lineAt(starts, i) });
        }
      }
      boundary = i + 1;
    }
  }
  return sites;
}

// PHP and JavaScript: functions and methods, and the code outside them.
function scanFunctions(code, lang, htmlChars) {
  const starts = lineStarts(code);
  const sites = [];
  const stack = [{ kind: 'root' }];
  let boundary = 0;
  const top = () => stack[stack.length - 1];
  const inFunction = () => stack.some((f) => f.kind === 'function');
  const className = () => stack.filter((f) => f.kind === 'class').map((f) => f.name).join('.');
  const firstCodeLine = (from) => { let k = from; while (k < code.length && /\s/.test(code[k])) k += 1; return lineAt(starts, k); };
  const outside = []; // [from, to) offsets of code outside functions and class bodies
  let outsideFrom = 0;
  for (let i = 0; i < code.length; i += 1) {
    const ch = code[i];
    if (ch !== '{' && ch !== '}' && ch !== ';') continue;
    const header = code.slice(boundary, i);
    if (ch === '{') {
      const atTop = !inFunction();
      const type = atTop && header.match(/\b(class|trait|interface|enum)\s+([A-Za-z_]\w*)[^(){};]*$/);
      let fn = null;
      if (atTop && !type) {
        const named = header.match(/\bfunction\s*&?\s*([A-Za-z_$][\w$]*)\s*\([^]*\)\s*(?::\s*[?\w\\|]+\s*)?$/)
          ?? header.match(/([A-Za-z_$][\w$]*)\s*[:=]\s*(?:async\s+)?function\b[^(]*\([^]*\)\s*$/)
          ?? (lang === 'js' ? header.match(/(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?(?:\([^]*\)|[A-Za-z_$][\w$]*)\s*=>\s*$/) : null)
          ?? (lang === 'js' && top().kind === 'class' ? header.match(/(?:^|[\s;}])(?:static\s+|async\s+|get\s+|set\s+)*([A-Za-z_$][\w$]*)\s*\([^]*\)\s*$/) : null);
        if (named && !KEYWORDS.has(named[1].toLowerCase())) fn = named[1];
      }
      if (type) {
        if (stack.length === 1) { outside.push([outsideFrom, boundary + header.search(/\S|$/)]); }
        stack.push({ kind: 'class', name: type[2] });
      } else if (fn) {
        if (stack.length === 1) outside.push([outsideFrom, boundary + header.search(/\S|$/)]);
        const cls = className();
        stack.push({ kind: 'function', name: cls ? `${cls}.${fn}` : fn, from: firstCodeLine(boundary) });
      } else stack.push({ kind: 'block' });
      boundary = i + 1;
    } else if (ch === '}') {
      const done = stack.length > 1 ? stack.pop() : null;
      if (done?.kind === 'function') sites.push({ symbol: done.name, from: done.from, to: lineAt(starts, i) });
      if ((done?.kind === 'function' || done?.kind === 'class') && stack.length === 1) outsideFrom = i + 1;
      boundary = i + 1;
    } else {
      // A class constant is behavior too (a rate, a limit).
      const constant = top().kind === 'class' && header.match(/^\s*(?:(?:public|private|protected|final|static)\s+)*(?:const|readonly\s+static|static\s+readonly)\s+(?:[\w\\?]+\s+)?([A-Za-z_]\w*)\s*=/);
      if (constant) sites.push({ symbol: `${className()}.${constant[1]}`, from: firstCodeLine(boundary), to: lineAt(starts, i) });
      boundary = i + 1;
    }
  }
  outside.push([outsideFrom, code.length]);
  // Code outside functions that does something: not only namespace, use,
  // declare, include and require lines.
  const ignorable = /^\s*(namespace\s+[\w\\]+|use\s+[^;]+|declare\s*\([^)]*\)|(require|include)(_once)?\b[^;]*|['"]use strict['"]|export\s*\{[^}]*\}|import\s+[^;]+)\s*$/;
  let body = false;
  for (const [from, to] of outside) {
    const statements = code.slice(from, to).split(';').map((s) => s.trim()).filter(Boolean);
    if (statements.some((s) => !ignorable.test(s))) body = true;
  }
  if (body || htmlChars > 0) sites.unshift({ symbol: '(file)', from: 1, to: starts.length });
  return sites;
}

// VB.NET: Sub, Function, Property and Operator blocks of classes and modules.
function scanVb(code) {
  const lines = code.split('\n');
  const sites = [];
  const types = [];
  const DECL = /^\s*(?:<[^>]*>\s*)*(?:(?:Public|Private|Protected|Friend|Shared|Overrides|Overridable|NotOverridable|MustOverride|Overloads|Shadows|Async|Partial|Static|ReadOnly|WriteOnly|Default|Iterator|Widening|Narrowing)\s+)*(Sub|Function|Property|Operator)\s+([\w[\]]+|New|[+\-*/&=<>]+)/i;
  let open = null;
  for (let k = 0; k < lines.length; k += 1) {
    const line = lines[k];
    const type = line.match(/^\s*(?:(?:Public|Private|Protected|Friend|Partial|Shared|MustInherit|NotInheritable)\s+)*(Class|Module|Structure|Interface)\s+(\w+)/i);
    if (type && !open) { types.push({ name: type[2], iface: /interface/i.test(type[1]) }); continue; }
    if (/^\s*End\s+(Class|Module|Structure|Interface)\b/i.test(line) && !open) { types.pop(); continue; }
    if (open) {
      if (new RegExp(`^\\s*End\\s+${open.kind}\\b`, 'i').test(line)) { sites.push({ symbol: open.name, from: open.from, to: k + 1 }); open = null; }
      continue;
    }
    const decl = line.match(DECL);
    if (!decl || /\bMustOverride\b|\bDeclare\b/i.test(line) || types.at(-1)?.iface) continue;
    const kind = decl[1][0].toUpperCase() + decl[1].slice(1).toLowerCase();
    const name = `${types.map((t) => t.name).join('.')}${types.length ? '.' : ''}${decl[2].replace(/[[\]]/g, '')}`;
    if (kind === 'Property') {
      // An auto-property has no End Property before the next declaration.
      let hasBody = false;
      for (let j = k + 1; j < lines.length; j += 1) {
        if (/^\s*End\s+Property\b/i.test(lines[j])) { hasBody = true; break; }
        if (DECL.test(lines[j]) || /^\s*End\s+(Class|Module|Structure)\b/i.test(lines[j])) break;
      }
      if (!hasBody) continue;
    }
    open = { kind, name, from: k + 1 };
  }
  return sites;
}

// SQL: stored procedures, functions, triggers and views.
function scanSql(code) {
  const lines = code.split('\n');
  const sites = [];
  let open = null;
  const close = (to) => { if (open) sites.push({ symbol: open.name, from: open.from, to }); open = null; };
  for (let k = 0; k < lines.length; k += 1) {
    const m = lines[k].match(/^\s*(?:CREATE|ALTER)\s+(?:OR\s+(?:REPLACE|ALTER)\s+)?(?:DEFINER\s*=\s*\S+\s+)?(PROC(?:EDURE)?|FUNCTION|TRIGGER|VIEW|PACKAGE(?:\s+BODY)?)\s+([\w.[\]"`]+)/i);
    if (m) { close(k); open = { name: m[2].replace(/[[\]"`]/g, ''), from: k + 1 }; continue; }
    if (/^\s*GO\s*;?\s*$/i.test(lines[k])) close(k);
  }
  let last = lines.length;
  while (last > 1 && !lines[last - 1].trim()) last -= 1;
  close(last);
  if (sites.length === 0 && code.trim()) sites.push({ symbol: '(file)', from: 1, to: lines.length });
  return sites;
}

// The sites of one file: [{ id, symbol, from, to, markers }]. `id` is
// `<path>:<symbol>`, with `#2`, `#3` for overloads in file order.
export function scanText(text, file) {
  const lang = languageOf(file);
  const normalized = text.replace(/\r\n?/g, '\n');
  // Minified or generated one-line code has no members worth reading apart.
  const all = normalized.split('\n');
  if (all.some((line) => line.length > 5000) || (normalized.length > 20000 && normalized.length / all.length > 300)) {
    return [{ id: `${file}:(file)`, symbol: '(file)', from: 1, to: all.length, markers: [], minified: true }];
  }
  const { code, plain, htmlChars } = mask(normalized, lang === 'text' ? 'text' : lang);
  let sites;
  if (lang === 'csharp' || lang === 'java') sites = scanBraces(code, lang);
  else if (lang === 'php' || lang === 'js') sites = scanFunctions(code, lang, htmlChars);
  else if (lang === 'vb') sites = scanVb(code);
  else if (lang === 'sql') sites = scanSql(code);
  else sites = normalized.trim() ? [{ symbol: '(file)', from: 1, to: normalized.split('\n').length }] : [];
  // A C# or Java file whose code is outside any member (top-level statements, a
  // script) keeps its file site.
  if ((lang === 'csharp' || lang === 'java') && sites.length === 0 && /\w\s*\(/.test(code.replace(/\b(using|namespace|import|package)\b[^;{]*[;{]/g, ''))) sites.push({ symbol: '(file)', from: 1, to: normalized.split('\n').length });
  const plainLines = (lang === 'text' ? normalized : plain).split('\n');
  const seen = new Map();
  return sites.sort((a, b) => a.from - b.from || a.to - b.to).map((s) => {
    const count = (seen.get(s.symbol) ?? 0) + 1;
    seen.set(s.symbol, count);
    const symbol = count === 1 ? s.symbol : `${s.symbol}#${count}`;
    // The file site of PHP and JavaScript holds its functions; their markers are theirs.
    let markers = markersIn(plainLines, s.from, s.to);
    if (s.symbol === '(file)') markers = markers.filter((m) => !sites.some((o) => o !== s && m.line >= o.from && m.line <= o.to));
    return { id: `${file}:${symbol}`, symbol, from: s.from, to: s.to, markers };
  });
}

export function scanFile(root, file) {
  if (BINARY.test(file)) return [];
  let buffer;
  try { buffer = fs.readFileSync(path.join(root, file)); } catch { return []; }
  const text = decode(buffer);
  return text === null ? [] : scanText(text, file);
}

// ---------------------------------------------------------------- a change

// The kept source files a change's source map names (a folder row stands for
// the files below it), in path order.
export function changeFiles(root, dir) {
  const listed = sourceMapPaths(readIf(path.join(dir, 'source-map.md'), []) ?? '');
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

// ---------------------------------------------------------------- the ledger

const ledgerKey = (cell) => cell.replace(/<!--[\s\S]*?-->/g, '').trim().replace(/^`(.*)`$/, '$1').trim().replace(/\\\|/g, '|').replace(/\\/g, '/').toLowerCase();

// One verdict cell: { kind, refs, capability, question } or { kind: 'invalid' }.
export function parseVerdict(cell) {
  const v = cell.replace(/<!--[\s\S]*?-->/g, '').replace(/[*_`]/g, '').trim().replace(/[.。]$/, '').trim();
  let m = v.match(/^covered\s*:?\s*(.+)$/i);
  if (m) {
    const tokens = m[1].split(/[\s,、;/]+|\band\b/i).filter(Boolean);
    if (tokens.length && tokens.every((t) => /^[RS]\d+$/i.test(t))) return { kind: 'covered', refs: tokens.map((t) => t.toUpperCase().replace(/^([RS])0*(\d)/, '$1$2')) };
    return { kind: 'invalid' };
  }
  if (/^no[\s-]+behaviou?r$/i.test(v)) return { kind: 'no-behavior' };
  m = v.match(/^other[\s-]+capability\s*:?\s*([a-z0-9]+(?:-[a-z0-9]+)*(?:\/[a-z0-9]+(?:-[a-z0-9]+)*)+)$/i);
  if (m) return { kind: 'other', capability: m[1].toLowerCase() };
  m = v.match(/^question\s+Q(\d+)$/i);
  if (m) return { kind: 'question', question: `Q${Number(m[1])}` };
  if (/^gap$/i.test(v)) return { kind: 'gap' };
  return { kind: v ? 'invalid' : 'blank' };
}

// The ledger of an extract change: every site the scanner finds now in the
// files of its source map, with the row coverage.md gives it.
export function readLedger(root, dir, problems = []) {
  const sites = changeSites(root, dir);
  const text = readIf(path.join(dir, 'coverage.md'), problems);
  const rows = new Map();
  const duplicates = new Set();
  for (const [site = '', verdict = '', evidence = ''] of tableRows(text ?? '')) {
    const key = ledgerKey(site);
    if (!key) continue;
    if (rows.has(key)) duplicates.add(key);
    rows.set(key, { site, verdict, evidence, parsed: parseVerdict(verdict) });
  }
  return { text, sites, rows, duplicates };
}

function capped(problems, list, say, max = 20) {
  for (const item of list.slice(0, max)) problems.push(say(item));
  if (list.length > max) problems.push(`...and ${list.length - max} more`);
}

// Extract review: one row per site with a verdict that holds. `requirements`
// and `screens` are the names in spec and screens.md order (R1, S1...), `asked`
// the question ids with a review item, `capabilities` the plan's capability
// paths and `own` this change's capability.
export function checkLedger(root, dir, { requirements, screens, asked, capabilities, own }, problems) {
  const { text, sites, rows, duplicates } = readLedger(root, dir, problems);
  if (text === null) { problems.push('coverage.md is missing (the omission check: run sites.mjs, then the checkers)'); return; }
  const ids = new Set(sites.map((s) => ledgerKey(s.id)));
  capped(problems, sites.filter((s) => !rows.has(ledgerKey(s.id))).map((s) => s.id), (id) => `site has no row in coverage.md: ${id}`);
  capped(problems, [...duplicates], (key) => `site has more than one row in coverage.md: ${rows.get(key).site}; keep only the current verdict`);
  capped(problems, [...rows.keys()].filter((key) => !ids.has(key)).map((key) => rows.get(key).site), (site) => `coverage.md has a row for a site the scanner does not find: ${site} (a mistyped id, or a file no longer in source-map.md)`);
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
      if (v.capability === own) bad.push(`coverage of ${site.id} names its own capability as "other capability"`);
      else if (!capabilities.includes(v.capability)) bad.push(`coverage of ${site.id} names ${v.capability}, which is not a capability of the plan`);
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
  return { sites: sites.length, files: new Set(sites.map((s) => s.id.slice(0, s.id.lastIndexOf(':')))).size, counts, questions, unmarked, open };
}

export function writeParts(root, change, per = 40) {
  const dir = path.join(root, 'openspec/changes', change);
  if (!fs.existsSync(dir)) return { ok: false, problems: [`change not found: ${change}`] };
  if (!fs.existsSync(path.join(dir, 'source-map.md'))) return { ok: false, problems: ['source-map.md is missing: the sites come from the files it lists'] };
  const files = changeFiles(root, dir);
  const sites = files.flatMap((file) => scanFile(root, file));
  const out = path.join(root, 'openspec/spec-relay/work', change, 'sites');
  fs.rmSync(out, { recursive: true, force: true });
  fs.mkdirSync(out, { recursive: true });
  const parts = [];
  for (let k = 0; k * per < sites.length || (k === 0 && sites.length === 0); k += 1) {
    const chunk = sites.slice(k * per, (k + 1) * per);
    const name = `${String(k + 1).padStart(2, '0')}.md`;
    const rows = chunk.map((s) => `| \`${cell(s.id)}\` | ${s.from}-${s.to} | ${cell(markerText(s.markers)) || '-'} |`);
    fs.writeFileSync(path.join(out, name), `# Sites ${k * per + 1}-${k * per + chunk.length} of ${sites.length} (${change})\n\n| Site | Lines | Markers |\n|---|---|---|\n${rows.join('\n')}\n`);
    parts.push(`openspec/spec-relay/work/${change}/sites/${name}`);
    if (sites.length === 0) break;
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
