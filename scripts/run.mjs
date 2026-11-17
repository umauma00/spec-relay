// Runs one command line in a folder, as verify.mjs and compare.mjs need it:
// in Windows PowerShell on Windows (conventions.md writes the commands for
// PowerShell), in /bin/sh elsewhere, with a timeout that stops the command and
// everything it started.
//
// On Windows: `powershell.exe -NoProfile -NonInteractive -ExecutionPolicy
// Bypass`; the Bypass applies to that one process only, so `npm test` works
// where the execution policy blocks npm.ps1, and changes no setting.
import { spawn, spawnSync } from 'node:child_process';

const KEEP_BYTES = 256 * 1024;
// The most stdout a caller may ask to keep whole (compare.mjs reads a driver's
// output this way).
export const MAX_STDOUT_BYTES = 512 * 1024 * 1024;

// Stops a command and everything it started: a test runner's own children
// (dotnet, java, node) would otherwise keep running and hold files open.
export function killTree(child, platform) {
  if (platform === 'win32') spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true });
  else { try { process.kill(-child.pid, 'SIGKILL'); } catch { try { child.kill('SIGKILL'); } catch { /* gone */ } } }
}

// The longest timeout setTimeout can wait (about 24.8 days).
export const MAX_TIMEOUT_MS = 2 ** 31 - 1;
// After the command's own process ended (or was killed), how long to wait for
// the output of what it left behind before going on.
const GRACE_MS = 2000;
const running = new Set();

// The PowerShell script that runs a command and exits with its status.
export const windowsScript = (command) => `[Console]::OutputEncoding = [Text.Encoding]::UTF8; ${command}; $ok = $?; if ($LASTEXITCODE) { exit $LASTEXITCODE }; if (-not $ok) { exit 1 }`;

// Runs one command line in cwd and resolves to
// { exitCode, timedOut, seconds, output, stdout? }: output is the last part of
// stdout and stderr together; with { captureStdout: true } stdout is also kept
// whole (up to MAX_STDOUT_BYTES, then the command is stopped and fails). With
// { input } that text is written to the command's stdin.
export function runCommand(command, cwd, { timeoutMs, platform = process.platform, exec = spawn, input, captureStdout = false } = {}) {
  // UTF-8 output, so the printed tail of a failure is readable on a Japanese
  // (CP932) console too. Input reaches the program as the bytes written.
  // `-Command` alone exits 1 for any failure, so the exit code of a program is
  // passed on, and a failed cmdlet exits 1.
  const [file, args, extra] = platform === 'win32'
    ? ['powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', windowsScript(command)], {}]
    : ['/bin/sh', ['-c', command], { detached: true }];
  const started = Date.now();
  return new Promise((resolve) => {
    const chunks = [];
    const out = [];
    let size = 0;
    let outSize = 0;
    let tooLong = false;
    let timedOut = false;
    let settled = false;
    let exitCode = null;
    let child;
    let timer = null;
    let grace = null;
    const keep = (chunk) => {
      chunks.push(chunk); size += chunk.length;
      while (size > KEEP_BYTES && chunks.length > 1) size -= chunks.shift().length;
    };
    const keepOut = (chunk) => {
      keep(chunk);
      if (!captureStdout || tooLong) return;
      outSize += chunk.length;
      if (outSize > MAX_STDOUT_BYTES) { tooLong = true; out.length = 0; killTree(child, platform); return; }
      out.push(chunk);
    };
    const done = (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer); clearTimeout(grace);
      running.delete(child);
      child?.stdout?.destroy?.(); child?.stderr?.destroy?.();
      let output = Buffer.concat(chunks).toString('utf8');
      if (error) output = `${output}\n${error.message}`;
      if (tooLong) output = `${output}\nstopped: the command wrote more than ${MAX_STDOUT_BYTES / 1024 / 1024} MB to stdout`;
      const failed = timedOut || tooLong || typeof exitCode !== 'number';
      resolve({
        exitCode: failed ? -1 : exitCode, timedOut, seconds: Math.round((Date.now() - started) / 100) / 10, output,
        ...(captureStdout ? { stdout: tooLong ? '' : Buffer.concat(out).toString('utf8') } : {}),
      });
    };
    try {
      child = exec(file, args, { cwd, env: process.env, windowsHide: true, stdio: [input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'], ...extra });
    } catch (error) { resolve({ exitCode: -1, timedOut: false, seconds: 0, output: error.message, ...(captureStdout ? { stdout: '' } : {}) }); return; }
    running.add(child);
    if (timeoutMs) {
      timer = setTimeout(() => {
        timedOut = true;
        killTree(child, platform);
        grace = setTimeout(() => done(), GRACE_MS);
      }, Math.min(timeoutMs, MAX_TIMEOUT_MS));
    }
    child.stdout?.on('data', keepOut);
    child.stderr?.on('data', keep);
    child.on('error', (error) => done(error));
    if (input !== undefined && child.stdin) {
      // A command that exits without reading all its input closes the pipe.
      child.stdin.on('error', () => {});
      child.stdin.end(input);
    }
    // A process the command left behind may hold the output open: the command's
    // own exit decides, and its output is read for a short while after.
    child.on('exit', (code) => { exitCode = code; clearTimeout(grace); grace = setTimeout(() => done(), GRACE_MS); });
    child.on('close', () => done());
  });
}

// Ctrl+C stops the command that is running too (on POSIX the command runs in
// its own process group, which the terminal does not signal).
export function stopAllOnSignal() {
  const stop = (signal) => {
    for (const child of running) killTree(child, process.platform);
    process.exit(signal === 'SIGINT' ? 130 : 143);
  };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
}
