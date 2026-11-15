# データベースの扱い

古いシステムは、ロジックの一部をデータベースの中に持っていることがよくあります。ストアドプロシージャ・トリガー・ビュー・関数・制約や既定値・定期ジョブです。仕様と振る舞いをそのまま保つ移行では、これもコードと同じく移行の対象です。spec-relay は次のように扱います。

| 工程 | データベースについてやること |
|---|---|
| 1. 調査 | 使っているデータベースと、その定義がどこにあるかを `database.md` に記録します。リポジトリに定義がなければ、人が書き出して `openspec/spec-relay/db/` に置きます。書き出した定義は元コードと同じく inventory に入り、どのコンテキストのものかを決めます |
| 2. 移行先の設計 | `data.md` で一度だけ決めます。スキーマの方針（既定はそのまま使う）、DB の中のロジックを種類ごとに残すか移すか、SQL 方言や ORM の違いの規則、スキーマを変えさせない設定、テスト用のデータベース |
| 3. 解析 | トリガーの効果や制約による拒否も仕様に書き、trace.md は定義ファイルを指します。照合担当は、テーブルに書き込む要件で、そのテーブルのトリガー・制約・既定値も読みます |
| 5. 実装 | `data.md` に従ってデータベースを使います。スキーマや DB のオブジェクトは変えず、テスト用のデータベース以外には接続しません |

## 既定の考え方

| 論点 | 既定 | 理由 |
|---|---|---|
| スキーマ | そのまま使う | 振る舞いを保つ移行で、データ移行も要らず、新旧を同じデータベースで並べて動かせます。作り直しは移行のあとの別作業です |
| トリガー・制約・既定値・シーケンス・ビュー | データベースに残す | 誰が書き込んでも効くため（古いシステムや手作業の SQL も含む）。アプリへ移すと漏れやすくなります |
| ストアドプロシージャ・関数 | 残して呼ぶ | 製品を替えるときや、人が選んだものだけ移します |
| ジョブ（SQL Server Agent など） | バッチの capability として仕様にする | どこで動かすかは人が決めます |

例外は `data.md` の「Exceptions」に1件ずつ書きます。レビューの項目は種類ごとに1つなので、オブジェクトの数だけレビューが増えることはありません。

## 定義を書き出す

定義がリポジトリにない（または古い）データベースは、人が書き出します。AI はデータベースに接続しません。頼めばコマンドの実行は手伝いますが、相手のデータベースとサインインはあなたが決めます。

- 本番ではなく、**複製か開発用のデータベース**から書き出してください。
- 置き場所は `openspec/spec-relay/db/<データベースの短い名前>/` です。**UTF-8** で保存し、リポジトリにコミットします。
- パスワードや接続文字列は、コマンドにもファイルにも書きません。Windows 認証を使うか、環境変数（例：`SR_DB_USER`）やパスワードの入力を使います。
- 書き出したら、オーケストレーターに伝えます。AI が `node "<キットのフォルダー>/scripts/gate.mjs" db-hash` でハッシュを取り、UTF-16 のファイルがあれば知らせます。

データベースごとの書き出し方の例です（2026-11-15 時点の各製品の公式文書をもとにしています。Windows の実機ではまだ試していません）。

### SQL Server

