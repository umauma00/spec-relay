import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after } from 'node:test';
import { inventoryRows, scenarioList } from '../scripts/gate.mjs';
import { sourceMapPaths } from '../scripts/coverage.mjs';
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
  const rows = inventoryRows(String(inventory)).map((r) => `| \`${r.path}\` | confirmed | read |`);
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
// none) with a walkthrough that covers it by R1's first scenario (written again
// whenever the source map or the spec changes).
export function writeChecked(dir, rel, text) {
  let body = text;
  const map = rel.match(/^(openspec\/changes\/extract-[^/]+)\/source-map\.md$/);
  if (map && !/^##\s+(?:\d+[.)]?\s*)?(entry points?|入口)/im.test(text)) {
    body = `${text.replace(/\s*$/, '\n')}\n## Entry points\n- \`${sourceMapPaths(text)[0] ?? 'src/none.php'}\` - the entry\n`;
  }
  write(dir, rel, body);
  const change = rel.match(/^(openspec\/changes\/extract-[^/]+)\/(?:source-map\.md|specs\/.+\.md)$/)?.[1];
  if (change) {
    const read = (f) => { try { return fs.readFileSync(path.join(dir, change, f), 'utf8'); } catch { return null; } };
    const mapText = read('source-map.md');
    const specs = [];
    const walk = (d) => { try { for (const e of fs.readdirSync(path.join(dir, change, d), { withFileTypes: true })) { if (e.isDirectory()) walk(`${d}/${e.name}`); else if (e.name.endsWith('.md')) specs.push(`${d}/${e.name}`); } } catch { /* none */ } };
    walk('specs');
    const first = scenarioList(specs.sort().map(read).join('\n'))[0];
    const entry = entryPoints(mapText ?? '')?.[0]?.id;
    if (entry && first) write(dir, `${change}/walkthrough.md`, walkthrough([entry], `covered R1: ${first.scenario}`, `${sourceMapPaths(mapText)[0] ?? entry}:1 - read`));
  }
  if (/^openspec\/changes\/survey[^/]*\/inventory\.md$/.test(rel)) write(dir, rel.replace(/inventory\.md$/, 'crosscheck.md'), confirmedSurveyCheck(text));
}
