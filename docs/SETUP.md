# 導入の詳しい手順

[README](../README.md) の「はじめかた」の詳細です。Windows での注意点は [WINDOWS.md](WINDOWS.md) にあります。

OpenSpec CLI は、導入スクリプトが移行対象のリポジトリの中（`openspec/spec-relay/tools/`）に、キットが確かめた版（テストもこの版で実行）を `npm ci` で入れます。npm のレジストリにつながる必要があります。グローバルに入っている `openspec` は、どの版でも使いません。

## アプリごとの注意

- **VS Code** は Copilot ハーネス（1.143 から既定）で使ってください。Local ハーネスは 1.146（2026-11-11）で非推奨になり、2027年2月に削除される予定のため、対象にしていません。
- **Copilot CLI** は 1.0.109 以降を勧めます。並列に動くサブエージェントの許可確認の修正が 1.0.106 から 1.0.109 に入っています（確認が重複して残る、長いセッションでサブエージェントの操作が効かなくなる、など）。`copilot --version` で確かめられます。
- **ファイル編集の許可**：解析担当・照合担当・実装担当は自分のファイルを書きます。最初の並列作業の前にファイル編集をセッション中は許可しておくと、サブエージェントが許可待ちで止まりません。許可はできるだけ `openspec/` と移行先のフォルダーに絞ってください。

  | アプリ | 許可の選び方（2026-11-11 時点の公式情報） |
  |---|---|
  | VS Code | 権限は Manual・Assisted・Allow all。Manual では編集の許可をファイル単位かフォルダー単位で出せますが、フォルダー単位は Git リポジトリ全体が対象で、元コードも含みます。`chat.tools.edits.autoApprove` 設定で、ファイルパターンごとに承認の要否を決められます（例：`{"**/*": false, "openspec/**": true, "<移行先のフォルダー>/**": true}`） |
  | Copilot app | Ask every time・Assisted・Approve all |
  | Copilot CLI | `/permissions` で、毎回確認・assisted・allow-all を切り替えます。「このリポジトリでは今後確認しない」は Git リポジトリ全体が対象です。並列のファイル操作でこれを選ぶと、同時に出ていた確認もまとめて承認されます（1.0.109 から）。並列に起動した呼び出しのどれか1つを拒否すると、一緒に起動したものも取り消されます |

  リポジトリ全体を許可した場合でも、オーケストレーターが波の前後に `gate.mjs guard` で元コード・review.md・ベースライン仕様などのハッシュを比べ、割り当て外の変更があれば止まって知らせます。

## プラグインとして入れる

Copilot CLI の場合（PowerShell でもそのまま実行できます）：

```powershell
copilot plugin marketplace add umauma00/spec-relay
copilot plugin install spec-relay@spec-relay-marketplace
```

VS Code と Copilot app でも、同じ登録元（`umauma00/spec-relay`）をマーケットプレイスとして追加して `spec-relay` を入れます。

## 最初に環境を確かめる

移行の途中で環境が原因で止まらないよう、オーケストレーターは毎回のセッションの最初に `scripts/doctor.mjs` で環境を確かめ、足りないものと、それぞれ何をすればよいかを知らせます。`FAIL` があるうちは調査を始めません。手で実行することもできます（何も書き換えません）。

```powershell
node "C:\path\to\spec-relay\scripts\doctor.mjs" --target . --client cli
```

`--client` は使うアプリに合わせて `cli`・`vscode`・`app` のどれかにします。確かめること：

