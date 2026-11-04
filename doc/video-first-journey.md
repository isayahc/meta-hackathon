# Video-first workflow integration (#49)

The smallest single-person slice now connects capture → source-linked review →
human corrections → confirmed purpose → choice of method → future tasks → the
existing calendar → actual work → #50 reconciliation → replan / #43 outcomes.
The full four-destination visual redesign remains #48, and the real demonstration
and benchmark remain #44. This integration does not establish farmer validation.

## Ordinary product flow

1. Open **Today**, then **Record or upload your work**. A supported phone file
   picker can offer recording; uploading is the fallback. No goal, calendar,
   map, scene identifier, task, or formal process description is required.
2. Read the interpretation beside the retained original clip. Source-time
   buttons seek the video. Observed steps and unobserved suggestions are labeled
   separately; sparse frames do not establish duration or completion. Correct
   labels, tools, materials, locations and unknowns, or add an omitted human-
   reported step. Confirm the review while keeping its gaps explicit.
3. Confirm the desired outcome, success criteria, optional deadline, priority
   and desired improvement. Link an existing goal or create one. Alternatively,
   explicitly keep intent unresolved and organize unassigned future work.
4. Compare any current stored improvement review and use an accepted, eligible
   intervention, or explicitly retain current practice. Missing comparison
   evidence is an honest empty state and does not prevent useful planning.
   Improvement generation and detailed resource constraints remain in the
   existing optimizer tools; this flow does not invent an intervention.
5. Enter the future task you intend to do, confirm its goal contribution, and
   optionally associate a reviewed process step. Observations do not create
   obligations or dependencies. Link existing tasks without copying them.
6. Continue to the existing Plan controls for dependencies, resources,
   completion criteria, availability, fixed commitments, and plan acceptance.
   Unknown estimates and conflicts remain explicit. Task editing includes a
   process-reference selector to review corrections or new interpretations.
7. A new visit to the app opens Today. Accepted agenda, next-action reason,
   goal contribution, place when known, remaining estimate and fixed commitments
   are readable there. Open the canonical task to start/pause/block/complete or
   log actual/partial work. Existing accepted reservations require review when
   changed; task completion never silently completes a goal.
8. Record a follow-up from that task or select it in capture. Review the retained
   source through #50's association/correction/accept/reject/defer controls, then
   propose and accept a revised calendar. Manual progress reports appear in the
   same workflow. Registered #43 trials show measured results and keep/revise/
   reject decisions; without comparable measurements, outcome remains unknown.

The global Record work action remains available when visiting task, goal,
calendar and spatial screens. Task context is inherited when selected. Additional
footage must be attached to a named workflow; it retains its own source/process
and review instead of silently merging observations. Follow-up footage requires
an existing workflow task and still requires human occurrence confirmation.

## Persistence and transaction boundaries

- `journey:<id>` in the existing `docs` table stores source/process, confirmed
  goal and canonical task references, reviewed revisions, desired improvement,
  method choice/basis, and transition history. It contains no alternate task,
  schedule, media, or spatial state.
- Sources use #50 `evidence-source:<id>` records and actual retained bytes under
  `media/`. Capture registers the source and its workflow before invoking the
  existing video scanner. Failure preserves a retryable source; retries use the
  existing processing token. Exact-byte reuploads resume the same workflow.
- Every initial/additional interpretation materializes a normal #40 process.
  No actions are created by capture. Process correction, goal creation, and
  task creation reuse shared primitives inside the workflow transaction, so a
  failed workflow save cannot leave an orphan goal/task/correction.
- Mutating journey commands require a workflow revision, request ID and reason.
  Identical receipts return the existing workflow; changed payloads with the
  same ID and stale revisions reject. IDs remain stable across retries/reloads.
- Explicit reanalysis retains old interpretations and process revisions. A
  `superseded-process:<id>` reference identifies the replacement, invalidates
  old planning/comparison/outcome advice, and requires task process-reference
  review. It does not rewrite human corrections or accepted task work histories.
- Process or goal changes invalidate the method's saved basis. A withdrawn
  improvement or rejected/revise-pending trial returns Today to review.
  Trial observations remain distinct from both estimates and human decisions.
