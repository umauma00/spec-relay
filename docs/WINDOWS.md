# Windows で使う

spec-relay は Windows を主な実行環境として扱います。GitHub Actions の `windows-latest`（PowerShell 7、Node.js 22 と 24）で、実際の OpenSpec CLI を使う通しのテストを含めて毎回 `npm test` を実行しています。実際の Copilot CLI・VS Code・Copilot app の画面からの確認はまだです。

## 用意するもの

| 必要なもの | 入れ方の例 | 確認 |
|---|---|---|
| Node.js 22.20 以上（npm を含む） | `winget install OpenJS.NodeJS.LTS` | `node --version`、`npm.cmd --version` |
| Git for Windows | `winget install Git.Git` | `git --version` |
| OpenSpec CLI 2.0.0 | 入れる必要はありません。導入スクリプトが移行対象のリポジトリの中（`openspec\spec-relay\tools\`）に `npm ci` で入れます | `node "C:\path\to\spec-relay\scripts\openspec.mjs" --version`（導入後、リポジトリの中で） |
| GitHub Copilot | CLI は `npm install -g @github/copilot`（1.0.109 以降）、または VS Code（1.143 以降、Copilot ハーネス）・Copilot app | `copilot --version` |

入れた直後は、開いていたターミナルに PATH が反映されていません。新しいターミナルを開いてください。

そろったかは、次のコマンドで確かめられます（オーケストレーターも毎回のセッションの最初に実行します）。Windows では、PowerShell の実行ポリシー、書き込みを止める「コントロールされたフォルダー アクセス」、OneDrive などの同期フォルダー、git の「所有者が違う」（`safe.directory`）と長いパスも確かめます。

```powershell
node "C:\path\to\spec-relay\scripts\doctor.mjs" --target . --client cli
```

## PowerShell で「スクリプトの実行が無効」と出るとき

`npm` を実行して「このシステムではスクリプトの実行が無効になっているため…」と出るのは、PowerShell が `npm.ps1` を先に見つけるためで、コマンドが無いわけではありません。次のどちらかで動きます。

- `npm.cmd --version` のように `.cmd` を付けて実行する。
- 自分の判断で実行ポリシーを変える（`Set-ExecutionPolicy -Scope CurrentUser RemoteSigned`）。AI にはこの変更を勝手にさせません。

キットは OpenSpec を `node` で直接起動し（`node "<キットのフォルダー>\scripts\openspec.mjs" <引数>`）、導入スクリプトも npm を `node` で直接起動するので、この設定の影響を受けません。

実装のテストを実行する `scripts/verify.mjs` は、移行先の設計で決めたコマンド（`npm test` など）を Windows PowerShell で実行します。そのとき、起動するプロセスだけ `-ExecutionPolicy Bypass` を付けるので、`npm.ps1` で止まりません。実行ポリシーの設定そのものは変えません（組織のグループポリシーで決められている場合は、そちらが優先されます）。

## 導入スクリプトを手で実行する

PowerShell・コマンドプロンプトのどちらでも、1行で書きます（行末の `\` で折り返す書き方は bash 専用です）。パスは必ず `"` で囲んでください。

```powershell
# プラグインとして入れた場合、キットは %USERPROFILE%\.copilot\installed-plugins\ の下にあります
node "C:\path\to\spec-relay\scripts\setup.mjs" --target . --source-language "C#" --target-language "TypeScript" --source-root "src" --target-root "ts" --language ja
```

内容を確認したら、同じコマンドの最後に `--apply` を付けて実行します。ふだんはこの手順を `spec-relay-orchestrator` が行うので、手で実行する必要はありません。

## キットが Windows で自動的に扱うこと

- **OpenSpec の起動**：リポジトリの中（`openspec\spec-relay\tools\node_modules\`）の OpenSpec 本体のスクリプトを `node` で直接起動します。`openspec.cmd` などのシムやグローバルに入っている版は使いません。npm も、`npm.cmd` の隣にある `npm-cli.js` を `node` で直接起動します。
- **改行**：Git for Windows の既定（`core.autocrlf=true`）でスキーマや設定が CRLF になっても、キットの版と同じものとして扱います。レビューの確認（`gate.mjs`）も CRLF と UTF-8 の BOM を読めます。キット自体は `.gitattributes` で LF に固定しています。
- **パス**：`--source-root` と `--target-root` は `\` と `/` のどちらでも書けて、設定には `/` で記録します。大文字と小文字の違いだけの名前は同じフォルダーとして扱います。`con`・`nul` などの予約名、末尾が `.` や空白の名前、`: * ? " < > |` を含む名前は受け付けません。
- **空白を含むフォルダー**：`C:\Users\Taro Yamada\...` のような場所でも動きます。
- **画面のテスト（比べ方 B2・C）**：Playwright は Windows 11 に入っている Edge（`channel: 'msedge'`）を使うので、ブラウザのダウンロードは要りません。Playwright 本体は `tests\e2e\node_modules\` の `cli.js` を `node` で直接起動し、`npx` やシェルは通しません（[E2E.md](E2E.md)）。

## 気をつけること

- **文字コード**：成果物（spec・trace・questions・review・tasks）は UTF-8 で保存してください。Windows PowerShell 5.1 の `>` や `Out-File` は UTF-16 で書き出すため、OpenSpec が読めません。`gate.mjs` は UTF-16 のファイルを見つけると不合格にして知らせます。
- **capability の名前**：英小文字・数字・ハイフンだけにします（例：`billing/invoice`）。日本語や大文字、`_` は OpenSpec が受け付けません。日本語の名前は計画（`openspec/spec-relay/plan.md`）に併記します。
- **長いパス**：capability のパスは archive の中で繰り返されるため、深い場所では 260 文字の制限に当たることがあります。リポジトリは `C:\work\proj` のような短い場所に置くか、長いパスを有効にしてください（`git config --global core.longpaths true`）。
- **ネットワーク上のフォルダー**：`\\server\share\...` や `\\wsl.localhost\...` でも OpenSpec は `node` で起動するので動きますが、npm が `npm.cmd` しか見つからない環境では、cmd.exe がこうした場所を作業フォルダーにできないため、導入スクリプトがその旨を表示して止まります。ファイルの操作も遅く、ロックで失敗しやすくなります。
- **シンボリックリンク**：OpenSpec 2.0.0 は Claude Code など一部のツール向けに、`.agents/skills/` のスキルへのリンクを作ります。キットは `--tools github-copilot` だけで導入し、Copilot は `.agents/skills/` を直接読むので、リンクは作られません（ほかのツール向けの OpenSpec のファイルがあると、導入スクリプトはその前に止まります）。開発者モードや `git config core.symlinks true` は要りません（OpenSpec 2.0.0 のコードで確認。Windows の実機ではまだ試していません）。
- **WSL**：WSL の中で使う場合は Linux として動きます。Windows 側のツールと WSL 側のファイルを混ぜないでください。
- **OpenSpec 全体の設定**：OpenSpec は利用者ごとの設定を `%APPDATA%\openspec\` に持ちます。spec-relay はここを書き換えません。