| 対象 | 確かめること | 足りないとき |
|---|---|---|
| Node.js | 22.20 以上（古い Node.js でも、このメッセージは出ます） | FAIL |
| キット | スキーマ・スクリプト・エージェントがそろっているか | FAIL |
| OpenSpec CLI | 導入前は npm があるか。導入後は、リポジトリの中の OpenSpec が入っていて動くか、版が 2.1.1 か（違えば FAIL。clone した直後で未導入のときは、導入スクリプトの再実行を案内） | FAIL |
| OpenSpec の利用統計 | キットの既定（`OPENSPEC_TELEMETRY=0` を渡す）で止まっているか。利用者が `OPENSPEC_TELEMETRY` を自分で設定して送る状態なら、そう知らせる | INFO |
| PowerShell | 実行ポリシーで `npm` が止まるか（`npm.cmd` を案内） | INFO |
| Copilot のアプリ | Copilot CLI 1.0.109 以上、VS Code 1.143 以上 | WARN |
| git | git があるか、リポジトリの一番上か、「所有者が違う」で拒否されていないか、長いパス | WARN |
| フォルダー | 書き込めるか（「コントロールされたフォルダー アクセス」など）、OneDrive などの同期フォルダーやネットワーク上のフォルダーでないか | FAIL・WARN |
| 導入済みのリポジトリ | スキーマがキットの版と同じか、`openspec update` で apply・archive・sync が戻っていないか、openspec/config.yaml に `skillsScope: project` があるか、`.agents/skills/` に OpenSpec のスキルが残っているか、元コードのフォルダーがあるか、移行先の言語のビルド道具（JDK・Python・.NET SDK など） | FAIL・WARN |
| ホームフォルダーの OpenSpec のスキル | 導入済みのリポジトリで、Copilot がどのリポジトリでも読む `~/.agents/skills` と `~/.copilot/skills` に、OpenSpec 標準のスキルがないか（OpenSpec 2.1 以降は、ほかのプロジェクトの `openspec init` が既定で `~/.agents/skills` に入れます。レビューの確認を通らない archive に使われるおそれがあります）。フックが有効なら INFO | WARN |
| サブエージェント | 導入のあとに1回、解析・照合・実装担当を同時に起動して、それぞれファイルを1つ書かせる試運転（`--trial`・`--trial-check`。実装担当は移行先のフォルダーに書き、`node --version` も実行）。エージェントが見つかるか、モデルが使えるか、書き込みとコマンド実行の許可が出るかを最初に確かめます | FAIL |

終了コードは、0 なら始められる（WARN が残ることはある）、1 なら FAIL を直してからです。試運転の結果は PC とアプリごとに `openspec/spec-relay/local/trial.json`（git では無視）に残り、モデルの設定を変えたときや、別の PC・アプリで使い始めたときは、もう一度試運転を求めます。

## 移行対象のリポジトリを準備する

移行したいリポジトリを開いて `spec-relay-orchestrator` を選び、「Java から TypeScript への移行を始めて」のように頼みます。AI が言語とフォルダーを聞いたうえで、次の導入スクリプトを実行します（手で実行してもかまいません）。

```powershell
node "C:\path\to\spec-relay\scripts\setup.mjs" --target . --source-language "Java" --target-language "TypeScript" --source-root "src" --target-root "ts" --language ja
```

