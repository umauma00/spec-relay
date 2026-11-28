# 前の版から更新するとき

キットを新しい版にしたら、移行中のリポジトリで導入スクリプトをもう一度実行してください（`node "<キットのフォルダー>/scripts/setup.mjs" --target . --apply`。オーケストレーターに頼めば、doctor の結果を見て実行します）。何段飛ばした更新でも、この1回で済みます（0.6.0 以前から上げるときだけは、下の「0.6.0 から更新するとき」の手順です）。

- 前の版のキットが置いたスキーマ（`openspec/schemas/spec-relay-*`）と、OpenSpec の版を固定するファイル（`openspec/spec-relay/tools/` の package.json・package-lock.json・.gitignore）は、そのまま新しい版に置き換わります（変更の予定に `replace` と出ます）。0.24.0 より前のキットのときのように、先に消す必要はありません。下の節にある「`openspec/schemas/spec-relay-*` を削除してから」「package.json と package-lock.json を消してから」は飛ばしてください。
- 置き換えるのは、中身がキットの過去のどれかの版と同じファイルだけです。誰かが書き換えたファイルは「衝突」と表示して、何も変えずに止まります。元に戻すか消してから、もう一度実行してください。
- 導入スクリプトは、最後に導入したキットの版を `openspec/spec-relay/kit.json` に記録します。終わったら、これを含めて変わったファイルをコミットします。ほかの人は pull したあと、自分のキットも同じ版に更新してから、導入スクリプトを実行します。古いキットのままだと、新しい版がスキーマや固定する OpenSpec を変えていれば、導入スクリプトは kit.json を衝突として止まり、doctor は `kit-version` で FAIL にします（新しい版のファイルを、書き換えられたものとして扱わないためです）。変えていなければ、doctor の WARN で知らせるだけです。

そのうえで、更新する前に使っていた版の節（「X から更新するとき」）と、それより上の節をすべて読んでください（上ほど新しい版です）。進行中の change で起きることと、手で決めることが書いてあります。

## 0.31.0 から更新するとき

