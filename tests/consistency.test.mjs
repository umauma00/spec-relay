import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { checkPortReady, checkPortDone, guardFiles } from '../scripts/gate.mjs';
import { checkFinishReady } from '../scripts/finish.mjs';
import { protectedPath } from '../scripts/hook.mjs';
import { merge } from '../scripts/merge.mjs';
import {
  specCode, dependencies, databaseObjects, objectKey, links, judge, items, checkConsistency, checkDependencies,
  ledgerRows, parseVerdict, pairKey, entryListed, dataOwners, checkExtractLinks, LEDGER, main,
} from '../scripts/consistency.mjs';
import { entryPoints } from '../scripts/walkthrough.mjs';
import { tempDir, write, crlf, quiet } from './helpers.mjs';

const X = 'openspec/changes/extract-billing-invoice';
const AUTH_SPEC = '# platform/auth Specification\n\n## Purpose\n\nSigns users in and checks the session on every page.\n\n## Requirements\n\n### Requirement: Check the session\nThe system SHALL send a user without a session to the sign-in page.\n\n#### Scenario: No session\n- **WHEN** a page is opened without a session\n- **THEN** the user is sent to /login.php\n';
const BILL_SPEC = '## Purpose\n\nInvoices for the customers of the shop, each month.\n\n## ADDED Requirements\n\n### Requirement: Issue an invoice\nThe system SHALL issue an invoice for a signed-in user.\n\n#### Scenario: Month end\n- **WHEN** the month ends\n- **THEN** an invoice is written to Invoices\n';
const AUTH_MAP = '# Source map\n\n## Source files\n| Path | Role | In scope |\n|---|---|---|\n| `src/common/auth.php` | check | full |\n\n## Entry points\n- `src/common/auth.php:check` - every page calls it\n\n## Dependencies\n- None\n\n## Database\n| Table or object | Kind | Use | Definition |\n|---|---|---|---|\n| dbo.Users | table | read / write | - |\n';
const BILL_MAP = '# Source map\n\n## Source files\n| Path | Role | In scope |\n|---|---|---|\n| `src/billing/invoice.php` | page | full |\n\n## Entry points\n- `src/billing/invoice.php` - the page\n\n## Dependencies\n| Depends on | What it uses | Entry point |\n|---|---|---|\n| `platform/auth` | the session check | `src/common/auth.php:check` |\n| MySQL | the database | - |\n\n## Database\n| Table or object | Kind | Use | Definition |\n|---|---|---|---|\n| `[dbo].[Invoices]` | table | write | - |\n| Users | table | read | - |\n';
const CONTEXT_MAP = '# Context map\n\n## Contexts\n\n### Context: platform\n- **Name**: Platform\n- **Owned data**: `dbo.Users`, sessions\n\n### Context: billing\n- **Name**: Billing\n- **Owned data**: Invoices\n\n## Shared data\n| Data | Owner | Also written by | Read by |\n|---|---|---|---|\n| Users | platform | - | billing |\n';

function project({ billMap = BILL_MAP, authMap = AUTH_MAP, contextMap = CONTEXT_MAP, plan = null } = {}) {
  const dir = tempDir();
  write(dir, 'openspec/config.yaml', 'context: |\n  Source root (read-only): src\n  Target root (new implementation): ts\n');
  write(dir, 'src/billing/invoice.php', '<?php\n');
  write(dir, 'src/common/auth.php', '<?php\n');
  write(dir, 'src/common/util.php', '<?php\n');
  const survey = 'openspec/changes/archive/2026-11-01-survey';
  write(dir, `${survey}/capabilities.md`, '# Capabilities\n\n### platform\n1. `platform/auth`\n   - `src/common/`\n\n### billing\n1. `billing/invoice`\n   - `src/billing/`\n');
  write(dir, `${survey}/inventory.md`, '| Path | Context | Handling | Notes |\n|---|---|---|---|\n| src/common/ | platform | port | |\n| src/billing/ | billing | port | |\n');
  write(dir, `${survey}/context-map.md`, contextMap);
  write(dir, `${survey}/glossary.md`, '# Glossary\n');
  if (plan) write(dir, 'openspec/spec-relay/plan.md', plan);
  write(dir, 'openspec/specs/platform/auth/spec.md', AUTH_SPEC);
  write(dir, 'openspec/changes/archive/2026-11-02-extract-platform-auth/source-map.md', authMap);
  write(dir, 'openspec/changes/archive/2026-11-02-extract-platform-auth/trace.md', '| Requirement | Source |\n|---|---|\n| Check the session | src/common/auth.php:1 |\n');
  write(dir, `${X}/.openspec.yaml`, 'schema: spec-relay-extract\n');
  write(dir, `${X}/specs/billing/invoice/spec.md`, BILL_SPEC);
  write(dir, `${X}/source-map.md`, billMap);
  return dir;
}

