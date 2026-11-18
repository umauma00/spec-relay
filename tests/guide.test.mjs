import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { modules, dataOwnership, stackFacts, init, stamp, check, saveQa, parseQa, parseCodeGuide, locate, fileAnchor, summary, main } from '../scripts/guide.mjs';
import { render } from '../scripts/render.mjs';
import { status } from '../scripts/status.mjs';
import { tempDir, write, quiet } from './helpers.mjs';

const ARCH = '# Architecture\n\n## Modules\n| Context | Module path | Public API | Events published | Depends on |\n|---|---|---|---|---|\n| platform | new/platform | Clock | - | - |\n| billing | new/billing | InvoiceService | InvoiceIssued | platform |\n| Sales Orders | new/sales | OrderApi | OrderPlaced | billing, platform |\n\n## Data ownership\n| Table or file | Owning module |\n|---|---|\n| invoices | billing |\n| orders | Sales Orders |\n';
const CONVENTIONS = '# Conventions\n\n## Runtime and frameworks\n- Java 21, Spring Boot 3.3\n- PostgreSQL 16\n\n## Commands\n| Purpose | Command |\n|---|---|\n| Build | `./gradlew build` |\n| Test | `./gradlew test` |\n';

function repo() {
  const dir = tempDir();
  write(dir, 'openspec/config.yaml', 'context: |\n  Artifact language: ja\n  Source root: src\n  Target root: new\n');
  const td = 'openspec/changes/archive/2026-11-01-target-design';
  write(dir, `${td}/.openspec.yaml`, 'schema: spec-relay-target\n');
  write(dir, `${td}/architecture.md`, ARCH);
  write(dir, `${td}/conventions.md`, CONVENTIONS);
  write(dir, 'new/build.gradle', 'plugins {}\n');
  write(dir, 'new/platform/Clock.java', 'class Clock {\n  long now() { return 0; }\n}\n');
  write(dir, 'new/billing/InvoiceService.java', 'class InvoiceService {\n  int total(int a, int b) {\n    return a + b;\n  }\n}\n');
  write(dir, 'new/billing/InvoiceController.java', 'class InvoiceController {\n  // GET /invoices/{id}\n  Object show(long id) { return null; }\n}\n');
  write(dir, 'new/billing/messages.properties', 'a=b\n');
  write(dir, 'new/sales/OrderApi.java', 'class OrderApi {}\n');
  write(dir, 'openspec/specs/billing/invoice/spec.md', '## Purpose\nTotals.\n\n## Requirements\n\n### Requirement: Total\nThe system SHALL add.\n');
  return dir;
}
const read = (dir, rel) => fs.readFileSync(path.join(dir, rel), 'utf8');
const BILLING = '# Module: billing\n\n## Overview\nInvoices and totals.\n\nSecond paragraph.\n\n## Files\n\n### File: new/billing/InvoiceService.java\nAdds the lines.\n- `InvoiceService.total` (line 2): adds a and b.\n';
const ROUTES = '# Routes\n\n| Page or URL | Method | Handler | Capability | Screen |\n|---|---|---|---|---|\n| /invoices/{id} | GET | new/billing/InvoiceController.java:show:3 | billing/invoice | Invoice |\n';

test('the modules, their data and the stack come from the archived target design', () => {
  const dir = repo();
  assert.deepEqual(modules(dir).map((m) => [m.key, m.path, m.dependsOn]), [['platform', 'new/platform', []], ['billing', 'new/billing', ['platform']], ['sales-orders', 'new/sales', ['billing', 'platform']]]);
  assert.deepEqual(modules(dir)[1].events, ['InvoiceIssued']);
  assert.deepEqual(dataOwnership(dir), [{ table: 'invoices', owner: 'billing' }, { table: 'orders', owner: 'sales-orders' }]);
  const facts = stackFacts(dir);
  assert.deepEqual(facts.runtime, ['Java 21, Spring Boot 3.3', 'PostgreSQL 16']);
  assert.deepEqual(facts.commands[0], { purpose: 'Build', command: './gradlew build' });
  assert.deepEqual(facts.buildFiles, ['new/build.gradle']);
  assert.deepEqual(modules(tempDir()), []);
});

test('init makes the guide\'s folders and starting files, never over a file that is there, and lists each module\'s code files', () => {
  const dir = repo();
  const first = init(dir);
  assert.equal(first.ok, true);
  assert.deepEqual(first.wrote, ['openspec/spec-relay/guide/stack.md', 'openspec/spec-relay/guide/routes.md']);
  const billing = first.modules.find((m) => m.module === 'billing');
  assert.deepEqual(billing.code, ['new/billing/InvoiceController.java', 'new/billing/InvoiceService.java']);
  assert.equal(billing.other, 1, 'files that are not code are counted, not listed');
  assert.equal(billing.guide, 'openspec/spec-relay/guide/code/billing.md');
  assert.match(read(dir, 'openspec/spec-relay/guide/stack.md'), /- Java 21, Spring Boot 3\.3[\s\S]*\| Build \| `\.\/gradlew build` \|[\s\S]*- new\/build\.gradle/);
  write(dir, 'openspec/spec-relay/guide/stack.md', 'mine\n');
  assert.deepEqual(init(dir).wrote, []);
  assert.equal(read(dir, 'openspec/spec-relay/guide/stack.md'), 'mine\n');
  assert.match(init(tempDir()).problems[0], /no modules/);
});

