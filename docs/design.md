# golangci-lint playground 設計書

## 1. 概要

[Go Playground](https://go.dev/play/) のように、ブラウザ上で Go コードを書き、[golangci-lint](https://golangci-lint.run/) による検査結果をその場で確認できる Web アプリケーションを作る。

golangci-lint を WebAssembly（js/wasm）にビルドし、**ブラウザの中だけで検査を実行する**。コードの検査にサーバーを使わないため、静的ホスティングだけで公開でき、ユーザーのコードが外部に送られることもない。

### 1.1 ゴール

- ブラウザだけで Go コードに golangci-lint をかけ、結果をエディタ上にインライン表示できる
- golangci-lint の設定ファイル（`.golangci.yml`）を **YAML で自由記述** でき、書いた内容がそのまま検査に反映される（詳細は [1.4](#14-要件設定ファイル-yaml-の自由記述)）
- 有効にするリンターなど、よく使う設定は GUI からも調整できる
- コード・設定・バージョンを含む状態を URL で共有できる
- 複数の golangci-lint バージョンを選んで試せる
- 実行用サーバーを持たず、静的ホスティングだけで運用できる

### 1.2 ノンゴール（当面はやらない）

- Go コードの **実行**（それは Go Playground の役割）
- golangci-lint のカスタムプラグイン（Module Plugin / Go Plugin）のロード
- cgo を含むコードの解析
- サードパーティモジュールに依存するコードの解析（[11 章](#11-未解決の論点今後の検討事項) で継続検討。MVP は標準ライブラリのみ）
- ユーザーアカウント・保存履歴の管理

### 1.3 想定ユースケース

- リンターの挙動や指摘内容を手軽に確かめる（「この書き方は `gocritic` に怒られる？」）
- golangci-lint の issue / PR / ブログで再現コードを URL で共有する
- 設定項目（`linters.settings.*`）の効果を試行錯誤する
- バージョン間で挙動差を比較する
- 手元のプロジェクトの `.golangci.yml` をそのまま貼り付けて、挙動を再現・共有する

### 1.4 要件：設定ファイル (YAML) の自由記述

ユーザーは golangci-lint の設定ファイルを YAML で自由に記述できる。playground は「GUI で選べる範囲の設定」に機能を絞らず、golangci-lint が受け付ける設定はすべてそのまま使えるようにする。

- **YAML を書き換えない**: ユーザーが書いた YAML は、一字一句そのまま `.golangci.yml` として golangci-lint に渡す。playground が制御したい項目（結果の JSON の出力先、並列実行ロックの無効化）は、設定ファイルではなく **コマンドラインフラグ** で指定する。フラグは設定ファイルより優先されるので、ユーザーが `output.*` などを書いていても結果の取得には影響しない（[4.2](#42-検査エンジンweb-worker)、PoC で確認済み）
- **YAML エディタを主役にする**: 設定パネルの正本は YAML テキストとする。GUI（リンター選択など）は YAML を編集するための補助で、GUI 操作は YAML の該当箇所だけを書き換える（コメントやキーの順番、GUI が扱わない設定は残す）
- **非対応の機能は見える形で伝える**: ブラウザ内では動かない設定（`go` コマンドを内部で使うリンターや、カスタムプラグインなど。[4.6](#46-ブラウザ内で動かない機能の扱い)）が書かれていたら、YAML エディタの該当行に警告マーカーを出す。設定は書き換えず、実行も止めない
- **エラーはそのまま見せる**: YAML の構文エラーや golangci-lint が出す設定エラーは、そのまま結果パネルに表示し、行番号が分かるものはエディタ上にもマーカーを出す
- **貼り付けやすさ**: 手元の `.golangci.yml` を丸ごと貼り付けても動くことを目標にする。v1 形式（`version: "2"` がない設定）を貼り付けた場合は、`golangci-lint migrate`（ブラウザ内で実行）による v2 形式への変換を提案する
- **共有に含める**: 自由記述した YAML はコメントも含めて共有 URL にそのまま保存し、共有 URL を開くと一字一句同じ内容が再現される

## 2. 前提となる事実（検証済み）

golangci-lint v2.5.0 のネイティブ版と、js/wasm 版の PoC（[付録 A](#付録-a-wasm-方式の-poc-結果)、[`poc/wasm/`](../poc/wasm/README.md)）で確認した事実。

| 項目 | 挙動 | 設計への影響 |
| --- | --- | --- |
| js/wasm ビルド | `GOOS=js GOARCH=wasm` なら golangci-lint 本体を無改造でビルドできる（`wasip1` は依存ライブラリが非対応で失敗） | ターゲットは `js/wasm`。Go 公式の `wasm_exec.js` を使う |
| パッケージ読み込み | `go/packages` が `go list` を子プロセスとして起動するが、js/wasm ではプロセスを作れない | `golang.org/x/tools` に小さなパッチを当て、プロセス内で読み込むドライバに差し替える（golangci-lint 本体は無改造） |
| 依存パッケージの型情報 | golangci-lint は依存パッケージを export data（コンパイラが出力する型情報）から読む | 標準ライブラリの export data をビルド時に生成して同梱する |
| ファイル操作 | `wasm_exec.js` はブラウザではファイル操作を未実装にしている | Node 互換の `fs` API をメモリ上で実装し、`globalThis.fs` に差し込む |
| 解析キャッシュ | キャッシュなしの 1 回目は約 22 秒。標準ライブラリ全体の解析キャッシュは gzip 後 0.3MB で、ブラウザと同じパス構成で事前生成すればそのまま有効 | キャッシュをビルド時に生成して同梱する |
| JSON 出力 | `--output.json.path <path>` で `{"Issues": [...], "Report": {...}}` が得られる。フラグは設定ファイルの `output.*` より優先される | JSON はメモリ上のファイル（例: `/tmp/result.json`）に書かせて読む。ユーザーの YAML は書き換えない |
| Issue の形 | `FromLinter`, `Text`, `Severity`, `SourceLines`, `Pos{Filename,Offset,Line,Column}`, 自動修正可能なものは `SuggestedFixes[].TextEdits[]{Pos,End,NewText}`（`NewText` は base64） | エディタ上のマーカーやクイックフィックスに直接使える |
| 型エラー | `FromLinter: "typecheck"` として返り、`Pos` は `Line:1, Column:0` 固定、実際の位置は `Text` 内の `./main.go:11:2: ...` に埋め込まれる | `Text` を正規表現で再パースして位置を補正する（PoC で実装済み） |
| 終了コード | 指摘ありは 1。ブラウザ内では `go` コマンドの起動失敗などをログに出すため 7（エラーをログ出力）になることが多い | 終了コードには依存せず、JSON を正とする |
| リンター一覧 | `golangci-lint help linters --json` で `name, description, groups, fast, autoFix, deprecated, since, originalURL` が得られる | バージョンごとにビルド時に書き出し、リンター選択 UI に使う |
| 設定の JSON Schema | golangci-lint のモジュールに `jsonschema/golangci.jsonschema.json` が同梱されている（`config verify` はネットワーク越しに取りに行くので使わない） | ビルド時にモジュールから取り出して同梱する |
| フォーマッタ | v2 では `formatters` セクションに分離。`golangci-lint fmt` でファイルを整形できる | 「Format」機能は `fmt` サブコマンドで実装する。ただし `gci` はブラウザ内で動かない |
| `go` コマンドへの依存 | `gomoddirectives`・`gci` は `go` コマンドを起動できず失敗する。golangci-lint は警告をログに出して処理を続ける | 非対応として UI で警告する（[4.6](#46-ブラウザ内で動かない機能の扱い)） |
| Go バージョン | golangci-lint をビルドした Go と、同梱する標準ライブラリの Go は一致している必要がある | バージョンごとに「golangci-lint ＋ Go ツールチェイン」の組を固定してビルドする |

## 3. 全体アーキテクチャ

```
┌──────────────────────── 静的ホスティング (CDN) ────────────────────────┐
│  /index.html, /assets/*            アプリ本体（Vite でビルド）          │
│  /versions.json                    利用可能な golangci-lint バージョン  │
│  /v/{version}/                     バージョンごとのアセット（不変）     │
│     golangci-lint.wasm.gz          js/wasm 版 golangci-lint             │
│     std.bundle.gz                  標準ライブラリ（ソース・型情報・構成）│
│     cache.bundle.gz                事前生成した解析キャッシュ           │
│     linters.json / schema.json     リンター一覧・設定の JSON Schema     │
└───────────────┬───────────────────────────────────────────────────────┘
                │ HTTPS（初回のみ。以降は Service Worker のキャッシュ）
┌───────────────▼──────────────────────── Browser ──────────────────────┐
│  メインスレッド (TypeScript + CodeMirror 6)                            │
│   ├ Go エディタ（複数ファイル / txtar）                                │
│   ├ 設定パネル（YAML エディタ ＋ リンター選択 GUI）                    │
│   ├ 結果パネル（一覧 + エディタ内マーカー + Quick Fix）                │
│   └ 共有（URL フラグメントへの圧縮保存）                               │
│            │ postMessage（ファイル・設定 ⇄ 正規化済みの結果）          │
│  ┌─────────▼──────── Web Worker（検査エンジン）──────────────────────┐ │
│  │  MemFS（Node 互換 fs をメモリ上に実装、globalThis.fs）            │ │
│  │   /goroot, /stdexport, /stdmanifest.json  ← std.bundle            │ │
│  │   /cache/golangci-lint                    ← cache.bundle          │ │
│  │   /work                                   ← ユーザーのファイル    │ │
│  │  wasm_exec.js + golangci-lint.wasm（実行ごとに新しいインスタンス）│ │
│  └───────────────────────────────────────────────────────────────────┘ │
│  Service Worker: /v/{version}/* を Cache API に保存                    │
└────────────────────────────────────────────────────────────────────────┘
```

### 3.1 方式選定：サーバーサイド実行か、ブラウザ内 WASM か

当初は「ブラウザ内 WASM は非現実的」と判断し、サーバーサイドで隔離実行する設計を書いていた。しかし PoC で **golangci-lint 本体を無改造のまま js/wasm で動かし、ネイティブと同じ検査結果が得られる** ことを確認したため、両方式を比較し直した。

| 観点 | A. ブラウザ内 WASM | B. サーバーサイドで隔離実行 |
| --- | --- | --- |
| セキュリティ | ユーザーのブラウザ内で完結するため、サンドボックスの設計・運用が不要。コードがサーバーに送られない | gVisor などによる強い隔離、レート制限、DoS 対策が必須 |
| インフラ・運用コスト | 静的ホスティングだけで済み、利用者が増えてもコストがほぼ増えない | 実行用の VM / コンテナ基盤が必要。利用量に比例してコストが増える |
| 初回ロード | 約 24MB（gzip 後。WASM 15.1MB + 標準ライブラリ 9.0MB + 事前生成キャッシュ 0.3MB）。2 回目以降はブラウザのキャッシュから読む | 軽い（エディタ UI だけ） |
| 実行速度 | ブラウザ PoC で 1 回目 約 3 秒、2 回目以降 約 0.9 秒（標準設定） | 約 0.5 秒 |
| メモリ | 330〜550MB。スマートフォンでは厳しい可能性がある | サーバー側で制御できる |
| 対応できない機能 | `go` コマンドを内部で起動するリンター・フォーマッタ（`gomoddirectives`、`gci` など）。サードパーティモジュールの対応は難しい | 制約なし |
| メンテナンス | golangci-lint の新バージョンごとに、`golang.org/x/tools` の小さなパッチを当てて再ビルドする | 公式バイナリを使うだけ |

**決定（2026-11-25）: ブラウザ内 WASM 方式（A）を採用する。** ブラウザで動く PoC（[`poc/wasm/`](../poc/wasm/README.md)）で、実用的な速度で動作することを確認した（[付録 A.5](#a5-ブラウザでの検証結果)）。サーバーサイド方式の検討内容は [付録 B](#付録-b-サーバーサイド方式不採用案) に要約を残す。

## 4. コンポーネント詳細

### 4.1 フロントエンド（UI）

- **技術**: TypeScript + Vite、エディタは **CodeMirror 6**
  - Monaco より軽量でモバイルでも動作し、`@codemirror/lint` で診断表示、`@codemirror/lang-go` / `@codemirror/lang-yaml` が使える
  - UI フレームワークは小さく保つ（Preact もしくは素の TS）
- **画面構成**
  - ヘッダ: `Run`（Ctrl/Cmd+Enter）、`Cancel`（実行中のみ）、`Format`、`Fix`、`Share`、バージョン選択、サンプル選択
  - 左: Go コードエディタ（ファイルタブ。`+` で `go.mod` や追加ファイルを作成）
  - 右上: 設定パネル（[1.4](#14-要件設定ファイル-yaml-の自由記述) の要件に対応）
    - **YAML エディタ（正本）**: `.golangci.yml` を自由記述する。`@codemirror/lang-yaml` によるハイライト、バージョンごとの JSON Schema を使ったキー補完・ホバー説明・型チェック。Schema に反する記述は警告として表示するだけで、実行は止めない（最終的な判断は golangci-lint に任せる）
    - **GUI（補助）**: リンター一覧（`linters.json` から生成。検索・グループ・`fast` / `autoFix` バッジ・説明・元リポジトリへのリンク）をチェックボックスで選ぶと、YAML の `linters.enable` / `linters.disable` / `linters.default` だけを書き換える。YAML 側の変更は GUI に即時反映する
    - YAML の部分書き換えには、コメントや順序を保持できる YAML ライブラリ（`yaml` パッケージの Document API など）を使う
    - 非対応の設定（[4.6](#46-ブラウザ内で動かない機能の扱い)）や設定エラーは、YAML エディタの該当行にマーカーで表示する
    - 「デフォルト設定に戻す」「サンプル設定を挿入」ボタンを用意する
  - 右下 / 下部: 結果パネル
    - Issue 一覧（リンター名・メッセージ・位置）。クリックで該当行へジャンプ
    - エディタ内に波線マーカー、ホバーでメッセージ、`SuggestedFixes` があれば Quick Fix ボタン
    - 実行時間、golangci-lint のログ（stderr、折りたたみ）
- **初回ロードの表示**: 約 24MB のダウンロード中は進捗（MB / 全体）を表示する。ダウンロード中もエディタは使える。2 回目以降の訪問では Service Worker のキャッシュから読むので待ち時間はほぼない
- **非力な端末への配慮**: メモリが少ない端末（`navigator.deviceMemory` が小さい場合など）では、ダウンロード開始前に「重い処理です」と確認を出す
- **状態の永続化**: 編集中の内容は `localStorage` に自動保存（try/catch でラップ）
- **複数ファイルの表現**: Go Playground と同じ [txtar](https://pkg.go.dev/golang.org/x/tools/txtar) 形式を内部表現・共有形式に採用する

  ```
  -- go.mod --
  module playground

  go 1.25
  -- main.go --
  package main
  ...
  ```

### 4.2 検査エンジン（Web Worker）

PoC の `web/worker.js`・`gofs.js`・`runner.js`・`bundle.js` を TypeScript に移植して本実装とする。

#### メッセージプロトコル

| 方向 | メッセージ | 内容 |
| --- | --- | --- |
| UI → Worker | `init` | `{ version }`。アセットを取得・展開し WASM をコンパイルする |
| UI → Worker | `lint` | `{ id, files: { name: content }, config }`。検査を実行する |
| UI → Worker | `fix` / `fmt` | `lint` と同じ入力。`--fix` 付きの実行 / `golangci-lint fmt` を行い、変更後のファイルを返す |
| UI → Worker | `migrate` | `{ id, config }`。`golangci-lint migrate` で v1 設定を v2 に変換する |
| Worker → UI | `progress` | `{ name, loaded, total }`。ダウンロードの進捗 |
| Worker → UI | `ready` | 初期化完了 |
| Worker → UI | `result` | `{ id, issues, files?, log, exitCode, ms }` |
| Worker → UI | `error` | `{ id?, code, message }` |

#### 実行の流れ

1. `/work` を空にし、ユーザーのファイルと `.golangci.yml`（ユーザーの YAML そのまま）を書き込む。`go.mod` がなければ `module playground` とバンドルした Go のバージョンで補う
2. 新しい Go インスタンスを作り、以下の引数・環境変数で golangci-lint を起動する
   - 引数: `run --allow-parallel-runners --output.json.path /tmp/result.json --show-stats=false ./...`
   - 環境変数: `GOROOT=/goroot`、`GOOS=linux`、`GOARCH=amd64`、`CGO_ENABLED=0`、`GOTOOLCHAIN=local`、`GOLANGCI_LINT_CACHE=/cache/golangci-lint`、`WASM_STD_MANIFEST`、`WASM_EXPORT_DIR`、`HOME`
3. 終了後、`/tmp/result.json` を読んで正規化する（JSON がなければ stdout / stderr をエラーとして返す）。ユーザーの設定で stdout / stderr に出力された内容はログとして返す
4. Go ランタイムが残したタイマー（`go._scheduledTimeouts`）を片付ける（残すと `Go program has already exited` が投げられる）

- **実行ごとに新しい Go インスタンス**を作り、MemFS は使い回す。これで golangci-lint の解析キャッシュが実行をまたいで効き、2 回目以降が速くなる（PoC で約 0.9 秒）。WASM のメモリはインスタンスごとに捨てられる
- 実行は 1 本ずつ直列に処理する（キュー）
- **キャンセル**: Worker を `terminate()` し、新しい Worker を作り直す。コンパイル済みの `WebAssembly.Module` とバンドルのバイト列はメインスレッド側で保持して新しい Worker に渡し、再ダウンロード・再コンパイルを避ける（実行中に作られた解析キャッシュは失われる）
- **タイムアウト**: サーバーと違い、実行時間に上限は設けない。経過時間を表示し、ユーザーが `Cancel` で止められるようにする

#### 結果の正規化

```ts
type Issue = {
  linter: string;          // FromLinter
  message: string;         // Text
  severity?: string;
  file: string;            // /work からの相対パス
  line: number;
  column: number;
  sourceLines?: string[];
  fixes?: { message: string; edits: { start: number; end: number; newText: string }[] }[];
};
```

- `SuggestedFixes[].TextEdits[].NewText` は base64 デコードして文字列にする
- `typecheck` の Issue は `Text` を行ごとに `^\.?/?(?<file>[^:\s]+\.go):(?<line>\d+):(?<col>\d+): (?<msg>.*)$` でパースし、1 行 1 Issue に分解して位置を補正する
- 終了コードには依存しない（指摘ありで 1、ログにエラーを出すと 7 になる）

#### 入力の上限

コードはユーザー自身のブラウザで動くだけなので、安全上の制限は不要。ただし共有 URL の長さとメモリ使用量のために、緩い上限（例: ファイル数 20、合計 256KiB）を設け、超えたら警告する。

### 4.3 ビルドパイプライン

golangci-lint のバージョンごとに、以下のアセットを生成する。PoC の `build.sh` を本実装の土台にする。

| 手順 | 内容 | 出力 |
| --- | --- | --- |
| 1. x/tools のパッチ | golangci-lint の `go.mod` が要求する `golang.org/x/tools` をモジュールキャッシュからコピーし、`defaultDriver` へのフック（数行）とプロセス内ドライバ `inproc_js.go`（約 200 行）を追加する。`-modfile` の `replace` で差し替える | — |
| 2. WASM ビルド | `GOOS=js GOARCH=wasm go build -trimpath -ldflags='-s -w'` | `golangci-lint.wasm.gz`（約 15MB） |
| 3. 標準ライブラリ | `go list -export -json std`（`CGO_ENABLED=0 GOOS=linux GOARCH=amd64`）から、ソース・export data（`__.PKGDEF` のみ）・パッケージ構成のマニフェストを 1 ファイルにまとめる | `std.bundle.gz`（約 9MB） |
| 4. キャッシュ | ブラウザと同じ MemFS・同じパスで、Node 上で WASM 版を動かし、公開されている標準ライブラリを全部 import するプログラムを標準設定と `--default=all` で検査する | `cache.bundle.gz`（約 0.3MB） |
| 5. メタデータ | WASM 版で `help linters --json` / `help formatters --json` を実行。モジュール内の `jsonschema/golangci.jsonschema.json` を取り出す | `linters.json`、`formatters.json`、`schema.json` |
| 6. 検証 | テストスイート（[9 章](#9-テスト戦略)）を実行する | — |

- **Go ツールチェインの固定**: golangci-lint の公式リリースと同じ Go のマイナーバージョン（v2.5.0 なら Go 1.25 系）でビルドし、手順 3 の標準ライブラリも同じ Go から作る。PoC は環境の都合で Go 1.24.7 を使ったが、本実装では揃える
- **パッチの追従**: x/tools のパッチは `defaultDriver` の冒頭に数行足すだけなので、x/tools が更新されても当たり続ける見込みが高い。当たらなくなったらビルドが失敗するので、CI で気づける
- **ビルド成果物の不変性**: `/v/{version}/` 以下は一度公開したら変えない。ビルド方法を変えたときは、マニフェスト（`versions.json`）でビルド番号を上げてパスを変える（例: `/v/v2.5.0-2/`）

### 4.4 共有機能

サーバーを持たないため、**URL フラグメント方式** を基本にする。

- スナップショットを JSON にし、`CompressionStream('deflate-raw')` で圧縮して base64url 化し、`/#s=...` に入れる。フラグメントはサーバーに送られないので、共有内容がアクセスログにも残らない
- 共有 URL を開いたときは、内容を読み込むだけで **自動では実行しない**（`Run` を押して実行する）
- URL が長すぎる場合（例: 8,000 文字超）は警告し、後述の Gist 連携を案内する

スナップショット形式（バージョン付きで将来の拡張に備える）:

```json
{
  "schema": 1,
  "version": "v2.5.0",
  "files": "-- go.mod --\n...\n-- main.go --\n...",
  "config": "version: \"2\"\n..."
}
```

将来の拡張（Phase 3）: **GitHub Gist からの読み込み**（`/#gist=<id>`）。GitHub API は CORS に対応しているので、サーバーなしで実装できる。Gist 内の `.go` ファイル・`go.mod`・`.golangci.yml` を読み込む。

### 4.5 バージョン管理

- `/versions.json` に、公開しているバージョンの一覧・既定のバージョン・各バージョンの Go バージョンとアセットのサイズを書く
- 選択されたバージョンのアセットだけを取得する（バージョンを切り替えると、そのバージョンの約 24MB を新たに取得する）
- 新バージョンのリリースを定期ジョブ（GitHub Actions の schedule）で検知し、ビルド → テスト → デプロイ → `versions.json` 更新を行う PR を自動作成する
- 保持するのは直近 N 個（例: 5）のマイナーバージョンの最新パッチ程度にする。共有 URL のバージョンが廃止済みなら、最も近いバージョンで開いて警告を表示する

### 4.6 ブラウザ内で動かない機能の扱い

ブラウザ内では `go` コマンドを起動できないため、それに依存する機能は動かない。

| 機能 | 状態 | 扱い |
| --- | --- | --- |
| `gomoddirectives` | PoC で失敗を確認（`go list -m` を起動） | 非対応。設定で有効にされていたら警告マーカーを出す |
| `gci` フォーマッタ | PoC で失敗を確認（`go env` を起動） | 非対応。同上 |
| `gomodguard`、`depguard`（`$gostd` 変数）、`gocritic` の ruleguard、`gosec` の一部、`unconvert` | ソースに `go` コマンドを起動する処理があるが、PoC の `--default=all` ではエラーにならなかった。特定の設定のときだけ呼ばれる可能性がある | Phase 1 で設定を変えて検証し、必要なら非対応リストに加える |
| `linters.settings.custom`（プラグイン） | ブラウザ内ではロードできない | 非対応。警告マーカーを出す |
| go.mod を使ったキャッシュキーの計算など、golangci-lint 内部の `go env` 呼び出し | 警告をログに出して処理を続ける | 検査結果に影響しないので、ログから除外して表示する |

- 非対応の一覧はバージョンごとの定義ファイル（`unsupported.json`）で管理し、UI の警告とテストで共有する
- 将来、利用者の要望が多いものは、`go env` の結果を環境変数で渡すなどのパッチで個別に対応を検討する

## 5. セキュリティ・プライバシー

コードの検査はすべてユーザー自身のブラウザ内で行われるため、サーバーサイド方式で必要だったサンドボックス・レート制限・DoS 対策は不要になる。残る論点は以下。

| 脅威・論点 | 対策 |
| --- | --- |
| XSS（共有 URL に仕込まれた内容） | 共有 URL の内容は信頼しない。Issue メッセージ・ファイル名などはすべてテキストとしてレンダリングする（`innerHTML` 禁止）。CSP を設定する（`script-src 'self' 'wasm-unsafe-eval'`、`connect-src 'self' https://api.github.com`、`worker-src 'self'` など） |
| 重い共有 URL によるブラウザの占有 | 共有 URL は自動実行しない。検査は Worker で動くので UI は固まらず、`Cancel` で止められる |
| サプライチェーン（ビルドに使うコード） | golangci-lint と依存は `go.sum` で固定し、CI でソースからビルドする。x/tools のパッチはリポジトリで管理しレビューする。フロントエンドの依存は lockfile で固定する |
| 配信アセットの改ざん | 同一オリジンから配信し、HTTPS のみとする。`versions.json` に各アセットの SHA-256 を書き、Worker で検証する |
| プライバシー | コードはサーバーに送られない。共有内容は URL フラグメントに入るので、ホスティング側のログにも残らない。アクセス解析を入れる場合は Cookie を使わないものにする |

## 6. ディレクトリ構成（案）

```
.
├── web/                       # フロントエンド（Vite + TypeScript + CodeMirror 6）
│   ├── src/
│   │   ├── ui/                # エディタ、設定パネル、結果パネル、共有
│   │   ├── engine/            # Web Worker（PoC から移植）
│   │   │   ├── worker.ts
│   │   │   ├── gofs.ts        # メモリ上の fs
│   │   │   ├── bundle.ts
│   │   │   └── runner.ts      # golangci-lint の起動・結果の正規化
│   │   └── sw.ts              # Service Worker
│   └── examples/              # サンプルコード（txtar）
├── wasm/                      # WASM 版 golangci-lint のビルドパイプライン
│   ├── go.mod                 # golangci-lint のバージョンを固定
│   ├── xtools/                # go/packages のパッチとプロセス内ドライバ
│   ├── tools/mkbundle/        # 標準ライブラリのバンドル生成
│   ├── scripts/               # キャッシュ生成、メタデータ生成
│   └── build.sh
├── testdata/                  # ゴールデンテスト（txtar + 設定 + 期待結果）
├── e2e/                       # Playwright
├── .github/workflows/         # ビルド・テスト・デプロイ・新バージョン検知
├── poc/wasm/                  # PoC（本実装への移植後に削除）
└── docs/
    └── design.md
```

## 7. デプロイ構成

- **ホスティング**: 静的ホスティング（Cloudflare Pages または GitHub Pages）。サーバーサイドの処理はない
  - 1 ファイルのサイズ上限に注意する（Cloudflare Pages は 25MiB。`golangci-lint.wasm.gz` は約 15MB なので収まる）
  - 帯域: 新規訪問者 1 人あたり約 24MB。GitHub Pages は月 100GB の目安があるため、利用が増えたら帯域無制限の Cloudflare Pages に移す
- **キャッシュヘッダ**: `/v/{version}/*` は不変なので `Cache-Control: public, max-age=31536000, immutable`。`index.html` と `versions.json` は `no-cache`
- **圧縮**: アセットは自前で gzip 済みのファイルとして配信し、Worker で展開する（ホスティング側の圧縮設定に依存しない）。CDN の自動 brotli 圧縮が使えるなら、非圧縮の `.wasm` を置いて任せる方が小さくなるので、Phase 4 で比較する
- **Service Worker**: `/v/{version}/*` を Cache API に保存し、2 回目以降の訪問ではネットワークに取りに行かない。使わなくなったバージョンのキャッシュは削除する
- **CI/CD**: GitHub Actions で、バージョンごとのアセットをビルド（matrix）→ テスト → デプロイする。アセットのビルドは数分かかるので、ビルド済みのバージョンは再ビルドしない

## 8. 可観測性

サーバーがないため、取れる情報は限られる。

- アクセス解析（任意）: Cookie を使わない軽量な解析で、訪問数・利用バージョン程度を見る
- エラー報告（任意）: Worker の初期化失敗・実行失敗を、ユーザーの同意を得たうえで匿名で送る仕組みを検討する（コードや設定の内容は送らない）。当面は入れず、GitHub Issues への報告リンクを置く

## 9. テスト戦略

| 種類 | 内容 |
| --- | --- |
| MemFS の互換テスト | 同じテストを `node:fs` と MemFS の両方に対して実行し、挙動（エラーコード・位置管理・`O_APPEND` など）が一致することを確認する |
| プロセス内ドライバ | 標準ライブラリだけの import、ローカルパッケージ、`vendor/` 経由の標準ライブラリ、cgo・サードパーティ import のエラーを Go のテストで確認する |
| ネイティブとの一致テスト | `testdata/` の入力（txtar + 設定）を、同じバージョンのネイティブ版と WASM 版（Node 上で実行）の両方で検査し、Issue が一致することを確認する。WASM 化による差異を検出する |
| 結果の正規化 | `typecheck` の位置補正、`SuggestedFixes` のデコード、txtar の変換 |
| 非対応機能 | `unsupported.json` に載っている設定で警告が出ること、載っていない設定で警告が出ないこと |
| E2E | Playwright（Chromium・Firefox・WebKit）でエディタ入力 → Run → マーカー表示 → Share → 共有 URL 再現、キャンセル、バージョン切り替え、2 回目の訪問で Service Worker から読むこと |
| CI | GitHub Actions で上記を実行。アセットのビルドは golangci-lint のバージョンごとにキャッシュする |

## 10. 実装フェーズ

### Phase 0: PoC（完了）

- js/wasm ビルドとプロセス内ドライバ、標準ライブラリのバンドル、キャッシュの事前生成、メモリ上の fs、Web Worker、素のテキストエリアの UI、E2E（[`poc/wasm/`](../poc/wasm/README.md)）

### Phase 1: MVP

- PoC の検査エンジンを TypeScript に移植（`web/src/engine/`）、ビルドパイプラインを `wasm/` に移す
- golangci-lint の公式リリースと同じ Go のバージョンでビルドする
- CodeMirror 6 エディタ、エディタ内マーカー、結果一覧
- 単一ファイル + 自動生成 `go.mod`、標準ライブラリのみ
- 設定 YAML の自由記述（書き換えずにそのまま渡す）。空ならデフォルト設定（`standard`）で実行
- 非対応機能の洗い出し（[4.6](#46-ブラウザ内で動かない機能の扱い)）と警告表示
- キャンセル、ダウンロード進捗の表示
- URL フラグメント方式の共有
- Service Worker によるアセットのキャッシュ
- 最新版 1 バージョンのみ
- 静的ホスティングへのデプロイと CI（ビルド・ネイティブとの一致テスト・Chromium の E2E）

### Phase 2: 設定とブラウザ対応の充実

- YAML エディタの強化（JSON Schema による補完・ホバー説明・警告）
- リンター選択 GUI（コメントと順序を保ったまま YAML の一部だけを書き換える）
- 複数ファイル（txtar）のタブ表示
- サンプル集
- Firefox・Safari・モバイル端末での動作確認と対応（メモリ不足時の案内など）

### Phase 3: 機能拡張

- 複数バージョン対応、新バージョン追従の自動化
- `Fix`（`--fix`）と `Format`（`fmt`）、Quick Fix（`SuggestedFixes` の適用）
- v1 設定から v2 への移行支援（`golangci-lint migrate` をブラウザ内で実行）
- GitHub Gist からの読み込み
- 2 バージョンの結果を並べて比較

### Phase 4: 発展

- ダウンロードサイズの削減（CDN の brotli 圧縮、`wasm-opt`、標準ライブラリのバンドルを必要なパッケージだけ遅延ロードする等）
- 非対応リンターへの個別パッチ
- サードパーティモジュール対応（[11 章](#11-未解決の論点今後の検討事項)）

## 11. 未解決の論点・今後の検討事項

- **サードパーティモジュールのサポート**: golangci-lint は依存パッケージを export data から読む作りで、export data を作るにはコンパイラが要る。候補は (1) golangci-lint の依存読み込みにパッチを当て、ソースから読み込んだ依存を受け入れるようにし、モジュールの zip は CORS に対応したプロキシ経由でブラウザから取得する、(2) よく使われるモジュールの export data をビルド時に生成して配信する、(3) モジュールを使うときだけサーバーで検査する併用方式。工数とメンテナンス負荷を比較して決める
- **ブラウザ互換性とメモリ**: PoC はヘッドレス Chromium でのみ確認した。Firefox・Safari（特に iOS）で 300〜550MB の WASM メモリを確保できるか、速度に大きな差がないかを確認する
- **ダウンロードサイズ**: 約 24MB は大きい。初回訪問者への見せ方（ダウンロード前に UI だけ先に出す、など）と、削減策（Phase 4）の効果を測る
- **非対応機能の範囲**: [4.6](#46-ブラウザ内で動かない機能の扱い) の「要検証」の項目を確定させる
- **重いリンター構成**: `--default=all` ではキャッシュありでも約 7 秒かかる（Node での計測）。待ち時間の見せ方と、どこまでを許容範囲とするか
- **Go バージョンの選択**: golangci-lint のバージョンとは別に、解析対象の Go バージョン（`go.mod` の `go` 行）を選べるようにするか。標準ライブラリのバンドルが Go のバージョンごとに必要になるため、当面は「golangci-lint バージョンごとに 1 つの Go」で固定する
- **i18n**: UI 文言の日英対応

## 付録 A: WASM 方式の PoC 結果

2026-11-25 に、golangci-lint v2.5.0 を `GOOS=js GOARCH=wasm`（Go 1.24.7）でビルドして検証した。A.1〜A.4 は Node.js 22 上での検証、A.5 はブラウザでの検証。

### A.1 ビルドの可否

| ターゲット | 結果 |
| --- | --- |
| `GOOS=wasip1` | 依存ライブラリ（`termenv`、`logrus`、`viper` のファイル監視）が非対応でビルド失敗 |
| `GOOS=js` | **無改造でビルド成功**。72MB（gzip 後 15.4MB） |

### A.2 動かすための変更

無改造のバイナリは起動しバージョン表示もできるが、パッケージの読み込みで止まる。golangci-lint は `golang.org/x/tools/go/packages` を使い、その中で `go list` を子プロセスとして起動するが、js/wasm ではプロセスもパイプも作れない（`pipe: not implemented on js`）。

そこで、**golangci-lint 本体は変えず、`golang.org/x/tools` だけを `replace` ディレクティブで差し替えた**。

1. `go/packages` の `defaultDriver` に、js/wasm のときだけ使うプロセス内ドライバへのフックを追加（数行）
2. プロセス内ドライバ（約 200 行）: ユーザーのパッケージは `go/build` で解決し、標準ライブラリは事前生成したマニフェストから引く。`go list` は呼ばない
3. 標準ライブラリの export data（型情報）を事前生成して同梱。golangci-lint は依存パッケージを export data から読む作りになっているため必要。`go list -export std` が出力するアーカイブから型情報の部分（`__.PKGDEF`）だけを切り出した
4. 実行時は `--allow-parallel-runners` を付ける（ファイルロックが js/wasm では使えないため）

同梱するデータ（Node での検証時点。ブラウザ PoC での最終的なサイズは A.5 を参照）:

| データ | 生サイズ | gzip 後 |
| --- | --- | --- |
| golangci-lint（wasm） | 72MB | 15.4MB |
| 標準ライブラリの export data（336 パッケージ） | 8.7MB | 4.0MB |
| 標準ライブラリのソース（テスト・`cmd` 除く） | 29MB | 6.6MB |
| 標準ライブラリのマニフェスト（パッケージ構成・import 関係） | 129KB | — |

標準ライブラリのソースは、キャッシュがないときに依存パッケージの「facts」（`printf` チェックなどが使う解析情報）を計算するために必要になる。

### A.3 計測結果（Node）

サンプル（`errcheck`・`ineffassign`・`govet` の printf 違反・`bodyclose` 違反を含む 1 ファイル）での結果。

| 条件 | WASM（Node） | ネイティブ |
| --- | --- | --- |
| 起動のみ（`version`） | 0.7 秒 | — |
| 標準設定・キャッシュなし | 23.5 秒 | 30 秒（1 スレッド）/ 5 秒（並列） |
| 標準設定・キャッシュあり | **1.9 秒**（メモリ 332MB） | 0.3〜0.5 秒 |
| `--default=all`・初回 | 20.9 秒（メモリ 544MB） | — |
| `--default=all`・キャッシュあり | **6.7 秒**（メモリ 377MB） | 0.6 秒（メモリ 104MB） |

- 検出された Issue はネイティブと **完全に一致** した（標準設定: `errcheck`・`govet`・`ineffassign`、全リンター: `bodyclose`・`errcheck`・`forbidigo`・`ineffassign`・`revive`）
- 最初の試作では、ドライバが標準ライブラリを毎回 `go/build` で走査していて読み込みに 12.7 秒かかっていた。マニフェストを使う方式に変えて 30 ミリ秒になった
- WASM はシングルスレッドで動くため、キャッシュがないときの遅さはネイティブを 1 スレッドで動かした場合と同程度（約 1.2 倍）

### A.4 わかった制約

- `go` コマンドを内部で起動する機能は動かない: `gomoddirectives`（`go list -m`）、`gci` フォーマッタ（`go env`）、go.mod を使ったキャッシュキー計算など。警告を出して処理は続く
- golangci-lint のキャッシュの掃除処理がファイルロックを使えずエラーを出す（検査結果には影響しない）
- サードパーティモジュール: 依存パッケージを export data から読む作りのため、ブラウザ内で Go コンパイラを動かさない限り、そのままでは扱えない

### A.5 ブラウザでの検証結果

[`poc/wasm/`](../poc/wasm/README.md) で、ブラウザ内だけで動く PoC を作り、ヘッドレス Chromium（Playwright）で E2E テストを行った。

実装したもの:

- **メモリ上のファイルシステム**（`web/gofs.js`）: Go の `syscall/fs_js.go` が呼ぶ Node 互換の `fs` API（`open`・`read`・`write`・`stat`・`readdir`・`rename` など）を約 400 行で実装し、`globalThis.fs` に差し込んだ。外部ライブラリは使っていない
- **Web Worker**: Worker の中で MemFS と WASM を持ち、UI を固めない。実行ごとに新しい Go インスタンスを起動し、MemFS（＝golangci-lint のキャッシュ）は実行間で共有する
- **キャッシュの事前生成**: ブラウザと同じ MemFS・同じパスで、Node 上で WASM 版 golangci-lint を動かし、公開されている標準ライブラリ 171 パッケージを import するプログラムを検査してキャッシュを作る。gzip 後わずか 0.3MB で、**ブラウザでもそのまま有効** だった

計測結果（ローカルサーバーのため回線速度は含まない）:

| 項目 | 結果 |
| --- | --- |
| ダウンロードサイズ（gzip 後） | 約 24.4MB（WASM 15.1MB、標準ライブラリ 9.0MB、キャッシュ 0.3MB） |
| 初期化（展開・WASM コンパイル） | 約 0.8 秒 |
| 1 回目の検査 | 約 2.7〜3.2 秒（事前生成キャッシュなしでは 22.6 秒） |
| 2 回目以降の検査 | 約 0.9 秒 |
| 型エラーのみのコード | 約 0.4 秒 |

- 検出結果はネイティブと一致した（`bodyclose`・`errcheck`・`govet`・`ineffassign`）
- 自由記述した `.golangci.yml` がそのまま反映されることを確認した（`default: none` + `govet` のみ → `govet` だけが報告される）
- 型エラーは `Text` からの位置補正で正しい行・列（`main.go:4:2`）に表示された
- Go の実行終了後に残ったタイマーが発火して `Go program has already exited` を投げる問題があった。実行後に `go._scheduledTimeouts` を片付けて解消した
- 追加検証: JSON の出力先をフラグでメモリ上のファイル（`/tmp/result.json`）に向けると、ユーザーの設定で `output.formats.text.path: stdout` / `output.formats.json.path: stderr` を指定していても、結果はファイルに正しく出力された（フラグが設定より優先される）。これにより、ユーザーの YAML を書き換えずに済む

## 付録 B: サーバーサイド方式（不採用案）

当初検討したサーバーサイド方式の要点を残す。詳細は git 履歴のコミット `e74abd3` 時点の本書を参照。将来、サードパーティモジュール対応などで併用方式を取る場合の参考にする。

- **構成**: SPA → Go 製 API サーバー（入力検証・結果キャッシュ・レート制限・共有スニペット保存）→ ジョブごとの使い捨てコンテナ（gVisor / runsc）で golangci-lint を実行
- **隔離**: `--network=none`、read-only rootfs、tmpfs の作業領域、CPU / メモリ / PID / 実行時間の上限、非 root、`cap-drop=ALL`、ホストのディレクトリはマウントしない。ジョブは stdin で JSON として渡す
- **任意コード実行と同等に警戒した理由**: パーサーやリンターのバグを突く病的な入力、cgo による C コンパイラの起動、設定ファイル経由のファイル読み書き、`go.mod` の `toolchain` / `replace` によるツールチェイン取得やファイル参照
- **速度**: 標準ライブラリの解析キャッシュをコンテナイメージに焼き込んで約 0.5 秒
- **デプロイ**: gVisor を入れた VM 上の Docker、スケール時は GKE Sandbox などの gVisor RuntimeClass。Cloud Run のようにコンテナ内でコンテナを起動できない環境はサンドボックス側には使えない
- **不採用の理由**: サンドボックスの設計・運用とインフラ費用の負担が大きい。ブラウザ内 WASM 方式で実用的な速度が出ることを確認できたため