- Actual task, goal, plan, source and outcome records remain authoritative.
  Workflow views derive their current stage and linked state from these records.
  Shared tasks retain one execution history and one calendar allocation.
- URL routes preserve selected workflow/task/goal/evidence across reload/back.
  Unsubmitted journey review form fields and pending requests are retained in
  session storage on the same browser tab. Saved records survive independently
  in SQLite. A file that has not finished uploading is not a retained source.
- OI still owns spatial state. This slice works without OI; existing Space and
  connector access remain available. Rich process/location associations are
  owned by #41 and are not fabricated here.

## Headless use

Replace the absolute example paths for the checkout and an isolated test project.
No app or listening server is needed:

```bash
npm --prefix /absolute/path/meta-hackathon/app/physical-task-tracker run build
node /absolute/path/meta-hackathon/app/physical-task-tracker/dist/task-capabilities.js test journey --out /absolute/path/new-journey-test
node /absolute/path/meta-hackathon/app/physical-task-tracker/dist/task-journey.js view --root /absolute/path/project
node /absolute/path/meta-hackathon/app/physical-task-tracker/dist/task-journey.js --root /absolute/path/project --command /absolute/path/command.json
```

Tell OpenCode: **“Test the video-first journey offline. Prove a correction,
confirmed goal, accepted plan, partial work and reviewed follow-up keep the same
workflow/task identity. Show unknown outcomes honestly. Do not launch the app.”**

`replay-journey.mjs` creates a new project and retains reviewed-work, accepted-
plan, follow-up/replan and report JSON plus the SQLite database. It uses explicit
synthetic byte fixtures (not playable farmer video), injected interpretations
marked `replay`, historical example actuals and future example planning windows.
The example quantity changes from 50 → 30 after reported partial work → 28 after
a human correction; the remaining estimate changes to 35 minutes. Neither is a
real measurement or savings claim. Original process revision and task identity
survive reopening through a separate CLI process.

To capture real video headlessly, use a command file such as:

```json
{
  "command": "capture",
  "path": "/absolute/path/work.mp4",
  "frames": 4
}
```

That command uses the real scanner and needs its configured model credentials
and video dependencies. It is not an offline replay. For a follow-up add
`workflow_id`, current `revision`, `role: "followup"`, and an existing `task_id`.
For retry, pass `source_id`, `workflow_id`, `retry: true` and `source_revision`;
no second upload is required. The HTTP capture boundary is `/api/journey-video`;
ordinary commands use GET/POST `/api/journeys`.

Journey commands: `view`, `correct` (existing correction patch contract),
`review`, `goal`, `unassigned`, `method` (`retain` / accepted `intervention`),
`task` (explicit future confirmation or existing task ID), and `rename`.
Use the existing planning/reconciliation/outcome CLIs for subsequent decisions;
`view` resolves their current results into the same workflow.

## Validation and remaining work

Automated checks exercise the real SQLite transaction boundaries, API handler,
CLI reopen, initial capture before setup, process correction, task/goal identity,
plan acceptance, interruption, #50 update, replan, missing estimates, explicit
unknown outcomes, source retry and exact duplicate suppression. Negative checks
cover stale receipts, changed payloads, failed enclosing writes, external
corrections, superseded interpretations and withdrawn/rejected interventions.

`journey-ui-smoke.mjs` uses the real request handler through Playwright routing,
without a listening server. Its injected synthetic interpretation checks upload,
correction/reload, purpose, future-task confirmation and task route reload, and
requests screenshots at 390×844, 1440×900 and 320×844. Media playback and live
inference are outside that synthetic check.

Browser execution in this coding environment was blocked before opening a page:
Chromium process-singleton `socket()` returned `Operation not permitted`.
Consequently no screenshots, rendered responsiveness, keyboard walkthrough or
live inference pass is claimed. Run the browser check and inspect its images
in an allowed environment before treating the visual journey as verified.
The comprehensive four-destination design/accessibility/usability pass belongs
to #48; publish actual footage/demo/benchmark evidence through #44.
