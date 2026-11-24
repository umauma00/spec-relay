// What a reviewer checks on each review item, against what, and what to do when
// it is wrong. Written here, in the kit, so every model and every host shows the
// reviewer the same guidance (the same reason render.mjs holds the design).
//
// Keys are a review item's id (M1, C1, D90: one fixed item) or its letter (K, R:
// every item of that letter). An id wins over its letter. Each entry has
// `check` (what to look at, in order), `against` (what to compare it with) and,
// when it says more than the common advice, `wrong` (what to write when it is wrong).

const GUIDE = {
  ja: {
    'spec-relay-survey': {
      K: {
        check: ['責務の一文が、このアプリの業務のひとまとまりとして自然か（ほかのコンテキストと重なっていないか）', '所有データを主に書き込むのが、本当にこのコンテキストか', '入口のファイルが、この責務の画面や処理か'],
        against: 'この項目の「つながり」「データ」「ファイル」と、根拠に書かれたファイル。業務を知っている人の感覚',
        wrong: '統合する・分ける・名前を変える・ファイルを別のコンテキストへ移す、など、どう変えたいかを書く',
      },
      M1: { check: ['矢印の向き（上流 → 下流）が、呼び出しやデータの流れと合っているか', '抜けているつながり、ないはずのつながりがないか'], against: '下の図と表、各コンテキストの入口' },
      M2: { check: ['どのデータも所有者が1つで、それが正しいか', '「書く」が並ぶデータは、境界の引き方を見直す候補'], against: '下のデータとコンテキストの表' },
      M3: { check: ['同じ言葉が別の意味で使われている箇所、1つのものに2つの名前がある箇所を理解したか', '新しいシステムで、どちらの意味・名前に寄せるか'], against: '下の用語の衝突（用語集の全体は付録）' },
      M4: { check: ['capability の分け方が、仕様を書いてレビューする単位としてちょうどよいか', '移行する順番（共通基盤が先）が妥当か'], against: '下の capability の一覧' },
      M5: { check: ['carry（変えずに新しいシステムへ持っていく）にしたファイルを、そのまま使ってよいか（画像・CSS・フォント・帳票テンプレートなど）'], against: '下の carry のファイル一覧' },
      C1: { check: ['excluded（移行しない）にしたファイルを、本当に捨ててよいか（生成物、外部ライブラリ、使われていないコードなど）', '理由がそれぞれに書かれているか'], against: '下の excluded のファイルと理由' },
      D: { check: ['データベースの製品・版と、定義ファイルの場所が正しいか', 'データベースの中のロジック（ビュー、ストアド、トリガーなど）の数が実態と合うか'], against: '下の表（database.md）' },
      D90: { check: ['読めなかった定義と、その理由を理解したか（扱いは移行先の設計で決める）'], against: '下の「読めなかった定義」' },
    },
    'spec-relay-extract': {
      R: {
        check: ['要件の文とシナリオが、右の元コードの動きと同じか（条件、計算、エラーのとき）', '照合（AI の再確認）が confirmed でなければ、その理由'],
        against: '右の元コードの行、既存のテスト、照合の結果',
        wrong: '違う動きや抜けている条件を書く。元コードのほうがバグだと思うときも、そう書く',
      },
      S: { check: ['画面の項目・操作・メッセージ・遷移が、実際の画面と同じか', 'スクリーンショットがあれば見比べる'], against: 'スクリーンショットと screens.md の記述' },
      Q: { check: ['新しいシステムでどうするかを決めて、判断に書く'], against: '質問の本文と元コード', wrong: '質問そのものがおかしいときに書く。決められないときは「保留」にして、誰に聞くかを書く' },
      C: { check: ['目印（DB への書き込み、例外など）があるのに「動作なし」とした箇所が、本当に仕様に要らないか'], against: '抜けの確認（箇所台帳）' },
    },
    'spec-relay-amend': {
      R: { check: ['旧と新の違いが、元コードの動きの読み違いを直すものになっているか', 'ほかのシナリオを壊していないか'], against: '旧・新の文と元コードの行' },
      I1: { check: ['影響を受ける実装（port）と、その直し方が正しいか'], against: '付録の impact.md' },
    },
    'spec-relay-target': {
      A: { check: ['モジュールの分け方と依存の向きが、調査のコンテキストの地図と合っているか'], against: '付録の architecture.md' },
      V: { check: ['移行先の言語・フレームワーク・書き方・コマンドが、チームで使い続けられるものか'], against: '付録の conventions.md' },
      E: { check: ['各コンテキストの確かめ方（A〜C）が、そのリスクに見合っているか'], against: '付録の verification.md' },
      U: { check: ['画面の見た目の方針（same / layout / new）と、持っていくファイルが正しいか'], against: '付録の ui.md' },
      D: { check: ['データベースの扱い（keep / move）と例外、データアクセスの対応が正しいか'], against: '付録の data.md' },
    },
    'spec-relay-finish': {
      C1: { check: ['全体の確認がすべて通っているか'], against: '付録の checks.md' },
      L: { check: ['残りものの分類（切替の前に直す／切替の後の課題／直さない）が妥当か'], against: '付録の leftovers.md', wrong: '分類を変えたいときは、変えたい分類と理由を書く' },
      H: { check: ['引き渡しの判定と、切替の前にすることが正しいか'], against: '付録の handover.md' },
    },
    common: '「直してほしい」に、何がどう違うかを書く（AI が直して、直した内容を項目の下に書きます）。今は決められなければ「保留」に理由を書く',
    words: { check: '確認すること', against: '照らすもの', wrong: '違うとき', how: '確認のしかた' },
  },
  en: {
    'spec-relay-survey': {
      K: {
        check: ['Does the one-line responsibility read as one part of the business, without overlapping another context?', 'Is this context really the one that writes its owned data?', 'Are the entry points screens and jobs of this responsibility?'],
        against: 'The connections, data and files of this item, the files named in its evidence, and what people who know the business say',
        wrong: 'Say how it should change: merge, split, rename, or move files to another context',
      },
      M1: { check: ['Do the arrows (upstream → downstream) follow the calls and the data?', 'Is a connection missing, or one there that should not be?'], against: 'The diagram and table below, and each context\'s entry points' },
      M2: { check: ['Does every piece of data have one owner, and the right one?', 'Data that several contexts write is a reason to look at the boundaries again'], against: 'The data and contexts table below' },
      M3: { check: ['Do you understand where one word means two things, or one thing has two names?', 'Which meaning or name should the new system use?'], against: 'The glossary conflicts below (the whole glossary is in the appendix)' },
      M4: { check: ['Is each capability a good unit to specify and review?', 'Is the order of the migration right (the platform first)?'], against: 'The capability list below' },
      M5: { check: ['May the files marked carry go to the new system unchanged (images, CSS, fonts, report templates)?'], against: 'The carried files below' },
      C1: { check: ['May the files marked excluded really be left behind (generated code, vendored libraries, dead code)?', 'Does each have its reason?'], against: 'The excluded files and their reasons below' },
      D: { check: ['Are the product, version and the place of the definitions right?', 'Do the counts of logic in the database (views, procedures, triggers) match what is there?'], against: 'The table below (database.md)' },
      D90: { check: ['Do you understand which definitions could not be read, and why (the target design decides what to do)?'], against: 'Missing definitions below' },
    },
    'spec-relay-extract': {
      R: {
        check: ['Do the requirement and its scenarios do what the source lines do (conditions, calculations, errors)?', 'When the crosscheck is not confirmed, why?'],
        against: 'The source lines, the existing tests and the crosscheck',
        wrong: 'Write the behavior that differs or the condition that is missing; also when you think the source is the bug',
      },
      S: { check: ['Are the fields, actions, messages and transitions those of the real screen?', 'Compare with the screenshot when there is one'], against: 'The screenshot and screens.md' },
      Q: { check: ['Decide what the new system does, and write it as the decision'], against: 'The question and the source', wrong: 'Write when the question itself is wrong. When you cannot decide yet, put it on hold and say whom to ask' },
      C: { check: ['Are the sites with markers (a database write, an error) that were judged "no behavior" really not part of the spec?'], against: 'The omission check (site ledger)' },
    },
    'spec-relay-amend': {
      R: { check: ['Does the new wording correct a misreading of what the source does?', 'Does it break no other scenario?'], against: 'The old and new wording and the source lines' },
      I1: { check: ['Are the ports it touches, and how they change, right?'], against: 'impact.md in the appendix' },
    },
    'spec-relay-target': {
      A: { check: ['Do the modules and the direction of their dependencies follow the survey\'s context map?'], against: 'architecture.md in the appendix' },
      V: { check: ['Can the team keep using the language, frameworks, conventions and commands?'], against: 'conventions.md in the appendix' },
      E: { check: ['Does each context\'s verification level (A to C) fit its risk?'], against: 'verification.md in the appendix' },
      U: { check: ['Are the look policy (same / layout / new) and the carried files right?'], against: 'ui.md in the appendix' },
      D: { check: ['Are the handling of the database (keep / move), the exceptions and the data access mapping right?'], against: 'data.md in the appendix' },
    },
    'spec-relay-finish': {
      C1: { check: ['Did every whole-system check pass?'], against: 'checks.md in the appendix' },
      L: { check: ['Is the class of each leftover right (before the switch / after the switch / accepted)?'], against: 'leftovers.md in the appendix', wrong: 'Write the class it should have, and why' },
      H: { check: ['Are the verdict and what happens before the switch right?'], against: 'handover.md in the appendix' },
    },
    common: 'Write what is wrong under "Needs a change" (the agent corrects it and writes what it changed under the item). When you cannot decide yet, put it on hold with the reason',
    words: { check: 'Check', against: 'Compare with', wrong: 'When it is wrong', how: 'How to check' },
  },
};

const lang = (code) => (code === 'ja' ? 'ja' : 'en');

// The guidance of one item: by its id, else by its letter. Null when the kit has none.
export function itemGuide(schema, item, code) {
  const all = GUIDE[lang(code)][schema];
  if (!all) return null;
  if (item.id && all[item.id]) return { ...all[item.id], own: true };
  if (item.letter && all[item.letter]) return { ...all[item.letter], own: false };
  return null;
}

export const guideWords = (code) => GUIDE[lang(code)].words;
export const commonAdvice = (code) => GUIDE[lang(code)].common;
