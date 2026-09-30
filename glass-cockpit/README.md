# glass-cockpit

AI が自律的に作業している間に、人が進み具合を一目で見られるようにする作業ダッシュボード。AI が書き換えるタスクと質問の横に、Claude Code のセッションログから集計した指標を並べる。

## インストール

Node.js 22.18 以降が要る（スクリプトは TypeScript のまま Node.js で動かす。ビルドも依存パッケージも要らない）。

```
/plugin marketplace add enokizako/enokizako-agent-plugins
/plugin install glass-cockpit@enokizako-agent-plugins
```

チームで使う方法とアップデートの方法は、[マーケットプレイスの README](../README.md) を参照。

## 画面に出るもの

- **今の状態**: 直近のセッションが、人の回答や権限の許可を待っているのか、ターンを終えたのか、動いているのかを色で出す。ブラウザのタブのタイトルにも出る。
- **タスク**: 進行中と次にやるものを上に出し、完了とやらないものは折りたたむ。
- **質問**: AI が人の判断を仰ぎたいこと。回答が来ない時に AI が取る行動も並べる。
- **指標**: 費用（API 単価で換算）、キャッシュ読み込み率、ツールのエラー率、文脈の読み落とし、拒否、API エラーなど。
- **運用状況**: サブエージェントや Codex の実行、使っているモデル、レビューゲート（作業の前に通したいスキルを実行したか）。
- **セッション一覧**: 並行して動いているセッションの状態。
- **worktree 一覧**: git worktree ごとの費用・状態・タスク。

指標の定義や判定のしかたは [SKILL.md](skills/dashboard/SKILL.md) にある。

## 使いかた

Claude に頼む。

- 「作業ダッシュボードを作って」: `.dev/dashboard.json` と料金表 `.dev/prices.json` を作り、料金表を公式の料金ページで最新にする。
- 「ダッシュボードを開いて」: HTML を作って開く。常に最新で見たい時は `serve` で開くよう頼む。

ダッシュボードを作った後は、セッションの始めにフックが更新の手順を Claude に伝える。Claude はタスクに着手した時・終えた時・進めなくなった時・人に判断を仰ぎたい時に、`dashboard.json` を書き換える。回答はチャットで返す。

- `serve` は開くたびに集計し直し、30 秒ごとに再読み込みする。
- `serve` で開いた画面では、タスクを「やめる」ボタンで「やらない」に消し込める。`build` の HTML は静的なので、ボタンは出ない。
- `.dev/` は `.gitignore` に入れる想定。

### スクリプトを直接動かす

スクリプトはこのフォルダの `skills/dashboard/scripts/dashboard.ts`。ダッシュボードを置くプロジェクトのルートで実行する。

```sh
node <このフォルダ>/skills/dashboard/scripts/dashboard.ts init   # .dev/dashboard.json と .dev/prices.json を作る
node <このフォルダ>/skills/dashboard/scripts/dashboard.ts build  # .dev/dashboard.html を書き出す
node <このフォルダ>/skills/dashboard/scripts/dashboard.ts serve  # http://127.0.0.1:8765 で配信する
```

`serve` のポートが使われていれば、次の空いているポートを使う。

## dashboard.json

```json
{
  "title": "foo 作業ダッシュボード",
  "project": "..",
  "cost_cap_usd": 300,
  "session_cap_usd": 25,
  "tasks": [
    { "id": "T1", "status": "doing", "title": "ログイン画面の実装" },
    { "id": "T2", "status": "blocked", "title": "決済の組み込み", "blocker": "Q1 の回答待ち" }
  ],
  "questions": [
    {
      "id": "Q1",
      "urgency": "高",
      "question": "決済は Stripe と PAY.JP のどちらにしますか？",
      "default": "Stripe で進める",
      "answer": null
    }
  ]
}
```

`status` は `todo` / `doing` / `blocked` / `done` / `dropped` のどれか。ほかの項目（`gates`、`exclude_worktrees` など）は [SKILL.md](skills/dashboard/SKILL.md) を参照。

## worktree ごとに分ける

親のリポジトリに `.dev/dashboard.json` があれば、git worktree の中でセッションを始めた時に、フックがその worktree 用のダッシュボードを作る。費用の上限と料金表は親から引き継ぎ、タスクは空で始まる。親のダッシュボードは worktree の分を数えないので、費用が二重にならない。

## フックが記録するもの

今の状態を出すため、フックがセッションの出来事（プロンプトの送信、ツールの開始と終了、権限の確認、ターンの終了など）を `~/.claude/glass-cockpit/sessions/<セッション ID>.jsonl` に記録する。

- ダッシュボードの無いプロジェクトも含め、プラグインを読み込んだすべてのセッションで記録する。
- `cleanupPeriodDays`（既定 30 日）より古い記録は、セッションの終了の時に消す。
- フックは何も出力せず、失敗しても Claude を止めない。

## ライセンス

[MIT](LICENSE)
