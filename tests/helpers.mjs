import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after } from 'node:test';
import { inventoryRows, scenarioList } from '../scripts/gate.mjs';
import { sourceMapPaths, surveyRowStamp } from '../scripts/coverage.mjs';
import { entryPoints } from '../scripts/walkthrough.mjs';

const made = [];
// Retries cover files a virus scanner or indexer still holds open on Windows.
after(() => { for (const dir of made) fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); });

export function tempDir(prefix = 'spec-relay-') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  made.push(dir);
  return dir;
}

export function write(dir, rel, text) {
  fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
  fs.writeFileSync(path.join(dir, rel), text);
}

export function quiet(fn) {
  const { log, error } = console;
  console.log = () => {}; console.error = () => {};
  try { return fn(); } finally { console.log = log; console.error = error; }
}

// Keeps OpenSpec away from the developer's own settings: `openspec init` and
// `openspec update` write a global profile (XDG_CONFIG_HOME wins on every
// platform, also over %APPDATA% on Windows) and send telemetry unless told not to.
// From 2.1.0 OpenSpec can also write skills to the home folder
// (~/.agents/skills) and keeps a list of projects there (~/.local/share), so
// the home folder is a temporary one too; npm keeps its usual cache.
export function isolateOpenspec() {
  const npmSetting = (name, value) => {
    if (!Object.keys(process.env).some((key) => key.toLowerCase() === name)) process.env[name] = value;
  };
  npmSetting('npm_config_cache', process.platform === 'win32'
    ? path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'), 'npm-cache')
    : path.join(os.homedir(), '.npm'));
  // The person's npm settings (registry, proxy, cafile) live in ~/.npmrc.
  npmSetting('npm_config_userconfig', path.join(os.homedir(), '.npmrc'));
  const home = tempDir('spec-relay-home-');
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  process.env.XDG_DATA_HOME = path.join(home, '.local', 'share');
  process.env.XDG_STATE_HOME = path.join(home, '.local', 'state');
  process.env.XDG_CONFIG_HOME = tempDir('spec-relay-config-');
  process.env.OPENSPEC_TELEMETRY = '0';
  process.env.NO_COLOR = '1';
}

export const crlf = (text) => text.replace(/\r?\n/g, '\r\n');

// The survey crosscheck that confirms every row of an inventory table, so a
// fixture about something else passes the survey gate's crosscheck.
export function confirmedSurveyCheck(inventory) {
  const rows = inventoryRows(String(inventory)).map((r) => `| \`${r.path}\` | confirmed <!-- row ${surveyRowStamp(r)} --> | read |`);
  return `# Crosscheck\n\n| Path | Verdict | Evidence |\n|---|---|---|\n${rows.join('\n')}\n`;
}

// Writes that crosscheck for the inventory a survey change holds now.
export function surveyChecked(dir, change = 'openspec/changes/survey') {
  write(dir, `${change}/crosscheck.md`, confirmedSurveyCheck(fs.readFileSync(path.join(dir, change, 'inventory.md'), 'utf8')));
  return dir;
}

// A walkthrough with one covered behavior per entry point.
export function walkthrough(entries, verdict = 'covered R1: s', evidence = 'src/calc.php:3') {
  return `# Walkthrough\n\n| Entry point | Behavior | Verdict | Evidence |\n|---|---|---|---|\n${entries.map((e) => `| \`${e}\` | the result | ${verdict} | ${evidence} |`).join('\n')}\n`;
}

// `write`, plus what the gate's AI checks need when a fixture is about
// something else: a survey's inventory comes with a crosscheck that confirms
// each row, and an extract's source map gets an entry point (when it lists
// none) with a walkthrough that names a scenario of every requirement and cites
// every line of the source-map files. The walkthrough is written again after
// every write while it is the helper's own (a test that writes its own keeps it).
const HELPER_WALK = '<!-- test helper walkthrough -->';
export function writeChecked(dir, rel, text) {
  let body = text;
  const map = rel.match(/^(openspec\/changes\/extract-[^/]+)\/source-map\.md$/);
  if (map && !/^##\s+(?:\d+[.)]?\s*)?(entry points?|入口)/im.test(text)) {
    body = `${text.replace(/\s*$/, '\n')}\n## Entry points\n- \`${sourceMapPaths(text)[0] ?? 'src/none.php'}\` - the entry\n`;
  }
  write(dir, rel, body);
  if (/^openspec\/changes\/survey[^/]*\/inventory\.md$/.test(rel)) write(dir, rel.replace(/inventory\.md$/, 'crosscheck.md'), confirmedSurveyCheck(text));
  let changes = [];
  try { changes = fs.readdirSync(path.join(dir, 'openspec/changes')).filter((n) => n.startsWith('extract-')); } catch { /* none */ }
  for (const name of changes) helperWalk(dir, `openspec/changes/${name}`);
}

function helperWalk(dir, change) {
  const read = (f) => { try { return fs.readFileSync(path.join(dir, change, f), 'utf8'); } catch { return null; } };
  const own = read('walkthrough.md');
  if (own !== null && !own.includes(HELPER_WALK)) return;
  const mapText = read('source-map.md');
  const specs = [];
  const walk = (d) => { try { for (const e of fs.readdirSync(path.join(dir, change, d), { withFileTypes: true })) { if (e.isDirectory()) walk(`${d}/${e.name}`); else if (e.name.endsWith('.md')) specs.push(`${d}/${e.name}`); } } catch { /* none */ } };
  walk('specs');
  const firsts = [];
  for (const { requirement, scenario } of scenarioList(specs.sort().map(read).join('\n'))) if (!firsts.some((f) => f.requirement === requirement)) firsts.push({ requirement, scenario });
  const entries = entryPoints(mapText ?? '') ?? [];
  if (!entries.length || !firsts.length) return;
  const files = [];
  const add = (p) => {
    const full = path.join(dir, p);
    let stat; try { stat = fs.statSync(full); } catch { return; }
    if (stat.isDirectory()) { for (const e of fs.readdirSync(full)) add(`${p.replace(/\/$/, '')}/${e}`); return; }
    const lines = fs.readFileSync(full, 'latin1').split(/\r\n|\r|\n/);
    const count = lines.length - (lines.at(-1) === '' ? 1 : 0);
    if (count > 0) files.push(`\`${p}:1-${count}\``);
  };
  for (const p of sourceMapPaths(mapText ?? '')) add(p);
  const evidence = files.length ? files.join('; ') : `${sourceMapPaths(mapText ?? '')[0] ?? entries[0].id}:1`;
  const rows = [];
  entries.forEach((e, i) => {
    const list = i === 0 ? firsts : firsts.slice(0, 1);
    list.forEach(({ scenario }, j) => rows.push(`| \`${e.id}\` | the result | covered R${firsts.indexOf(list[j]) + 1}: ${scenario} | ${evidence} |`));
  });
  write(dir, `${change}/walkthrough.md`, `# Walkthrough\n\n${HELPER_WALK}\n\n| Entry point | Behavior | Verdict | Evidence |\n|---|---|---|---|\n${rows.join('\n')}\n`);
}
