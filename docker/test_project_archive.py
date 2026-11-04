"""Offline backup behavior: WAL recovery, media preservation and rejected restores."""
from __future__ import annotations

import sqlite3
import tempfile
import unittest
from pathlib import Path

from project_archive import backup_project, restore_project


class ProjectArchiveTests(unittest.TestCase):
    """Exercise the real SQLite backup API with committed WAL content."""

    def test_wal_media_restore_and_reject_overwrite(self) -> None:
        """A consistent stopped-writer snapshot preserves DB and opaque future data."""
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            project = root / 'source'
            (project / 'media').mkdir(parents=True)
            (project / 'media' / 'clip.mp4').write_bytes(b'original fixture')
            (project / 'media' / 'step.gif').write_bytes(b'gif fixture')
            (project / 'checkpoint.json').write_text('{"pending": true}', encoding='utf-8')
            # Keep a connection open without writes to ensure a WAL exists during backup.
            db = sqlite3.connect(project / 'fieldops.db')
            try:
                db.execute('PRAGMA journal_mode=WAL')
                db.execute('CREATE TABLE docs(body TEXT)')
                db.execute("INSERT INTO docs VALUES('reviewed correction and memory')")
                db.commit()
                backup_project(project, root / 'backup')
            finally:
                db.close()
            restore_project(root / 'backup', root / 'restored')
            with sqlite3.connect(root / 'restored' / 'fieldops.db') as restored:
                self.assertEqual(restored.execute('SELECT body FROM docs').fetchone()[0],
                                 'reviewed correction and memory')
            self.assertEqual((root / 'restored/media/clip.mp4').read_bytes(), b'original fixture')
            self.assertEqual((root / 'restored/checkpoint.json').read_text(), '{"pending": true}')
            with self.assertRaisesRegex(ValueError, 'empty'):
                restore_project(root / 'backup', root / 'restored')
            (root / 'backup/project/media/clip.mp4').write_bytes(b'corrupted')
            with self.assertRaisesRegex(ValueError, 'checksums'):
                restore_project(root / 'backup', root / 'bad-restore')
            self.assertFalse((root / 'bad-restore').exists())

    def test_reject_symlinks_and_overlap(self) -> None:
        """Do not follow external files or recursively copy backup directories."""
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            project = root / 'source'
            project.mkdir()
            with sqlite3.connect(project / 'fieldops.db') as db:
                db.execute('CREATE TABLE docs(body TEXT)')
            with self.assertRaisesRegex(ValueError, 'overlap'):
                backup_project(project, project / 'nested')
            (project / 'link').symlink_to(root / 'outside')
            with self.assertRaisesRegex(ValueError, 'Unsupported'):
                backup_project(project, root / 'backup')


if __name__ == '__main__':
    unittest.main()
