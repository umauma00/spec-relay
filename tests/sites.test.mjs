import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { scanText, scanFile, decode, parseVerdict, writeParts, markerText } from '../scripts/sites.mjs';
import { checkReview } from '../scripts/gate.mjs';
import { render } from '../scripts/render.mjs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { tempDir, write, crlf } from './helpers.mjs';

const KIT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const ids = (sites) => sites.map((s) => `${s.symbol} ${s.from}-${s.to}`);
const marks = (sites, symbol) => markerText(sites.find((s) => s.symbol === symbol).markers);

const CS = `using System;
namespace Shop.Billing
{
    /// <summary>Invoice { not a brace</summary>
    public partial class InvoicePage : System.Web.UI.Page
    {
        private const decimal TaxRate = 0.08m;
        private static readonly string[] Kinds = { "a", "b{" };
        private int count;
        public int Count { get { return count; } set { count = value; } }
        public string Name => $"{first} {{x}} {(a ? "}" : "{")}";
        public InvoicePage() : base() { count = 0; }
        protected void Page_Load(object sender, EventArgs e)
        {
            if (!IsPostBack) { Bind(); }
            var s = @"SELECT * FROM t WHERE a = ""{""";
        }
        [WebMethod]
        public static decimal Total(decimal net, int qty = 1)
        {
            try { return Math.Round(net * (1 + TaxRate), 0); }
            catch (Exception ex) { throw new InvalidOperationException("x", ex); }
        }
        public decimal Total(decimal net) => Total(net, 1);
        void Bind() { using (var c = new SqlCommand("INSERT INTO log VALUES(1)")) { c.ExecuteNonQuery(); } }
        public abstract void Nothing();
        class Inner { void Deep() { char c = '{'; } }
        #region odd {
        #endregion
    }
}
`;

test('C#: members of types, overloads, constants, nested types; braces in strings, comments and #region do not count', () => {
  const sites = scanText(CS, 'src/InvoicePage.aspx.cs');
  assert.deepEqual(ids(sites), [
    'InvoicePage.TaxRate 7-7', 'InvoicePage.Kinds 8-8', 'InvoicePage.Count 10-10', 'InvoicePage.Name 11-11',
    'InvoicePage.InvoicePage 12-12', 'InvoicePage.Page_Load 13-17', 'InvoicePage.Total 18-23', 'InvoicePage.Total#2 24-24',
    'InvoicePage.Bind 25-25', 'InvoicePage.Inner.Deep 27-27',
  ]);
  assert.equal(sites[0].id, 'src/InvoicePage.aspx.cs:InvoicePage.TaxRate');
  assert.equal(marks(sites, 'InvoicePage.Total'), 'rounding 21; error 22');
  assert.equal(marks(sites, 'InvoicePage.Bind'), 'db-write 25');
  assert.equal(marks(sites, 'InvoicePage.Page_Load'), 'db-read 16', 'SQL in a string is a marker');
  assert.deepEqual(ids(scanText(crlf(CS), 'a.cs')), ids(sites));
});

test('Java: methods, constructors, static final constants and annotations', () => {
  const java = 'package a;\nimport java.util.*;\npublic class Tax {\n  static final int MAX = 9;\n  private int n;\n  public Tax(int n) { this.n = n; }\n  @Override\n  public String toString() { return "}" + n; }\n  int rate() throws IOException { if (n > MAX) { throw new IOException(); } return n; }\n}\n';
  assert.deepEqual(ids(scanText(java, 'Tax.java')), ['Tax.MAX 4-4', 'Tax.Tax 6-6', 'Tax.toString 7-8', 'Tax.rate 9-9']);
});

const PHP = `<html><body>
<?php
require_once 'db.php';
$id = $_GET['id'];
if ($id) { $rows = mysql_query("SELECT * FROM inv WHERE id={$id['x']}"); }
function total($a) { return round($a * 1.08); }
class Invoice {
  const RATE = 0.08;
  public function save() { $sql = <<<SQL
INSERT INTO inv VALUES ("}")
SQL;
    mysql_query($sql); }
  abstract function x();
}
?>
<p><?= $name ?></p>
<script>window.location = "/x";</script>
`;

