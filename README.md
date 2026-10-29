# Claude Code Plugins by enokizako

- https://github.com/enokizako/enokizako-agent-plugins

## インストール方法

### 1. マーケットプレイスを登録

```bash
/plugin marketplace add enokizako/enokizako-agent-plugins
```

### 2. プラグインをインストール

```bash
/plugin install glass-cockpit@enokizako-agent-plugins
```

プラグインの詳細が開くので、中身を確かめてからインストールする範囲を選びます。

- **Install for you**: 自分の、すべてのプロジェクトで使う
- **Install for all collaborators on this repository**: このリポジトリで作業する全員で使う（`.claude/settings.json` に書かれます）
- **Install for you, in this repo only**: 自分の、このリポジトリだけで使う

`Run /reload-plugins to activate.` と出たら、`/reload-plugins` を実行するか、Claude Code を起動し直すと使えるようになります。

### チームで使う場合

リポジトリの `.claude/settings.json` に次のように書いてコミットすると、そのリポジトリで作業する全員が同じプラグインを使えます。`autoUpdate` を `true` にしておくと、新しい版が自動で入ります。

```json
{
  "extraKnownMarketplaces": {
    "enokizako-agent-plugins": {
      "source": { "source": "github", "repo": "enokizako/enokizako-agent-plugins" },
      "autoUpdate": true
    }
  },
  "enabledPlugins": {
    "glass-cockpit@enokizako-agent-plugins": true
  }
}
```

## アップデート方法

このマーケットプレイスは、既定では自動で更新されません。

### 自動で更新する

1. `/plugin` コマンドを実行
2. Marketplaces タブで `enokizako-agent-plugins` を選択
3. 「Enable auto-update」を選択

自動更新は、セッションで最初のメッセージを送ってから 10 分ほどのうちに、裏で行われます。今のセッションは古い版のまま動き、`Plugin updated: … Run /reload-plugins to apply` と出ます。新しい版は、`/reload-plugins` を実行するか、次にセッションを始めた時から使われます。

### 手動で更新する

```bash
/plugin marketplace update enokizako-agent-plugins
```

でマーケットプレイスを更新してから、`/plugin` の Installed タブでプラグインを選び、「Update now」を選びます。シェルからは `claude plugin update glass-cockpit@enokizako-agent-plugins` でも更新できます。

### 新しい版が入らない場合

プラグインは、`plugin.json` の `version` が変わった時だけ更新されます。GitHub に新しい commit があっても、版が同じなら `already at the latest version` と出て何も変わりません。

## 含まれるプラグイン

### glass-cockpit

AI に作業を任せている間に、進み具合を一目で見られる作業ダッシュボードです。飛行機のグラスコックピット（計器を1枚の画面にまとめた操縦席）のように、今の状態・タスク・費用を1画面に並べます。

前提: Node.js 22.18 以降がインストールされていること。

#### 機能

- AI がタスクと質問を書き出し、着手・完了のたびに更新する
- 今のセッションが「人の回答待ち」「権限の確認待ち」「ターンを終えて入力待ち」「実行中」のどれかを色で出す。ブラウザのタブのタイトルにも出る
- 費用（API 単価で換算）、キャッシュ読み込み率、ツールのエラー率などを、セッションログから集計する
- 並行して動くセッションや、git worktree ごとの作業を一覧にする

#### 使い方

作業中に「作業ダッシュボードを作って」と伝えると、プロジェクトに `.dev/glass-cockpit/` を作ります。あとは、いつもどおり作業を頼むだけで、AI がダッシュボードを更新します。「ダッシュボードを開いて」と伝えると、ブラウザで開きます。

```bash
/glass-cockpit:dashboard
```

詳細は [glass-cockpit/README.md](glass-cockpit/README.md) を参照してください。

## 開発

clone したリポジトリを、ローカルのマーケットプレイスとして登録して試します。ローカルから登録したプラグインは、ソースをその場で読み込むので、編集は次のセッションか `/reload-plugins` で反映されます。

```bash
/plugin marketplace add ./path/to/enokizako-agent-plugins
/plugin install glass-cockpit@enokizako-agent-plugins
```

### このリポジトリ自身で使う（ドッグフーディング）

このリポジトリの `.claude/settings.json` で、GitHub の `toru-tsunoda/agent-plugins` をマーケットプレイスとして登録し、glass-cockpit を有効にしています。手元でもクラウドのセッションでも、このリポジトリを開けば、`main` の版の glass-cockpit が使えます（`autoUpdate` が `true` なので、`version` を上げてマージすると届きます）。

ブランチで編集中の版を手元で試す時は、`.claude/settings.local.json`（コミットしない）で `main` の版を止めてから、`--plugin-dir` で読み込みます。両方を読み込むと、フックが2回動きます。

```json
{
  "enabledPlugins": {
    "glass-cockpit@enokizako-agent-plugins": false
  }
}
```

```bash
claude --plugin-dir ./glass-cockpit
```

リリースする時は、プラグインの `.claude-plugin/plugin.json` の `version` を上げます。**上げないと、コードを変えても利用者には届きません**。`version` は `plugin.json` にだけ書き、`.claude-plugin/marketplace.json` には書きません（両方にあると `plugin.json` が使われ、食い違いに気づきにくいため）。

マニフェストは次のコマンドで確かめられます。

```bash
claude plugin validate .               # マーケットプレイス
claude plugin validate ./glass-cockpit # プラグイン
```

## ライセンス

[MIT](LICENSE)
