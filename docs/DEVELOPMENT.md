# 開発

キット自体を直す人向けの説明です。

## リポジトリの構成

```text
plugin.json                    プラグイン定義（Agent Plugins 1.0）
.github/plugin/marketplace.json マーケットプレイス定義
com.github.copilot/agents/     オーケストレーター・解析担当・照合担当・実装担当・コードガイドの説明担当
com.github.copilot/hooks/      実行前に archive と書き込みを確かめるフック（既定は無効）と、サブエージェントの時間の記録
com.github.copilot/extensions/ canvas の拡張（進み具合・レビュー画面・仕様・コードガイドを Copilot の canvas に出し、レビューのチェックと判断、役立った Q&A を書き戻す。試験中）
skills/spec-relay/SKILL.md     オーケストレーターの手順
skills/spec-relay-view/        markdown を HTML にして見せるスキル
openspec-schemas/              移行用の OpenSpec スキーマ
templates/openspec-config.yaml 移行対象に置く OpenSpec 設定のひな形
scripts/setup.mjs              導入スクリプト（外部パッケージなし）
scripts/gate.mjs               承認・実装の前に使う機械的な確認（止まったときの次の一手も出す）
scripts/coverage.mjs           ファイル単位の網羅の確認（gate.mjs から使う。どの元ファイルもどれかの capability の仕様に入るか）
scripts/sites.mjs              元コードの箇所（メソッドや関数など）と目印の一覧。照合担当が箇所ごとに仕様の抜けを判定する台帳のもと
scripts/hook.mjs               フックの本体（gate を通らない archive と保護されたファイルへの書き込みを拒否）
scripts/status.mjs             進捗の計算（TODO リスト・チャット用）と、次に並列で始めてよい作業
scripts/finish.mjs             仕上げの工程（開始の確認、残りものの収集と下書き、移行先のハッシュ、仕上げの gate）
scripts/metrics.mjs            工程ごとにかかった時間の記録と集計
scripts/merge.mjs              サブエージェントが分担して書いた表を1つの成果物にまとめる
scripts/verify.mjs             実装のテスト・境界チェック・比べ方を実行し、結果を記録する（port-done が読む）
scripts/compare.mjs            比べ方 B1：元のプログラムから記録したケースと新しいコードの結果を1件ずつ比べる
scripts/http.mjs               比べ方 B1 の HTTP 版：動いている元のシステムにリクエストを送って記録し、新しいシステムに同じリクエストを送る
scripts/e2e.mjs                比べ方 B2・C：画面のテスト（Playwright）を元のシステムで通して記録し、同じテストを新しいシステムに流す
scripts/e2e-config.mjs         画面のテストを新旧で同じ条件にする Playwright の設定（e2e.mjs が使う）
scripts/run.mjs                verify と compare がコマンドを実行する部分（Windows では PowerShell）
scripts/render.mjs             成果物の markdown をレビュー用の HTML に、承認済みの仕様を読みものの HTML にする（デザイン固定）
scripts/canvas.mjs             canvas の画面を出すサーバー（拡張から使う。単独でブラウザーでも試せる）
scripts/review-edit.mjs        canvas から review.md への書き込み（チェック・判断・レビュー担当）と、その記録
scripts/guide.mjs              コードガイド（任意）の準備・ハッシュの記録・確認と、画面の部品（図は設計から描く）
scripts/doctor.mjs             最初の環境チェックとサブエージェントの試運転
scripts/known-files.mjs        過去の版のスキーマと OpenSpec を固定するファイルのハッシュ一覧（known-files.json）を git の履歴から作る
scripts/openspec.mjs           リポジトリに固定した OpenSpec CLI の起動（`node <キット>/scripts/openspec.mjs <引数>`、シェルを通さない）
templates/openspec-tools/      リポジトリに置く、OpenSpec の版を固定する package.json と package-lock.json
templates/e2e/                 移行先の tests/e2e/ に置く、Playwright の版を固定した package.json・設定・補助関数
tests/                         node:test のテスト（npm があれば、OpenSpec を実際に入れて動かす通しの確認も）
docs/WORKFLOW.md               流れと設計の説明、今後の課題
docs/SETUP.md                  導入の詳しい手順（アプリごとの許可、環境チェック、導入スクリプトのオプション）
docs/SAFEGUARDS.md             守っていること（確かめる仕組みの詳細）
docs/TROUBLESHOOTING.md        止まったときの表示と対処、フック
docs/UPGRADING.md              前の版から更新するとき
docs/DEVELOPMENT.md            キットの開発（この構成とテスト）
docs/WINDOWS.md                Windows での準備と注意点
docs/DATABASE.md               データベースの扱いと、定義の書き出し方
docs/COMPARE.md                比べ方 B1（元のプログラムから記録したケースとの比較）の書き方
docs/E2E.md                    シナリオごとの確認方法と、比べ方 B2・C（画面のテスト）の書き方
docs/CANVAS.md                 canvas で見る（試験中）
docs/GUIDE.md                  コードガイド（任意）
```