0.32.0 で、AI の照合とレビューの修正の待ち時間を減らしました（[詳しく](WORKFLOW.md#並列での進め方)）。検出の手順（照合・箇所台帳・入口からの見直し・機能どうしの照合）と gate は変わらず、順番と、まとめ方だけが変わります。スキーマは変わりません。導入スクリプトをもう一度実行すれば版の記録が更新されます（先頭の説明）。

| 変わったこと | 進行中の change で起きること |
|---|---|
| 波の前後の手順（`gate.mjs guard --save`・`--compare`、git status の比較、`merge.mjs`）を `wave.mjs start`・`merge`・`check`・`accept`・`end` の1回ずつにまとめた。途中で終わった作業の部品は、その場でまとめられる | なし。新しい波から使う。`gate.mjs guard` もこれまでどおり動く。前の版で作った `openspec/spec-relay/work/guard/` の古いスナップショットは消してかまわない |
| バックグラウンドのサブエージェントが使えるホスト（Copilot CLI・Copilot app）では、波の全員を待たず、1つ終わるたびに次の作業を始める | なし |
| 照合で見つかった行と、レビューで頼まれた `fix:` を、1件ずつではなく change ごとに1つのファイル（`findings.mjs --change <change> --write`）にまとめ、1人の解析担当が一度に直し、照合し直しも一度にする | なし。レビュー中の change でも、次の修正からこの形になる |
| 機能どうしの照合（`consistency.mjs items`）を、入口からの見直しの後ではなく、照合と同じ波で始める | なし。修正で仕様が変わった組は、これまでどおり古くなり、照合し直す |
| 導入時に、Copilot の契約に合わせた同時実行数（Business なら 16）と、先に解析する数（8 以上なら 3）を勧める | **導入済みのリポジトリは変わりません。** 速くしたいときは、`openspec/config.yaml` の `Parallel subagents` を契約の上限に、`Analyses ahead of review` を 3 に、自分で書き換えてください（[SETUP.md](SETUP.md) の並列化の設定）。セッションの初めにファイル編集を許可しておくと、サブエージェントが許可待ちで止まりません |
| 有効にしたフックが、サブエージェントによる `wave.mjs start`・`merge`・`accept`・`end` の実行を拒否する | なし |

## 0.30.0 から更新するとき

0.31.0 で、機能（capability）どうしの仕様を突き合わせるようにしました（[詳しく](WORKFLOW.md#機能どうしの整合性0310-から)）。解析のスキーマの説明文と source-map.md のテンプレート（Dependencies が表に）が変わりました。導入スクリプトをもう一度実行すれば置き換わります（先頭の説明）。archive 済みの change はそのままです。

| 変わったこと | 進行中の change で起きること |
|---|---|
| 解析の `gate.mjs review` が、source-map.md の Dependencies と Database を確かめる。入口からの見直しで `other capability` とした機能が Dependencies にないと止まる。Dependencies の表の Entry point 列に書いた入口が、相手の archive 済みの source-map の入口になく、plan が相手に割り当てたファイルでもないとき、Database の表の Use が read・write・calls などと読めないときも止まる。修正（amend）も、source-map.md を持つときは同じ確かめで止まる。書き込むテーブルを、調査のコンテキストの地図（と plan の `## Shared data`）がそのコンテキストに許していないとき、2つのコンテキストが書き込むのに持ち主がないときも止まる | レビュー中・作成中の解析は、gate の指摘どおり解析担当に source-map.md を直してもらう。Dependencies は箇条書きのままでも機能の名前は読むが、入口は表の Entry point 列からしか読まないので、表に直すとよい。テーブルの持ち主は人に聞き、答えを plan の `## Shared data`（`\| Data \| Owner \| Also written by \|`）に書く |
| つながりのある機能の組（`uses`・`data <オブジェクト>`・`file <パス>`）ごとに、照合担当が両方の仕様を比べ、プロジェクトで1つの台帳 `openspec/spec-relay/consistency.md` に残す（`consistency.mjs items` が組と符号を出し、`merge.mjs --into openspec/spec-relay/consistency.md` がまとめる）。解析の gate は、その機能と、ベースライン（archive 済みの仕様）のあるほかの機能との組に、今の両方の仕様の符号を持つ行と、成り立つ判定（両側の要件の名前を引用符で書いた `consistent`、その解析の質問 `question <change> Q<n>`、plan の `## Consistency decisions` にある決定 `accepted D<n>`）を求める | レビュー中の解析は、gate が「no row in openspec/spec-relay/consistency.md」で止まる。オーケストレーターに機能どうしの照合を頼む（`consistency.mjs items --change extract-<capability>`）。つながる相手にまだベースラインがないとき、同じ機能の解析のやり直し（`-v<n>`）のときは何も求めない（archive 後の port-ready で照合する） |
| `gate.mjs port-ready` と `gate.mjs port-done` が、その機能の確定した仕様と、ほかの確定した仕様との組がすべて照合済みであることを求める。仕上げ（`finish.mjs ready` と finish の gate）は、確定した仕様どうしのすべての組を求める。`question` の判定は、その解析のレビュー中だけ通る | **0.30.0 以前に archive した仕様どうしは照合されていない**ので、次の port-ready がその組で止まる。進行中の port は port-done で止まる。オーケストレーターに `consistency.mjs items --capability <capability>` の組を照合してもらう。`conflict` は誤っている側を amend で直してから照合し直す。`duplicate`・`term`・`unclear` は人が決め、直すなら amend、残すなら plan の `## Consistency decisions`（`\| Id \| Pair \| Topic \| Decision \|`、Decision の末尾に台帳の行の `<!-- pair ... -->`）に `D<n>` として書き、判定を `accepted D<n>` にする。port 済みの機能は、仕上げの前にまとめて照合する（`consistency.mjs items --all`） |
| `openspec/spec-relay/consistency.md` は、サブエージェントが書けないファイルとして波の前後のガード（`gate.mjs guard`）と有効にしたフックで守る | なし |

## 0.29.0 から更新するとき

0.30.0 で、取りこぼしを減らすために、調査と解析に別の AI による確認を足しました。調査・解析のスキーマの説明文と修正の照合のテンプレートが変わり、調査のスキーマに `templates/crosscheck.md`、解析のスキーマに `templates/walkthrough.md` が増えました。導入スクリプトをもう一度実行すれば置き換わります（先頭の説明）。archive 済みの change はそのままで、何も求めません。archive 済みでまだ port していない機能の仕様も、この見直しなしで進めてかまいません。漏れが心配な機能だけ、解析をやり直す（`extract-<capability>-v2`）こともできます。

| 変わったこと | 進行中の change で起きること |
|---|---|
| 調査に `crosscheck.md`（調査の照合）が増えた。別の AI が inventory の行ごとにファイルを読み、コンテキスト・capability・扱い、除外と carry の妥当さ、入口の持ち主を確かめる。`gate.mjs review` は、inventory の行ごとに照合の行がないと止まり、判定は `confirmed` か `question` で、どちらも根拠があるものだけを通す。照合の行は inventory の行の符号 `<!-- row ... -->` があるものだけを数える（`draft.mjs items` の `codes` を照合担当が写し、`merge.mjs` が確かめ、なければ書く。あとで inventory の行が変わると、その行は照合し直すまで止まる）。`question` の行があると、review.md の `## 3. Coverage` に C2（一覧と根拠の符号つき）が要る | レビュー中の調査（archive 前）は、gate が「crosscheck.md is missing」で止まる。オーケストレーターに調査の照合を頼み（`draft.mjs items --change survey` の `paths` を照合担当に分ける）、`merge.mjs` でまとめ、`draft.mjs review --change survey --update` で C2 を足す。調査の archive 後なら何もしなくてよい |
| 解析に `walkthrough.md`（入口からの見直し）が増えた。別の AI が source-map.md の `## Entry points` の入口ごとに処理を最後まで追い、動作ごとにそれを書いたシナリオの名前を挙げる。`gate.mjs review` は、入口に行がない、source-map にない入口がある、名前を挙げたシナリオがその要件にない、根拠のファイルや行が実在しない、シナリオを挙げられていない要件がある、箇所台帳で `covered` の箇所の作用の行を `covered` のどの行も指していない（40行以内の範囲かメソッド名で）、`gap`・`vague` が残る、などで止まる。source-map.md に入口が1つもないときも止まる（定義だけの機能は `- None（理由）`） | レビュー中・作成中の解析は、gate が「walkthrough.md is missing」で止まる。source-map.md の Entry points を、1行に1つ `` `パス:シンボル` - 呼ばれ方 `` の形に直し（足りなければ解析担当が足す）、`draft.mjs items --change extract-<capability>` の `entryPoints` に全部出ることを確かめてから、見直しを1波で実行して `merge.mjs --into openspec/changes/extract-<capability>/walkthrough.md` でまとめる。見つかった `gap` は要件を末尾に足すか質問にし、変わった要件は照合し直す。チェック済みの項目の文が変わったら `draft.mjs review --update` がチェックを外すので、もう一度見てもらう |
| 解析と修正の照合（crosscheck.md）に `incomplete` が増えた。書いてあることは正しいが、trace の行にシナリオにない分岐・エラー・既定値・上限・書き込みがあるときの判定で、解決するまで gate を通らない（これまでも `confirmed` 以外は止まっていたので、gate の動きは同じ） | なし。次に照合するときから、照合担当がこの判定を使う |
| `draft.mjs items` が、解析では source-map の入口（`entryPoints`）も、調査では inventory の行（`paths`）も出す | なし |
| `merge.mjs` が walkthrough.md を入口ごとにまとめる（1回の merge で来た行が、その入口の行をすべて置き換える。同じ回の部品どうしは足し合わせるので、見直しは別の回でまとめる。消えた `gap`・`vague` の行は `dropped` に出る）。調査の crosscheck.md はパスでまとめ、行ごとに inventory の行の符号を書く | なし |
| レビュー画面の冒頭に、調査では照合の件数、解析では入口からの見直しの件数が出る。付録に、人に任された行・未解決の行・見直していない入口の一覧が出る | なし |
| walkthrough.md も、サブエージェントが書けないファイルとして波の前後のガード（`gate.mjs guard`）と有効にしたフックで守る | なし |

## 0.28.0 から更新するとき

0.29.0 で、画面のない機能（capability）の実装が、コンテキストで選んだ B2・C（画面のテストとスクリーンショットの比較）で止まらないようにしました。解析・移行先の設計・port のスキーマの説明文が変わりました。導入スクリプトをもう一度実行すれば置き換わります（先頭の説明）。archive 済みの change はそのままです。

| 変わったこと | 進行中の change で起きること |
|---|---|
| 解析の screens.md が `None` の機能は、レビュー済み（archive 済み）なら、その機能の port で B2・C を適用しない。verification.md でコンテキストに B2・C を選んでいても、`verify.mjs` は実行せず、`gate.mjs port-done` も求めない。完了時に「B2・C（画面の比較）は行っていません」と理由つきで知らせる。決めるのは、いちばん新しい archive 済みの解析の screens.md だけ（ファイルがないときは画面ありとみなす） | 0.28.0 で「機能専用のフォルダーに画面のテストがない」と止まっていた port は、そのまま進められる。`draft.mjs port-design --change port-<capability> --update` は表を書き換えないので、design.md の Verification に B2・C の行を書いていたら消し、Scenario checks の `e2e` を `unit` か `compare` にする。`tests/e2e/<capability>/` に画面のテストを作っていたら、そのテストも消す（どれかが残っていると、`verify.mjs` は実行せず、port-done も止まる。`e2e-old.json` は残っていてかまわない） |
| 画面のない機能の port で、design.md に B2・C の行がある、Scenario checks に `e2e` がある、`tests/e2e/<capability>/` に画面のテストがある、のどれかで止まる（`verify.mjs` も実行しない）。画面があるなら、解析をやり直して（`extract-<capability>-v2`）画面をレビューしてもらう。`e2e.mjs old` もその機能では実行しない | 上の行のとおり、消してから進める |
| 解析を archive できるのは、名前と同じスキーマの change だけ（`extract-*` は spec-relay-extract、`port-*` は spec-relay-port など。フックが有効なとき）。B2・C を外すかどうかを決める screens.md も、解析のスキーマで、レビュー（承認者の名前があり、すべての項目にチェック）を終えて archive されたものだけを信じる | なし（キットの手順どおりに作った change は、もともと満たしている） |
| archive 済みの port（仕上げで再実行するもの）で、画面のない機能に B2・C の行や画面のテストが残っていても止めず、その機能の B2・C は実行しない | なし |
| 仕上げ（finish）で、すべての機能に画面がないコンテキストは、checks.md の B2・C が `-` になり、結果を求めない（Notes に理由）。画面のある機能が1つでもあれば、これまでどおり | 作成済みの checks.md は書き換わらない。そのコンテキストの B2・C の欄が空なら `-` にする |
| 解析で screens.md が `None` のとき、review.md の「2. Screens」に `S0 This capability has no screens` の項目を置き、人が確かめる（`draft.mjs review` が作る）。これがないと `gate.mjs review` が止まる。screens.md に画面があるのに S0 があっても止まる | レビュー中の解析で screens.md が `None` なら、`draft.mjs review --change <change> --update` で S0 を足し、人に確かめてもらう。archive 済みの解析には求めない |
| レビュー画面の S0 に、何を確かめるか（利用者が見る画面が本当にないか、確定すると B2・C を行わないこと）が出る | なし |

## 0.27.0 から更新するとき

0.28.0 で、trace.md などの元コードの参照（`パス:シンボル:行`）の読み取りを直しました。スキーマは変わっていないので、導入スクリプトを実行し直す必要はありません（実行してもかまいません）。

| 変わったこと | 進行中の change で起きること |
|---|---|
| 拡張子のないファイル（`Makefile:12`、`bin/console:main`、`artisan:handle:3`）と、リポジトリの直下にあるドットファイル（`.gitignore:2`、`.env:1`）を参照として読む（`src/.gitignore` のようにフォルダーの下にあるものは、これまでも読めていた）。これまでは読めず、その参照しかない要件は gate.mjs review が「names no source location」で止まり、ほかの参照と並んでいると黙って抜けていた（レビュー画面に元コードが出ず、箇所台帳の突き合わせにも入らなかった） | 次に gate を通すと、抜けていた参照も確かめる。行がファイルにない、などはそのとき初めて止まることがある。直してから進める。archive 済みの change の仕様ビューにも、抜けていた元コードが出る |
| 拡張子のないファイルとリポジトリ直下のドットファイルは、リポジトリにそのファイルがあるときに参照とみなす（シンボルに空白があってもよい。`Dockerfile:RUN npm ci:3`。パスだけのときは gate が「シンボルか行を足す」と知らせる）。ファイルがないときは、よく使われる名前（Makefile・Dockerfile・Rakefile・Gemfile・Jenkinsfile など。大文字小文字は問わない）で後ろに `:シンボル` か `:行` があるときだけ参照とみなし、gate が「ファイルがない」と知らせる。それ以外の名前やドットファイルの打ち間違いは、これまでどおり「names no source location」になる | `src/a.cs:3; Makefile` のように、ファイル名だけの参照が並んでいた行は、次の gate でシンボルか行を求めて止まる |
| 次のものは参照ではない（これまでと同じ）: パスのないシンボル（`Billing::Total`、`InvoiceController:index`、`.ctor:10`）、メモ（`注: 税は別`、`TODO: あとで`）、フォルダー（`src:3`）、リポジトリにない名前だけ（`Makefile`）。セルの中の `,` は、次に拡張子のあるパスかよく使われる名前、またはリポジトリにあるファイルをフォルダー付きかドットファイルで書いたもの（`bin/console:10`、`.env:1`）が続くときだけ区切りとみなす。括弧の中の `,`（`total(a: number, b: number)`）とシンボルの並び（`Page_Load, btnSave_Click`、`install, build`、`.btn,.btn-primary`）は分けない | なし |
| Windows の区切り（`src\v1.2\Makefile:7`）と、名前にドットを含むフォルダー（`src/v1.2/`、`lib/jquery.ui/`）の下の拡張子のないファイルも同じように読む | なし |
| capabilities.md・plan.md の割り当ての項目と、source-map.md の Path の欄（後ろにメモがあるとき）で、バッククォートなしのドットファイル（`- .gitignore`、`.editorconfig (root)`）もパスとして読む（これまでは拡張子が9文字以上だと読めなかった）。拡張子のないファイルはこれまでどおりバッククォートで囲む（`` - `Makefile` ``） | 割り当てに書いてあったのに読まれていなかったファイルが、次の gate から割り当てに入る |

## 0.26.0 から更新するとき

0.27.0 で、人に答えてもらう所すべてに AI の推奨と理由を付け、レビューの終わりをチャットに知らせられるようにしました。解析のスキーマの説明文と questions.md のひな形が変わり、移行先の設計のスキーマに `templates/proposals.md` が増えました。導入スクリプトをもう一度実行すれば置き換わります（先頭の説明）。archive 済みの change はそのままです。

| 変わったこと | 進行中の change で起きること |
|---|---|
| questions.md の質問ごとに、下に `  - Recommended: <推奨の答え>` と `  - Why: <理由>` を書く。コードから決められないときは `Recommended: none` と、何で決まるかを Why に書く。`gate.mjs review` は、どちらかがない質問で止まる（AI の番。`next.agent` に出る） | 進行中の解析で、まだ判断していない質問に推奨がないと gate が止まる。AI が書き足せば通る。すでに判断を書いて確認済みにした質問には求めない（後から推奨を足して「推奨どおり」に見せないため）。質問の1行目は変えないので、review.md のチェックと判断はそのまま残る |
| レビュー画面の質問に「AI の推奨」と理由が出る。HTML ビューでは「推奨どおりにする」で、推奨をそのまま判断にして確認済みにできる | なし（推奨を書き足すと出る） |
| レビュー画面の最後に「レビューの完了」が出る。HTML ビューでは、終わったら「レビュー完了をチャットに知らせる」で AI に伝わる。ブラウザーで開いた HTML では、チャットに送る1行とコピーのボタン。どちらもアーカイブの承認にはならず、AI が gate を通してから、アーカイブしてよいかを聞く | なし |
| 移行先の設計では、解析担当が調査の結果から7つの問いそれぞれに推奨と理由を `openspec/spec-relay/work/target-design/proposals.md` に書き、オーケストレーターが推奨を先頭にした選択肢で1問ずつ聞く | 進行中の移行先の設計で、まだ聞いていない問いがあれば、そこから推奨つきで聞く |
| オーケストレーターがチャットで聞く質問（導入、レビュー、アーカイブの前、止まったとき）にも、推奨と理由を付ける | なし |

## 0.25.0 から更新するとき

0.26.0 で、オーケストレーターが自分で読んでいた作業をサブエージェントに任せるようにしました（移行先の architecture.md、仕上げの handover.md、レビューでの `fix:` の直しのうち数語より大きいもの、読むファイルが多いコードの質問）。変わったのはスキル・エージェントの定義・スクリプトで、スキーマは変わっていません。プラグインを更新すれば足ります。

| 変わったこと | 進行中の change で起きること |
|---|---|
| 仕上げの handover.md は解析担当が書く。レビューで分類が変わったり `finish.mjs run` をやり直したりしたら、解析担当が書き直し、H1 と H2 のチェックが外れる | なし |
| 仕上げの checks.md と leftovers.md も、波の前後のガード（`gate.mjs guard`）と、有効にしたフックで守る（サブエージェントは書けない） | 波の途中の仕上げで、サブエージェントがこの2つを書いていたら `guard --compare` が止まる |

## 0.24.0 から更新するとき

0.25.0 で、ほかのファイルから決まる部分をスクリプトが書くようにしました（モデルが書き写さないため）。6つのスキーマ（調査・移行先の設計・解析・修正・port・仕上げ）の説明文が変わりました。導入スクリプトをもう一度実行すれば置き換わります（先頭の説明）。archive 済みの change はそのままです。

| 変わったこと | 進行中の change で起きること |
|---|---|
| review.md は `draft.mjs review --change <change>` が成果物から作る。直しで要件・画面・質問などが増えたり名前が変わったりしたら `--update` で作り直す（人のチェック・判断・fix や hold のメモは残り、文言が変わった項目はチェックが外れる） | なし。すでにある review.md は `--update` を付けたときだけ書き換わる |
| 照合担当に渡す番号付きの名前（`R1 <名前>`、`S1 <名前>`）は `draft.mjs items --change <change>` が出す | なし |
| port の design.md の画面・シナリオ・元コードの表は `draft.mjs port-design --change port-<capability>` が書く。修正（amend）の後は `--update` で足りない行を足す | なし。書いてある表は変えず、ひな形のままの節だけを埋める |
| 仕上げの全体のチェックは `finish.mjs run --change finish` が実行し、checks.md に pass・fail と移行先のハッシュを書く | なし。進行中の仕上げでも、次に実行すると結果の欄が書き換わる（Notes に足したメモは残る） |
| 手書きの review.md に初めて `--update` を使うと、項目の文言が成果物どおりに揃う。文言が変わった項目はチェックが外れ、質問は判断も外れる（元の行は報告の `changed` の `was` に残るので、AI が人に伝える）。どの項目のメモでもない文章は末尾の `## Other notes` に移る | 進行中のレビューで `--update` を使ったときだけ |
| review.md の項目の番号の後ろの記号は、番号の直後（`R1.名前`）か、空白の後で後ろにも空白があるとき（`R1 - 名前`）だけ区切りとみなす（`R1 .NET の丸め` や `R2 -1 は拒否` の名前が照合できるように） | なし。`R1 .NET の丸め` のような名前が通るようになるだけ |

## 0.23.0 から更新するとき

0.24.0 で、導入スクリプトが前の版のスキーマと `openspec/spec-relay/tools/` のファイルを自動で置き換えるようになりました（上の説明）。スキーマと固定する OpenSpec の版は変わっていませんが、導入スクリプトを一度実行してください。キットの版が `openspec/spec-relay/kit.json` に記録されるので、コミットします。

- 0.6.0 以前に導入したリポジトリでは、`openspec update` のあとに `.github/` に残る 0.6.0 の案内のファイル（キットが書いた中身のままのもの）も、導入スクリプトが消します（「0.6.0 から更新するとき」の 3）。
- 進行中の change で起きることはありません。

## 0.22.0 から更新するとき

0.23.0 で、レビュー画面を使いやすくしました。5つのスキーマ（調査・移行先の設計・解析・修正・仕上げ）の apply の説明文が変わったので、`openspec/schemas/spec-relay-*` を削除してから導入スクリプトをもう一度実行してください（`node "<キットのフォルダー>/scripts/setup.mjs" --target . --apply`）。archive 済みの change はそのままです。

| 変わったこと | 進行中の change で起きること |
|---|---|
| 項目が違うときは、review.md のその行の下に `  - fix: 直してほしいこと`、決められないときは `  - hold: 理由` を書く。AI は直したら `  - fixed: 直した内容` を足す（HTML ビューでは「修正を依頼」「保留にする」「依頼を取り下げる」「保留を解除」のボタン） | `fix:` の後に `fixed:` がない項目があると `gate.mjs review` が止まる（AI がまだ直していないため） |
| 画面の各項目に「確認すること・照らすもの・違うとき」が出る。調査では、関係の図、データ × コンテキストの表、capability・carry・excluded の一覧が各項目の中に出る | なし。画面を作り直すと出ます |
| 確認済みの項目と付録は折りたたまれる。inventory は付録でコンテキストごとの数になる | なし |
| canvas で確認ボタンを押しても、画面の位置が先頭に戻らない。canvas は「HTML ビュー」と呼ぶ | なし |
| 画面の数字と「次へ」は「あなたの番」（未確認か再確認待ち）だけを数える。HTML ビューの下に、読んでいる項目のボタンを並べた操作バーと「元に戻す」が出る。「これを聞く」は「質問する」になった | なし |
| 調査・移行先の設計・仕上げのキットの項目名（M1 など）は、日本語の画面では日本語で出る（review.md は英語のまま） | なし |
| 移行先の設計・仕上げ・修正の項目（A0、V1、E90、C1、H1、I1 など）に、その項目が確かめる文書の節や、そのコンテキストの表の行が出る（付録まで行かなくてよい）。画面の見出しや表の見出しのうち、キットの英語のもの（screens.md や database.md）は日本語の画面で日本語になる | なし |

## 0.21.0 から更新するとき

0.22.0 で、固定する OpenSpec を 2.0.0 から **2.1.1** に上げました。Node.js は **22.20 以上**が必要です（OpenSpec 2.1 の要件。doctor が FAIL にします）。移行中のリポジトリでは次の2つを行います。スキーマは変わっていません。

1. `openspec/spec-relay/tools/` の package.json と package-lock.json を消してから、導入スクリプトをもう一度実行します（`node "<キットのフォルダー>/scripts/setup.mjs" --target . --apply`）。OpenSpec 2.1.1 が入り、openspec/config.yaml の `schema:` の次の行に `skillsScope: project` が足されます。
2. 変わった3つのファイル（package.json、package-lock.json、openspec/config.yaml）をコミットします。ほかの人は pull したあと、同じく導入スクリプトを実行します。

`skillsScope: project` が要るのは、OpenSpec 2.1 から `openspec init` の既定が、スキルをホームフォルダー（`~/.agents/skills`、すべてのプロジェクト用）に入れることに変わったためです。この行がないと、端末で実行した `openspec update` が「スキルをホームフォルダーに移すか」を尋ね、移すとキットが無効にした apply・archive・sync が元に戻ります。この行がないうちは doctor が `skills-scope` で FAIL にします。

ほかのプロジェクトで OpenSpec 2.1 を使うと、ホームフォルダーに OpenSpec 標準のスキルが入ることがあります。Copilot はそれをどのリポジトリでも読み、同じ名前のスキルのどちらを使うかは公開されていません。doctor が見つけたときは `personal-skills` で知らせるので、ほかで使っていなければそのフォルダーを消し、使っているならフック（`Hook enforcement: on`、[TROUBLESHOOTING.md](TROUBLESHOOTING.md#フック試験中既定は無効)）を有効にしてください。

キットが起動する OpenSpec は、既定で利用統計を送らなくなりました（環境変数 `OPENSPEC_TELEMETRY=0` を渡します。自分で `OPENSPEC_TELEMETRY` を設定している場合はその値が優先です）。README の詳細は docs へ移しました（[README](../README.md#ドキュメント) の一覧）。

## 0.20.0 から更新するとき

0.21.0 で、**すべてのシナリオに自動の確認**を付けるようになり、比べ方 B2（画面）と C（web の画面の見た目）をキットの `e2e.mjs` が Playwright で行うようになりました（[詳しく](E2E.md)）。移行先の設計・port・仕上げのスキーマの説明文が変わったので、`openspec/schemas/spec-relay-*` を削除してから導入スクリプトをもう一度実行してください（`node "<キットのフォルダー>/scripts/setup.mjs" --target . --apply`）。archive 済みの change はそのままです。

| 変わったこと | 進行中の change で起きること |
|---|---|
| port の design.md に `## Scenario checks`（要件・シナリオ・確認方法 `e2e`・`compare`・`unit`）が加わった | B1 か B2 のコマンドがある port は、表がないと `gate.mjs port-done` が止まる。すべてのシナリオの行を足す。A だけの port は変わらない |
| `compare` にしたシナリオは、記録したケースに `"scenario"` キーで印が要る | 印がないと止まる。入力の一覧に `"scenario"` を足して記録し直す（`http.mjs record` はそのまま写す） |
| B2 は「操作を記録して再生する」から「シナリオごとの Playwright のテストを、元のシステムで通してから新しいシステムに流す」に変わった | B2 を選んだコンテキストの port は、design.md の B2 のコマンドを `spec-relay-e2e --base <新しいシステム> --start '<起動コマンド>'` にし、`e2e.mjs init` で `tests/e2e/` を作り、verification.md に書いた元のシステムのアドレスで `e2e.mjs old` を実行して通し（オーケストレーターが行う）、元のシステムを止めてから verify する。以前の B2 のテストは `tests/e2e/<capability>/` の `*.e2e.mjs` に移し、題名をシナリオの印にし、パスの読み替えは `tests/e2e/<capability>/paths.json` に置く |
| verification.md の列名が「B2 screen tests」になった | なし（列は `B2` で始まれば読みます） |

Playwright（`@playwright/test`、Apache-2.0）はキットに同梱していません。`tests/e2e/` で `npm ci` を実行すると、版を固定した 1.64.1 が入ります。Windows 11 では入っている Edge を使うので、ブラウザのダウンロードは要りません。

## 0.19.0 から更新するとき

0.20.0 で、点検で見つかった3つの穴をふさぎました。調査・移行先の設計・解析・port のスキーマの説明文が変わったので、`openspec/schemas/spec-relay-*` を削除してから導入スクリプトをもう一度実行してください（`node "<キットのフォルダー>/scripts/setup.mjs" --target . --apply`）。archive 済みの change はそのままです。影響があるのは進行中の change だけです。

| 変わったこと | 進行中の change で起きること |
|---|---|
| 調査の review.md は M1〜M5 と C1 の項目が必須。除外したファイルは inventory.md の Notes に理由が必須 | 項目を消していたり、理由が空だったりすると `gate.mjs review` が止まる。項目を戻し、理由を書く |
| 移行先の設計の review.md は A0・A90・A91・V1〜V4・E90・U90 の項目が必須 | 項目を消していると止まる。テンプレートの項目を戻す |
| trace の行番号は、そのファイルにある行でなければならない | ファイルより先の行を書いていると止まる |
| 箇所台帳の `covered` は、その箇所の効果のある行（DB への書き込み・エラー・リダイレクト・メールなど）すべてに、名前を挙げた要件の trace が届いている必要がある | 届いていない行を gate が挙げる。その行を定めている要件の名前を足すか、要件がなければ `gap` として解析担当に戻す。効果のない行（ページの文章など）に目印が付いただけなら、判定に `; no effect <行>` を足す（[詳しく](WORKFLOW.md#箇所台帳ファイルの中の抜けの検出)） |
| 目印のある箇所を「動作なし」としたとき、または行を `no effect` で外したときは、review.md の `## 4. Coverage` に C1 が必要 | gate が示す文（一覧を表す符号つき）でオーケストレーターが項目を足し、人が一覧を見てチェックする。以前の版の「4. Coverage」の C1 が残っている場合も、この文に書き直す |
| 比べ方 B1 を HTTP 越しに使える（`scripts/http.mjs`） | なし。ロジックを直接呼べない PHP のページや WebForms でも、元のシステムを手元で動かせれば B1 を選べる（[詳しく](COMPARE.md#直接呼べないロジックhttp-越しの記録)）。A だけにしていたコンテキストを B1 にするときは、移行先の設計をやり直す（`target-design-v2`） |

## 0.18.0 から更新するとき

0.19.0 で、任意の**コードガイド**を作れるようになりました。移行先のコードを、機能・画面と URL・ファイルの3つの入口から辿れる案内で、モジュールと依存の図、データの持ち主の図、ファイルごとの説明、canvas で聞いて役立った Q&A が入ります。チャットで「コードガイドを作って」と頼んでください（[詳しく](GUIDE.md)）。新しいエージェント `spec-relay-guide-writer` が増えます。プラグインを更新すれば入ります。スキーマや今までの成果物に変更はありません。

## 0.17.0 から更新するとき

0.18.0 で、canvas のレビュー画面から review.md に書き込めるようになりました（確認済みにする・判断を書く・レビュー担当の名前）。自分でファイルを直したのと同じ扱いで、変更の完了（アーカイブ）は今までどおりチャットで伝えます（[詳しく](CANVAS.md)）。書き込みは `openspec/spec-relay/local/canvas-log.jsonl` に記録され、`gate.mjs guard --compare` はそれをサブエージェントの変更と区別します。プラグインを更新すれば入ります。スキーマや成果物に変更はありません。

## 0.16.0 から更新するとき

0.17.0 で、Copilot の canvas（試験中）に進み具合・レビュー画面・仕様を出せるようになりました。各項目の「これを聞く」で、質問をそのままチャットに送れます（[詳しく](CANVAS.md)）。プラグインを更新すれば入ります。スキーマや成果物に変更はありません。

## 0.15.0 から更新するとき

0.16.0 で、承認済みの仕様を HTML で読めるようになりました。`node "<kit>/scripts/render.mjs" --spec all` で `openspec/spec-relay/views/specs.html`（仕様の一覧）と capability ごとのページができます。要件ごとにシナリオと元コードの該当行が並び、修正中の amend があればその要件に注意書きが出ます。スキーマや成果物に変更はないので、導入のやり直しは要りません。

## 0.14.0 から更新するとき

0.15.0 で、比べ方 B1 の道具が加わりました。元のプログラムから記録したケース（入力と結果）と新しいコードの結果を、`compare.mjs` が1件ずつ比べます（[詳しく](COMPARE.md)）。移行先の設計と port のスキーマの説明文が変わったので、`openspec/schemas/spec-relay-port/` と `openspec/schemas/spec-relay-target/` を削除してから導入スクリプトをもう一度実行してください。

- archive 済みの移行先の設計はそのまま使えます。B1 を選んでいたコンテキストの port では、design.md の B1 のコマンドを `spec-relay-compare --cases tests/golden/<capability> --driver "<実行係のコマンド>"` にできます。今までどおり、自分で書いた比較のコマンドでもかまいません。
- A だけにしていたコンテキストでも、本番の記録（バッチの入出力など）があれば B1 にできます。そのときは移行先の設計をやり直します（`target-design-v2`）。

## 0.13.0 から更新するとき

0.13.0 より前の版から上げるときは、その版より後の節もすべて読んでください。スキーマの削除と導入スクリプトの再実行は1回で済みます。

0.14.0 で、実装の完了の確かめ方が強くなりました（`verify.mjs` によるテストの実行記録、シナリオごとのテストの印、`TODO(port)`、照合担当による実装の照合）。port と移行先の設計のスキーマが変わったので、`openspec/schemas/spec-relay-port/` と `openspec/schemas/spec-relay-target/` を削除してから導入スクリプトをもう一度実行してください（`node "<キットのフォルダー>/scripts/setup.mjs" --target . --apply`）。

- archive 済みの移行先の設計はそのままです。conventions.md の Test と Boundary check のコマンドは、0.14.0 から移行先のフォルダーで実行します。リポジトリの一番上で動く書き方になっていたら、port の design.md の Verification 表で、A と `Boundary check` の行にコマンドを書けば、そちらを使います。
- archive 済みの verification.md の比べ方の欄は `yes` か `no` で読みます（`はい`・`✓`・`なし`・`-` なども可）。それ以外の言葉があると port-done が止まるので、移行先の設計をやり直す（`target-design-v2`）か、オーケストレーターに相談してください。
- archive 済みの conventions.md の Test や Boundary check が `npm run build; npm test` のように複数のコマンドをつないでいると、前の失敗が隠れるので port-done が止まります。port の design.md の Verification 表に1つのコマンド（スクリプトやビルドツールのタスク）を書けば、そちらを使います。
- 進行中の port は、タスクがすべて完了していても `gate.mjs port-done` を通らなくなります。オーケストレーターがテストに印を付け、`verify.mjs` と照合を行ってから、改めて archive してよいかを聞きます。

## 0.11.0 から更新するとき

0.12.0 で、解析に「抜けの確認」（箇所台帳 `coverage.md`）が加わりました（[詳しく](WORKFLOW.md#箇所台帳ファイルの中の抜けの検出)）。スキーマが変わったので、`openspec/schemas/spec-relay-*` を削除してから、導入スクリプトをもう一度実行してください。進行中の extract の change では、`coverage.md` がないと `gate.mjs review` が止まります。オーケストレーターに「抜けの確認をして」と頼むと、`sites.mjs` と照合担当で作ります。

## 0.10.0 から更新するとき

0.11.0 で、全部の実装のあとに「6. 仕上げ」の工程（スキーマ `spec-relay-finish`、`scripts/finish.mjs`）が加わり、port のスキーマの説明文が変わりました。導入スクリプトをもう一度実行するとスキーマの違いを表示して止まるので、`openspec/schemas/spec-relay-*` を削除してから実行し直してください。

- 後回しにした作業は、計画（`openspec/spec-relay/plan.md`）の `## Follow-up` の下に1件ずつ書きます。仕上げの工程がここから集めます。別の見出しに書いていた場合は移してください。
- 進捗の表示は、全部の実装が終わっても「次は仕上げ」となり、仕上げの change を archive して初めて「移行完了」になります。

## 0.9.0 から更新するとき

0.10.0 で、データベースの扱いが加わりました。調査に `database.md`、移行先の設計に `data.md`（review.md の `## 5. Data`）が増え、解析と実装のスキーマの説明文も変わっています。

1. `openspec/schemas/spec-relay-*` を削除してから、導入スクリプトをもう一度実行します（スキーマが新しい版と違うと表示して止まるためです）。
2. 調査がまだ archive されていなければ、オーケストレーターに `database.md` を書いてもらい、レビューに D の項目を足します。データベースを使っていなければ、`## Databases` の下に None と書くだけです。
3. 0.9.0 以前に archive した調査には `database.md` がないので、gate はデータベースの確認をしません。ストアドやトリガーにロジックがあるシステムなら、調査をやり直して（`survey-v2`）定義を取り込むことを勧めます。archive 済みの調査のあとで `openspec/spec-relay/db/` に定義を置くと、調査に記録した定義と違うため gate が止まるので、置くのは調査のやり直しの中で行います。移行先の設計をまだ archive していなければ、そのあとで `data.md` を足します。
4. 進行中の target-design には `data.md` を足します（ないと gate と進捗の表示が先へ進みません）。調査がデータベースを使わないと記録しているか、0.9.0 以前の調査なら、None と書くだけです。
5. `openspec/spec-relay/db/` の定義は元ファイルと同じく、計画（plan.md）のどれかの capability の下に書きます（`` - `openspec/spec-relay/db/sales/` ``）。`gate.mjs coverage` が確かめます。定義を置くのは 2 か 3 の調査の中だけです（調査の archive のあとに置くと gate が止まります）。

## 0.8.0 から更新するとき

0.9.0 で、仕様の抜けをファイル単位で gate が確かめるようになりました（[詳しく](WORKFLOW.md#ファイル単位の網羅抜けの検出)）。スキーマが変わったので、`openspec/schemas/spec-relay-*` を削除してから、導入スクリプトをもう一度実行してください（`node "<キットのフォルダー>/scripts/setup.mjs" --target . --apply`）。進行中の移行では次のものが要ります。

- `openspec/spec-relay/plan.md` の各 capability の下に、元ファイル・フォルダーを字下げした項目で書きます（`` - `src/billing/` ``）。調査の capabilities.md に書いてあれば、そこから写します。オーケストレーターに「plan に元ファイルを足して」と頼むと書き、`gate.mjs coverage` で確かめます。plan に1つも書いていない間は、調査の capabilities.md の割り当てを使います。
- 進行中の extract と amend の change では、source-map.md の表に割り当てのファイルがすべてあり、trace.md にすべての要件の行がないと `gate.mjs review` が止まります。止まったら、オーケストレーターが解析担当に直させます。
- extract の review.md の「4. Coverage」（C1、C2）は不要になりました。残っていても、チェックすれば gate は通ります。

## 0.7.0 から更新するとき

0.8.0 で、画面の見た目を引き継ぐ決まりが加わりました。調査の一覧に扱いの列（`port` か `carry`）、移行先の設計に `ui.md`、screens.md に見た目の出どころと詳細、port の design.md に画面ごとの方針と carry のファイルの欄があります。

1. スキーマが変わったので、導入スクリプトは「キットの版と違う」と表示して止まります。`openspec/schemas/spec-relay-*` を削除してから、導入スクリプトをもう一度実行してください。
2. archive 済みの調査はそのまま使えます。扱いの列がない一覧は、すべて `port` として読みます。CSS などを `carry` にしたいときは、調査をやり直します（`survey-v2`）。進行中の調査は、inventory.md に扱いの列（`| Path | Context | Handling | Notes |`）を足さないと gate を通りません。分担して書いている途中の部分ファイルも同じ列にそろえてください。
3. 進行中の target-design は、`ui.md` と review.md の `## 4. Screens`（コンテキストごとの `U<n>` と `U90`）を書き足さないと gate を通りません。archive 済みのときは、前の版の architecture.md・conventions.md・verification.md をそのまま写し、`ui.md` を足した `target-design-v2` を作ってレビューすると、以後の port が方針に従います。
4. 進行中の extract の screens.md には、見た目の出どころと詳細を書き足すと、実装で見た目を再現しやすくなります（gate はこの欄を見ないので、なくても通ります）。archive 済みの target-design に `ui.md` がないまま port を始めると、オーケストレーターは画面ごとの方針を人に聞いて design.md に記録します。

## 0.6.0 から更新するとき

0.7.0 は OpenSpec 2.0.0 が前提で、その版を移行対象のリポジトリの中に固定します。2.0.0 はスキルを `.github/skills/` ではなく `.agents/skills/` に置くので、0.6.0 のままでは標準の apply・archive・sync を無効にできませんでした。0.7.0 は `.agents/skills/` だけを見ます。グローバルに入れた `openspec` は使わなくなるので、残しても消してもかまいません。

進行中の移行では、次の順に実行します。

1. 導入スクリプトをもう一度実行します（`node "<キットのフォルダー>/scripts/setup.mjs" --target . --apply`）。`openspec/spec-relay/tools/` にキットが固定する OpenSpec が入り、`.github/` に残ったファイルを `leftover` として表示して止まります（まだ完了ではありません）。
2. 移行対象のリポジトリで `node "<キットのフォルダー>/scripts/openspec.mjs" update` を実行します。OpenSpec が置いた古いファイルは消え、`.agents/skills/` に新しいスキルが入ります。
3. 導入スクリプトをもう一度実行します。0.6.0 が無効にしたファイル（`.github/skills/openspec-*` と `.github/prompts/opsx-*` のうち、キットの案内の中身のままのもの）は update のあとも残ることがあります（OpenSpec 2.1.1 では `.github/prompts/opsx-*` が残ります）。0.24.0 からは導入スクリプトがそれを消し、`.agents/skills/` の OpenSpec 標準のスキルを無効にします。update の前に自分で消さないでください（OpenSpec がそのワークフローを使わないものと読み、ホームフォルダーの OpenSpec 全体の設定から外すので、ほかのプロジェクトにも響きます）。
4. 案内の中身に書き足したファイルや、OpenSpec が編集済みとして残したファイルは、`leftover` と表示されて導入スクリプトが完了しません（doctor は `legacy` で FAIL を出します。元フォルダーが `.` のときは、調査の gate も元コードとして数えます）。要るものを移してから手で消し、導入スクリプトをもう一度実行してください。最後に doctor で FAIL がないことを確かめ、`openspec/spec-relay/tools/` の3つのファイル、`.agents/skills/`、`.github/` で消えたファイルをコミットします。

## 0.5.0 から更新するとき

- 0.6.0 で、レビューの学びを `openspec/spec-relay/lessons.md` に残すようになりました。最初の学びが出たときにオーケストレーターが作るので、用意は要りません。進行中の移行では、これまでのレビューで繰り返し直したことがあれば、オーケストレーターに伝えると最初の行として書きます。
- スキーマと設定は変わっていないので、導入スクリプトのやり直しは不要です。

## 0.4.0 から更新するとき

- extract と amend の承認（`gate.mjs review`）に、調査の archive、調査の一覧（または計画の `## Capabilities`）にある capability、その capability の change 名が必要になりました。進行中の change が通らなくなったら、表示に従って計画に capability を足すか、change の名前を合わせます。
- フックを使うときは、`openspec/config.yaml` に[フック](TROUBLESHOOTING.md#フック試験中既定は無効)の1行を足します（なければ無効）。スキーマは変わっていないので、導入スクリプトのやり直しは不要です。

## 0.3.0 から更新するとき

0.4.0 で環境チェック（`scripts/doctor.mjs`）が加わりました。スキーマと設定は変わっていないので、導入し直す必要はありません。次のセッションの最初に、オーケストレーターが環境を確かめ、サブエージェントの試運転を1回行います。

## 0.2.0 から更新するとき

0.3.0 で、サブエージェントを並列に動かす手順に変わり、survey・extract・amend のスキーマの説明文が変わりました。導入スクリプトをもう一度実行するとスキーマの違いを表示して止まるので、`openspec/schemas/spec-relay-*` を削除してから実行し直してください。`openspec/config.yaml` はそのまま残るので、次の2か所を手で直します。

- context に並列化の5行を足す（ない場合は既定の 4・2・`session` で動きます）。

  ```yaml
    Parallel subagents (at once, whole session): 16
    Analyses ahead of review: 2
    Analyst model: session
    Checker model: session
    Implementer model: session
  ```

- rules の `raise doubts in questions.md.` を `raise doubts as questions for questions.md.` に変える（questions.md はオーケストレーターだけが書くため）。

## 0.1.0 から更新するとき

0.2.0 で、解析の前に「調査」と「移行先の設計」の工程が加わりました。導入スクリプトをもう一度実行すると、スキーマが新しい版と違うと表示して止まるので、`openspec/schemas/spec-relay-*` を削除してから実行し直してください。進行中の extract change は、新しく加わった screens.md と crosscheck.md を書き足したうえで、調査を archive すると gate を通ります（0.5.0 から、extract の承認には調査が必要です）。先にオーケストレーターに調査を頼み、その一覧に進行中の capability を入れてください。確定済みの仕様（ベースライン）はそのまま残り、`gate.mjs port-ready` はこの2つが終わるまで実装の開始を止めます。
