# Reviewed workflow lifecycle

Field Ops can preserve reviewed baseline/follow-up episodes, collect versioned datasets,
evaluate the existing outcome decision rules, explicitly select a passing version,
and export/reopen a portable evidence bundle. This is a human workflow review tool.
It does not train weights, execute machinery, complete tasks, or establish farmer savings.

## Farmer flow

Workspace → Improvements & outcomes → Save reviewed examples follows
**Observe → Review → Suggest → Try → Check**. First use the existing process and trial
flows to review observations, accept an eligible suggestion, and record what actually
happened. Choose a stored visit, identify the reviewer, record an assessment/reason,
and grant annotation-export permission if appropriate. A later capture of the same
trial/visit appends an episode revision. Correct measurements through the existing
trial form, processes through their review flow, and spatial links through their review
flow; these remain the authoritative stores.

Cards distinguish proposed change, acceptance, reported use, measured/estimated/unknown
values, reviewed outcome assessment, unknown subsequent state, and stale references.
Dataset creation/evaluation/selection are headless operations. The UI downloads existing
datasets, displays historical scores, and flags scores that need review.

## Contracts and ownership

`src/lib/lifecycle.ts` defines and validates `workflow-episode/1`,
`workflow-dataset/1`, `workflow-evaluation/1`, and `workflow-bundle/1`.
Validation runs before import writes, export, capture, or evaluation. It checks schema
versions, typed fields, process/visit/source/metric relationships, source snapshot
checksums, permissions, split membership, result counts, and bundle integrity.
Reports from the installed policy must reproduce before bundle import/export succeeds.

| Record | Retained evidence |
| --- | --- |
| Episode | Stable trial/visit identity; optional canonical journey ID; baseline and selected follow-up snapshots; process revisions, goals, spans, original predictions/corrections; reviewed OI associations; recording checksum/name when retained; recording time (null if unknown) separately from visit time; workload, units, quality/conditions; reviewer/target; mode; permissions; previous revision digest |
| Dataset | Explicit version/inclusion criteria; one pinned revision and SHA-256 per episode; development/validation/test membership |
| Evaluation | Actual predictions and checks for held-out members; separate reviewed targets; installed rule hash; fixed limitations; no automatic promotion |
| Selection | Explicit reviewer/reason; evaluation reference; previous selection ID. Earlier versions stay readable |
| Inference run | Policy version, episode revision, proposed review action, pending human decision, null performed action/outcome. Canonical feedback stays in the linked intervention trial |
| Bundle | Dataset, episode and evaluation snapshots; canonical SHA-256 manifest; runtime requirements; source references only; non-executable declaration |

Records use the existing SQLite `docs` table. Episodes are immutable snapshots, not
another workflow/task/scene engine. Import creates archive records only; it never
inserts canonical tasks, goals, trials, processes, calendar entries, or OI scenes.
Missing canonical/OI state makes archive freshness unverified. Historical replay is
still possible without loading the app or changing current farm state.

Related workflow IDs, trial IDs, session IDs, source identities, or media checksums
cannot cross splits. This is deliberately conservative: a baseline and its follow-up
belong together. Do not use multiple clips from one workflow as independent validation.
Permissions record annotation export, media export, training, and granting authority.
This implementation exports **references only**, even with media permission. It does
not infer permission from possession and never initiates training. Legacy compare
sessions without retained original media have a null checksum/recording time; their
analysis identity is not described as a recording checksum.

SHA-256 uses sorted object keys and preserves array order. Integrity hashes are not
signatures or proof that an external reviewer is trustworthy. Original source snapshot
hashes retain the canonical trial store's JSON encoding. Conflicting imported IDs fail
atomically; identical imports are idempotent. A capture may include `request_id` for
idempotent retries; different input under that ID is rejected.

## Policy and evaluation limits

The baseline is the existing #43 `evaluateTrial` comparator. Its code hash plus the
lifecycle adapter version identifies the actual policy. Inference chooses either
“resolve evidence” or “review result and choose keep/revise/reject.” This is not an
intervention-generation quality benchmark. It does not invent a new optimization policy.