const scope = { change: 'extract-billing-invoice', own: 'billing/invoice' };
function part(dir, rows, name = '01.md') {
  write(dir, `openspec/spec-relay/work/extract-billing-invoice/consistency/${name}`, `| Pair | Topic | Verdict | Evidence |\n|---|---|---|---|\n${rows.join('\n')}\n`);
}
const codeOf = (dir, topic = 'uses', s = scope) => links(dir, s).find((l) => l.topic === topic).code;
const doMerge = (dir) => merge(dir, { into: LEDGER, parts: ['openspec/spec-relay/work/extract-billing-invoice/consistency'], clean: true });

test('the code of a spec is the same for the delta and the baseline OpenSpec writes from it', () => {
  const baseline = '# billing/invoice Specification\n\n## Purpose\n\nInvoices for the customers of the shop, each month.\n\n## Requirements\n\n### Requirement: Issue an invoice\nThe system SHALL issue an invoice for a signed-in user.\n\n#### Scenario: Month end\n- **WHEN** the month ends\n- **THEN** an invoice is written to Invoices\n';
  assert.equal(specCode(BILL_SPEC), specCode(baseline));
  assert.equal(specCode(crlf(BILL_SPEC)), specCode(BILL_SPEC));
  assert.equal(specCode(`${BILL_SPEC}\n\n<!-- a note -->\n`), specCode(BILL_SPEC));
  assert.notEqual(specCode(BILL_SPEC.replace('signed-in', 'known')), specCode(BILL_SPEC));
  assert.equal(specCode('## Purpose\n\nNothing yet.\n'), null);
  assert.match(specCode(BILL_SPEC), /^[0-9a-f]{8}$/);
});

test('dependencies: a table with entry points, list items, only capabilities of the plan', () => {
  const caps = ['platform/auth', 'billing/invoice', 'sales/order'];
  assert.deepEqual(dependencies(BILL_MAP, caps).map((d) => [d.capability, d.entries]), [['platform/auth', ['src/common/auth.php:check']]]);
  const list = '## Dependencies\n- `platform/auth` - the session check (`src/common/auth.php:check`)\n- sales/order: reads orders\n- jQuery 1.4\n';
  assert.deepEqual(dependencies(list, caps).map((d) => [d.capability, d.entries]), [['platform/auth', []], ['sales/order', []]]);
  const many = '## Dependencies\n| Depends on | What | Entry point |\n|---|---|---|\n| platform/auth | check, sign-in | src/common/auth.php:check, src/common/auth.php:login |\n| `sales/order` | - | none |\n';
  assert.deepEqual(dependencies(many, caps).map((d) => [d.capability, d.entries]), [['platform/auth', ['src/common/auth.php:check', 'src/common/auth.php:login']], ['sales/order', []]]);
  assert.deepEqual(dependencies('## Source files\n', caps), []);
});

