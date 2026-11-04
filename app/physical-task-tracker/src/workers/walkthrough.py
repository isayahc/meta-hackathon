"""Bounded local capture and pinned MapAnything/SAM 3 inference worker.

Input/output are versioned JSON files. No remote inference, automatic download,
scene mutation, identity merging, calibration fitting, or replay fallback.
"""
from __future__ import annotations

import contextlib
import hashlib
import importlib.metadata
import json
import math
import os
from pathlib import Path
import platform
import re
import shutil
import subprocess
import sys
import time
from typing import Any

import numpy as np
from PIL import Image, ImageOps

MAP_PIN = "3d10cf7a3016fc0f9bb13a071ee66c47b10be0d9"
SAM_PIN = "f1647e8d0c1d280991f4d1b7d974c2704537fe66"


def digest(path: Path) -> str:
    """Hash exact artifact bytes without loading model weights into memory."""
    h = hashlib.sha256()
    with path.open("rb") as handle:
        for block in iter(lambda: handle.read(1024 * 1024), b""):
            h.update(block)
    return h.hexdigest()


def command(args: list[str], timeout: int = 120) -> str:
    """Run a bounded local command without a shell."""
    return subprocess.run(args, check=True, capture_output=True, text=True, timeout=timeout).stdout


def sharpness(image: Image.Image) -> float:
    """Return a reproducible Laplacian-variance diagnostic, not an accuracy claim."""
    gray = np.asarray(image.convert("L").resize((256, 256)), dtype=np.float32)
    laplace = 4 * gray[1:-1, 1:-1] - gray[:-2, 1:-1] - gray[2:, 1:-1] - gray[1:-1, :-2] - gray[1:-1, 2:]
    return float(laplace.var())


def capture(request: dict[str, Any], out: Path) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    """Select sharp candidates per temporal bin while retaining original indices/PTS."""
    count = request.get("max_frames", 6)
    if not isinstance(count, int) or isinstance(count, bool) or not 2 <= count <= 12:
        raise ValueError("max_frames must be an integer from 2 to 12")
    inputs = request.get("images", [])
    video = request.get("video")
    if bool(inputs) == bool(video):
        raise ValueError("Provide images OR video")
    candidates: list[dict[str, Any]] = []
    sources: list[dict[str, Any]] = []
    if video:
        src = Path(video).resolve(strict=True)
        meta = json.loads(command(["ffprobe", "-v", "error", "-show_format", "-show_streams", "-of", "json", str(src)]))
        duration = float(meta["format"]["duration"])
        if not math.isfinite(duration) or not 0 < duration <= 120:
            raise ValueError("Walkthrough clips must be at most 120 seconds")
        rows = json.loads(command(["ffprobe", "-v", "error", "-select_streams", "v:0", "-show_frames", "-show_entries", "frame=best_effort_timestamp_time", "-of", "json", str(src)]))["frames"]
        if not 2 <= len(rows) <= 20000:
            raise ValueError("Unsupported decoded frame count")
        shutil.copyfile(src, out / "source-video.bin")
        sources.append({"file": "source-video.bin", "sha256": digest(out / "source-video.bin"), "kind": "video", "duration_s": duration})
        indices = sorted(set(np.linspace(0, len(rows) - 1, min(len(rows), count * 3), dtype=int).tolist()))
        for i in indices:
            timestamp = float(rows[i]["best_effort_timestamp_time"])
            if not math.isfinite(timestamp) or timestamp < 0:
                raise ValueError("Invalid source timestamp")
            file = f"candidate-{i}.png"
            command(["ffmpeg", "-v", "error", "-i", str(src), "-vf", f"select=eq(n\\,{i})", "-frames:v", "1", "-y", str(out / file)])
            candidates.append({"source_index": i, "timestamp_s": timestamp, "file": file})
    else:
        if not isinstance(inputs, list) or not 2 <= len(inputs) <= 36:
            raise ValueError("Provide 2–36 overlapping images")
        for i, path in enumerate(inputs):
            src = Path(path).resolve(strict=True)
            raw = f"source-{i}.bin"
            shutil.copyfile(src, out / raw)
            sources.append({"file": raw, "sha256": digest(out / raw), "kind": "image", "source_index": i})
            file = f"candidate-{i}.png"
            with Image.open(src) as original:
                image = ImageOps.exif_transpose(original).convert("RGB")
                image.save(out / file)
            candidates.append({"source_index": i, "timestamp_s": None, "file": file})
    for candidate in candidates:
        with Image.open(out / candidate["file"]) as image:
            candidate.update({"sharpness": sharpness(image), "width": image.width, "height": image.height})
    selected = []
    for group in np.array_split(np.arange(len(candidates)), min(count, len(candidates))):
        best = max((candidates[int(i)] for i in group), key=lambda f: f["sharpness"])
        best["id"] = f"frame-{best['source_index']}"
        best["sha256"] = digest(out / best["file"])
        selected.append(best)
    return selected, sources


