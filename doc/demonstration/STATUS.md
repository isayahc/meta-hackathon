# Status snapshot — 2026-10-29

Physical task tracker for farm operations (+ construction): phone video in,
task list out — state tracking, two-visit diffs, spots with memory, resume
briefings, goals + optimizer, ecology fusion, calendar, live dashboard.
`main` holds everything through merged #30. Three doc commits
(COMPETITORS.md, TASK_RESEARCH.md, this snapshot) are in flight on
`app/video-upload`.

## Built since the last snapshot

- Video upload core loop (#28): Run tab → clip → checkable task list.
- Sequence UI: frame-by-frame steps as a GIF+caption carousel; checklist in
  its own section; per-step GIF slices (`--gifs`) served from `/media/`.
- Recording dates: container `creation_time`, mtime fallback labeled as an
  estimate, unknown stays unknown.
- Calendar tab: day/week/month, stored events, goal/spot overlays, add form;
  video entries cluster tasks + referenced clip, every entry opens.
- SQLite store (`fieldops.db`: goals, spots+sessions, events, plan/eco
  docs) with one-time JSON migration; `.env` autoload; `npm start` frontend.
- Research packet: `COMPETITORS.md`, `TASK_RESEARCH.md`.

Tests: 77 total, 77 pass, 0 fail, 0 skip (TypeScript, `npm test`).
Live-verified: real bottle-clip analysis, key flow, calendar scan entry,
ffprobe metadata; headless drives after every UI change, zero console errors.

## Run it

```bash
cd app/physical-task-tracker
npm install && npm start   # builds, serves ./my-farm, opens :8123
```

Key: `.env` → `META_API_KEY` → saved key
(`%APPDATA%\meta-hackathon\demo-key.json`) → hidden prompt. Never in repo.

## Still open

- Session-1 head-mounted planting footage (not shot) — see `DEMO_PLAN.md`.
- Submission video + writeup, due Nov 4 9PM ET.
- Live runs: real eco capture (replaces `samples/eco-kansas.json` fixture),
  live optimize with `--eco`.
- Follow-ups: spot lat/lon, session image persistence, sampler + dedup,
  media prune/size cap, offline-first.