test('database objects: names without schema and brackets, writes and effects', () => {
  assert.equal(objectKey('`[dbo].[Invoices]`'), 'invoices');
  assert.equal(objectKey('dbo.Users'), 'users');
  const objects = databaseObjects(BILL_MAP);
  assert.deepEqual([...objects.keys()], ['invoices', 'users']);
  assert.equal(objects.get('invoices').writes, true);
  assert.equal(objects.get('users').writes, false);
  const proc = databaseObjects('## Database\n| Table or object | Kind | Use | Definition |\n|---|---|---|---|\n| usp_Close | procedure | calls | x |\n| None | | | |\n');
  assert.deepEqual([...proc.keys()], ['usp_close']);
  assert.equal(proc.get('usp_close').effect, true);
  assert.equal(proc.get('usp_close').writes, false);
});

test('entry points of a dependency match by id, by the last name of the symbol, or by the page', () => {
  const list = entryPoints('## Entry points\n- `src/common/auth.php:Auth.check` - x\n- `src/pages/a.php` - page\n');
  assert.equal(entryListed('src/common/auth.php:check', list), true);
  assert.equal(entryListed('SRC/Common/auth.php:Auth.check', list), true);
  assert.equal(entryListed('src/pages/a.php', list), true);
  assert.equal(entryListed('src/common/auth.php:login', list), false);
  assert.equal(entryListed('src/common/other.php:check', list), false);
});

test('links: uses, a database object one side writes, a file both own; only capabilities with a spec', () => {
  const dir = project();
  assert.deepEqual(links(dir, scope).map((l) => [l.pair, l.topic]), [['billing/invoice <-> platform/auth', 'uses'], ['billing/invoice <-> platform/auth', 'data users']]);
  // Only reads on both sides: no link. A file the plan gives to both: a link.
  const plan = '# Plan\n\n## Capabilities\n\n### platform\n1. `platform/auth`\n   - `src/common/`\n\n### billing\n1. `billing/invoice`\n   - `src/billing/`\n   - `src/common/util.php`\n';
  const other = project({ authMap: AUTH_MAP.replace('read / write', 'read'), plan: plan.replace('   - `src/common/util.php`\n', '   - `src/common/util.php`\n').replace('### platform\n1. `platform/auth`\n   - `src/common/`', '### platform\n1. `platform/auth`\n   - `src/common/`\n   - `src/common/util.php`') });
  assert.deepEqual(links(other, scope).map((l) => l.topic), ['uses', 'file src/common/util.php']);
  // No spec on the other side yet (not analyzed): no link until it has one.
  fs.rmSync(path.join(dir, 'openspec/specs'), { recursive: true });
  assert.deepEqual(links(dir, scope), []);
  // The pair code is the code of both specs, in the order of the sorted pair.
  const fresh = project();
  const [link] = links(fresh, scope);
  assert.equal(link.code, `${specCode(BILL_SPEC)} ${specCode(AUTH_SPEC)}`);
  // Port-ready reads baselines only: the extract under analysis is no side yet.
  assert.deepEqual(links(fresh, { capability: 'platform/auth' }), []);
});

test('ledger rows and verdicts', () => {
  assert.equal(pairKey('`platform/auth` <-> billing/invoice'), 'billing/invoice <-> platform/auth');
  assert.equal(pairKey('billing/invoice'), '');
  assert.deepEqual(parseVerdict('question extract-billing-invoice Q02'), { kind: 'question', change: 'extract-billing-invoice', question: 'Q2' });
  assert.equal(parseVerdict('**consistent**').kind, 'consistent');
  assert.equal(parseVerdict('consistent, mostly').kind, 'invalid');
  const rows = ledgerRows('| Pair | Topic | Verdict | Evidence |\n|---|---|---|---|\n| platform/auth <-> billing/invoice | uses | consistent <!-- pair 0123abcd 4567ef01 --> | x |\n');
  assert.deepEqual([...rows.keys()], ['billing/invoice <-> platform/auth|uses']);
  assert.deepEqual([...rows.values()][0].stamp, ['0123abcd', '4567ef01']);
});

