# Voice Lab 連携（任意の追加部品）

Muu の Settings → Generate から URL・声モデル・キーを指定し、PC のブリッジが Voice Lab の既存 API へ渡します。完成した MP3 は Muu の R2 に登録されます。Voice Lab を外部公開せず、既存の再生・保存・アップロードから切り離してあります。

ローカル開発は `.dev.vars` に `VOICE_GENERATION_ENABLED=1` と既存の `ADMIN_PASSWORD` を設定します。本番は公開の承認後に同名の Worker 変数を設定してデプロイします。PC 側の設定例と手順は RVC の `config/muu.example.yaml`・`docs/muu_bridge.md` にあります。初回に PC がモデル一覧を同期した後は、PC 停止中も依頼を受け付け、復帰後に処理できます。

`VOICE_GENERATION_ENABLED=0` または未設定で無効化できます。完全に取り外す場合の接続点は、`worker/index.mjs` の生成ルート分岐と import、`public/app.mjs` の任意モジュール呼び出し、`public/sw.mjs` の生成用2ファイルの一覧です。既存の曲や R2 の依頼・完成音は削除しません。

以下は API の詳細です。

The queue is disabled unless `VOICE_GENERATION_ENABLED=1`; leave it unset or set it to `0` to turn the feature off. This switch only hides the generation routes and does not delete generation state or generated audio from R2. All routes require the same `Authorization: Bearer <ADMIN_PASSWORD>` credential and reject cross-site browser requests according to `worker/auth.mjs`. State is stored in the single R2 object `_generation/state.json`; conditional ETag writes serialize queue mutations without a database.

`GET /api/generation` returns the synced catalog, worker heartbeat, and the newest 50 public jobs. It returns `503 catalog_unavailable` until a bridge has polled with a valid catalog. `POST /api/generation` creates or replays a job using an idempotency UUID and a catalog-valid voice, conversion preset, and mix preset. Reusing the same UUID and request data returns `200`; using it with different data returns `409`.

The bridge sends `POST /api/generation/worker/poll` with `{worker_id,catalog?}`. The response includes `job` (with private owner/lease and lab identifiers) or `null`, and a 120 second lease. Polling refreshes its heartbeat, renews its active job, or claims the oldest queued/expired job. Progress uses `POST /api/generation/worker/{id}` with `worker_id` and status. A job can become done only after the matching deterministic MP3 exists in R2 with `generationRequest` metadata. Terminal jobs cannot be reopened.

Audio is streamed with `PUT /api/generation/worker/{id}/audio`, `Content-Type: audio/mpeg`, `Content-Length`, `X-Worker-Id`, `X-Duration`, and URL-encoded `X-Title`. The endpoint accepts at most 95 MiB, checks the configured bucket quota, and creates `{folder}/generation-{id}.mp3` conditionally. Repeating an upload for the same request is idempotent when the object metadata matches; another object at that key is never overwritten. Uploading invalidates the library cache. Upload does not finish the job; the bridge must then post `done` with the deterministic `track_id`.

All JSON request bodies are limited to 16 KiB. Errors use `{ "error": "..." }`; malformed JSON is `400`, oversized bodies are `413`, and conditional-write conflicts retry a bounded number of times. Invalid or unreadable state is left untouched and returned as `503 state_unavailable`; storage service faults return `503 storage_unavailable`. Generation state is excluded from the track library because only valid `<folder>/<name>.mp3` keys are listed as tracks.
