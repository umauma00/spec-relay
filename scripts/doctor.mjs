#!/usr/bin/env node
// Checks, before a migration starts and at the start of every session, that
// this machine and the repository being migrated have what the spec-relay
// steps need, so that a migration does not stop halfway on something the
// environment lacks. Every problem comes with what the person should do.
//
//   node doctor.mjs [--target DIR] [--client cli|vscode|app] [--json] [--lang ja|en]
//       the environment checks
//   node doctor.mjs --trial [--target DIR]
//       after setup: the tasks of the subagent trial (JSON). The orchestrator
//       gives each to its subagent in one wave; each writes one small file
//       (the implementer's in the target root, where it writes during a port).
//   node doctor.mjs --trial-check [--target DIR] [--client cli|vscode|app] [--json] [--lang ja|en]
//       after that wave: checks what the trial subagents wrote, cleans up and
//       records a passed trial in openspec/spec-relay/local/trial.json
//
// Exit code 0: nothing blocks (warnings may remain), 1: something must be fixed
// first, 2: bad usage. --json prints ASCII-only JSON (\uXXXX escapes), so a
// Windows console code page cannot garble it.
//
// The checks change nothing in the repository. They write and remove one
// temporary file to test write access. --trial removes what an earlier trial
// left (openspec/spec-relay/work/trial/ and <target root>/spec-relay-trial.md);
// --trial-check removes them again and records a passed trial in
// openspec/spec-relay/local/trial.json (git-ignored).
//
// This file uses only syntax Node.js 14 can read, and loads the other kit
// modules after the Node.js check, so an old Node.js gets that check's message
// instead of a SyntaxError.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const KIT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const NODE_MIN = '22.12.0';
export const OPENSPEC_TESTED = '1.17.0';
// Recommended client versions: fixes for parallel subagents and their permission
// prompts (Copilot CLI 1.0.106-1.0.109); the Copilot harness is the VS Code default from 1.143.
export const CLIENT_MIN = { cli: '1.0.109', vscode: '1.143.0' };
export const TRIAL_DIR = 'openspec/spec-relay/work/trial';
// Per machine and client, so it stays out of git (local/ has its own .gitignore).
export const TRIAL_RECORD = 'openspec/spec-relay/local/trial.json';
const TRIAL_FILE = 'spec-relay-trial.md';
export const ROLES = ['analyst', 'checker', 'implementer'];
const CLIENTS = ['cli', 'vscode', 'app'];
// Paths inside the kit's own archive folders repeat the capability name; past
// this many characters in the repository path, Windows' 260-character limit is near.
const LONG_TARGET = 100;

// "1.2.3" or "v1.2.3 (extra)" -> [1, 2, 3], or null.
export function parseVersion(text) {
  const m = String(text || '').match(/(\d+)\.(\d+)(?:\.(\d+))?/);
  return m ? [Number(m[1]), Number(m[2]), Number(m[3] || 0)] : null;
}

export function compareVersions(a, b) {
  const x = typeof a === 'string' ? parseVersion(a) : a;
  const y = typeof b === 'string' ? parseVersion(b) : b;
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] < y[i] ? -1 : 1;
  return 0;
}

const showVersion = (v) => v.join('.');

// Windows environment names are case-insensitive.
function envValue(env, name) {
  const key = Object.keys(env).find((k) => k.toUpperCase() === name.toUpperCase());
  return key === undefined ? '' : (env[key] || '');
}

const ON = ['1', 'true', 'yes', 'on'];
const OFF = ['', '0', 'false', 'no', 'off'];
// The trimmed, lower-case value of an environment variable, or undefined when it is not set.
function setTo(env, name) {
  const key = Object.keys(env).find((k) => k.toUpperCase() === name);
  return key === undefined || env[key] === undefined ? undefined : String(env[key]).trim().toLowerCase();
}

// The same rules as OpenSpec 1.17.0 (src/telemetry): an opt-out in the
// environment, CI, or `telemetry.enabled: false` in the global config.
export function telemetryOff(env, platform, readFile) {
  const telemetry = setTo(env, 'OPENSPEC_TELEMETRY');
  if (telemetry !== undefined && !ON.includes(telemetry)) return 'OPENSPEC_TELEMETRY';
  const dnt = setTo(env, 'DO_NOT_TRACK');
  if (dnt !== undefined && !OFF.includes(dnt)) return 'DO_NOT_TRACK';
  const ci = setTo(env, 'CI');
  if (ci !== undefined && !OFF.includes(ci)) return 'CI';
  const xdg = envValue(env, 'XDG_CONFIG_HOME');
  const appData = envValue(env, 'APPDATA');
  const dir = xdg ? path.join(xdg, 'openspec')
    : platform === 'win32' ? path.join(appData || path.join(os.homedir(), 'AppData', 'Roaming'), 'openspec')
      : path.join(os.homedir(), '.config', 'openspec');
  const text = readFile(path.join(dir, 'config.json'));
  if (text === null) return null;
  try {
    const config = JSON.parse(text);
    return config && config.telemetry && config.telemetry.enabled === false ? 'config' : null;
  } catch {
    return 'config'; // OpenSpec treats an unreadable config as off
  }
}

