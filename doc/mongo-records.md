# Live MongoDB records

This stage of #80 makes MongoDB the live authority for goals, spots, sessions,
events, actions/tasks, process revisions, OI links and documents (including
workflow decisions, corrections, calendar plans and operation receipts).
The dashboard and CLIs use the same asynchronous record APIs. Video/GIF bytes
remain on the project volume; live MinIO playback and memory behavior (#72/#73)
are separate work.

## New project with Docker

Choose a long random **URI-safe** password (letters and digits work without URL
encoding), put `FIELDOPS_MONGO_PASSWORD` in your shell or uncommitted `.env`, then
run from the repository root:

```sh
docker compose -f compose.mongo.yaml run --build --rm fieldops node app/physical-task-tracker/dist/task-records.js init /data my-farm --offline
docker compose -f compose.mongo.yaml up -d fieldops
```

Initialization is explicit and once-only. The server refuses an uninitialized
Mongo project. Mongo has authentication, an internal replica-set key, a persistent
volume and no published database port. The application is published on localhost
8123. This Compose file uses a separate project volume from the SQLite Compose
file. The database admin credential is used here for local setup; use separate
provisioning credentials and a scoped application account for a shared deployment.
A single-node replica set supplies transactions, **not high availability**.
Use a supported host kernel (the existing Mongo 8 Linux 6.19 compatibility caveat
still applies). The `mongo:8.0` release line is shared with the migration lab;
pin a tested image digest when promoting a deployment.

## Existing project / npm start

Stop every writer and take a verified SQLite backup before activating Mongo.
`--offline` acknowledges this requirement; it is not a cross-process lock.
The source must already have the current SQLite schema. Import does not upgrade it.

Set `MONGODB_URI` to a reachable transaction-capable replica set and optionally
`MONGODB_DATABASE` (default `fieldops`). External-service URIs must use resolvable
replica-set member names. A standalone Mongo process is rejected. From the root:

```sh
npm install
npm run build
node app/physical-task-tracker/dist/task-records.js inspect /absolute/my-farm my-farm --offline
node app/physical-task-tracker/dist/task-records.js import /absolute/my-farm my-farm --offline
```

For the default `npm start` project, use the absolute path to
`app/physical-task-tracker/my-farm`. Keep `MONGODB_URI` available when starting
`npm start`. For any other path:

```sh
node app/physical-task-tracker/dist/serve-dashboard.js /absolute/my-farm --port 8123
```

No credentials are stored in the project marker. `FIELDOPS_RECORD_BACKEND=mongodb`
can additionally require a Mongo project; `FIELDOPS_PROJECT_ID` can require a
matching identity. An explicit SQLite setting cannot override a Mongo marker.
Never point two unrelated projects at the same project ID in one Mongo database.

## Authority, consistency and recovery

- Activation reserves a `pending` marker **before** remote writes, imports every
  record in a majority-committed transaction, then activates the marker. SQLite
  bytes, stable IDs, revisions and receipts are preserved; media stays in place.
- If interrupted, keep writers stopped and repeat the same init/import command.
  It can finish a matching committed import with no subsequent writes. A changed
  source, different project identity or newer Mongo records prevents overwrite.
- After activation, missing credentials, unavailable Mongo, missing projects and
  incompatible schemas fail closed. They never redirect reads/writes to SQLite.
- Mongo collections are `records_<table>` and `record_projects`, distinct from
  #81's immutable `transfer_*` collections. Each row is a separate document,
  scoped by `project_id`; JSON payloads are native BSON values. Compound unique
  indexes preserve revision keys and per-event action identity. Schema version
  and required fields are validated.
- Domain operations use a consistent project snapshot. Only changed records are
  written. A shared project revision fence serializes writes, preventing write
  skew across tasks, calendar decisions and receipts. Mongo retries a conflicted
  transaction against fresh records, where stale domain revisions are rejected.
  Inference, FFmpeg and other external effects run outside these transactions.
- This implementation deliberately targets bounded, single-operator projects:
  each operation loads up to **20,000 records / 32 MiB**, with an **8 MiB** per-row
  limit. Exceeding a limit fails before committing. Larger deployments need
  selective repository queries; this is not a large-data query engine. Clients
  are short-lived so CLI processes exit cleanly.
- Do not remove the marker to roll back after Mongo has accepted writes. The old
  SQLite copy is stale. The SQLite archive and #81 transfer commands refuse a
  Mongo project. Coordinated live Mongo/media backup and reverse migration remain
  #80 work; use an operationally verified database backup plus the matching media
  volume before relying on this mode for irreplaceable data.

## Verification

`npm test` runs the existing workflow suite and new local authority/atomicity
checks. The Mongo-specific tests skip unless explicitly enabled. CI runs:

```sh
docker compose -f compose.mongo.yaml --profile test build
docker compose -f compose.mongo.yaml run --rm mongo-tests
```

This exercises real authenticated Mongo transactions: replayed video capture,
process correction/history, next-action creation, accepted calendar decisions,
HTTP readiness and a fresh CLI process; concurrent stale edits, repeated
creation receipts, multi-record rollback, scope isolation and interrupted import
recovery. No live model or robot is involved, and media remains local.
