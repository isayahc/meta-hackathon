# MongoDB / MinIO migration — first implementation stage

This stage provides a read-only source inventory, immutable transfer generations in MongoDB, content-addressed/versioned objects through the S3 SDK, and verified restoration into a new local project. **The dashboard still uses SQLite/local media. No live backend cutover or long-term memory behavior is implemented by this stage.** Issue #80 remains open.

Each table row is a separate MongoDB document, preserving original IDs, revisions and receipts. A Mongo transaction publishes the generation only after every object has passed a full byte checksum. Retrying an identical generation does not duplicate its committed records. Interrupted uploads can leave unreferenced content-addressed objects; retry reuses them. Automatic orphan deletion is deliberately not implemented. Do not delete objects referenced by retained generations.

Stop every source writer before inspection/export. The CLI requires `--offline` as acknowledgement, not a cross-process lock. Source databases must already use the supported application schema. Inspection never upgrades the source. Unknown tables, unsafe paths, symlinks and checksum failures are rejected. All project files are included, not only media; keep credentials outside the project.

After `npm install` and `npm run build`, from the repository root:

```sh
node app/physical-task-tracker/dist/task-storage-transfer.js inspect farm /absolute/source-project --offline
```

This prints record counts, asset count/bytes and generation ID without contacting services. For export/restore supply runtime `MONGODB_URI`, `MONGODB_DATABASE` (default fieldops), `S3_ENDPOINT`, `S3_BUCKET`, `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, and optional `AWS_REGION`. Provision a private bucket with versioning enabled and a Mongo replica set supporting transactions.

```sh
node app/physical-task-tracker/dist/task-storage-transfer.js export farm /absolute/source-project --offline
node app/physical-task-tracker/dist/task-storage-transfer.js restore farm /absolute/new-project GENERATION_ID --offline
```

Restore refuses an existing destination. It verifies the generation, record counts and all downloaded bytes; an incomplete restore is removed. The original source remains intact. Restored records can be opened using the existing app for validation. Keep the old source/backup until a future explicit cutover has been tested. Do not treat these migration collections as the app's live records or configure two writers.

## Isolated integration laboratory

`compose.storage.yaml` has no published database/object ports. Its Mongo service has no authentication and is for an isolated development/test network only, not a production configuration. Set `STORAGE_ACCESS_KEY` and `STORAGE_SECRET_KEY` in the shell, then:

```sh
docker compose -f compose.storage.yaml run --build --rm transfer
```

MongoDB 8 has a documented incompatibility with some Linux kernels beginning at 6.19; CI uses Ubuntu 22.04 rather than bypassing its startup guard. Docker shares the host/VM kernel, so verify compatibility on Docker Desktop/WSL2 as well. See https://www.mongodb.com/docs/v8.0/release-notes/8.0/ .

The default tool command generates synthetic reviewed work, uploads it twice, checks scope isolation, and restores from actual MongoDB/MinIO, verifying IDs, corrections and MP4/GIF hashes. It uses persistent development volumes; `down -v` deletes those laboratory volumes. No live inference is used.

MinIO is built from the source release RELEASE.2025-10-15T17-29-55Z rather than relying on an old community image. Its AGPL license is included in the image. The adapter uses standard S3 operations so another compatible deployment can be selected. Verify supported distribution, patching and deployment terms before production use. Source: https://github.com/minio/minio/releases

## Remaining #80 stages

- Replace service-level SQL transactions with native Mongo persistence while preserving revision/idempotency guarantees.
- Integrate asset identities and streaming/range delivery into the live dashboard and bounded FFmpeg staging.
- Define production authentication, explicit live cutover/rollback and coherent ongoing backups.
- Integrate memory and agent checkpoint behavior from #72/#73.

The migration scaffolding is not a substitute for those stages. SQLite remains the sole live authority until that work lands.
