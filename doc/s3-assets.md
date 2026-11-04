# Live MinIO video and step-GIF storage

Opt-in S3 asset storage completes the live media path following MongoDB records
in #82. Uploads, original videos, sampled visit images and generated step GIFs
use private versioned objects. The existing `/media/<filename>` links remain
stable; the application streams the recorded object version, including byte
ranges for video seeking. No expiring URL is stored as an identity.

## Docker setup

Set `FIELDOPS_MONGO_PASSWORD`, `STORAGE_ACCESS_KEY`, and `STORAGE_SECRET_KEY` in
your shell or uncommitted `.env`. Use a long URI-safe Mongo password as described
in [Mongo setup](mongo-records.md). Both database and MinIO administration ports
remain private. From the repository root, for a **new** project:

```sh
docker compose -f compose.mongo.yaml -f compose.assets.yaml run --build --rm fieldops node app/physical-task-tracker/dist/task-records.js init /data my-farm --offline
docker compose -f compose.mongo.yaml -f compose.assets.yaml run --rm fieldops node app/physical-task-tracker/dist/task-assets.js init /data --offline
docker compose -f compose.mongo.yaml -f compose.assets.yaml up -d fieldops
```

The first two commands are explicit once-only initialization; the server refuses
to start with an uninitialized/pending selected backend. The existing project
volume persists the authority markers and any non-media application files.
Mongo records and MinIO objects each have their own persistent volume.
For an existing Mongo project with local media, stop its writers and replace
`task-assets ... init` with `task-assets.js import /data --offline`. Keep a backup
before import. Import preserves local originals and every existing media alias.
It is resumable; it never silently omits a nested directory or unsupported file.

For local `npm start` or external services, set `MONGODB_URI`, optional
`MONGODB_DATABASE`, `S3_ENDPOINT`, `S3_BUCKET`, `AWS_ACCESS_KEY_ID`,
`AWS_SECRET_ACCESS_KEY`, and optional `AWS_REGION`. Initialize/import the actual
project directory using `node app/physical-task-tracker/dist/task-assets.js`.
The marker binds the bucket and Mongo project ID; changing credentials or the
endpoint must still reach the same recorded keys and versions. The bucket must
be private, versioned, and dedicated (initialization rejects bucket policies and
shared/public ACLs). Use HTTPS for remote endpoints and provisioning credentials
only for setup; production runtime credentials need access only to the intended
project objects and records. The included Compose configuration uses development
admin credentials and a single-node Mongo replica set, not a high-availability
production deployment.

## Identity and failure recovery

- `asset:<filename>` documents in Mongo hold SHA-256, byte size, MIME, immutable
  object key, exact version ID, origin/parent assets and upload state. Names may
  not be rebound to different bytes. Source/process/step links keep those names.
- An upload reservation is committed **before** writing the object. States are
  pending, ready or failed. Readiness requires reading and verifying the full
  stored checksum, then committing the object version. A failed final database
  write leaves an inspectable reservation. Retrying the same bytes reuses the
  object; it does not create another object version.
- Playback and staging check the exact recorded version. A newer object version
  cannot replace historical evidence. Missing objects fail visibly, even if an
  old local file exists. Observed storage failures mark availability unavailable;
  a successful later probe clears it. No silent local fallback is permitted.
- To inspect stored assets: `node app/physical-task-tracker/dist/task-assets.js audit /absolute/project`.
  To finish an interrupted upload whose object exists:
  `node app/physical-task-tracker/dist/task-assets.js repair /absolute/project clip.mp4`.
  Repair verifies bytes before publishing readiness. A genuinely missing original
  object version requires storage recovery; repair cannot invent it.
- There is deliberately no automatic object deletion. Pending uploads and
  unreferenced previews remain inspectable with provenance. Retain historical
  object versions used by evidence; bucket lifecycle policies must not expire
  them. Coordinated Mongo/object backups and reference-aware garbage collection
  remain separate #80 work.

## FFmpeg and limits

FFmpeg and model adapters receive a checksum-verified temporary file. Each
project allows one media staging job at a time, coordinated across processes by
an exclusive directory. Uploads/individual assets are limited to 200 MiB;
generated previews are limited to 24 files of at most 8 MiB each. The staging
budget is 512 MiB. Completed and failed jobs remove their staging directory in
`finally`. After a killed process, stop all project writers and run:

```sh
node app/physical-task-tracker/dist/task-assets.js cleanup-staging /absolute/project --offline
```

This removes only temporary staging files, never S3 objects. An interrupted
analysis retains its original source and existing retry state. Segment GIFs
remain mapped to their sampled video intervals; inference quality is unchanged.

Standalone walkthrough reconstruction directories and future engineering
artifacts are not migrated by this stage. The implemented paths are video
capture/reanalysis, original-video playback, step-GIF review/backfill, and
compared visit images.

## Verification

Local tests cover immutable names, staging cleanup, streaming, suffix/open byte
ranges, HEAD, ETags and conditional requests. The existing storage CI also runs
`dist/lib/s3-assets.test.js` with `FIELDOPS_TEST_ASSETS=1` against real MongoDB,
MinIO and FFmpeg. It checks upload → replayed analysis → real step GIFs → review,
a fresh CLI process after deleting local files, exact-version playback despite
a newer object version, ranges, scope isolation, interrupted import and a
forced database failure after object upload. No live model calls are made.
