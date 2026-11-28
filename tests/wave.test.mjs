import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { start, check, mergeParts, accept, end, gitChanges, main } from '../scripts/wave.mjs';
import { KIT_ROOT } from '../scripts/setup.mjs';
import { writeReview, sha256 } from '../scripts/review-edit.mjs';
import { tempDir, write, quiet } from './helpers.mjs';

const CROSS = 'openspec/changes/extract-a/crosscheck.md';
const PART = (n) => `openspec/spec-relay/work/extract-a/crosscheck-0${n}.md`;
const row = (id, verdict = 'confirmed') => `| Item | Verdict | Evidence |\n|---|---|---|\n| ${id} | ${verdict} | src/a.php:1 |\n`;

const hasGit = (() => { try { execFileSync('git', ['--version'], { stdio: 'ignore' }); return true; } catch { return false; } })();

function repo({ git = false } = {}) {
  const dir = tempDir();
  fs.cpSync(path.join(KIT_ROOT, 'openspec-schemas', 'spec-relay-extract'), path.join(dir, 'openspec/schemas/spec-relay-extract'), { recursive: true });
  write(dir, 'openspec/config.yaml', 'context: |\n  Source root: src\n  Target root: new\n');
  write(dir, 'openspec/changes/extract-a/.openspec.yaml', 'schema: spec-relay-extract\n');
  write(dir, 'openspec/changes/extract-a/review.md', '- [ ] R1 a\n- [ ] R2 b\n');
  write(dir, 'src/a.php', '<?php echo 1;\n');
  if (git) {
    const run = (...args) => execFileSync('git', args, { cwd: dir, stdio: 'ignore' });
    run('init', '-q');
    run('-c', 'user.email=t@example.com', '-c', 'user.name=t', 'add', '-A');
    run('-c', 'user.email=t@example.com', '-c', 'user.name=t', 'commit', '-qm', 'base');
  }
  return dir;
}

test('a wave merges each finished part right away and the snapshot follows the merge', () => {
  const dir = repo();
  assert.equal(start(dir, 'wave-1').ok, true);
  write(dir, PART(1), row('R1 a'));
  write(dir, PART(2), row('R2 b', 'mismatch'));
  // Mid-wave, only part files: a folder may hold a part another task is still writing.
  const folder = mergeParts(dir, 'wave-1', [{ into: CROSS, parts: ['openspec/spec-relay/work/extract-a'] }]);
  assert.equal(folder.ok, false);
  assert.match(folder.merged[0].problems[0], /is a folder/);
  const first = mergeParts(dir, 'wave-1', [{ into: CROSS, parts: [PART(1)] }]);
  assert.equal(first.ok, true, JSON.stringify(first));
  assert.equal(first.merged[0].rows, 1);
  assert.equal(fs.existsSync(path.join(dir, PART(1))), false, 'the merged part is cleaned');
  assert.equal(fs.existsSync(path.join(dir, PART(2))), true, 'the other part stays');
  // The merge wrote crosscheck.md (guarded), and the snapshot took it: a check is clean.
  assert.equal(check(dir, 'wave-1').ok, true);
  const last = end(dir, 'wave-1', [{ into: CROSS, parts: ['openspec/spec-relay/work/extract-a'] }]);
  assert.equal(last.ok, true, JSON.stringify(last));
  assert.equal(last.ended, true);
  assert.match(fs.readFileSync(path.join(dir, CROSS), 'utf8'), /R2 b \| mismatch/);
  assert.equal(fs.existsSync(path.join(dir, 'openspec/spec-relay/work/guard/wave-1.json')), false, 'the snapshot is gone at the end');
});

test('a guarded file nobody assigned stops the merge, and nothing is written', () => {
  const dir = repo();
  start(dir, 'wave-2');
  write(dir, 'openspec/changes/extract-a/review.md', '- [x] R1 a\n- [ ] R2 b\n');
  write(dir, PART(1), row('R1 a'));
  const result = mergeParts(dir, 'wave-2', [{ into: CROSS, parts: [PART(1)] }]);
  assert.equal(result.ok, false);
  assert.deepEqual(result.changed, ['openspec/changes/extract-a/review.md']);
  assert.equal(fs.existsSync(path.join(dir, CROSS)), false, 'nothing merged');
  assert.equal(fs.existsSync(path.join(dir, PART(1))), true, 'the part is kept');
  assert.equal(result.next.person.length, 1);
  // The source file too: and accept never takes source code in.
  write(dir, 'src/a.php', '<?php echo 2;\n');
  assert.deepEqual(check(dir, 'wave-2').changed, ['openspec/changes/extract-a/review.md', 'src/a.php']);
  assert.match(accept(dir, 'wave-2', ['src']).problems[0], /source code/);
  assert.match(accept(dir, 'wave-2', ['openspec/config.yaml']).problems[0], /settings/);
  assert.match(accept(dir, 'wave-2', ['.']).problems[0], /not a repository path/);
});

