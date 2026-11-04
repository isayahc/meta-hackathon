"""Build and verify Docker on a Docker-capable host using disposable named volumes."""
from __future__ import annotations

import json
import subprocess
import time
import uuid
from pathlib import Path


def run(*arguments: str) -> str:
    """Run Docker without a shell and raise on failed operations."""
    result = subprocess.run(['docker', *arguments], check=True, text=True, stdout=subprocess.PIPE)
    return result.stdout.strip()


def healthy(container: str) -> None:
    """Wait at most 90 seconds for the image's real HTTP/database readiness probe."""
    for _ in range(90):
        status = run('inspect', '--format', '{{.State.Health.Status}}', container)
        if status == 'healthy':
            return
        if status == 'unhealthy':
            break
        time.sleep(1)
    raise RuntimeError('Container did not become healthy: ' + run('logs', container))


def main() -> None:
    """Exercise replacement, offline backup and fresh-volume restoration; always clean up."""
    root = Path(__file__).resolve().parent.parent
    tag = 'fieldops-smoke-' + uuid.uuid4().hex[:12]
    image = tag + ':test'
    volumes = [tag + suffix for suffix in ('-data', '-backup', '-restored')]
    container = tag + '-app'
    run('build', '--tag', image, str(root))
    try:
        for volume in volumes:
            run('volume', 'create', volume)
        # Populate volume ownership as the image does for a new /data volume.
        def job(volume: str, *command: str, extra: tuple[str, ...] = ()) -> str:
            """Run a maintenance process with the application's UID and persisted project."""
            return run('run', '--rm', '-v', volume + ':/data', *extra, image, *command)
        job(volumes[0], 'node', '/app/docker/fixture.mjs', 'seed')
        for _ in range(2):
            run('run', '-d', '--name', container, '--init', '-v', volumes[0] + ':/data', image)
            healthy(container)
            run('exec', container, 'node', '/app/docker/fixture.mjs', 'verify')
            run('stop', '--time', '30', container)
            code = run('inspect', '--format', '{{.State.ExitCode}}', container)
            if code != '0':
                raise RuntimeError('Unclean shutdown: ' + code)
            run('rm', container)
        # Backup destination is a separate volume. Give the non-root user access once.
        run('run', '--rm', '--user', '0', '-v', volumes[1] + ':/backups', image,
            'chown', '1000:1000', '/backups')
        job(volumes[0], 'python3', '/app/docker/project_archive.py', 'backup', '/data', '/backups/snapshot', '--offline',
            extra=('-v', volumes[1] + ':/backups'))
        job(volumes[2], 'python3', '/app/docker/project_archive.py', 'restore', '/backups/snapshot', '/data', '--offline',
            extra=('-v', volumes[1] + ':/backups:ro'))
        run('run', '-d', '--name', container, '--init', '-v', volumes[2] + ':/data', image)
        healthy(container)
        run('exec', container, 'node', '/app/docker/fixture.mjs', 'verify')
        run('stop', '--time', '30', container)
        run('rm', container)
        print(json.dumps({'passed': True, 'inference': 'synthetic replay',
                          'checks': ['image build', 'FFmpeg', 'health', 'non-root writes', 'SIGTERM',
                                     'container replacement', 'backup', 'fresh-volume restore']}))
    finally:
        subprocess.run(['docker', 'rm', '-f', container], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        for volume in volumes:
            subprocess.run(['docker', 'volume', 'rm', volume], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        subprocess.run(['docker', 'image', 'rm', image], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)


if __name__ == '__main__':
    main()
