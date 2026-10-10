# ローカル公開 MCP

小規模サーバー向けの採用実装は [Go版](../mcp-go/README.md) です。ローカル3318番はGo版へ切り替え済み。このNode版は契約比較・復旧用に保持しています。以下はNode版を使用する場合の説明です。

ポートフォリオの公開情報を MCP の tools と Markdown resources で読む独立プロセスです。`../agent-public-service.js` と共通 JSON Schema を利用し、JSON API と同じ公開判定・検索・ページ分割・DTO を返します。SQLite 接続は `readonly: true`、`fileMustExist: true` です。管理 router や書き込み接続は読み込みません。

対象はローカルの公開データです。本番サイトとの同期、外部への配備、Codex・Claude・VS Code などへの登録は行っていません。

## 準備と起動

Node.js 22 と、同じ Node 22 で利用できる親 `api/node_modules/better-sqlite3` が必要です。MCP の依存はこのディレクトリの `package.json` と `package-lock.json` に固定しています。リポジトリルートから実行します。

```sh
npm --prefix api/mcp ci --ignore-scripts
node --test api/mcp/*.test.mjs
node api/mcp/stdio.mjs
```

stdio は MCP client が上記の最後のコマンドを子プロセスとして起動します。stdout は改行区切りの JSON-RPC 専用です。診断は stderr に出力し、EOF・SIGINT・SIGTERM で接続と DB を閉じます。

HTTP は次のコマンドで起動します。

```sh
node api/mcp/http.mjs
```

接続先は `http://127.0.0.1:3318/mcp` です。listen は常に `127.0.0.1` です。設定できる環境変数は次のとおりです。

| 変数 | 既定値・用途 |
| --- | --- |
| `PORTFOLIO_MCP_ROOT` | リポジトリルート。公開 HTML・テキストの取得元 |
| `PORTFOLIO_MCP_DB` | root 下の `api/data/portfolio.db`。存在する DB のみ開く |
| `PORTFOLIO_MCP_PORT` | HTTP port。既定 `3318` |
| `PORTFOLIO_MCP_ORIGINS` | 許可 Origin のカンマ区切り。既定は空。例 `http://localhost:4321` |

これらはプロセス起動時の運用設定です。tool 引数や resource URI から root・DB・取得 URL を変更できません。Origin がない native client は許可し、Origin がある場合は許可リストと完全一致する必要があります。指定できる Origin は port を明示した `http://127.0.0.1:port` または `http://localhost:port` です。Host は接続先 port と一致する `127.0.0.1:port` または `localhost:port` に限定し、forwarded header を信用しません。

## tools と resources

| tool | 引数 |
| --- | --- |
| `list_public_content` | `kind`: `works` / `notes` / `skills` / `timeline`、任意の `limit`・`cursor` |
| `search_public_content` | `kind`: `works` / `notes`、必須の `q`、任意の `limit`・`cursor` |
| `get_public_content` | `kind`: `profile` / `works` / `notes`。Works・Notes は `id` 必須、Profile は `id` 禁止 |

`limit` は既定 20・最大 50 件、`q` は最大 120 Unicode コードポイント、cursor は最大 2048 UTF-8 bytes、ID は `[A-Za-z0-9_-]` の 1〜128 文字です。未知プロパティは拒否します。一覧は本文を含めず、詳細だけが `content_markdown` を含みます。

`structuredContent` と最初の text content に同じ公開 JSON envelope を返します。成功・共通エラーの union を共通 JSON Schema から `outputSchema` に登録します。業務エラーは `isError: true`、検索結果 0 件は成功です。SDK が処理する入力・未知 tool・protocol エラーは共通 envelope とは別です。

固定 resources は `portfolio://altena/index`、`profile`、`works`、`notes`、`skills`、`timeline` の 6 件です。個別本文は `portfolio://altena/works/{id}`、`portfolio://altena/notes/{id}` の templates と tool 結果の `resource_link` から取得します。URI をファイルパスへ変換しません。query・fragment・userinfo・port・エンコード・余分な path・`../` は拒否します。非公開・取り下げ済みの ID は不存在と同じ結果になります。

## transport と制限

SDK は `@modelcontextprotocol/server` / `client` 2.3.1、Express adapter 2.0.2、Node adapter 2.1.1、Express 5.2.1、Zod 4.6.5 に固定しています。`serveStdio` と `createMcpHandler` に同じ `createMcpServer({ service })` を渡します。2026-07-28 の modern 通信と legacy `initialize` 通信に対応し、HTTP の legacy 対応は stateless です。GET・DELETE は SDK が 405 を返します。modern は JSON 応答、legacy の応答形式は SDK が決めます。旧 HTTP+SSE endpoint・session・購読・変更通知は提供しません。

HTTP の既定上限は request 64 KiB、response 5 MiB、同時処理 8 件、処理時間 5 秒です。1 分の固定 window ごとに HTTP request 120 件、tool 読取 60 回、resource 読取 60 回までとします。tool・resource の上限は各カテゴリ内で共有します。HTTP 応答は `Cache-Control: no-store` です。出力を上限内で読み切ってから送信し、超過時は部分本文を返しません。公開集合の走査・本文・DTO 出力には共通サービスの上限も適用します。

時間制限は非同期通信を打ち切り、同期 reader の処理後にも経過時間を確認します。同期 SQLite・ファイル処理を実行途中で強制停止することはできません。共通サービスの走査件数・本文量制限と合わせてローカル検証に使います。

## 確認した範囲

2026-10-09、Node.js 22.22.3 で 16 件のテストが通りました。実 SDK client による modern・legacy の stdio／loopback HTTP 接続、tools・resources、JSON/Markdown の一致、非公開情報の除外、取り下げと cursor 失効、URI・入力制限、Host/Origin と protocol header の拒否、body・rate・concurrency・response・時間制限、SQLite の readonly と終了処理を試験用 fixture で確認しています。fixture の取り下げ試験以外では DB の SHA-256 が変わらないことも確認しています。

Inspector、利用ホストへの登録、Nginx/Cloudflare 経由、本番 DB、本番 endpoint は未検証です。

公式 API の根拠: [SDK v2](https://ts.sdk.modelcontextprotocol.io/v2/)、[stdio](https://ts.sdk.modelcontextprotocol.io/v2/serving/stdio)、[Express](https://ts.sdk.modelcontextprotocol.io/v2/serving/express.html)、[legacy client](https://ts.sdk.modelcontextprotocol.io/v2/serving/legacy-clients)。
