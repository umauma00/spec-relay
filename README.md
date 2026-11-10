# spec-relay

[OpenSpec](https://github.com/Fission-AI/OpenSpec) を使って、コードベースを別のプログラミング言語へ移すための GitHub Copilot 用キットです。元のコードから仕様を起こし、人間がその仕様をレビューし、レビュー済みの仕様をもとに新しい言語で実装します。

> **状態：土台（0.1.0）**。工程の骨組み・OpenSpec スキーマ・導入スクリプト・テストまでです。実アカウントでの通し確認はまだ行っていません。

## 流れ

```mermaid
flowchart LR
  A[1. 解析<br/>元コード → 仕様] --> B[2. 人間がレビュー<br/>承認で仕様を確定] --> C[3. 実装<br/>仕様 → 新しい言語]
```

| 工程 | やること | OpenSpec 上の形 |
|---|---|---|
| 1. 解析 | 元のコードを読み、今の動作を言語に依存しない仕様にする | `extract-<capability>` change（スキーマ `spec-relay-extract`） |
| 2. レビュー | 人が要件・疑問点を1つずつ確認し、承認したら archive | extract change の apply と archive |
| 3. 実装 | 確定した仕様を新しい言語で実装。細かいロジックは元コードを参照 | `port-<capability>` change（スキーマ `spec-relay-port`） |

機能のまとまり（capability）ごとに回すので、レビュー済みのものから順に実装を始められます。詳しくは [docs/WORKFLOW.md](docs/WORKFLOW.md) を参照してください。

## 対応アプリ

GitHub Copilot CLI・VS Code・GitHub Copilot app を想定しています。入口はどれも **`spec-relay-orchestrator`** エージェント1つで、チャットで頼むと AI がコマンドを実行して報告します。

## 必要なもの

Windows を主な実行環境として扱います（macOS・Linux でも動きます）。Windows での入れ方と注意点は [docs/WINDOWS.md](docs/WINDOWS.md) にまとめています。

| 必要なもの | Windows での入れ方の例 |
|---|---|
| Node.js 22.12 以上（OpenSpec の要件） | `winget install OpenJS.NodeJS.LTS` |
| [OpenSpec CLI](https://github.com/Fission-AI/OpenSpec) 1.17.0（テストはこの版で実行） | `npm install -g @fission-ai/openspec@1.17.0` |
| GitHub Copilot（CLI・VS Code・Copilot app のいずれか） | |

## 導入

### プラグインとして入れる

Copilot CLI の場合（PowerShell でもそのまま実行できます）：

```powershell
copilot plugin marketplace add umauma00/spec-relay
copilot plugin install spec-relay@spec-relay-marketplace
```

VS Code と Copilot app でも、同じ登録元（`umauma00/spec-relay`）をマーケットプレイスとして追加して `spec-relay` を入れます。

### 移行対象のリポジトリを準備する

移行したいリポジトリを開いて `spec-relay-orchestrator` を選び、「Java から TypeScript への移行を始めて」のように頼みます。AI が言語とフォルダーを聞いたうえで、次の導入スクリプトを実行します（手で実行してもかまいません）。

```powershell
node "C:\path\to\spec-relay\scripts\setup.mjs" --target . --source-language "Java" --target-language "TypeScript" --source-root "src" --target-root "ts" --language ja
```

- これは確認だけで、何も書き換えません。内容を見てから、同じコマンドの最後に `--apply` を付けて反映します。
- PowerShell・コマンドプロンプト・bash のどれでも同じ1行で動きます。キットのパスは `"` で囲んでください（プラグインとして入れた場合は、ホームフォルダーの `.copilot\installed-plugins\` の下にあります）。

導入で置かれるもの：

| 場所 | 中身 |
|---|---|
| `openspec/schemas/spec-relay-extract/` | 工程 1・2 のスキーマとテンプレート |
| `openspec/schemas/spec-relay-port/` | 工程 3 のスキーマとテンプレート |
| `openspec/config.yaml` | 移行元・移行先の言語とフォルダー（全成果物の生成に使われる） |
| `.github/skills/openspec-*`、`.github/prompts/opsx-*` | `openspec init --tools github-copilot` が置く OpenSpec 標準のスキルとコマンド（propose・explore・update） |

- 内容の違う既存ファイルがあると、上書きせずに衝突を表示して止まります。`openspec init` が置き換え・削除・編集するファイル（既存の `opsx-*`・`openspec-*`、`openspec/AGENTS.md` など）が既にある場合も、同じく止まります。
- OpenSpec 標準の apply・archive（bulk-archive を含む）・sync（スキルとコマンド）は、レビューの確認を通らずにチェックや archive ができてしまうため、導入スクリプトが中身を「`spec-relay-orchestrator` を使ってください」という案内に置き換えて無効にします。ファイル自体を消さないのは、消すと後の `openspec update` が利用者の OpenSpec 全体の設定（Windows では `%APPDATA%\openspec`）から、ほかのプロジェクトも含めてこれらのワークフローを外してしまうためです。`openspec update` で元の中身に戻ったときは、もう一度導入スクリプトを実行してください。

## 守っていること

- **元のコードは書き換えない。** すべてのエージェントにとって読み取り専用です。
- **仕様の確定は人が決める。** AI は人がチャットで認めた項目だけをチェックし、明示的な承認なしに archive しません。archive の前に `scripts/gate.mjs review` で、すべての要件と質問がチェックリストにあり、チェック済みで、質問への判断とレビュー担当の名前が書かれていることを確かめます（`openspec archive --yes` 自体はこれを確かめません）。
- **実装の前後も確かめる。** port は、ベースライン仕様があることを `gate.mjs port-ready` で確かめてから始め、すべてのタスクの完了を `gate.mjs port-done` で確かめてから archive します。
- **仕様が契約。** 実装中に元コードと仕様が食い違ったら、AI はどちらかを選ばず人に聞きます。

## リポジトリの構成

```text
plugin.json                    プラグイン定義（Agent Plugins 1.0）
.github/plugin/marketplace.json マーケットプレイス定義
com.github.copilot/agents/     オーケストレーター・解析担当・実装担当
skills/spec-relay/SKILL.md     オーケストレーターの手順
openspec-schemas/              移行用の OpenSpec スキーマ
templates/openspec-config.yaml 移行対象に置く OpenSpec 設定のひな形
scripts/setup.mjs              導入スクリプト（外部パッケージなし）
scripts/gate.mjs               承認・実装の前に使う機械的な確認
scripts/openspec.mjs           OpenSpec CLI の起動（Windows でシェルを通さない）
tests/                         node:test のテスト（OpenSpec があれば通しの確認も）
docs/WORKFLOW.md               流れと設計の説明、今後の課題
docs/WINDOWS.md                Windows での準備と注意点
```

## 開発

```powershell
npm install -g @fission-ai/openspec@1.17.0
npm test
```

OpenSpec がない端末では、OpenSpec を実際に動かす通しのテストだけ skip と表示されます（CI では skip せず失敗にします）。テストは一時フォルダーの設定を使うので、手元の OpenSpec の設定は変わりません。CI は Windows と Ubuntu の Node.js 22・24 で実行しています。

ライセンスはまだ決めていません（LICENSE は未配置）。

構成と考え方は [code-migration-kit-with-github-copilot](https://github.com/umauma00/code-migration-kit-with-github-copilot) を参考にしています。違いは [docs/WORKFLOW.md](docs/WORKFLOW.md#先行例code-migration-kit-with-github-copilotから引き継いだこと) にあります。