def local_model_config() -> dict[str, Any]:
    """Require local approved checkpoints and exact source revisions; never download."""
    config: dict[str, Any] = {}
    for name, pin in [("MAPANYTHING", MAP_PIN), ("SAM3", SAM_PIN)]:
        raw = os.environ.get(f"{name}_ROOT")
        if not raw:
            raise ValueError(f"{name}_ROOT is required for live inference")
        root = Path(raw).resolve(strict=True)
        actual = command(["git", "-C", str(root), "rev-parse", "HEAD"]).strip()
        if actual != pin or command(["git", "-C", str(root), "status", "--porcelain", "--untracked-files=no"]).strip():
            raise ValueError(f"{name} requires an unmodified checkout at {pin}")
        sys.path.insert(0, str(root))
        config[name] = {"code_revision": actual}
    from huggingface_hub import snapshot_download
    revisions = {name: os.environ.get(f"{name}_REVISION", "") for name in ("MAPANYTHING", "SAM3")}
    if not all(re.fullmatch(r"[a-f0-9]{40}", revision) for revision in revisions.values()):
        raise ValueError("MAPANYTHING_REVISION and SAM3_REVISION must be exact checkpoint commit hashes")
    map_path = Path(snapshot_download(repo_id="facebook/map-anything-apache", revision=revisions["MAPANYTHING"], local_files_only=True))
    sam_path = Path(snapshot_download(repo_id="facebook/sam3", revision=revisions["SAM3"], local_files_only=True)) / "sam3.pt"
    config["MAPANYTHING"]["checkpoint_revision"] = revisions["MAPANYTHING"]
    config["SAM3"]["checkpoint_revision"] = revisions["SAM3"]
    # Hash every checkpoint/config file, so revision and actual weights are auditable.
    weights = sorted(p for p in map_path.rglob("*") if p.is_file())
    if not weights:
        raise ValueError("Empty MapAnything checkpoint directory")
    config["MAPANYTHING"].update({"checkpoint": "facebook/map-anything-apache", "artifacts": [{"file": str(p.relative_to(map_path)), "sha256": digest(p)} for p in weights]})
    config["SAM3"].update({"checkpoint": "facebook/sam3", "sha256": digest(sam_path)})
    config["map_path"], config["sam_path"] = str(map_path), str(sam_path)
    return config


def ground_mask(points: np.ndarray, depth: np.ndarray, valid: np.ndarray, mask: np.ndarray) -> dict[str, Any]:
    """Associate an aligned mask with predicted world points, preserving missing depth."""
    if points.shape != (*mask.shape, 3) or depth.shape != mask.shape or valid.shape != mask.shape:
        raise ValueError("Mask/depth/point image coordinates do not align")
    usable = mask & valid & np.isfinite(points).all(axis=-1) & np.isfinite(depth) & (depth > 0)
    n = int(usable.sum())
    return {"point_count": n, "valid_fraction": n / max(1, int(mask.sum())),
            "predicted_centroid": np.median(points[usable], axis=0).tolist() if n else None,
            "geometry_status": "predicted" if n else "missing_depth"}


