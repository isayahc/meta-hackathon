# Docker deployment and recovery

Field Ops runs as one application container with Node 22, FFmpeg, Python's standard library and the built dashboard. Docker is optional for development: root `npm install` / `npm start` still works. The default container deployment is local and single-user; it does not add authentication or production TLS.

## Start (Windows/WSL2 or Linux)

Install Docker Engine with Compose v2 on Linux, or Docker Desktop using Linux containers and the WSL2 backend on Windows. In WSL2 enable integration for your distribution. Open a terminal at the repository root:

```sh
docker compose up --build -d
docker compose ps
docker compose logs --tail 50 fieldops
```

Open http://localhost:8123. No automatic browser launch occurs inside Docker. On Windows these Docker commands also work in PowerShell. Change the host port via `FIELDOPS_PORT` (PowerShell: `$env:FIELDOPS_PORT = '8124'`; WSL2/Linux: `export FIELDOPS_PORT=8124`). The application listens on `0.0.0.0` inside the container; Compose publishes only on host `127.0.0.1`.

The image runs as `node` (UID/GID 1000). Newly created named volumes inherit the image directory ownership. Existing bind mounts must be writable by that UID; fix ownership on the intended directory rather than making the container privileged. There is one writer service; do not scale it to multiple instances against this project volume.

## Persistent storage

| Mount | Default volume | Contents |
| --- | --- | --- |
| `/data` | `fieldops-project` | SQLite, original media, generated GIFs, process revisions, tasks, decisions and future project memory/checkpoints |
| `/config` | `fieldops-credentials` | Existing saved-key configuration, outside project backups |

Set `FIELDOPS_DATA_VOLUME` / `FIELDOPS_CONFIG_VOLUME` to use different named volumes, especially for a second installation. A fresh container does not import the local `app/physical-task-tracker/my-farm` folder automatically. Use the offline archive command below to migrate existing projects.

`docker compose stop`, `down` (without `-v`), or `up --force-recreate` preserves named volumes. **`down -v` deletes them.** Rebuilding an image does not back up data. Future memory/checkpoint records will be preserved if stored under `/data`; their behavioral implementation and actual agent resume remain #72/#73.

## Keys and optional integrations

Start and inspect existing records without a model key. For inference, either enter a key using the existing local UI (persisted in `/config`) or supply `META_API_KEY` in your shell before starting Compose. `META_API_BASE` and `META_MODEL` can also be supplied. Do not put keys in Dockerfiles, build arguments, committed env files or image layers. Keep the host port private: the app's existing key-management API is not a multi-user authentication system.

For a runtime file secret, add an uncommitted Compose override:

```yaml
services:
  fieldops:
    environment:
      META_API_KEY_FILE: /run/secrets/meta_api_key
    secrets:
      - meta_api_key
secrets:
  meta_api_key:
    file: /absolute/path/outside/repository/meta-api-key.txt
```

Start with `docker compose -f compose.yaml -f /absolute/path/secret-override.yaml up -d`. The entrypoint reads the file without logging it; a nonempty `META_API_KEY` takes precedence. Environment/file keys are not copied into `/config`. Saved UI credentials need a separate secure backup if you want to retain them.

Meta inference remains external. OI and optional GPU perception/model dependencies are **not included**. The present OI connector expects a compatible checkout/runtime via its existing `OI_ROOT` configuration, not an invented HTTP service. Supply reviewed mounts/dependencies through an override when integrating it. Optional Python GPU workers require their documented additional packages/models. The base image supports video/FFmpeg and app persistence; it does not claim a complete GPU stack.

## Readiness and shutdown

`/healthz` checks database compatibility and returns its schema version without calling a model. The image healthcheck probes that endpoint. Startup initializes/migrates the database before listening; a permissions error, corrupt database or unsupported version prevents readiness. The healthcheck assumes internal port 8123; changing it requires updating the probe too.

Compose runs an init process and allows 30 seconds to stop. SIGTERM/SIGINT stops accepting connections and drains active requests. A 25-second application deadline exits with an error if work is still running. Interrupted model jobs may need explicit retry; automatic checkpoint recovery is not yet implemented. Stop every app, CLI and external process writing a project before backup or restore.

## Offline backup

