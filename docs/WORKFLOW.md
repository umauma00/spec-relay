# spec-relay の流れと設計

この文書は、spec-relay の工程・成果物・判断の根拠をまとめたものです。オーケストレーターの手順そのものは [skills/spec-relay/SKILL.md](../skills/spec-relay/SKILL.md) にあり、こちらはその背景です。

## 全体像

```mermaid
flowchart LR
  S[元のコード<br/>読み取り専用] --> A
  subgraph P1[1. 解析]
    A[extract-&lt;capability&gt;<br/>source-map → specs → trace → questions → review]
  end
  A --> R
  subgraph P2[2. 人間がレビュー]
    R[review.md を1項目ずつ確認<br/>全項目チェックで archive]
  end
  R -->|archive| B[(openspec/specs/<br/>ベースライン仕様)]
  B --> I
  S -. trace.md 経由で詳細ロジックを参照 .-> I
  subgraph P3[3. 実装]
    I[port-&lt;capability&gt;<br/>proposal → design → tasks → apply]
  end
  I --> T[新しい言語の実装<br/>target root]
```

単位は **capability（機能のまとまり）** です。capability ごとに「解析 → レビュー → 実装」を回すので、全体を解析し終える前に、レビュー済みのものから実装を始められます。

## OpenSpec の使い方

spec-relay は OpenSpec の仕組みをそのまま使い、独自のスキーマを2つ足します。

| OpenSpec の概念 | spec-relay での意味 |
|---|---|
| `openspec/specs/` | レビュー済みの **ベースライン仕様**。新しい実装が満たすべき契約 |
| change（スキーマ `spec-relay-extract`） | 元のコードから仕様を起こす作業（工程 1・2） |
| change（スキーマ `spec-relay-port`） | ベースライン仕様を新しい言語で実装する作業（工程 3） |
| apply | extract では **人間のレビュー**、port では実装 |
| archive | extract では **承認**（仕様がベースラインになる）、port では完了 |
| `openspec/config.yaml` の context | 移行元・移行先の言語とフォルダー。全成果物の生成に注入される |

### extract スキーマの成果物

| 成果物 | 中身 | 誰が使うか |
|---|---|---|
| `source-map.md` | 範囲のファイル・入口・依存・範囲外 | レビュー担当、工程 3 |
| `specs/<capability>/spec.md` | 今の動作を言語に依存しない形で書いた要件とシナリオ | すべての工程の契約 |
| `trace.md` | 要件ごとの元コードの位置（パス・シンボル・行）と既存テスト | 工程 3 の実装担当 |
| `questions.md` | バグの疑い・曖昧な点・推測・移行しないもの | レビュー担当が判断する |
| `review.md` | 要件・質問・網羅性のチェックリスト | レビュー担当がチェックする |

仕様（spec）にはクラス名や関数名を書かず、元コードの位置は trace.md に分けます。仕様を新しい言語にも通用する契約に保ちながら、実装時には元のロジックへすぐたどれるようにするためです。

### port スキーマの成果物

| 成果物 | 中身 |
|---|---|
| `proposal.md` | 対象の capability、移行先、順番の理由、範囲外 |
| `design.md` | 移行先の構成、言語の意味の違いと決めたルール、要件ごとの元コード参照 |
| `tasks.md` | 要件・移行先ファイル・参照する元コード・確認方法を書いたタスク |

port は動作を変えないので、spec の差分を持ちません（`skip_specs: true`。OpenSpec が自動で付けます）。

## 人間のレビュー（工程 2）の守り方

このキットの要は工程 2 です。今の土台では次の4つで守っています。

1. **手順**：スキルとエージェントの指示で、AI は人がチャットで認めた項目だけをチェックし、明示的な承認なしに archive しない。直した項目はチェックを外して確認し直す。
2. **機械的な確認**：`openspec archive --yes` は未チェックの項目や、チェックリストに載っていない要件があっても止まらない（1.17.0 で確認）。そこで archive の前に `scripts/gate.mjs review` を実行し、すべての要件・質問に項目があること、すべてチェック済みであること、質問ごとの判断とレビュー担当の名前が書かれていることを確かめる。
3. **抜け道を外す**：OpenSpec 標準の apply・archive・sync のスキルとコマンドは、チェックを付けて archive まで進めてしまうため、導入スクリプトが中身をオーケストレーターへの案内に置き換える（ファイルを消すと、`openspec update` が利用者の OpenSpec 全体のプロファイルを狭めてしまうため、消さない）。
4. **記録**：review.md の各項目と質問への判断が change と一緒に archive に残る。

AI が自分でチェックを付けること自体を仕組みで止める（フックでの拒否）こと、チェック後に内容が変わったことを検出する（ハッシュの記録）ことは、次の段階の課題です（下の「今後の課題」）。

## 進捗の表示（Copilot の TODO）

