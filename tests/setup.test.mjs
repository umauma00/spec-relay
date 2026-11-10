import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { main, parseArgs, plan, CONFIG_MARKER } from '../scripts/setup.mjs';

const BASE = ['--source-language', 'C#', '--target-language', 'TypeScript', '--target-root', 'ts'];

function tempRepo() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'spec-relay-setup-'));
}

function quiet(fn) {
  const { log, error } = console;
  console.log = () => {}; console.error = () => {};
  try { return fn(); } finally { console.log = log; console.error = error; }
}

test('required options are enforced', () => {
  assert.throws(() => parseArgs([]), /--source-language is required/);
  assert.throws(() => parseArgs(['--source-language', 'C#', '--target-language', 'Go']), /--target-root is required/);
});

test('roots must stay inside the target and not overlap the kit files', () => {
  assert.throws(() => parseArgs([...BASE.slice(0, 4), '--target-root', '../out']), /inside --target/);
  assert.throws(() => parseArgs([...BASE.slice(0, 4), '--target-root', '.']), /new directory/);
  assert.throws(() => parseArgs([...BASE.slice(0, 4), '--target-root', 'openspec/out']), /new directory/);
  assert.throws(() => parseArgs([...BASE, '--source-root', 'ts']), /differ/);
});

test('a dry run changes nothing', () => {
  const dir = tempRepo();
  assert.equal(quiet(() => main(['--target', dir, ...BASE, '--skip-init'])), 0);
  assert.deepEqual(fs.readdirSync(dir), []);
});

test('apply writes schemas and a filled config, and a second run keeps them', () => {
  const dir = tempRepo();
  assert.equal(quiet(() => main(['--target', dir, ...BASE, '--language', 'ja', '--skip-init', '--apply'])), 0);
  const config = fs.readFileSync(path.join(dir, 'openspec/config.yaml'), 'utf8');
  assert.ok(config.includes(CONFIG_MARKER));
  assert.match(config, /Source language: C#/);
  assert.match(config, /Target root \(new implementation\): ts/);
  assert.match(config, /Artifact language: ja/);
  assert.doesNotMatch(config, /\{\{/);
  for (const schema of ['spec-relay-extract', 'spec-relay-port']) {
    assert.ok(fs.existsSync(path.join(dir, 'openspec/schemas', schema, 'schema.yaml')));
  }
  const again = plan(parseArgs(['--target', dir, ...BASE]));
  assert.ok(again.every((step) => step.action === 'keep'));
});

test('a changed schema file or a foreign config is a conflict and nothing is written', () => {
  const dir = tempRepo();
  fs.mkdirSync(path.join(dir, 'openspec'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'openspec/config.yaml'), 'schema: spec-driven\n');
  assert.equal(quiet(() => main(['--target', dir, ...BASE, '--skip-init', '--apply'])), 2);
  assert.equal(fs.readFileSync(path.join(dir, 'openspec/config.yaml'), 'utf8'), 'schema: spec-driven\n');
  assert.ok(!fs.existsSync(path.join(dir, 'openspec/schemas')));

  const dir2 = tempRepo();
  quiet(() => main(['--target', dir2, ...BASE, '--skip-init', '--apply']));
  fs.appendFileSync(path.join(dir2, 'openspec/schemas/spec-relay-port/schema.yaml'), '# local edit\n');
  const steps = plan(parseArgs(['--target', dir2, ...BASE]));
  assert.deepEqual(steps.filter((s) => s.action === 'conflict').map((s) => path.basename(s.path)), ['schema.yaml']);
});
