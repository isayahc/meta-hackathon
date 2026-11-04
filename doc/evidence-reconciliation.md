# Follow-up evidence and reviewed updates (#50)

New evidence can update an existing task occurrence without creating another checklist. Source identity, observed facts, model interpretations, proposed changes, reviewed changes, and schedule acceptance remain separate records.

## Product flow

1. Open a task in Plan and choose **Record follow-up evidence**, or select an existing task in the video form. This uses `/api/reconcile-video`, not the initial-discovery checklist route.
2. The upload is retained and hashed before analysis. Recording time is separate from upload time. Supply an offset-bearing recording timestamp when known; otherwise container metadata may supply a camera timestamp. File modification time never becomes authoritative recording time.
3. Return to **What this changes** in Plan. Reload recovers retained clips, processing/error state, observations, proposals and decisions. Explicit retry analyzes the retained clip; it does not require uploading again.
4. Confirm the task occurrence. A similar action can belong to a different recurring batch. Reject ambiguous matches or retain unrelated footage with no operational change.
5. Inspect source media, sample timestamps, uncertainty, before/after values and affected task/goal/calendar references. Accept, correct, reject or defer each independent change. Current-state confirmation is required when footage is historical/undated or completion is proposed. Resolve possible overlap before accepting another source's progress.
6. Preview effects on today's plan. Accepted and pinned blocks stay in place; conflicts and unscheduled work are explicit. Use the existing day-plan controls to release conflicting reservations, generate a revised proposal, and separately accept it.

A person can also **Report current progress or a correction**. An explicit human edit applies immediately, with a retained report and revision history, without asking them to approve the same input again. Remaining quantities are totals, not implicit increments. Use the existing work-log form for actual execution intervals: sampled video or a status report never fabricates continuous work duration.

Completing a task does not complete its goals. Completion requires defined task criteria and cannot retain nonzero remaining work. Original time estimates, task identities, actual work logs and historical plans remain intact.

## State and storage

The existing `docs` table stores versioned `work-update/1` source documents and request receipts. Canonical tasks remain `actions`; process revisions remain `processes`; goals/events/calendar stores are unchanged. No parallel task or scene database is introduced. Old projects require no source-data migration; the first write adds the new document keys.

A source includes SHA-256 of actual video bytes, persisted media name, upload time, optional recording time and uncertainty, media metadata, task/goal/place/occurrence context, the task snapshot at ingestion, interpretation revisions, associations, changes, decisions and history. SHA matches prevent repeated processing across renamed duplicate files. Different encodings do not produce the same hash: other reports/footage associated with the same task produce an explicit overlap review. There is no perceptual-deduplication or confidence-aggregation claim.

Stages are `received`, `processing`, `needs_review`, `applied`, `no_material_change` and `failed_retryable`. Live warnings expose stale task bases, contradictory current values, chronology and overlap. Spatial handoffs have their own `pending_external` state. A processing token prevents an interrupted/older worker from replacing a newer attempt. Exact retry keys cannot be reused with changed review/manual payloads.

Model runs over one source remain interpretation revisions. Equivalent proposals over the same source interval retain prior acceptance/rejection, regardless of model version. A second progress application from an already-used interval requires an explicit non-additive correction; it cannot add incremental work again. Cross-source overlap requires a human determination; “same work” disallows incremental quantity addition. This is a conservative review guard, not automatic semantic video matching.

Task changes validate references, quantity units and totals, execution state, dependencies, source references and base revisions. Independent selected decisions apply in one `BEGIN IMMEDIATE` transaction with task mutations and receipts. Conflicting writes to the same field are rejected. A failed mutation or receipt write rolls back the entire subset. Rebase creates a new proposal and supersedes the old proposal; it never silently changes its original before-value.

Evidence-only updates do not invalidate planning. Untimed evidence/calendar markers are excluded from scheduling inputs. Accepted changes to task/process inputs make the existing plan stale through its input revision digest. Transitive dependency references identify affected tasks, goals and accepted blocks. A feasibility preview is read-only and does not replace the latest saved plan or accepted schedule.

## Process, friction and spatial consequences

`propose_related` supports a source-backed process revision, friction finding, or spatial handoff. Each references an existing task and exact interpretation/observation.