test('PHP: functions, methods, class constants, and the page code outside them; heredoc and inline HTML', () => {
  const sites = scanText(PHP, 'web/invoice.php');
  assert.deepEqual(ids(sites), ['(file) 1-18', 'total 6-6', 'Invoice.RATE 8-8', 'Invoice.save 9-12']);
  assert.equal(marks(sites, '(file)'), 'input 4; db-write 5; db-read 5; redirect 17');
  assert.equal(marks(sites, 'Invoice.save'), 'db-write 10,12');
  // A class file with only namespace, use and require lines has no file site.
  assert.deepEqual(ids(scanText("<?php\nnamespace App;\nuse Foo\\Bar;\nrequire_once __DIR__ . '/x.php';\nclass A { function b() { if (true) { echo \"}\"; } } }\n", 'A.php')), ['A.b 5-5']);
  // A comment ends at ?>.
  assert.deepEqual(ids(scanText('<?php // note ?>\n<?php function f() { return 1; } ?>\n', 'f.php')), ['f 2-2']);
});

test('VB.NET: Sub, Function and Property blocks; auto-properties and comments do not count', () => {
  const vb = "Public Class Calc\n    Public Property Rate As Decimal\n    Public Property Total As Decimal\n        Get\n            Return 1\n        End Get\n    End Property\n    Public Function Add(a As Integer) As Integer ' comment }\n        Return a + 1\n    End Function\n    Private Sub Btn_Click(sender As Object, e As EventArgs) Handles Btn.Click\n        Response.Redirect(\"x\")\n    End Sub\n    Public Declare Function GetTick Lib \"kernel32\" () As Integer\nEnd Class\n";
  const sites = scanText(vb, 'Calc.vb');
  assert.deepEqual(ids(sites), ['Calc.Total 3-7', 'Calc.Add 8-10', 'Calc.Btn_Click 11-13']);
  assert.equal(marks(sites, 'Calc.Btn_Click'), 'redirect 12');
});

test('JavaScript: functions, object and class methods, arrows, and the code outside them; regex and template literals', () => {
  const js = "var re = /[{]/g;\nfunction check(f) { if (!f.value) { alert('x'); return false; } return true; }\n$(function () { $('#a').click(function () { save(); }); });\nvar obj = { go: function () { location.href = '/a'; } };\nconst arrow = (x) => { return x / 2; };\nclass K { m(a) { return `${a}}`; } }\n";
  const sites = scanText(js, 'site.js');
  assert.deepEqual(ids(sites), ['(file) 1-7', 'check 2-2', 'go 4-4', 'arrow 5-5', 'K.m 6-6']);
  assert.equal(marks(sites, 'go'), 'redirect 4');
});

test('SQL: procedures and functions up to GO; other files are one site; minified code is one site without markers', () => {
  const sql = 'CREATE PROCEDURE dbo.usp_Save @id int AS\nBEGIN\n  UPDATE inv SET total = 1 WHERE id = @id;\nEND\nGO\nCREATE FUNCTION dbo.fn_Tax(@x money) RETURNS money AS BEGIN RETURN ROUND(@x * 1.08, 0) END\nGO\n';
  const sites = scanText(sql, 'db/procs.sql');
  assert.deepEqual(ids(sites), ['dbo.usp_Save 1-4', 'dbo.fn_Tax 6-6']);
  assert.equal(marks(sites, 'dbo.fn_Tax'), 'rounding 6');
  assert.deepEqual(ids(scanText('<asp:Button runat="server" OnClick="Save_Click" />\n', 'Invoice.aspx')), ['(file) 1-2']);
  assert.deepEqual(scanText('\n\n', 'empty.config'), []);
  const minified = scanText(`function a(){${'x();'.repeat(2000)}}`, 'lib.min.js');
  assert.deepEqual(ids(minified), ['(file) 1-1']);
  assert.deepEqual(minified[0].markers, []);
});