// Which toolchain a target language needs from step 5 on. Commands are tried
// in order; the first that runs counts.
const TOOLCHAINS = [
  { match: /\bjava\b|kotlin|scala|spring/i, name: 'JDK', commands: [['java', ['-version']], ['javac', ['-version']]], all: true, install: 'winget install Microsoft.OpenJDK.21' },
  { match: /typescript|javascript|node/i, name: 'npm', commands: [['npm', ['--version'], 'npm/bin/npm-cli.js']], install: 'winget install OpenJS.NodeJS.LTS' },
  { match: /python/i, name: 'Python', commands: [['py', ['-3', '--version']], ['python', ['--version']], ['python3', ['--version']]], install: 'winget install Python.Python.3.13' },
  { match: /c#|csharp|\.net|dotnet|f#|vb/i, name: '.NET SDK', commands: [['dotnet', ['--version']]], install: 'winget install Microsoft.DotNet.SDK.9' },
  { match: /php/i, name: 'PHP', commands: [['php', ['--version']]], install: 'winget install PHP.PHP.8.4' },
  { match: /^go\b|golang/i, name: 'Go', commands: [['go', ['version']]], install: 'winget install GoLang.Go' },
  { match: /rust/i, name: 'Rust', commands: [['cargo', ['--version']]], install: 'winget install Rustlang.Rustup' },
];

export function toolchainFor(language) {
  return TOOLCHAINS.find((t) => t.match.test(language || '')) || null;
}

// --- the checks ------------------------------------------------------------
// Each returns { id, level: 'ok' | 'info' | 'warn' | 'fail', message, fix? }.
// `ctx.t(ja, en)` picks the person's language.

export function checkNode(ctx) {
  const v = parseVersion(ctx.nodeVersion);
  if (v && compareVersions(v, NODE_MIN) >= 0) return { id: 'node', level: 'ok', message: `Node.js ${showVersion(v)}` };
  return {
    id: 'node', level: 'fail',
    message: ctx.t(`Node.js ${ctx.nodeVersion} は古すぎます。${NODE_MIN} 以上が必要です（OpenSpec の要件）。`, `Node.js ${ctx.nodeVersion} is too old: ${NODE_MIN} or later is required (OpenSpec needs it).`),
    fix: ctx.t('`winget install OpenJS.NodeJS.LTS` で新しい版を入れ、新しいターミナルを開いてからもう一度確かめてください（macOS・Linux は https://nodejs.org/ から）。',
      'Install a current version (Windows: `winget install OpenJS.NodeJS.LTS`; macOS and Linux: https://nodejs.org/), open a new terminal and check again.'),
  };
}

export function checkKit(ctx) {
  const needed = [
    ...ctx.schemas.map((s) => `openspec-schemas/${s}/schema.yaml`),
    'templates/openspec-config.yaml',
    ...['setup', 'gate', 'status', 'merge', 'render', 'openspec'].map((s) => `scripts/${s}.mjs`),
    ...['orchestrator', 'analyst', 'checker', 'implementer'].map((a) => `com.github.copilot/agents/spec-relay-${a}.agent.md`),
    'skills/spec-relay/SKILL.md', 'skills/spec-relay-view/SKILL.md',
  ];
  const missing = needed.filter((rel) => !ctx.exists(path.join(ctx.kitRoot, rel)));
  if (!missing.length) return { id: 'kit', level: 'ok', message: `spec-relay ${ctx.kitVersion} (${ctx.kitRoot})` };
  return {
    id: 'kit', level: 'fail',
    message: ctx.t(`キットのファイルが欠けています: ${missing.slice(0, 5).join(', ')}${missing.length > 5 ? ` ほか ${missing.length - 5} 件` : ''}`,
      `kit files are missing: ${missing.slice(0, 5).join(', ')}${missing.length > 5 ? ` and ${missing.length - 5} more` : ''}`),
    fix: ctx.t('キットを入れ直してください（Copilot CLI: `copilot plugin uninstall spec-relay` のあと `copilot plugin install spec-relay@spec-relay-marketplace`。VS Code・Copilot app: プラグインを削除して入れ直す）。',
      'Reinstall the kit (Copilot CLI: `copilot plugin uninstall spec-relay`, then `copilot plugin install spec-relay@spec-relay-marketplace`; VS Code and the Copilot app: remove and add the plugin again).'),
  };
}

export function checkOpenspec(ctx) {
  const install = `npm install -g @fission-ai/openspec@${OPENSPEC_TESTED}`;
  const probe = ctx.probeOpenspec(ctx.target);
  if (!probe.ok) {
    const missing = /not found/.test(probe.reason);
    return {
      id: 'openspec', level: 'fail',
      message: missing ? ctx.t('OpenSpec CLI が見つかりません。', 'the OpenSpec CLI was not found.') : ctx.t(`OpenSpec CLI が動きません: ${probe.reason}`, `the OpenSpec CLI does not run: ${probe.reason}`),
      fix: ctx.t(`\`${install}\` で入れ、新しいターミナルを開いてください。PowerShell で「スクリプトの実行が無効」と出たら \`npm.cmd\` と打ちます。`,
        `Install it with \`${install}\` and open a new terminal. If PowerShell says running scripts is disabled, type \`npm.cmd\` instead of \`npm\`.`),
    };
  }
  const v = parseVersion(probe.version);
  if (!v) return { id: 'openspec', level: 'warn', message: ctx.t(`OpenSpec の版を読めません: ${probe.version}`, `cannot read the OpenSpec version: ${probe.version}`), fix: ctx.t(`\`${install}\` で入れ直してください。`, `Reinstall it with \`${install}\`.`) };
  const cmp = compareVersions(v, OPENSPEC_TESTED);
  if (cmp === 0) return { id: 'openspec', level: 'ok', message: `OpenSpec ${showVersion(v)}` };
  if (cmp < 0) {
    return {
      id: 'openspec', level: 'fail',
      message: ctx.t(`OpenSpec ${showVersion(v)} は古く、キットのスキーマを扱えない場合があります（確認済みは ${OPENSPEC_TESTED}）。`, `OpenSpec ${showVersion(v)} is older than ${OPENSPEC_TESTED}, the version the kit is tested with, and may not handle its schemas.`),
      fix: ctx.t(`\`${install}\` で入れ直してください。`, `Install the tested version: \`${install}\`.`),
    };
  }
  return {
    id: 'openspec', level: 'warn',
    message: ctx.t(`OpenSpec ${showVersion(v)} は、キットが確認した ${OPENSPEC_TESTED} より新しい版です。archive などの動きが変わっている可能性があります。`, `OpenSpec ${showVersion(v)} is newer than ${OPENSPEC_TESTED}, the version the kit is tested with; archive and validation may behave differently.`),
    fix: ctx.t(`このまま進めてもかまいません。途中で OpenSpec のエラーが出たら \`${install}\` で確認済みの版に戻してください。`, `You may continue. If OpenSpec reports errors later, go back to the tested version: \`${install}\`.`),
  };
}

// The kit's scripts also look in npm's global folder; a terminal opened before
// the install (or an app started before it) does not have it on PATH, so the
// agent's own `openspec` commands would fail there.
export function checkOpenspecPath(ctx) {
  if (ctx.platform !== 'win32' || ctx.openspecOnPath()) return null;
  return {
    id: 'openspec-path', level: 'warn',
    message: ctx.t('OpenSpec は入っていますが、このターミナルの PATH にありません（入れる前に開いたターミナルやアプリでよく起きます）。オーケストレーターが打つ `openspec` コマンドが「認識されません」で止まります。', 'OpenSpec is installed but not on this terminal\'s PATH (common in a terminal or app opened before the install); the orchestrator\'s own `openspec` commands fail with "not recognized".'),
    fix: ctx.t('新しいターミナルを開くか、Copilot のアプリ（VS Code・Copilot app）を再起動してから続けてください。', 'Open a new terminal, or restart the Copilot client (VS Code, the Copilot app), then continue.'),
  };
}

export function checkTelemetry(ctx) {
  const off = telemetryOff(ctx.env, ctx.platform, ctx.readFile);
  if (off) return { id: 'telemetry', level: 'ok', message: ctx.t(`OpenSpec の利用統計の送信は止まっています（${off}）。`, `OpenSpec usage statistics are off (${off}).`) };
  return {
    id: 'telemetry', level: 'info',
    message: ctx.t('OpenSpec は初期設定で匿名の利用統計（コマンド名と版）を送ります。コードや仕様の中身は送りません。', 'OpenSpec sends anonymous usage statistics (command name and version) by default; no code or spec content.'),
    fix: ctx.t('止めるときは `openspec config set telemetry.enabled false` を実行します（この PC のすべてのプロジェクトに効きます）。環境変数 `OPENSPEC_TELEMETRY=0` でも止まります。キットはこの設定を変えません。',
      'To turn it off, run `openspec config set telemetry.enabled false` (all projects on this machine), or set `OPENSPEC_TELEMETRY=0`. The kit never changes this setting.'),
  };
}

// Windows PowerShell refuses npm's openspec.ps1 shim under the default policy.
// The kit's scripts never go through it; the person and the agent must type openspec.cmd.
export function checkPowershell(ctx) {
  if (ctx.platform !== 'win32') return null;
  const shim = ctx.findInPath('openspec.ps1');
  if (!shim) return null;
  // Windows PowerShell 5.1 and PowerShell 7 keep separate policies; the agent's shell may be either.
  const blocked = (ctx.executionPolicy() || []).filter((p) => /^(restricted|allsigned|undefined)$/i.test(p.policy));
  if (!blocked.length) return null;
  const which = blocked.map((p) => `${p.shell} ${p.policy}`).join(', ');
  return {
    id: 'powershell', level: 'info',
    message: ctx.t(`PowerShell の実行ポリシー（${which}）のため、そこで \`openspec\` と打つと「スクリプトの実行が無効」で止まります。`, `the PowerShell execution policy (${which}) stops a typed \`openspec\` there with "running scripts is disabled".`),
    fix: ctx.t('`openspec.cmd` と打てば動きます（オーケストレーターもそうします）。ポリシーを変えるかはご自身で判断してください（`Set-ExecutionPolicy -Scope CurrentUser RemoteSigned`）。',
      'Type `openspec.cmd` instead (the orchestrator does). Whether to change the policy is your decision (`Set-ExecutionPolicy -Scope CurrentUser RemoteSigned`).'),
  };
}

export function checkGit(ctx) {
  const git = ctx.exec('git', ['--version'], { cwd: ctx.target });
  if (!git.found || git.status !== 0) {
    return [{
      id: 'git', level: 'warn', message: git.found ? ctx.t('git が動きません（`git --version` が失敗します）。', 'git does not run (`git --version` fails).') : ctx.t('git が見つかりません。', 'git was not found.'),
      fix: ctx.t('`winget install Git.Git` で入れてください。git がなくても動きますが、元ファイルの一覧にビルドの出力（bin/・obj/ など）が混ざり、サブエージェントが割り当て外のファイルを変えたことも見つけにくくなります。',
        'Install it (`winget install Git.Git`). The kit runs without git, but the source file list then includes build output (bin/, obj/) and edits outside a subagent\'s assignment are harder to see.'),
    }];
  }
  const results = [{ id: 'git', level: 'ok', message: (git.stdout || '').trim() || 'git' }];
  const top = ctx.exec('git', ['rev-parse', '--show-toplevel'], { cwd: ctx.target });
  const stderr = top.stderr || '';
  if (/dubious ownership|safe\.directory/i.test(stderr)) {
    // Git prints the exact command, including the %(prefix)/// form network folders need.
    const suggested = stderr.match(/git config --global --add safe\.directory\s+(.+?)\s*$/m);
    const command = suggested ? `git config --global --add safe.directory ${suggested[1]}` : `git config --global --add safe.directory "${ctx.target.replace(/\\/g, '/')}"`;
    results.push({
      id: 'git-repo', level: 'warn',
      message: ctx.t('git がこのフォルダーを「所有者が違う」として拒否しています（別のドライブや別のユーザーが作ったフォルダーでよく起きます）。このままでは git を使う確認が働きません。', 'git refuses this folder as owned by someone else (common on another drive or a folder another user created); the kit\'s git checks cannot work.'),
      fix: ctx.t(`\`${command}\` を実行してください（git の全体設定を変えるので、ご自身で判断してください）。`, `Run \`${command}\` (it changes git's global config, so it is your decision).`),
    });
  } else if (top.status !== 0) {
    results.push({
      id: 'git-repo', level: 'warn',
      message: ctx.t('このフォルダーは git リポジトリではありません。', 'this folder is not a git repository.'),
      fix: ctx.t('移行前の状態に戻せるよう、`git init` のあと今のファイルをコミットしてから始めることを勧めます。git がないと、元ファイルの一覧にビルドの出力が混ざります。',
        'Run `git init` and commit the current files first, so you can always go back. Without it, the source file list includes build output.'),
    });
  } else {
    const same = ctx.samePath((top.stdout || '').trim(), ctx.target);
    if (!same) {
      results.push({
        id: 'git-repo', level: 'warn',
        message: ctx.t(`リポジトリの一番上（${(top.stdout || '').trim()}）ではなく、その中のフォルダーで実行しています。`, `this is a folder inside the repository, not its top (${(top.stdout || '').trim()}).`),
        fix: ctx.t('リポジトリの一番上のフォルダーを開いて始めてください。中のフォルダーだと、元ファイルの一覧に git が無視するファイルまで入ります。', 'Open the repository\'s top folder instead; from a subfolder the source file list also includes files git ignores.'),
      });
    } else {
      // Uncommitted changes matter before setup only: during a migration there always are some.
      const dirty = ctx.setUp ? null : ctx.exec('git', ['status', '--porcelain'], { cwd: ctx.target });
      if (dirty && dirty.status === 0 && (dirty.stdout || '').trim()) {
        results.push({
          id: 'git-repo', level: 'info',
          message: ctx.t('コミットしていない変更があります。', 'there are uncommitted changes.'),
          fix: ctx.t('導入の前にコミットしておくと、キットが加えたものだけを見分けて戻せます。', 'Commit them before setup, so the kit\'s changes stay separate and easy to undo.'),
        });
      } else {
        results.push({ id: 'git-repo', level: 'ok', message: ctx.t('git リポジトリの一番上です。', 'the top of a git repository.') });
      }
    }
  }
  if (ctx.platform === 'win32' && ctx.target.length > LONG_TARGET) {
    const longpaths = ctx.exec('git', ['config', '--get', 'core.longpaths'], { cwd: ctx.target });
    if ((longpaths.stdout || '').trim().toLowerCase() !== 'true') {
      results.push({
        id: 'long-paths', level: 'warn',
        message: ctx.t(`フォルダーのパスが ${ctx.target.length} 文字あります。archive の中ではパスが長くなり、Windows の 260 文字の制限に当たることがあります。`, `the folder path is ${ctx.target.length} characters long; paths inside the archive grow and may hit Windows' 260-character limit.`),
        fix: ctx.t('`C:\\work\\proj` のような短い場所に移すか、`git config --global core.longpaths true` で git の長いパスを有効にしてください。', 'Move the repository to a short path such as `C:\\work\\proj`, or let git use long paths: `git config --global core.longpaths true`.'),
      });
    }
  }
  return results;
}

export function checkTarget(ctx) {
  const results = [];
  if (!ctx.isDir(ctx.target)) {
    return [{ id: 'target', level: 'fail', message: ctx.t(`フォルダーがありません: ${ctx.target}`, `not a folder: ${ctx.target}`), fix: ctx.t('移行するリポジトリのフォルダーを開いて（または --target で指定して）実行してください。', 'Run it in (or pass --target) the folder of the repository to migrate.') }];
  }
  const error = ctx.tryWrite(ctx.target);
  if (error) {
    results.push({
      id: 'target', level: 'fail',
      message: ctx.t(`このフォルダーに書き込めません（${error}）。`, `cannot write to this folder (${error}).`),
      fix: ctx.t('読み取り専用でないか、Program Files の下でないかを確かめてください。Windows のセキュリティの「コントロールされたフォルダー アクセス」が有効だと、ドキュメントやデスクトップの下に Node.js が書き込めません。その場合は `C:\\work\\proj` のような場所に移すか、node.exe を許可してください。',
        'Check that the folder is not read-only or under Program Files. Windows Security\'s "Controlled folder access" blocks Node.js from writing under Documents and Desktop: move the repository to a folder such as `C:\\work\\proj`, or allow node.exe.'),
    });
  } else {
    results.push({ id: 'target', level: 'ok', message: ctx.t(`書き込めます: ${ctx.target}`, `writable: ${ctx.target}`) });
  }
  if (ctx.platform === 'win32' && /^\\\\/.test(ctx.target)) {
    results.push({
      id: 'network-folder', level: 'warn',
      message: ctx.t('ネットワーク上のフォルダー（\\\\ で始まるパス）です。cmd.exe はここを作業フォルダーにできないため、`openspec.cmd` や `npm.cmd` を使うコマンドが止まります。ファイルの移動も遅く、ロックで失敗しやすくなります。', 'this is a network folder (a \\\\ path). cmd.exe cannot work in it, so commands through `openspec.cmd` or `npm.cmd` stop, and folder moves are slow and fail on locks more often.'),
      fix: ctx.t('リポジトリを手元のドライブ（`C:\\work\\proj` など）に置いて使ってください。', 'Work on a local copy of the repository (for example `C:\\work\\proj`).'),
    });
  }
  const synced = syncedFolder(ctx);
  if (synced) {
    results.push({
      id: 'sync-folder', level: 'warn',
      message: ctx.t(`${synced} で同期しているフォルダーの中です。同期中のファイルはロックされ、OpenSpec の archive（フォルダーの移動）が EPERM や EBUSY で失敗することがあります。`, `the folder is synchronised by ${synced}. Files being uploaded are locked, and OpenSpec's archive (a folder move) can fail with EPERM or EBUSY.`),
      fix: ctx.t('同期しない場所（`C:\\work\\proj` など）にリポジトリを置くか、移行の間は同期を一時停止してください。', 'Keep the repository outside the synchronised folder (for example `C:\\work\\proj`), or pause synchronisation during the migration.'),
    });
  }
  return results;
}

function syncedFolder(ctx) {
  const here = ctx.target.replace(/\\/g, '/').toLowerCase();
  for (const name of ['OneDrive', 'OneDriveCommercial', 'OneDriveConsumer']) {
    const dir = envValue(ctx.env, name).replace(/\\/g, '/').toLowerCase().replace(/\/+$/, '');
    if (dir && (here === dir || here.startsWith(`${dir}/`))) return 'OneDrive';
  }
  // Box Drive's folder has a common name, so only the one directly in the home folder counts.
  const home = (ctx.home || '').replace(/\\/g, '/').toLowerCase().replace(/\/+$/, '');
  if (home && (here === `${home}/box` || here.startsWith(`${home}/box/`))) return 'Box';
  const parts = ctx.target.split(/[\\/]+/);
  const hit = parts.find((p) => /^(onedrive( - .*)?|dropbox|google drive|icloud ?drive)$/i.test(p));
  return hit ? hit.replace(/ - .*/, '') : null;
}

// What setup left in the repository, and whether it still matches this kit.
export function checkSetup(ctx) {
  const configFile = path.join(ctx.target, 'openspec/config.yaml');
  const config = ctx.readFile(configFile);
  if (config === null) {
    if (ctx.readFile(path.join(ctx.target, 'openspec/config.yml')) !== null) {
      return [{ id: 'setup', level: 'warn', message: ctx.t('OpenSpec の設定 openspec/config.yml がすでにあります。導入スクリプトはここで止まります。', 'an OpenSpec config openspec/config.yml exists; setup stops on it.'), fix: ctx.t('キットの templates/openspec-config.yaml の内容を手で取り込んでください。', 'Merge the kit\'s templates/openspec-config.yaml into it by hand.') }];
    }
    return [{ id: 'setup', level: 'info', message: ctx.t('まだ導入していません。', 'spec-relay is not set up in this repository yet.'), fix: ctx.t('次は導入です（オーケストレーターが setup.mjs を実行します）。', 'Next: setup (the orchestrator runs setup.mjs).') }];
  }
  const text = ctx.normalizeText(config);
  if (!text.includes(ctx.configMarker)) {
    return [{ id: 'setup', level: 'warn', message: ctx.t('OpenSpec の設定 openspec/config.yaml がすでにあります。導入スクリプトはここで止まります。', 'an OpenSpec config openspec/config.yaml exists; setup stops on it.'), fix: ctx.t('キットの templates/openspec-config.yaml の内容を手で取り込んでください。', 'Merge the kit\'s templates/openspec-config.yaml into it by hand.') }];
  }
  const results = [];
  const differs = [];
  for (const schema of ctx.schemas) {
    const from = path.join(ctx.kitRoot, 'openspec-schemas', schema);
    for (const rel of ctx.listFiles(from)) {
      const theirs = ctx.readFile(path.join(ctx.target, 'openspec/schemas', schema, rel));
      const ours = ctx.readFile(path.join(from, rel));
      if (theirs === null || ctx.normalizeText(theirs) !== ctx.normalizeText(ours || '')) differs.push(`openspec/schemas/${schema}/${rel.replace(/\\/g, '/')}`);
    }
  }
  if (differs.length) {
    results.push({
      id: 'schemas', level: 'fail',
      message: ctx.t(`openspec/schemas のスキーマが、このキット（${ctx.kitVersion}）の版と違います: ${differs.slice(0, 3).join(', ')}${differs.length > 3 ? ` ほか ${differs.length - 3} 件` : ''}`,
        `the schemas in openspec/schemas differ from this kit (${ctx.kitVersion}): ${differs.slice(0, 3).join(', ')}${differs.length > 3 ? ` and ${differs.length - 3} more` : ''}`),
      fix: ctx.t('キットを更新したときは、README の「〜から更新するとき」の手順に従ってください。手で書き換えた場合は元に戻してください。違うスキーマのまま進めると、途中で成果物や確認が合わなくなります。',
        'If you updated the kit, follow "Updating from ..." in the README. If someone edited them, restore them. With other schemas, artifacts and gates stop matching midway.'),
    });
  } else {
    results.push({ id: 'schemas', level: 'ok', message: ctx.t(`スキーマはこのキットの版と同じです（${ctx.schemas.length} 個）。`, `the schemas match this kit (${ctx.schemas.length}).`) });
  }
  const bypass = ctx.bypassFiles(ctx.target);
  if (bypass.length) {
    results.push({
      id: 'workflows', level: 'fail',
      message: ctx.t(`OpenSpec 標準の apply・archive・sync が元に戻っています（\`openspec update\` のあとによく起きます）: ${bypass.map((f) => path.relative(ctx.target, f).replace(/\\/g, '/')).join(', ')}`,
        `OpenSpec's generic apply, archive or sync workflows are back (usually after \`openspec update\`): ${bypass.map((f) => path.relative(ctx.target, f).replace(/\\/g, '/')).join(', ')}`),
      fix: ctx.t('これらはレビューの確認を通らずに archive できてしまいます。導入スクリプトをもう一度実行してください（オーケストレーターが openspec/config.yaml の値で実行します）。', 'They archive without the review gate. Run setup again (the orchestrator runs it with the values in openspec/config.yaml).'),
    });
  }
  const sourceRoot = ctx.cleanValue(ctx.configValue(ctx.target, 'Source root', '.'));
  const sourceDir = path.resolve(ctx.target, sourceRoot);
  if (!ctx.isDir(sourceDir)) {
    results.push({
      id: 'source-root', level: 'fail',
      message: ctx.t(`openspec/config.yaml の元コードのフォルダー「${sourceRoot}」がありません。`, `the source root "${sourceRoot}" in openspec/config.yaml does not exist.`),
      fix: ctx.t('フォルダーの名前を変えたり移したりした場合は、openspec/config.yaml の「Source root」を今のフォルダーに直してください。', 'If the folder was renamed or moved, correct "Source root" in openspec/config.yaml.'),
    });
  }
  if (ctx.configValue(ctx.target, 'Parallel subagents', null) === null) {
    results.push({
      id: 'config', level: 'warn',
      message: ctx.t('openspec/config.yaml に並列化の設定がありません（0.2.0 以前の導入）。既定値（4・2・session）で動きます。', 'openspec/config.yaml has no parallel settings (set up with 0.2.0 or earlier); the defaults (4, 2, session) apply.'),
      fix: ctx.t('README の「0.2.0 から更新するとき」の5行を context に足してください。', 'Add the five lines from "Updating from 0.2.0" in the README to its context.'),
    });
  }
  const tool = toolchainFor(ctx.cleanValue(ctx.configValue(ctx.target, 'Target language', '')));
  if (tool) results.push(checkToolchain(ctx, tool));
  results.push(checkTrialRecord(ctx));
  return results;
}

function checkToolchain(ctx, tool) {
  const found = [];
  for (const [name, args, npmScript] of tool.commands) {
    const r = ctx.exec(name, args, { cwd: ctx.target, npmScript });
    if (r.found && r.status === 0) {
      const first = `${r.stdout || ''}\n${r.stderr || ''}`.trim().split(/\r?\n/)[0];
      found.push(first.toLowerCase().startsWith(name) ? first : `${name} ${first}`);
      if (!tool.all) break;
    } else if (tool.all) {
      found.length = 0;
      break;
    }
  }
  if (found.length) return { id: 'toolchain', level: 'ok', message: found.join('; ') };
  return {
    id: 'toolchain', level: 'warn',
    message: ctx.t(`移行先の言語に使う ${tool.name} が見つかりません。工程 5（実装）のビルドとテストで必要になります。`, `${tool.name} for the target language was not found; step 5 (implementation) needs it to build and test.`),
    fix: ctx.t(`実装を始める前に入れてください（例: \`${tool.install}\`。版は移行先の設計の conventions.md に合わせます）。入れたら新しいターミナルを開きます。`, `Install it before implementation starts (for example \`${tool.install}\`; match the version in the target design's conventions.md), then open a new terminal.`),
  };
}

// The trial proves, once per client and machine, that the three subagents start,
// accept their models and may write files. Models changed since -> run it again.
export function trialRun(ctx) {
  const runs = (readJson(ctx.readFile(path.join(ctx.target, TRIAL_RECORD))) || {}).runs || {};
  const mine = Object.keys(runs).filter((key) => key.split('/')[0] === ctx.machine).map((key) => runs[key]);
  if (ctx.client) return mine.find((run) => run.client === ctx.client) || (mine.length ? { otherClient: mine[0].client } : null);
  return mine[0] || null;
}

function checkTrialRecord(ctx) {
  const record = trialRun(ctx);
  const models = configModels(ctx);
  const again = (why) => ({
    id: 'trial', level: 'warn',
    message: why,
    fix: ctx.t('オーケストレーターがサブエージェントの試運転（3つの小さな作業）を1回行います。各サブエージェントがファイルを1つ書くので、許可の確認が出たら許可してください。', 'The orchestrator runs the subagent trial once (three tiny tasks). Each subagent writes one file: allow it when asked.'),
  });
  if (trialLeftovers(ctx).length) return again(ctx.t('終わっていない試運転のファイルが残っています。', 'an unfinished trial left its files.'));
  if (record && record.otherClient) return again(ctx.t(`この PC では別のアプリ（${record.otherClient}）でしか試運転していません。`, `on this machine the trial ran only in another client (${record.otherClient}).`));
  if (!record) return again(ctx.t('この PC ではサブエージェントの試運転をまだしていません。', 'the subagent trial has not run on this machine yet.'));
  const changed = ROLES.filter((r) => (record.models || {})[r] !== models[r]);
  if (changed.length) return again(ctx.t(`試運転のあとでモデルの設定が変わりました（${changed.join(', ')}）。`, `the model settings changed since the trial (${changed.join(', ')}).`));
  return { id: 'trial', level: 'ok', message: ctx.t(`サブエージェントの試運転は済んでいます（${record.date}、${record.client || 'アプリ不明'}）。`, `the subagent trial passed (${record.date}, ${record.client || 'client unknown'}).`) };
}

export function checkClient(ctx) {
  let client = ctx.client;
  const vscodeVersion = envValue(ctx.env, 'TERM_PROGRAM').toLowerCase() === 'vscode' ? envValue(ctx.env, 'TERM_PROGRAM_VERSION') : '';
  if (!client && vscodeVersion) client = 'vscode';
  if (!client) {
    return { id: 'client', level: 'info', message: ctx.t('Copilot のアプリを指定していないので、アプリの版は確かめていません。', 'no client given, so the Copilot client version is not checked.'), fix: ctx.t('`--client cli`、`--client vscode`、`--client app` のどれかを付けると確かめます。', 'Pass `--client cli`, `--client vscode` or `--client app` to check it.') };
  }
  if (client === 'cli') {
    const r = ctx.exec('copilot', ['--version'], { cwd: ctx.target, npmScript: '@github/copilot/npm-loader.js' });
    const v = r.found && r.status === 0 ? parseVersion(r.stdout) : null;
    if (!v) {
      return { id: 'client', level: 'info', message: ctx.t('copilot コマンドの版を読めませんでした。', 'could not read the copilot command\'s version.'), fix: ctx.t(`\`copilot --version\` が ${CLIENT_MIN.cli} 以上か確かめてください。古ければ \`copilot update\` で更新します。`, `Check that \`copilot --version\` is ${CLIENT_MIN.cli} or later; update with \`copilot update\`.`) };
    }
    if (compareVersions(v, CLIENT_MIN.cli) >= 0) return { id: 'client', level: 'ok', message: `Copilot CLI ${showVersion(v)}` };
    return {
      id: 'client', level: 'warn',
      message: ctx.t(`Copilot CLI ${showVersion(v)} は古い版です。並列のサブエージェントと許可の確認の修正が ${CLIENT_MIN.cli} までに入っています。`, `Copilot CLI ${showVersion(v)} is older than ${CLIENT_MIN.cli}, which has fixes for parallel subagents and their permission prompts.`),
      fix: ctx.t('`copilot update` で更新してください（npm で入れた場合は `npm install -g @github/copilot`、winget なら `winget upgrade GitHub.Copilot`）。', 'Update with `copilot update` (npm: `npm install -g @github/copilot`; winget: `winget upgrade GitHub.Copilot`).'),
    };
  }
  if (client === 'vscode') {
    const v = parseVersion(vscodeVersion);
    if (!v) return { id: 'client', level: 'info', message: ctx.t('VS Code の版を読めませんでした。', 'could not read the VS Code version.'), fix: ctx.t(`ヘルプ → バージョン情報で ${CLIENT_MIN.vscode} 以上か、チャットが Copilot ハーネスで動いているかを確かめてください。`, `Check Help > About for ${CLIENT_MIN.vscode} or later, and that chat runs on the Copilot harness.`) };
    if (compareVersions(v, CLIENT_MIN.vscode) >= 0) return { id: 'client', level: 'ok', message: `VS Code ${showVersion(v)}` };
    return {
      id: 'client', level: 'warn',
      message: ctx.t(`VS Code ${showVersion(v)} は古い版です。キットは ${CLIENT_MIN.vscode} から既定になった Copilot ハーネスを前提にしています。`, `VS Code ${showVersion(v)} is older than ${CLIENT_MIN.vscode}, where the Copilot harness the kit expects became the default.`),
      fix: ctx.t('ヘルプ → 更新の確認 で更新し、チャットを Copilot ハーネスで使ってください。', 'Update with Help > Check for Updates and use chat on the Copilot harness.'),
    };
  }
  return { id: 'client', level: 'info', message: ctx.t('Copilot app の版はスクリプトから確かめられません。', 'the Copilot app\'s version cannot be checked from a script.'), fix: ctx.t('アプリを最新にしておいてください。サブエージェントが使えるかは試運転で確かめます。', 'Keep the app up to date; the subagent trial checks that subagents work.') };
}

function readJson(text) {
  if (text === null || text === undefined) return null;
  try { return JSON.parse(text); } catch { return null; }
}

function configModels(ctx) {
  const models = {};
  for (const role of ROLES) {
    const value = ctx.cleanValue(ctx.configValue(ctx.target, `${role[0].toUpperCase()}${role.slice(1)} model`, 'session') || 'session');
    models[role] = !value || value.toLowerCase() === 'session' ? 'session' : value;
  }
  return models;
}

export function runChecks(ctx) {
  const target = checkTarget(ctx);
  // Without the folder, the checks that run commands in it would only add confusing errors.
  if (!ctx.isDir(ctx.target)) return [checkNode(ctx), checkKit(ctx), ...target];
  const openspec = checkOpenspec(ctx);
  return [checkNode(ctx), checkKit(ctx), openspec, openspec.level === 'fail' ? null : checkOpenspecPath(ctx), checkTelemetry(ctx), checkPowershell(ctx), checkClient(ctx)]
    .concat(checkGit(ctx), target, checkSetup(ctx))
    .filter(Boolean);
}

// --- the subagent trial ----------------------------------------------------

// The analyst and the checker write in the work folder, the implementer in the
// target root, where it writes during a port: the trial meets the same
// permission prompts (and VS Code auto-approve patterns) as the real work.
export function trialTasks(ctx) {
  const models = configModels(ctx);
  const targetRoot = ctx.cleanValue(ctx.configValue(ctx.target, 'Target root', '')).replace(/\\/g, '/').replace(/\/+$/, '');
  return ROLES.map((role) => {
    const file = role === 'implementer' && targetRoot ? `${targetRoot}/${TRIAL_FILE}` : `${TRIAL_DIR}/${role}.md`;
    const line = `spec-relay trial: ${role}`;
    // The implementer also runs a command: a port runs builds and tests, and shell commands have their own permission prompt.
    const task = role === 'implementer'
      ? `spec-relay environment trial. Run the command \`node --version\`, then create the file ${file} with two lines: first exactly ${line}, then the command's output. Do not read, create or change anything else. Reply with one word: done.`
      : `spec-relay environment trial. Create the file ${file} containing exactly this one line: ${line}. Do not read, create or change anything else. Reply with one word: done.`;
    return { role, agent: `spec-relay-${role}`, model: models[role], file, line, task };
  });
}

export function checkTrial(ctx) {
  const results = trialTasks(ctx).map((task) => {
    const text = ctx.readFile(path.join(ctx.target, task.file));
    const lines = text === null ? [] : ctx.normalizeText(text).split('\n').map((l) => l.trim());
    const ran = task.role !== 'implementer' || lines.some((l) => /^v\d+\.\d+/.test(l));
    if (lines.includes(task.line) && ran) {
      return { id: `trial-${task.role}`, level: 'ok', message: ctx.t(`${task.agent} が起動し、ファイルを書けました（モデル: ${task.model}）。`, `${task.agent} started and wrote its file (model: ${task.model}).`) };
    }
    const why = text === null ? ctx.t('ファイルがありません', 'no file')
      : !lines.includes(task.line) ? ctx.t('中身が違います（UTF-8 で書かれていないか、別の内容）', 'unexpected content (not UTF-8, or other text)')
        : ctx.t('`node --version` の結果がありません（コマンドの実行が許可されなかった可能性があります）', 'no `node --version` output (running the command may have been declined)');
    return {
      id: `trial-${task.role}`, level: 'fail',
      message: ctx.t(`${task.agent} の試運転が通りませんでした（${why}: ${task.file}）。`, `the trial of ${task.agent} failed (${why}: ${task.file}).`),
      fix: ctx.t(
        `その呼び出しの返事を確かめてください。(1) エージェントが見つからない: キットのプラグインが入っているか、VS Code では Copilot ハーネスで使っているか。Copilot CLI では \`/subagents\` でサブエージェントが無効になっていないか。(2) モデルのエラー: openspec/config.yaml の「${task.role[0].toUpperCase()}${task.role.slice(1)} model」を \`session\` か、契約で使えるモデル名にする。(3) 許可を断った: ファイル編集（実装担当はコマンドの実行も）を許可して試運転をやり直す。直したらもう一度試運転します。`,
        `Read that call's reply. (1) Agent not found: is the kit plugin installed, and in VS Code is chat on the Copilot harness? In Copilot CLI, are subagents turned on in \`/subagents\`? (2) A model error: set "${task.role[0].toUpperCase()}${task.role.slice(1)} model" in openspec/config.yaml to \`session\` or a model your plan offers. (3) A permission was declined: allow file edits (and, for the implementer, running commands) and run the trial again. Then run the trial again.`),
    };
  });
  return results;
}

// What a trial may have left: its folder and the implementer's file.
function trialLeftovers(ctx) {
  return [TRIAL_DIR, ...trialTasks(ctx).filter((t) => !t.file.startsWith(`${TRIAL_DIR}/`)).map((t) => t.file)]
    .filter((rel) => ctx.exists(path.join(ctx.target, rel)));
}

const CREATED = `${TRIAL_DIR}/created.json`;

// Before a trial: removes an earlier trial's files and notes the folders the
// implementer's file will create, so that cleaning up removes only those.
function startTrial(ctx) {
  cleanTrial(ctx);
  const created = [];
  for (const task of trialTasks(ctx).filter((t) => !t.file.startsWith(`${TRIAL_DIR}/`))) {
    let dir = path.dirname(task.file);
    while (dir && dir !== '.' && !ctx.exists(path.join(ctx.target, dir))) { created.push(dir); dir = path.dirname(dir); }
  }
  fs.mkdirSync(path.join(ctx.target, TRIAL_DIR), { recursive: true });
  fs.writeFileSync(path.join(ctx.target, CREATED), `${JSON.stringify(created)}\n`);
}

// Removes what a trial wrote, and only the folders it created (deepest first).
// A file a scanner or a sync client still holds is retried, and a failure only warns.
function cleanTrial(ctx) {
  const created = readJson(ctx.readFile(path.join(ctx.target, CREATED))) || [];
  const retry = { recursive: true, force: true, maxRetries: 5, retryDelay: 200 };
  try {
    for (const task of trialTasks(ctx).filter((t) => !t.file.startsWith(`${TRIAL_DIR}/`))) fs.rmSync(path.join(ctx.target, task.file), retry);
    fs.rmSync(path.join(ctx.target, TRIAL_DIR), retry);
    for (const dir of created.slice().sort((a, b) => b.length - a.length)) {
      try { fs.rmdirSync(path.join(ctx.target, dir)); } catch { /* not empty: the person's files */ }
    }
    return null;
  } catch (error) {
    return error.code || error.message;
  }
}

function saveTrial(ctx) {
  const file = path.join(ctx.target, TRIAL_RECORD);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const ignore = path.join(path.dirname(file), '.gitignore');
  if (!fs.existsSync(ignore)) fs.writeFileSync(ignore, '# spec-relay: results that belong to one machine; never committed.\n*\n');
  const saved = readJson(ctx.readFile(file)) || {};
  const runs = saved.runs || {};
  runs[`${ctx.machine}/${ctx.client || 'unknown'}`] = { date: new Date().toISOString().slice(0, 10), kit: ctx.kitVersion, client: ctx.client || null, models: configModels(ctx) };
  fs.writeFileSync(file, `${JSON.stringify({ runs }, null, 2)}\n`);
}

// --- running it --------------------------------------------------------------

class UsageError extends Error {}

export function parseArgs(argv) {
  const opts = { target: process.cwd(), json: false, mode: 'check' };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--json') opts.json = true;
    else if (arg === '--trial') opts.mode = 'trial';
    else if (arg === '--trial-check') opts.mode = 'trial-check';
    else if (arg === '--help' || arg === '-h') opts.mode = 'help';
    else if (arg === '--target' || arg === '--client' || arg === '--lang') {
      const value = argv[++i];
      if (value === undefined || value.startsWith('--')) throw new UsageError(`${arg} needs a value`);
      opts[arg.slice(2)] = value;
    } else throw new UsageError(`unknown option: ${arg}`);
  }
  if (opts.client !== undefined) {
    opts.client = opts.client.toLowerCase();
    if (!CLIENTS.includes(opts.client)) throw new UsageError('--client must be cli, vscode or app');
  }
  if (opts.lang !== undefined && !['ja', 'en'].includes(opts.lang)) throw new UsageError('--lang must be ja or en');
  opts.target = path.resolve(opts.target);
  return opts;
}