`policyInput` withholds reviewed targets, decisions, correction histories, raw model
answers, process annotations, and source snapshots. It passes observed measurements,
workload/context, registered metric/context constraints, and the candidate description
to the fixed comparator. Evaluation checks reviewed outcome agreement, measurement
grounding, available review actions, constraint/comparability guards, and absence of
unsupported completion. Missing/estimated observations cannot become confirmed gains.
A failed target prevents selection. Selection is explicit and leaves prior versions intact.

Freshness is recomputed separately from immutable scores. Changed process revisions,
media, source interpretation/session, trial visits, improvement constraints/approval,
spatial association reviews, or OI head/entity state block reuse. Missing OI never
passes a reference check. A newer episode review supersedes the older one. A selected
policy whose evaluated dataset becomes stale cannot run current inference until reviewed
and selected against fresh evidence. Exporting historical evidence does not make it current.

## Headless commands

Build the existing app, then run this isolated offline scenario:

```bash
node /absolute/path/meta-hackathon/app/physical-task-tracker/dist/task-capabilities.js test lifecycle --out /absolute/path/new-lifecycle-run
```

It retains exact JSON requests/responses, a project database, an imported archive,
a bundle, and a report. Its two correlated held-out examples are one synthetic tray
workflow: baseline outcome unknown; follow-up 20 min/10 trays → 12 min/10 trays. These
invented values test arithmetic and guards, not field performance. The scenario selects
the passing software baseline, reopens/replays the bundle, then corrects a measurement
and verifies the old evaluation remains unchanged and reuse is stale.

For your own existing trial, write a JSON command file:

```json
{
  "command": "capture",
  "request_id": "review-001",
  "trial_id": "existing-trial-id",
  "trial_revision": 2,
  "visit_id": "existing-visit-id",
  "mode": "live",
  "reviewer": "Operator",
  "reason": "Reviewed complete-batch timing and matching quality criteria",
  "expected_status": "improved",
  "permissions": {
    "metadata_export": true,
    "media_export": false,
    "training": false,
    "authority": "Source owner"
  }
}
```

`mode` labels source provenance: `live`, `replay`, or `synthetic`. Replayed proposals
cannot be captured as live. All executions of this deterministic rule over stored
observations are reported as replay, including episodes originally collected live.

```bash
node /absolute/path/meta-hackathon/app/physical-task-tracker/dist/task-lifecycle.js --root /absolute/path/farm --command /absolute/path/command.json
```

Subsequent JSON commands:

| Command | Fields |
| --- | --- |
| `view` | None; episodes/issues, datasets, immutable evaluations and separate `evaluation_status`, selections, runs |
| `dataset` | `id`, `version`, `inclusion_criteria`, `members: [{id, revision, split}]`; digests derived from retained episodes |
| `evaluate` | Dataset `id`, `version`, and `split: "validation"` or `"test"` |
| `select` | `evaluation_id`, `reviewer`, `reason`; requires all checks passing and current sources |
| `infer` | Episode `id`, `revision`; requires current episode and selected evaluation evidence |
| `export` | Dataset `id`, `version`; emits complete portable bundle JSON |
| `import` | `bundle` containing exported JSON; archive-only, atomic and collision protected |
| `replay` | `bundle`; deterministic historical predictions, explicitly unverified freshness, no selection or canonical writes |

`GET/POST /api/lifecycle` uses the same service. Ordinary inference/capture does not
call Meta, train a model, or modify OI. Selection does not keep/reject a farm intervention:
use the existing trial decision flow for that, and recapture its reviewed feedback.

## Verification

Unit/API/CLI checks cover round trips and tampering, split leakage, identity collisions,
missing sources, process and OI staleness, annotation corrections, outcome labels,
permission rejection, withholding answers, and no unsupported execution/completion.
The browser smoke script drives the real request handler without a listening server:

```bash
node /absolute/path/meta-hackathon/app/physical-task-tracker/scripts/lifecycle-ui-smoke.mjs /absolute/path/lifecycle-screenshots
```

It requires local Playwright and a runnable Chromium. It captures 390/1440/320px views,
checks capture/reload, and checks overflow/errors. The implementation environment blocked
Chromium's singleton socket (`Operation not permitted`), so screenshot inspection and
mobile visual sign-off remain unverified; the script is supplied for an allowed host.
