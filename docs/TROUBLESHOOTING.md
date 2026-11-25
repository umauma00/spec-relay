# 止まったとき

AI が止まったときは、報告の最初に「止まった理由」「あなたにお願いすること」「AI がやること」の3つを書きます。`gate.mjs` は、人にしかできないこと（`next.person`、利用者の言語の文）と、AI が直すこと（`next.agent`）を分けて出します。

| 表示・報告 | 意味 | あなたがすること |
|---|---|---|
| TODO の【レビュー待ち 3/8】 | レビューの途中 | 残りの項目を見て、チャットで承認するか review.md でチェックする |
| 「未承認の項目が N 件」 | gate review が未チェックの項目を見つけた | 同上 |
| 「承認者の名前がありません」 | review.md の `Reviewer:` が空 | 記録する名前を伝える |
| 「判断がまだの質問」 | questions.md の質問に判断がない | 新しいシステムでどうするかを決める |
| 「〜のレビューがまだ終わっていません」 | 実装の前に、その仕様のレビューが必要 | そのレビューを終える |
| 【全項目チェック済み・gate 未通過】 | 成果物の不備（照合の残り、項目の漏れなど）か、調査がまだ archive されていない | 不備なら何もしなくてよい（AI が直して確かめ直す）。調査が未完了なら、AI が用意する調査のレビューをする |
| 「archive してよいか」 | gate を通った | 確定してよければ「はい」と答える |
| 「同じ動きであることは…推定です」 | 実装の完了時。比べ方が A（仕様から作ったテスト）だけで、元のプログラムは動かしていない | 推定で足りるかを決めてから archive に答える |
| 「TODO(port) を残してよいか」 | 実装で終わらなかった箇所がある | 後の作業に回してよいかを決める（了承すると proposal.md の Follow-up に名前付きで残る） |
| 「割り当て外のファイルが変わりました」 | サブエージェントが担当外を書いた | 元に戻すか、受け入れるかを決める |
| `spec-relay:` で始まる拒否 | フックが実行前に止めた | 理由のとおり。設定や元コードを変えたいときは自分で変える |
| 導入スクリプトの「衝突」 | 既存ファイルと中身が違う（スキーマや `openspec/spec-relay/tools/` なら、キットの過去のどの版とも違う。誰かが書き換えたか、もっと新しい版のキットが置いた） | どちらを残すかを決める（何も変更されていない）。ほかの人がキットを更新したなら自分のキットも更新する。そうでなければ、元に戻すか消してから導入スクリプトを実行し直す |
| doctor の `kit-version`、導入スクリプトの `openspec/spec-relay/kit.json` の衝突 | ほかの人が新しい版のキットで導入し直した | 自分のキットを更新する。古いキットのまま導入スクリプトを実行したり、スキーマを消したりしない |
| コマンドがない・アクセス拒否など | 環境の問題 | AI が環境チェック（`scripts/doctor.mjs`）の直し方を伝えるので、そのとおりにする（[docs/WINDOWS.md](WINDOWS.md) も参照） |

同じ確認で2回直しても通らないときは、AI は止まって残りの問題を見せ、進め方を聞きます。

## フック（試験中・既定は無効）

プラグインには Copilot の preToolUse フック（`com.github.copilot/hooks/hooks.json`）が入っています。形式とツール名は Copilot CLI の公式資料に合わせています。VS Code（Copilot ハーネス）と Copilot app は同じ実行環境なので同じように動くはずですが、実機ではまだ確かめていません。有効にした移行対象のリポジトリでだけ、次を実行前に拒否します。

- gate を通らない `openspec archive`（`node <キット>/scripts/openspec.mjs`・`openspec`・`openspec.cmd`・`npx @fission-ai/openspec` などの書き方と、`cd` してからの実行を含む）、change 名のない archive、変数で名前を渡す archive、サブエージェントからの archive
- 元コード（元のフォルダーが `.` のときは `openspec/` と移行先のフォルダー以外のすべて）、`openspec/specs/`、`openspec/changes/archive/`、`openspec/schemas/`、`openspec/spec-relay/tools/`（固定した OpenSpec）、`openspec/config.yaml`、キット自体への書き込み
- サブエージェントによる review.md・questions.md・crosscheck.md・port の proposal.md と design.md・計画（plan.md）・学びの記録（lessons.md）の書き込み
- port のテスト実行の記録（`verify.json`）への書き込み（編集ツールでも、`Set-Content`・リダイレクト・`node -e` などのシェルコマンドでも。書くのは `verify.mjs` だけ）
- canvas での書き込みの記録（`openspec/spec-relay/local/canvas-log.jsonl`）への書き込み（編集ツールでも、シェルコマンドでも。書くのは canvas だけ）

有効にするには、`openspec/config.yaml` の context に次の1行を足すか、`on` に変えます（導入時なら `--hooks on`。導入済みのリポジトリでは `--hooks` は反映されないので、この行を自分で直します）。フックが有効な間、AI の編集ツールは config.yaml を書けず、この行や config.yaml を書き換えるシェルコマンドも拒否されます（無効の間も、AI には変えないように指示しています）。

```yaml
  Hook enforcement (on or off; on denies archives that fail the gate and agent writes to protected files): on
```

- 実機（特に Windows）での確認がまだなので、既定は無効です。node が見つからないなどでフックが動かないときは、拒否せずに通常の許可確認へ進みます（Copilot は終了コードが 0 以外だとそのツールの実行を拒否するので、壊れたフックですべての操作が止まらないよう、必ず 0 を返します）。
- シェルコマンドでの書き込み（`Set-Content` など）は、config.yaml・verify.json・canvas-log.jsonl へのもの以外は読み取りません。これはオーケストレーターの `gate.mjs guard` が後から見つけます。
- フックはプラグインを入れたすべてのリポジトリで、シェルとファイル編集の前に1回ずつ起動します（node の起動1回分。spec-relay のリポジトリでなければすぐ終わります）。ホストがプラグインの場所（`PLUGIN_ROOT`）を渡さないときは何もしません。
- チャットでの承認は AI が review.md に書くので、「AI が勝手にチェックを付ける」ことはフックでは区別できません。承認は今も、チャットでのあなたの言葉と gate の合格の両方です。
