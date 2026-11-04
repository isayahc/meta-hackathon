"""Offline project backup/restore. Stop every writer before invoking either command."""
from __future__ import annotations

import argparse
import hashlib
import json
import shutil
import sqlite3
import tempfile
from pathlib import Path
from typing import Any


def inventory(root: Path) -> dict[str, str]:
    """Hash every regular file and reject links or special filesystem entries."""
    result: dict[str, str] = {}
    for path in sorted(root.rglob('*')):
        if path.is_symlink() or not (path.is_file() or path.is_dir()):
            raise ValueError(f'Unsupported filesystem entry: {path.name}')
        if path.is_file():
            digest = hashlib.sha256()
            with path.open('rb') as stream:
                for chunk in iter(lambda: stream.read(1024 * 1024), b''):
                    digest.update(chunk)
            result[path.relative_to(root).as_posix()] = digest.hexdigest()
    return result


def check_database(path: Path) -> None:
    """Verify the SQLite snapshot without migrating it or changing its journal mode."""
    with sqlite3.connect(path.as_uri() + '?mode=ro', uri=True) as connection:
        result = connection.execute('PRAGMA integrity_check').fetchall()
        if result != [('ok',)]:
            raise ValueError('Database integrity check failed')


def separate(source: Path, destination: Path) -> None:
    """Reject overlapping paths so a backup cannot recursively include itself."""
    if source == destination or source in destination.parents or destination in source.parents:
        raise ValueError('Source and destination must not overlap')


def backup_project(source: Path, destination: Path) -> None:
    """Copy a stopped project and consolidate SQLite, including committed WAL data."""
    source, destination = source.resolve(), destination.resolve()
    separate(source, destination)
    if not (source / 'fieldops.db').is_file():
        raise ValueError('Source must contain fieldops.db')
    if destination.exists():
        raise ValueError('Backup destination must not already exist')
    inventory(source)
    destination.parent.mkdir(parents=True, exist_ok=True)
    temporary = Path(tempfile.mkdtemp(prefix='.fieldops-backup-', dir=destination.parent))
    try:
        project = temporary / 'project'
        shutil.copytree(source, project, ignore=lambda directory, names: [
            n for n in names if Path(directory) == source and n in
            {'fieldops.db', 'fieldops.db-wal', 'fieldops.db-shm', 'fieldops.db-journal'}])
        with sqlite3.connect((source / 'fieldops.db').as_uri() + '?mode=ro', uri=True) as original:
            with sqlite3.connect(project / 'fieldops.db') as snapshot:
                original.backup(snapshot)
                snapshot.execute('PRAGMA journal_mode=DELETE')
        check_database(project / 'fieldops.db')
        manifest: dict[str, Any] = {'format': 'fieldops-offline-backup/1', 'files': inventory(project)}
        (temporary / 'manifest.json').write_text(json.dumps(manifest, indent=2), encoding='utf-8')
        temporary.rename(destination)
    except BaseException:
        shutil.rmtree(temporary, ignore_errors=True)
        raise


def restore_project(source: Path, destination: Path) -> None:
    """Validate an archive fully before restoring to a new or empty stopped project."""
    source, destination = source.resolve(), destination.resolve()
    separate(source, destination)
    if destination.exists() and (not destination.is_dir() or any(destination.iterdir())):
        raise ValueError('Restore destination must be empty; existing projects are never overwritten')
    inventory(source)
    manifest = json.loads((source / 'manifest.json').read_text(encoding='utf-8'))
    project = source / 'project'
    if manifest.get('format') != 'fieldops-offline-backup/1' or manifest.get('files') != inventory(project):
        raise ValueError('Backup manifest or checksums do not match')
    check_database(project / 'fieldops.db')
    destination.mkdir(parents=True, exist_ok=True)
    try:
        shutil.copytree(project, destination, dirs_exist_ok=True)
    except BaseException:
        # Destination was empty before restoration; no original data is removed.
        for child in destination.iterdir():
            shutil.rmtree(child) if child.is_dir() else child.unlink()
        raise


def main() -> None:
    """Parse the explicit offline acknowledgement and execute one operation."""
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('command', choices=['backup', 'restore'])
    parser.add_argument('source', type=Path)
    parser.add_argument('destination', type=Path)
    parser.add_argument('--offline', action='store_true', required=True,
                        help='Confirm all application, CLI, and external writers are stopped')
    args = parser.parse_args()
    operation = backup_project if args.command == 'backup' else restore_project
    operation(args.source, args.destination)
    print(json.dumps({'status': 'ok', 'operation': args.command, 'destination': str(args.destination)}))


if __name__ == '__main__':
    main()
