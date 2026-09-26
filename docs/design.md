# muu 技術設計

更新：2026-09-26。初版の構成案。実装前。

## 1. 構成

```text
[iPhone/Android PWA] --HTTPS--> [Cloudflare Worker] --binding--> [R2 bucket]
   IndexedDB / Cache Storage        静的アセット + API
```

- Worker 1 本が静的 PWA と API を同一オリジンで配信する（Workers Static Assets）。Pages は使わない。CORS・別ドメインを持たない。
- ビルド無し。HTML / CSS / ES Modules をそのまま配信。Wrangler はデプロイと Secret 管理にだけ使う。
- 共有 DB は無し。R2 のオブジェクトとその customMetadata を唯一の正とする。

## 2. リポジトリ構成（案）

```text
worker/index.mjs        ルーティング、R2 一覧、認可、Range 配信
public/                 PWA（index.html, app.mjs, player.mjs, library.mjs,
                        playlists.mjs, settings.mjs, storage.mjs, sw.mjs,
                        theme.css, styles.css, manifest.webmanifest,
                        vendor/material-symbols/）
shared/version.mjs      バージョン定数（Worker と PWA が同じ値を使う）
docs/                   本書
wrangler.toml           name, assets, r2_buckets, vars
```

## 3. R2 レイアウト

```text
<folder>/<file>.mp3   customMetadata: title, duration(秒), uploadedAt(ISO)
<folder>/cover.jpg
```

- 楽曲 ID = オブジェクト key。URL エンコードしてパスに載せる。
- Worker の一覧 API は `list()` を prefix なしで回し（1000 件 / 回、continuation）、`.mp3` だけを曲、`cover.jpg` をフォルダカバーとして組み立てる。customMetadata が欠ける曲、size 0 の曲は除外。
- 一覧は Worker 側で 60 秒程度 Cache API に置く。ETag は一覧 JSON のハッシュ。PWA は `If-None-Match` で差分有無だけ確認する。

## 4. API

| API | 認可 | 用途 |
| --- | --- | --- |
| GET /api/library | なし | 曲一覧 JSON `{ etag, tracks:[{id, folder, title, duration, size, uploadedAt, cover}] }` |
| GET /media/:id | なし | MP3。Range 対応（R2 の range get をそのまま返す）。無ければ 404 |
| GET /covers/:folder | なし | cover.jpg。無ければ 404、PWA は代替画像 |
| PUT /api/tracks/:id | パスワード | アップロード。本文 = MP3、ヘッダに title / duration。既存 key は 409。バケット合計が `MAX_BUCKET_BYTES`（既定 9 GB）を超えるなら 507 |
| PUT /api/covers/:folder | パスワード | cover.jpg のアップロード。上書き可 |
| DELETE /api/tracks/:id | パスワード | 削除。存在しなくても 204 |
| POST /api/auth | パスワード | パスワードの確認のみ。何も変更しない |
| GET /version.json | なし | `{ version }`。Worker が返す |

- パスワードは `Authorization: Bearer <password>` で受け、Worker Secret `ADMIN_PASSWORD` と定数時間比較。
- 書き込み API は加えて `Sec-Fetch-Site` が `same-origin` であることを要求する。
- 大きなファイルは Worker のリクエスト本文上限（Free 100 MB）内なので単発 PUT で足りる。超える運用になったら multipart を検討。

## 5. PWA 内部

- `library.mjs`：一覧の取得、IndexedDB への前回一覧保存、ソート、Home 表示。
- `player.mjs`：`<audio>` 1 個、キュー、シャッフル、Media Session、前回状態の復元。otoport の player / queue をほぼ流用。
- `storage.mjs`：Cache Storage の音声・カバー保存、索引、使用量（`navigator.storage.estimate()` と実サイズを別に持つ）。
- `playlists.mjs`：IndexedDB の `playlists`（id, name, trackIds[]。配列順が表示順）。曲参照は R2 key。一覧に無い key はグレー表示。
- `settings.mjs`：設定 UI、アップロード（`File` を `<audio>` の `loadedmetadata` で秒数解析 → PUT）、更新確認。
- `sw.mjs`：アプリ本体は precache、`/media/*` は Cache Storage 優先・無ければネットワーク、`/api/*` はネットワークのみ。更新時に音声キャッシュへ触らない。
- 状態管理はモジュール変数＋`CustomEvent`。フレームワークなし。

## 6. 端末内データ

| 保管先 | 内容 |
| --- | --- |
| IndexedDB `library` | 前回一覧 JSON と etag |
| IndexedDB `saved` | 保存済み key、サイズ、保存日時 |
| IndexedDB `playlists` | My Playlist |
| IndexedDB `state` | 現在曲、位置、キュー、シャッフル、設定、パスワード |
| Cache `muu-app-v<ver>` | アプリ本体 |
| Cache `muu-media` | 音声。key = `/media/<id>` |
| Cache `muu-covers` | カバー |

## 7. テーマ

`theme.css` に全色を定義。指定パレットを M3 のロールへ割り当て、他ファイルは変数名だけを参照する。

```css
:root {
  --md-sys-color-background: #212129;
  --md-sys-color-surface: #212129;
  --md-sys-color-surface-container: #323949;
  --md-sys-color-surface-container-high: #3d3e51;
  --md-sys-color-outline-variant: #40445a;
  --md-sys-color-primary: #4c5265;          /* 塗り専用 */
  --md-sys-color-on-surface: #e6e6ec;
  --md-sys-color-on-surface-variant: #b4b6c4;
  --md-sys-color-on-primary: #ffffff;
}
```

## 8. デプロイ

1. `npm i -D wrangler`、`wrangler login`（ブラウザ認可のため利用者が実行）。
2. `wrangler.toml` に既存バケットを `r2_buckets` で紐付け。
3. `wrangler secret put ADMIN_PASSWORD`。
4. `wrangler deploy`。`*.workers.dev` の URL を友人へ共有。独自ドメインは任意。

## 9. 既知の制約

- iOS：バックグラウンド再生・ロック画面操作はホーム画面追加の PWA で確認する。Safari タブでは保証しない。`audio.volume` は操作不可。
- Cache Storage の quota は端末依存。使用率ゲージで可視化し、上限接近時は保存を止めてトースト。
- R2 の `list()` は結果整合。アップロード直後に一覧へ出るまで数秒かかることがある。アップロード側の端末は楽観的に一覧へ足す。
- URL を知る人は誰でも全曲を一括保存できる。友人間限定の前提。
