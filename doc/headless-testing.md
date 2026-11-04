# Test Field Ops from OpenCode, without launching the app

All commands below run in a terminal. They do not need the dashboard, a web
server, or browser automation. The scenario runner calls the existing CLIs and
persists actual test state so you can inspect what happened afterward.

## What to tell OpenCode

> Read AGENTS.md and doc/headless-testing.md. Test all offline capabilities in a
> new isolated directory. Do not launch the app. Show passed, failed, and blocked
> results, explain what each result establishes, and link the report and evidence.

Or give it a narrower task:

- “Test process corrections and prove the original revision survives.”
- “Test the improvement comparison and prove a correction makes it stale.”
- “Test walkthrough capture and station review without loading the models.”
- “Prepare views from `/absolute/path/work-area.mp4`; show the selected frames
  and timestamps. Do not run inference.”
- “Run the local MapAnything/SAM walkthrough adapter on this clip. Check the
  documented prerequisites, preserve raw outputs, and report missing dependencies
  as blocked. Do not substitute replay.”

The last request needs the separately installed inference runtime and approved
weights. Offline testing is the default; model tests are a separate explicit
request. The repository's current sandbox restrictions still apply.

## Discover and run scenarios

Resolve the checkout and output paths on your own machine. Replace the example
absolute paths below; do not use an existing project as the output directory.
Node 22+ and the app's installed build dependencies are required.

```bash
npm --prefix /absolute/path/meta-hackathon/app/physical-task-tracker install
npm --prefix /absolute/path/meta-hackathon/app/physical-task-tracker run build
node /absolute/path/meta-hackathon/app/physical-task-tracker/dist/task-capabilities.js list
node /absolute/path/meta-hackathon/app/physical-task-tracker/dist/task-capabilities.js test all --out /absolute/path/new-capability-run
```

Or build and run in one command:

```bash
npm --prefix /absolute/path/meta-hackathon/app/physical-task-tracker run capabilities -- test improvements --out /absolute/path/new-improvement-run
```

Use the direct Node command when consuming pure JSON stdout; npm can add its own
console output. Windows PowerShell supports the same Node/npm commands with
quoted absolute Windows paths. Set `WALKTHROUGH_PYTHON` to the intended Python
executable if it is not named `python3`.

| Scenario | What runs | What it proves |
| --- | --- | --- |
| `process` | Synthetic scan event → process CLI → correction → reopen original/current revisions | Evidence-backed process persistence and correction history |
| `improvements` | Synthetic fixture → real optimizer replay → accept decision → correct process → reopen review | Comparison/decision persistence and stale-result detection |
| `floorplan` | Scaled and unscaled observation fixtures through the real connector using **mock OI** | Consumer contract behavior and retained evidence; not actual OI execution |
| `walkthrough` | Generated PNGs → real capture worker; synthetic geometry/masks → replay → review → negative tests → export | Capture/review persistence, stale rejection, dynamic station rejection, explicit unverified scale |
| `all` | Every scenario, continuing when one fails or is blocked | The above results together, independently labeled |

Walkthrough requires Python with NumPy and Pillow. Its generated PNG test does
not require ffmpeg; capture of your own video does. No scenario invokes a model,
downloads weights, starts a server, or changes your existing farm project.
The floor-plan scenario explicitly uses mocked OI operations. These are separate
capability checks, not proof of the unfinished end-to-end #45 integration.

## Reports and evidence

`--out` must be an absolute path whose parent exists and whose final directory
does not yet exist. Existing directories are refused, including empty ones.
Each scenario has its own project and output directory under it.

- `report.json`: versioned overall status and per-capability checks/reasons.
- Numbered `*.command.json`: invoked executable, arguments, and failure flags.
- Numbered `*.json`, `*.stdout.txt`, `*.stderr.txt`: parsed results and exact logs.
- `project/fieldops.db`: reopenable test state.
- Scenario-specific frame/mask/geometry and connector evidence files.

Exit codes: **0 passed**, **1 failed**, **2 blocked**. Any failure takes precedence
over a blocked result. Missing Python/modules blocks walkthrough while the other
scenarios continue. Expected negative checks pass only when the command rejects
the operation for the expected reason. Never turn blocked into passed or silently
replace a requested live run with these fixtures.

The report explicitly records `live_inference: false`. Inspect assertion results
and evidence; a zero exit status is not a model quality score. These tests also
do not verify UI layout, real farm outcomes, calibration accuracy, or unsupported
OI integrations. Test outputs are retained until you choose to remove them.

## Use your own media without the dashboard

Inspect video metadata without an API call:

```bash
node /absolute/path/meta-hackathon/app/physical-task-tracker/dist/task-scan-video.js --meta /absolute/path/work.mp4
```

Capture a short work-area walkthrough without inference:

```bash
node /absolute/path/meta-hackathon/app/physical-task-tracker/dist/task-walkthrough.js capture --root /absolute/path/test-farm --video /absolute/path/work-area.mp4 --frames 6
node /absolute/path/meta-hackathon/app/physical-task-tracker/dist/task-walkthrough.js list --root /absolute/path/test-farm
```

Use the returned ID with `show`, `review`, or `handoff`. The full patch formats
and evidence contract are in [walkthrough-adapter.md](walkthrough-adapter.md).
Add `--live` only when testing installed local models; no Meta API key is needed
for that local worker. Exact source/checkpoint pins and runtime setup are in the
same guide. A live worker may return a saved run with `report.status: failed` even
when the CLI exits successfully; OpenCode must inspect that field before claiming
inference success. Similarly, `captured` means no model observations were produced.

For actual Meta video understanding on a host where API calls are allowed:

```bash
node /absolute/path/meta-hackathon/app/physical-task-tracker/dist/task-scan-video.js /absolute/path/work.mp4 --frames 6 > /absolute/path/video-analysis.json
```

Supply `META_API_KEY` through the environment/key store, never in commands or
reports. This command spends API credits and requires ffmpeg for video. Its JSON
is model analysis; it does not itself save an event/process into the farm DB.
For process records already in a project, use `task-process.js list|show|correct`
with `--root`; building from an event uses `build --event <stored-event-id>`.

For actual OI execution with fixture observations and no model call:

```bash
node /absolute/path/meta-hackathon/app/physical-task-tracker/dist/task-floorplan.js --benchmark --root /absolute/path/new-oi-test-farm
```

Configure the pinned `OI_ROOT` and `OI_STRICT_PIN=true` per
[oi-boundary.md](oi-boundary.md). This writes test scenes through OI; use a new
project and unset any shared `OI_SCENE_DATA_DIR` override. Omitting `--mock-oi`
is intentional: unavailable OI is an error, not a reason to call a mock test live.
This tests the existing floor-plan contract, not #53's pending reconstruction import.

## Regression tests versus capability checks

The scenario runner leaves reviewable example state. The regression suite checks
many more edge cases and uses temporary state:

```bash
npm --prefix /absolute/path/meta-hackathon/app/physical-task-tracker test
python3 -m unittest discover -s /absolute/path/meta-hackathon/app/physical-task-tracker/src/workers -p 'test_*.py' -v
```

The Python suite additionally exercises real ffmpeg video frame extraction and
requires ffmpeg/ffprobe. Keep reports specific: fixture behavior, fresh inference,
real OI integration, and visual checks are different evidence categories.
