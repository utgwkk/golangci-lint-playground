# golangci-lint playground 設計書

> 英語版は [design.md](design.md)。両方を同じ変更で更新すること。

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
- サードパーティモジュールに依存するコードの解析（標準ライブラリのみ対応する。[1.5](#15-スコープの決定事項)）
- Google Chrome（デスクトップ版）以外のブラウザでの動作確認・対応（[1.5](#15-スコープの決定事項)）
- ダウンロードサイズの削減（[1.5](#15-スコープの決定事項)）
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

### 1.5 スコープの決定事項

2026-11-25 に、以下を決定した。いずれも実装・メンテナンスの負担を抑え、まず使えるものを出すための判断。

| 項目 | 決定 | 理由 | ユーザーへの見せ方 |
| --- | --- | --- | --- |
| サードパーティモジュール | **対応しない**。import できるのは標準ライブラリと、同じモジュール内のパッケージだけ | golangci-lint は依存パッケージを export data から読む作りで、ブラウザ内で export data を作るにはコンパイラが要る。golangci-lint へのパッチ・モジュール取得用のプロキシ・サーバー併用のいずれも負担が大きい | 標準ライブラリ以外を import すると、その import 行にエラー（「package ... is not in std (only the standard library is available in the playground)」）を表示する（[4.6](#46-ブラウザ内で動かない機能の扱い)） |
| 対応ブラウザ | **Google Chrome（デスクトップ版）で動けばよい**。他のブラウザ（モバイル版を含む）は動作確認・対応をしない | PoC で Chromium での動作を確認済み。WASM のメモリ使用量（300〜550MB）や速度のブラウザ差を調べて対応するコストを避ける | Chrome 以外では「This playground is tested with Google Chrome. It may not work correctly in other browsers.」と案内を出す。実行は止めない |
| Go と golangci-lint のバージョン | **Go は最新の安定版（go1.27.4）を使い、golangci-lint もそれに対応する最新版（v2.15.0）にする** | 新しい言語機能・標準ライブラリで試せるようにするため。golangci-lint の公式リリースは古い Go でビルドされていることがあるが、パリティテストでネイティブ版（同じ Go でビルド）と一致することを確認する | ツールバーのバージョン選択に `v2.15.0（go1.27.4）` のように表示する |
| ダウンロードサイズ | **削減しない**。初回約 24MB（gzip 後）をそのまま受け入れる | 削減策（CDN の brotli 圧縮、`wasm-opt`、標準ライブラリの遅延ロード等）は効果に対して手間が大きい | ダウンロードの進捗を表示する。2 回目以降の訪問は Service Worker のキャッシュから読む |

## 2. 前提となる事実（検証済み）

golangci-lint のネイティブ版（v2.5.0・v2.15.0）と、js/wasm 版の PoC（[付録 A](#付録-a-wasm-方式の-poc-結果)）・Phase 1 の実装で確認した事実。

| 項目 | 挙動 | 設計への影響 |
| --- | --- | --- |
| js/wasm ビルド | `GOOS=js GOARCH=wasm` なら golangci-lint 本体を無改造でビルドできる（`wasip1` は依存ライブラリが非対応で失敗） | ターゲットは `js/wasm`。Go 公式の `wasm_exec.js` を使う |
| パッケージ読み込み | `go/packages` が `go list` を子プロセスとして起動するが、js/wasm ではプロセスを作れない | `golang.org/x/tools` に小さなパッチを当て、プロセス内で読み込むドライバに差し替える（golangci-lint 本体は無改造） |
| 依存パッケージの型情報 | golangci-lint は依存パッケージを export data（コンパイラが出力する型情報）から読む | 標準ライブラリの export data をビルド時に生成して同梱する |
| ファイル操作 | `wasm_exec.js` はブラウザではファイル操作を未実装にしている | Node 互換の `fs` API をメモリ上で実装し、`globalThis.fs` に差し込む |
| 解析キャッシュ | キャッシュなしの 1 回目は約 22 秒。標準ライブラリ全体の解析キャッシュは gzip 後 0.3MB で、ブラウザと同じパス構成で事前生成すればそのまま有効 | キャッシュをビルド時に生成して同梱する |
| JSON 出力 | `--output.json.path <path>` で `{"Issues": [...], "Report": {...}}` が得られる。フラグは設定ファイルの `output.*` より優先される | JSON はメモリ上のファイル（例: `/tmp/report.json`）に書かせて読む。ユーザーの YAML は書き換えない |
| Issue の形 | `FromLinter`, `Text`, `Severity`, `SourceLines`, `Pos{Filename,Offset,Line,Column}`, 自動修正可能なものは `SuggestedFixes[].TextEdits[]{Pos,End,NewText}`（`NewText` は base64） | エディタ上のマーカーやクイックフィックスに直接使える |
| 型エラー | `FromLinter: "typecheck"` として返り、`Pos` は `Line:1, Column:0` 固定、実際の位置は `Text` 内の `./main.go:11:2: ...` に埋め込まれる | `Text` を正規表現で再パースして位置を補正する（PoC で実装済み） |
| 終了コード | 指摘ありは 1。ブラウザ内では `go` コマンドの起動失敗などをログに出すため 7（エラーをログ出力）になることが多い | 終了コードには依存せず、JSON を正とする |
| リンター一覧 | `golangci-lint help linters --json` で `name, description, groups, fast, autoFix, deprecated, since, originalURL` が得られる | バージョンごとにビルド時に書き出し、リンター選択 UI に使う |
| 設定の JSON Schema | golangci-lint のモジュールに `jsonschema/golangci.jsonschema.json` が同梱されている（`config verify` はネットワーク越しに取りに行くので使わない） | ビルド時にモジュールから取り出して同梱する |
| フォーマッタ | v2 では `formatters` セクションに分離。`golangci-lint fmt` でファイルを整形できる | 「Format」機能は `fmt` サブコマンドで実装する。ただし `gci` はブラウザ内で動かない |
| `go` コマンドへの依存 | x/tools の `imports` パッケージ（`goimports`・`gci`・`swaggo` が使う）は `go env` を起動しようとして失敗し、**検査全体が止まる**。`gomoddirectives` は `go list -m` を起動できず無視される | x/tools にもう 1 つパッチを当て、`go env` の代わりに環境変数から値を返す（`goimports`・`gci`・`swaggo` は動くようになった）。残りは非対応として UI で警告する（[4.6](#46-ブラウザ内で動かない機能の扱い)） |
| Go バージョン | golangci-lint をビルドした Go と、同梱する標準ライブラリの Go は一致している必要がある | バージョンごとに「golangci-lint ＋ Go ツールチェイン」の組を固定してビルドする |
| Go と golangci-lint の組み合わせ | 型情報（export data）の形式は Go のバージョンで変わる。golangci-lint v2.5.0（x/tools v0.37.0）は Go 1.27 の形式（バージョン 5）を読めず、ネイティブ版でも `fmt` すら import できない | Go を上げるときは、その Go に対応した golangci-lint（現在は v2.15.0、x/tools v0.52.0）も一緒に上げる |
| 配信時の圧縮 | 多くの静的サーバーは `*.gz` に `Content-Encoding: gzip` を付けるため、ブラウザが自動で展開してしまい、チェックサムが合わなくなる（`vite preview` で発生） | gzip 済みアセットの拡張子は `.bin` にする |

## 3. 全体アーキテクチャ

```
┌──────────────────────── 静的ホスティング (CDN) ────────────────────────┐
│  /index.html, /assets/*            アプリ本体（Vite でビルド）          │
│  /versions.json                    利用可能な golangci-lint バージョン  │
│  /v/{version}/                     バージョンごとのアセット（ハッシュ付き URL）│
│     golangci-lint.wasm.bin         js/wasm 版 golangci-lint             │
│     std.bundle.bin                 標準ライブラリ（ソース・型情報・構成）│
│     cache.bundle.bin               事前生成した解析キャッシュ           │
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
| 対応できない機能 | `go` コマンドを内部で起動するリンター（`gomoddirectives` など）。サードパーティモジュールの対応は難しい | 制約なし |
| メンテナンス | golangci-lint の新バージョンごとに、`golang.org/x/tools` の小さなパッチを当てて再ビルドする | 公式バイナリを使うだけ |

**決定（2026-11-25）: ブラウザ内 WASM 方式（A）を採用する。** ブラウザで動く PoC（git 履歴のコミット `bf8c696` 時点の `poc/wasm/`） で、実用的な速度で動作することを確認した（[付録 A.5](#a5-ブラウザでの検証結果)）。サーバーサイド方式の検討内容は [付録 B](#付録-b-サーバーサイド方式不採用案) に要約を残す。

## 4. コンポーネント詳細

### 4.1 フロントエンド（UI）

- **技術**: TypeScript + Vite、エディタは **CodeMirror 6**
  - Monaco より軽量で、`@codemirror/lint` で診断表示、`@codemirror/lang-go` / `@codemirror/lang-yaml` が使える
  - UI フレームワークは小さく保つ（Preact もしくは素の TS）
- **画面構成**
  - ヘッダ: `Run`（Ctrl/Cmd+Enter）、`Format`（Shift+Alt+F）、`Fix`、`Cancel`（実行中のみ）、`Share`、バージョン選択、サンプル選択
    - **`Fix`**: `golangci-lint run --fix` で、自動修正できる指摘をまとめて直す（ユーザーの `.golangci.yml` を使う。フォーマッタの修正も含む）。変わったファイルだけを最小限の差分で書き換えるので、元に戻せる。直せずに残った指摘を結果として表示する
    - **`Format`**: すべての Go ファイルを goimports で整形し、足りない import を追加・使っていない import を削除する（`golangci-lint fmt --no-config -E goimports`）。ユーザーの `.golangci.yml` は読まない。設定にほかのフォーマッタ（gofumpt など）があっても混ぜず、結果を goimports だけで決めるため。足りない import は x/tools のパッチ（[4.3](#43-ビルドパイプライン)）により `$GOROOT/src` から探す。変わったファイルだけを最小限の差分で書き換えるので、元に戻す（Undo）ができる。構文エラーで整形できなかったファイルは、そのファイル名を表示する
  - 左: Go コードエディタ（ファイルタブ。`+` で `go.mod` や追加ファイルを作成、ダブルクリックで名前を変更、`×` で削除。タブには指摘の件数を出す）。ファイルごとに CodeMirror の `EditorState` を持つので、元に戻す履歴やマーカーはファイルごとに保たれる（`ui/files.ts`）
  - 右上: 設定パネル（[1.4](#14-要件設定ファイル-yaml-の自由記述) の要件に対応）
    - **YAML エディタ（正本）**: `.golangci.yml` を自由記述する。`@codemirror/lang-yaml` によるハイライトに加えて、バージョンごとの JSON Schema（`schema.json`）を使った支援をする（`web/src/config/`）
      - **キー・値の補完**: カーソル位置の YAML のパス（`linters.settings.govet` など）を、入力途中で壊れた YAML でも扱えるようにインデントから求め（`yamlpath.ts`）、そこで書けるキーや値（列挙値・真偽値・リンター名など）を候補に出す。値がオブジェクトのキーは改行して一段下げ、配列のキーは `- ` まで入れる
      - **ホバー**: キーにはスキーマの説明を、リンター名・フォーマッタ名には `linters.json` / `formatters.json` の説明を出す
      - **警告**: スキーマに反する記述（不明なキー、型・列挙値・パターンの違反など）を、「Did you mean …?」の候補付きで警告する。警告だけで実行は止めない（最終的な判断は golangci-lint に任せる）
      - スキーマの検証は自前の小さなインタプリタ（`schema.ts`）で行う。ajv などのコードを生成する検証器は CSP（`unsafe-eval` を許可していない）の下では動かないため。golangci-lint のスキーマが使うキーワード（`$ref`・`properties`・`patternProperties`・`additionalProperties`・`items`・`enum`・`anyOf`・`required`・`pattern`・`minimum`・`uniqueItems` など）だけを実装している
      - スキーマのリンター名（`linter-names`）は、カスタムリンターのために「既知の名前の列挙または任意の文字列」になっていて、打ち間違いを検出できない。playground ではプラグインを読み込めず、不明な名前は実行時に必ずエラーになるので、`linters.enable` / `linters.disable` / 除外ルールの `linters` に書かれた名前はリンター一覧と照らし合わせて警告する
    - **GUI（補助）**: 「Choose linters」ダイアログ（`ui/toolspanel.ts`）。リンターとフォーマッタの一覧（`linters.json` / `formatters.json` から生成。検索・有効なものだけ表示・`standard` / `fast` / `autofix` / `deprecated` / ブラウザ非対応のバッジ・説明・元リポジトリへのリンク）と `linters.default` の選択がある。操作すると、YAML の `linters.enable` / `linters.disable` / `linters.default` / `formatters.enable` だけを書き換える。ダイアログを開くたびに YAML から状態を読み直す
    - YAML の部分書き換えは、構文木から該当箇所の位置を求めてテキストを最小限に差し替える（`yamledit.ts`）。YAML ライブラリでドキュメント全体を書き戻すと、引用符・インデント・空行などがユーザーの書き方から変わってしまうため。ブロック形式とフロー形式の配列、キーの新規作成（親を含む）、空になった配列と親の削除に対応する
    - 非対応の設定（[4.6](#46-ブラウザ内で動かない機能の扱い)）や設定エラーは、YAML エディタの該当行にマーカーで表示する
    - 「Reset to default」ボタンを用意する
  - ツールバーの右端の `Licenses` ボタンで、ライセンスとソースコードのダイアログを開く（[12 章](#12-ライセンス)）
  - 右下 / 下部: 結果パネル
    - Issue 一覧（リンター名・メッセージ・位置）。クリックで該当行へジャンプ
    - エディタ内に波線マーカー、ホバーでメッセージ
    - **Quick Fix**: `SuggestedFixes` がある指摘には、結果一覧と、エディタの指摘のポップアップに「Fix」ボタンを出す。修正案の編集は UTF-8 のバイト位置なので、検査したときの内容に対してバイト単位で当て（`fixes.ts`）、当てたあとは自動で検査し直す。検査のあとにコードを編集していたら位置がずれるので、適用せずにもう一度実行するよう案内する
    - 実行時間、golangci-lint のログ（stderr、折りたたみ）
- **初回ロードの表示**: 約 24MB のダウンロード中は進捗（MB / 全体）を表示する。ダウンロード中もエディタは使える。2 回目以降の訪問では Service Worker のキャッシュから読むので待ち時間はほぼない
- **対象外ブラウザでの案内**: Google Chrome 以外のブラウザでは「This playground is tested with Google Chrome. It may not work correctly in other browsers.」と案内を出す（[1.5](#15-スコープの決定事項)）。実行は止めない
- **状態の永続化**: 編集中の内容は `localStorage` に自動保存（try/catch でラップ）
- **サンプル集**: ツールバーから選ぶ。`web/examples/*.txtar` に、1 行目をタイトル、続く行を説明、`.golangci.yml` を設定として置く（基本、リンターの設定と除外、フォーマッタ、複数パッケージ、nolint、modernize、スタイル）。編集中の内容を置き換えるときは確認する。サンプルはパリティテストの対象にも含め、ネイティブ版と同じ指摘を出すことを保証する
- **複数ファイルの表現**: Go Playground と同じ [txtar](https://pkg.go.dev/golang.org/x/tools/txtar) 形式を、共有 URL と下書きの保存形式に使う（main.go だけなら txtar にせずそのまま。Phase 1 の共有 URL もそのまま開ける）。エディタ上はタブで表示する

  ```
  -- go.mod --
  module playground

  go 1.27
  -- main.go --
  package main
  ...
  ```

### 4.2 検査エンジン（Web Worker）

`web/src/engine/` に実装している（PoC から TypeScript に移植）。メインスレッド側の `client.ts` がアセットの取得・検証・WASM のコンパイルと Worker の管理を、Worker 側の `worker.ts` が MemFS（`gofs.ts`）と golangci-lint の実行（`runner.ts`）を受け持つ。`runner.ts` 以下は Node.js でもそのまま動き、キャッシュ生成とパリティテストに使う。

#### メッセージプロトコル

| 方向 | メッセージ | 内容 |
| --- | --- | --- |
| UI → Worker | `init` | `{ module, wasmExecUrl, std, cache, goVersion }`。ダウンロード・チェックサム検証・WASM のコンパイルはメインスレッドで済ませ、コンパイル済みのモジュールとバンドルを渡す。Worker はバンドルを MemFS に展開する |
| UI → Worker | `lint` | `{ id, files: { name: content } }`。`.golangci.yml` も `files` に含める。検査を実行する |
| UI → Worker | `format` | `{ id, files }`。goimports で整形し（`FORMAT_ARGS`）、整形後のファイルを `formatted`（`{ id, files, log, exitCode, ms }`）で返す |
| UI → Worker | `fix` | `lint` と同じ入力。`--fix` 付きで実行し（`FIX_ARGS`）、修正後のファイルと残った指摘を `fixed`（`{ id, issues, files, log, exitCode, ms }`）で返す |
| UI → Worker | `migrate` | （Phase 3）`{ id, config }`。`golangci-lint migrate` で v1 設定を v2 に変換する |
| Worker → UI | `ready` | 初期化完了 |
| Worker → UI | `result` | `{ id, issues, files?, log, exitCode, ms }` |
| Worker → UI | `error` | `{ id?, code, message }` |

#### 実行の流れ

1. `/work` を空にし、ユーザーのファイルと `.golangci.yml`（ユーザーの YAML そのまま）を書き込む。`go.mod` がなければ `module playground` とバンドルした Go のバージョンで補う
2. 新しい Go インスタンスを作り、以下の引数・環境変数で golangci-lint を起動する
   - 引数: `run --allow-parallel-runners --output.json.path /tmp/report.json --show-stats=false ./...`
   - 環境変数: `GOROOT=/goroot`、`GOOS=linux`、`GOARCH=amd64`、`CGO_ENABLED=0`、`GOTOOLCHAIN=local`、`GOLANGCI_LINT_CACHE=/cache/golangci-lint`、`WASM_STD_MANIFEST`、`WASM_EXPORT_DIR`、`HOME`
3. 終了後、`/tmp/report.json` を読んで正規化する（JSON がなければ stdout / stderr をエラーとして返す）。ユーザーの設定で stdout / stderr に出力された内容はログとして返す
4. Go ランタイムが残したタイマー（`go._scheduledTimeouts`）を片付ける（残すと `Go program has already exited` が投げられる）
5. ログ（stdout / stderr）から、ブラウザで動かしていることによる無害なメッセージ（`go env` の起動失敗、ファイルロックの失敗など）を取り除いてから UI に返す

MemFS には `/dev/null`（書き込みは捨て、読み込みは EOF）を用意している。ないと golangci-lint が毎回警告を出す。

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

golangci-lint のバージョンごとに、以下のアセットを `wasm/dist/v/<version>/` に生成する。`scripts/build-assets.sh` が全体を実行する（手順 1〜3・5 は `wasm/build.sh`、手順 4 と `versions.json` は `web/scripts/` の Node.js スクリプト）。

| 手順 | 内容 | 出力 |
| --- | --- | --- |
| 1. x/tools のパッチ | golangci-lint の `go.mod` が要求する `golang.org/x/tools` をモジュールキャッシュからコピーし、`wasm/xtools/patches/` のパッチを当てて `wasm/xtools/overlay/` のファイルを追加する。パッチは 2 つ: (a) `go/packages` の `defaultDriver` からプロセス内ドライバ（`inproc_js.go`、import 位置付きのエラーも返す）を呼ぶフック、(b) `internal/imports` の `ProcessEnv.init` で `go env` の代わりに値を返すフック（`goenv_js.go`。GOPATH モードで `$GOROOT/src` を探すので `go` コマンドは不要）。手順 2 のソース一式の `go.mod` に `replace` を書いて差し替える | — |
| 2. WASM ビルド | 全モジュールを（パッチを当てた x/tools を含めて）vendor したソース一式を作り、そこからネットワークを使わずにビルドする: `GOOS=js GOARCH=wasm GOFLAGS=-mod=vendor go build -trimpath -ldflags='-s -w'` | `golangci-lint.wasm.bin`（gzip、約 15MB） |
| 3. 標準ライブラリ | `go list -export -json std`（`CGO_ENABLED=0 GOOS=linux GOARCH=amd64`）から、ソース・export data（`__.PKGDEF` のみ）・パッケージ構成のマニフェストを 1 ファイルにまとめる | `std.bundle.bin`（gzip、約 9.4MB） |
| 4. キャッシュ | ブラウザと同じ MemFS・同じパスで、Node 上で WASM 版を動かし、公開されている標準ライブラリを全部 import するプログラムを標準設定と `--default=all` で検査する | `cache.bundle.bin`（gzip、約 0.3MB） |
| 5. メタデータ | 同じバージョンのネイティブ版（手順 2 と同時にビルドし、パリティテストにも使う）で `help linters --json` / `help formatters --json` を実行。モジュール内の `jsonschema/golangci.jsonschema.json` を取り出す | `linters.json`、`formatters.json`、`schema.json`、`build.json`（バージョンと Go のバージョン） |
| 6. ソースとライセンス | 手順 2 のビルド元の vendor したソース一式をアーカイブにし（`golangci-lint-source.tar.gz`）、バイナリにリンクされる全モジュールのライセンスを書き出す（`wasm/tools/mknotices`。[12 章](#12-ライセンス)） | `golangci-lint-source.tar.gz`、`licenses.txt` |
| 7. マニフェスト | 各アセットのサイズと SHA-256 を書き出す | `versions.json` |
| 8. 検証 | テストスイート（[9 章](#9-テスト戦略)）を実行する | — |

- **Go ツールチェインの固定**: Go の最新の安定版（現在は go1.27.4）でビルドし、手順 3 の標準ライブラリも同じ Go から作る（[1.5](#15-スコープの決定事項)。当初は golangci-lint の公式リリースと同じ Go にする方針だった）。`wasm/go.mod` の `toolchain` 行で指定し、`wasm/build.sh` が `GOTOOLCHAIN` で強制する。golangci-lint はその Go に対応したバージョンが必要（[2 章](#2-前提となる事実検証済み)）。Go や golangci-lint を上げたときは、パリティテストでネイティブ版（同じ Go でビルド）と結果が一致すること、[4.6](#46-ブラウザ内で動かない機能の扱い) の非対応一覧が変わっていないことを確認する
- **パッチの追従**: x/tools のパッチは `defaultDriver` の冒頭に数行足すだけなので、x/tools が更新されても当たり続ける見込みが高い。当たらなくなったらビルドが失敗するので、CI で気づける
- **拡張子 `.bin`**: gzip 済みのアセットは `.gz` ではなく `.bin` で配信する。`.gz` だと多くの静的サーバーが `Content-Encoding: gzip` を付け、ブラウザが展開してしまうため（[2 章](#2-前提となる事実検証済み)）
- **URL に中身のハッシュを付ける**: `/v/{version}/` 以下のファイルは、同じバージョンのままでも作り直されることがある（ビルドに関わるファイルが変わると CI がアセットを作り直す。解析キャッシュにはタイムスタンプが入るので、作り直すたびにバイト列が変わる）。当初は「一度公開したら変えない」前提だったが、守られず、Service Worker が古いファイルを返してチェックサムが合わなくなる不具合が起きた。そこで `versions.json` にバージョンのディレクトリの全ファイルのサイズと SHA-256 を書き、画面はファイルを `cache.bundle.bin?v=<SHA-256 の先頭 16 文字>` のように中身のハッシュ付きの URL で取得する（`assetUrl`）。中身が変われば URL も変わるので、ブラウザや Service Worker のキャッシュが古いファイルを返すことはない

### 4.4 共有機能

サーバーを持たないため、**URL フラグメント方式** を基本にする。

- スナップショットを JSON にし、`CompressionStream('deflate-raw')` で圧縮して base64url 化し、`/#s=...` に入れる。フラグメントはサーバーに送られないので、共有内容がアクセスログにも残らない
- 共有 URL を開いたときは、内容を読み込むだけで **自動では実行しない**（`Run` を押して実行する）
- URL が長すぎる場合（例: 8,000 文字超）は警告し、後述の Gist 連携を案内する

スナップショット形式（バージョン付きで将来の拡張に備える）:

```json
{
  "schema": 1,
  "version": "v2.15.0",
  "files": "-- go.mod --\n...\n-- main.go --\n...",
  "config": "version: \"2\"\n..."
}
```

将来の拡張（Phase 3）: **GitHub Gist からの読み込み**（`/#gist=<id>`）。GitHub API は CORS に対応しているので、サーバーなしで実装できる。Gist 内の `.go` ファイル・`go.mod`・`.golangci.yml` を読み込む。

### 4.5 バージョン管理

- `/versions.json` に、公開しているバージョンの一覧・既定のバージョン・各バージョンの Go バージョンとアセットのサイズを書く
- 選択されたバージョンのアセットだけを取得する（バージョンを切り替えると、そのバージョンの約 24MB を新たに取得する）
- 新バージョンのリリースを定期ジョブ（GitHub Actions の schedule）で検知し、ビルド → テスト → デプロイ → `versions.json` 更新を行う PR を自動作成する
  - バージョンが 1 つの現状では、`wasm/go.mod` の golangci-lint を上げる PR を Dependabot が作る（[7 章](#7-デプロイ構成)）。CI がアセットを作り直し、x/tools のパッチが当たること、ネイティブ版と結果が一致すること、新しい依存のライセンスが両立することを確かめる（[12 章](#12-ライセンス)）
- 保持するのは直近 N 個（例: 5）のマイナーバージョンの最新パッチ程度にする。共有 URL のバージョンが廃止済みなら、最も近いバージョンで開いて警告を表示する

### 4.6 ブラウザ内で動かない機能の扱い

ブラウザ内では `go` コマンドを起動できない。Phase 1 で、`go` コマンドを使うコードを持つリンター・フォーマッタを 1 つずつ WASM 版で動かして確認した（v2.5.0 で確認し、v2.15.0 に上げたときに再確認した）。

| 機能 | 結果 | 扱い |
| --- | --- | --- |
| `goimports`・`swaggo`・`gci` フォーマッタ | パッチ前は x/tools の `imports` パッケージが `go env` を起動しようとして失敗し、**検査全体が止まっていた**。x/tools のパッチ（[4.3](#43-ビルドパイプライン)）で動くようになり、ネイティブと同じ結果になる（`gci` の `localmodule` セクションを含む） | 対応 |
| `depguard`（`$gostd` 変数）・`gosec`・`unconvert`・`goheader`（`template-path`） | 動作し、ネイティブと同じ結果 | 対応 |
| `gomoddirectives` | `go list -m` を起動できず、警告をログに出して無視される | 非対応。設定で有効にされていたら警告マーカーを出す |
| `gomodguard`・`gomodguard_v2` | エラーは出ないが、モジュールの依存関係を調べるリンターなので、標準ライブラリだけの playground では何も検出しない | 非対応。同上 |
| gocritic の ruleguard | ルールファイルが `github.com/quasilyte/go-ruleguard/dsl` を import するため読み込めず、「empty rule set」という指摘が出る | 非対応。`linters.settings.gocritic.settings.ruleguard` に警告マーカーを出す |
| `linters.settings.custom`（プラグイン） | ブラウザ内ではロードできない | 非対応。警告マーカーを出す |
| `linters.default: all` | 上の非対応リンターも有効になる | `default: all` の行に、動かないリンターの一覧を案内として出す（`linters.disable` に入れると消える） |
| 標準ライブラリ以外の import（サードパーティモジュール） | 対応しない（[1.5](#15-スコープの決定事項)）。プロセス内ドライバが import 位置付きのエラーを返し、`typecheck` として報告される | 結果一覧とエディタの該当 import 行に「package ... is not in std」と表示する |
| golangci-lint 内部の `go env` 呼び出し（go.mod を使ったキャッシュキー計算など）、キャッシュのファイルロック | 警告・エラーをログに出して処理を続ける。検査結果には影響しない | ログから取り除いて表示する |

- 非対応の判定は `web/src/config/unsupported.ts` にまとめ、YAML エディタの警告（CodeMirror の lint）と単体テストで共有する
- 設定ファイルは書き換えず、警告を出すだけにする（[1.4](#14-要件設定ファイル-yaml-の自由記述)）

## 5. セキュリティ・プライバシー

コードの検査はすべてユーザー自身のブラウザ内で行われるため、サーバーサイド方式で必要だったサンドボックス・レート制限・DoS 対策は不要になる。残る論点は以下。

| 脅威・論点 | 対策 |
| --- | --- |
| XSS（共有 URL に仕込まれた内容） | 共有 URL の内容は信頼しない。Issue メッセージ・ファイル名などはすべてテキストとしてレンダリングする（`innerHTML` 禁止）。CSP を設定する（`script-src 'self' 'wasm-unsafe-eval'`、`connect-src 'self'`、`worker-src 'self'` など。開発サーバーと両立させるため、本番ビルドの HTML にだけ注入する。Phase 3 の Gist 連携で `connect-src` に `https://api.github.com` を足す） |
| 重い共有 URL によるブラウザの占有 | 共有 URL は自動実行しない。検査は Worker で動くので UI は固まらず、`Cancel` で止められる |
| サプライチェーン（ビルドに使うコード） | golangci-lint と依存は `go.sum` で固定し、CI でソースからビルドする。x/tools のパッチはリポジトリで管理しレビューする。フロントエンドの依存は lockfile で固定する |
| 配信アセットの改ざん | 同一オリジンから配信し、HTTPS のみとする。`versions.json` に各アセットの SHA-256 を書き、ダウンロード後にメインスレッドで検証する |
| プライバシー | コードはサーバーに送られない。共有内容は URL フラグメントに入るので、ホスティング側のログにも残らない。アクセス解析を入れる場合は Cookie を使わないものにする |

## 6. ディレクトリ構成

```
.
├── wasm/                          # WASM 版 golangci-lint のビルドパイプライン
│   ├── go.mod                     # golangci-lint のバージョンと Go ツールチェインを固定
│   ├── build.sh                   # WASM・標準ライブラリのバンドル・メタデータ → dist/v/<version>/
│   ├── xtools/
│   │   ├── patches/               # golang.org/x/tools へのパッチ
│   │   └── overlay/               # x/tools に追加するファイル（inproc_js.go, goenv_js.go）
│   └── tools/
│       ├── mkbundle/              # 標準ライブラリのバンドル生成
│       └── mknotices/             # WASM 版の licenses.txt の生成（ライセンスの確認も行う）
├── web/                           # Web アプリ（Vite + TypeScript + CodeMirror 6）
│   ├── index.html
│   ├── src/
│   │   ├── main.ts                # 画面の組み立て
│   │   ├── engine/                # 検査エンジン（Web Worker、Node.js でも動く）
│   │   ├── ui/                    # エディタ、ファイルタブ、リンター選択ダイアログ、結果一覧、位置の変換
│   │   ├── config/                # 設定の支援: スキーマ（補完・ホバー・警告）、YAML の部分書き換え、非対応設定の検出
│   │   ├── share.ts, txtar.ts, samples.ts
│   │   └── sw.ts                  # Service Worker
│   ├── examples/                  # サンプル集（txtar）
│   ├── scripts/                   # キャッシュ生成、versions.json、パリティテスト、Web アプリの licenses.txt、README のスクリーンショット（Node.js）
│   ├── test/                      # 単体テスト（Vitest）
│   └── e2e/                       # E2E テスト（Playwright）
├── scripts/
│   ├── build-assets.sh            # アセット一式のビルド
│   └── check-design-sync.mjs      # design.md と design.ja.md の章立てが同じか確かめる
├── testdata/parity/               # パリティテストのケース（txtar）
├── .github/workflows/ci.yml       # テスト・GitHub Pages へのデプロイ
├── CLAUDE.md                      # 開発者・コーディングエージェント向けの決まり（英語で書くことなど）
├── .claude/skills/                # Agent Skills（README のスクリーンショットの撮り直しなど）
└── docs/design.md, design.ja.md   # 本書（英語版・日本語版）
```

`vite.config.ts` の `publicDir` が `wasm/dist` を指すので、ビルドしたアセットはそのまま Web アプリと一緒に配信される。

## 7. デプロイ構成

- **ホスティング**: GitHub Pages（GitHub Actions からデプロイ）。サーバーサイドの処理はない
  - `main` ブランチへの push で、CI（[9 章](#9-テスト戦略)）が通ったら `web/dist` をデプロイする（`.github/workflows/ci.yml`）。リポジトリの Settings → Pages で Source を「GitHub Actions」にする
  - Vite の `base` を `./` にしているので、`https://<user>.github.io/<repo>/` のようなサブパスでも動く
  - 帯域: 新規訪問者 1 人あたり約 25MB。GitHub Pages は月 100GB の目安があるため、利用が増えたら帯域の制限がない静的ホスティング（Cloudflare Pages など。1 ファイル 25MiB の上限内に収まる）に移す
- **キャッシュ**: GitHub Pages ではキャッシュヘッダを指定できない。そのため Service Worker（`sw.ts`）が `/v/` 以下を Cache API に保存し、2 回目以降の訪問ではネットワークに取りに行かない。`versions.json` と画面は通常どおりネットワークから取る
  - ハッシュ付きの URL（`?v=`、[4.3](#43-ビルドパイプライン)）はキャッシュを優先する。新しいハッシュのファイルを保存したら、同じファイルの古いハッシュのものは消す
  - ハッシュの無い URL（ハッシュ付き URL を導入する前の画面からのリクエスト）はネットワークを優先し、オフラインのときだけキャッシュを使う。Service Worker の更新時には、ハッシュの無い古いキャッシュを消す
  - それでもチェックサムが合わないとき（CDN が前回のデプロイのファイルを返している場合など）は、キャッシュを通さずに（`cache: 'reload'`）1 回だけ取り直す
- **圧縮**: アセットは自前で gzip 済みのファイル（`.bin`）として配信し、メインスレッドで展開する。ホスティング側の圧縮設定に依存しない。それ以上のサイズ削減は行わない（[1.5](#15-スコープの決定事項)）
- **CI のジョブ構成**: 実行時間が直列に伸びないよう、依存関係のないジョブは並列に走らせる。アセットは artifact でジョブ間に受け渡す

  ```
  typecheck ───────────────┐
  unit ────────────────────┤
  assets ─┬─ parity ───────┼─ CI success ─ deploy（main のみ）
          └─ e2e ──────────┘
  ```

  - `assets` ジョブの中でも、独立した処理は並列に動かす。WASM ビルド・ネイティブ版のビルド・標準ライブラリのバンドルは同時に実行し（`wasm/build.sh`）、キャッシュ生成は標準設定と全リンターの 2 パスを別プロセスで同時に実行して結果をマージする（`web/scripts/seed-cache.ts`。キャッシュは内容アドレスのファイルなので、和集合をとればよい）。4 コアの環境で、Go のビルドキャッシュがない状態から約 220 秒 → 約 175 秒
  - アセットのビルドに関わるファイルのハッシュをキーに `actions/cache` で保存し、変わっていなければビルドを省く
  - **`CI success` ジョブ**: デプロイに必要なすべてのジョブが成功したときだけ成功する、まとめ役のジョブ。`main` のブランチ ruleset の必須チェックと auto-merge には、これだけを指定する（ジョブ構成を変えても ruleset を直さずに済む）。必須チェックでは「スキップされたジョブ」が成功扱いになるため、上流のジョブが失敗しても `CI success` 自体は必ず実行し（`if: !cancelled()`）、すべての結果が `success` であることを確かめる。`deploy` もこのジョブだけに依存する
  - ジョブを Go のビルドごとに別ランナーへ分ける案は採らなかった。Go のビルドキャッシュ（`setup-go` のキャッシュキーは共通）がジョブ間で取り合いになり、artifact の受け渡しも増えるため、短縮幅が小さい
- **依存の更新**: Dependabot（`.github/dependabot.yml`）が週に 1 回、golangci-lint（`wasm/go.mod`）・npm パッケージ（`web/`）・GitHub Actions（コミット SHA で固定）を更新する PR を作る。リリースから 7 日たったバージョンだけを提案する（クールダウン）。壊れたリリースや乗っ取られたリリースは、それまでに気づかれて取り下げられる見込みが高いため。セキュリティアップデートは遅らせない。CodeMirror のパッケージは状態（`@codemirror/state` など）を共有するので一緒に更新し、開発ツールのマイナー・パッチ更新と Actions もそれぞれまとめる。ほかの Go モジュールは golangci-lint が要求するバージョンに従うので、単独では更新しない。PR では CI 全体が走り、マージは手動で行う
- **設計書の同期**: `unit` ジョブで `scripts/check-design-sync.mjs` を実行し、`docs/design.md` と `docs/design.ja.md` の見出しの構成（レベルと章番号）が違えば失敗させる

## 8. 可観測性

サーバーがないため、取れる情報は限られる。

- アクセス解析（任意）: Cookie を使わない軽量な解析で、訪問数・利用バージョン程度を見る
- エラー報告（任意）: Worker の初期化失敗・実行失敗を、ユーザーの同意を得たうえで匿名で送る仕組みを検討する（コードや設定の内容は送らない）。当面は入れず、GitHub Issues への報告リンクを置く

## 9. テスト戦略

| 種類 | 内容 | 実行 |
| --- | --- | --- |
| MemFS の互換テスト | 同じ操作を MemFS と `node:fs`（一時ディレクトリ）の両方に実行し、結果とエラーコード（`ENOENT`・`EEXIST`・`EISDIR`・`ENOTDIR`・`ENOTEMPTY`・`EBADF` など）が一致することを確認する | `npm test`（`web/test/gofs.test.ts`） |
| 単体テスト | 結果の正規化（`typecheck` の位置補正、`SuggestedFixes` のデコード、ログの整理）、txtar、共有 URL の往復、UTF-8 の列位置の変換、非対応設定の検出、スキーマのたどり方と検証（テスト用の小さなスキーマで）、カーソル位置の YAML パスの判定、YAML の部分書き換え（コメント・書式が保たれること）、リンターの有効/無効の判定と切り替え、バンドルされたモジュールが属する npm パッケージの判定（`licenses.txt` 用） | `npm test` |
| ネイティブとの一致テスト | `testdata/parity/*.txtar` と `web/examples/*.txtar`（サンプル集）を、同じバージョンのネイティブ版と WASM 版（Node.js 上）で検査し、Issue（自動修正の内容を含む）が完全に一致することを確認する。各ケースは `--fix` 付きでも実行し、修正後のファイルと残った指摘も一致することを確認する。標準設定、全リンター＋全フォーマッタ、型エラー、複数パッケージ、フォーマッタ、設定の自由記述、nolint、gci の localmodule、自動修正（マルチバイト文字の後ろの修正を含む）の 9 ケースと、サンプル 7 つ | `npm run parity` |
| E2E | Playwright（Chromium）で、サンプルの検査とエディタのマーカー、Issue クリックでの移動、自由記述した設定（`output.*` を含む）の反映、非対応設定の警告、標準ライブラリ以外の import のエラー位置、ファイルタブ（追加・名前の変更・削除、別ファイルの指摘への移動）、不正な設定のエラー表示、共有 URL（複数ファイル、自動実行しないこと）、キャンセル、Service Worker のキャッシュ（再デプロイで作り直されたアセットを、強制再読み込みなしで取り直せること）、リンター選択ダイアログ（YAML の部分書き換え）、スキーマによる補完・警告・ホバー、サンプル集、goimports による整形（足りない import の追加、全タブ、元に戻す、ショートカット、構文エラーのファイル）、`Fix` によるまとめての修正（元に戻す）、Quick Fix（結果一覧とエディタのポップアップから適用、再検査、検査後に編集したときは適用しないこと）、ライセンスのダイアログ（ライセンスとソースアーカイブを取得できること）の 21 シナリオ（カーソル行の選択の見え方をライト・ダークで確かめる 2 件を含む） | `npm run e2e` |
| 設計書の同期 | `docs/design.md` と `docs/design.ja.md` の見出し（レベルと章番号）が一致すること | `node scripts/check-design-sync.mjs` |
| CI | GitHub Actions で、型チェック・単体テスト・アセットのビルドを並列に、アセットができたらパリティテストと E2E を並列に実行する（[7 章](#7-デプロイ構成)） | `.github/workflows/ci.yml` |

プロセス内ドライバ（Go）の単体テストはまだない。挙動はパリティテスト（複数パッケージ・型エラー）と E2E（標準ライブラリ以外の import）で確認している。

## 10. 実装フェーズ

### Phase 0: PoC（完了）

- js/wasm ビルドとプロセス内ドライバ、標準ライブラリのバンドル、キャッシュの事前生成、メモリ上の fs、Web Worker、素のテキストエリアの UI、E2E（PoC（git 履歴のコミット `bf8c696` 時点の `poc/wasm/`））

### Phase 1: MVP（完了）

- 検査エンジンを TypeScript に移植（`web/src/engine/`）、ビルドパイプラインを `wasm/` に移した
- Go の最新の安定版でビルド。当初は golangci-lint v2.5.0 の公式リリースと同じ go1.25.1 だったが、2026-11-25 に go1.27.4 へ変更し、Go 1.27 に対応した golangci-lint v2.15.0 に上げた
- CodeMirror 6 エディタ（ライト・ダーク両対応）、エディタ内マーカー、結果一覧（クリックで該当箇所へ移動）
- 単一ファイル + 自動生成 `go.mod`。txtar による複数ファイルも 1 つのエディタで扱える（Phase 2 でタブ表示に置き換えた）
- 設定 YAML の自由記述（書き換えずにそのまま渡す）。空ならデフォルト設定（`standard`）で実行
- 非対応機能の洗い出しと警告表示（[4.6](#46-ブラウザ内で動かない機能の扱い)）。その過程で `goimports` が検査全体を止める問題を見つけ、x/tools のパッチで解消した
- キャンセル、ダウンロード進捗の表示、アセットのチェックサム検証
- URL フラグメント方式の共有（共有 URL は自動実行しない）
- Service Worker によるアセットのキャッシュ
- Google Chrome 以外での案内表示
- CI（型チェック・単体テスト・パリティテスト・E2E）と GitHub Pages へのデプロイのワークフロー（GitHub 上での実行は未確認）

### Phase 2: 設定の充実（完了）

- YAML エディタの強化: JSON Schema による補完・ホバー説明・警告（CSP の下で動く自前の検証器）。不明なリンター名の警告
- リンター選択 GUI: コメントと順序を保ったまま YAML の一部だけを書き換える
- 複数ファイルのタブ表示（txtar は共有・保存形式として残す）
- サンプル集（7 つ。パリティテストの対象にも含めた）

### Phase 3: 機能拡張

- 複数バージョン対応、新バージョン追従の自動化
- `Fix`（`--fix`）、Quick Fix（`SuggestedFixes` の適用）（完了）。`Format`（goimports による整形と import の追加）は Phase 2 のあとに先行して実装した
- v1 設定から v2 への移行支援（`golangci-lint migrate` をブラウザ内で実行）
- GitHub Gist からの読み込み
- 2 バージョンの結果を並べて比較

### Phase 4: 発展

- 非対応リンターへの個別パッチ（要望が多いものから）

## 11. 未解決の論点・今後の検討事項

サードパーティモジュール・対応ブラウザ・ダウンロードサイズは [1.5](#15-スコープの決定事項) で決着済み。残る論点は以下。

- **重いリンター構成**: `--default=all` ではキャッシュありでも約 7 秒かかる（Node での計測）。待ち時間の見せ方と、どこまでを許容範囲とするか
- **Go バージョンの選択**: golangci-lint のバージョンとは別に、解析対象の Go バージョン（`go.mod` の `go` 行）を選べるようにするか。標準ライブラリのバンドルが Go のバージョンごとに必要になるため、当面は「golangci-lint バージョンごとに 1 つの Go」で固定する
- **i18n**: UI は英語のみ。ほかの言語（日本語など）にも対応するか


## 12. ライセンス

| 構成要素 | ライセンス | 配布される場所 |
| --- | --- | --- |
| このリポジトリ（Web アプリ・ビルドスクリプト・テスト） | MIT（`LICENSE`） | リポジトリ、サイトの Web アプリ |
| `golang.org/x/tools` へのパッチ（`wasm/xtools/patches/`） | x/tools と同じ BSD-3-Clause（`wasm/xtools/LICENSE`） | リポジトリ、WASM 版に組み込まれる |
| golangci-lint と依存モジュール | golangci-lint は GPL-3.0、依存モジュールはそれぞれのライセンス | サイトの `v/<version>/`（WASM 版、`schema.json`） |
| Go（ランタイム・標準ライブラリ・`wasm_exec.js`） | BSD-3-Clause | サイトの `v/<version>/`（`std.bundle.bin` にソースが入っている） |
| Web アプリに同梱する npm パッケージ | MIT・ISC（20 パッケージ） | サイトの Web アプリ |

- **リポジトリは MIT のまま**: リポジトリには golangci-lint のコードは含まれず、`go.mod` / `go.sum` で参照しているだけ。Web アプリと golangci-lint は別のプログラムで、Web アプリは golangci-lint をコマンドライン引数で起動し、メモリ上のファイルシステムを通じてファイルをやり取りする（OS 上でコマンドを実行するのと同じ関係）。そのため Web アプリは golangci-lint に基づく著作物ではなく、サイトは両者を「集合物」として配布している
- **サイトは GPL-3.0 のバイナリを配布している**: WASM 版は golangci-lint に基づく著作物なので、GPL-3.0 のオブジェクトコード配布の条件を満たす
  - **対応するソース**（GPL-3.0 第 6 条 (d)）: `v/<version>/` のバイナリの隣に `golangci-lint-source.tar.gz` を置く。`go.mod` / `go.sum`、すべてのモジュールを vendor したもの（パッチを当てた `golang.org/x/tools` を含む）、ビルド手順の README、playground のビルドスクリプトとパッチが入っている。`wasm/build.sh` はこのソース一式から `-mod=vendor` でネットワークを使わずにビルドするので、アーカイブとバイナリが食い違うことはない（公開したアーカイブからビルドし直すと、`golangci-lint.wasm.bin` がバイト単位で一致する）。アーカイブは再現可能（エントリの並びとタイムスタンプを固定）で、中身が変わったときだけハッシュが変わる。MPL-2.0 のモジュールのソースもこれで提供される（MPL-2.0 第 3.2 条）
  - **ライセンス文と告知**: `v/<version>/licenses.txt` を、vendor したソースから `wasm/tools/mknotices` で生成する。バイナリにリンクされる全モジュールとそのライセンスの一覧に続けて、各モジュールの LICENSE・NOTICE（Apache-2.0 第 4 条 (d)）・PATENTS と、Go のライセンスを載せる
  - **改変の告知**（GPL-3.0 第 5 条 (a)）: golangci-lint 本体は改変していないが、`golang.org/x/tools` にはパッチを当てている。`licenses.txt` とアーカイブの README にその旨と、パッチを最後に変更した日付を書く
- **ライセンスの確認**: golangci-lint v2.15.0 の時点で、バイナリにリンクされる 206 モジュールのライセンスは MIT（133）、Apache-2.0（27）、BSD-3-Clause（26）、GPL-3.0（7）、MPL-2.0（6）、BSD-2-Clause（2）、MIT と BSD-3-Clause（2）・Apache-2.0（2）・Unlicense（1）のデュアルまたは併記。いずれも GPL-3.0 と両立する。`mknotices` は両立すると確認済みのライセンスだけを受け付け、それ以外のライセンスやライセンスのないモジュールがあるとビルドを失敗させる。golangci-lint を上げたときに、確認していないライセンスが紛れ込むことはない。Web アプリに同梱する npm パッケージについては、Vite プラグイン `web/scripts/licenses-plugin.ts` が同じ確認をし、Web アプリの `licenses.txt`（playground の MIT ライセンスと各パッケージのライセンスファイル）を書き出す
- **UI**: ツールバーの `Licenses` ボタンでダイアログを開き、リポジトリ・2 つの `licenses.txt`・選択中のバージョンのソースアーカイブへのリンクを表示する

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
- サードパーティモジュール: 依存パッケージを export data から読む作りのため、ブラウザ内で Go コンパイラを動かさない限り、そのままでは扱えない（対応しないことに決定。[1.5](#15-スコープの決定事項)）

### A.5 ブラウザでの検証結果

git 履歴のコミット `bf8c696` 時点の `poc/wasm/` に、ブラウザ内だけで動く PoC を作り、ヘッドレス Chromium（Playwright）で E2E テストを行った。

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

当初検討したサーバーサイド方式の要点を残す。詳細は git 履歴のコミット `e74abd3` 時点の本書を参照。

- **構成**: SPA → Go 製 API サーバー（入力検証・結果キャッシュ・レート制限・共有スニペット保存）→ ジョブごとの使い捨てコンテナ（gVisor / runsc）で golangci-lint を実行
- **隔離**: `--network=none`、read-only rootfs、tmpfs の作業領域、CPU / メモリ / PID / 実行時間の上限、非 root、`cap-drop=ALL`、ホストのディレクトリはマウントしない。ジョブは stdin で JSON として渡す
- **任意コード実行と同等に警戒した理由**: パーサーやリンターのバグを突く病的な入力、cgo による C コンパイラの起動、設定ファイル経由のファイル読み書き、`go.mod` の `toolchain` / `replace` によるツールチェイン取得やファイル参照
- **速度**: 標準ライブラリの解析キャッシュをコンテナイメージに焼き込んで約 0.5 秒
- **デプロイ**: gVisor を入れた VM 上の Docker、スケール時は GKE Sandbox などの gVisor RuntimeClass。Cloud Run のようにコンテナ内でコンテナを起動できない環境はサンドボックス側には使えない
- **不採用の理由**: サンドボックスの設計・運用とインフラ費用の負担が大きい。ブラウザ内 WASM 方式で実用的な速度が出ることを確認できたため