test('stamp records each explained file\'s hash, and check finds what the code no longer bears out', () => {
  const dir = repo();
  init(dir);
  write(dir, 'openspec/spec-relay/guide/code/billing.md', `${BILLING}- \`missingThing\` (line 3): no such name.\n- \`InvoiceService\` (line 99): no such line.\n\n### File: new/billing/Gone.java\nold\n`);
  write(dir, 'openspec/spec-relay/guide/routes.md', `${ROUTES}| /x | GET | new/none.java:1 | | |\n| /y | GET | new/billing/InvoiceService.java:nothere | | |\n`);
  assert.deepEqual(stamp(dir).modules.find((m) => m.module === 'billing'), { module: 'billing', stamped: 1, qa: 0 });
  assert.match(read(dir, 'openspec/spec-relay/guide/code/billing.md'), /### File: new\/billing\/InvoiceService\.java\n<!-- hash: [0-9a-f]{16} -->\nAdds/);
  assert.equal(stamp(dir).modules.find((m) => m.module === 'billing').stamped, 0, 'a second stamp changes nothing');
  let result = check(dir);
  const billing = result.modules.find((m) => m.module === 'billing');
  assert.deepEqual([billing.files, billing.explained, billing.unexplained, billing.stale, billing.gone], [2, 1, ['new/billing/InvoiceController.java'], [], ['new/billing/Gone.java']]);
  assert.ok(result.problems.some((p) => /`missingThing` does not appear in new\/billing\/InvoiceService\.java/.test(p)));
  assert.ok(result.problems.some((p) => /has no line 99/.test(p)));
  assert.ok(result.problems.some((p) => /Gone\.java does not exist/.test(p)));
  assert.ok(result.problems.some((p) => /routes\.md: \/x: new\/none\.java does not exist/.test(p)));
  assert.ok(result.problems.some((p) => /`nothere` does not appear/.test(p)));
  assert.ok(!result.problems.some((p) => /invoices/.test(p)), 'a handler that exists passes');
  write(dir, 'new/billing/InvoiceService.java', 'class InvoiceService {\n  int total(int a, int b) { return a + b + 0; }\n}\n');
  result = check(dir);
  assert.deepEqual(result.modules.find((m) => m.module === 'billing').stale, ['new/billing/InvoiceService.java']);
  assert.equal(result.ok, false);
});

test('a saved answer needs an explained file, keeps its headings as text, and an empty hash is filled by stamp', () => {
  const dir = repo();
  init(dir);
  write(dir, 'openspec/spec-relay/guide/code/billing.md', BILLING);
  stamp(dir);
  assert.match(saveQa(dir, { module: 'billing', file: 'new/billing/InvoiceController.java', question: 'q', answer: 'a' }).problem, /not explained/);
  assert.match(saveQa(dir, { module: 'nope', file: 'x', question: 'q', answer: 'a' }).problem, /no module/);
  assert.match(saveQa(dir, { module: 'billing', file: 'new/billing/InvoiceService.java', question: ' ', answer: 'a' }).problem, /both needed/);
  const saved = saveQa(dir, { module: 'billing', file: 'new/billing/InvoiceService.java', question: 'Why\nint?\n### Q: forged', answer: 'Because.\n# heading\n- File: other', now: new Date('2026-11-18T00:00:00Z') });
  assert.deepEqual(saved, { ok: true, file: 'openspec/spec-relay/guide/qa/billing.md' });
  let qa = parseQa(read(dir, saved.file));
  assert.equal(qa.length, 1);
  assert.equal(qa[0].question, 'Why int? ### Q: forged', 'the question stays one line');
  assert.equal(qa[0].file, 'new/billing/InvoiceService.java');
  assert.match(qa[0].hash, /^[0-9a-f]{16}$/);
  assert.equal(qa[0].saved, '2026-11-18');
  assert.equal(qa[0].answer, 'Because.\n\\# heading\n- File: other');
  // An entry the orchestrator wrote on the person's word, with the hash left empty.
  fs.appendFileSync(path.join(dir, saved.file), '\n### Q: Where is the total?\n- File: new/billing/InvoiceService.java\n- Hash:\n- Saved: 2026-11-18\n\nLine 2.\n');
  assert.equal(stamp(dir).modules.find((m) => m.module === 'billing').qa, 1);
  qa = parseQa(read(dir, saved.file));
  assert.equal(qa[1].hash, qa[0].hash);
  assert.equal(parseCodeGuide(read(dir, 'openspec/spec-relay/guide/code/billing.md')).files[0].hash, qa[0].hash);
});

test('locate finds the guide page of a module, a file or a URL', () => {
  const dir = repo();
  init(dir);
  write(dir, 'openspec/spec-relay/guide/code/billing.md', BILLING);
  write(dir, 'openspec/spec-relay/guide/routes.md', ROUTES);
  assert.deepEqual(locate(dir, ''), { page: 'guide', anchor: null });
  assert.deepEqual(locate(dir, 'Sales Orders'), { page: 'guide-sales-orders', anchor: null });
  assert.deepEqual(locate(dir, 'new\\billing\\InvoiceService.java'), { page: 'guide-billing', anchor: fileAnchor('new/billing/InvoiceService.java') });
  assert.deepEqual(locate(dir, 'new/sales/OrderApi.java'), { page: 'guide-sales-orders', anchor: fileAnchor('new/sales/OrderApi.java') }, 'a file not explained yet is found by its module path');
  assert.deepEqual(locate(dir, 'GET /invoices/{id}'), { page: 'guide-billing', anchor: fileAnchor('new/billing/InvoiceController.java') });
  assert.equal(locate(dir, 'elsewhere/x.java'), null);
});

test('render --guide writes the first page with the diagrams and the three ways in, and a page per module', () => {
  const dir = repo();
  init(dir);
  write(dir, 'openspec/spec-relay/guide/code/billing.md', BILLING);
  write(dir, 'openspec/spec-relay/guide/routes.md', ROUTES);
  stamp(dir);
  saveQa(dir, { module: 'billing', file: 'new/billing/InvoiceService.java', question: 'Why int?', answer: 'Because.' });
  const result = render({ root: dir, guide: 'all', now: new Date('2026-11-18T00:00:00Z') });
  assert.equal(result.ok, true);
  const index = read(dir, 'openspec/spec-relay/views/guide.html');
  assert.match(index, /<svg[^>]*role="img"/);
  assert.equal((index.match(/<svg/g) ?? []).length, 2, 'the architecture and the data diagrams');
  assert.match(index, /<a href="guide-billing\.html">billing<\/a>/);
  assert.match(index, /<span class="mono">\/invoices\/\{id\}<\/span>/);
  assert.match(index, new RegExp(`href="guide-billing\\.html#${fileAnchor('new/billing/InvoiceController.java')}"`), 'a URL links to its handler\'s file');
  assert.match(index, /<a href="spec-billing-invoice\.html">billing\/invoice<\/a>/);
  assert.match(index, /Java 21, Spring Boot 3\.3/);
  assert.match(index, /2 ファイル中 1|説明 1 \/ 2 ファイル/);
  const page = read(dir, 'openspec/spec-relay/views/guide-billing.html');
  assert.match(page, new RegExp(`id="${fileAnchor('new/billing/InvoiceService.java')}"`));
  assert.match(page, /Adds the lines\./);
  assert.match(page, /まだ説明がありません。/, 'the controller has no explanation yet');
  assert.match(page, /保存した Q&amp;A[\s\S]*Why int\?[\s\S]*Because\./);
  assert.match(page, /<a href="guide\.html">← コードガイド<\/a>/);
  write(dir, 'new/billing/InvoiceService.java', 'class InvoiceService { }\n');
  render({ root: dir, guide: 'billing' });
  const after = read(dir, 'openspec/spec-relay/views/guide-billing.html');
  assert.match(after, /この説明を書いた後にコードが変わりました/);
  assert.match(after, /保存した後にコードが変わりました/);
  assert.equal(render({ root: dir, guide: 'nope' }).ok, false);
});

test('the to-do list gets one optional line for the guide once it is started', () => {
  const dir = repo();
  assert.equal(status(dir).todoList.find((t) => t.key === 'guide'), undefined);
  assert.equal(summary(dir), null);
  init(dir);
  assert.deepEqual(summary(dir), { files: 4, explained: 0, stale: 0 });
  write(dir, 'openspec/spec-relay/guide/code/billing.md', BILLING);
  stamp(dir);
  const line = status(dir, { language: 'en' }).todoList.find((t) => t.key === 'guide');
  assert.equal(line.title, 'Code guide (optional): 1 of 4 files explained');
  assert.equal(line.status, 'in-progress');
  assert.notEqual(status(dir).current?.step, 'guide', 'the guide is never where the work is');
});

test('the command line runs init, stamp and check', () => {
  const dir = repo();
  assert.equal(quiet(() => main(['init', '--root', dir])), 0);
  assert.ok(fs.existsSync(path.join(dir, 'openspec/spec-relay/guide/code')));
  assert.equal(quiet(() => main(['stamp', '--root', dir])), 0);
  assert.equal(quiet(() => main(['check', '--root', dir])), 0, 'files not explained yet are listed, not problems');
  write(dir, 'openspec/spec-relay/guide/code/billing.md', '# Module: billing\n\n### File: new/billing/Gone.java\nx\n');
  assert.equal(quiet(() => main(['check', '--root', dir])), 1);
  assert.equal(quiet(() => main(['nothing'])), 2);
});
