# Portfolio native MCP

小規模サーバー向けのGo製MCP。実行時は単一バイナリで、Node.js・npm・管理APIへのHTTP接続を必要としない。公開HTMLと既存SQLiteを読み取り専用で取得する。既存の管理APIを置き換えるものではない。

## ビルドと起動

Go 1.26以上を使用する。依存バージョンは `go.mod` / `go.sum` に固定している。

```sh
cd api/mcp-go
CGO_ENABLED=0 go build -trimpath -ldflags='-s -w' -o /tmp/portfolio-mcp ./cmd/portfolio-mcp
/tmp/portfolio-mcp --transport http --root /Users/kn/File/projects/web/portfolio --db /Users/kn/File/projects/web/portfolio/api/data/portfolio.db --port 3318
```

HTTP入口は `http://127.0.0.1:3318/mcp`。stdioでは `--transport stdio` を使用する。stdoutはMCP専用で、診断はstderrへ出す。

Linux x86_64向けは次のように作成する。

```sh
CGO_ENABLED=0 GOOS=linux GOARCH=amd64 go build -trimpath -ldflags='-s -w' -o /tmp/portfolio-mcp-linux-amd64 ./cmd/portfolio-mcp
```

HTTP listenerはループバックだけで起動する。本番ではNginx経由のHTTPSから、公開情報の読み取りだけを匿名で提供する。管理APIと非公開情報への入口は設けない。

## 本番接続

接続先は `https://altena.me/portfolio/mcp`（Streamable HTTP）。専用 `portfolio-mcp.service` がGoバイナリを起動する。サービス定義とNginx設定は `deploy/` に置く。`deploy.py` は新規配備専用、`update-binary.py` は既知の旧SHAを確認してバイナリだけを更新し、失敗時に旧releaseへ戻す。

```sh
PORTFOLIO_MCP_URL=https://altena.me/portfolio/mcp /opt/homebrew/opt/node@22/bin/node api/mcp-go/tests/remote-contracts.mjs
```

上の検証コマンドはリポジトリのルートで実行する。2026-10-09にこの環境の実SDKから新旧通信方式で接続し、日本語・全角・大小文字・本文だけの語による検索、詳細/Markdown取得、Notesの3ページ送りを確認した。公開Notes 3件・Works 1件・Skills 15件・Timeline 26件を取得し、実際の下書き3件は固定not_foundとなった。本番DBは置き換えていない。

Originを送らないSDKで検証した。Origin付きのブラウザクライアントは既存ガードが拒否する。接続URLの配備はクライアント設定への登録を伴わない。

本番のプロセスRSSは取得後の単発観測で約19MiBだった。systemdはMemoryMax=96MiB・CPUQuota=50%・TasksMax=32、読み取り専用ファイルシステムを使用する。ピーク負荷の測定ではない。[本番検証記録](../../docs/superpowers/verification/2026-10-09-mcp-production.json)を参照。

## 取得契約

- Tools: `list_public_content`、`search_public_content`、`get_public_content`。
- Resources: `portfolio://altena/` に続く `index`、`profile`、`works`、`notes`、`skills`、`timeline`。個別項目は `works/{id}` と `notes/{id}`。
- DBの公開記事だけを取得し、下書き・限定公開・不正IDは除外する。公開解除で古いcursorを失効させる。HTMLは固定された公開パスからのみ読み取る。
- DTO・revision・cursor・Markdownは既存JSサービスと同じ契約。取得時刻とファイルmtimeは内容revisionへ含めない。
- 一覧は標準20/最大50件。本文512KiB、ファイル2MiB、最大1000項目、dataset16MiB、DTO出力2MiB。
- 通信入力64KiB、wire応答5MiB、同時8、読み取り5秒。60秒あたりHTTP120/tool60/resource60を上限とする。未知の引数・生URI・Host・Originを検査する。

## 検証

```sh
go test ./...
PORTFOLIO_MCP_BINARY=/tmp/portfolio-mcp /opt/homebrew/opt/node@22/bin/node --test tests/contracts.mjs
```

後者は開発時の比較検証だけにNode SDKと既存JS readerを使う。実行バイナリはNodeを呼ばない。fixtureで新旧MCP仕様・公開範囲・検索・revision・cursor・Markdownを比較し、実DBでも結果一致とDB不変を確認する。

旧Node版は `../mcp/` に比較・復旧用として残す。同時に同じportで起動しない。

2026-10-09のローカル確認では、日付正規化を含むGoの19テストとNode SDKの5統合テストが成功した。実データのDTO・revision・cursor・Markdownを照合し、DBのSHA-256不変を確認した。Linux/amd64静的バイナリは本番のRocky Linux 10で稼働を確認した。

Mac ARM64で初回 `tools/list` 応答後と、Notes一覧・index resourceを10組読んだ後のRSSを各1回観測した。ピーク値や本番負荷の測定ではない。

| 実装 | 初回応答後 | 10組の取得後 |
| --- | ---: | ---: |
| Node.js | 82.5MiB | 92.4MiB |
| Go | 22.1MiB | 27.0MiB |

観測値と検証条件は [検証記録](../../docs/superpowers/verification/2026-10-09-native-mcp.json) に保存した。