進捗は Copilot が標準で持つ TODO リストに出します。オーケストレーターが `scripts/status.mjs` を実行し、その結果をホストの TODO ツールに渡します。

```text
- [ ] 全体: 12機能のうち3機能が移行済み（仕様確定 5）
- [x] billing/invoice: 解析
- [ ] ▶ billing/invoice: レビュー【レビュー待ち 3/8】 ← いまここ
- [ ] billing/invoice: 実装
```

| 決めたこと | 理由 |
|---|---|
| 全体1行と、いまの capability の3工程だけを出す | capability が数十あっても TODO が短いままで、今どこで次に何をするかが一目で分かる。全体の表は `--format markdown` でチャットに出す |
| 状態は OpenSpec のファイルだけから計算する | TODO はセッションごとに消える。正本は `openspec/` に置き、毎回そこから作り直せば、再開しても食い違わない |
| 人を待つ工程は「未着手」のまま、題名に理由を書く | どのホストも状態は「未着手・進行中・完了」の3つだけ。「進行中」は AI が作業している工程1つに限る |
| TODO のチェックは承認にならない | 承認は今までどおり、チャットでの人の明示的な返事と `gate.mjs` |
| TODO 用の JSON（`--format todo`）は ASCII だけで出す（日本語は `\uXXXX`） | Windows のコンソールのコードページ（cp932 など）を通っても題名が化けない |
| 毎回の報告の先頭にも同じ一覧を出す | ツール呼び出しが成功しても画面に出たとは限らない。TODO が使えないホストでもチャットで進捗が分かる |

各ホストの TODO（2026-11-10 時点の公式情報）：

| ホスト | ツール | 表示 |
|---|---|---|
| Copilot CLI | `update_todo`（エージェントの `todo` 指定は 1.0.100 から有効）。Markdown のチェックリストを1つ渡す | タイムラインに出る |
| VS Code（Local ハーネス） | `todo`。項目の配列（`id`・`title`・`description`・`status`）を渡す | Chat ビュー上部の Todo 欄 |
| VS Code（Copilot ハーネス）・Copilot app | `todo` に対応（Copilot app は Copilot CLI がもと） | 公式の記載なし。実機で確認する |

サブエージェント（解析担当・実装担当）は TODO を更新できません（VS Code の Local ハーネスでは公式に使えないと明記）。TODO を持つのはオーケストレーターだけです。

`plan.md` の `## Capabilities` の下に、字下げしない項目として並べた capability を、計画の順に数えます。下に `###` の見出し（たとえば境界づけられたコンテキストごと）を置いてもかまいません。計画にない仕様は表には出しますが、件数には入れません。計画が読めないとき、名前が衝突するとき、アーカイブ済みなのにベースライン仕様がないときなどは `problems` に出し、「すべて移行済み」とは表示しません。

工程は `status.mjs` の `STEPS` にデータとして並べてあり、成果物の数は change のスキーマ（`openspec/schemas/*/schema.yaml`）から数えます。成果物や工程を増やすときは、スキーマや `STEPS` に1項目足すだけで済みます。

## 先行例（code-migration-kit-with-github-copilot）から引き継いだこと

| 項目 | 先行例 | spec-relay |
|---|---|---|
| 入口 | オーケストレーター1つ | 同じ（`spec-relay-orchestrator`） |
| 配布 | Agent Plugins 1.0（`plugin.json`・`skills/`・`com.github.copilot/agents/`） | 同じ配置 |
| 対応アプリ | Copilot CLI・VS Code・Copilot app | 同じ |
| 手順の置き場所 | 非表示のスキル | 同じ |
| 元コード | 書き換えない | 同じ |
| 工程の記録 | キット独自の記録とハッシュ | OpenSpec の change と archive |
| 翻訳の単位 | ファイル | capability（仕様の単位） |
| 仕様 | 原則なし（ルールブックで変換） | 仕様が契約。元コードは詳細の参照 |

## 今後の課題

- フック（`com.github.copilot/hooks`）で、元コードへの書き込み、AI による review.md のチェック、`gate.mjs` を通らない archive を拒否する。
- レビュー時点の spec・trace・questions のハッシュを記録し、チェック後に内容が変わったら gate で落とす。
- 解析担当・実装担当をモデルから勝手に呼ばれないようにする（先行例は `disable-model-invocation: true` とランナー経由の起動。spec-relay はオーケストレーターがサブエージェントとして呼ぶため、ホストごとの挙動を確かめてから決める）。
- capability の分割と順番を決める調査（依存解析）の補助。
- port の結果を元のプログラムと同じ入力で比べる仕組み（先行例の parity 工程に相当）。
- 実アカウントでの Copilot CLI・VS Code・Copilot app の動作確認（まず Windows で）。TODO が各ホストの画面にどう出るかも、このときに確かめる。
- キットを更新したときに、導入済みリポジトリのスキーマを新しい版へ更新する手順（今は「キットの版と違う」と表示して止まる）。
