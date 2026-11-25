import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { scanText, scanFile, decode, parseVerdict, writeParts, markerText, checkLedger, ledgerSummary, listCode, refReaches } from '../scripts/sites.mjs';
import { checkReview } from '../scripts/gate.mjs';
import { render } from '../scripts/render.mjs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { tempDir, writeChecked as write, crlf } from './helpers.mjs';

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
  assert.deepEqual(ids(sites), ['(file) 1-17', 'total 6-6', 'Invoice.RATE 8-8', 'Invoice.save 9-12']);
  // (file) holds the page code and the HTML outside functions, not the functions.
  assert.deepEqual(sites[0].lines, [1, 4, 5, 16, 17]);
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
  assert.deepEqual(ids(sites), ['(file) 1-3', 'check 2-2', 'go 4-4', 'arrow 5-5', 'K.m 6-6']);
  assert.deepEqual(sites[0].lines, [1, 3]);
  assert.equal(marks(sites, 'go'), 'redirect 4');
});

test('SQL: procedures and functions up to GO; other files are one site; lines over 2000 characters are marked long', () => {
  const sql = 'CREATE PROCEDURE dbo.usp_Save @id int AS\nBEGIN\n  UPDATE inv SET total = 1 WHERE id = @id;\nEND\nGO\nCREATE FUNCTION dbo.fn_Tax(@x money) RETURNS money AS BEGIN RETURN ROUND(@x * 1.08, 0) END\nGO\n';
  const sites = scanText(sql, 'db/procs.sql');
  assert.deepEqual(ids(sites), ['dbo.usp_Save 1-4', 'dbo.fn_Tax 6-6']);
  assert.equal(marks(sites, 'dbo.fn_Tax'), 'rounding 6');
  assert.deepEqual(ids(scanText('<asp:Button runat="server" OnClick="Save_Click" />\n', 'Invoice.aspx')), ['(file) 1-1']);
  assert.deepEqual(scanText('\n\n', 'empty.config'), []);
  const minified = scanText(`function a(){${'x();'.repeat(6000)}}`, 'lib.min.js');
  assert.deepEqual(ids(minified), ['(file) 1-1']);
  assert.deepEqual(minified[0].markers, [{ kind: 'long', line: 1 }]);
  // One long line (embedded data) does not stop the rest of the file from being read.
  const mixed = scanText(`<?php\n$logo = '${'A'.repeat(16000)}';\n${Array.from({ length: 50 }, (_, k) => `function f${k}() { mysql_query("DELETE FROM t${k}"); }`).join('\n')}\n`, 'page.php');
  assert.equal(mixed.length, 51);
  assert.deepEqual(mixed[0].lines, [2]);
  assert.equal(markerText(mixed[0].markers), 'long 2');
  assert.equal(markerText(mixed[1].markers), 'db-write 3');
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
  assert.deepEqual(parseVerdict('covered R1, R03 S2'), { kind: 'covered', refs: ['R1', 'R3', 'S2'], dismissed: [] });
  assert.deepEqual(parseVerdict('**Covered**: R2.'), { kind: 'covered', refs: ['R2'], dismissed: [] });
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
  assert.deepEqual({ ...result, problems: undefined }, { ok: true, change: 'extract-calc', sites: 3, files: 1, untraced: 0, parts: ['openspec/spec-relay/work/extract-calc/sites/01.md', 'openspec/spec-relay/work/extract-calc/sites/02.md'], problems: undefined });
  assert.match(fs.readFileSync(path.join(dir, result.parts[1]), 'utf8'), /\| `src\/a.php:c` \| 4-4 \| - \| - \|/);
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
  write(dir, `${C}/questions.md`, '- Q1. Is save dead code?\n  - Recommended: keep\n  - Why: the old system does it\n');
  write(dir, `${C}/review.md`, 'Reviewer: Uma\n- [x] R1 Total\n- [x] S0 This capability has no screens\n- [x] Q1 save: decision: keep\n');
  const ledger = (rows) => write(dir, `${C}/coverage.md`, `| Site | Verdict | Evidence |\n|---|---|---|\n${rows}`);
  const problems = () => checkReview(dir, 'extract-billing-invoice').problems;

  ledger('| `src/invoice.php:total` | covered R1 | 2 |\n| `src/invoice.php:save` | question Q1 | 3 |\n| SRC\\invoice.php:label | no behavior | constant text |\n');
  assert.deepEqual(problems(), []);
  ledger('| `src/invoice.php:total` | covered R1 | 2 |\n| `src/invoice.php:save` | gap | writes an invoice row |\n| `src/invoice.php:old` | no behavior | x |\n');
  assert.deepEqual(problems(), [
    'site has no row in coverage.md: src/invoice.php:label',
    'coverage.md has a row for a site the scanner does not find: `src/invoice.php:old` (a mistyped id, a renamed member, or a file no longer in source-map.md; delete the row)',
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
    'coverage of src/invoice.php:total is "confirmed"; write only covered R<n>/S<n>, no behavior, other capability <path>, question Q<n> or gap, and put reasons in the Evidence cell',
    'coverage of src/invoice.php:save names billing/tax, but the plan does not give src/invoice.php to that capability (list the file itself under it too, or judge the site here)',
    'coverage of src/invoice.php:label is "blank"; write only covered R<n>/S<n>, no behavior, other capability <path>, question Q<n> or gap, and put reasons in the Evidence cell',
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

// Every line with BEHAVIOR in it must be in a site: a member's lines or (file)'s.
function assertNothingLost(text, file) {
  const sites = scanText(text, file);
  const inSite = new Set(sites.flatMap((s) => s.lines ?? Array.from({ length: s.to - s.from + 1 }, (_, k) => s.from + k)));
  const lost = text.split('\n').map((line, k) => [k + 1, line]).filter(([n, line]) => line.includes('BEHAVIOR') && !inSite.has(n));
  assert.deepEqual(lost, [], `${file}: lines in no site`);
  return sites;
}

test('C#: generic return types, constraints, contextual names, auto-properties, #if, raw strings, lambda fields', () => {
  const cs = `using System;
[assembly: AssemblyTitle("x")]
namespace N;
[Route("api/[controller]")]
public class Repo<T> : Base where T : class, new()
{
    private static int counter = BEHAVIOR();
    public int Id { get; set; }
    public string Name { get; private set; } = BEHAVIOR("x");
    public List<int> Get(int id) { return BEHAVIOR(id); }
    public Dictionary<string, List<int>> Add(int a) { BEHAVIOR(); return null; }
    public void Remove<TKey>(TKey k) where TKey : struct, new() { BEHAVIOR(); }
    public string? Find(string key) { return BEHAVIOR(key); }
    public static implicit operator int(Repo<T> r) => BEHAVIOR(r);
    Task<int> Load(int quantity = 1);
    private Func<int, int> twice = x => BEHAVIOR(x * 2);
    private Action<int> log = x => {
        BEHAVIOR(x);
    };
    private readonly object sync = new object();
#if DEBUG
    public void Trace() {
        BEHAVIOR("debug");
#else
    public void Trace() { BEHAVIOR("release");
#endif
    }
    public string Json() => """
        { "open": "{" }
        """;
    int Count => BEHAVIOR();
}
var app = BEHAVIOR();
`;
  const sites = assertNothingLost(cs, 'Repo.cs');
  assert.deepEqual(sites.map((s) => s.symbol), ['(file)', 'Repo.Get', 'Repo.Add', 'Repo.Remove', 'Repo.Find', 'Repo.operator int', 'Repo.twice', 'Repo.log', 'Repo.Trace', 'Repo.Json', 'Repo.Count']);
  // (file): the attributes, the field values and the top-level statement. The #else branch is in Trace's lines.
  assert.deepEqual(sites[0].lines, [2, 4, 7, 9, 15, 20, 33]);
  assert.deepEqual(ids(sites).find((s) => s.startsWith('Repo.Trace')), 'Repo.Trace 22-27');
  // A branch of #if outside every member is in (file).
  const branch = assertNothingLost('class A {\n#if X\n  void F() { }\n#else\n  void G() { BEHAVIOR(); }\n#endif\n}\n', 'A.cs');
  assert.deepEqual(ids(branch), ['(file) 5-5', 'A.F 3-3']);
});

test('Java: enum methods, anonymous classes in fields, generics', () => {
  const java = `package a;
public enum Rate {
  LOW(1), HIGH(2);
  private final int v;
  Rate(int v) { this.v = v; }
  public <T extends Comparable<T>> List<T> sorted(List<T> xs) { return BEHAVIOR(xs); }
}
class Job {
  private Runnable task = new Runnable() {
    public void run() { BEHAVIOR(); }
  };
  static { BEHAVIOR(); }
}
`;
  const sites = assertNothingLost(java, 'Rate.java');
  assert.deepEqual(ids(sites), ['Rate.(values) 3-3', 'Rate.Rate 5-5', 'Rate.sorted 6-6', 'Job.task 9-11', 'Job.(static init) 12-12']);
});

test('VB.NET: multi-line lambdas, attributes on the class line, Shared ReadOnly, #If, field values', () => {
  const vb = `Imports System
<Serializable()> Public Class Order
    Public Shared ReadOnly Rate As Decimal = 0.1D
    Private count As Integer = BEHAVIOR()
    Private name As String
    Public Sub Save()
        Dim items = list.Where(Function(x)
                                   Return BEHAVIOR(x)
                               End Function)
        AddHandler b.Click, Sub(s, e)
                                BEHAVIOR()
                            End Sub
        BEHAVIOR()
    End Sub
#If DEBUG Then
    Public Sub Dump()
    End Sub
#Else
    Public Sub Dump()
        BEHAVIOR()
    End Sub
#End If
End Class
`;
  const sites = assertNothingLost(vb, 'Order.vb');
  assert.deepEqual(ids(sites), ['(file) 2-21', 'Order.Rate 3-3', 'Order.Save 6-14', 'Order.Dump 16-17']);
  // <Serializable()> is behavior too; the field value and the #Else branch.
  assert.deepEqual(sites[0].lines, [2, 4, 19, 20, 21]);
});

test('SQL outside procedures, TypeScript classes, PHP function_exists and group use', () => {
  const sql = 'SET ANSI_NULLS ON\nGO\nINSERT INTO settings VALUES (1) -- BEHAVIOR\nGO\nCREATE PROCEDURE p AS\nBEGIN\n  SELECT 1\nEND\nGO\nUPDATE x SET a = 1 -- BEHAVIOR\n';
  const sqlSites = assertNothingLost(sql, 'seed.sql');
  assert.deepEqual(ids(sqlSites), ['(file) 3-10', 'p 5-8']);
  assert.deepEqual(sqlSites[0].lines, [3, 10]);
  assert.equal(markerText(sqlSites[0].markers), 'db-write 3,10');

  const ts = `import {
  Injectable,
} from '@angular/core';
export type Id = { value: string };
@Injectable()
export class OrderService {
  private readonly cache: Map<string, number>;
  constructor(private http: HttpClient) {}
  async load(id: string): Promise<Order> { return BEHAVIOR(id); }
  get total(): number { return BEHAVIOR(); }
  get(key: string) { return BEHAVIOR(key); }
  *ids(): Generator<number> { yield BEHAVIOR(); }
  handle = (e: Event): void => { BEHAVIOR(e); };
  twice = (x: number) => BEHAVIOR(x);
  limit = BEHAVIOR();
}
export const fmt = (n: number): string => BEHAVIOR(n);
`;
  const tsSites = assertNothingLost(ts, 'order.service.ts');
  assert.deepEqual(tsSites.map((s) => s.symbol), ['(file)', 'OrderService.constructor', 'OrderService.load', 'OrderService.total', 'OrderService.get', 'OrderService.ids', 'OrderService.handle', 'OrderService.twice', 'fmt']);
  assert.deepEqual(tsSites[0].lines, [5, 15]);

  const php = "<?php\nuse App\\{A, B};\nif (!function_exists('money')) {\n  function money($x) { return BEHAVIOR($x); }\n}\nclass Cart {\n  public $items;\n  public $rate = BEHAVIOR;\n  function add($x) { BEHAVIOR(); }\n}\n";
  const phpSites = assertNothingLost(php, 'cart.php');
  assert.deepEqual(ids(phpSites), ['(file) 3-8', 'money 4-4', 'Cart.add 9-9']);
  assert.deepEqual(phpSites[0].lines, [3, 8]);
});

test('UTF-16 without a byte order mark is read; other binary content is one (file) site', () => {
  const dir = tempDir();
  fs.writeFileSync(path.join(dir, 'A.cs'), Buffer.from('class A { void B() { } }\n', 'utf16le'));
  assert.deepEqual(ids(scanFile(dir, 'A.cs')), ['A.B 1-1']);
  fs.writeFileSync(path.join(dir, 'Report.frx'), Buffer.from([1, 0, 0, 0, 0x41, 0x42, 0, 0, 0xff, 0x10, 0x20]));
  const binary = scanFile(dir, 'Report.frx');
  assert.equal(binary.length, 1);
  assert.equal(binary[0].binary, true);
  assert.equal(binary[0].id, 'Report.frx:(file)');
});

test('verdicts: the cell holds the verdict only, with ranges and colons read', () => {
  assert.deepEqual(parseVerdict('covered R1-R3, S2'), { kind: 'covered', refs: ['R1', 'R2', 'R3', 'S2'], dismissed: [] });
  assert.deepEqual(parseVerdict('covered: R4'), { kind: 'covered', refs: ['R4'], dismissed: [] });
  // Marker lines the checker found to hold no effect, for the person to confirm.
  assert.deepEqual(parseVerdict('covered R1, S1; no effect 6, 9-11'), { kind: 'covered', refs: ['R1', 'S1'], dismissed: [6, 9, 10, 11] });
  assert.deepEqual(parseVerdict('covered R2 no-effect: 14'), { kind: 'covered', refs: ['R2'], dismissed: [14] });
  assert.deepEqual(parseVerdict('covered R2; no effect'), { kind: 'invalid' });
  assert.deepEqual(parseVerdict('covered R2; no effect 9-3'), { kind: 'invalid' });
  assert.deepEqual(parseVerdict('covered; no effect 3'), { kind: 'invalid' });
  assert.equal(parseVerdict('covered R3-S4').kind, 'invalid');
  assert.deepEqual(parseVerdict('question: Q01'), { kind: 'question', question: 'Q1' });
  // Notes go to the Evidence cell, so none can take a verdict back.
  for (const cell of ['covered R2 (main path)', 'no behavior - but it deletes the order', 'no behavior (a getter)', 'gap - writes a row', 'question Q2 (dead code?)', 'no behaviorx']) {
    assert.equal(parseVerdict(cell).kind, 'invalid', cell);
  }
});

test('the ledger: symbols keep their letter case, other capability must own the file, a source map without files fails', () => {
  const dir = tempDir();
  const C = 'openspec/changes/extract-billing-invoice';
  write(dir, 'openspec/config.yaml', 'context: |\n  Source root (read-only): src\n');
  write(dir, 'src/Invoice.cs', 'class Invoice {\n  int Total() { return 1; }\n  int total(int a) { return a; }\n}\n');
  write(dir, 'src/shared.php', '<?php\nfunction tax() { return 1; }\n');
  write(dir, 'openspec/changes/archive/2026-11-01-survey/inventory.md', '| Path | Context |\n|---|---|\n| src/ | billing |\n');
  write(dir, 'openspec/changes/archive/2026-11-01-survey/capabilities.md', '1. `billing/invoice`\n   - `src/`\n2. `billing/tax`\n   - `src/shared.php`\n');
  write(dir, `${C}/.openspec.yaml`, 'schema: spec-relay-extract\n');
  write(dir, `${C}/specs/billing/invoice/spec.md`, '## Purpose\n\nInvoices.\n\n## ADDED Requirements\n\n### Requirement: Total\nThe system SHALL add.\n\n#### Scenario: s\n- **WHEN** x\n- **THEN** y\n');
  write(dir, `${C}/source-map.md`, '## Source files\n| Path | Role | In scope |\n|---|---|---|\n| src/Invoice.cs | all | full |\n| src/shared.php | tax | full |\n');
  write(dir, `${C}/trace.md`, '| Requirement | Source | Existing tests |\n|---|---|---|\n| Total | src/Invoice.cs:Invoice.Total:2 | none |\n');
  write(dir, `${C}/screens.md`, 'None\n');
  write(dir, `${C}/crosscheck.md`, '| Item | Verdict | Evidence |\n|---|---|---|\n| R1 Total | confirmed | x |\n');
  write(dir, `${C}/questions.md`, 'None\n');
  write(dir, `${C}/review.md`, 'Reviewer: Uma\n- [x] R1 Total\n- [x] S0 This capability has no screens\n');
  const ledger = (rows) => write(dir, `${C}/coverage.md`, `| Site | Verdict | Evidence |\n|---|---|---|\n${rows}`);
  const problems = () => checkReview(dir, 'extract-billing-invoice').problems;
  ledger('| `src/invoice.cs:Invoice.Total` | covered R1 | 2 |\n| `SRC/Invoice.cs:Invoice.total` | no behavior | unused |\n| `src/shared.php:tax` | other capability billing/tax | listed there |\n');
  assert.deepEqual(problems(), []);
  // Invoice.total and Invoice.Total are two sites; one row does not answer both.
  ledger('| `src/invoice.cs:Invoice.Total` | covered R1 | 2 |\n| `src/shared.php:tax` | other capability billing/tax | x |\n');
  assert.deepEqual(problems(), ['site has no row in coverage.md: src/Invoice.cs:Invoice.total']);
  write(dir, `${C}/source-map.md`, '## Source files\n| Path | Role | In scope |\n|---|---|---|\n| src/Invoice.cs | all | No (moved) |\n| src/shared.php | tax | out |\n');
  assert.ok(problems().includes('source-map.md names no kept source file, so the omission check has nothing to scan: check its Source files table'), problems().join('\n'));
});

test('sites.mjs as a program: exit codes and the residual lines of (file)', () => {
  const dir = tempDir();
  write(dir, 'openspec/config.yaml', 'context: |\n  Source root (read-only): src\n');
  write(dir, 'src/page.php', '<?php\n$a = 1;\nfunction f() { return 1; }\n$b = 2;\n$c = 3;\n');
  write(dir, 'openspec/changes/extract-x/source-map.md', '## Source files\n| Path | Role | In scope |\n|---|---|---|\n| src/ | all | full |\n');
  const sites = (args) => spawnSync(process.execPath, [path.join(KIT, 'scripts/sites.mjs'), ...args], { encoding: 'utf8' });
  const ok = sites(['--change', 'extract-x', '--root', dir]);
  assert.equal(ok.status, 0, ok.stderr);
  assert.equal(JSON.parse(ok.stdout).sites, 2);
  assert.match(fs.readFileSync(path.join(dir, 'openspec/spec-relay/work/extract-x/sites/01.md'), 'utf8'), /\| `src\/page.php:\(file\)` \| 2, 4-5 \| - \|/);
  assert.equal(sites(['--change', 'extract-none', '--root', dir]).status, 1);
  assert.equal(sites(['--change']).status, 2);
  assert.equal(sites(['--change', 'extract-x', '--root', path.join(dir, 'src')]).status, 2);
});

test('what is never claimed: long values, strings, attributes, enum values, statements after an import', () => {
  // A constant longer than the 2000 characters a header is read from is still a site.
  const sql = Array.from({ length: 60 }, (_, k) => `      "AND COL${k} = @p${k} " +`).join('\n');
  const dao = assertNothingLost(`public class Dao {\n  private const string UpdateSql =\n      "UPDATE ORDERS SET STATUS = 9 " +\n${sql}\n      " WHERE ID = @id";\n  private string other =\n${sql}\n      "x"; // BEHAVIOR\n  public void Run() { Exec(UpdateSql); }\n}\n`, 'Dao.cs');
  assert.deepEqual(dao.map((s) => s.symbol), ['(file)', 'Dao.UpdateSql', 'Dao.Run']);
  assert.equal(dao[0].lines.length, 62, 'the field with a value is (file), every line of it');
  // Multi-line strings outside members keep their lines and markers.
  const page = assertNothingLost('<?php\nmysql_query("\n   DELETE FROM cart -- BEHAVIOR\n   WHERE id = 1\n");\n', 'del.php');
  assert.deepEqual(page[0].lines, [2, 3, 4, 5]);
  assert.equal(markerText(page[0].markers), 'db-write 2,3');
  // Attributes and enum values are behavior.
  const model = assertNothingLost('public class M {\n  [Required] [Range(1, 5)] public int Qty { get; set; } // BEHAVIOR\n  public string Name { get; set; }\n}\npublic enum Status {\n  Active = 1, // BEHAVIOR\n  Deleted = 9\n}\n', 'M.cs');
  assert.deepEqual(ids(model), ['(file) 2-2', 'Status.(values) 6-8']);
  assert.deepEqual(ids(assertNothingLost('public class C {\n  @Column(nullable = false) private String name; // BEHAVIOR\n  private int n;\n}\n', 'C.java')), ['(file) 2-2']);
  assert.deepEqual(ids(assertNothingLost('Public Enum Kind\n  A = 1 \' BEHAVIOR\nEnd Enum\n', 'K.vb')), ['Kind.(values) 1-3']);
  assert.deepEqual(ids(assertNothingLost("export enum Kind { A = 'a' } // BEHAVIOR\n", 'k.ts')), ['Kind.(values) 1-1']);
  // An attribute or annotation argument with braces is not a member body.
  assert.deepEqual(ids(scanText('public class C {\n  @RequestMapping(value = {"/a", "/b"})\n  public String save() { return "x"; }\n  void other() { }\n}\n', 'C.java')), ['C.save 2-3', 'C.other 4-4']);
  assert.deepEqual(ids(scanText('public class T {\n  [InlineData(new int[] { 1, 2 })]\n  public void Test(int[] a) { }\n}\n', 'T.cs')), ['T.Test 2-3']);
  assert.deepEqual(ids(scanText('public class D {\n  public Foo Create(int x = 1) => new Foo { A = x };\n}\n', 'D.cs')), ['D.Create 2-2']);
  // A primary constructor's base call is behavior; `using var`/typed using declarations are statements.
  assert.deepEqual(scanText('public class P(IDb db) : Base(db.Open())\n{\n}\n', 'P.cs')[0].lines, [1]);
  assert.deepEqual(assertNothingLost('using System;\nusing SqlConnection conn = new SqlConnection(cs); // BEHAVIOR\n', 'Program.cs')[0].lines, [2]);
});

test('what is never claimed in PHP, JavaScript and VB', () => {
  // ?> ends a statement, so a bare include does not swallow the next one.
  const tpl = assertNothingLost("<?php include 'header.php' ?>\n<?php check_login(); /* BEHAVIOR */ ?>\n<?= show_total() /* BEHAVIOR */ ?>\n<?php save_order(); /* BEHAVIOR */ ?>\n", 'page.php');
  assert.deepEqual(tpl[0].lines, [2, 3, 4]);
  // A conditional include is behavior; one at the top is not.
  assert.deepEqual(scanText("<?php\nif ($save) {\n  include 'save.php';\n}\nrequire 'footer.php';\n", 'c.php')[0].lines, [2, 3]);
  // JavaScript without semicolons: the import lines up to the first statement that does something.
  assert.deepEqual(assertNothingLost("import './styles.css'\ninitAnalytics() // BEHAVIOR\ntype A = string\nrun() // BEHAVIOR\n", 'main.ts')[0].lines, [2, 3, 4]);
  assert.deepEqual(assertNothingLost("require('./server').listen(3000); // BEHAVIOR\nconst fs = require('fs');\nexport default { taxRate: 0.1 }; // BEHAVIOR\n", 'srv.js')[0].lines, [1, 3]);
  // A statement in a class body is not a declaration.
  assert.deepEqual(assertNothingLost('class A {\n  x;\n  isClose(s) { if (s) return 1; }\n  this.db.save(s); // BEHAVIOR\n}\n', 'k.js')[0].lines, [4]);
  // VB: a value on a continued line; XML literal lines do not hang the scanner.
  assert.deepEqual(assertNothingLost('Public Class F\n    Private Shared Rates As Dictionary(Of String, Decimal) _\n        = LoadRates() \' BEHAVIOR\nEnd Class\n', 'F.vb')[0].lines, [2, 3]);
  const started = Date.now();
  scanText(`Module X\n${'<td> <%= r.C0 %> </td> '.repeat(40)}\nEnd Module\n`, 'X.vb');
  assert.ok(Date.now() - started < 2000, 'XML literals scan in linear time');
});

test('other capability needs the capability that owns the file most specifically', () => {
  const dir = tempDir();
  const C = 'openspec/changes/extract-billing-invoice';
  write(dir, 'openspec/config.yaml', 'context: |\n  Source root (read-only): src\n');
  write(dir, 'src/Invoice.cs', 'class Invoice {\n  int Total() { return 1; }\n}\n');
  write(dir, 'openspec/changes/archive/2026-11-01-survey/inventory.md', '| Path | Context |\n|---|---|\n| src/ | billing |\n');
  write(dir, 'openspec/changes/archive/2026-11-01-survey/capabilities.md', '1. `billing/invoice`\n   - `src/Invoice.cs`\n2. `billing/tax`\n   - `src/`\n');
  write(dir, `${C}/.openspec.yaml`, 'schema: spec-relay-extract\n');
  write(dir, `${C}/specs/billing/invoice/spec.md`, '## Purpose\n\nInvoices.\n\n## ADDED Requirements\n\n### Requirement: Total\nThe system SHALL add.\n\n#### Scenario: s\n- **WHEN** x\n- **THEN** y\n');
  write(dir, `${C}/source-map.md`, '## Source files\n| Path | Role | In scope |\n|---|---|---|\n| src | all | full |\n');
  write(dir, `${C}/trace.md`, '| Requirement | Source | Existing tests |\n|---|---|---|\n| Total | src/Invoice.cs:Invoice.Total:2 | none |\n');
  write(dir, `${C}/screens.md`, 'None\n');
  write(dir, `${C}/crosscheck.md`, '| Item | Verdict | Evidence |\n|---|---|---|\n| R1 Total | confirmed | x |\n');
  write(dir, `${C}/questions.md`, 'None\n');
  write(dir, `${C}/review.md`, 'Reviewer: Uma\n- [x] R1 Total\n- [x] S0 This capability has no screens\n');
  write(dir, `${C}/coverage.md`, '| Site | Verdict | Evidence |\n|---|---|---|\n| `src/Invoice.cs:Invoice.Total` | other capability billing/tax | x |\n');
  // billing/tax covers src/ as a folder, but billing/invoice lists the file itself, so the site is invoice's to judge.
  // (The folder row "src" without a trailing / still names the folder.)
  assert.ok(checkReview(dir, 'extract-billing-invoice').problems.includes('coverage of src/Invoice.cs:Invoice.Total names billing/tax, but the plan does not give src/Invoice.cs to that capability (list the file itself under it too, or judge the site here)'));
});

test('what is never claimed (third review): string lines, dynamic and conditional includes, interface attributes, defaults', () => {
  // The last line of a concatenation is only a string; it is still behavior.
  assert.deepEqual(assertNothingLost('<?php\n$sql = "DELETE FROM orders " .\n       "WHERE created < 1"; // BEHAVIOR\n', 'purge.php')[0].lines, [2, 3]);
  assert.deepEqual(assertNothingLost("const sql =\n  'UPDATE t SET a = 1'; // BEHAVIOR\n", 'job.js')[0].lines, [1, 2]);
  // A dynamic include, an include under a brace-less if, and one under the alternative syntax.
  assert.deepEqual(assertNothingLost('<?php\ninclude "pages/$page.php"; // BEHAVIOR\n', 'd.php')[0].lines, [2]);
  assert.deepEqual(assertNothingLost("<?php\nif (!$user)\n    include 'login.php'; // BEHAVIOR\n", 'p.php')[0].lines, [2, 3]);
  assert.deepEqual(assertNothingLost("<?php if ($admin): ?>\n<?php include 'admin.php'; /* BEHAVIOR */ ?>\n<?php endif; ?>\n", 'a.php')[0].lines, [1, 2, 3]);
  // VB: an interface member with an attribute does not swallow the class after it.
  const vb = assertNothingLost('<ComVisible(True)> Public Interface ICalc\n    <DispId(1)> Function Tax(a As Decimal) As Decimal\nEnd Interface\nPublic Class Calc\n    Public Sub Purge()\n        Db.Execute("DELETE FROM orders") \' BEHAVIOR\n    End Sub\n    Public Property Conn As New SqlConnection(Cs()) \' BEHAVIOR\nEnd Class\n', 'Calc.vb');
  assert.deepEqual(ids(vb), ['(file) 1-8', 'Calc.Purge 5-7']);
  // C#: a top-level statement with delegate, record parameters with attributes, an interface default value.
  assert.deepEqual(assertNothingLost('using System;\napp.Use(delegate (HttpContext c) { return Next(); }); // BEHAVIOR\n', 'Program.cs')[0].lines, [2]);
  assert.deepEqual(assertNothingLost('public record Order(\n  [Required] string Name, // BEHAVIOR\n  int Qty);\npublic interface IApi {\n  Task Add(int qty = 1); // BEHAVIOR\n  Task Get(int id);\n}\n', 'M.cs')[0].lines, [1, 2, 3, 5]);
  // TypeScript without semicolons: a generic alias claims its own line only.
  assert.deepEqual(assertNothingLost("type Id<T> = T | null\nlocalStorage.removeItem('token') // BEHAVIOR\n", 'a.ts')[0].lines, [2]);
  // A /* in a misread string does not blank the rest of the file.
  assertNothingLost('function bare(s) { return /^"/.test(s) ? s.slice(1) : s; }\napp.use("/api/*", auth); // BEHAVIOR\napp.post("/o", () => { db.query("DELETE FROM cart"); }); // BEHAVIOR\n', 'app.js');
  assertNothingLost("INSERT INTO msg VALUES (1, 'it\\'s ok'); -- BEHAVIOR\nINSERT INTO route VALUES (2, '/files/*'); -- BEHAVIOR\nDELETE FROM orders; -- BEHAVIOR\n", 'seed.sql');
  // Names: nested annotation arguments, anonymous classes, bracketed SQL names.
  assert.deepEqual(ids(scanText('public class C {\n  @Operation(responses = { @ApiResponse(code = "200"), @ApiResponse(code = "404") })\n  public String get() { return "x"; }\n  void save() { }\n}\n', 'C.java')), ['C.get 2-3', 'C.save 4-4']);
  assert.deepEqual(ids(scanText('public class T {\n  [TestCase(new[] { 1, 2 }, ExpectedResult = 3)]\n  public int Sum(int[] a) { return 0; }\n}\n', 'T.cs')), ['T.Sum 2-3']);
  assert.deepEqual(scanText('export default class extends React.Component {\n  render() { return 1; }\n}\n', 'App.jsx').map((s) => s.symbol), ['(anonymous).render']);
  assert.deepEqual(scanText('CREATE PROCEDURE dbo.[Save Order] AS\nSELECT 1\n', 'p.sql').map((s) => s.symbol), ['dbo.Save Order']);
});

test('the ledger: evidence for no behavior, two capabilities may not defer a site to each other, backslashes in symbols', () => {
  const dir = tempDir();
  const C = 'openspec/changes/extract-billing-invoice';
  write(dir, 'openspec/config.yaml', 'context: |\n  Source root (read-only): src\n');
  write(dir, 'src/God.cs', 'class God {\n  int Total() { return 1; }\n  void Purge() { Db.DeleteAll(); }\n}\n');
  write(dir, 'src/Ops.vb', 'Module Ops\n  Public Shared Operator /(a As X, b As X) As X\n    Return a\n  End Operator\n  Public Shared Operator \\(a As X, b As X) As X\n    Return b\n  End Operator\nEnd Module\n');
  write(dir, 'openspec/changes/archive/2026-11-01-survey/inventory.md', '| Path | Context |\n|---|---|\n| src/ | billing |\n');
  write(dir, 'openspec/changes/archive/2026-11-01-survey/capabilities.md', '1. `billing/invoice`\n   - `src/`\n2. `billing/tax`\n   - `src/God.cs`\n');
  write(dir, `${C}/.openspec.yaml`, 'schema: spec-relay-extract\n');
  write(dir, `${C}/specs/billing/invoice/spec.md`, '## Purpose\n\nInvoices.\n\n## ADDED Requirements\n\n### Requirement: Total\nThe system SHALL add.\n\n#### Scenario: s\n- **WHEN** x\n- **THEN** y\n');
  write(dir, `${C}/source-map.md`, '## Source files\n| Path | Role | In scope |\n|---|---|---|\n| src/ | all | full |\n');
  write(dir, `${C}/trace.md`, '| Requirement | Source | Existing tests |\n|---|---|---|\n| Total | src/God.cs:God.Total:2 | none |\n');
  write(dir, `${C}/screens.md`, 'None\n');
  write(dir, `${C}/crosscheck.md`, '| Item | Verdict | Evidence |\n|---|---|---|\n| R1 Total | confirmed | x |\n');
  write(dir, `${C}/questions.md`, 'None\n');
  write(dir, `${C}/review.md`, 'Reviewer: Uma\n- [x] R1 Total\n- [x] S0 This capability has no screens\n');
  write(dir, `${C}/coverage.md`, '| Site | Verdict | Evidence |\n|---|---|---|\n| `src/God.cs:God.Total` | covered R1 | 2 |\n| `src/God.cs:God.Purge` | other capability billing/tax | tax owns it |\n| `src/Ops.vb:Ops./` | no behavior | |\n| `src/Ops.vb:Ops.\\` | no behavior | returns b |\n');
  write(dir, 'openspec/changes/extract-billing-tax/coverage.md', '| Site | Verdict | Evidence |\n|---|---|---|\n| `src/God.cs:God.Purge` | other capability billing/invoice | invoice owns it |\n');
  assert.deepEqual(checkReview(dir, 'extract-billing-invoice').problems, [
    'coverage of src/God.cs:God.Purge names billing/tax, and the deferrals billing/invoice -> billing/tax -> billing/invoice come back here: one of them must judge the site',
    'coverage of src/Ops.vb:Ops./ is "no behavior" with no evidence; say why in the Evidence cell',
  ]);
});

test('lists and deep nesting: an unclosed list is not a list, nested classes keep their names, big inputs stay fast', () => {
  const ids = (text, file) => scanText(text, file).map((s) => s.symbol);
  // An unclosed export list does not swallow the function after it.
  assert.deepEqual(ids('export { a, b\nfunction run() { go(); }\n', 'a.js').filter((s) => s !== '(file)'), ['run']);
  // A closed list is claimed; its braces are not a block.
  assert.deepEqual(ids("import { a } from 'x';\nexport { a };\nfunction run() { go(); }\n", 'a.js'), ['run']);
  assert.deepEqual(ids('<?php\nuse A\\{B, C};\nfunction run() { go(); }\n', 'a.php'), ['run']);
  // Nested classes are named from the outside in.
  assert.deepEqual(ids('<?php\nclass A { function f() { $x = new class { function g() { h(); } }; } }\n', 'a.php'), ['A.f']);
  const t = Date.now();
  scanText('export { a\n'.repeat(60000), 'a.js');
  scanText('if (a) {\n'.repeat(60000), 'a.js');
  scanText('<?php\n' + 'if ($a) {\n'.repeat(60000), 'a.php');
  assert.ok(Date.now() - t < 5000, `took ${Date.now() - t} ms`);
});

test('fourth review: MySQL executable comments, PHP alternative syntax and annotations, long lines, behavior switches', () => {
  const view = (text, file) => scanText(text, file).map((s) => `${s.symbol} ${s.lines ? s.lines.join(',') : `${s.from}-${s.to}`}`);
  // mysqldump runs /*!50003 ... */ as code.
  assert.deepEqual(view("DELIMITER ;;\n/*!50003 CREATE*/ /*!50003 TRIGGER `t_bi` BEFORE INSERT ON `t` FOR EACH ROW\nBEGIN\n  INSERT INTO audit VALUES (NEW.id);\nEND */;;\n", 'dump.sql'), ['t_bi 2-5']);
  // Only a whole line of a default setting is inert.
  assert.deepEqual(view('USE Shop; DELETE FROM Cart;\nSET NOCOUNT ON; UPDATE Stock SET Qty = 0;\nSET ANSI_NULLS ON\nGO\n', 'fix.sql'), ['(file) 1,2']);
  assert.deepEqual(view('SET ANSI_NULLS OFF\nGO\nCREATE PROCEDURE p AS SELECT 1\nGO\n', 'p.sql'), ['(file) 1', 'p 3-3']);
  // T-SQL temp tables are not MySQL comments.
  assert.deepEqual(view('DELETE o FROM Orders o JOIN\n#old x ON x.Id = o.Id\n', 't.sql'), ['(file) 1,2']);
  // PHP alternative syntax: an include may be in a branch.
  assert.deepEqual(view("<?php\nif ($user):\n    $x = 1;\n    include 'dashboard.php';\nendif;\n", 'page.php'), ['(file) 2,3,4,5']);
  assert.deepEqual(view("<?php for ($i = 0; $i < 3; $i++): ?>\n<?php include 'cell.php'; ?>\n<?php endfor; ?>\n", 'grid.php'), ['(file) 1,2,3']);
  assert.deepEqual(view("<?php\ndeclare(strict_types=1);\nfunction f() { g(); }\n", 'f.php'), ['(file) 2', 'f 3-3']);
  // Doctrine and Symfony annotations are behavior.
  assert.deepEqual(view('<?php\nclass C {\n    /**\n     * @Route("/cart/delete/{id}")\n     * @param int $id\n     */\n    public function delete($id) { $this->cart->remove($id); }\n    /** @Assert\\Length(max=10) */\n    private $name;\n}\n', 'C.php'), ['(file) 4,5,8', 'C.delete 7-7']);
  // An annotation's arguments run on over lines; the marker shows it on the review page.
  const doc = scanText('<?php\nclass C {\n    /**\n     * @Route(\n     *   "/cart/delete/{id}",\n     *   methods={"DELETE"}\n     * )\n     */\n    public function delete($id) { $this->cart->remove($id); }\n}\n', 'D.php');
  assert.deepEqual(doc[0].lines, [4, 5, 6, 7]);
  assert.ok(doc[0].markers.some((m) => m.kind === 'annotation'));
  // A comment that ends on a long line still ends there.
  assert.deepEqual(view(`/*\n * Plugin A\n */(function(){${'a();'.repeat(600)}})();\n$('#purge').click(function () { $.post('/purge'); });\n`, 'plugins.js'), ['(file) 3,4']);
  // A long line with unbalanced braces: nothing is claimed.
  const cs = view(`class A {\n  void M() {\n    var x = new[] { ${'1, '.repeat(800)}\n    };\n    Purge();\n  }\n  int N;\n}\n`, 'A.cs');
  assert.ok(cs[0].startsWith('(file)') && cs[0].split(' ')[1].split(',').includes('5'), cs.join(' | '));
  // JavaScript: a require under a brace-less if is not inert.
  assert.deepEqual(view("if (config.mock)\n  var db = require('./mock-db');\nelse\n  var db = require('./real-db');\n", 'boot.js'), ['(file) 1,2,3,4']);
  // Parameter annotations and decorators are behavior.
  assert.deepEqual(view('public interface Api {\n    void create(@Valid @NotNull Order o);\n}\n', 'Api.java'), ['(file) 2']);
  assert.deepEqual(view('class Cart {\n  @observable b: number;\n}\n', 'c.ts'), ['(file) 2']);
  // VB: Option Compare Text changes comparisons; interface defaults are behavior.
  assert.deepEqual(view('Option Compare Text\nOption Strict On\nModule M\n  Function Same(a As String, b As String) As Boolean\n    Return a = b\n  End Function\nEnd Module\n', 'm.vb'), ['(file) 1', 'M.Same 4-6']);
  assert.deepEqual(view('Interface IApi\n    Sub Go(Optional retries As Integer = 5)\n    Sub Stop()\nEnd Interface\n', 'i.vb'), ['(file) 2']);
  // Masking does not rescan to the end for every unclosed /*.
  const t = Date.now();
  scanText('x = "a" /* c\n'.repeat(40000), 'a.js');
  scanText('logs/* tmp/*\n'.repeat(40000), 'ignore.txt');
  assert.ok(Date.now() - t < 3000, `took ${Date.now() - t} ms`);
});

test('fourth review: the ledger reads only Site tables, rejects placeholder evidence, deferral cycles and unscannable source-map rows, and skips carry files', () => {
  const dir = tempDir();
  const C = 'openspec/changes/extract-billing-a';
  const S = 'openspec/changes/archive/2026-11-01-survey';
  write(dir, 'openspec/config.yaml', 'context: |\n  Source root (read-only): src\n');
  write(dir, 'src/God.cs', 'class God {\n  void Purge() { Db.DeleteAll(); }\n  void Keep() { Db.Keep(); }\n}\n');
  write(dir, 'src/site.css', 'body { color: red; }\n');
  write(dir, 'src/lib/patch.cs', 'class P { void X() { Y(); } }\n');
  write(dir, `${S}/inventory.md`, '| Path | Context | Handling | Notes |\n|---|---|---|---|\n| src/ | billing | port | |\n| src/site.css | billing | carry | |\n| src/lib/ | excluded | | |\n');
  write(dir, `${S}/capabilities.md`, '1. `billing/a`\n   - `src/`\n2. `billing/b`\n   - `src/God.cs`\n3. `billing/c`\n   - `src/God.cs`\n');
  write(dir, `${C}/source-map.md`, '## Source files\n| Path | Role | In scope |\n|---|---|---|\n| src/God.cs | all | full |\n| src/site.css | look | full |\n| src/lib/patch.cs | patch | full |\n');
  write(dir, `${C}/coverage.md`, '| Site | Verdict | Evidence |\n|---|---|---|\n| `./src/God.cs:God.Purge` | other capability billing/b | b |\n| `src/god.cs:God.Keep` | no behavior | n/a |\n\n| Verdict | Count |\n|---|---|\n| covered | 0 |\n');
  write(dir, 'openspec/changes/extract-billing-b/coverage.md', '| Site | Verdict | Evidence |\n|---|---|---|\n| `src/God.cs:God.Purge` | other capability billing/c | c |\n');
  write(dir, 'openspec/changes/extract-billing-c/coverage.md', '| Site | Verdict | Evidence |\n|---|---|---|\n| `src/God.cs:God.Purge` | other capability billing/a | a |\n');
  const problems = [];
  checkLedger(dir, path.join(dir, C), { requirements: [], screens: [], asked: new Set(), assignment: new Map([['billing/a', ['src/']], ['billing/b', ['src/God.cs']], ['billing/c', ['src/God.cs']]]), own: 'billing/a' }, problems);
  assert.deepEqual(problems, [
    'source-map.md lists src/lib/patch.cs as in scope, but it holds no kept source file (excluded in inventory.md, ignored by git, or outside the source root), so the omission check cannot scan it: fix the row, or mark it out of scope',
    'coverage of src/God.cs:God.Purge names billing/b, and the deferrals billing/a -> billing/b -> billing/c -> billing/a come back here: one of them must judge the site',
    'coverage of src/God.cs:God.Keep is "no behavior" with no evidence; say why in the Evidence cell',
  ]);
  // Server-side code under a carry folder is still scanned; a lone mark is no evidence.
  write(dir, 'src/assets/upload.php', '<?php\nmove_uploaded_file($a, $b);\n');
  write(dir, 'src/assets/Upload.ashx', '<%@ WebHandler Language="C#" Class="U" %>\n');
  write(dir, `${S}/inventory.md`, '| Path | Context | Handling | Notes |\n|---|---|---|---|\n| src/ | billing | port | |\n| src/site.css | billing | carry | |\n| src/assets/ | billing | carry | |\n| src/lib/ | excluded | | |\n');
  write(dir, `${C}/source-map.md`, '## Source files\n| Path | Role | In scope |\n|---|---|---|\n| src/God.cs | all | full |\n| src/site.css | look | full |\n| src/assets/ | assets | full |\n');
  write(dir, `${C}/coverage.md`, '| Site | Verdict | Evidence |\n|---|---|---|\n| `src/God.cs:God.Purge` | covered R1 | x |\n| `src/God.cs:God.Keep` | no behavior | — |\n');
  const again = [];
  checkLedger(dir, path.join(dir, C), { requirements: ['R'], screens: [], asked: new Set(), assignment: new Map([['billing/a', ['src/']]]), own: 'billing/a' }, again);
  assert.deepEqual(again, [
    'site has no row in coverage.md: src/assets/Upload.ashx:(file)',
    'site has no row in coverage.md: src/assets/upload.php:(file)',
    'coverage of src/God.cs:God.Keep is "no behavior" with no evidence; say why in the Evidence cell',
  ]);
  // A ledger range may have spaces around the dash.
  assert.deepEqual(parseVerdict('covered R1 - R3').refs, ['R1', 'R2', 'R3']);
});

test('effect lines: a covered site needs a named requirement whose trace reaches each of them', () => {
  const dir = tempDir();
  const C = 'openspec/changes/extract-shop-orders';
  write(dir, 'openspec/config.yaml', 'context: |\n  Source root (read-only): src\n');
  // A page with code outside functions: one (file) site, as in old PHP.
  write(dir, 'src/orders.php', [
    '<?php',
    'if (!isset($_SESSION["user"])) { header("Location: login.php"); exit; }',
    'if (isset($_POST["delete"])) {',
    '  mysql_query("DELETE FROM orders WHERE id = " . $_POST["delete"]);',
    '  mail("admin@example.com", "deleted", $_POST["delete"]);',
    '}',
    '$rows = mysql_query("SELECT * FROM orders");',
    'function fmt_yen($n) { return number_format(floor($n)) . " yen"; }',
    'function audit($m) { file_put_contents("audit.log", $m, FILE_APPEND); }',
    '',
  ].join('\n'));
  write(dir, 'openspec/changes/archive/2026-11-01-survey/inventory.md', '| Path | Context |\n|---|---|\n| src/ | shop |\n');
  write(dir, 'openspec/changes/archive/2026-11-01-survey/capabilities.md', '1. `shop/orders`\n   - `src/orders.php`\n');
  write(dir, `${C}/.openspec.yaml`, 'schema: spec-relay-extract\n');
  write(dir, `${C}/specs/shop/orders/spec.md`, '## Purpose\n\nOrders.\n\n## ADDED Requirements\n\n### Requirement: List orders\nThe system SHALL list.\n\n#### Scenario: s\n- **WHEN** x\n- **THEN** y\n\n### Requirement: Delete an order\nThe system SHALL delete.\n\n#### Scenario: s\n- **WHEN** x\n- **THEN** y\n');
  write(dir, `${C}/source-map.md`, '## Source files\n| Path | Role | In scope |\n|---|---|---|\n| src/orders.php | all | full |\n');
  const trace = (list, del) => write(dir, `${C}/trace.md`, `| Requirement | Source | Existing tests |\n|---|---|---|\n| List orders | ${list} | none |\n| Delete an order | ${del} | none |\n`);
  write(dir, `${C}/screens.md`, '### Screen: Orders\n- x\n');
  write(dir, `${C}/crosscheck.md`, '| Item | Verdict | Evidence |\n|---|---|---|\n| R1 List orders | confirmed | x |\n| R2 Delete an order | confirmed | x |\n| S1 Orders | confirmed | x |\n');
  write(dir, `${C}/questions.md`, 'None\n');
  const review = (extra = '') => write(dir, `${C}/review.md`, `Reviewer: Uma\n- [x] R1 List orders\n- [x] R2 Delete an order\n- [x] S1 Orders\n${extra}`);
  const ledger = (file, fmt = 'covered R1', audit = 'covered R2') => write(dir, `${C}/coverage.md`, `| Site | Verdict | Evidence |\n|---|---|---|\n| \`src/orders.php:(file)\` | ${file} | the page |\n| \`src/orders.php:fmt_yen\` | ${fmt} | 8 |\n| \`src/orders.php:audit\` | ${audit} | 9 |\n`);
  const problems = () => checkReview(dir, 'extract-shop-orders').problems;
  review();

  // The sloppy ledger: one requirement "covers" the whole page, and the trace never read the delete branch.
  trace('src/orders.php:7', 'src/orders.php:audit');
  ledger('covered R1');
  assert.deepEqual(problems(), [
    'coverage of src/orders.php:(file) is "covered R1", but no trace of R1 reaches its effect lines (exit 2; redirect 2; db-write 4; mail 5): name the requirement that specifies each line (its trace row must cite the line or the member), or write gap. Only when a line holds no effect at all (page text, script that runs in the browser), add "; no effect <lines>" to the verdict, for the person to confirm',
  ]);
  // The sites file already tells the checker which effect lines no trace reaches.
  const parts = writeParts(dir, 'extract-shop-orders');
  assert.equal(parts.untraced, 4);
  assert.match(fs.readFileSync(path.join(dir, parts.parts[0]), 'utf8'), /\| `src\/orders.php:\(file\)` \| [^|]+ \| [^|]+ \| exit 2; redirect 2; db-write 4; mail 5 \|\n\| `src\/orders.php:fmt_yen` \| 8-8 \| rounding 8 \| - \|\n\| `src\/orders.php:audit` \| 9-9 \| file 9 \| - \|/);

  // Naming more requirements is not enough: their traces must reach the lines.
  ledger('covered R1, R2');
  assert.match(problems().join(), /no trace of R1, R2 reaches its effect lines \(exit 2; redirect 2; db-write 4; mail 5\)/);
  // A screen stands for a redirect (where an action leads) and the exit that ends it, never for a write or a mail.
  ledger('covered R1, S1');
  assert.match(problems().join(), /no trace of R1 reaches its effect lines \(db-write 4; mail 5\)/);
  trace('src/orders.php:7', 'src/orders.php:3-6<br>src/orders.php:audit');
  ledger('covered R1, R2');
  assert.match(problems().join(), /no trace of R1, R2 reaches its effect lines \(exit 2; redirect 2\)/);
  ledger('covered R1, R2, S1');
  assert.deepEqual(problems(), []);
  // Several lines after one path are lines, not a symbol.
  ledger('covered R1, R2');
  trace('src/orders.php:2, 7', 'src/orders.php:3-4, 5<br>src/orders.php:audit');
  assert.deepEqual(problems(), []);
  trace('src/orders.php:2, 7', 'src/orders.php:3-4, 500-600<br>src/orders.php:audit');
  assert.deepEqual(problems(), ['the trace of "Delete an order" gives src/orders.php the lines 500-600, but the file has 9 lines', 'coverage of src/orders.php:(file) is "covered R1, R2", but no trace of R1, R2 reaches its effect lines (mail 5): name the requirement that specifies each line (its trace row must cite the line or the member), or write gap. Only when a line holds no effect at all (page text, script that runs in the browser), add "; no effect <lines>" to the verdict, for the person to confirm']);
  trace('src/orders.php:2<br>src/orders.php:7', 'src/orders.php:3-6<br>src/orders.php:audit');
  assert.deepEqual(problems(), []);
  // The requirement must be the one the row names, and a symbol reaches its own member only.
  ledger('covered R1');
  assert.match(problems().join(), /no trace of R1 reaches its effect lines \(db-write 4; mail 5\)/);
  ledger('covered R1, R2', 'covered R1', 'covered R1');
  assert.match(problems().join(), /coverage of src\/orders.php:audit is "covered R1", but no trace of R1 reaches its effect lines \(file 9\)/);
  // `(file)` has no name, so a symbol in the trace does not reach it.
  trace('src/orders.php:page code', 'src/orders.php:3-6<br>src/orders.php:Audit');
  ledger('covered R1, R2');
  assert.match(problems().join(), /src\/orders.php:\(file\) is "covered R1, R2", but no trace of R1, R2 reaches its effect lines \(exit 2; redirect 2; db-write 7\)/);
});

test('"no behavior" on a site with marker lines needs the person\'s C1 item with the count', () => {
  const dir = tempDir();
  const C = 'openspec/changes/extract-shop-orders';
  write(dir, 'openspec/config.yaml', 'context: |\n  Source root (read-only): src\n');
  write(dir, 'src/log.php', '<?php\nfunction audit($m) { file_put_contents("audit.log", $m, FILE_APPEND); }\nfunction stamp() { return date("Y"); }\nfunction name() { return "x"; }\n');
  write(dir, 'openspec/changes/archive/2026-11-01-survey/inventory.md', '| Path | Context |\n|---|---|\n| src/ | shop |\n');
  write(dir, 'openspec/changes/archive/2026-11-01-survey/capabilities.md', '1. `shop/orders`\n   - `src/log.php`\n');
  write(dir, `${C}/.openspec.yaml`, 'schema: spec-relay-extract\n');
  write(dir, `${C}/specs/shop/orders/spec.md`, '## Purpose\n\nOrders.\n\n## ADDED Requirements\n\n### Requirement: Name\nThe system SHALL name.\n\n#### Scenario: s\n- **WHEN** x\n- **THEN** y\n');
  write(dir, `${C}/source-map.md`, '## Source files\n| Path | Role | In scope |\n|---|---|---|\n| src/log.php | all | full |\n');
  write(dir, `${C}/trace.md`, '| Requirement | Source | Existing tests |\n|---|---|---|\n| Name | src/log.php:name | none |\n');
  write(dir, `${C}/screens.md`, 'None\n');
  write(dir, `${C}/crosscheck.md`, '| Item | Verdict | Evidence |\n|---|---|---|\n| R1 Name | confirmed | x |\n');
  write(dir, `${C}/questions.md`, 'None\n');
  write(dir, `${C}/coverage.md`, '| Site | Verdict | Evidence |\n|---|---|---|\n| `src/log.php:audit` | no behavior | a log nobody reads |\n| `src/log.php:stamp` | no behavior | unused |\n| `src/log.php:name` | covered R1 | 4 |\n');
  const review = (extra = '') => write(dir, `${C}/review.md`, `Reviewer: Uma\n- [x] R1 Name\n- [x] S0 This capability has no screens\n${extra}`);
  const problems = () => checkReview(dir, 'extract-shop-orders').problems;
  review();
  const code = listCode(['src/log.php:audit', 'src/log.php:stamp']);
  assert.match(code, /^[0-9a-f]{6}$/);
  const item = `C1 The marker lines of 2 sites are judged to hold nothing to migrate (list ${code})`;
  assert.deepEqual(problems(), [`review.md has no C1 item: 2 sites with marker lines are judged "no behavior" or "no effect" (src/log.php:audit; src/log.php:stamp); run draft.mjs review --change <change> --update, which adds "- [ ] ${item}" under "## 4. Coverage" for the person to decide`]);
  // An item for another list (an older one, or one of the same length) is not this list's.
  const stale = [`review item C1 is not for the list as it is now (2 sites with marker lines judged "no behavior" or "no effect"); run draft.mjs review --change <change> --update, which writes "- [ ] ${item}" unticked, so the person sees the list again`];
  review('- [x] C1 The 2 sites judged no behavior have nothing to migrate\n');
  assert.deepEqual(problems(), stale);
  review(`- [x] C1 動作なしと判断した 2 箇所は移行しなくてよい（list ${listCode(['src/log.php:audit', 'src/log.php:name'])}）\n`);
  assert.deepEqual(problems(), stale);
  review(`- [ ] C1 目印があるのに動作なしと判断した 2 箇所は移行しなくてよい（list ${code}）\n`);
  assert.deepEqual(problems(), [`not ticked: C1 目印があるのに動作なしと判断した 2 箇所は移行しなくてよい（list ${code}）`]);
  review(`- [x] C1 目印があるのに動作なしと判断した 2 箇所は移行しなくてよい（list ${code}）\n`);
  assert.deepEqual(problems(), []);
  assert.equal(ledgerSummary(dir, path.join(dir, C)).code, code);
  // Without such a site the item is not needed.
  write(dir, `${C}/coverage.md`, '| Site | Verdict | Evidence |\n|---|---|---|\n| `src/log.php:audit` | question Q1 | 2 |\n| `src/log.php:stamp` | question Q1 | 3 |\n| `src/log.php:name` | covered R1 | 4 |\n');
  write(dir, `${C}/questions.md`, '- Q1. Are audit and stamp still used?\n  - Recommended: keep\n  - Why: the old system does it\n');
  review('- [x] Q1 audit: decision: keep\n');
  assert.deepEqual(problems(), []);
  assert.equal(ledgerSummary(dir, path.join(dir, C)).code, null);
});

test('a marker line that holds no effect is set aside in the verdict, and the person confirms it', () => {
  const dir = tempDir();
  const C = 'openspec/changes/extract-shop-orders';
  write(dir, 'openspec/config.yaml', 'context: |\n  Source root (read-only): src\n');
  // Page text and script for the browser trip the markers of a page with code outside functions.
  write(dir, 'src/orders.php', [
    '<?php',
    '$rows = mysql_query("SELECT * FROM orders");',
    '?>',
    '<script>try { initCalendar(); } catch (e) {}</script>',
    '<p>Commit your changes before leaving. To delete from the list, press the button.</p>',
    '<?php mail("admin@example.com", "seen", ""); ?>',
    '',
  ].join('\n'));
  write(dir, 'openspec/changes/archive/2026-11-01-survey/inventory.md', '| Path | Context |\n|---|---|\n| src/ | shop |\n');
  write(dir, 'openspec/changes/archive/2026-11-01-survey/capabilities.md', '1. `shop/orders`\n   - `src/orders.php`\n');
  write(dir, `${C}/.openspec.yaml`, 'schema: spec-relay-extract\n');
  write(dir, `${C}/specs/shop/orders/spec.md`, '## Purpose\n\nOrders.\n\n## ADDED Requirements\n\n### Requirement: List orders\nThe system SHALL list.\n\n#### Scenario: s\n- **WHEN** x\n- **THEN** y\n');
  write(dir, `${C}/source-map.md`, '## Source files\n| Path | Role | In scope |\n|---|---|---|\n| src/orders.php | all | full |\n');
  write(dir, `${C}/trace.md`, '| Requirement | Source | Existing tests |\n|---|---|---|\n| List orders | src/orders.php:2 | none |\n');
  write(dir, `${C}/screens.md`, 'None\n');
  write(dir, `${C}/crosscheck.md`, '| Item | Verdict | Evidence |\n|---|---|---|\n| R1 List orders | confirmed | x |\n');
  write(dir, `${C}/questions.md`, 'None\n');
  const review = (extra = '') => write(dir, `${C}/review.md`, `Reviewer: Uma\n- [x] R1 List orders\n- [x] S0 This capability has no screens\n${extra}`);
  const ledger = (verdict) => write(dir, `${C}/coverage.md`, `| Site | Verdict | Evidence |\n|---|---|---|\n| \`src/orders.php:(file)\` | ${verdict} | 4: script for the browser; 5: page text |\n`);
  const problems = () => checkReview(dir, 'extract-shop-orders').problems;
  review();
  ledger('covered R1');
  const open = problems().join();
  assert.match(open, /no trace of R1 reaches its effect lines \(([^)]*4[^)]*5[^)]*mail 6)\)/);
  // Setting aside the page text does not set aside the mail: that line still needs a requirement.
  ledger('covered R1; no effect 4, 5');
  assert.match(problems().join(), /no trace of R1 reaches its effect lines \(mail 6\)/);
  write(dir, `${C}/trace.md`, '| Requirement | Source | Existing tests |\n|---|---|---|\n| List orders | src/orders.php:2, 6 | none |\n');
  // What was set aside is the person's to confirm, and the item names this list.
  const code = listCode(['src/orders.php:(file) no effect 4,5']);
  assert.deepEqual(problems(), [`review.md has no C1 item: 1 site with marker lines is judged "no behavior" or "no effect" (src/orders.php:(file) no effect 4,5); run draft.mjs review --change <change> --update, which adds "- [ ] C1 The marker lines of 1 site are judged to hold nothing to migrate (list ${code})" under "## 4. Coverage" for the person to decide`]);
  review(`- [x] C1 The marker lines of 1 site are judged to hold nothing to migrate (list ${code})\n`);
  assert.deepEqual(problems(), []);
  // Another line set aside is another list: the tick no longer counts.
  ledger('covered R1; no effect 4-6');
  write(dir, `${C}/trace.md`, '| Requirement | Source | Existing tests |\n|---|---|---|\n| List orders | src/orders.php:2 | none |\n');
  assert.match(problems().join(), /review item C1 is not for the list as it is now/);
  // The review page shows what was set aside, with the code the item must name.
  const summary = ledgerSummary(dir, path.join(dir, C));
  assert.equal(summary.code, listCode(['src/orders.php:(file) no effect 4,5,6']));
  assert.equal(summary.unmarked.length, 1);
  assert.match(summary.unmarked[0].markers, /^no effect: .*mail 6/);
  // A line that a trace reaches, or that holds no effect marker, sets nothing aside.
  ledger('covered R1; no effect 1, 2');
  write(dir, `${C}/trace.md`, '| Requirement | Source | Existing tests |\n|---|---|---|\n| List orders | src/orders.php:2-6 | none |\n');
  review();
  assert.deepEqual(problems(), []);
});

test('a trace symbol reaches its member however the two write the name', () => {
  const site = (symbol) => ({ file: 'src/a.cs', symbol });
  const ref = (symbol) => ({ file: 'SRC/A.cs', symbol, from: null, to: null });
  for (const [written, found] of [['[dbo].[usp_Save]', 'dbo.usp_Save'], ['"dbo"."usp_Save"', 'dbo.usp_Save'], ['Repo<T>.Get', 'Repo.Get'], ['App\\Models\\Order::save()', 'App.Models.Order.save'], ['Order->save', 'Order.save'], ['Save#2', 'OrderService.Save'], ['OrderService', 'OrderService.Save']]) {
    assert.equal(refReaches(ref(written), site(found), 10), true, `${written} -> ${found}`);
  }
  assert.equal(refReaches(ref('Service.Save'), site('OrderService.Save'), 10), false);
  assert.equal(refReaches(ref('page code'), site('(file)'), 10), false);
  assert.equal(refReaches({ file: 'src/a.cs', symbol: '', from: 3, to: 12 }, site('(file)'), 10), true);
  assert.equal(refReaches({ file: 'src/b.cs', symbol: '', from: 3, to: 12 }, site('(file)'), 10), false);
});
