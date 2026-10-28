# Demo: task-scan

Sends a farm-work photo to a Muse model and gets back structured task state:
what work is happening, what stage it's at, visible progress cues, safety
flags, and suggested next steps as JSON.

## Run

```bash
node task-scan.mjs https://upload.wikimedia.org/wikipedia/commons/0/0a/Harvesting_carrots.jpg
```

You'll be prompted for your Meta API key (typed blind) — once. Say yes when
asked and it's remembered in `%APPDATA%\meta-hackathon\demo-key.json` (outside
the repo, never committed), so later runs skip the prompt. Precedence:
`META_API_KEY` env, then the saved key, then the prompt. Delete that file to
forget the key. Any `https://` image URL or local path works
(drop your own photo into `samples/`). `META_API_BASE` and `MUSE_MODEL` env
vars override the endpoint and model. `MAX_TOKENS` (default 4096) sizes the
token budget — the default 800 starved the model's reasoning and returned
`finish_reason='length'` with null content. `REASONING_EFFORT` is forwarded as
`reasoning_effort` only when set (low|medium|high, provider-dependent).
See `example.env` for the full variable list (placeholders only, no secrets).

Null, empty, truncated, or non-JSON responses are hard errors (nonzero exit),
never printed as successful analysis.

## Regression test

```bash
node --test task-scan.test.mjs
```

Covers the captured `length`/null-content failure shape plus the request
builder defaults.

## Video understanding test

`task-scan-video.mjs` sends N time-ordered frames (default 4) and asks what
changed between them — task progression, the tracker's core mechanic:

```bash
node task-scan-video.mjs <phone-video.mp4 | frames-dir> [--frames 6]
```

Video files need `ffmpeg` (`ffprobe` for duration); a directory of frame
images skips that. Same key handling and env vars as above.

`--meta <video-file>` prints duration, dimensions, fps, and codec without
spending an API call — useful for sizing `--frames` before a run.

## Action SRT

Add `--srt` to get timestamped action segments as a subtitle file instead of
the progression JSON (frame dirs also need `--duration SECS`):

```bash
node task-scan-video.mjs <phone-video.mp4> --frames 6 --srt
```

