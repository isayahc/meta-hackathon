# Field Ops — physical task tracker

Phone-first farm-operations app: photograph work, diff visits into tracked
spots, briefings, goals + optimizer, weather/soil fusion, all in one
tabbed browser UI backed by small Node scripts (zero dependencies).

## Start here

TypeScript sources live in `src/` and compile to `dist/` (gitignored).
Prerequisites: Node 18+. One-time setup:

```bash
cd C:\Users\isaya\meta-hackathon\app\physical-task-tracker
npm install   # typescript only; zero runtime dependencies
npm run build # strict tsc + copy dashboard/samples into dist/
```

Fastest start — one command, no API key, no network:

```bash
npm start
```

That builds (if needed), starts the server on `./my-farm`, and loads
http://localhost:8123 in your browser. (First time only: `npm install`.)
Add your first goal right in the app under Plan, or ahead of time with:

```bash
node dist/task-optimize.js ./my-farm --goal "Transplant bed 3 by Friday" --weight 5 --offline
```

Stop the server with Ctrl+C. `npm test` rebuilds and runs the suite.

## Run the full loop

Steps 1-3 and 5 need a Meta API key (hidden prompt, then remembered —
see below); steps 4 and 6 need none.

```bash
# 1. Scan one visit (photo or video frames)
node dist/task-scan.js https://upload.wikimedia.org/wikipedia/commons/0/0a/Harvesting_carrots.jpg

# 2. Compare two visits into a tracked spot (saves state + session)
node dist/task-compare.js <visit-a> <visit-b> --spot north-fence --root ./my-farm

# 3. Brief + set goals + optimize into a plan
node dist/task-briefing.js ./my-farm --out briefing.json
node dist/task-optimize.js ./my-farm --goal "Transplant bed 3 by Friday" --weight 5

# 4. (Optional, no key) Fuse weather + soil into the plan
node dist/lib/eco.js 38.5,-98.0 --root ./my-farm
node dist/task-optimize.js ./my-farm --eco 38.5,-98.0

# 5. (Optional) Segment a field feature with SAM 3.1
node dist/sam-segment.js <image> "<noun>" --out segment.svg

# 6. Open the live dashboard (no key to view; refresh needs one)
node dist/serve-dashboard.js ./my-farm --port 8123 --open
```

Key handling: `.env` (cwd, then app root) → `META_API_KEY` env → saved key, then hidden prompt. Say yes
once and it's remembered in `%APPDATA%\meta-hackathon\demo-key.json`
(outside the repo, never committed). `example.env` lists every variable
(placeholders only). `npm test` rebuilds and runs the suite from `dist/`.

Layout: `src/lib/` holds the shared TypeScript modules (request/prompt
builders, goals model, ecology, spot state, flag helpers); `src/task-*.ts`
are thin CLI wrappers; `src/serve-dashboard.ts` + `src/dashboard/` is the
web app (mobile-friendly). `dist/` is compiled output (gitignored).

## Run

```bash
node dist/task-scan.js https://upload.wikimedia.org/wikipedia/commons/0/0a/Harvesting_carrots.jpg
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
node --test dist/task-scan.test.js
```

Covers the captured `length`/null-content failure shape plus the request
builder defaults.

## Video understanding test

`src/task-scan-video.ts` sends N time-ordered frames (default 4) and asks what
changed between them — task progression, the tracker's core mechanic:

```bash
node dist/task-scan-video.js <phone-video.mp4 | frames-dir> [--frames 6]
```

Video files need `ffmpeg` (`ffprobe` for duration); a directory of frame
images skips that. Same key handling and env vars as above.

`--meta <video-file>` prints duration, dimensions, fps, and codec without
spending an API call — useful for sizing `--frames` before a run.

## Action SRT

Add `--srt` to get timestamped action segments as a subtitle file instead of
the progression JSON (frame dirs also need `--duration SECS`):

```bash
node dist/task-scan-video.js <phone-video.mp4> --frames 6 --srt
```