test('merge writes the ledger: the pair code is required and must be the code of both specs as they are', () => {
  const dir = project();
  const code = codeOf(dir);
  part(dir, ['| billing/invoice <-> platform/auth | uses | consistent | no code |']);
  assert.match(doMerge(dir).problems.join('\n'), /has no pair code/);
  part(dir, ['| billing/invoice <-> platform/auth | uses | consistent <!-- pair 00000000 11111111 --> | old |']);
  assert.match(doMerge(dir).problems.join('\n'), /when both specs were different from now/);
  part(dir, [`| platform/auth <-> billing/invoice | uses | consistent <!-- pair ${code} --> | "Issue an invoice" asks for a signed-in user; "Check the session" sends others to /login.php |`]);
  const result = doMerge(dir);
  assert.equal(result.ok, true, result.problems.join('\n'));
  const text = fs.readFileSync(path.join(dir, LEDGER), 'utf8');
  assert.match(text, /^# Consistency between capabilities/);
  assert.match(text, new RegExp(`\\| billing/invoice <-> platform/auth \\| uses \\| consistent <!-- pair ${code} --> \\|`));
  // A later part replaces the row of the same pair and topic.
  part(dir, [`| billing/invoice <-> platform/auth | uses | conflict <!-- pair ${code} --> | "Issue an invoice" says any user |`], '02.md');
  assert.equal(doMerge(dir).replaced, 1);
  assert.equal(ledgerRows(fs.readFileSync(path.join(dir, LEDGER), 'utf8')).size, 1);
  // Only under the work folder, and the ledger keeps its table.
  assert.equal(merge(dir, { into: LEDGER, parts: ['src'] }).ok, false);
});

test('the extract gate: a row per link, current, with a verdict that holds', () => {
  const dir = project();
  write(dir, `${X}/questions.md`, '# Questions\n\n- Q1. Words\n  - Recommended: keep\n  - Why: x\n');
  write(dir, `${X}/review.md`, '- [ ] Q1 Words: decision: \n');
  const problems = () => { const p = []; checkConsistency(dir, scope, p, { change: 'extract-billing-invoice', asked: new Set(['Q1']) }); return p; };
  assert.deepEqual(problems().map((p) => p.slice(0, 60)), [`no row in ${LEDGER} for billing/invoice <-> platform/auth (uses)`.slice(0, 60), `no row in ${LEDGER} for billing/invoice <-> platform/auth (data users)`.slice(0, 60)]);
  const [uses, data] = links(dir, scope).map((l) => l.code);
  part(dir, [
    `| billing/invoice <-> platform/auth | uses | consistent <!-- pair ${uses} --> | "Issue an invoice" vs "Check the session": both send a user without a session away |`,
    `| billing/invoice <-> platform/auth | data users | consistent <!-- pair ${data} --> | "Issue an invoice" only reads users; looks fine |`,
  ]);
  assert.equal(doMerge(dir).ok, true);
  assert.deepEqual(problems(), ['the row for billing/invoice <-> platform/auth (data users) is consistent, but its evidence does not name in quotes a requirement of platform/auth (or say "<capability>: nothing" for a side that states nothing about it); have the checker name the requirements it compared']);
  part(dir, [`| billing/invoice <-> platform/auth | data users | consistent <!-- pair ${data} --> | "Issue an invoice" reads users; platform/auth: nothing about invoices |`]);
  assert.equal(doMerge(dir).ok, true);
  assert.deepEqual(problems(), []);
  part(dir, [`| billing/invoice <-> platform/auth | data users | term <!-- pair ${data} --> | "Issue an invoice" says customer for what "Check the session" calls user |`]);
  doMerge(dir);
  assert.match(problems().join('\n'), /is term: the specs name one thing with two words/);
  // The orchestrator moves it to a question of this change, keeping the code.
  const ledger = path.join(dir, LEDGER);
  const edit = (from, to) => fs.writeFileSync(ledger, fs.readFileSync(ledger, 'utf8').replace(from, to));
  edit(/\| term (<!-- pair [0-9a-f ]+ -->)/, '| question extract-billing-invoice Q1 $1');
  assert.deepEqual(problems(), []);
  assert.equal(items(dir, { change: 'extract-billing-invoice' }).todo, 0, 'items counts the asked question like the gate');
  // A checker's part cannot replace the person's decision on the same specs.
  part(dir, [`| billing/invoice <-> platform/auth | data users | consistent <!-- pair ${data} --> | "Issue an invoice"; "Check the session" |`]);
  assert.match(doMerge(dir).problems.join('\n'), /the person's decision stays/);
  fs.rmSync(path.join(dir, 'openspec/spec-relay/work'), { recursive: true });
  // A question of another change does not count, archived and decided or not.
  edit('question extract-billing-invoice Q1', 'question extract-platform-auth Q3');
  assert.match(problems().join('\n'), /still points to Q3 of extract-platform-auth: a question holds only during that change's review/);
  // A spec that changes after the check makes its rows stale.
  write(dir, `${X}/specs/billing/invoice/spec.md`, BILL_SPEC.replace('signed-in user', 'signed-in customer'));
  assert.match(problems().join('\n'), /checked when the spec of billing\/invoice was different/);
});

test('the pair code survives the archive of the extract: port-ready, port-done and finish read the baselines', () => {
  const dir = project();
  const [uses, data] = links(dir, scope).map((l) => l.code);
  part(dir, [
    `| billing/invoice <-> platform/auth | uses | consistent <!-- pair ${uses} --> | "Issue an invoice" needs what "Check the session" gives |`,
    `| billing/invoice <-> platform/auth | data users | question extract-billing-invoice Q1 <!-- pair ${data} --> | x |`,
  ]);
  assert.match(doMerge(dir).problems.join('\n'), /a checker writes no "question" verdict/);
  part(dir, [
    `| billing/invoice <-> platform/auth | uses | consistent <!-- pair ${uses} --> | "Issue an invoice" needs what "Check the session" gives |`,
    `| billing/invoice <-> platform/auth | data users | unclear <!-- pair ${data} --> | "Check the session" writes users; "Issue an invoice" reads them, the order is unclear |`,
  ]);
  assert.equal(doMerge(dir).ok, true);
  // What OpenSpec does on archive: the delta becomes the baseline, the change moves.
  write(dir, 'openspec/specs/billing/invoice/spec.md', BILL_SPEC.replace('## ADDED Requirements', '## Requirements').replace(/\n\n### /g, '\n\n\n### '));
  fs.renameSync(path.join(dir, X), path.join(dir, 'openspec/changes/archive/2026-11-03-extract-billing-invoice'));
  assert.deepEqual(judge(dir, links(dir, { capability: 'billing/invoice' })).map((l) => l.status), ['ok', 'open']);
  assert.match(checkPortReady(dir, 'billing/invoice').problems.join('\n'), /data users\) is unclear: .* accepted D<n>/);
  // The person keeps it as it is: the decision goes to the plan, the row cites it.
  const plan = (id = 'D1', topic = 'data users') => write(dir, 'openspec/spec-relay/plan.md', `# Plan\n\n## Capabilities\n\n### platform\n1. \`platform/auth\`\n   - \`src/common/\`\n\n### billing\n1. \`billing/invoice\`\n   - \`src/billing/\`\n\n## Consistency decisions\n| Id | Pair | Topic | Decision |\n|---|---|---|---|\n| ${id} | platform/auth <-> billing/invoice | ${topic} | keep: the old code reads users after the session check |\n`);
  const ledger = path.join(dir, LEDGER);
  fs.writeFileSync(ledger, fs.readFileSync(ledger, 'utf8').replace(/\| unclear (<!-- pair [0-9a-f ]+ -->)/, '| accepted D1 $1'));
  plan('D1', 'uses');
  assert.match(checkPortReady(dir, 'billing/invoice').problems.join('\n'), /has no D1 with this pair, this topic and a decision/);
  plan();
  const ready = checkPortReady(dir, 'billing/invoice').problems;
  assert.ok(!ready.some((p) => /consistency|row for/.test(p)), ready.join('\n'));
  // An amendment of one side makes the pair stale for both ports, port-done and the finish step.
  write(dir, 'openspec/specs/platform/auth/spec.md', AUTH_SPEC.replace('/login.php', '/signin.php'));
  assert.match(checkPortReady(dir, 'billing/invoice').problems.join('\n'), /checked when the spec of platform\/auth was different/);
  assert.match(checkPortReady(dir, 'platform/auth').problems.join('\n'), /checked when the spec of platform\/auth was different/);
  assert.match(checkFinishReady(dir).problems.join('\n'), /checked when the spec of platform\/auth was different/);
  write(dir, 'openspec/changes/port-billing-invoice/tasks.md', '- [x] 1 done\n');
  write(dir, 'openspec/changes/port-billing-invoice/proposal.md', `## Baseline\n- \`billing/invoice\` sha256:${'0'.repeat(64)}\n`);
  assert.match(checkPortDone(dir, 'port-billing-invoice').problems.join('\n'), /checked when the spec of platform\/auth was different/);
});

test('an extract never waits for another extract\'s draft, and a rerun is compared after its archive', () => {
  const dir = project();
  // platform/auth is analyzed again at the same time: billing compares with its baseline, not its draft.
  write(dir, 'openspec/changes/extract-platform-auth-v2/.openspec.yaml', 'schema: spec-relay-extract\n');
  write(dir, 'openspec/changes/extract-platform-auth-v2/specs/platform/auth/spec.md', AUTH_SPEC.replace('/login.php', '/other.php'));
  assert.equal(links(dir, scope)[0].code.split(' ')[1], specCode(AUTH_SPEC));
  // The rerun itself has no links in its gate: its delta is not the spec the others meet.
  const p = [];
  checkExtractLinks(dir, path.join(dir, 'openspec/changes/extract-platform-auth-v2'), 'platform/auth', p, new Set());
  assert.deepEqual(p, []);
  assert.match(items(dir, { change: 'extract-platform-auth-v2' }).note, /a rerun is compared after its archive/);
});

test('items lists every link with its code, status and the files of both sides', () => {
  const dir = project();
  const out = items(dir, { change: 'extract-billing-invoice' });
  assert.equal(out.ok, false);
  assert.equal(out.todo, 2);
  assert.equal(out.glossary, 'openspec/changes/archive/2026-11-01-survey/glossary.md');
  assert.deepEqual(out.links[0].sides.map((s) => [s.capability, s.specs, s.sourceMaps, s.trace]), [
    ['billing/invoice', [`${X}/specs/billing/invoice/spec.md`], [`${X}/source-map.md`], null],
    ['platform/auth', ['openspec/specs/platform/auth/spec.md'], ['openspec/changes/archive/2026-11-02-extract-platform-auth/source-map.md'], 'openspec/changes/archive/2026-11-02-extract-platform-auth/trace.md'],
  ]);
  assert.match(out.links[0].code, /^<!-- pair [0-9a-f]{8} [0-9a-f]{8} -->$/);
  assert.equal(quiet(() => main(['items', '--root', dir])), 2);
  assert.equal(quiet(() => main(['check', '--all', '--root', dir])), 0, 'no link between two baselines yet');
  assert.equal(quiet(() => main(['check', '--capability', 'platform\\auth', '--root', dir])), 0);
  assert.equal(quiet(() => main(['check', '--change', 'extract-billing-invoice', '--root', dir])), 1);
});

test('dependencies: what the walkthrough leaves to another capability, and the entry points it uses', () => {
  const dir = project({ billMap: BILL_MAP.replace('| `platform/auth` | the session check | `src/common/auth.php:check` |\n', '') });
  write(dir, `${X}/walkthrough.md`, '| Entry point | Behavior | Verdict | Evidence |\n|---|---|---|---|\n| `src/billing/invoice.php` | sign-in | other capability platform/auth | src/common/auth.php:1 |\n');
  const problems = (d = dir) => { const p = []; checkDependencies(d, path.join(d, X), 'billing/invoice', p); return p; };
  assert.match(problems().join('\n'), /walkthrough.md leaves behavior to platform\/auth .* does not name it/);
  const wrong = project({ billMap: BILL_MAP.replace('auth.php:check', 'auth.php:login') });
  assert.match(problems(wrong).join('\n'), /uses src\/common\/auth.php:login of platform\/auth, which platform\/auth's archived source map does not list .* amend platform\/auth/);
  assert.deepEqual(problems(project()), []);
  // Only a column headed Entry point gives entry points, and only words that name code.
  const other = project({ billMap: BILL_MAP.replace('| Depends on | What it uses | Entry point |', '| Depends on | Kind | Where used |').replace('`src/common/auth.php:check`', 'session check, role lookup') });
  assert.deepEqual(problems(other), []);
  const noted = project({ billMap: BILL_MAP.replace('`src/common/auth.php:check`', '`src/common/auth.php:check` (returns `false` when signed out)') });
  assert.deepEqual(problems(noted), []);
  // A symbol in a file the other side lists as a whole is that entry point.
  const whole = project({ billMap: BILL_MAP, authMap: AUTH_MAP.replace('`src/common/auth.php:check` - every page calls it', '`src/common/auth.php` - included by every page') });
  assert.deepEqual(problems(whole), []);
});

test('dependencies: a table written by a context the context map does not let write it', () => {
  const writes = BILL_MAP.replace('| Users | table | read | - |', '| Users | table | update | - |');
  const problems = (d) => { const p = []; checkDependencies(d, path.join(d, X), 'billing/invoice', p); return p; };
  assert.match(problems(project({ billMap: writes })).join('\n'), /writes Users, which the context map gives to platform and does not list billing as also writing it/);
  // The person's later decision in the plan's Shared data counts.
  const plan = '# Plan\n\n## Capabilities\n\n### platform\n1. `platform/auth`\n   - `src/common/`\n\n### billing\n1. `billing/invoice`\n   - `src/billing/`\n\n## Shared data\n| Data | Owner | Also written by |\n|---|---|---|\n| dbo.Users | platform | billing |\n';
  assert.deepEqual(problems(project({ billMap: writes, plan })), []);
  // A table two contexts write with no owner anywhere.
  const noOwner = CONTEXT_MAP.replace('`dbo.Users`, sessions', 'sessions').replace('| Users | platform | - | billing |\n', '');
  assert.match(problems(project({ billMap: writes, contextMap: noOwner })).join('\n'), /Users is written by billing\/invoice \(billing\) and by platform\/auth of other contexts, and the context map names no owner/);
  assert.deepEqual(problems(project({ contextMap: noOwner })), [], 'only reads here');
  const owners = dataOwners(project());
  assert.deepEqual([...owners('users').owners], ['platform']);
  assert.deepEqual([...owners('invoices').owners], ['billing']);
});

test('only the orchestrator writes the ledger: the wave guard and the hook', () => {
  const dir = project();
  write(dir, LEDGER, '# Consistency between capabilities\n');
  assert.ok(Object.keys(guardFiles(dir)).includes(LEDGER));
  assert.match(protectedPath(dir, path.join(dir, LEDGER), { subagent: true }) ?? '', /consistency ledger/);
  assert.equal(protectedPath(dir, path.join(dir, LEDGER), { subagent: false }), null);
});

test('reading the Use cell, Owned data and the owner cell', () => {
  const use = (cell) => databaseObjects(`## Database\n| Table or object | Kind | Use | Definition |\n|---|---|---|---|\n| T | table | ${cell} | x |\n`).get('t');
  for (const cell of ['請求書の一覧を読む', '登録済みの行を読む', 'read (filters on updated_at)', 'read; soft-delete flag checked', 'reads']) assert.equal(use(cell).writes, false, cell);
  for (const cell of ['write', 'read / write', 'inserts (one row per invoice)', '書き込む', '更新する', 'update']) assert.equal(use(cell).writes, true, cell);
  assert.equal(use('calls').effect, true);
  assert.equal(use('fires on write').effect, true);
  assert.equal(objectKey('Orders, OrderLines'), 'orders');
  const map = (owned) => `# Context map\n\n### Context: platform\n${owned}\n\n### Context: billing\n- **Owned data:** \`Invoices\`\n\n## Shared data\n| Data | Owner | Also written by | Read by |\n|---|---|---|---|\n| Logs | none | billing | - |\n`;
  const owners = (owned) => dataOwners(project({ contextMap: map(owned) }));
  assert.deepEqual([...owners('- **Owned data**: the audit log of Invoices changes')('invoices').owners], ['billing'], 'prose names no table');
  assert.deepEqual([...owners('- **Owned data**:\n  - `Users`\n  - `Roles`')('roles').owners], ['platform'], 'a sub-list continues the label');
  assert.deepEqual([...owners('- **Owned data**: Users, Roles tables')('roles').owners], ['platform']);
  assert.deepEqual([...owners('- **Owned data**: Users')('logs').owners], [], '"none" is no context');
});

test('a table everybody writes links each writer to its owner; a shared folder is one link', () => {
  const dir = project({ authMap: AUTH_MAP.replace('| dbo.Users | table | read / write | - |', '| AuditLog | table | write | - |') });
  write(dir, 'openspec/changes/archive/2026-11-01-survey/context-map.md', CONTEXT_MAP.replace('`dbo.Users`, sessions', '`dbo.Users`, `AuditLog`'));
  write(dir, `${X}/source-map.md`, BILL_MAP.replace('| Users | table | read | - |', '| AuditLog | table | write | - |'));
  write(dir, 'src/sales/order.php', '<?php\n');
  write(dir, 'openspec/spec-relay/plan.md', '# Plan\n\n## Capabilities\n\n### platform\n1. `platform/auth`\n   - `src/common/`\n\n### billing\n1. `billing/invoice`\n   - `src/billing/`\n   - `src/common/`\n\n### sales\n1. `sales/order`\n   - `src/sales/`\n');
  write(dir, 'openspec/specs/sales/order/spec.md', AUTH_SPEC.replace('Check the session', 'Take an order'));
  write(dir, 'openspec/changes/archive/2026-11-02-extract-sales-order/source-map.md', '# Source map\n\n## Database\n| Table or object | Kind | Use | Definition |\n|---|---|---|---|\n| AuditLog | table | write | - |\n');
  assert.deepEqual(links(dir, { all: true }).map((l) => `${l.pair} ${l.topic}`), ['platform/auth <-> sales/order data auditlog'], 'between baselines only');
  const topics = links(dir, scope).map((l) => `${l.pair} ${l.topic}`);
  assert.ok(topics.includes('billing/invoice <-> platform/auth data auditlog'));
  assert.ok(!topics.includes('billing/invoice <-> sales/order data auditlog'), 'two writers of the owner\'s table are not linked to each other');
  assert.deepEqual(topics.filter((t) => t.includes(' file ')), ['billing/invoice <-> platform/auth file src/common/'], 'one link for the folder both list, not one per file');
});

test('the code ignores sections OpenSpec does not carry; merge refuses unknown topics and verdicts', () => {
  assert.equal(specCode(`${BILL_SPEC}\n## Notes\n\nTo check with the team.\n`), specCode(BILL_SPEC));
  const dir = project();
  const code = codeOf(dir);
  part(dir, [`| billing/invoice <-> platform/auth | anything at all | consistent <!-- pair ${code} --> | "Issue an invoice"; "Check the session" |`]);
  assert.match(doMerge(dir).problems.join('\n'), /the topic of .* must be one consistency.mjs items gives/);
  part(dir, [`| billing/invoice <-> platform/auth | uses | banana <!-- pair ${code} --> | x |`]);
  assert.match(doMerge(dir).problems.join('\n'), /must be consistent, conflict, duplicate, term or unclear/);
  part(dir, [`| billing/invoice <-> platform/auth | uses | consistent <!-- pair ${code} --> | "Issue an invoice"; "Check the session" |`]);
  assert.equal(doMerge(dir).ok, true);
  const text = fs.readFileSync(path.join(dir, LEDGER), 'utf8');
  assert.equal(text.replace(/<!--[\s\S]*?-->/g, '').includes('<change>'), false, 'the template comment is one comment');
});
