# Roadmap to Nov 4, 9PM ET submission — Field Ops tracker

Built from the agent review (`meta-hackathon-agent-review.md`) and verified
against the repo on 2026-10-29. Deadline: **2026-11-04 9:00 PM ET**.

Baseline: `meta/main` at `92e0825` (PR #30 merged).
`app/video-upload` holds research/status docs; `app/agents-md` holds
AGENTS.md. PRs #31/#32 open (docs-only) — recheck live before citing.

Legend: **UNVERIFIED** = not confirmed by direct inspection; re-check
before citing.

## 1. Where we are — shipped, with evidence

All paths under `app/physical-task-tracker/src/` unless noted.

1. Photo scan — `task-scan.ts`; `POST /api/scans`; `task-scan.test.ts`.
2. Video scan loop — `task-scan-video.ts` (frames, `--srt`, `--gifs`,
   recording-date resolution); `POST /api/scan-video` (persists clip +
   GIFs to `media/`, serves `/media/`); `task-scan-video.test.ts`.
3. Two-visit compare — `task-compare.ts` (`--spot/--root` save);
   `POST /api/compares`; PhenoCam fixtures in `src/samples/`.
4. Spot memory — `lib/spot-state.ts` (`initSpot`, `appendSession`,
   `listSpotBriefs`); `spot-state.test.ts`.
5. SQLite store — `lib/db.ts` (`fieldops.db`: goals, spots, sessions,
   events, docs; WAL; JSON migration); `db.test.ts`, `events.test.ts`.
6. Goals — `lib/goals.ts` (open/at-risk/done); `POST /api/goals[/:id]`;
   `goals.test.ts`.
7. Resume briefing — `task-briefing.ts`; `POST /api/briefing`;
   `briefing.test.ts`.
8. Optimizer — `task-optimize.ts` (constraints, eco, offline, plan via
   `setDoc`); `POST /api/refresh`.
9. Ecology fusion — `lib/eco.ts` (Open-Meteo + SoilGrids);
   `eco.test.ts`; Kansas fixture (not a live capture).
10. SAM segmentation CLI — `sam-segment.ts` → SVG overlay.
    Standalone only, not consumed by spot/task state.
11. Dashboard — 5 tabs, video upload, GIF+caption carousel, calendar
    day/week/month.
12. Calendar — `lib/events.ts` + overlays; `GET/POST /api/events`; scans
    auto-record video entries with payload + media.
13. Ops — `.env` autoload; `npm start` (build + serve + open); API key
    outside the repo.
14. Tests — 77/77 pass at last full run (re-run before citing).
15. Docs — `DEMO_PLAN.md`, `WHY_IT_MATTERS.md`, `OPEN_QUESTIONS.md` on
    main; `COMPETITORS.md`, `TASK_RESEARCH.md`, `STATUS.md`, `AGENTS.md`
    in flight.

## 2. What remains — ordered by submission impact

### P0 — Must ship

1. **Clean install.** Node 18+ claims vs `node:sqlite` (Node 22+);
   `@meta-sam/parser` resolution vs zero-dep app package. Pin/document
   runtime, fix SAM resolution, verify `npm ci → build → test → start`
   from a fresh clone.
2. **Durable actions.** Checkboxes are DOM-only — refresh wipes them.
   Persist ordered actions with stable IDs + status.
3. **Action-vs-goal split.** Action completion ≠ goal completion.
4. **Verification gate (minimum).** Refuse/quarantine spot updates when
   `same_location` is false; keep prior issues until resolved.
5. **Video URL contract.** `videoUrl` is forwarded as a local path.
   Remove the affordance or implement bounded SSRF-safe fetch.
6. **Demo + release.** Session-1 footage (not shot), Session-2 check-in,
   submission video + writeup, live eco capture, live optimize,
   clean-host smoke, tagged frozen release.

### P1 — Ship if time

7. **CI** — install/build/test on PRs.
8. **Runtime schemas** — validate scan/compare/plan JSON before persisting.
9. **Temporal honesty** — label uniform sampling + equal GIF slices as
   estimates.
10. **Timestamps/retention** — split captured/uploaded/analyzed; prune
    orphaned media on failed jobs.
11. **Constraint check** — deterministic post-check on eco/operator rules.
12. **Golden eval minimum** — one documented success + one documented
    failure case, reproducible.

### Explicitly deferred (post-hackathon)

SAM→entity integration; offline-first; robot/tool procedure graph; broad
pilot; multiuser auth/ops. Keep API bound to `127.0.0.1`.

### Suggested order

- Oct 29–30: P0 items 1–3; merge docs PRs #31/#32 or rebase them.
- Oct 31–Nov 1: P0 items 4–5 + CI.
- Nov 2: Shoot Session 1; live eco capture + live optimize; golden cases.
- Nov 3: Session 2; end-to-end browser pass; clean-host smoke.
- Nov 4 (before 9PM ET): freeze tag, record video, write submission text.

Scope rule (from the review): if time conflicts with breadth, ship fewer
features with reliable verification and one honest uncertain observation.

## 3. Open questions

**Submission mechanics (answer first):** what exactly is due (video
length, writeup format, repo requirements, live vs recorded)? Do judges run
the app or watch the video? Is a live API key usable at judging, or must it
run on fixtures?

**Product decisions blocking P0:** video URL — remove or SSRF-safe fetch?
Gate strictness — refuse or quarantine? Actions — ephemeral or first-class?
Session 2 — staged-with-labeling or same-day disturb-and-revisit?

**Science questions** (from `OPEN_QUESTIONS.md`): sparse longitudinal
tracking with no benchmark; progress without a plan; same-spot registration
at phone quality; calibrated abstention; goal grounding.
