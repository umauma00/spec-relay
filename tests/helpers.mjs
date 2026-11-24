import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after } from 'node:test';

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
