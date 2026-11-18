import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { KIT_ROOT } from '../scripts/setup.mjs';

const read = (rel) => fs.readFileSync(path.join(KIT_ROOT, rel), 'utf8');

function frontmatter(text) {
  const match = text.match(/^---\n([\s\S]*?)\n---\n/);
  assert.ok(match, 'missing frontmatter');
  return Object.fromEntries(match[1].split('\n').map((line) => {
    const i = line.indexOf(':');
    return [line.slice(0, i).trim(), line.slice(i + 1).trim()];
  }));
}

test('plugin, marketplace and package versions match', () => {
  const plugin = JSON.parse(read('plugin.json'));
  const market = JSON.parse(read('.github/plugin/marketplace.json'));
  const pkg = JSON.parse(read('package.json'));
  assert.equal(market.plugins[0].name, plugin.name);
  for (const version of [market.metadata.version, market.plugins[0].version, pkg.version]) {
    assert.equal(version, plugin.version);
  }
});

test('agents have names matching their files and valid relative links', () => {
  const dir = 'com.github.copilot/agents';
  const files = fs.readdirSync(path.join(KIT_ROOT, dir));
  assert.deepEqual(files.sort(), ['spec-relay-analyst.agent.md', 'spec-relay-checker.agent.md', 'spec-relay-guide-writer.agent.md', 'spec-relay-implementer.agent.md', 'spec-relay-orchestrator.agent.md']);
  for (const file of files) {
    const text = read(path.join(dir, file));
    const meta = frontmatter(text);
    assert.equal(meta.name, file.replace('.agent.md', ''));
    assert.ok(meta.description);
    assert.doesNotThrow(() => JSON.parse(meta.tools));
    for (const [, link] of text.matchAll(/\]\((\.[^)#]+)\)/g)) {
      assert.ok(fs.existsSync(path.resolve(KIT_ROOT, dir, link)), `${file}: broken link ${link}`);
    }
  }
});

test('the skill is hidden and the kit files it names exist', () => {
  const text = read('skills/spec-relay/SKILL.md');
  const meta = frontmatter(text);
  assert.equal(meta.name, 'spec-relay');
  assert.equal(meta['user-invocable'], 'false');
  for (const rel of ['scripts/setup.mjs', 'scripts/gate.mjs', 'scripts/status.mjs', 'scripts/merge.mjs', 'scripts/verify.mjs', 'scripts/compare.mjs', 'docs/COMPARE.md', 'scripts/doctor.mjs', 'docs/WORKFLOW.md', 'openspec-schemas']) {
    assert.ok(text.includes(rel.split('/').pop()), `skill does not mention ${rel}`);
    assert.ok(fs.existsSync(path.join(KIT_ROOT, rel)), `${rel} is missing`);
  }
});

test('the view skill names the renderer, which exists', () => {
  const text = read('skills/spec-relay-view/SKILL.md');
  const meta = frontmatter(text);
  assert.equal(meta.name, 'spec-relay-view');
  assert.ok(meta.description);
  assert.ok(text.includes('scripts/render.mjs'));
  assert.ok(fs.existsSync(path.join(KIT_ROOT, 'scripts/render.mjs')));
});

test('the templates have the headings and columns the gate reads', async () => {
  const { headedRows, section, column } = await import('../scripts/gate.mjs');
  const header = (text) => headedRows(text.replace(/<!--[\s\S]*?-->/g, 'x'))[0]?.header ?? [];
  const inventory = read('openspec-schemas/spec-relay-survey/templates/inventory.md');
  assert.ok(column(header(inventory), /^handling$/) >= 0, 'inventory template has a Handling column');
  const ui = read('openspec-schemas/spec-relay-target/templates/ui.md');
  assert.ok(column(header(section(ui, /^screens$/i) ?? ''), /^policy$/) >= 0, 'ui.md template has ## Screens with a Policy column');
  assert.notEqual(section(ui, /^carried files\b/i), null, 'ui.md template has ## Carried files');
  const design = read('openspec-schemas/spec-relay-port/templates/design.md');
  assert.notEqual(section(design, /^carried files\b/i), null, 'port design template has ## Carried files');
  assert.ok(column(header(section(design, /^screens$/i) ?? ''), /^policy/) >= 0, 'port design template has a Policy column');
  assert.match(read('openspec-schemas/spec-relay-target/templates/review.md'), /^## 4\. Screens\n- \[ \] U1 /m);
  const database = read('openspec-schemas/spec-relay-survey/templates/database.md');
  for (const heading of [/^databases$/i, /^logic in the database$/i, /^missing definitions$/i, /^snapshot$/i]) assert.notEqual(section(database, heading), null, `database.md template has ${heading}`);
  assert.ok(column(header(section(database, /^databases$/i) ?? ''), /^definitions?$/) >= 0, 'database.md template has a Definitions column');
  const data = read('openspec-schemas/spec-relay-target/templates/data.md');
  for (const heading of [/^schema policy$/i, /^database logic$/i, /^exceptions$/i, /^data access mapping$/i, /^schema changes$/i, /^test database$/i]) assert.notEqual(section(data, heading), null, `data.md template has ${heading}`);
  assert.ok(column(header(section(data, /^database logic$/i) ?? ''), /^handling$/) >= 0, 'data.md template has a Handling column');
  assert.match(read('openspec-schemas/spec-relay-target/templates/review.md'), /^## 5\. Data\n- \[ \] D0 /m);
  assert.match(read('openspec-schemas/spec-relay-survey/templates/review.md'), /^## 4\. Databases\n- \[ \] D1 [\s\S]*- \[ \] D90 /m);
});
