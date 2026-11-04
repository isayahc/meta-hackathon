# Measuring intervention outcomes (#43)

The trial flow connects an accepted improvement to a saved baseline, later sessions/evidence, comparable measurements and the farmer's keep/revise/reject decision. It uses the existing project SQLite store and shared TypeScript services. No separate task, scene, session or planning engine is introduced.

## User flow

Open **Plan → Did the improvement help?**

1. Select an eligible improvement and explicitly accept it for a trial. A stale improvement must be regenerated against the current process/constraints.
2. Register the metric, units, better direction, practical unchanged tolerance, workload unit and baseline evidence. Describe workload composition, staffing, equipment, conditions, quality criteria, observation coverage and measurement source. Register intended equipment changes before testing.
3. Save the baseline and start the trial. Predictions, process revisions, original baseline and policy are frozen at registration. The headless API also supports historical imports, explicitly labeled `retrospective`; they are not presented as preregistered trials.
4. Perform the trial, then attach a follow-up compare session or a retained #50 evidence interpretation. Confirm whether the selected method was actually used. Supply measured totals and the corresponding workload denominator; do not infer whole-batch duration from isolated frames.
5. Review the prediction separately from the normalized measured comparison. Incomplete coverage, unverified method use, unknown context/quality, different workload composition or unplanned changes produce an explicit unknown/inconclusive result.
6. Keep, revise or reject the method, with a reason. Revision requires a concrete next trial plan. Corrections preserve previous measurements and invalidate the earlier evidence-dependent decision. Rejected methods remain stopped while changed evidence is reviewed.

The UI offers one primary metric at registration. The JSON contract supports up to twenty metrics. Later measurement forms render every registered metric. The latest observed follow-up is the default comparison; all visits and revisions stay available, and the CLI/API can evaluate a specific follow-up.

## Arithmetic and interpretation

Measurements are totals for an explicitly defined workload. For each metric:

- baseline rate = measured baseline total / baseline workload amount
- follow-up rate = measured follow-up total / follow-up workload amount
- delta = follow-up rate − baseline rate
- improvement percent = direction-adjusted improvement / baseline rate × 100, or unknown if baseline is zero or the percentage exceeds numeric range

A lower-is-better metric improves when delta is negative; a higher-is-better metric improves when delta is positive. Changes within the registered absolute tolerance **per workload unit** are unchanged. Units must match exactly; clients must explicitly convert units before submitting values. Zero/negative workloads and nonfinite values are invalid; missing quantities remain null. Unsupported normalization never emits Infinity/NaN as a measurement.

Different amounts of otherwise comparable work can be normalized: 20 minutes for 10 trays versus 30 minutes for 20 trays is 2 versus 1.5 minutes/tray. That is a 25% observed reduction, even if the original proposal predicted 40%. The application does not overwrite either number or imply that the prediction was measured.

Statuses:

| Status | Meaning |
| --- | --- |
| `unknown` | Required measurements, baseline/follow-up or denominator are missing/unsupported |
| `inconclusive` | Rates may be calculable, but context, coverage, adoption or quality prevents a sound comparison |
| `improved` | Comparable measured metrics improve, none worsen, and quality is preserved |
| `unchanged` | Comparable metrics stay within their registered tolerance |
| `worse` | A comparable metric worsens or follow-up fails previously met quality criteria |

Per-metric values/statuses remain visible even when the overall result is inconclusive or quality fails. A faster trial with worse quality is not labeled an overall improvement. Multiple metrics retain tradeoffs; one worsening metric prevents an overall improved result. Observed differences are **not proof of causation**, even when the recorded conditions match. Unrecorded confounding, replication and real-world validation remain possible follow-up work.

`estimated` inputs remain estimates and cannot establish measured savings. `sparse_frames` cannot establish a measured total. `continuous_video` requires retained evidence with continuous source coverage; legacy compare sessions contain sampled views and cannot satisfy that method. Full-batch operator/instrument measurements can be attached to sampled visual context, with an explicit measurement source and coverage explanation. The application records these operator assertions; it does not independently authenticate an instrument log described in text.

## Evidence and durability

Trials live under `intervention-trial:<id>` in the existing `docs` table. A new trial freezes the accepted assessment, original improvement review and predictions, metric policy, baseline source snapshot and process snapshot. Canonical `sessions`, `processes`, `actions`, goals and schedules retain their identities.

New compare runs retain original video/image files and the exact sampled frames in content-addressed project media. The result returns the stored session reference. Temporary HTTP uploads can then be removed without losing trial evidence. A frame-directory input retains the sampled files actually sent to the model. Older sessions still have their saved analysis; original media that was deleted by the old workflow cannot be recreated and is labeled unavailable.

Each visit explicitly selects a compare session's `before`/`after` source or one exact #50 interpretation. Exact source identities prevent attaching identical evidence twice as independent before/after work, including a retained video's rerun interpretation. This is not perceptual deduplication of re-encoded clips. The operator must still establish that visits represent separate work occurrences. Session `same_location:false` quarantine makes the comparison inconclusive.

Recording/observed time is supplied separately from processing time. Baselines must precede the trial and follow-ups must occur after it. Human-supplied observed timestamps remain assertions; upload time does not establish when work occurred.

Optimistic revisions and request receipts protect registration, measurement/correction and decision commands. A reused request ID with different content is rejected. Measurements and their old versions are saved atomically with audit history. The original registered baseline is never replaced; a corrected current baseline is stored alongside the original and prior revisions. Original process versions remain readable.

