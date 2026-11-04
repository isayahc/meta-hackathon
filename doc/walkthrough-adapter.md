# Walkthrough capture and perception adapter (#45)

This increment implements capture, an optional local model worker, raw evidence
storage, operator review, and a provisional evidence export. **#45 remains open.**
Fresh inference on a real walkthrough, route assessment (#54), and end-to-end
proof through scene import, process links and mapped comparison remain acceptance
gates. #53 now provides a reviewed immutable-asset placement/import seam; see
[reconstruction-import.md](reconstruction-import.md) for its supported subset.

## Capture setup

The Node app keeps its existing dependency-free runtime. Python dependencies are
isolated from the app and OI. Capture was tested with Python 3.12, NumPy 2.3.5,
Pillow 12.3.0, and locally installed ffmpeg/ffprobe. From your checkout:

```bash
python3 -m venv /tmp/fieldops-capture
/tmp/fieldops-capture/bin/python -m pip install numpy==2.3.5 Pillow==12.3.0
export WALKTHROUGH_PYTHON=/tmp/fieldops-capture/bin/python
npm --prefix /absolute/path/meta-hackathon/app/physical-task-tracker run build
node /absolute/path/meta-hackathon/app/physical-task-tracker/dist/task-walkthrough.js capture --root /absolute/path/farm --video /absolute/path/walkthrough.mp4 --frames 6
node /absolute/path/meta-hackathon/app/physical-task-tracker/dist/task-walkthrough.js capture --root /absolute/path/farm --image /absolute/path/a.jpg --image /absolute/path/b.jpg
```

Capture accepts 2–36 overlapping images or one clip of at most 120 seconds,
selecting 2–12 frames. Video candidates retain their decoded frame index and
presentation timestamp. Photos retain their input index and have no invented
timestamp. Sharpness selection takes the best candidate per temporal bin;
duplicate/blur warnings do not establish overlap or reconstruction consistency.
The Space tab exposes the same capture/live modes, uploads, and saved reviews.

## Optional live inference setup

The worker was implemented against inspected, pinned upstream APIs. **The model
execution path has not been exercised in this environment.** It contains no
remote inference, automatic model download, or automatic replay fallback.

| Component | Required source/checkpoint |
| --- | --- |
| MapAnything code | `facebookresearch/map-anything` at `3d10cf7a3016fc0f9bb13a071ee66c47b10be0d9` |
| MapAnything weights | `facebook/map-anything-apache`, exact 40-character checkpoint revision supplied by operator |
| SAM 3 code | `facebookresearch/sam3` at `f1647e8d0c1d280991f4d1b7d974c2704537fe66` |
| SAM 3 weights | Gated `facebook/sam3`, exact checkpoint revision containing `sam3.pt` |

Follow the pinned [MapAnything setup and licensing instructions](https://github.com/facebookresearch/map-anything/tree/3d10cf7a3016fc0f9bb13a071ee66c47b10be0d9)
and [SAM 3 setup and license](https://github.com/facebookresearch/sam3/tree/f1647e8d0c1d280991f4d1b7d974c2704537fe66).
The selected MapAnything checkpoint is the Apache variant; the worker does not
substitute the standard checkpoint. SAM 3 access requires accepting its model
terms and arranging approved local checkpoint access. SAM's documented baseline
requires Python 3.12+, PyTorch 2.7+, and CUDA 12.6+. Follow upstream installation
instructions in a separate inference environment and resolve a compatible set;
there is no validated combined dependency lock or GPU capacity recommendation yet.

Install both pinned repositories into that environment and populate the local
Hugging Face cache with the approved checkpoint revisions before running Field
Ops. Set:

```bash
export WALKTHROUGH_PYTHON=/absolute/path/inference-venv/bin/python
export MAPANYTHING_ROOT=/absolute/path/map-anything
export SAM3_ROOT=/absolute/path/sam3
export MAPANYTHING_REVISION='replace-with-exact-cached-checkpoint-commit'
export SAM3_REVISION='replace-with-exact-cached-checkpoint-commit'
export WALKTHROUGH_DEVICE=cuda
```

Add `--live` to the capture command. Source checkouts must match the pins and have
no tracked modifications. Checkpoint resolution is cache-only. `cpu` is an
explicit alternative, not a tested performance fallback. Do not assume 8 GB of
GPU memory is enough. Failures retain captured evidence with `status: failed` and
no observations. A worker startup/capture failure returns an error instead.

## Evidence and coordinate contract

Runs live in `<project>/walkthroughs/<run-id>/`; review records and revisions live
in `fieldops.db`. SHA-256 digests cover source bytes, selected PNGs, raw geometry,
masks, overlays, and runtime package metadata. Replay validates digests and
always changes the source label to `replay`, even when imported from a live run.

MapAnything tensor outputs are retained in per-frame NPZ files: world `pts3d`,
`depth_z`, validity `mask`, `intrinsics`, `camera_poses`, `conf`, `img_no_norm`, and
any other returned tensors. SAM receives the exact processed image grid; mask
grounding uses valid, finite, positive-depth samples on that grid. A robust
centroid is a proposed observation, not a surveyed station boundary. Original
capture pixels and processed model pixels are distinct coordinate spaces.

The source world frame is `mapanything-world`, units `predicted_m`; camera poses
are OpenCV camera-to-world transforms (x right, y down, z forward). OI transform
is null. Neither model output nor a review certifies scale, world orientation,
rooms, portals, connectivity, walkability, or unseen geometry.

This increment uses per-image SAM prompts, not the video tracking API. Track and
OI entity IDs remain null; there is no cross-view identity merge. A `person`
proposal cannot be confirmed as a station. Other proposals require explicit
static confirmation and valid depth. **Raw reconstruction is not motion-filtered**;
moving materials and overlap errors still need review and future model work.

## Reviews, measurements, and handoff

`task-walkthrough.js list|show|review|handoff` requires `--root`; show/review/handoff
also require `--id`. Review takes `--revision <current revision>` and `--patch
/absolute/path/patch.json`. Example station patch:

```json
{"observation_id":"observation-0","decision":"confirmed","station":"Tray bench","static_confirmed":true,"rationale":"Confirmed against the source image."}
```

Use `decision: rejected` with a rationale to reject a proposal. Review history is
append-only; the newest decision controls export. Stale writes fail, raw outputs
stay unchanged, and each edit advances the run revision. Consumers must pin the
exported `run_revision`; downstream OI invalidation is not implemented yet.

Measurements are currently collected through CLI/API, not a graphical picker:

```json
{"measurements":{"calibration":{"frame_id":"frame-0","a":[10,20],"b":[80,20],"measured_m":1.2,"source":"Tape measurement of bench edge"},"holdout":{"frame_id":"frame-1","a":[15,30],"b":[90,30],"measured_m":0.8,"source":"Independent tray edge measurement"}}}
```

Endpoints are original-image pixels. A separate, nonidentical held-out pair is
required. Measurements never enter model inference; no scale fit or residual is
computed here. Same-object reuse across different photos cannot be detected
automatically and must be avoided by the operator.

The `fieldops-walkthrough-handoff/1` export contains reviewed stations, source
coordinates, measurements, frame/artifact references, and run revision. Its
status is `requires_reviewed_import_plan`; it is **not an OI import request** and
has no authoritative scene/entity bindings. Use `task-reconstruction prepare-walkthrough`
with explicit reviewed asset correspondences, poses, source-to-OI transform and
3D measurement anchors, then preview and explicitly commit. The handoff itself
never mutates a scene; #54 owns route/clearance assessment.

HTTP endpoints: `GET/POST /api/walkthroughs`, `GET /api/walkthroughs/:id`,
`POST /api/walkthroughs/:id/review` with `{revision,patch}`, `GET
/api/walkthroughs/:id/handoff`, and manifest-listed PNGs under
`/api/walkthroughs/:id/images/:name`. Creation accepts `imagesData` (data-URL array)
or `videoData` (data URL), `mode`, `frames`, and `prompts`. Browser uploads are
limited to 100 MB; JSON requests are bounded to 160 MB. This follows the existing
local dashboard trust model; it is not an authenticated internet upload service.

## Reproduce checks and explicit replay

```bash
npm --prefix /absolute/path/meta-hackathon/app/physical-task-tracker test
python3 -m unittest discover -s /absolute/path/meta-hackathon/app/physical-task-tracker/src/workers -p 'test_*.py' -v
python3 /absolute/path/meta-hackathon/app/physical-task-tracker/scripts/replay-walkthrough.py /tmp/new-replay-bundle
node /absolute/path/meta-hackathon/app/physical-task-tracker/dist/task-walkthrough.js replay --root /absolute/path/farm --manifest /tmp/new-replay-bundle/run.json
node /absolute/path/meta-hackathon/app/physical-task-tracker/scripts/walkthrough-ui-smoke.mjs /tmp/walkthrough-qa
```

The browser check requires Playwright and installed Chromium; optionally set
`PLAYWRIGHT_CHROMIUM_EXECUTABLE`. It intercepts browser requests and invokes the
real app handler in process, without listening on a port. It checks mobile
capture/review, saved corrections, dynamic rejection, replay labels and width.

The replay generator makes visibly labeled synthetic station images, synthetic
NPZ geometry, and masks. It never calls a model. It is a reproducible adapter
fixture, not the real walkthrough benchmark required by #45.

## Validation recorded on 2026-11-04

- Node suite: 214 tests passed, including replay, artifact integrity, invalid
  units/depth, review persistence, revision conflicts, API and CLI behavior.
- Python worker: 6 tests passed, including a real ffmpeg-generated video with
  decoded frame timestamps and explicit missing-model failure.
- Capture-only sample: 2 selected frames from generated images; worker reported
  0.106 seconds and 31,404,032 peak RSS bytes. This excludes Node overhead and is
  **not** an inference timing or real walkthrough quality benchmark.
- Mobile browser script is committed but execution was blocked: Chromium could
  not create its process singleton socket (`Operation not permitted`). No visual
  verification or screenshot success is claimed.
- No GPU, PyTorch, approved cached weights, or real walkthrough with measured
  calibration/holdout was available. Model accuracy, runtime, VRAM, static-scene
  filtering, OI reopen/correction, and mapped comparison remain unverified.

Before closing #45, run the fresh measured walkthrough, preserve its actual
model/version/artifact metadata, measure reconstruction/semantic/scale errors
separately, exercise the reviewed import and process-link paths on that evidence,
complete #54 route assessment, and visually verify capture through
OI view and #42 comparison. Publish unknown and failed results alongside success.
