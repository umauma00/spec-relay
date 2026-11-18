// What the person changes in review.md from the canvas: a tick, a decision, the
// reviewer's name. The canvas is the person's hand on the file, as if they had
// edited it themselves; it never archives and never writes anything else.
//
// Each write is recorded in openspec/spec-relay/canvas-log.jsonl (the hash of
// review.md before and after), so that `gate.mjs guard --compare` can tell the
// person's canvas edits from a subagent's. Agents never write that log (hook.mjs).
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { CANVAS_LOG } from './gate.mjs';

const CHECKBOX = /^(\s*(?:[-*+]|\d+[.)])\s+\[)(.?)(\]\s*)(.*)$/;
const FENCE = /^\s*(```|~~~)/;
export const sha256 = (buffer) => crypto.createHash('sha256').update(buffer).digest('hex');

// A value typed on the page, as one line of Markdown text.
const oneLine = (value, max) => String(value ?? '').replace(/[\u0000-\u001f\u007f\u2028\u2029]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);

// The review item `id` (R1, Q2...) in review.md: its line number, tick and line.
function findItem(lines, id) {
  let fenced = false;
  for (let i = 0; i < lines.length; i += 1) {
    if (FENCE.test(lines[i])) { fenced = !fenced; continue; }
    if (fenced) continue;
    const m = lines[i].match(CHECKBOX);
    if (!m) continue;
    const plainBody = m[4].replace(/<!--[\s\S]*?-->/g, ' ').replace(/[*_`[\]()]/g, '').trim();
    const k = plainBody.match(/^([A-Za-z])(\d+)\b/);
    if (k && `${k[1].toUpperCase()}${Number(k[2])}` === id) return { index: i, m, done: m[2].trim().toLowerCase() === 'x' };
  }
  return null;
}

// The new text of review.md, or { problem }. `action` is tick, untick, decision or reviewer.
export function editReview(text, { action, id, value }) {
  const bom = text.startsWith('\uFEFF') ? '\uFEFF' : '';
  const body = text.slice(bom.length);
  const eol = /\r\n/.test(body) ? '\r\n' : '\n';
  const lines = body.split(/\r?\n/);
  if (action === 'reviewer') {
    const name = oneLine(value, 80);
    if (!name) return { problem: 'empty name' };
    let fenced = false;
    const at = lines.findIndex((l) => { if (FENCE.test(l)) { fenced = !fenced; return false; } return !fenced && /^\s*\**Reviewer\**\s*:/i.test(l); });
    if (at >= 0) lines[at] = `Reviewer: ${name}`;
    else {
      const heading = lines.findIndex((l) => /^#\s/.test(l));
      lines.splice(heading + 1, 0, ...(heading >= 0 ? ['', `Reviewer: ${name}`] : [`Reviewer: ${name}`, '']));
    }
    return { text: bom + lines.join(eol) };
  }
  if (!/^[A-Z]\d+$/.test(String(id))) return { problem: 'not a review item id' };
  const item = findItem(lines, id);
  if (!item) return { problem: `no line for ${id} in review.md` };
  const [, open, , close, rest] = item.m;
  if (action === 'tick' || action === 'untick') {
    if (action === 'tick' && id.startsWith('Q')) {
      const decision = rest.split(/\bdecision:/i)[1];
      if (decision === undefined || !oneLine(decision.replace(/<!--[\s\S]*?-->/g, ''), 500)) return { problem: 'write the decision first' };
    }
    lines[item.index] = `${open}${action === 'tick' ? 'x' : ' '}${close}${rest}`;
    return { text: bom + lines.join(eol) };
  }
  if (action === 'decision') {
    const decision = oneLine(value, 500);
    if (!decision) return { problem: 'empty decision' };
    const parts = rest.split(/\bdecision:/i);
    const head = parts[0].replace(/\s+$/, '');
    lines[item.index] = `${open}${item.m[2]}${close}${head}${/:$/.test(head) ? '' : ':'} decision: ${decision}`;
    return { text: bom + lines.join(eol) };
  }
  return { problem: `unknown action ${action}` };
}

// Applies one edit to the review.md of an active change. `hash` is the file's
// hash when the page was built: a file changed since then is not written.
export function writeReview(root, change, { action, id, value, hash }) {
  const file = path.join(root, 'openspec/changes', change, 'review.md');
  let before;
  try { before = fs.readFileSync(file); } catch { return { ok: false, status: 404, problem: `no review.md in ${change}` }; }
  const beforeHash = sha256(before);
  if (hash !== beforeHash) return { ok: false, status: 409, problem: 'review.md changed since the page was shown' };
  const edited = editReview(before.toString('utf8'), { action, id, value });
  if (edited.problem) return { ok: false, status: 400, problem: edited.problem };
  const after = Buffer.from(edited.text, 'utf8');
  const afterHash = sha256(after);
  if (afterHash === beforeHash) return { ok: true, hash: afterHash, unchanged: true };
  const rel = path.relative(root, file).split(path.sep).join('/');
  // The record first: an edit that fails after it leaves a harmless extra line.
  const log = path.join(root, CANVAS_LOG);
  fs.mkdirSync(path.dirname(log), { recursive: true });
  fs.appendFileSync(log, `${JSON.stringify({ time: new Date().toISOString(), file: rel, action, id: id ?? null, before: beforeHash, after: afterHash })}\n`);
  // Write beside the file, then swap it in, so a reader never sees half a file.
  const temp = path.join(path.dirname(file), `.review.md.${crypto.randomBytes(6).toString('hex')}.tmp`);
  fs.writeFileSync(temp, after);
  for (let attempt = 0; ; attempt += 1) {
    try { fs.renameSync(temp, file); break; } catch (error) {
      // Windows: an editor or a virus scanner may hold the file for a moment.
      if (attempt >= 4 || !['EPERM', 'EBUSY', 'EACCES'].includes(error.code)) {
        try { fs.rmSync(temp, { force: true }); } catch { /* left behind */ }
        return { ok: false, status: 423, problem: `could not write review.md (${error.code ?? error.message}); close it in other programs and try again` };
      }
      const until = Date.now() + 100 * (attempt + 1);
      while (Date.now() < until) { /* wait */ }
    }
  }
  return { ok: true, hash: afterHash };
}

// The person's canvas edits, newest last (for the agent: what changed in review.md since it looked).
export function canvasEdits(root, { since } = {}) {
  let text = '';
  try { text = fs.readFileSync(path.join(root, CANVAS_LOG), 'utf8'); } catch { return []; }
  return text.split(/\r?\n/).filter(Boolean).flatMap((line) => { try { return [JSON.parse(line)]; } catch { return []; } })
    .filter((e) => !since || e.time > since);
}