[SqlPackage](https://learn.microsoft.com/sql/tools/sqlpackage/sqlpackage-extract) の Extract で、オブジェクトごとの .sql ファイルにします。`/p:ExtractTarget=SchemaObjectType` で、スキーマ名と種類ごとのフォルダーに分かれます。

```powershell
dotnet tool install -g microsoft.sqlpackage
SqlPackage /Action:Extract /SourceServerName:"localhost" /SourceDatabaseName:"Sales" /SourceTrustServerCertificate:True /TargetFile:"openspec/spec-relay/db/sales" /p:ExtractTarget=SchemaObjectType
```

- サインインを指定しなければ Windows 認証です。SQL 認証なら `/SourceUser:$env:SR_DB_USER /SourcePassword:$env:SR_DB_PASSWORD` を足します（値は環境変数に入れ、コマンドに直接書きません）。
- **SQL Server Agent のジョブは含まれません**（msdb にあるため）。SSMS の「ジョブをスクリプト化」で書き出し、`openspec/spec-relay/db/sales/jobs/` に置きます。
- SSMS の「スクリプトの生成」でも書き出せますが、保存形式が Unicode（UTF-16）になることがあります。そのときは下の「UTF-16 を UTF-8 にする」で変換します。

### MySQL・MariaDB

```powershell
mysqldump --no-data --routines --triggers --events --skip-dump-date --default-character-set=utf8mb4 --result-file="openspec/spec-relay/db/shop/schema.sql" -u $env:SR_DB_USER -p shop
```

- 出力先は必ず `--result-file` で指定します。Windows PowerShell 5.1 で `>` を使うと UTF-16 になります。
- `--skip-dump-date` を付けると、書き出し直しても日付だけでハッシュが変わることがありません。

### PostgreSQL

```powershell
pg_dump --schema-only --no-owner --file="openspec/spec-relay/db/shop/schema.sql" -h localhost -U $env:SR_DB_USER shop
```

パスワードは入力を求められます（環境変数 `PGPASSWORD` も使えます）。

### Oracle

`DBMS_METADATA.GET_DDL` で、テーブル・ビュー・パッケージ・トリガー・シーケンスなどの定義を取り出します（SQL Developer や SQLcl から実行できます）。1オブジェクト1ファイルにすると、コンテキストに振り分けやすくなります。

### SQLite

```powershell
sqlite3 app.db ".output openspec/spec-relay/db/app/schema.sql" ".schema"
```

### 定義が取れないとき

Access のファイルが失われた、暗号化されたストアドがある、別のサーバーにある、権限がない、といった場合は、`database.md` の「Missing definitions」に何がないかと理由を書きます。そのデータベースの「Definitions」の欄は `none` にします。解析では、コードから読める範囲で仕様にし、残りは質問（questions.md）として人が判断します。

## マスタの表のデータ

区分値・メッセージ・メニュー・設定のような表は、中身が振る舞いを決めます。必要なら、人が選んだ小さな表だけ `openspec/spec-relay/db/<データベース>/data/<表>.csv` に置けます。個人情報や業務データを含む表は置かないでください。置いたファイルも inventory の対象です。

## UTF-16 を UTF-8 にする

`gate.mjs db-hash` や調査の gate が UTF-16 と知らせたファイルだけを、PowerShell で変換します（Windows PowerShell 5.1 と PowerShell 7 のどちらでも動きます）。

```powershell
$f = Resolve-Path "openspec/spec-relay/db/sales/dbo/Procedures/usp_Close.sql"; [IO.File]::WriteAllText($f, [IO.File]::ReadAllText($f))
```

`ReadAllText` は先頭の BOM で UTF-16 を判別し、`WriteAllText` は BOM なしの UTF-8 で書きます。知らされていないファイル（Shift_JIS など）に使うと文字化けするので、使わないでください。

## 定義が変わったとき

`database.md` には、書き出した定義全体のハッシュを記録します。調査を archive したあとで `openspec/spec-relay/db/` の中身が変わると、解析のレビューと実装の開始（`gate.mjs port-ready`）が止まります。改行コード（CRLF と LF）と BOM の違いは数えません。

- 意図して取り直したとき（データベースが変わった）：調査をやり直し（`survey-v2`）、変わった定義の振り分けと `database.md` をレビューします。
- 意図しない変更：git で元に戻します。

## 確かめていないこと

- 上の書き出しコマンドは各製品の公式文書をもとにしており、Windows の実機と各データベースではまだ試していません。とくに SqlPackage の `/TargetFile` にフォルダーを渡す書き方は、実機で確かめる必要があります。
- テスト用のデータベースは、Windows 11 で追加の費用なしに動くもの（SQL Server Express や LocalDB、各製品のインストーラー）を勧めます。Docker Desktop は、従業員 250 人以上か年間売上 1,000 万ドル超の組織では有料の契約が要るため（[Docker の規約](https://docs.docker.com/subscription/desktop-license/)）、既定にはしていません。
