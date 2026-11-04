"""CPU-only worker regression tests. No downloads, credentials, GPU or inference."""
from __future__ import annotations

import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

import numpy as np
from PIL import Image, ImageDraw
from walkthrough import ground_mask, run, sharpness


class WalkthroughTests(unittest.TestCase):
    """Verify source identity, missing geometry, and honest failure reporting."""

    def setUp(self) -> None:
        """Create independent input images for each case."""
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.images = []
        for i in range(4):
            image = Image.new("RGB", (64, 64), "white")
            if i % 2:
                ImageDraw.Draw(image).rectangle((10 + i, 10, 40, 40), fill="black")
            path = self.root / f"image-{i}.png"; image.save(path); self.images.append(str(path))

    def request(self, mode: str = "capture") -> dict:
        """Build a valid bounded image capture request."""
        return {"schema": "walkthrough-request/1", "mode": mode, "images": self.images, "max_frames": 2}

    def test_sharp_selection_retains_source_indices(self) -> None:
        """Select the sharper source within each bin without reindexing evidence."""
        report = run(self.request(), self.root / "out")
        self.assertEqual([f["source_index"] for f in report["frames"]], [1, 3])
        self.assertTrue(all(f["timestamp_s"] is None for f in report["frames"]))
        self.assertEqual(report["source"], "capture")
        self.assertEqual(report["observations"], [])
        self.assertEqual(sharpness(Image.new("RGB", (64, 64), "white")), 0)

    def test_missing_live_runtime_never_falls_back_to_replay(self) -> None:
        """Retain captured evidence and a failed status when models are unavailable."""
        with patch.dict("os.environ", {"MAPANYTHING_ROOT": ""}):
            report = run(self.request("live"), self.root / "out")
        self.assertEqual(report["status"], "failed")
        self.assertEqual(report["source"], "capture")
        self.assertEqual(report["observations"], [])
        self.assertIn("MAPANYTHING_ROOT", report["error"])

    def test_mask_grounding_ignores_nonfinite_or_missing_depth(self) -> None:
        """Only valid aligned depth samples may contribute a predicted centroid."""
        points = np.ones((2, 2, 3)); points[0, 0] = np.nan
        depth = np.ones((2, 2)); depth[0, 1] = 0
        valid = np.ones((2, 2), bool); mask = np.ones((2, 2), bool)
        result = ground_mask(points, depth, valid, mask)
        self.assertEqual(result["point_count"], 2)
        self.assertEqual(result["valid_fraction"], .5)
        self.assertEqual(result["predicted_centroid"], [1, 1, 1])
        depth[:] = 0
        self.assertEqual(ground_mask(points, depth, valid, mask)["geometry_status"], "missing_depth")
        with self.assertRaises(ValueError):
            ground_mask(points, depth, valid, np.ones((3, 3), bool))

    def test_real_video_preserves_decoded_frame_timestamps(self) -> None:
        """Exercise ffmpeg/ffprobe against a generated 3 fps clip, not a model mock."""
        video = self.root / "clip.mp4"
        subprocess.run(["ffmpeg", "-v", "error", "-f", "lavfi", "-i", "testsrc2=size=64x64:rate=3:duration=2", "-c:v", "mpeg4", str(video)], check=True)
        report = run({"schema": "walkthrough-request/1", "mode": "capture", "video": str(video), "max_frames": 2}, self.root / "out")
        for frame in report["frames"]:
            self.assertAlmostEqual(frame["timestamp_s"], frame["source_index"] / 3, places=5)
        self.assertEqual(report["sources"][0]["kind"], "video")

    def test_invalid_requests_and_duplicate_views(self) -> None:
        """Invalid requests fail and duplicated captures do not imply overlap quality."""
        request = self.request(); request["max_frames"] = 99
        with self.assertRaises(ValueError): run(request, self.root / "invalid")
        request = self.request(); request["images"] = [self.images[1], self.images[1]]
        report = run(request, self.root / "duplicates")
        self.assertTrue(any("duplicates" in warning for warning in report["warnings"]))

    def test_worker_stdout_is_json(self) -> None:
        """Capture diagnostics cannot contaminate the CLI result stream."""
        request_path = self.root / "request.json"; request_path.write_text(json.dumps(self.request()))
        result = subprocess.run([sys.executable, str(Path(__file__).with_name("walkthrough.py")), str(request_path), str(self.root / "out")], capture_output=True, text=True, check=True)
        self.assertEqual(json.loads(result.stdout), {"status": "captured"})


if __name__ == "__main__":
    unittest.main()
