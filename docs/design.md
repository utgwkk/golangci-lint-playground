# golangci-lint playground 設計書

## 1. 概要

[Go Playground](https://go.dev/play/) のように、ブラウザ上で Go コードを書き、[golangci-lint](https://golangci-lint.run/) による検査結果をその場で確認できる Web アプリケーションを作る。

### 1.1 ゴール

- ブラウザだけで Go コードに golangci-lint をかけ、結果をエディタ上にインライン表示できる
- golangci-lint の設定ファイル（`.golangci.yml`）を **YAML で自由記述** でき、書いた内容がそのまま検査に反映される（詳細は [1.4](#14-要件設定ファイル-yaml-の自由記述)）
- 有効にするリンターなど、よく使う設定は GUI からも調整できる
- コード・設定・バージョンを含む状態を URL で共有できる
- 複数の golangci-lint バージョンを選んで試せる
- 任意コードを受け付ける公開サービスとして、安全に運用できる

### 1.2 ノンゴール（当面はやらない）

- Go コードの **実行**（それは Go Playground の役割）
- golangci-lint のカスタムプラグイン（Module Plugin / Go Plugin）のロード
- cgo を含むコードの解析
- ユーザーアカウント・保存履歴の管理

### 1.3 想定ユースケース

- リンターの挙動や指摘内容を手軽に確かめる（「この書き方は `gocritic` に怒られる？」）
- golangci-lint の issue / PR / ブログで再現コードを URL で共有する
- 設定項目（`linters.settings.*`）の効果を試行錯誤する
- バージョン間で挙動差を比較する
- 手元のプロジェクトの `.golangci.yml` をそのまま貼り付けて、挙動を再現・共有する

### 1.4 要件：設定ファイル (YAML) の自由記述

ユーザーは golangci-lint の設定ファイルを YAML で自由に記述できる。playground は「GUI で選べる範囲の設定」に機能を絞らず、golangci-lint が受け付ける設定はできる限りそのまま使えるようにする。

- **YAML エディタを主役にする**: 設定パネルの正本は YAML テキストとする。GUI（リンター選択など）は YAML を編集するための補助で、GUI 操作は YAML の該当箇所だけを書き換える（コメントやキーの順番、GUI が扱わない設定は残す）
- **最小限の介入**: サーバーは受け取った YAML を golangci-lint に渡す前に、**サンドボックスの安全性と実行制御に必要な最小限のキーだけ** を上書きする（[4.2 設定 YAML の取り扱い](#設定-yaml-の取り扱い)）。それ以外のキー（`linters.settings.*`、`linters.exclusions.*`、`issues.*`、`formatters.*`、`severity.*` など）はユーザーが書いたとおりに使う
- **介入は必ず見える形で伝える**: 上書き・無視したキーがあれば、レスポンスの `configWarnings` で返し、YAML エディタの該当行に警告マーカーを出す。黙って書き換えない
- **エラーはそのまま見せる**: YAML の構文エラーや golangci-lint が出す設定エラーは、行番号付きでエディタ上に表示する
- **貼り付けやすさ**: 手元の `.golangci.yml` を丸ごと貼り付けても動くことを目標にする。v1 形式（`version: "2"` がない設定）を貼り付けた場合は、v2 形式への変換を提案する
- **共有に含める**: 自由記述した YAML はコメントも含めて共有スナップショットにそのまま保存し、共有 URL を開くと一字一句同じ内容が再現される

## 2. 前提となる事実（検証済み）

本設計は golangci-lint v2.5.0（go1.25.1 ビルド）を手元で動かして確認した以下の挙動を前提とする。

| 項目 | 挙動 | 設計への影響 |
| --- | --- | --- |
| JSON 出力 | `--output.json.path stdout` で `{"Issues": [...], "Report": {...}}` が得られる | 結果は JSON をパースして扱う。終了コードには依存せず、JSON を正とする |
| Issue の形 | `FromLinter`, `Text`, `Severity`, `SourceLines`, `Pos{Filename,Offset,Line,Column}`, 自動修正可能なものは `SuggestedFixes[].TextEdits[]{Pos,End,NewText}`（`NewText` は base64） | エディタ上のマーカーやクイックフィックスに直接使える |
| 型エラー | `FromLinter: "typecheck"` として返り、`Pos` は `Line:1, Column:0` 固定、実際の位置は `Text` 内の `./main.go:11:2: ...` に埋め込まれる | `typecheck` は `Text` を正規表現で再パースして位置を補正する |
| キャッシュ効果 | 標準ライブラリの解析キャッシュがないと初回 約5秒、ウォーム時 約0.5秒 | サンドボックスイメージに **事前ウォームしたキャッシュ** を焼き込む |
| リンター一覧 | `golangci-lint help linters --json` で `name, description, groups, fast, autoFix, deprecated, since, originalURL` が得られる | バージョンごとのリンター選択 UI をこの JSON から生成する |
| フォーマッタ | v2 では `formatters` セクションに分離。`golangci-lint fmt --diff` で unified diff が得られる | 「Format」機能は `fmt` サブコマンドで実装する |
| 設定検証 | `golangci-lint config verify` は JSON Schema を **ネットワーク越しに取得** する | サンドボックス（ネットワーク遮断）では使えない。スキーマはビルド時に同梱する |
| Go バージョン | golangci-lint はビルドに使った Go と解析対象の Go の組み合わせに制約がある | golangci-lint バイナリと Go ツールチェインはイメージ単位でペアにして固定する |

## 3. 全体アーキテクチャ

```
┌────────────────────────── Browser ──────────────────────────┐
│  SPA (TypeScript + Vite + CodeMirror 6)                      │
│   ├ Go エディタ（複数ファイル / txtar）                      │
│   ├ 設定パネル（リンター選択 GUI ⇔ YAML エディタ）           │
│   └ 結果パネル（一覧 + エディタ内マーカー + Quick Fix）      │
└──────────────┬──────────────────────────────────────────────┘
               │ HTTPS (JSON)
┌──────────────▼──────────────── API Server (Go) ─────────────┐
│  ├ リクエスト検証（サイズ・ファイル名）、設定の最小限の上書き│
│  ├ 結果キャッシュ（hash(version, config, files) → result）   │
│  ├ レート制限 / 同時実行数制御（キュー）                    │
│  ├ 共有スニペットの保存・取得                               │
│  └ Runner インタフェース経由でサンドボックスへジョブ投入     │
└──────────────┬───────────────────────────────┬──────────────┘
               │                               │
┌──────────────▼───────── Sandbox ──────┐  ┌───▼──────────────┐
│ 使い捨てコンテナ (gVisor / runsc)       │  │ Storage          │
│  ├ lintrunner（stdin でジョブ受信）     │  │  (SQLite → GCS / │
│  ├ golangci-lint vX.Y.Z + Go 1.NN       │  │   S3 など)       │
│  ├ 事前ウォーム済み GOCACHE (read-only) │  └──────────────────┘
│  └ /work (tmpfs) にファイル展開して実行 │
└─────────────────────────────────────────┘
```

### 3.1 方式選定：なぜサーバーサイド実行か

| 方式 | 評価 |
| --- | --- |
| **A. ブラウザ内 WebAssembly で golangci-lint を動かす** | golangci-lint は `go/packages` 経由で `go list` を呼び、標準ライブラリのソースや型情報を必要とする。Go ツールチェインごと WASM 化し、数百 MB の GOROOT をブラウザへ配信する必要があり非現実的。リンター側も WASM 前提で作られていない |
| **B. サーバーサイドで隔離実行**（採用） | Go Playground と同じ方式。golangci-lint をそのまま使え、バージョン追従も容易。代わりに **サンドボックスの安全性** と **実行コスト** を設計で担保する |

golangci-lint は対象コードを *実行* はしないが、以下の理由で任意コード実行と同等の警戒が必要と判断し、強い隔離を前提とする。

- `go list` / 型チェックはパーサーやリンター実装のバグを踏む可能性がある（巨大入力・病的入力による DoS を含む）
- cgo が有効だと C コンパイラが呼ばれる
- 設定ファイル経由でファイル読み込み（例: `goheader` の `template-path`）や出力先指定（`output.*.path`）ができる
- `go.mod` の `toolchain` ディレクティブや `replace` がツールチェイン取得・ファイルシステム参照を誘発しうる

## 4. コンポーネント詳細

### 4.1 フロントエンド

- **技術**: TypeScript + Vite、エディタは **CodeMirror 6**
  - Monaco より軽量でモバイルでも動作し、`@codemirror/lint` で診断表示、`@codemirror/lang-go` / `@codemirror/lang-yaml` が使える
  - UI フレームワークは小さく保つ（Preact もしくは素の TS）。静的ファイルとして API サーバーから配信する
- **画面構成**
  - ヘッダ: `Run`（Ctrl/Cmd+Enter）、`Format`、`Fix`、`Share`、バージョン選択、サンプル選択
  - 左: Go コードエディタ（ファイルタブ。`+` で `go.mod` や追加ファイルを作成）
  - 右上: 設定パネル（[1.4](#14-要件設定ファイル-yaml-の自由記述) の要件に対応）
    - **YAML エディタ（正本）**: `.golangci.yml` を自由記述する。`@codemirror/lang-yaml` によるハイライト、バージョンごとの JSON Schema（ビルド時に同梱）を使ったキー補完・ホバー説明・型チェック。Schema に反する記述は警告として表示するだけで、実行は止めない（最終的な判断は golangci-lint に任せる）
    - **GUI（補助）**: リンター一覧（検索・グループ・`fast` / `autoFix` バッジ・説明・元リポジトリへのリンク）をチェックボックスで選ぶと、YAML の `linters.enable` / `linters.disable` / `linters.default` だけを書き換える。YAML 側の変更は GUI に即時反映する
    - YAML の部分書き換えには、コメントや順序を保持できる YAML ライブラリ（`yaml` パッケージの Document API など）を使う
    - サーバーから返った `configWarnings`（上書き・無視したキー）や設定エラーは、YAML エディタの該当行にマーカーで表示する
    - 「デフォルト設定に戻す」「サンプル設定を挿入」ボタンを用意する
  - 右下 / 下部: 結果パネル
    - Issue 一覧（リンター名・メッセージ・位置）。クリックで該当行へジャンプ
    - エディタ内に波線マーカー、ホバーでメッセージ、`SuggestedFixes` があれば Quick Fix ボタン
    - 実行時間、キャッシュヒット有無、golangci-lint の stderr（折りたたみ）
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

### 4.2 API サーバー

Go 製の単一バイナリ（`net/http` 標準ルーティングで十分）。

#### エンドポイント

| メソッド | パス | 概要 |
| --- | --- | --- |
| `POST` | `/api/lint` | 検査を実行し結果を返す |
| `POST` | `/api/fmt` | `golangci-lint fmt` の結果（整形後ファイル）を返す |
| `GET` | `/api/versions` | 利用可能な golangci-lint バージョン一覧 |
| `GET` | `/api/versions/{version}/linters` | そのバージョンのリンター・フォーマッタ一覧 |
| `GET` | `/api/versions/{version}/schema` | そのバージョンの設定 JSON Schema |
| `POST` | `/api/share` | スナップショットを保存し ID を返す |
| `GET` | `/api/share/{id}` | スナップショットを取得 |
| `GET` | `/p/{id}` | 共有 URL（SPA を返し、フロントが `/api/share/{id}` を読む） |
| `GET` | `/healthz` | ヘルスチェック |

#### `POST /api/lint`

リクエスト:

```json
{
  "version": "v2.5.0",
  "files": [
    { "name": "go.mod",  "content": "module playground\n\ngo 1.25\n" },
    { "name": "main.go", "content": "package main\n..." }
  ],
  "config": "version: \"2\"\nlinters:\n  enable: [gocritic]\n",
  "fix": false
}
```

- `files` に `go.mod` がなければサーバー側でデフォルト（`module playground` + イメージの Go バージョン）を補う
- `config` が空ならデフォルト設定（`linters.default: standard`）を使う
- `fix: true` のときは `--fix` を付けて実行し、修正後のファイル内容も返す

レスポンス:

```json
{
  "issues": [
    {
      "linter": "errcheck",
      "message": "Error return value of `f.Close` is not checked",
      "severity": "",
      "file": "main.go",
      "line": 10,
      "column": 15,
      "sourceLines": ["\tdefer f.Close()"],
      "fixes": [
        { "message": "", "edits": [{ "start": 89, "end": 101, "newText": "..." }] }
      ]
    }
  ],
  "fixedFiles": null,
  "configWarnings": [
    { "path": "run.timeout", "line": 3, "message": "run.timeout は playground の上限 20s に変更しました" }
  ],
  "stderr": "",
  "durationMs": 612,
  "cached": false,
  "version": "v2.5.0"
}
```

- 生の golangci-lint JSON をそのまま返さず、**正規化した型** に変換する（バージョン間の差分を API サーバーで吸収し、フロントを安定させる）
  - `SuggestedFixes[].TextEdits[].NewText` は base64 デコードして文字列で返す
  - `typecheck` の Issue は `Text` 中の `^\.?/?(?P<file>[^:]+):(?P<line>\d+):(?P<col>\d+): (?P<msg>.*)$` を行ごとにパースし、1 行 1 Issue に分解して位置を補正する
  - `Report.Linters` は返さない（`/api/versions/{v}/linters` で別途提供）
- エラー（入力不正・タイムアウト・設定エラー等）は HTTP ステータス + `{ "error": { "code": "...", "message": "..." } }` で返す。設定ファイルのエラーは `code: "invalid_config"` として結果パネルに分かりやすく表示する

#### 入力検証

| 項目 | 制限（初期値） |
| --- | --- |
| リクエストボディ | 256 KiB |
| ファイル数 | 20 |
| 1 ファイルサイズ | 64 KiB |
| ファイル名 | `^[A-Za-z0-9_\-./]+$`、`..` / 絶対パス禁止、深さ 3 まで、拡張子は `.go` `.mod` `.sum` `.txt` `.yml` 程度に限定 |
| 設定 YAML | 16 KiB、アンカー/エイリアス展開数に上限（Billion laughs 対策） |
| `go.mod` | `toolchain` 行は削除、ローカルパスへの `replace` は拒否 |

#### 設定 YAML の取り扱い

[1.4](#14-要件設定ファイル-yaml-の自由記述) の要件に従い、ユーザーが書いた YAML は **できるだけそのまま** golangci-lint に渡す。安全性の本体はサンドボックス（4.3）が受け持つので、設定の段階では「サンドボックス内で効いてしまうと実行制御が壊れるキー」だけに手を入れる。

処理の流れ:

1. YAML としてパースする（サイズ上限・アンカー展開数の上限あり）。構文エラーなら行・列付きで `invalid_config` を返す
2. `version` が `"2"` でなければ `code: "config_v1"` を返し、フロントは v2 形式への変換を提案する（変換はサンドボックス内で `golangci-lint migrate` を実行して行う）
3. 下表のキーだけを上書き・削除し、内容を `configWarnings` に記録する
4. ユーザーの元の YAML テキストは書き換えずに保持し（共有・キャッシュキーにはこちらを使う）、上書き後の YAML はサンドボックスに渡すためだけに生成する

| キー | 扱い | 理由 |
| --- | --- | --- |
| `output.*` | 削除 | 結果の受け取り方はサーバーが決める（JSON を stdout へ） |
| `run.timeout` | 上限（例: 20s）を超えたら丸める | 実行時間の上限を守るため |
| `run.concurrency` | 固定値に上書き | CPU の割り当てに合わせるため |
| `run.modules-download-mode` | `readonly` に上書き | ネットワークなしで動かすため |
| `run.relative-path-mode` / `run.go` | 固定値に上書き | 出力パスの正規化と、イメージの Go バージョンに合わせるため |
| `linters.settings.custom` | 無視して警告 | プラグインのロードは非対応（ノンゴール） |
| ファイルパスを取る設定（`goheader.template-path` など） | そのまま渡す（サンドボックス内のファイルしか読めない）。読めないファイルを指す場合のエラーはそのまま見せる | 自由記述を妨げないため。秘密情報はサンドボックスに置かない |

上の表に載っていないキーは、未知のキーやスキーマに反する値も含めて **すべてそのまま渡す**。エラーの判断は golangci-lint に任せ、その出力（設定エラーのメッセージ）を `invalid_config` としてそのまま返す。こうすることで、playground 側の対応が遅れても、新バージョンで増えた設定をすぐに試せる。

上書き対象のキーはバージョンごとに定義ファイルで管理し、golangci-lint の設定項目の変更に追従する。

#### 結果キャッシュ

- キー: `sha256(version || 正規化済み config || txtar(files) || fix)`
- 同一入力（共有 URL を多数の人が開くケース）では再実行しない
- 初期はプロセス内 LRU（例: 1,000 件 / TTL 24h）。スケールアウト時に Redis / Memorystore へ移行

#### 同時実行制御とレート制限

- サンドボックス同時実行数をセマフォで制限（例: vCPU 数 ÷ 1）。溢れた分は短いキュー（例: 待ち 10 秒まで）に積み、それ以上は `503` + `Retry-After`
- IP 単位のトークンバケット（例: 10 req/min、バースト 5）。共有スニペット保存は別枠でより厳しく
- 同一 IP からの同時実行は 1 本まで

### 4.3 サンドボックス（Runner）

#### Runner インタフェース

```go
type Job struct {
    Version string        // "v2.5.0"
    Files   []File        // 検証済み
    Config  []byte        // 最小限の上書きを適用した YAML
    Mode    Mode          // ModeLint / ModeFix / ModeFmt
}

type Result struct {
    RawJSON   []byte      // golangci-lint の JSON 出力
    Files     []File      // Fix / Fmt 後のファイル
    Stderr    string      // 上限付きで切り詰め
    ExitCode  int
    Duration  time.Duration
}

type Runner interface {
    Run(ctx context.Context, job Job) (Result, error)
}
```

実装:

- `LocalRunner`: 開発用。ホストの golangci-lint を一時ディレクトリで直接実行（**本番使用禁止**、起動フラグで明示的に有効化）
- `DockerRunner`: 本番用。ジョブごとに使い捨てコンテナを起動
- （将来）`PoolRunner`: 起動済みコンテナのプールを使い回し、起動オーバーヘッドを削減

#### コンテナ実行オプション（`DockerRunner`）

```
docker run --rm -i \
  --runtime=runsc \                 # gVisor でシステムコールを隔離
  --network=none \                  # ネットワーク完全遮断
  --read-only \                     # ルート FS 読み取り専用
  --tmpfs /work:rw,size=64m,mode=1777 \
  --tmpfs /tmp:rw,size=64m \
  --memory=1g --memory-swap=1g \
  --cpus=1 --pids-limit=256 \
  --user 65534:65534 \
  --cap-drop=ALL --security-opt=no-new-privileges \
  golangci-lint-playground-sandbox:v2.5.0
```

- 外側でも `context.WithTimeout`（例: 30 秒）を設け、超過時はコンテナを強制終了
- stdout / stderr は上限（例: 1 MiB）を超えたら切り捨てる
- ホストのディレクトリは一切マウントしない。ジョブは **stdin で JSON として渡す**

#### サンドボックス内エージェント `lintrunner`

イメージに同梱する小さな Go バイナリ。

1. stdin から `Job` JSON を読む
2. `/work` にファイルを展開し、`/work/.golangci.yml` に設定を書く
3. 以下の環境で golangci-lint を実行する
   - `CGO_ENABLED=0`
   - `GOTOOLCHAIN=local`（ツールチェインの自動ダウンロードを禁止）
   - `GOPROXY=off`、`GOFLAGS=-mod=mod`、`GONOSUMDB` / `GOFLAGS` は固定
   - `GOCACHE` / `GOLANGCI_LINT_CACHE` は「イメージ内の read-only なウォーム済みキャッシュ」を下敷きにした書き込み可能領域（後述）
   - `HOME=/tmp`
4. モードに応じたコマンド
   - Lint: `golangci-lint run --output.json.path stdout --output.text.path stderr --show-stats=false ./...`
   - Fix: 上記 + `--fix`、実行後に `/work` のファイルを読み戻す
   - Fmt: `golangci-lint fmt ./...` 実行後にファイルを読み戻す
5. `Result` を JSON で stdout に書いて終了

#### サンドボックスイメージ

golangci-lint のバージョンごとにイメージを作る。

```dockerfile
FROM golang:1.25 AS build
ARG GOLANGCI_LINT_VERSION=v2.5.0
# 公式リリースバイナリを取得し、チェックサムを検証
RUN ... install golangci-lint ${GOLANGCI_LINT_VERSION} ...
COPY lintrunner/ /src/lintrunner/
RUN CGO_ENABLED=0 go build -o /out/lintrunner /src/lintrunner

# キャッシュのウォームアップ:
# 標準ライブラリの主要パッケージを import する warmup プロジェクトに対し、
# 全リンターを有効にして一度実行し、GOCACHE と golangci-lint キャッシュを作る
COPY warmup/ /warmup/
RUN cd /warmup && golangci-lint run --default=all ./... || true

FROM gcr.io/distroless/base-debian12   # もしくは最小限の Go ランタイムイメージ
COPY --from=build /usr/local/go /usr/local/go
COPY --from=build /go/bin/golangci-lint /usr/local/bin/
COPY --from=build /out/lintrunner /usr/local/bin/
COPY --from=build /root/.cache /cache-seed   # ウォーム済みキャッシュ（read-only）
ENTRYPOINT ["/usr/local/bin/lintrunner"]
```

- **キャッシュのウォームアップ** が体感速度を左右する（実測で 5 秒 → 0.5 秒）。ただし golangci-lint / Go のキャッシュは書き込みを伴うため、`lintrunner` 起動時に `/cache-seed` を `/tmp` 配下の書き込み領域へ高速コピー（またはオーバーレイ）して使う。コピーコストが大きい場合は、キャッシュ用だけ tmpfs を広めに確保するか、コンテナプール化で償却する
- イメージのメタデータとして `golangci-lint help linters --json`、`help formatters --json`、JSON Schema をビルド時に書き出し、API サーバーが `/api/versions/{v}/...` で配信する（実行時にサンドボックスを起動しなくて済む）

### 4.4 共有機能

二段構えにする。

1. **URL フラグメント方式（MVP）**: スナップショット（txtar + config + version）を圧縮（`CompressionStream('deflate-raw')` など）して base64url 化し、`/#v1:...` に入れる。サーバー保存が不要で実装が軽い。URL が長くなる欠点あり
2. **短縮 ID 方式**: `POST /api/share` でスナップショットを保存し、内容のハッシュ（sha256 を base64url で 11 文字程度に切り詰め）を ID とする。同じ内容は同じ ID になり重複保存されない
   - 保存先: 初期は SQLite、本番はオブジェクトストレージ（GCS / S3）
   - サイズ上限はリクエスト上限と同じ、IP 単位のレート制限を別途設ける
   - 不適切コンテンツ報告用に、ID 単位で削除できる管理コマンドを用意する

スナップショット形式（バージョン付きで将来の拡張に備える）:

```json
{
  "schema": 1,
  "version": "v2.5.0",
  "files": "-- go.mod --\n...\n-- main.go --\n...",
  "config": "version: \"2\"\n..."
}
```

### 4.5 バージョン管理

- `GET /api/versions` は「サンドボックスイメージが存在するバージョン」を返す。`default: true` は最新安定版
- 新バージョンのリリースを定期ジョブ（GitHub Actions の schedule）で検知し、イメージビルド → 動作テスト → レジストリ push → 設定ファイルへの追記を行う PR を自動作成する
- 保持するのは「最新マイナーの最新パッチ」×直近 N 個（例: 5）程度にし、ディスクとビルドコストを抑える。共有 URL のバージョンが廃止済みなら、最も近いバージョンで実行して警告を表示する

## 5. セキュリティ設計まとめ

| 脅威 | 対策 |
| --- | --- |
| サンドボックス脱出 | gVisor (runsc)、非 root、`cap-drop=ALL`、`no-new-privileges`、read-only rootfs、ホストマウントなし |
| 外部通信（データ持ち出し・踏み台） | `--network=none`、`GOPROXY=off`、`GOTOOLCHAIN=local` |
| リソース枯渇（DoS） | CPU / メモリ / PID / tmpfs サイズ / 実行時間 / 出力サイズの上限、同時実行数制御、IP 単位レート制限、結果キャッシュ |
| 設定ファイル経由のファイル読み書き | 設定は自由記述を優先し、`output.*` の削除とプラグインの無視だけを行う。ファイルを読む設定は残すが、サンドボックス内には `/work` とツールチェイン以外のファイルを置かず、ホストのディレクトリもマウントしないので、読まれて困るものがない |
| cgo 経由の外部コマンド実行 | `CGO_ENABLED=0`、イメージに C コンパイラを入れない |
| 共有機能の悪用（ストレージ荒らし） | サイズ上限、レート制限、内容アドレス化による重複排除、削除用管理コマンド |
| XSS | Issue メッセージ・ファイル名などはすべてテキストとしてレンダリング（`innerHTML` 禁止）、CSP を設定 |

## 6. ディレクトリ構成（案）

```
.
├── cmd/
│   └── server/              # API サーバーのエントリポイント
├── internal/
│   ├── api/                 # HTTP ハンドラ、リクエスト/レスポンス型
│   ├── lint/                # 設定 YAML の上書き処理、golangci-lint 出力の正規化
│   ├── runner/              # Runner インタフェース、Local / Docker 実装
│   ├── share/               # スナップショット保存（SQLite / オブジェクトストレージ）
│   ├── cache/               # 結果キャッシュ
│   └── ratelimit/
├── sandbox/
│   ├── lintrunner/          # サンドボックス内エージェント
│   ├── warmup/              # キャッシュウォームアップ用プロジェクト
│   └── Dockerfile
├── web/                     # フロントエンド（Vite + TypeScript + CodeMirror 6）
│   ├── src/
│   └── examples/            # サンプルコード（txtar）
├── deploy/                  # docker compose / IaC
├── docs/
│   └── design.md
└── Makefile
```

## 7. デプロイ構成

- **MVP**: gVisor を入れた VM 1 台（例: GCE e2-standard-4 相当）に `docker compose` で API サーバーを配置し、API サーバーがホストの Docker デーモン経由でサンドボックスコンテナを起動する。前段に Cloudflare などの CDN / WAF を置き、静的ファイル配信と粗いレート制限を任せる
  - API サーバーに Docker ソケットを渡すのは強い権限なので、API サーバー自体も最小権限で動かし、Docker 操作はコンテナ起動に限定したラッパー経由にする
- **スケール時**: Kubernetes（GKE Sandbox などの gVisor RuntimeClass）でサンドボックスを Pod / Job として実行する、もしくは Firecracker ベースのマイクロ VM サービスを使う。Runner インタフェースを差し替えるだけで移行できるようにしておく
- Cloud Run のような「コンテナ内でさらにコンテナを起動できない」環境は、API サーバーの置き場所としては使えるが、サンドボックス実行側には向かない

## 8. 可観測性

- 構造化ログ（`log/slog`）: リクエスト ID、バージョン、実行時間、キャッシュヒット、終了コード（**コード本文はログに残さない**）
- メトリクス（Prometheus 形式）: リクエスト数、実行時間ヒストグラム、キュー待ち時間、タイムアウト数、サンドボックス起動失敗数、キャッシュヒット率
- アラート: エラー率、p95 レイテンシ、キュー溢れ

## 9. テスト戦略

| 種類 | 内容 |
| --- | --- |
| ユニットテスト | 設定 YAML の取り扱い（上書き対象キーだけが変わり、それ以外は意味的に同一のまま渡ること・`configWarnings` の行番号・コメントを含む元テキストが保持されること）、ファイル名検証、`typecheck` メッセージのパース、`SuggestedFixes` のデコード、txtar 変換 |
| ゴールデンテスト | `testdata/` の入力 txtar + 設定 → 期待される正規化済み Issue JSON（`LocalRunner` で実行） |
| サンドボックステスト | ネットワークアクセス不可、`/work` 外への書き込み不可、タイムアウトで確実に kill される、巨大出力が切り詰められる、ことを実コンテナで確認 |
| E2E テスト | Playwright でエディタ入力 → Run → マーカー表示 → Share → 共有 URL 再現、の一連のフロー |
| CI | GitHub Actions で上記を実行。サンドボックステストは gVisor を入れたランナーで実行 |

## 10. 実装フェーズ

### Phase 0: PoC（数日）

- `LocalRunner` + 最小 API（`POST /api/lint`）+ 素の textarea のフロントエンド
- golangci-lint 出力の正規化（`typecheck` 位置補正含む）をここで固める

### Phase 1: MVP

- CodeMirror 6 エディタ、エディタ内マーカー、結果一覧
- 単一ファイル + 自動生成 `go.mod`、標準ライブラリのみ
- 設定 YAML の自由記述（素の YAML エディタ + 最小限の上書き + `configWarnings` 表示）。空ならデフォルト設定（`standard`）で実行
- 最新版 1 バージョンのみ
- `DockerRunner` + gVisor + ウォーム済みキャッシュ入りイメージ
- 入力検証・同時実行制御・IP レート制限・結果キャッシュ
- URL フラグメント方式の共有
- VM 1 台へのデプロイ

### Phase 2: 設定と共有の充実

- YAML エディタの強化（JSON Schema による補完・ホバー説明・警告、エディタ上のエラー/警告マーカー）
- リンター選択 GUI（コメントと順序を保ったまま YAML の一部だけを書き換える）
- 複数ファイル（txtar）対応
- 短縮 ID 方式の共有（`/p/{id}`）
- サンプル集

### Phase 3: 機能拡張

- 複数バージョン対応、新バージョン追従の自動化
- `Fix`（`--fix`）と `Format`（`fmt`）、Quick Fix（`SuggestedFixes` の適用）
- v1 設定から v2 への移行支援（`golangci-lint migrate` を使った変換）
- 結果パネルでの差分比較（例: 2 バージョンの結果を並べる）

### Phase 4: 運用強化・発展

- コンテナプールによるレイテンシ削減
- 可観測性・アラート整備
- サードパーティモジュール対応（後述）

## 11. 未解決の論点・今後の検討事項

- **サードパーティモジュールのサポート**: サンドボックスはネットワーク遮断が前提のため、API サーバー側（またはサンドボックス外の専用フェッチャー）で `go mod download` を行い、取得済みモジュールを read-only でサンドボックスに渡す方式が候補。Go Playground も同様にプロキシ経由でモジュールを扱っている。取得対象のサイズ上限・許可リスト・キャッシュ方針を決める必要がある
- **キャッシュシードのコピーコスト**: ウォーム済みキャッシュのサイズ次第で、コンテナ起動ごとのコピーが重くなる。オーバーレイ FS、プール化、ウォーム対象パッケージの絞り込みのどれで解決するか、実測して決める
- **重いリンター**: `--default=all` のような設定では時間・メモリを大きく消費する。上限内で収まらない場合のユーザーへの伝え方（タイムアウト時に「有効リンターを減らしてください」と案内する等）
- **Go バージョンの選択**: golangci-lint のバージョンとは別に、解析対象の Go バージョン（`go.mod` の `go` 行）を選べるようにするか。イメージの組み合わせが増えるため当面は「golangci-lint バージョンごとに 1 つの Go」で固定する
- **i18n**: UI 文言の日英対応