- **Process revision:** provide the next complete `farm-process/1` document plus current process ID/revision. The task must reference that process. Review uses the current process revision, completion/evidence validators and the same SQLite transaction as the decision. Old revisions stay readable; dependent optimizer results become stale. Linked tasks retain their old process references until explicitly reviewed. No future task is created merely because another historical step was observed.
- **Friction:** acceptance records a qualitative input for improvement review, not measured savings or an automatically accepted intervention. It remains in the source's reviewed findings for the #42/#43 flows.
- **Spatial:** acceptance records `pending_external`. It does not invoke OI or claim a distributed transaction. The supported OI integration (#53/#41/#54) must perform and verify that handoff before dependent spatial work can be called applied. There is no simulated spatial success.

The UI displays and reviews these related proposals. Their authoring is available through the JSON contract; automatic generation of complete process revisions and spatial operations is not claimed. The current live follow-up adapter proposes only supported remaining-quantity/blocker claims; completion is an explicit user-authored proposal or manual report.

## CLI and HTTP

Use an absolute project path and JSON command file:

```bash
node /absolute/meta-hackathon/app/physical-task-tracker/dist/task-reconcile.js view --root /absolute/test-farm
node /absolute/meta-hackathon/app/physical-task-tracker/dist/task-reconcile.js --root /absolute/test-farm --command /absolute/update.json
```

GET `/api/reconciliation` returns the same review view. POST `/api/reconciliation` accepts the same command objects as the CLI. Stale revisions return 409; invalid commands return 400. POST `/api/reconcile-video` accepts `videoData`/`videoUrl`, optional `task_id`, `recorded_at`, and `frames`; retry accepts `source_id`, current `revision`, and `retry: true`. The response contains the durable source, including `failed_retryable` when inference fails. Do not interpret HTTP 200 as successful inference: inspect `source.stage` and `source.error`.

Command families:

| Command | Required inputs / meaning |
| --- | --- |
| `ingest` | `source: {kind, media}` for persisted video, or `{kind:'manual', request_id, report}`; optional recorded time, uncertainty, duration and context |
| `begin` | `id, revision`, optional `retry:true`; returns processing token |
| `finish` | `id, token, interpretation:{origin,model,prompt_version,observations,raw?,metadata?}` |
| `fail` | `id, token, error`; retain retryable source |
| `associate` | `id, revision, task_id, decision:'confirmed'|'rejected', reason` |
| `propose` | `id, revision, change:{task_id,observation_id,interpretation_id?,kind,patch,reason,uncertainty?,quantity_mode?,quantity_value?,unit?}` |
| `review` | `id, revision, request_id, decisions:[{change_id,decision,reason,correction?,current_confirmed?,overlap?,overlap_reason?}]` |
| `rebase` | `id, revision, change_id, reason`; explicit new base, original retained |
| `manual` | `request_id, task_id, task_revision, report, patch`; intentional current-state edit |
| `retain` | `id, revision, reason`; no operational change after pending proposals are resolved |
| `propose_related` | `id, revision, change:{kind,task_id,observation_id,interpretation_id?,reason,proposal,process_id?,base_revision?}` |
| `review_related` | `id, revision, review:{change_id,decision,reason,current_confirmed?}` |
| `plan` | `day, now`; read-only feasibility and accepted-plan comparison |

Observation: `{id,text,start_s,end_s,confidence,uncertainty,coverage}`. Unknown times are null. Sampled observations identify sample instants, not continuous work intervals. Origins: `model`, `replay`, `human`. Coverage: `sampled`, `continuous`, `human_report`.

Task change kinds: `progress`, `completion`, `blocker`, `correction`. Supported patch fields: execution, remaining minutes, estimate source, quantity, preconditions, dependencies and location. `propose` quantity changes use `quantity_mode:'remaining'|'incremental'`, a numeric `quantity_value`, and the canonical `unit`; direct raw quantity patches are rejected at proposal creation. Corrected and manual patches can supply a complete canonical `{total,remaining,unit}` quantity. A new remaining-time estimate needs an estimate source. No task identity, original estimate, actual log or goal outcome field is writable through evidence patches.

Example explicit human update:

```json
{
  "command": "manual",
  "request_id": "batch-a-progress-1",
  "task_id": "EXISTING_TASK_ID",
  "task_revision": 2,
  "report": "I counted 28 trays remaining in this batch",
  "patch": {
    "execution": "paused",
    "quantity": {"total": 50, "remaining": 28, "unit": "trays"}
  }
}
```

## Headless evidence and verification

```bash
node /absolute/meta-hackathon/app/physical-task-tracker/dist/task-capabilities.js test reconciliation --out /absolute/new-evidence-directory
```

The scenario retains `baseline.json`, `review.json`, `effects.json`, `after.json`, `fieldops.db`, CLI stdout/stderr and the capability report. Inputs are labeled synthetic. It does not prove live model accuracy, video decoding, real farm outcomes, OI mutation or rendered UI usability.

Tests cover partial progress; explicit quantity correction; blocker propagation; exact duplicate input; repeated interpretation/rejection; historical evidence; conflicting/manual concurrent edits; ambiguous association; unrelated footage; same-interval and cross-source overlap; units; atomic rollback; processing interruption/retry; completion consistency; canonical process revision and stale rejection; pending spatial handoff; and real CLI/HTTP persistence.

Run `scripts/reconciliation-ui-smoke.mjs` with Playwright on a host that can launch Chromium. It drives the real handler through browser interception without a listening server, checks review/correction/reload, keyboard refresh, and widths 390, 1440 and 320, and saves screenshots for inspection. In the implementation environment Chromium aborts because its process-singleton socket is denied. **No rendered/mobile/keyboard pass or screenshot inspection is claimed.** Live inference, the complete #49 journey and #44 demo validation remain separate verification work.