def infer(frames: list[dict[str, Any]], request: dict[str, Any], out: Path) -> tuple[list[dict[str, Any]], dict[str, Any]]:
    """Run the pinned image-only APIs; masks use the exact reconstructed image grid."""
    config = local_model_config()
    provenance = {key: value for key, value in config.items() if key not in ("map_path", "sam_path")}
    (out / "model-provenance.json").write_text(json.dumps(provenance, indent=2), encoding="utf-8")
    os.environ["HF_HUB_OFFLINE"] = "1"
    os.environ["TRANSFORMERS_OFFLINE"] = "1"
    import torch
    from mapanything.models import MapAnything
    from mapanything.utils.image import load_images
    from sam3.model_builder import build_sam3_image_model
    from sam3.model.sam3_image_processor import Sam3Processor

    device = os.environ.get("WALKTHROUGH_DEVICE", "cuda")
    if device not in ("cpu", "cuda") or (device == "cuda" and not torch.cuda.is_available()):
        raise ValueError("Requested device unavailable; no automatic CPU or replay fallback")
    if device == "cuda":
        torch.cuda.reset_peak_memory_stats()
    start = time.perf_counter()
    model = MapAnything.from_pretrained(config.pop("map_path"), local_files_only=True).to(device).eval()
    views = load_images([str(out / f["file"]) for f in frames])
    with torch.inference_mode():
        predictions = model.infer(views, memory_efficient_inference=True, minibatch_size=1, use_amp=device == "cuda", apply_mask=True)
    if len(predictions) != len(frames):
        raise ValueError("Model frame count mismatch")
    # Persist tensor outputs before releasing the reconstruction model's GPU memory.
    for f, pred in zip(frames, predictions):
        arrays = {k: v.detach().cpu().float().numpy() for k, v in pred.items() if torch.is_tensor(v)}
        for key in ("pts3d", "depth_z", "mask", "intrinsics", "camera_poses", "conf", "img_no_norm"):
            if key not in arrays:
                raise ValueError(f"Pinned MapAnything output missing {key}")
        raw = f"{f['id']}-geometry.npz"
        np.savez_compressed(out / raw, **arrays)
        f["geometry"] = raw
        image = arrays["img_no_norm"][0]
        if image.ndim != 3 or image.shape[-1] != 3 or not np.isfinite(image).all():
            raise ValueError("Invalid reconstructed RGB grid")
        if image.max() <= 1.0:
            image = image * 255
        f["model_image"] = f"{f['id']}-model.png"
        Image.fromarray(np.clip(image, 0, 255).astype(np.uint8)).save(out / f["model_image"])
        f["model_width"], f["model_height"] = int(image.shape[1]), int(image.shape[0])
    del predictions, model, views
    if device == "cuda":
        torch.cuda.empty_cache()
    sam = build_sam3_image_model(checkpoint_path=config.pop("sam_path"), load_from_HF=False, device=device)
    processor = Sam3Processor(sam, device=device)
    observations: list[dict[str, Any]] = []
    for f in frames:
        with Image.open(out / f["model_image"]) as image, np.load(out / f["geometry"], allow_pickle=False) as geometry:
            state = processor.set_image(image)
            for prompt in request["prompts"]:
                processor.reset_all_prompts(state)
                result = processor.set_text_prompt(prompt=prompt, state=state)
                masks = result["masks"].detach().cpu().numpy()
                scores = result["scores"].detach().cpu().numpy()
                boxes = result["boxes"].detach().cpu().numpy()
                if len(masks) > 100:
                    raise ValueError("Too many mask candidates; narrow prompts")
                for index, raw_mask in enumerate(masks):
                    mask = raw_mask.reshape(image.height, image.width).astype(bool)
                    oid = f"observation-{len(observations)}"
                    mask_file = f"{oid}-mask.png"
                    Image.fromarray(mask.astype(np.uint8) * 255).save(out / mask_file)
                    overlay = np.asarray(image.convert("RGB")).copy()
                    overlay[mask] = (overlay[mask].astype(float) * .5 + np.array([255, 130, 0]) * .5).astype(np.uint8)
                    overlay_file = f"{oid}-overlay.png"
                    Image.fromarray(overlay).save(out / overlay_file)
                    grounding = ground_mask(geometry["pts3d"][0], geometry["depth_z"][0, ..., 0], geometry["mask"][0, ..., 0].astype(bool), mask)
                    score = float(scores[index])
                    box = boxes[index].tolist()
                    if not math.isfinite(score) or not all(math.isfinite(v) for v in box):
                        raise ValueError("Non-finite SAM output")
                    observations.append({"id": oid, "frame_id": f["id"], "prompt": prompt, "score": score, "box": box,
                        "mask": mask_file, "overlay": overlay_file, "motion": "dynamic" if prompt.lower() == "person" else "unverified",
                        "track_id": None, "entity_id": None, **grounding})
    if device == "cuda":
        torch.cuda.synchronize()
    stats = {"inference_seconds": time.perf_counter() - start, "device": device,
             "peak_gpu_bytes": int(torch.cuda.max_memory_allocated()) if device == "cuda" else None,
             "torch": torch.__version__, "models": config}
    return observations, stats


