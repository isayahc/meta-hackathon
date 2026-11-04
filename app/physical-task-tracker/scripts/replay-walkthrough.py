"""Create a visibly synthetic walkthrough bundle for offline UI/contract testing."""
from __future__ import annotations

import json
from pathlib import Path
import sys
import tempfile
from typing import Any

import numpy as np
from PIL import Image, ImageDraw

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src" / "workers"))
from walkthrough import digest, run  # noqa: E402


def create_replay(out: Path) -> dict[str, Any]:
    """Generate two fictional views and masks; never invoke or impersonate a model."""
    with tempfile.TemporaryDirectory() as temp:
        images = []
        for i in range(2):
            path = Path(temp) / f"view-{i}.png"
            image = Image.new("RGB", (320, 240), "#e8e3d5")
            draw = ImageDraw.Draw(image)
            draw.rectangle((30 + 10 * i, 75, 270, 185), fill="#876443")
            draw.rectangle((45 + 10 * i, 85, 140, 130), fill="#76926b")
            draw.text((10, 10), "SYNTHETIC REPLAY - NO MODEL INFERENCE", fill="black")
            image.save(path)
            images.append(str(path))
        report = run({"schema": "walkthrough-request/1", "mode": "capture", "images": images, "max_frames": 2}, out)
    report.update({"source": "replay", "status": "inferred"})
    report["warnings"].insert(0, "Entire reconstruction and segmentation are synthetic fixtures, not measured or inferred results.")
    for i, frame in enumerate(report["frames"]):
        frame.update({"model_image": frame["file"], "model_width": 320, "model_height": 240, "geometry": f"frame-{i}-geometry.npz"})
        y, x = np.mgrid[:240, :320]
        points = np.stack((x / 100, y / 100, np.ones_like(x)), axis=-1).astype(np.float32)
        np.savez_compressed(out / frame["geometry"], pts3d=points[None], depth_z=np.ones((1, 240, 320, 1)),
                            mask=np.ones((1, 240, 320, 1)), intrinsics=np.eye(3)[None], camera_poses=np.eye(4)[None], conf=np.ones((1, 240, 320)))
        mask = np.zeros((240, 320), dtype=np.uint8); mask[75:185, 30:270] = 255
        mask_file, overlay_file = f"observation-{i}-mask.png", f"observation-{i}-overlay.png"
        Image.fromarray(mask).save(out / mask_file)
        with Image.open(out / frame["file"]) as image:
            overlay = image.convert("RGB"); ImageDraw.Draw(overlay).rectangle((30, 75, 270, 185), outline="orange", width=5); overlay.save(out / overlay_file)
        report["observations"].append({"id": f"observation-{i}", "frame_id": frame["id"], "prompt": "workbench" if i == 0 else "person",
            "score": .85, "box": [30, 75, 270, 185], "mask": mask_file, "overlay": overlay_file,
            "motion": "unverified" if i == 0 else "dynamic", "track_id": None, "entity_id": None,
            "predicted_centroid": [1.5, 1.3, 1.0], "point_count": 26400, "valid_fraction": 1.0, "geometry_status": "predicted"})
    report["stats"]["fixture"] = "synthetic; no inference runtime or accuracy result"
    report["artifacts"] = [{"file": p.name, "sha256": digest(p)} for p in sorted(out.iterdir()) if p.is_file() and p.name != "run.json"]
    (out / "run.json").write_text(json.dumps(report, indent=2), encoding="utf-8")
    return report


if __name__ == "__main__":
    if len(sys.argv) != 2:
        raise SystemExit("Usage: python scripts/replay-walkthrough.py <new-bundle-directory>")
    create_replay(Path(sys.argv[1]).resolve())
    print(json.dumps({"manifest": str(Path(sys.argv[1]).resolve() / "run.json"), "source": "replay"}))
