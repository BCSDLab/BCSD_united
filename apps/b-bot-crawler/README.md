# B_BOT crawler (Raspberry Pi)

Standalone Node 24 service for the **existing** GitHub README, Notion, and Google Drive document indexers. B_BOT remains a Cloudflare Worker; this service is only the long-running document-indexing execution plane. It writes to the existing B_BOT PostgreSQL/pgvector schema. It does not install or migrate that schema; provision it with the existing database migrations before jobs are submitted.

## Local operation

From the workspace root, with Node 24 and pnpm installed:

```sh
pnpm install
pnpm --filter @koin/b-bot-crawler typecheck
pnpm --filter @koin/b-bot-crawler test
pnpm --filter @koin/b-bot-crawler start
```

Configure the process environment using [`.env.example`](./.env.example). `pnpm start` does **not** load `.env` implicitly. The daemon fails before listening if the PostgreSQL connection or Cloudflare AI REST credentials are missing; Notion and Drive credentials are additionally checked for their respective jobs. Drive uses a Pi-provisioned `GOOGLE_REFRESH_TOKEN`, not the Worker's Nitro/KV storage. Grant that OAuth token Drive read-only access separately. `GDRIVE_FOLDER_IDS` may restrict Drive roots; if absent, the indexer scans all accessible Docs. Notion's first incremental request without an existing cursor performs a full index, as in the existing indexer. No jobs are scheduled on process start except previously queued jobs; existing in-flight jobs become `interrupted` and are **not** retried automatically.

`CRAWLER_AUTH_TOKEN` must be at least 32 characters and identical to the Worker secret. Listen address is fixed to `127.0.0.1`; the default port is `8813`. Never bind this service directly to an external interface. Jobs are durable in SQLite at `CRAWLER_STATE_PATH` (default `./data/crawler.sqlite`); keep the state directory persistent and writable by the service account. The separate SQLite instance-lock transaction prevents a second daemon from using the same state path; the OS releases it when a process dies, so no stale PID file requires manual removal. Back up the state file using SQLite-aware backup procedures, not by copying only the WAL file.

## HTTP contract

Every endpoint, including health, requires `Authorization: Bearer <CRAWLER_AUTH_TOKEN>`. The tunnel must additionally require a Cloudflare Access service token (Worker-provided client ID/secret). An authenticated `GET /health` returns `{ "ok": true, "service": "b-bot-crawler" }` without querying PostgreSQL, external sources, or AI.

- `POST /jobs` with `Content-Type: application/json`: `{ "connector": "github" | "notion" | "gdrive", "idempotencyKey": "sync:github:2026-11-04", "full": false }`. `full` is allowed only for Notion, and omitted defaults to false. Keys are 1–128 ASCII letters/digits/`.`/`_`/`:`/`-`. The entire body is limited to 4096 bytes. No URLs, scripts, or arbitrary task names are accepted. New job: 202; same key and same normalized payload: 200 with the same job; same key and different connector/mode: 409.
- `GET /jobs/:id`: 200 with the job, or 404. A job has `id`, `connector`, `status`, `createdAt`, `updatedAt`, optionally safe numeric counters and Notion `mode` in `result`, or generic `error` (`INGEST_FAILED` / `INTERRUPTED`). Status is `queued`, `running`, `succeeded`, `failed`, or `interrupted`. Never expose source errors, tokens, document content, or stack traces over this API.

One global FIFO worker executes jobs, because Notion indexing has module-level state and upstream API rate controls. A caller should poll status rather than waiting for indexing in the enqueue request. Failed/interrupted keys remain deduplicated; explicitly choose a **new** key to request an intentional retry. SIGTERM marks a running job interrupted and stops starting queued jobs, then waits for that ingestion to settle so its PostgreSQL pool can close. A forced kill releases the lock; the next process marks leftover `running` rows interrupted. Queued rows resume on restart.

## Pi deployment (only after Pi access and operator approval)

The files [`systemd/b-bot-crawler.service.example`](./systemd/b-bot-crawler.service.example) and [`cloudflared/config.yml.example`](./cloudflared/config.yml.example) are **templates**, not installed services or an existing tunnel. Adjust paths, service account, Node/pnpm executable location, state directory, hostname, and tunnel credentials to the actual Pi. Store `/etc/b-bot-crawler.env` as a restricted owner-readable file (`0600`), not in Git. Cloudflared should connect only to `http://127.0.0.1:8813` and publish the chosen hostname behind Cloudflare Access with a service-token policy. Provision the Worker with that hostname, the Access client ID/secret, and `CRAWLER_AUTH_TOKEN` as secrets; keep periodic scheduling disabled until the actual tunnel, Access policy, and credentials have been reviewed and approved. Do not paste tokens into logs or chat. The tunnel and token creation, Pi installation, production crawl, and Slack changes are not performed by this repository change.

The unit's `/usr/bin/env pnpm` assumes `pnpm` and Node 24 are on the service account's systemd `PATH`; interactive shell PATH managers (for example nvm) are not loaded. Replace `ExecStart` with the verified absolute installed executable path, or set an explicit service `Environment=PATH=...` before enabling the unit.
