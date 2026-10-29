# Status snapshot — 2026-10-28

Physical task tracker for farm operations (+ construction): photo/video
state tracking, two-visit diffs, spots with memory, resume briefings,
goals + optimizer, ecology fusion, live dashboard. All on `main`.

## Built and merged

- Compare mode (#11): `task-compare.mjs` diffs two visits, labeled sections.
- Spots + state (#12): `spots/<id>/{spot.json,state.json,sessions/}`, `--spot` wiring.
- Resume briefing (#13): `task-briefing.mjs` over every spot's state.
- Goals + optimizer (#14): `goals.json` (weight 1-5, open → at-risk → done),
  `task-optimize.mjs` ranks next actions (ranked/deferred/goal-effects).
- Ecology fusion (#15): `eco.mjs` (Open-Meteo + SoilGrids, no key) → hard
  weather/soil constraints; `--eco` / `--eco-file` on the optimizer.
- Live dashboard (#16): `serve-dashboard.mjs` + `dashboard/index.html`
  (spots, detail, actions with done-buttons, feed, eco strip, 5s poll).

Tests: 52 total, 48 pass, 0 fail, 4 skip (HTTP-bind tests skip in sandbox,
run on host). Live-verified so far: photo analysis, video SRT, SAM pivots,
PhenoCam compare, clip metadata.

## Run it (in order)

```bash
cd app/physical-task-tracker
node task-scan.mjs <photo-url>                          # single-visit analysis (Meta key)
node task-compare.mjs <visit-a> <visit-b> --spot ./my-farm/spots/north-fence
node task-briefing.mjs ./my-farm --out briefing.json
node task-optimize.mjs ./my-farm --goal "Transplant bed 3 by Friday" --weight 5 --out plan.json
node eco.mjs 38.5,-98.0 --out ./my-farm/eco.json        # no key needed
node task-optimize.mjs ./my-farm --eco 38.5,-98.0 --out plan.json
node serve-dashboard.mjs ./my-farm --port 8123          # open http://localhost:8123
```

Key handling: `META_API_KEY` env → saved key
(`%APPDATA%\meta-hackathon\demo-key.json`) → hidden prompt. Never in repo.

## Still open

- Live runs: real eco capture (replaces `samples/eco-kansas.json` fixture),
  live optimize with `--eco`, dashboard on host with refresh.
- Session-1 head-mounted planting footage (not shot).
- Submission video + writeup, due Nov 4 9PM ET.
- Follow-ups: spot lat/lon, session image persistence (photo slider),
  sampler + dedup for the live loop.
