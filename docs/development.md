# 開発手順

更新：2026-09-26。

## 前提

- Node.js 24.19.0（`engines` で固定）。npm 11。
- Cloudflare アカウント `73e71cfc7b30cca7fa6c8f6c26039ceb`、R2 バケット `muu`（作成済み）。
- ローカルの 8787 番は otoport が使うため、muu は 8790 番（inspector 9290）。

## コマンド

| コマンド | 内容 |
| --- | --- |
| `npm install` | 依存取得。初回は `npm approve-scripts --all workerd` で workerd の postinstall を許可 |
| `npm run dev` | `wrangler dev`。http://127.0.0.1:8790。R2 はローカルエミュレーション |
| `npm test` | 単体テスト（node:test）。CI と同じ |
| `npm run test:e2e` | Playwright（iPhone 13 相当）。dev サーバーを自動起動 |
| `npm run icons` | Material Symbols を取得して `public/icons.mjs` を再生成 |
| `npm run deploy` | 本番デプロイ。`wrangler login` 済みであること |

## 秘密情報

- ローカル：`.dev.vars`（`.dev.vars.example` を複製）。Git 管理外。
- 本番：`npx wrangler secret put ADMIN_PASSWORD`。

## CI / CD

- `.github/workflows/ci.yml`：push / PR で `npm test`。
- `.github/workflows/deploy.yml`：main への push で `wrangler deploy`。リポジトリ Secret `CLOUDFLARE_API_TOKEN`（Workers 編集権限）が無い間はスキップ。

## 進め方

- main 直コミットを基本とし、大きな変更だけブランチ＋PR。
- 不要になったコードは消す。将来使う可能性のある資料だけ `old/` に置く。
- 迷ったら `docs/principles.md` に照らす。
