# spec-relay

[OpenSpec](https://github.com/Fission-AI/OpenSpec) を使って、コードベースを別のプログラミング言語へ移すための GitHub Copilot 用キットです。元のコードから仕様を起こし、人間がその仕様をレビューし、レビュー済みの仕様をもとに新しい言語で実装します。仕様と振る舞いを変えずに移し、画面の見た目をどこまで引き継ぐかは人が決めます。

> **状態：0.30.0**。工程の骨組み・OpenSpec スキーマ・導入スクリプト・テストまでです。実アカウントでの通し確認はまだ行っていません。

## 流れ

```mermaid
flowchart LR
  S[① 調査] --> D[② 移行先の設計] --> A[③ 解析<br/>元コード → 仕様] --> B[④ 人間がレビュー] --> C[⑤ 実装<br/>仕様 → 新しい言語] --> F[⑥ 仕上げ]
```

| 工程 | やること |
|---|---|
| 1. 調査 | コード全体を読み、DDD の境界付けられたコンテキストと capability に分ける。人がレビュー |
| 2. 移行先の設計 | モジュール構成（既定は Spring Modulith 型）、規約、画面の方針、新旧の比べ方を決める。人がレビュー |
| 3. 解析 | 元のコードから、言語に依存しない仕様と画面の記録を作る。別の AI が元コードと照合する |
| 4. レビュー | 人が HTML で仕様を確かめ、承認したら確定する |
| 5. 実装 | 確定した仕様をモジュールごとに実装し、すべてのシナリオを自動で確かめ、元と比べる |
| 6. 仕上げ | 全体をもう一度確かめ、残りものを一覧にして、引き渡しの報告を人がレビュー |

工程 1・2・6 はプロジェクトで1回、3〜5 は capability ごとに回すので、レビュー済みのものから実装を始められます。仕様の読み違いは `amend` で差分だけ直します。工程ごとの成果物と設計は [docs/WORKFLOW.md](docs/WORKFLOW.md) にあります。

## 必要なもの

主な実行環境は Windows です（macOS・Linux でも動きます）。

| 必要なもの | Windows での入れ方の例 |
|---|---|
| Node.js 22.20 以上（OpenSpec の要件。npm を含む） | `winget install OpenJS.NodeJS.LTS` |
| GitHub Copilot：CLI 1.0.109 以降、VS Code 1.143 以降（Copilot ハーネス）、または Copilot app | CLI は `npm install -g @github/copilot` |
| OpenSpec CLI 2.1.1 | 入れる必要はありません。導入スクリプトが移行対象のリポジトリの中に、この版を固定して入れます（npm のレジストリにつながる必要があります） |

Windows での準備と注意点は [docs/WINDOWS.md](docs/WINDOWS.md) にあります。

## はじめかた

1. **プラグインを入れる。** Copilot CLI では次の2行です（PowerShell でもそのまま動きます）。VS Code と Copilot app でも、同じ `umauma00/spec-relay` をマーケットプレイスとして追加して `spec-relay` を入れます。

   ```powershell
   copilot plugin marketplace add umauma00/spec-relay
   copilot plugin install spec-relay@spec-relay-marketplace
   ```

2. **移行したいリポジトリで頼む。** どのアプリでも入口は `spec-relay-orchestrator` エージェント1つです。選んでから、「C# から TypeScript への移行を始めて」のように頼みます。AI が環境を確かめ（`scripts/doctor.mjs`）、言語とフォルダーを聞いてから導入スクリプト（`scripts/setup.mjs`）を実行します。導入スクリプトは、まず変更内容を見せるだけで、`--apply` を付けたときに反映します。ほかのコマンドも AI が実行して報告します。
3. **ファイル編集を許可しておく。** 解析・照合・実装はサブエージェントが並列で進めます。最初の並列作業の前に、ファイルの編集をセッション中は許可しておくと、許可待ちで止まりません。許可はできるだけ `openspec/` と移行先のフォルダーに絞ってください（絞り方はアプリで違います）。

アプリごとの許可の設定、環境チェックの項目、並列数やモデルのオプション、導入で置かれるファイルは [docs/SETUP.md](docs/SETUP.md) にあります。

## OpenSpec の利用統計

OpenSpec は初期設定で、匿名の利用統計（コマンド名と版。コードや仕様の中身は含まない）を送ります。**キットは既定でこれを止めます。** 導入スクリプトの `openspec init` も含め、キットが起動する OpenSpec にはすべて環境変数 `OPENSPEC_TELEMETRY=0` を渡すので、利用者の設定は要りません。PC 全体の OpenSpec の設定（`%APPDATA%\openspec`）は変えません。

- 自分で環境変数 `OPENSPEC_TELEMETRY` を設定しているときは、その値を優先します（送ってもよい場合は `1`）。
- キットを通さずに `openspec` を直接実行したときは、この既定は効きません。

止まっているかは環境チェック（`scripts/doctor.mjs`）が確かめます。

## 守っていること

- **元のコードは書き換えない。** すべてのエージェントにとって読み取り専用です。
- **仕様の確定は人が決める。** AI は人が認めた項目だけをチェックし、承認なしに確定しません。確定の前に `gate.mjs` が、抜けや未判断がないことを機械的に確かめます。
- **仕様が契約。** 実装中に元コードと仕様が食い違ったら、AI は人に聞きます。仕様にない機能や「良かれと思って」の手直しはしません。
- **動きを確かめてから終える。** すべてのシナリオに自動の確認を付け、テストと、選んだ方法での新旧の比較が通った記録がそろうまで、実装を完了にしません。元のプログラムを動かさずに比べた場合は、同じ動きであることが推定だと知らせます。
- **工程を飛ばさない。** 「飛ばして」と頼まれても、AI は確認を外しません。これを強制する[フック](docs/TROUBLESHOOTING.md#フック試験中既定は無効)は試験中で、既定は無効です。

確かめる仕組みの詳細（画面の見た目、データベース、並列での進め方、進捗の表示、時間の記録など）は [docs/SAFEGUARDS.md](docs/SAFEGUARDS.md) にあります。

## 困ったとき

- **AI が止まった**：報告の最初に、止まった理由と、あなたにお願いすることが書かれます。表示ごとの意味と対処は [docs/TROUBLESHOOTING.md](docs/TROUBLESHOOTING.md) にあります。
- **キットを新しい版にした**：[docs/UPGRADING.md](docs/UPGRADING.md) で、更新する前に使っていた版の節と、それより上（新しい版）の節をすべて読んでください。

## ドキュメント

| ファイル | 中身 |
|---|---|
| [WORKFLOW.md](docs/WORKFLOW.md) | 流れと設計、工程ごとの成果物、今後の課題 |
| [SETUP.md](docs/SETUP.md) | 導入の詳しい手順 |
| [WINDOWS.md](docs/WINDOWS.md) | Windows での準備と注意点 |
| [SAFEGUARDS.md](docs/SAFEGUARDS.md) | 守っていることと、確かめる仕組み |
| [TROUBLESHOOTING.md](docs/TROUBLESHOOTING.md) | 止まったときの対処と、フック（試験中） |
| [UPGRADING.md](docs/UPGRADING.md) | 前の版から更新するとき |
| [DATABASE.md](docs/DATABASE.md) | データベースの扱い |
| [COMPARE.md](docs/COMPARE.md) | 元のプログラムの記録との比較（比べ方 B1） |
| [E2E.md](docs/E2E.md) | シナリオごとの確認と画面のテスト（比べ方 B2・C） |
| [CANVAS.md](docs/CANVAS.md) | Copilot の canvas で見る（試験中） |
| [GUIDE.md](docs/GUIDE.md) | コードガイド（任意） |
| [DEVELOPMENT.md](docs/DEVELOPMENT.md) | キットの開発（リポジトリの構成とテスト） |

## ライセンス

[MIT License](LICENSE) です。

- キットのスクリプトは外部のパッケージを使わず、ほかのプロジェクトのコードも同梱していません。
- Playwright（`@playwright/test`・`playwright`・`playwright-core` 1.64.1、いずれも Apache-2.0）も同梱していません。画面のテストを使う移行先で、利用者が `tests/e2e/` に `npm ci` で入れます（`templates/e2e/package-lock.json` で 2026-11-19 に確認）。
- OpenSpec（`@fission-ai/openspec`、MIT License）は同梱していません。導入スクリプトが npm から移行対象のリポジトリに入れます。固定している 2.1.1 と、それが使うパッケージを合わせた 66 個のライセンスは、MIT 54、ISC 7、BlueOak-1.0.0 4、BSD-3-Clause 1 です（`templates/openspec-tools/package-lock.json` で 2026-11-24 に確認）。OpenSpec の版を上げるときは、この内訳も確かめ直します。
- 構成と考え方は [code-migration-kit-with-github-copilot](https://github.com/umauma00/code-migration-kit-with-github-copilot)（Apache-2.0）を参考にしました。ファイルは写していません。違いは [docs/WORKFLOW.md](docs/WORKFLOW.md#先行例code-migration-kit-with-github-copilotから引き継いだこと) にあります。
