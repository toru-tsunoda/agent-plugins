# enokizako-agent-plugins

enokizako の Claude Code プラグインのマーケットプレイス。

| プラグイン | 内容 |
|---|---|
| [glass-cockpit](glass-cockpit/README.md) | AI の作業を見守る作業ダッシュボード |

## インストール

Claude Code で、マーケットプレイスを足してからプラグインを入れる。

```
/plugin marketplace add enokizako/enokizako-agent-plugins
/plugin install glass-cockpit@enokizako-agent-plugins
```

プラグインごとに要るもの（Node.js の版など）は、各プラグインの README を参照。

### チームで使う

プロジェクトの `.claude/settings.json` に書いてコミットすると、チームで同じプラグインを使える。

```json
{
  "extraKnownMarketplaces": {
    "enokizako-agent-plugins": {
      "source": { "source": "github", "repo": "enokizako/enokizako-agent-plugins" }
    }
  },
  "enabledPlugins": {
    "glass-cockpit@enokizako-agent-plugins": true
  }
}
```

## アップデート

このマーケットプレイスは、既定では自動で更新されない。新しい版を取り込むには、マーケットプレイスを更新してからプラグインを更新する。

```
/plugin marketplace update enokizako-agent-plugins
```

プラグインの更新は `/plugin` の画面からするか、シェルで `claude plugin update glass-cockpit@enokizako-agent-plugins` を実行する。

自動で更新したい時は、`/plugin` の Marketplaces タブでこのマーケットプレイスを選び、Enable auto-update にする。

## 開発

clone したリポジトリを、ローカルのマーケットプレイスとして足して試す。

```
/plugin marketplace add /path/to/enokizako-agent-plugins
/plugin install glass-cockpit@enokizako-agent-plugins
```

リリースする時は、プラグインの `.claude-plugin/plugin.json` の `version` を上げる。**上げないと、コードを変えても利用者には届かない**。`version` は `plugin.json` にだけ書き、`.claude-plugin/marketplace.json` には書かない（両方にあると `plugin.json` が使われ、食い違いに気づきにくい）。

マニフェストは次のコマンドで確かめられる。

```sh
claude plugin validate .               # マーケットプレイス
claude plugin validate ./glass-cockpit # プラグイン
```

## ライセンス

[MIT](LICENSE)
