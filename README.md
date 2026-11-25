# golangci-lint-playground

[golangci-lint](https://golangci-lint.run/) をブラウザの中だけで動かす playground です。Go コードと `.golangci.yml` を書いて Run を押すと、WebAssembly 版の golangci-lint が検査し、結果をエディタ上に表示します。コードはサーバーに送られません。

![スクリーンショット](docs/images/screenshot.png)

## できること

- golangci-lint v2.15.0（Go 1.27.4 でビルド）による検査。結果はネイティブ版と同じです（`testdata/parity/` で確認しています）
- `.golangci.yml` の自由記述。書いた内容は書き換えずにそのまま使われます
- `.golangci.yml` の補完・説明・警告（golangci-lint の JSON Schema に基づく）と、リンター・フォーマッタを一覧から選べるダイアログ（YAML の該当箇所だけを書き換えます）
- `Format` ボタン（Shift+Alt+F）: goimports で整形し、足りない import を追加します
- `Fix` ボタン: 自動修正できる指摘をまとめて直します（`golangci-lint run --fix`）。結果一覧やエディタの指摘の「修正」から、1 件ずつ直すこともできます
- 複数ファイル（タブで切り替え）、同じモジュール内のパッケージ
- サンプル集（`web/examples/`）
- URL での共有（コードと設定は URL の `#` 以降に圧縮して入り、サーバーには送られません）

## 制約

- import できるのは標準ライブラリと同じモジュール内のパッケージだけです（サードパーティモジュールには対応しません）
- 動作確認しているブラウザは Google Chrome（デスクトップ版）です
- 初回は約 25MB をダウンロードします（2 回目以降は Service Worker のキャッシュから読み込みます）
- 一部の機能はブラウザでは動きません: `gomoddirectives`、`gomodguard`、`gomodguard_v2`、gocritic の ruleguard、カスタムリンター（プラグイン）。設定に書くとエディタに警告が出ます

詳しくは [設計書](docs/design.md) を参照してください。

## 開発

必要なもの: Go（`wasm/go.mod` の toolchain は自動で取得されます）、Node.js 22 以上

```bash
cd web && npm ci
```

golangci-lint の WASM 版・標準ライブラリのバンドル・解析キャッシュを作ります（数分かかります）。出力先は `wasm/dist/` です。

```bash
./scripts/build-assets.sh
```

開発サーバー:

```bash
cd web && npm run dev
```

テスト:

```bash
cd web && npm test
```

```bash
cd web && npm run parity
```

```bash
cd web && npm run build && npm run e2e
```

| ディレクトリ | 内容 |
| --- | --- |
| `wasm/` | golangci-lint を js/wasm にビルドするパイプライン（`golang.org/x/tools` へのパッチ、標準ライブラリのバンドル生成） |
| `web/` | Web アプリ（Vite + TypeScript + CodeMirror 6）。`src/engine/` が Web Worker で golangci-lint を動かす部分 |
| `testdata/parity/` | ネイティブ版と WASM 版の結果を比べるテストケース（`web/examples/` のサンプルも対象） |
| `scripts/` | アセットのビルド |
| `docs/` | 設計書 |

`main` ブランチへの push で、GitHub Actions がテストを実行し、GitHub Pages にデプロイします（リポジトリの Settings → Pages で Source を「GitHub Actions」にしておく必要があります）。

CI のすべてのジョブが成功したかは、`CI success` という 1 つのチェックにまとまっています。`main` を保護するときは、Settings → Rules → Rulesets のブランチ ruleset で「Require status checks to pass」に `CI success` だけを指定してください。ジョブを増やしたり分けたりしても、ruleset を変える必要はありません。auto-merge（Settings → General → Allow auto-merge）もこのチェックを待ってマージします。

## License

MIT
