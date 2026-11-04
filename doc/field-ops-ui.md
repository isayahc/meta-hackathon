# Field Ops screen and state inventory

Issue #48 integrates the persistent journey from #49 with the shared planning,
reconciliation and outcome records. The dashboard remains a single HTML asset;
there is no new task store, planning policy or spatial renderer.

## Layout and navigation

| Surface | Desktop structure | Mobile structure | Canonical route |
| --- | --- | --- | --- |
| Today | Fixed rail; next action above agenda, reviews and goals | Top capture action; next action first; four-item bottom navigation | `#today` |
| Goals | Goal summary and task list beside sticky detail | Goal summary, list, then task detail; editor in disclosure | `#goals/task/<id>`, `#goals/goal/<id>` |
| Calendar | Calendar beside proposal review and working-time disclosure | Agenda by default; week/month scroll inside a labeled region | `#calendar/day/<date>`, `#calendar/entry/<id>` |
| Workspace | Workflow list, focused review stage, contextual areas, updates and outcomes | Same sections; source video stays above the observation list | `#workspace/workflow/<id>`, `#workspace/update/<id>` |
| Capture | Modal with record/upload, context and optional recording details | Native modal; camera chooser with visible upload fallback | Returns to current task or workflow |

The four tab buttons have matching tab panels, arrow/Home/End navigation and
visible focus. Native dialogs support Escape and return focus. Interactive
calendar entries and overflow controls are buttons. Page content reserves space
for the fixed mobile navigation. Body text is 16px; primary controls are at least
44px. These are source-level contracts; rendering still requires inspection.

## Screen/state contracts

| State | Visible content and next action | Canonical API |
| --- | --- | --- |
| Empty | Record/upload immediately; manual task and goal creation are secondary | `GET /api/journeys` |
| Uploading | Real upload/interpretation message; no percentage; retain source before analysis | `POST /api/journey-video` |
| Retryable analysis | Saved original clip, error and retry action; no re-upload requirement | Same capture endpoint and source revision |
| Observation review | Original video alongside source times, observations, uncertainty and correction forms | `/api/journeys` correction/review commands |
| Purpose unresolved | Human confirms an existing/new goal, success criteria and desired improvement, or keeps it unassigned | `/api/journeys` goal/unassigned |
| Method and future work | Current versus proposed improvement evidence; explicit future-work confirmation and goal contributions | `/api/journeys` method/task |
| Returning Today | Next accepted action or reason nothing is ready, goals, location, duration, accepted agenda and relevant reviews | Same journey/planning view |
| Goal/task | Separate goal outcome and task counts; many-to-many links; completion criteria, actuals, history, area and calendar links | `/api/task-planning` |
| Schedule proposal | Current/proposed/why table; accepted and pinned blocks preserved; conflicts and deferred work shown | Planning propose/decide/block commands |
| Accepted/rejected proposal | Explicit decision label; decision buttons disabled; new proposal required for later changes | Stored schedule decisions |
| Execution | Start/resume, pause, blocked, explicit completion; partial quantity/time through actual-work disclosure | `/api/reconciliation` manual; planning work |
| Follow-up | Source and observations, association review, proposed changes and reasons before applying | `/api/reconciliation` |
| Outcome | Predicted effects separate from measurements, unknown/inconclusive results and retain/revise/reject decision | `/api/outcomes` |
| Workspace | Named areas and task context; supported OI workbench handoff, optional technical details | Existing mapping/walkthrough endpoints |
| Failure/stale input | Local status plus page announcement; preserve draft, reject stale revisions, require review of current values | Existing revision checks |

Only an explicit goal outcome control changes goal status. Task completion does
not complete a goal. Actual work has its own calendar label, distinct from past
observations, deadlines and proposed/accepted reservations. Goal filters retain
fixed commitments.

## Recovery and limits

Canonical data, uploaded sources, decisions and receipts remain in SQLite and
project media. Session drafts preserve editable text, selections and retry IDs
across navigation and reload in the same browser tab. Files cannot be restored
into a file input after reload; a source already accepted by the server is
resumed from Workspace. Task and availability drafts are version checked so an
old draft cannot silently overwrite a newer record. Changed values after an
ambiguous successful creation cannot reuse the prior creation receipt.

Goal/note creation now accepts an optional request ID and commits a receipt in
the existing database transaction. Task creation and workflow commands retain
their existing idempotency contracts. There is no second scheduling engine.

Process/video-to-location associations are available through #41; see
[spatial evidence](spatial-evidence.md). The pinned OI interface resolves scene
instances; unresolved regions/occupancies remain explicit rather than being
matched by label.
The UI uses existing OI handoff URLs, not an invented embedded scene. No live
model quality, actual productivity savings, or farmer validation is claimed.

## Verification and reproducible walkthrough

Automated checks cover the full existing server/library suite plus dashboard
script parsing, destination wiring, calendar overflow semantics, history restore,
actual-work timezone/goal filtering, preserved reservations, escaped readable
results, revision-aware drafts and retry-safe creation through SQLite and HTTP.

The updated `scripts/journey-ui-smoke.mjs` drives real HTTP handlers through
Playwright interception without opening a listening port. It covers capture,
correction/reload, goal confirmation, explicit future work, availability and a
fixed lunch, plan acceptance, progress, follow-up evidence, replan review,
dialog/keyboard navigation and screenshots of four destinations at 390×844,
1440×900 and 320×844. Input and interpretation are explicitly synthetic. It does
not establish camera recording, valid video playback or live inference quality.
The planning, reconciliation, outcome and walkthrough smoke scripts were also
updated for the new destinations/disclosures.

After building, on a host with Playwright and Chromium available, run the journey
script with an absolute output directory. The script's first positional argument
is the screenshot destination. Follow it with the planning, reconciliation and
outcomes scripts. Inspect the actual images for clipped controls, navigation
occlusion, typography, contrast and horizontal overflow; assertions alone do not
replace visual inspection.

**Execution status (2026-11-04):** automated Node checks passed. Browser launch
was attempted and blocked before page creation by Chromium's process-singleton
`socket() failed: Operation not permitted`. No screenshots were produced or
inspected, and the browser walkthrough has not passed in this environment.
Keep the PR in draft until that verification is completed.

An available reviewer should walk the same ordinary screens and answer: What
is the goal? What is the next accepted action and why? What changed after the
follow-up? Record their actual observations, misunderstandings and device sizes.
No reviewer session has been conducted. The real three-minute evidence-backed
demonstration remains part of #44; do not present the synthetic smoke fixture as
real footage, a separate visit, measured savings or live model output.