Writes `<video>.srt` (or `actions.srt` inside a frames dir). Try it on
ActivityNet video 1 (javelin throw,
[1QIUV7WYKXg](https://www.youtube.com/watch?v=1QIUV7WYKXg)) and compare the
model's cues against the official temporal annotations.

## Field segmentation (SAM 3.1)

`sam-segment.mjs` sends an image plus a short noun-phrase concept to SAM 3.1
(via `/v1/responses` — the chat endpoint rejects SAM) and writes an SVG
overlay of boxes + decoded mask paths:

```bash
node sam-segment.mjs samples/kansas-tile.jpg "center pivot irrigation field" --out pivots.svg
```

Prompts must be bare noun phrases (`agricultural field`), never instructions
(`segment the fields`) — the latter returns nothing. Generic concepts merge
everything into one mask; specific ones separate instances. Needs
`@meta-sam/parser` (`npm install`). Tests: `node --test sam-segment.test.mjs`.

## Compare mode (two visits, one diff)

`task-compare.mjs` takes two visits to the same spot — videos or frame
directories — and returns a structured diff: same-location evidence, changed
vs unchanged, progress delta, new issues, and a suggested state update:

```bash
node task-compare.mjs <visit-a> <visit-b> [--frames 3] [--goal "established row before the dry spell"]
```

With `--goal`, every change is mapped to goal movement and risks. This is the
tracking inflection point: single-visit analysis becomes longitudinal state.

## Spots + state files

A spot is a fixed viewpoint with a memory: `spots/<id>/spot.json`,
`sessions/<timestamp>/analysis.json`, and a rolling `state.json` (stage,
summary, open issues). `spot-state.mjs` implements init/read/append;
`task-compare.mjs --spot <project>/spots/<id>` saves each run as a session
and folds it into state (auto-creating the spot on first use):

```bash
node task-compare.mjs visit-a visit-b --spot ./my-farm/spots/north-fence
```

Tests: `node --test spot-state.test.mjs`.
## Resume briefing

`task-briefing.mjs` reads every spot's state and briefs the operator —
overall standing, per-spot status, blockers, next actions, and goal status:

```bash
node task-briefing.mjs ./my-farm [--goal "clean September harvest"] [--out briefing.json]
```

Text-only call (no images). Reads `spots/<id>/{spot.json,state.json}` as
produced by the spots layer. Tests: `node --test briefing.test.mjs`.
## Goals + optimizer

Goals are first-class objects in `<project>/goals.json` — `{ id, text,
deadline, weight 1-5, status }`, status moving `open -> at-risk -> done`.
`task-optimize.mjs` ranks next actions from open goals, every spot's state,
and hard constraints (never violated; conflicting work is deferred with a
reason). Optimizer v1 is structured Muse reasoning, not a solver matrix:

```bash
node task-optimize.mjs ./my-farm --goal "Transplant bed 3 by Friday" --deadline 2026-10-31 --weight 5 --constraint "No watering after 10am heat" --out plan.json
node task-optimize.mjs ./my-farm --set-status transplant-bed-3-by-friday-1=done
node task-optimize.mjs ./my-farm --offline   # print the prompt, no API call
```

Text-only call (no images). Works goals-only before any spots exist.
Tests: `node --test goals.test.mjs`.

## Live dashboard

`serve-dashboard.mjs` is the run script for the Field Ops dashboard
(`dashboard/index.html`, single file, no dependencies): spot grid with
stage chips, text-first spot detail (state, open issues, recent sessions —
sessions store analysis, not images, so there is no photo slider yet),
optimizer-ranked next actions with done buttons that write back to
`goals.json`, a briefing feed, and the eco strip. Polls `/api/overview`
every 5s; "Re-run optimizer" shells to `task-optimize.mjs`
(`--eco` passes through, Meta key required):

```bash
node task-optimize.mjs ./my-farm --out ./my-farm/plan.json   # optional, seeds the actions panel
node eco.mjs 38.5,-98.0 --out ./my-farm/eco.json   # optional, powers the eco strip
node serve-dashboard.mjs ./my-farm --port 8123 [--eco 38.5,-98.0]
# open http://localhost:8123 in a browser
```

Without `plan.json` / `eco.json`, those panels simply stay empty. Tests:
`node --test dashboard.test.mjs` (HTTP tests skip where listen() is
blocked and run on host).

## Ecology fusion

`eco.mjs` pulls open weather + soil data for a site and turns it into
optimizer input — no API keys needed. Open-Meteo gives current conditions
plus a 3-day field-work outlook (rain, heat, frost, wind); SoilGrids v2
gives topsoil texture, organic matter, and pH. Signals become hard
constraints (rain ≥60% blocks spraying/tillage, wind ≥40 km/h blocks
spraying, frost/heat reschedule transplant); soil texture/pH add their own
(work-dry-only clay, short-cycle sandy irrigation, pH lockout checks):

```bash
node eco.mjs 38.5,-98.0 --out samples/eco-kansas.json
node task-optimize.mjs ./my-farm --eco 38.5,-98.0 --out plan.json
node task-optimize.mjs ./my-farm --eco-file samples/eco-kansas.json --offline
```

`--eco-file` replays a saved capture (same shape as `eco.mjs --out`) for
offline runs and tests. Samples: `samples/eco-kansas.json` (documented
shapes, fictional readings — recapture live with the first command).
Tests: `node --test eco.test.mjs`.

## Sample

"Harvesting carrots" — agricultural workers harvesting carrots into crates,
Imperial Valley, California, circa 1948.
Source: [Wikimedia Commons](https://commons.wikimedia.org/wiki/File:Harvesting_carrots.jpg)
(Los Angeles Daily News / UCLA collection).