test('Shift_JIS source is decoded first, so 「ソ」 does not escape a closing quote', () => {
  // "ソ" is 0x83 0x5C in Shift_JIS; read as UTF-8, 0x5C would be a backslash.
  const bytes = Buffer.concat([Buffer.from('class A {\n  void B() { var s = "'), Buffer.from([0x83, 0x5c]), Buffer.from('"; }\n  void C() { }\n}\n')]);
  assert.match(decode(bytes), /ソ/);
  const dir = tempDir();
  fs.writeFileSync(path.join(dir, 'A.cs'), bytes);
  assert.deepEqual(ids(scanFile(dir, 'A.cs')), ['A.B 2-2', 'A.C 3-3']);
  fs.writeFileSync(path.join(dir, 'logo.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0]));
  assert.deepEqual(scanFile(dir, 'logo.png'), []);
});

test('verdicts', () => {
  assert.deepEqual(parseVerdict('covered R1, R03 S2'), { kind: 'covered', refs: ['R1', 'R3', 'S2'] });
  assert.deepEqual(parseVerdict('**Covered**: R2.'), { kind: 'covered', refs: ['R2'] });
  assert.equal(parseVerdict('covered R1 and maybe R2').kind, 'invalid');
  assert.equal(parseVerdict('No behaviour').kind, 'no-behavior');
  assert.deepEqual(parseVerdict('other capability `billing/tax`'), { kind: 'other', capability: 'billing/tax' });
  assert.deepEqual(parseVerdict('question Q4'), { kind: 'question', question: 'Q4' });
  assert.equal(parseVerdict('gap').kind, 'gap');
  assert.equal(parseVerdict('').kind, 'blank');
  assert.equal(parseVerdict('confirmed').kind, 'invalid');
});

test('sites.mjs writes the parts of a change from its source map', () => {
  const dir = tempDir();
  write(dir, 'openspec/config.yaml', 'context: |\n  Source root (read-only): src\n');
  write(dir, 'src/a.php', '<?php\nfunction a() { return 1; }\nfunction b() { return 2; }\nfunction c() { return 3; }\n');
  write(dir, 'src/vendor/x.php', '<?php\nfunction x() {}\n');
  write(dir, 'openspec/changes/archive/2026-11-01-survey/inventory.md', '| Path | Context |\n|---|---|\n| src/ | calc |\n| src/vendor/ | excluded |\n');
  write(dir, 'openspec/changes/extract-calc/source-map.md', '## Source files\n| Path | Role | In scope |\n|---|---|---|\n| src/ | all | full |\n');
  const result = writeParts(dir, 'extract-calc', 2);
  assert.deepEqual({ ...result, problems: undefined }, { ok: true, change: 'extract-calc', sites: 3, files: 1, parts: ['openspec/spec-relay/work/extract-calc/sites/01.md', 'openspec/spec-relay/work/extract-calc/sites/02.md'], problems: undefined });
  assert.match(fs.readFileSync(path.join(dir, result.parts[1]), 'utf8'), /\| `src\/a.php:c` \| 4-4 \| - \|/);
  assert.equal(writeParts(dir, 'extract-none').ok, false);
});

test('the extract gate needs one valid ledger row per site', () => {
  const dir = tempDir();
  const C = 'openspec/changes/extract-billing-invoice';
  write(dir, 'openspec/config.yaml', 'context: |\n  Source root (read-only): src\n');
  write(dir, 'src/invoice.php', '<?php\nfunction total($a) { return round($a * 1.08); }\nfunction save($a) { mysql_query("INSERT INTO inv VALUES ($a)"); }\nfunction label() { return "x"; }\n');
  write(dir, 'openspec/changes/archive/2026-11-01-survey/inventory.md', '| Path | Context |\n|---|---|\n| src/ | billing |\n');
  write(dir, 'openspec/changes/archive/2026-11-01-survey/capabilities.md', '1. `billing/invoice`\n   - `src/invoice.php`\n2. `billing/tax`\n   - `src/tax/`\n');
  write(dir, 'src/tax/rate.php', '<?php\n');
  write(dir, `${C}/.openspec.yaml`, 'schema: spec-relay-extract\n');
  write(dir, `${C}/specs/billing/invoice/spec.md`, '## Purpose\n\nInvoices.\n\n## ADDED Requirements\n\n### Requirement: Total\nThe system SHALL add tax.\n\n#### Scenario: s\n- **WHEN** x\n- **THEN** y\n');
  write(dir, `${C}/source-map.md`, '## Source files\n| Path | Role | In scope |\n|---|---|---|\n| src/invoice.php | all | full |\n');
  write(dir, `${C}/trace.md`, '| Requirement | Source | Existing tests |\n|---|---|---|\n| Total | src/invoice.php:total:2 | none |\n');
  write(dir, `${C}/screens.md`, 'None\n');
  write(dir, `${C}/crosscheck.md`, '| Item | Verdict | Evidence |\n|---|---|---|\n| R1 Total | confirmed | x |\n');
  write(dir, `${C}/questions.md`, '- Q1. Is save dead code?\n');
  write(dir, `${C}/review.md`, 'Reviewer: Uma\n- [x] R1 Total\n- [x] Q1 save: decision: keep\n');
  const ledger = (rows) => write(dir, `${C}/coverage.md`, `| Site | Verdict | Evidence |\n|---|---|---|\n${rows}`);
  const problems = () => checkReview(dir, 'extract-billing-invoice').problems;

  ledger('| `src/invoice.php:total` | covered R1 | 2 |\n| `src/invoice.php:save` | question Q1 | 3 |\n| src\\invoice.php:LABEL | no behavior | constant text |\n');
  assert.deepEqual(problems(), []);
  ledger('| `src/invoice.php:total` | covered R1 | 2 |\n| `src/invoice.php:save` | gap | writes an invoice row |\n| `src/invoice.php:old` | no behavior | x |\n');
  assert.deepEqual(problems(), [
    'site has no row in coverage.md: src/invoice.php:label',
    'coverage.md has a row for a site the scanner does not find: `src/invoice.php:old` (a mistyped id, or a file no longer in source-map.md)',
    'site src/invoice.php:save is a gap: add the requirement it needs (then check it again), or move it to questions.md as "question Q<n>"',
  ]);
  ledger('| `src/invoice.php:total` | covered R2, S1 | 2 |\n| `src/invoice.php:save` | other capability billing/invoice | x |\n| `src/invoice.php:label` | other capability shop/cart | x |\n| `src/invoice.php:label` | question Q7 | x |\n');
  assert.deepEqual(problems(), [
    'site has more than one row in coverage.md: `src/invoice.php:label`; keep only the current verdict',
    'coverage of src/invoice.php:total names R2, but the change has only R1-R1 as requirements',
    'coverage of src/invoice.php:total names S1, but the change has no screens',
    'coverage of src/invoice.php:save names its own capability as "other capability"',
    'coverage of src/invoice.php:label points to Q7, which is not in questions.md with a review item',
  ]);
  ledger('| `src/invoice.php:total` | confirmed | 2 |\n| `src/invoice.php:save` | other capability billing/tax | x |\n| `src/invoice.php:label` | | x |\n');
  assert.deepEqual(problems(), [
    'coverage of src/invoice.php:total is "confirmed"; write covered R<n>/S<n>, no behavior, other capability <path>, question Q<n> or gap',
    'coverage of src/invoice.php:label is "blank"; write covered R<n>/S<n>, no behavior, other capability <path>, question Q<n> or gap',
  ]);
  // The review page shows the counts first, the questions and the "no behavior" sites that hold markers.
  ledger('| `src/invoice.php:total` | covered R1 | 2 |\n| `src/invoice.php:save` | no behavior | never called |\n| `src/invoice.php:label` | question Q1 | x |\n');
  const out = path.join(dir, 'page.html');
  assert.equal(render({ root: dir, change: 'extract-billing-invoice', out, lang: 'ja' }).ok, true);
  const html = fs.readFileSync(out, 'utf8');
  assert.match(html, /箇所 3（1 ファイル）・要件や画面あり 1・動作なし 1・別の capability 0・質問 1/);
  assert.match(html, /<code>src\/invoice.php:save<\/code> <span class="mono">\[db-write 3\]<\/span> — never called/);
  assert.match(html, /<code>src\/invoice.php:label<\/code> → Q1/);
  fs.rmSync(path.join(dir, C, 'coverage.md'));
  assert.match(problems().join(), /coverage.md is missing/);
});

test('merge.mjs merges coverage parts by site, a later part winning', () => {
  const dir = tempDir();
  const C = 'openspec/changes/extract-calc';
  const W = 'openspec/spec-relay/work/extract-calc/coverage';
  write(dir, `${C}/.openspec.yaml`, 'schema: spec-relay-extract\n');
  write(dir, `${W}/01.md`, '| Site | Verdict | Evidence |\n|---|---|---|\n| `src/a.php:a` | covered R1 | 2 |\n| `src/a.php:b` | gap | writes a row |\n');
  write(dir, `${W}/02.md`, '| Site | Verdict | Evidence |\n|---|---|---|\n| `src/a.php:c` | no behavior | getter |\n');
  write(dir, `${W}/03-recheck.md`, '| Site | Verdict | Evidence |\n|---|---|---|\n| `src/a.php:b` | covered R2 | 3, after R2 was added |\n');
  const run = spawnSync(process.execPath, [path.join(KIT, 'scripts/merge.mjs'), '--into', `${C}/coverage.md`, '--parts', W, '--clean', '--root', dir], { encoding: 'utf8' });
  assert.equal(run.status, 0, run.stdout + run.stderr);
  const text = fs.readFileSync(path.join(dir, C, 'coverage.md'), 'utf8');
  assert.match(text, /\| `src\/a.php:b` \| covered R2 \| 3, after R2 was added \|/);
  assert.equal((text.match(/src\/a.php:/g) ?? []).length, 3);
});