Source mutation/deletion and later process corrections are detected at read time. Historical measured values remain inspectable, while an old keep recommendation becomes stale. A current decision references the exact evaluated evidence digest, rather than a mutable outcome label. A user may choose a method despite an unknown result, but that choice never promotes unknown evidence to measured improvement.

## Briefing and planning

The existing briefing now receives reviewed outcomes and pending work as model context. When trials exist, authoritative `next_actions` come from deterministic trial decisions plus unresolved canonical tasks. Generated action suggestions are retained separately for review. A model response cannot replace a rejected-trial instruction with an accepted action. A mid-generation input change is flagged as stale model narrative; current deterministic outcome actions are read again after generation.

The existing improvement plan also respects the latest trial for that review/candidate, including unchanged candidates re-emitted in a new review with the same process, candidate ID and change text. Pending, rejected, revision-needed or stale trial decisions defer the candidate with an explanation. A current keep decision permits the existing feasibility/review gates to run. No trial decision silently completes a task, closes a goal, resolves a blocker, changes actual logs, or replaces accepted calendar work.

Offline briefing works without a key, model or server:

```bash
node /absolute/meta-hackathon/app/physical-task-tracker/dist/task-briefing.js /absolute/project --offline
```

## Shared CLI / HTTP contract

```bash
node /absolute/meta-hackathon/app/physical-task-tracker/dist/task-outcomes.js view --root /absolute/project
node /absolute/meta-hackathon/app/physical-task-tracker/dist/task-outcomes.js --root /absolute/project --command /absolute/trial-command.json
```

GET `/api/outcomes` returns `{trials:[{trial,result}]}`. POST `/api/outcomes` accepts the same JSON commands as the CLI. Stale revisions return 409; invalid inputs return 400. CLI diagnostics use stderr and a nonzero exit status; stdout contains only the JSON result.

| Command | Inputs |
| --- | --- |
| `sources` | Discover stored compare sessions, retained evidence interpretations and process versions |
| `register` | `request_id, review_id, candidate_id, metrics, workload_unit, baseline`; optional expected changes; historical imports require both `started_at` and `retrospective:true` |
| `visit` | `request_id, id, revision, role:'baseline'|'followup', visit, reason`; optional `visit_id` corrects an existing follow-up |
| `evaluate` | `id`, optional `followup_id`; default is latest observed follow-up |
| `decide` | `request_id, id, revision, evidence_digest, decision:'keep'|'revise'|'reject', reason`; optional `followup_id`; revise requires `revision_plan` |
| `briefing` | Deterministic outcome actions and unresolved task references |
| `view` | All trials, snapshots, corrections, current comparisons and decision freshness |

Metric definition: `{id,label,unit,direction:'lower'|'higher',tolerance}`.

A visit has this shape (IDs refer to existing records):

```json
{
  "reference": {"kind":"session","spot_id":"bench","session_id":"SESSION_ID","side":"after"},
  "observed_at":"2026-11-03T14:00:00-05:00",
  "process_id":"trays",
  "process_revision":2,
  "workload":{"amount":20,"unit":"tray","context":"72-cell trays, same soil and fill depth"},
  "context":{
    "intervention_applied":true,
    "implementation_note":"Operator confirms the scoop remained at the station for the entire trial",
    "staffing":1,
    "equipment":"Existing scoop",
    "conditions":"Same bench and soil",
    "quality_criteria":"Correct fill depth",
    "quality_passed":true,
    "coverage":"full",
    "coverage_note":"Stopwatch covered all 20 trays; images are supporting context"
  },
  "measurements":[{"metric_id":"time","value":30,"unit":"min","kind":"measured","method":"operator","source":"Operator stopwatch record"}],
  "notes":"No unexpected interruptions reported"
}
```

An evidence reference instead uses `{kind:'evidence',source_id,interpretation_id}`. Unknown workload/measurement values, staffing, equipment, conditions, adoption and quality are null. Coverage is `full|partial|unknown`; measurement kind is `measured|estimated|unknown`; method is `operator|instrument|continuous_video|sparse_frames`.

Expected context changes are registered as `[{field:'equipment'|'staffing'|'conditions',value,reason}]`. A matching planned difference is visible without being classified as an unexpected confounder; workload composition and quality still require comparability. Frozen policy/expected changes cannot be rewritten after seeing results. Register a new trial for a materially revised intervention.

## Verification and headless replay

```bash
node /absolute/meta-hackathon/app/physical-task-tracker/dist/task-capabilities.js test outcomes --out /absolute/new-evidence-directory
```

This labeled synthetic scenario retains registration, original measured comparison, corrected outcomes, briefing, SQLite state and actual CLI outputs. It compares unequal workloads, preserves a 40% prediction separately from a 25% synthetic measured reduction, corrects the follow-up to a worse result, rejects the method, updates the real briefing CLI and preserves unfinished work. No live model or real farmer-result claim is made.

Tests cover improved/unchanged/worse/unknown/inconclusive outcomes, missing baseline/denominators, occlusion, unverified adoption, changed staffing/equipment/workload/quality, planned versus unplanned changes, sparse-frame rejection, immutable registration, stale evidence/decisions, duplicate input, interrupted-write rollback, canonical session/process snapshots, actual HTTP/CLI persistence, retained compare media, and generated briefing action boundaries.

`scripts/outcomes-ui-smoke.mjs` exercises review/correction/revise/reload through the real HTTP handler using browser interception, with screenshot targets 390×844, 1440×900 and 320×844. Browser execution in the implementation environment is blocked by Chromium's denied process-singleton socket. No visual inspection or mobile usability pass is claimed. Run and inspect this script on a browser-capable host. Live inference, actual farmer measurements and the full #49/#44 demonstration remain separate validation work.