This procedure briefly stops the app to keep media and database state consistent. The archive tool uses SQLite's backup API, includes committed WAL data, verifies integrity and writes a SHA-256 manifest. It copies all project files except the raw database/journals, replacing those with the consolidated database snapshot. It rejects symlinks/special files and nested source/destination paths.

Choose a unique backup directory name each time (the tool refuses overwrite):

```sh
docker compose stop fieldops
docker volume create fieldops-backups
docker compose run --rm --user 0 -v fieldops-backups:/backups fieldops chown 1000:1000 /backups
docker compose run --rm -v fieldops-backups:/backups fieldops python3 /app/docker/project_archive.py backup /data /backups/before-upgrade --offline
docker compose up -d
```

`--offline` is your acknowledgement that **all writers** are stopped, not an automatic lock against other processes. The tool never logs file contents or keys. The separate `/config` volume is excluded, but any sensitive files you deliberately put inside `/data` will be in the archive. Keep archives private.

The backup volume is still on the same Docker host. Export it off-host for disaster recovery. For example, create a stopped helper, copy the archive, then remove only the helper:

```sh
docker create --name fieldops-backup-export -v fieldops-backups:/backups fieldops:local true
docker cp fieldops-backup-export:/backups/before-upgrade ./fieldops-backup-before-upgrade
docker rm fieldops-backup-export
```

For a non-container project, stop its app/CLIs and use Python 3:

```sh
python3 /absolute/repo/docker/project_archive.py backup /absolute/project /absolute/backups/project-snapshot --offline
```

On Windows use `python` and absolute Windows paths. Copy that archive into the backup volume before following the restore procedure.

## Restore and upgrade

Restore into a **fresh** project volume; never overwrite the current project. The tool verifies the full manifest and database before copying. It refuses a nonempty destination, mismatched checksums and unsupported filesystem entries.

```sh
docker compose stop fieldops
docker volume create fieldops-restored
docker run --rm -v fieldops-restored:/data -v fieldops-backups:/backups:ro fieldops:local python3 /app/docker/project_archive.py restore /backups/before-upgrade /data --offline
```

Set `FIELDOPS_DATA_VOLUME=fieldops-restored` in your shell (PowerShell: `$env:FIELDOPS_DATA_VOLUME = 'fieldops-restored'`; WSL2/Linux: `export FIELDOPS_DATA_VOLUME=fieldops-restored`), then `docker compose up -d`. Verify the dashboard, original media, GIFs and task state before retiring the old volume. Existing records and credentials remain in their original volumes until explicitly removed.

For upgrades: stop writers, take a backup, retain the old image ID/tag, build the new image, then start it against the chosen project volume. SQLite `user_version=1` identifies the current schema. Previously unversioned stores upgrade in one transaction; failure rolls back changes. Newer schema versions are refused before migration. Future releases must increment the version and define migration steps. Downgrade by restoring the pre-upgrade archive and using the prior image; do not point older code at a newer store (older releases may not contain the version guard).

The image uses `node:22-bookworm-slim` and Debian packages plus the committed npm lockfile. This stabilizes the major runtime/dependency set, but is not a bit-for-bit immutable build. For a release, pin `NODE_IMAGE` to a tested digest with `docker build --build-arg NODE_IMAGE=node@sha256:...`, retain the built image digest, and record the package inventory. Do not substitute an unverified digest.

## Verification

`npm test` exercises migration refusal/rollback, health via the real request handler, mocked socket startup/shutdown, and the Python archive tests. It does not start a listening server.

On a Docker-capable host:

```sh
python3 /absolute/repo/docker/smoke.py
```

This builds the image, generates real FFmpeg MP4/GIF fixtures, retains a corrected workflow and canonical task using injected analysis, checks health/SIGTERM, replaces the container twice, archives the stopped project, restores into a fresh volume and verifies IDs, revisions and file hashes. It cleans only its uniquely named test containers/volumes/image. Opaque memory/checkpoint fixture records prove storage durability, not agent recovery. No live model calls are made. The Container and recovery GitHub workflow runs the same check on pull requests.

Docker/Compose reference: https://docs.docker.com/reference/compose-file/services/
Runtime file secrets: https://docs.docker.com/compose/how-tos/use-secrets/
