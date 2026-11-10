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
  assert.deepEqual(files.sort(), ['spec-relay-analyst.agent.md', 'spec-relay-implementer.agent.md', 'spec-relay-orchestrator.agent.md']);
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
  for (const rel of ['scripts/setup.mjs', 'scripts/gate.mjs', 'scripts/status.mjs', 'docs/WORKFLOW.md', 'openspec-schemas']) {
    assert.ok(text.includes(rel.split('/').pop()), `skill does not mention ${rel}`);
    assert.ok(fs.existsSync(path.join(KIT_ROOT, rel)), `${rel} is missing`);
  }
});