test('accept takes the orchestrator\'s own writes and only those', () => {
  const dir = repo();
  start(dir, 'wave-3');
  assert.equal(check(dir, 'wave-3').ok, true);
  write(dir, 'openspec/changes/extract-a/questions.md', '# Questions\n');
  write(dir, 'openspec/spec-relay/plan.md', '## Capabilities\n');
  // Its own write (questions.md) is not enough when the plan changed too.
  const partly = accept(dir, 'wave-3', ['openspec/changes/extract-a/questions.md']);
  assert.equal(partly.ok, false);
  assert.deepEqual(partly.added, ['openspec/spec-relay/plan.md']);
  assert.equal(check(dir, 'wave-3').ok, false, 'nothing was taken');
  // A folder covers what is under it (an archive moves a whole change).
  const both = accept(dir, 'wave-3', ['openspec/changes/extract-a', 'openspec/spec-relay/plan.md']);
  assert.equal(both.ok, true, JSON.stringify(both));
  assert.deepEqual(both.taken, ['openspec/changes/extract-a/questions.md', 'openspec/spec-relay/plan.md']);
  assert.equal(check(dir, 'wave-3').ok, true);
});

test('the person\'s canvas edits are theirs during a wave and after a merge', () => {
  const dir = repo();
  start(dir, 'wave-4');
  const file = () => fs.readFileSync(path.join(dir, 'openspec/changes/extract-a/review.md'));
  assert.equal(writeReview(dir, 'extract-a', { action: 'tick', id: 'R1', hash: sha256(file()) }).ok, true);
  const seen = check(dir, 'wave-4');
  assert.equal(seen.ok, true);
  assert.deepEqual(seen.canvas, ['openspec/changes/extract-a/review.md']);
  write(dir, PART(1), row('R1 a'));
  assert.equal(mergeParts(dir, 'wave-4', [{ into: CROSS, parts: [PART(1)] }]).ok, true);
  // After the snapshot moved, a later canvas edit still counts as the person's ...
  assert.equal(writeReview(dir, 'extract-a', { action: 'tick', id: 'R2', hash: sha256(file()) }).ok, true);
  assert.equal(check(dir, 'wave-4').ok, true);
  // ... and a subagent's edit still does not.
  write(dir, 'openspec/changes/extract-a/review.md', `${file()}- [x] R3 sneaked\n`);
  assert.deepEqual(check(dir, 'wave-4').changed, ['openspec/changes/extract-a/review.md']);
});

test('in a git repository a file outside the assigned places is reported', { skip: !hasGit }, () => {
  const dir = repo({ git: true });
  write(dir, 'scratch.txt', 'left over before the wave\n');
  assert.equal(start(dir, 'wave-5').git, true);
  write(dir, 'new/app.ts', 'export {};\n');
  write(dir, 'openspec/changes/extract-a/spec.md', '## Requirements\n');
  write(dir, 'openspec/spec-relay/work/extract-a/notes.md', 'x\n');
  assert.equal(check(dir, 'wave-5').ok, true, 'target root, change folder and work folder are assigned; scratch.txt was there before');
  write(dir, '.github/copilot-instructions.md', 'x\n');
  write(dir, 'openspec/schemas/spec-relay-extract/schema.yaml', 'changed\n');
  const result = check(dir, 'wave-5');
  assert.equal(result.ok, false);
  assert.deepEqual(result.outside, ['.github/copilot-instructions.md', 'openspec/schemas/spec-relay-extract/schema.yaml']);
  assert.match(result.next.person[0], /copilot-instructions/);
  assert.ok(gitChanges(dir).some((e) => e.endsWith('scratch.txt')));
});

test('the command line checks its arguments', () => {
  const dir = repo();
  assert.equal(quiet(() => main(['start', '--root', dir])), 2, 'a name is needed');
  assert.equal(quiet(() => main(['merge', 'w', '--into', CROSS, '--root', dir])), 2, '--into needs --parts');
  assert.equal(quiet(() => main(['accept', 'w', '--root', dir])), 2, 'accept needs paths');
  assert.equal(quiet(() => main(['start', 'w', '--root', dir])), 0);
  assert.equal(quiet(() => main(['end', 'w', '--root', dir])), 0);
  assert.equal(quiet(() => main(['check', 'w', '--root', dir])), 1, 'the snapshot is gone after end');
});