- これは確認だけで、何も書き換えません。内容を見てから、同じコマンドの最後に `--apply` を付けて反映します。
- PowerShell・コマンドプロンプト・bash のどれでも同じ1行で動きます。キットのパスは `"` で囲んでください（プラグインとして入れた場合は、ホームフォルダーの `.copilot\installed-plugins\` の下にあります）。
- 並列化の設定（あとから変えるときは `openspec/config.yaml` の値を書き換えます）：

  | オプション | 中身 | 既定 |
  |---|---|---|
  | `--parallel 16` | 同時に動かすサブエージェントの数（1〜32） | 4 |
  | `--ahead 2` | レビューより先に解析しておく機能の数（1〜10） | 2 |
  | `--subagent-model "<モデル>"` | サブエージェント（解析・照合・実装担当）のモデル | `session`（オーケストレーターと同じ） |
  | `--checker-model "<モデル>"` など | 役割ごとのモデル（`--analyst-model`・`--implementer-model` も） | `--subagent-model` と同じ |

  同時実行数の上限は Copilot の契約で違います。Copilot CLI のリファレンス（2026-11-10 時点）では Free 2、Pro 4、Max 8、Business 16、Enterprise と従量課金 32 で、孫のサブエージェントも含めたセッション全体の数です。従量課金でない契約ではこの数を上げられません。VS Code と Copilot app の上限は公式に書かれていません。モデルは、オーケストレーターがサブエージェントに頼むときに指定します。セッションのモデルが Auto のときや、ホストが指定を受け付けないときは、オーケストレーターと同じモデルで動きます。

導入で置かれるもの：

| 場所 | 中身 |
|---|---|
| `openspec/schemas/spec-relay-*/` | 各工程のスキーマとテンプレート（survey・target・extract・amend・port・finish） |
| `openspec/config.yaml` | 移行元・移行先の言語とフォルダー（全成果物の生成に使われる） |
| `openspec/spec-relay/tools/` | キットが確認した版の OpenSpec を固定する package.json と package-lock.json（コミットします）。`npm ci` で入る `node_modules/` は Git の対象外です。OpenSpec は `node "<キットのフォルダー>/scripts/openspec.mjs" <引数>` で呼びます（キットのスクリプトもオーケストレーターもこれを使います） |
| `openspec/spec-relay/kit.json` | 最後に導入したキットの版（コミットしてください）。新しい版のキットがスキーマなどを変えたあとに古いキットで導入スクリプトを実行すると、ここで止まります |
| `.agents/skills/openspec-*` | `openspec init --tools github-copilot --scope project` が置く OpenSpec 標準のスキル。導入スクリプトがすべて「`spec-relay-orchestrator` を使ってください」という案内に置き換えます（下の説明）。Copilot はこのフォルダーを直接読むので、リンクは作られません |

- キットを更新したあとに導入スクリプトを実行し直すと、前の版のキットが置いたスキーマと `openspec/spec-relay/tools/` の3つのファイルは、そのまま新しい版に置き換わります（`replace`）。中身が過去のどの版とも違うファイル（誰かが書き換えたもの）は置き換えずに衝突として止まります。キットは過去の版の中身を `scripts/known-files.json` にハッシュで持っています。
- 内容の違う既存ファイルがあると、上書きせずに衝突を表示して止まります。`openspec init` が置き換え・削除・編集するファイル（`.agents/skills/` の既存の `openspec-*` と `.openspec-target`、OpenSpec 1.x が `.github/`・`.claude/`・`.cursor/` などのツールのフォルダーに置いた `openspec-*`・`opsx*`、`openspec/AGENTS.md` など）が既にある場合も、同じく止まります。
- OpenSpec 標準のスキルは、導入スクリプトが中身を「`spec-relay-orchestrator` を使ってください」という案内に置き換えて無効にします。apply・archive（bulk-archive を含む）・sync はレビューの確認を通らずにチェックや archive ができてしまい、propose・explore などのほかのスキルも、固定した版ではなく PATH にある `openspec`（どの版か分からないか、入っていない）を呼ぶためです。ファイル自体を消さないのは、消すと後の `openspec update` が利用者の OpenSpec 全体の設定（Windows では `%APPDATA%\openspec`）から、ほかのプロジェクトも含めてこれらのワークフローを外してしまうためです。OpenSpec 2.x の `openspec update`（`node "<キットのフォルダー>/scripts/openspec.mjs" update`）は毎回これらを元の中身に戻すので、update のあとは毎回、導入スクリプトをもう一度実行してください（doctor が `workflows` で知らせます）。
- OpenSpec 2.1 から、`openspec init` は何も指定しないとスキルをホームフォルダー（`~/.agents/skills`、すべてのプロジェクト用）に入れます。そこではキットがスキルを無効にできないので、導入スクリプトは `--scope project` を付けて実行し、openspec/config.yaml に `skillsScope: project` を書きます。この行があると、`openspec update` は「スキルをどこに置くか」を尋ねず、リポジトリの中のまま更新します（キットの `openspec.mjs` は、init と update をそもそも質問しない形で起動します）。この行は消したり `global` に変えたりしないでください（doctor が `skills-scope` で FAIL にします。スキルがリポジトリからなくなったときは `repo-skills` で FAIL にし、戻し方を案内します）。
- OpenSpec 2.1 の `openspec update` は、ホームフォルダー（`~/.agents/skills`）にも OpenSpec のスキルがあると、それもこの版の内容に更新します（手で変えた内容は上書きされ、ほかのプロジェクトが別の版の OpenSpec を使っていても同じです）。また init と update は、実行したリポジトリの場所を `%LOCALAPPDATA%\openspec\projects.json`（macOS・Linux は `~/.local/share/openspec/projects.json`）に記録します。どちらも OpenSpec 自体の動作です。
- 導入済みのリポジトリでは、導入スクリプトは `node "<キットのフォルダー>/scripts/setup.mjs" --target . --apply` だけで再実行できます（言語やフォルダーは openspec/config.yaml から読みます）。リポジトリを新しく clone した人は、最初にこれを実行してください。`openspec/spec-relay/tools/` の lock ファイルどおりに `npm ci` で OpenSpec を入れます（doctor が知らせます）。
- `openspec/spec-relay/tools/` の package.json と package-lock.json は、Dependabot や Renovate などの依存関係の自動更新の対象から外してください。版を上げるのはキットの更新のときだけです（キットの版と違う中身は導入スクリプトが衝突として止め、doctor が FAIL にします）。
