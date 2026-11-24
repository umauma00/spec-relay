// What the person changes in review.md from the canvas: a tick, a decision, the
// reviewer's name. The canvas is the person's hand on the file, as if they had
// edited it themselves; it never archives and never writes anything else.
//
// Each write is recorded in openspec/spec-relay/local/canvas-log.jsonl (the hash
// of review.md before and after), so that `gate.mjs guard --compare` can tell the
// person's canvas edits from a subagent's. Agents never write that log (hook.mjs).
// The items and the Reviewer line are found the way gate.mjs reads them, so the
// canvas changes exactly the line the gate and the review page count.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { CANVAS_LOG, PLACEHOLDER, REMARK, openFix, plain } from './gate.mjs';
import { ignoreLocal } from './metrics.mjs';

const CHECKBOX = /^(\s*(?:[-*+]|\d+[.)])\s+\[)(.?)(\]\s*)(.*)$/;
const FENCE = /^\s*(```|~~~)/;
const DECISION = /(\*\*|__)?\bdecision(\*\*|__)?\s*:(\*\*|__)?/i;
export const sha256 = (buffer) => crypto.createHash('sha256').update(buffer).digest('hex');

// A value typed on the page, as one line of Markdown text.
const oneLine = (value, max) => String(value ?? '').replace(/[\u0000-\u001f\u007f\u2028\u2029]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
// HTML comments blanked out, keeping every other character in place (and the line breaks).
const masked = (text) => text.replace(/<!--[\s\S]*?-->/g, (m) => m.replace(/[^\r\n]/g, ' '));
const withoutComments = (text) => text.replace(/<!--[\s\S]*?-->/g, ' ');

// The text of review.md, or null when the bytes are not UTF-8 (Windows
// PowerShell 5.1 writes UTF-16; an old editor may write Shift_JIS). Such a file
// is never rewritten: decoding and encoding it again would destroy it.
export function utf8Text(buffer) {
  if ((buffer[0] === 0xff && buffer[1] === 0xfe) || (buffer[0] === 0xfe && buffer[1] === 0xff) || buffer.includes(0)) return null;
  try { return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(buffer); } catch { return null; }
}

// Lines with their own line ends, so an edit leaves every other line's bytes alone.
function split(body) {
  const parts = body.split(/(\r?\n)/);
  return { lines: parts.filter((_, i) => i % 2 === 0), ends: parts.filter((_, i) => i % 2 === 1) };
}
const join = ({ lines, ends }) => lines.map((line, i) => line + (ends[i] ?? '')).join('');

// The decision written on an item's line (comments left out), or '' when none or a placeholder.
export function decisionOf(rest) {
  const at = masked(rest).search(DECISION);
  if (at < 0) return '';
  const text = plain(withoutComments(rest.slice(at).replace(DECISION, '')));
  return PLACEHOLDER.test(text) ? '' : text;
}

// The line of the review item `id` (R1, Q2...), read as gate.mjs reads it.
function findItem(lines, id) {
  let fenced = false;
  for (let i = 0; i < lines.length; i += 1) {
    if (FENCE.test(lines[i])) { fenced = !fenced; continue; }
    if (fenced) continue;
    const m = lines[i].match(CHECKBOX);
    if (!m) continue;
    const k = plain(m[4]).match(/^([A-Za-z])(\d+)\b/);
    if (k && `${k[1].toUpperCase()}${Number(k[2])}` === id) return { index: i, m };
  }
  return null;
}

// The lines that belong to the item on line `index`: the indented lines after it
// (its notes), up to the next item, heading or unindented line. Returns the
// note lines ({ index, kind }) as gate.mjs reads them and where a new note goes.
function itemNotes(lines, index) {
  const bare = masked(lines.join('\n')).split('\n');
  // Whether a comment is still open at the end of each line: a note never goes inside one.
  const open = [];
  let inside = false;
  for (const line of lines) {
    let at = 0;
    for (;;) {
      const next = inside ? line.indexOf('-->', at) : line.indexOf('<!--', at);
      if (next < 0) break;
      inside = !inside;
      at = next + (inside ? 4 : 3);
    }
    open.push(inside);
  }
  const notes = [];
  let end = index;
  for (let i = index + 1; i < lines.length; i += 1) {
    const line = bare[i];
    if (CHECKBOX.test(line) || FENCE.test(line) || /^#{1,6}\s/.test(line)) break;
    const r = line.match(REMARK);
    if (r) { notes.push({ index: i, kind: r[1].toLowerCase() }); if (!open[i]) end = i; continue; }
    if (!lines[i].trim()) continue;
    // Read as gate.mjs reads it: a comment (blank once comments are left out)
    // does not end the item, other unindented text does.
    if (line.trim() && !/^\s/.test(line)) break;
    if (!open[i]) end = i;
  }
  return { notes, end };
}


// The line index of "Reviewer:" as gate.mjs reads it (outside comments), or -1.
function reviewerLine(lines) {
  return masked(lines.join('\n')).split('\n').findIndex((l) => /^Reviewer:/.test(l));
}

// The reviewer's name as the gate reads it, or null.
export function reviewerOf(text) {
  const m = withoutComments(text.replace(/^\uFEFF/, '')).match(/^Reviewer:[ \t]*(.*)$/m);
  const name = m ? m[1].trim() : '';
  return name && !PLACEHOLDER.test(name) ? name : null;
}

// The new text of review.md, or { problem, code }. `action` is tick, untick,
// decision, reviewer, fix, hold or withdraw.
export function editReview(text, { action, id, value }) {
  const bom = text.startsWith('\uFEFF') ? '\uFEFF' : '';
  const doc = split(text.slice(bom.length));
  const { lines, ends } = doc;
  const done = () => ({ text: bom + join(doc) });
  if (action === 'reviewer') {
    const name = oneLine(value, 80);
    if (!name) return { problem: 'empty name', code: 'emptyValue' };
    const at = reviewerLine(lines);
    if (at >= 0) { lines[at] = `Reviewer: ${name}`; return done(); }
    // No Reviewer line: put one under the title (outside fences and front matter), or at the top.
    // The title is looked for outside comments too, so the line never lands inside one.
    const bare = masked(lines.join('\n')).split('\n');
    let fenced = false;
    let front = lines[0] === '---';
    let after = -1;
    for (let i = 0; i < lines.length; i += 1) {
      if (front) { if (i > 0 && lines[i] === '---') { front = false; after = i; } continue; }
      if (FENCE.test(bare[i])) { fenced = !fenced; continue; }
      if (!fenced && /^#\s/.test(bare[i])) { after = i; break; }
    }
    const eol = ends[0] ?? '\n';
    const add = after >= 0 ? ['', `Reviewer: ${name}`] : [`Reviewer: ${name}`, ''];
    // Line i ends with ends[i]; the new lines go after line `after`, each with its own line end.
    lines.splice(after + 1, 0, ...add);
    if (after >= 0 && after >= ends.length) ends.push(eol);
    ends.splice(after + 1, 0, ...add.map(() => eol));
    ends.length = Math.min(ends.length, lines.length - 1);
    return done();
  }
  if (!/^[A-Z]\d+$/.test(String(id))) return { problem: 'not a review item id', code: 'bad' };
  const item = findItem(lines, id);
  if (!item) return { problem: `no line for ${id} in review.md`, code: 'noLine' };
  const [, open, mark, close, rest] = item.m;
  if (action === 'fix' || action === 'hold') {
    // "This is wrong, change it" or "I cannot decide yet": a note under the item,
    // and the item is open again. The note is one line of the person's words.
    const note = oneLine(value, 500);
    if (!note) return { problem: 'empty note', code: 'emptyValue' };
    const { end } = itemNotes(lines, item.index);
    const indent = `${open.match(/^\s*/)[0]}  `;
    const eol = ends[item.index] ?? ends[0] ?? '\n';
    lines[item.index] = `${open} ${close}${rest}`;
    lines.splice(end + 1, 0, `${indent}- ${action}: ${note}`);
    // Line i ends with ends[i]: the new line takes the line end of the line before it, which gets one.
    if (end >= ends.length) ends.push(eol);
    ends.splice(end + 1, 0, eol);
    ends.length = Math.min(ends.length, lines.length - 1);
    return done();
  }
  if (action === 'withdraw') {
    // Takes back the person's last note (a fix the agent has not answered, or a hold).
    const { notes } = itemNotes(lines, item.index);
    const last = notes[notes.length - 1];
    if (!last || last.kind === 'fixed') return { problem: `no note of yours to withdraw under ${id}`, code: 'noNote' };
    lines.splice(last.index, 1);
    ends.splice(last.index, 1);
    ends.length = Math.min(ends.length, lines.length - 1);
    return done();
  }
  if (action === 'tick' || action === 'untick') {
    if (action === 'tick' && id.startsWith('Q') && !decisionOf(rest)) return { problem: 'write the decision first', code: 'needDecision' };
    if (action === 'tick' && openFix(itemNotes(lines, item.index).notes)) return { problem: `${id} has a fix request the agent has not answered; withdraw it first`, code: 'openFix' };
    lines[item.index] = `${open}${action === 'tick' ? 'x' : ' '}${close}${rest}`;
    return done();
  }
  if (action === 'decision') {
    if (!id.startsWith('Q')) return { problem: 'only questions (Q) take a decision', code: 'bad' };
    const decision = oneLine(value, 500);
    if (!decision) return { problem: 'empty decision', code: 'emptyValue' };
    if (PLACEHOLDER.test(plain(decision))) return { problem: 'a placeholder is not a decision', code: 'placeholder' };
    const at = masked(rest).search(DECISION);
    const head = (at < 0 ? rest : rest.slice(0, at)).replace(/\s+$/, '');
    lines[item.index] = `${open}${mark}${close}${head}${/[\p{L}\p{N}]$/u.test(head) ? ':' : ''} decision: ${decision}`;
    return done();
  }
  return { problem: `unknown action ${action}`, code: 'bad' };
}

// Waits without spinning the processor (the canvas server is paused meanwhile).
const pause = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

// Applies one edit to the review.md of an active change. `hash` is the file's
// hash when the page was built: a file changed since then is not written.
// `change` must be the folder's own name (canvas.mjs reads it from the folder).
export function writeReview(root, change, { action, id, value, hash }) {
  const file = path.join(root, 'openspec/changes', change, 'review.md');
  let before;
  try { before = fs.readFileSync(file); } catch { return { ok: false, status: 404, code: 'noFile', problem: `no review.md in ${change}` }; }
  const beforeHash = sha256(before);
  if (hash !== beforeHash) return { ok: false, status: 409, code: 'stale', problem: 'review.md changed since the page was shown' };
  const text = utf8Text(before);
  if (text === null) return { ok: false, status: 415, code: 'notUtf8', problem: 'review.md is not UTF-8; save it again as UTF-8 to edit it in the canvas' };
  const edited = editReview(text, { action, id, value });
  if (edited.problem) return { ok: false, status: 400, code: edited.code, problem: edited.problem };
  const after = Buffer.from(edited.text, 'utf8');
  const afterHash = sha256(after);
  if (afterHash === beforeHash) return { ok: true, hash: afterHash, unchanged: true };
  // Write beside the file, then swap it in, so a reader never sees half a file.
  const temp = path.join(path.dirname(file), `.review.md.${crypto.randomBytes(6).toString('hex')}.tmp`);
  fs.writeFileSync(temp, after);
  const drop = () => { try { fs.rmSync(temp, { force: true }); } catch { /* left behind */ } };
  for (let attempt = 0; ; attempt += 1) {
    try { fs.renameSync(temp, file); break; } catch (error) {
      // Windows: an editor or a virus scanner may hold the file for a moment.
      if (attempt >= 4 || !['EPERM', 'EBUSY', 'EACCES'].includes(error.code)) {
        drop();
        return { ok: false, status: 423, code: 'busy', problem: `could not write review.md (${error.code ?? error.message}); close it in other programs and try again` };
      }
      pause(100 * (attempt + 1));
      // Someone may have saved the file meanwhile: never write over that.
      let now = null;
      try { now = fs.readFileSync(file); } catch { /* gone */ }
      if (!now || sha256(now) !== beforeHash) { drop(); return { ok: false, status: 409, code: 'stale', problem: 'review.md changed while saving' }; }
    }
  }
  // The record after the file: a write that never happened is never recorded,
  // and a record lost after the write shows the edit as a change in the guard (the safe side).
  const rel = path.relative(root, file).split(path.sep).join('/');
  try {
    ignoreLocal(root);
    fs.appendFileSync(path.join(root, CANVAS_LOG), `${JSON.stringify({ time: new Date().toISOString(), file: rel, action, id: id ?? null, before: beforeHash, after: afterHash })}\n`);
  } catch { return { ok: true, hash: afterHash, logged: false }; }
  return { ok: true, hash: afterHash };
}

// The log's entries, oldest first, from byte `offset` on (lines that do not parse are skipped).
export function canvasLog(root, { offset = 0 } = {}) {
  let buffer;
  try { buffer = fs.readFileSync(path.join(root, CANVAS_LOG)); } catch { return []; }
  if (offset > buffer.length) return [];
  return buffer.subarray(offset).toString('utf8').split(/\r?\n/).flatMap((line) => {
    try {
      const e = JSON.parse(line);
      return e && typeof e === 'object' && typeof e.file === 'string' && typeof e.before === 'string' && typeof e.after === 'string' ? [e] : [];
    } catch { return []; }
  });
}

// The person's canvas edits, oldest first (for the agent: what changed in review.md since it looked).
// `since` is any date-time Date.parse reads (with or without an offset).
export function canvasEdits(root, { since } = {}) {
  const from = since === undefined || since === null || since === '' ? null : Date.parse(since);
  if (Number.isNaN(from)) return { ok: false, problem: `not a date-time: ${since}` };
  return { ok: true, edits: canvasLog(root).filter((e) => from === null || Date.parse(e.time) > from) };
}