def run(request: dict[str, Any], out: Path) -> dict[str, Any]:
    """Produce captured or inferred artifacts; persist errors without fabricating predictions."""
    if request.get("schema") != "walkthrough-request/1" or request.get("mode") not in ("capture", "live"):
        raise ValueError("Unsupported request schema or mode")
    prompts = request.get("prompts", ["workbench", "tray", "container", "person"])
    if not isinstance(prompts, list) or not 1 <= len(prompts) <= 8 or not all(isinstance(p, str) and 0 < len(p.strip()) <= 80 for p in prompts):
        raise ValueError("Provide 1–8 short concept prompts")
    request["prompts"] = prompts
    out.mkdir(parents=True, exist_ok=False)
    start = time.perf_counter()
    frames, sources = capture(request, out)
    warnings = ["Overlap and multiview consistency require review; sharpness selection does not prove reconstruction quality.",
                "World orientation and metric scale are predictions, not surveyed geometry.",
                "Per-image masks are not video tracks or persistent entity IDs; no cross-view merge was performed.",
                "Raw reconstruction may contain moving people/materials; person proposals cannot become stations, but geometry has not been motion-filtered."]
    if len({f["sha256"] for f in frames}) < 2:
        warnings.append("Insufficient distinct views: selected frames are duplicates.")
    if any(f["sharpness"] < 20 for f in frames):
        warnings.append("Blur/low-texture warning: at least one selected frame has Laplacian variance below 20.")
    report: dict[str, Any] = {"schema": "walkthrough-observations/1", "source": "capture", "status": "captured", "frames": frames,
        "sources": sources, "prompts": prompts, "observations": [], "warnings": warnings,
        "coordinates": {"frame": "mapanything-world", "camera_convention": "opencv-cam2world-x-right-y-down-z-forward", "units": "predicted_m", "oi_transform": None},
        "scale": {"status": "unverified", "calibration": None, "holdout": None}, "stats": {"python": platform.python_version(), "numpy": np.__version__, "pillow": importlib.metadata.version("Pillow")}}
    if request["mode"] == "live":
        try:
            observations, stats = infer(frames, request, out)
            report.update({"source": "live", "status": "inferred", "observations": observations})
            report["stats"].update(stats)
        except Exception as exc:
            report.update({"source": "capture", "status": "failed", "error": f"{type(exc).__name__}: {exc}"})
    try:
        import resource
        rss = resource.getrusage(resource.RUSAGE_SELF).ru_maxrss
        report["stats"]["peak_rss_bytes"] = int(rss if sys.platform == "darwin" else rss * 1024)
    except ImportError:
        report["stats"]["peak_rss_bytes"] = None
    (out / "runtime-packages.json").write_text(json.dumps(sorted({(d.metadata["Name"], d.version) for d in importlib.metadata.distributions() if d.metadata["Name"]})), encoding="utf-8")
    report["stats"].update({"total_seconds": time.perf_counter() - start, "frame_count": len(frames)})
    report["artifacts"] = [{"file": p.name, "sha256": digest(p)} for p in sorted(out.iterdir()) if p.is_file()]
    (out / "run.json").write_text(json.dumps(report, indent=2, allow_nan=False), encoding="utf-8")
    return report


def main() -> None:
    """CLI entry point with machine-readable stdout and diagnostic stderr."""
    if len(sys.argv) != 3:
        raise ValueError("Usage: walkthrough.py request.json new-output-directory")
    request = json.loads(Path(sys.argv[1]).read_text(encoding="utf-8"))
    with contextlib.redirect_stdout(sys.stderr):
        report = run(request, Path(sys.argv[2]).resolve())
    print(json.dumps({"status": report["status"]}))


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        print(f"WALKTHROUGH_FAILED: {error}", file=sys.stderr)
        sys.exit(1)