## テスト

```powershell
npm test
```

通しのテストは、一時フォルダーに `npm ci` で OpenSpec を入れて動かします（npm のレジストリへの接続が必要です）。npm がない端末では、その部分だけ skip と表示されます（CI では skip せず失敗にします）。OpenSpec の版を上げるときは、`templates/openspec-tools/package.json` の版を変えて、そのフォルダーで `npm install --package-lock-only --ignore-scripts` を実行し、lock ファイルを作り直します。`scripts/openspec.mjs` の `OPENSPEC_VERSION` と `scripts/doctor.mjs` の `OPENSPEC_TESTED` も合わせます（テストが3つの一致を確かめます）。新しい版の `engines`（OpenSpec と依存パッケージ）が変わったときは、Node.js の最低版も合わせます（`scripts/doctor.mjs` の `NODE_MIN` と `NODE_DEPS`、package.json の `engines`、`skills/spec-relay/SKILL.md`、`scripts/setup.mjs` の npm がないときの案内、README・docs/SETUP.md・docs/WINDOWS.md。これはテストでは確かめません）。移行中のリポジトリでは、導入スクリプトを実行し直すと古い package.json と package-lock.json が置き換わります（下の「過去の版のファイル」）。テストは一時フォルダーの設定を使うので、手元の OpenSpec の設定は変わりません。CI は Windows と Ubuntu の Node.js 22・24 で実行しています。

### 過去の版のファイル

導入スクリプトは、移行中のリポジトリのスキーマ（`openspec/schemas/spec-relay-*`）と `openspec/spec-relay/tools/` の3つのファイルが、キットの過去のどれかの版と同じ中身なら、衝突にせずにこの版のものに置き換えます（変更の予定には `replace` と出ます）。過去の版の中身は `scripts/known-files.json` に SHA-256 で持ちます（改行コードと BOM は無視、JSON は解析して比べる）。`openspec-schemas/` か `templates/openspec-tools/` を変えたら、キットのリポジトリ（浅い clone ではないもの）で次を実行し、known-files.json も一緒にコミットしてください。今の中身が一覧にないとテストが失敗します。

```powershell
node scripts/known-files.mjs
```

一覧から中身を消すと、その版から更新する人の導入スクリプトが衝突で止まるので、消さないでください。

画面のテストの通しの確認（Playwright を実際に入れてブラウザを動かす）は、`SPEC_RELAY_E2E_REAL=1` を付けたときだけ実行します（Windows は Edge、ほかは `SPEC_RELAY_E2E_CHANNEL=chrome` か `SPEC_RELAY_E2E_EXECUTABLE=<ブラウザのパス>`）。CI では Windows（Edge）と Ubuntu（Chrome）で実行しています。Playwright の版を上げるときは、`templates/e2e/package.json` の版を変えて、そのフォルダーで `npm install --package-lock-only --ignore-scripts` を実行します。
