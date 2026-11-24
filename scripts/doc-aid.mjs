// The part of a change's own document that an item of the target design, the
// finish or an amendment asks about, shown in the item: a section as written, or
// the one table row of the item's context. The documents stay whole in the
// appendix; this only saves the reviewer the walk there and back.
//
// Keys are a review item's id (A0, V1) or its letter (A: the item of one context).
// An id wins over its letter. `rows` names the section whose table has a row per
// context; the row whose first cell is the item's name is shown with its head.
import fs from 'node:fs';
import path from 'node:path';
import { section, plain } from './gate.mjs';
import { escapeHtml, markdown } from './render.mjs';

const MAP = {
  'spec-relay-target': {
    A0: { file: 'architecture.md', sections: [/^style$/i] },
    A90: { file: 'architecture.md', sections: [/^data ownership$/i] },
    A91: { file: 'architecture.md', sections: [/^boundary check$/i] },
    A: { file: 'architecture.md', rows: /^modules$/i },
    V1: { file: 'conventions.md', sections: [/^runtime and frameworks$/i] },
    V2: { file: 'conventions.md', sections: [/^language mapping$/i] },
    V3: { file: 'conventions.md', sections: [/^coding conventions$/i] },
    V4: { file: 'conventions.md', sections: [/^commands$/i] },
    E90: { file: 'verification.md', sections: [/^sign-in$/i, /^recorded data$/i] },
    E: { file: 'verification.md', rows: /^levels$/i },
    U90: { file: 'ui.md', sections: [/^shared look$/i, /^carried files$/i, /^client-side scripts$/i] },
    U: { file: 'ui.md', rows: /^screens$/i },
    D0: { file: 'data.md', sections: [/^schema policy$/i] },
    D90: { file: 'data.md', sections: [/^exceptions$/i] },
    D91: { file: 'data.md', sections: [/^data access mapping$/i] },
    D92: { file: 'data.md', sections: [/^schema changes$/i, /^test database$/i] },
    D: { file: 'data.md', rows: /^database logic$/i },
  },
  'spec-relay-finish': {
    C1: { file: 'checks.md', whole: true },
    H1: { file: 'handover.md', sections: [/^verdict$/i] },
    H2: { file: 'handover.md', sections: [/^before the switch$/i] },
  },
  'spec-relay-amend': {
    I1: { file: 'impact.md', whole: true },
  },
};

const WORDS = {
  ja: { from: (file) => `${file} より`, noRow: (file) => `${file} にこの項目の行がありません`, noSection: (file) => `${file} に該当する節がありません` },
  en: { from: (file) => `From ${file}`, noRow: (file) => `${file} has no row for this item`, noSection: (file) => `${file} has no such section` },
};

const anchor = (file) => `doc-${file.replace(/[^A-Za-z0-9]+/g, '-').toLowerCase()}`;
const tableCells = (line) => line.trim().replace(/^\|/, '').replace(/\|$/, '').split(/(?<!\\)\|/).map((c) => c.trim());

// The head of the table in `text` and the row whose first cell is `name`, as Markdown.
function rowOf(text, name) {
  const lines = text.split(/\r?\n/);
  for (let i = 0; i + 1 < lines.length; i += 1) {
    if (!/^\s*\|/.test(lines[i]) || !/^\s*\|?\s*:?-{2,}/.test(lines[i + 1])) continue;
    for (let j = i + 2; j < lines.length && /^\s*\|/.test(lines[j]); j += 1) {
      if (plain(tableCells(lines[j])[0] ?? '').toLowerCase() === name) return [lines[i], lines[i + 1], lines[j]].join('\n');
    }
  }
  return null;
}

// The material of one item, or '' when the kit has none for it.
export function docAid(dir, schema, item, code) {
  const all = MAP[schema];
  if (!all) return '';
  const spec = (item.id && all[item.id]) || (item.letter && all[item.letter]);
  if (!spec) return '';
  const W = WORDS[code === 'ja' ? 'ja' : 'en'];
  let text = null;
  try { text = fs.readFileSync(path.join(dir, spec.file), 'utf8').replace(/^﻿/, ''); } catch { return ''; }
  const src = `<p class="aid-src"><a href="#${anchor(spec.file)}">${escapeHtml(W.from(spec.file))}</a></p>`;
  let md = null;
  let missing = W.noSection(spec.file);
  if (spec.whole) md = text.replace(/^#\s[^\n]*\n/, '');
  else if (spec.rows) {
    const name = plain(String(item.title ?? '').split(/[:：]/)[0]).trim().toLowerCase();
    const part = section(text, spec.rows);
    md = part && name ? rowOf(part, name) : null;
    missing = W.noRow(spec.file);
  } else {
    const parts = spec.sections.map((re) => [re, section(text, re)]).filter(([, t]) => t !== null && t.trim());
    md = parts.length ? parts.map(([re, t]) => (parts.length > 1 ? `## ${headingOf(re)}\n${t}` : t)).join('\n\n') : null;
  }
  if (md === null || !md.trim()) return `<div class="doc aid-doc">${src}<p class="caution">${escapeHtml(missing)}</p></div>`;
  return `<div class="doc aid-doc">${src}${markdown(md, { headingOffset: 2 })}</div>`;
}

// A section's heading from the pattern that found it ("sign-in" -> "Sign-in").
const headingOf = (re) => { const t = re.source.replace(/^\^|\$$/g, ''); return t.charAt(0).toUpperCase() + t.slice(1); };

export const DOC_AID_CSS = `
.aid-doc{margin-top:10px;max-width:60em}
.aid-src{margin:0 0 4px;font:600 13px/1.4 var(--ui);color:var(--ink2)}
.aid-src a{color:inherit}

`;