Writes `<video>.srt` (or `actions.srt` inside a frames dir). Try it on
ActivityNet video 1 (javelin throw,
[1QIUV7WYKXg](https://www.youtube.com/watch?v=1QIUV7WYKXg)) and compare the
model's cues against the official temporal annotations.

## Field segmentation (SAM 3.1)

`src/sam-segment.ts` sends an image plus a short noun-phrase concept to SAM 3.1
(via `/v1/responses` — the chat endpoint rejects SAM) and writes an SVG
overlay of boxes + decoded mask paths:

```bash
node dist/sam-segment.js src/samples/kansas-tile.jpg "center pivot irrigation field" --out pivots.svg
```

Prompts must be bare noun phrases (`agricultural field`), never instructions
(`segment the fields`) — the latter returns nothing. Generic concepts merge
everything into one mask; specific ones separate instances. Needs
`@meta-sam/parser` (`npm install`). Tests: `node --test dist/sam-segment.test.js`.

## Compare mode (two visits, one diff)

`src/task-compare.ts` takes two visits to the same spot — videos or frame
directories — and returns a structured diff: same-location evidence, changed
vs unchanged, progress delta, new issues, and a suggested state update:

```bash
node dist/task-compare.js <visit-a> <visit-b> [--frames 3] [--goal "established row before the dry spell"]
```

With `--goal`, every change is mapped to goal movement and risks. This is the
tracking inflection point: single-visit analysis becomes longitudinal state.

## Storage (SQLite)

Project state lives in `<project>/fieldops.db` (built-in `node:sqlite`, no
new dependencies): `goals`, `spots` + `sessions`, `events`, and `docs`
(latest plan, latest eco fusion). First open migrates any legacy JSON files
(`goals.json`, `spots/`, `events.json`, `plan.json`, `eco.json`) once and
leaves them in place, unread afterwards. Only the API key stays out of the
db (`%APPDATA%\meta-hackathon\demo-key.json`, never committed).
Uploaded clips persist under `<project>/media/` (served back at
`/media/<file>`) so calendar entries keep their referenced video. Each
scan also slices one small GIF per observed step (`--gifs`), shown under
each sequence item as a cheap stand-in for the full clip.

## Spots + state

A spot is a fixed viewpoint with a memory: one `spots` row (stage,
summary, open issues) plus a `sessions` row per visit holding its analysis.
`src/lib/spot-state.ts` implements init/read/append over those tables.
`src/task-compare.ts --spot <id> --root <project>` saves each run as a
session and folds it into state (auto-creating the spot on first use;
a bare `--spot <project>/spots/<id>` path still works):

```bash
node dist/task-compare.js visit-a visit-b --spot north-fence --root ./my-farm
```

Tests: `node --test dist/spot-state.test.js`.
## Resume briefing

`src/task-briefing.ts` reads every spot's state and briefs the operator —
overall standing, per-spot status, blockers, next actions, and goal status:

```bash
node dist/task-briefing.js ./my-farm [--goal "clean September harvest"] [--out briefing.json]
```

Text-only call (no images). Reads spot state from the db as
produced by the spots layer. Tests: `node --test dist/briefing.test.js`.
## Goals + optimizer

Goals are first-class rows in the `goals` table — `{ id, text,
deadline, weight 1-5, status }`, status moving `open -> at-risk -> done`.
`src/task-optimize.ts` ranks next actions from open goals, every spot's state,
and hard constraints (never violated; conflicting work is deferred with a
reason). Optimizer v1 is structured Muse reasoning, not a solver matrix:

```bash
node dist/task-optimize.js ./my-farm --goal "Transplant bed 3 by Friday" --deadline 2026-10-31 --weight 5 --constraint "No watering after 10am heat"
node dist/task-optimize.js ./my-farm --set-status transplant-bed-3-by-friday-1=done
node dist/task-optimize.js ./my-farm --offline   # print the prompt, no API call
```

Text-only call (no images). Works goals-only before any spots exist.
Tests: `node --test dist/goals.test.js`.

## Live dashboard

`src/serve-dashboard.ts` is the Field Ops app server and `dashboard/index.html`
(single file, no dependencies) is the app: tabbed mobile-friendly UI over
Spots (grid + detail), Run (scan a photo, compare two visits into spot
state — uploads or URLs), Plan (goals with add/done, ranked actions,
optimizer refresh), and Activity (on-demand briefing + feed). The server
shells to the sibling CLIs for model work (Meta key required; keyless
requests fail as 400/502 with the reason, never hang); uploads arrive as
data URLs, are materialized to temp files, and cleaned up. Polls
`/api/overview` every 5s. Sessions store analysis, not images, so detail
is text-first (no photo slider yet):

```bash
node dist/task-optimize.js ./my-farm --out plan.json   # optional file export; the db holds the live plan
node dist/lib/eco.js 38.5,-98.0 --root ./my-farm   # optional, powers the eco strip
node dist/serve-dashboard.js ./my-farm --port 8123 [--eco 38.5,-98.0] --open
```

Without a stored plan / eco doc, those panels simply stay empty. Tests:
`node --test dist/dashboard.test.js` (HTTP tests skip where listen() is
blocked and run on host).

## Ecology fusion

`src/lib/eco.ts` pulls open weather + soil data for a site and turns it into
optimizer input — no API keys needed. Open-Meteo gives current conditions
plus a 3-day field-work outlook (rain, heat, frost, wind); SoilGrids v2
gives topsoil texture, organic matter, and pH. Signals become hard
constraints (rain ≥60% blocks spraying/tillage, wind ≥40 km/h blocks
spraying, frost/heat reschedule transplant); soil texture/pH add their own
(work-dry-only clay, short-cycle sandy irrigation, pH lockout checks):

```bash
node dist/lib/eco.js 38.5,-98.0 --out src/samples/eco-kansas.json
node dist/task-optimize.js ./my-farm --eco 38.5,-98.0
node dist/task-optimize.js ./my-farm --eco-file src/samples/eco-kansas.json --offline
```

`--eco-file` replays a saved capture (same shape as `src/lib/eco.ts --out`) for
offline runs and tests. Samples: `samples/eco-kansas.json` (documented
shapes, fictional readings — recapture live with the first command).
Tests: `node --test dist/eco.test.js`.

## Sample

"Harvesting carrots" — agricultural workers harvesting carrots into crates,
Imperial Valley, California, circa 1948.
Source: [Wikimedia Commons](https://commons.wikimedia.org/wiki/File:Harvesting_carrots.jpg)
(Los Angeles Daily News / UCLA collection).