const USAGE = `Usage: node scripts/doctor.mjs [--target DIR] [--client cli|vscode|app] [--json] [--lang ja|en]
       node scripts/doctor.mjs --trial [--target DIR]
       node scripts/doctor.mjs --trial-check [--target DIR] [--client cli|vscode|app] [--json] [--lang ja|en]

  Checks that this machine and the repository have what spec-relay needs, and
  says what to do about anything missing. Exit 0: nothing blocks; 1: fix the
  FAIL lines first; 2: bad usage. --trial prints the subagent trial tasks and
  --trial-check checks what they wrote (after setup).`;

// The person's language: --lang, else the artifact language of an existing
// setup, else the system locale.
function pickLanguage(opts, readFile) {
  if (opts.lang) return opts.lang;
  const config = readFile(path.join(opts.target, 'openspec/config.yaml')) || '';
  const m = config.match(/^\s*Artifact language[^:\n]*:[ \t]*(.+?)\s*$/m);
  if (m && !/\{\{/.test(m[1])) return /^(ja|japanese|日本語)/i.test(m[1].trim()) ? 'ja' : 'en';
  let locale = '';
  try { locale = Intl.DateTimeFormat().resolvedOptions().locale || ''; } catch { /* no Intl */ }
  if (!locale) locale = envValue(process.env, 'LANG');
  return /^ja/i.test(locale) ? 'ja' : 'en';
}

const ascii = (json) => json.replace(/[\u007f-\uffff]/g, (ch) => `\\u${ch.charCodeAt(0).toString(16).padStart(4, '0')}`);

function readFileOrNull(file) {
  try {
    if (!fs.statSync(file).isFile()) return null;
    const buffer = fs.readFileSync(file);
    if ((buffer[0] === 0xff && buffer[1] === 0xfe) || (buffer[0] === 0xfe && buffer[1] === 0xff)) return '';
    return buffer.toString('utf8');
  } catch { return null; }
}

// The real machine. Tests replace any of these.
async function machineContext(opts, overrides = {}) {
  const launcher = await import(pathToFileURL(path.join(KIT_ROOT, 'scripts/openspec.mjs')).href);
  const setup = await import(pathToFileURL(path.join(KIT_ROOT, 'scripts/setup.mjs')).href);
  const gate = await import(pathToFileURL(path.join(KIT_ROOT, 'scripts/gate.mjs')).href);
  const platform = process.platform;
  const env = process.env;
  const pathDirs = () => envValue(env, 'PATH').split(path.delimiter).map((d) => d.trim().replace(/^"(.*)"$/, '$1')).filter((d) => d && path.isAbsolute(d));
  const ctx = {
    target: opts.target, client: opts.client, platform, env,
    nodeVersion: process.version,
    kitRoot: KIT_ROOT,
    kitVersion: (readJson(readFileOrNull(path.join(KIT_ROOT, 'package.json'))) || {}).version || '?',
    schemas: setup.SCHEMAS, configMarker: setup.CONFIG_MARKER, normalizeText: setup.normalizeText,
    bypassFiles: setup.bypassFiles, configValue: gate.configValue, cleanValue: gate.cleanValue,
    machine: machineId(),
    exists: (file) => fs.existsSync(file),
    isDir: (dir) => { try { return fs.statSync(dir).isDirectory(); } catch { return false; } },
    readFile: readFileOrNull,
    listFiles: (dir) => listFiles(dir),
    samePath: (a, b) => {
      const real = (p) => { try { return fs.realpathSync.native(p); } catch { return path.resolve(p); } };
      const fold = (p) => (platform === 'win32' || platform === 'darwin' ? p.toLowerCase() : p);
      return fold(path.resolve(real(a))) === fold(path.resolve(real(b)));
    },
    tryWrite: (dir) => {
      const file = path.join(dir, `.spec-relay-doctor-${process.pid}.tmp`);
      try { fs.writeFileSync(file, 'spec-relay doctor write test\n'); } catch (error) { return error.code || error.message; }
      // Only the write is the test; a scanner may hold the new file for a moment.
      try { fs.rmSync(file, { force: true, maxRetries: 5, retryDelay: 200 }); } catch { /* left behind; harmless */ }
      return null;
    },
    home: os.homedir(),
    openspecOnPath: () => platform !== 'win32' || Boolean(launcher.findCommand('openspec', { npmScript: '@fission-ai/openspec/bin/openspec.js' })),
    findInPath: (name) => pathDirs().map((d) => path.join(d, name)).find((f) => fs.existsSync(f)) || null,
    executionPolicy: () => {
      // A child of PowerShell 7 inherits its PSModulePath, on which Windows PowerShell 5.1 cannot load its modules.
      const clean = Object.assign({}, env);
      for (const key of Object.keys(clean)) if (key.toUpperCase() === 'PSMODULEPATH') delete clean[key];
      const shells = [
        ['PowerShell 7', launcher.findCommand('pwsh', {})],
        ['Windows PowerShell', { command: path.join(envValue(env, 'SystemRoot') || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'), prefixArgs: [] }],
      ];
      const found = [];
      for (const [shell, launch] of shells) {
        if (!launch || launch.batch) continue;
        const r = launcher.runCommand(launch, ['-NoProfile', '-NonInteractive', '-Command', 'Get-ExecutionPolicy'], { timeout: 15000, env: clean });
        if (r.status === 0 && (r.stdout || '').trim()) found.push({ shell, policy: r.stdout.trim() });
      }
      return found;
    },
    exec: (name, args, { cwd, npmScript } = {}) => {
      const launch = launcher.findCommand(name, { npmScript });
      const r = launcher.runCommand(launch, args, { cwd, timeout: 20000, maxBuffer: 64 * 1024 * 1024 });
      // 9009: the Microsoft Store's "python" alias when Python is not installed.
      const found = !r.notFound && !(r.error && r.error.code === 'ENOENT') && r.status !== 9009;
      // A timeout or a full buffer is "could not tell", never a result.
      return { found, status: r.error ? null : r.status, stdout: r.stdout || '', stderr: r.stderr || '' };
    },
    probeOpenspec: (cwd) => launcher.probeOpenspec({ cwd }),
  };
  Object.assign(ctx, overrides);
  ctx.lang = ctx.lang || pickLanguage(opts, ctx.readFile);
  if (ctx.setUp === undefined) ctx.setUp = ctx.normalizeText(ctx.readFile(path.join(ctx.target, 'openspec/config.yaml')) || '').includes(ctx.configMarker);
  ctx.t = (ja, en) => (ctx.lang === 'ja' ? ja : en);
  return ctx;
}

// A short, anonymous id of this machine and user for the trial record.
function machineId() {
  let user = '';
  try { user = os.userInfo().username; } catch { /* no user database */ }
  return crypto.createHash('sha256').update(`${os.hostname()}\n${user}`).digest('hex').slice(0, 12);
}

function listFiles(dir, base = dir) {
  let entries = [];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return []; }
  return entries.flatMap((entry) => {
    const full = path.join(dir, entry.name);
    return entry.isDirectory() ? listFiles(full, base) : [path.relative(base, full)];
  });
}

const LABEL = { ok: 'OK  ', info: 'INFO', warn: 'WARN', fail: 'FAIL' };

export function report(checks, ctx, title) {
  const lines = [title, ''];
  for (const c of checks) {
    lines.push(`${LABEL[c.level]}  ${c.message}`);
    if (c.fix && c.level !== 'ok') lines.push(`      -> ${c.fix}`);
  }
  const fails = checks.filter((c) => c.level === 'fail').length;
  const warns = checks.filter((c) => c.level === 'warn').length;
  lines.push('');
  if (fails) lines.push(ctx.t(`止まります: FAIL の ${fails} 件を直してから、もう一度実行してください。`, `Stopped: fix the ${fails} FAIL line(s), then run this again.`));
  else if (warns) lines.push(ctx.t(`始められます。WARN の ${warns} 件は、移行の途中で問題になる可能性があります。`, `Ready to start. The ${warns} WARN line(s) may cause trouble later in the migration.`));
  else lines.push(ctx.t('始められます。', 'Ready to start.'));
  return lines.join('\n');
}

function print(checks, ctx, opts, extra = {}) {
  const ok = !checks.some((c) => c.level === 'fail');
  if (opts.json) {
    console.log(ascii(JSON.stringify(Object.assign({ ok, kit: ctx.kitVersion, target: ctx.target, client: ctx.client || null, language: ctx.lang, checks }, extra), null, 2)));
  } else {
    console.log(report(checks, ctx, `spec-relay doctor ${ctx.kitVersion}  ${ctx.target}`));
  }
  return ok ? 0 : 1;
}

export async function main(argv, overrides = {}) {
  let opts;
  try { opts = parseArgs(argv); } catch (error) {
    if (!(error instanceof UsageError)) throw error;
    console.error(`doctor: ${error.message}\n\n${USAGE}`);
    return 2;
  }
  if (opts.mode === 'help') { console.log(USAGE); return 0; }
  // Before loading modules that need a current Node.js.
  const early = { nodeVersion: overrides.nodeVersion || process.version, lang: opts.lang || pickLanguage(opts, readFileOrNull) };
  early.t = (ja, en) => (early.lang === 'ja' ? ja : en);
  const node = checkNode(early);
  if (node.level === 'fail') {
    if (opts.json) console.log(ascii(JSON.stringify({ ok: false, target: opts.target, language: early.lang, checks: [node] }, null, 2)));
    else console.log(`${LABEL.fail}  ${node.message}\n      -> ${node.fix}`);
    return 1;
  }
  const ctx = await machineContext(opts, overrides);
  if (opts.mode === 'trial' || opts.mode === 'trial-check') {
    if (!ctx.setUp) {
      console.error(ctx.t('doctor: まだ導入していません。試運転は導入のあとに行います。', 'doctor: spec-relay is not set up here yet; run the trial after setup.'));
      return 1;
    }
    if (opts.mode === 'trial') {
      startTrial(ctx);
      const tasks = trialTasks(ctx);
      console.log(ascii(JSON.stringify({ folder: TRIAL_DIR, wave: tasks.length, tasks }, null, 2)));
      return 0;
    }
    // Run twice (after a compaction, say): a passed trial whose files are gone still counts.
    if (!trialLeftovers(ctx).length) {
      const done = checkTrialRecord(ctx);
      if (done.level === 'ok') return print([done], ctx, opts);
    }
    const checks = checkTrial(ctx);
    if (!checks.some((c) => c.level === 'fail')) saveTrial(ctx);
    // Cleaned up either way: a failed trial is started again with --trial.
    const left = cleanTrial(ctx);
    if (left) checks.push({ id: 'trial-cleanup', level: 'warn', message: ctx.t(`試運転のファイルを消せませんでした（${left}）。`, `could not remove the trial files (${left}).`), fix: ctx.t(`${TRIAL_DIR}/ と移行先のフォルダーの ${TRIAL_FILE} を消してください。`, `Delete ${TRIAL_DIR}/ and ${TRIAL_FILE} in the target root.`) });
    return print(checks, ctx, opts);
  }
  return print(runChecks(ctx), ctx, opts);
}

function invokedDirectly() {
  if (!process.argv[1]) return false;
  try { return fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url)); } catch { return false; }
}

if (invokedDirectly()) {
  main(process.argv.slice(2)).then((code) => { process.exitCode = code; }, (error) => {
    console.error(`doctor: ${error && error.message ? error.message : error}`);
    process.exitCode = 2;
  });
}
