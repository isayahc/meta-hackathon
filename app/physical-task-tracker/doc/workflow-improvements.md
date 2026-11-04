# Workflow diagnosis and human improvement trials

The existing `task-optimize` pipeline can now produce specific process improvements, not only next-task lists. When processes exist, its prompt includes their exact corrected revisions and operator-supplied evidence. The model proposes friction diagnoses and interventions; shared application code independently checks references, constraints, measurements and feasibility. Model text is retained under `model_narrative`, separate from the checked review. When processes are present, only eligible structured proposals enter the plan's ranked actions. Blocked or unresolved proposals enter `deferred` with reasons. If the model omits structured improvements, its unchecked action list is retained only as narrative and the plan requests evidence/re-generation.

The API/CLI delivers this workstream. The complete mobile comparison and evidence-navigation flow belongs to epic #39's demo workstream (#44). Step-to-space linking remains #41; this implementation does not manufacture missing links or claim a spatial alternative is feasible merely because its schema validates.

## Replay a concrete intervention

Run from the app directory, with Node 22+ and dependencies installed:

```bash
npm run build
node scripts/replay-improvements.mjs ./tray-workflow-demo
node dist/task-improvements.js list --root ./tray-workflow-demo
```

The replay refuses to overwrite a project database. It uses `src/samples/workflow-improvements.json`, creates process `trays` at revision 2, and calls the real optimizer's offline path. No API key, model request, server or OI mutation is needed. Output and input sources explicitly identify this as a **synthetic replay**, not farmer adoption or measured savings.

The fixture diagnoses separately confirmed returns for a scoop and proposes returning it to an existing holder. Its baseline is 20 minutes / 10 trays = 2 minutes/tray; its proposed estimate is 12 minutes / 10 trays = 1.2 minutes/tray. The 0.8 minutes/tray (40%) reduction is a **projection to test**. Distance, water use and other absent measurements remain unknown. The verification plan requires a comparable tray run, trip counts, fill-quality inspection, and operator feedback.

Use the review UUID printed by the replay:

```bash
node dist/task-improvements.js show --root ./tray-workflow-demo --id <review-id>
node dist/task-improvements.js decide --root ./tray-workflow-demo --id <review-id> --candidate keep-scoop-at-station --status accepted --rationale "Trial approved for ten comparable trays."
```

`rejected` and `deferred` are also supported. A nonempty farmer rationale is required for every decision. Blocked, unresolved or stale advice cannot be accepted. Decisions are append-only history within each stored review. Accepted advice becomes non-actionable if its process or operator inputs change; the historical acceptance remains visible. Reassess after updating inputs rather than overriding a failed feasibility check.

## Supply actual operator inputs

The fixture's `context` and `candidates` objects document the complete JSON shapes. Save the context object alone as a JSON file. Live generation:

```bash
node dist/task-optimize.js ./my-farm --workflow-context ./operator-context.json
```

Context persists in the project database and is reused by later refreshes. `--offline` prints the prompt without changing context or calling the model. `--workflow-candidates ./candidates.json` accepts an array of candidate proposals for offline replay and passes them through the **same** checking and persistence path. Do not label replay data as a live model run.

Operator context contains:

- `observations`: explicit reviewed friction statements, process ID/revision, step IDs, category, source, and `observed` or `farmer_confirmed` basis. The categories are repeated trips, setup, waiting, rework, staging and handoffs. Frame descriptions alone do not prove separate repetitions or wasted time. Observed statements additionally require present source media and matching frame/time coverage. A model claim without supported operator evidence stays a hypothesis and requests a farmer answer or additional recording.
- `measurements`: values, units, provenance, and `measured`, `estimated`, `assumed` or `unknown` kind. Unknown values must be null. The model can reference supplied IDs, but cannot create trusted measurements. Operator inputs are attestations; this app does not authenticate whether a person actually took a measurement.
- `workload`: positive amount, denominator unit, and comparison context for each metric. Missing or differing contexts/units make a comparison unknown. Time converts seconds to minutes; other unsupported conversions are refused. No arithmetic derives distances from an unscaled scene, duration from gaps between frames, or water use from video. Quality scores use higher-is-better and effort scores use lower-is-better; compare the same documented method and scale. A comparison is not proof of causality.
- `constraints`: budget in USD, available people, required condition IDs, forbidden change tags and free-text notes. Missing resource limits or requirements defer proposals. Estimated or assumed resource requirements need verification even when below a limit. Resource requirements must use absolute cost/labor measurements with no workload denominator.
- `conditions`: operator checks of prerequisites, access and quality for the proposed method, with `met`, `not_met` or `unknown` status and a source/rationale. Any required unmet condition blocks the proposal. Missing checks and free-text constraints remain unvalidated rather than being guessed. Corrected process prerequisites and preconditions are also checked, even if the model omits them.
- `spatial_options`: explicit scene/revision/entity references and proposed SpaceIR documents. Geometry remains owned by OI. Options are candidate data, not scene edits.

Every candidate must explain what changes, why, cost/quality/effort tradeoffs, uncertainty, and a verification procedure with workload, success and stop criteria. Feasibility is `eligible` under the supplied checked constraints, `deferred` for unresolved inputs, or `blocked` for conflicts. This does not certify that every possible constraint has been discovered. Lower proposed quality blocks the candidate; increased reported effort requires review. Unknown metrics are listed explicitly.

Ranking is deterministic: eligible before deferred before blocked, then descending open-goal weight, then candidate ID. It does not combine money, quality and effort into an opaque score or rank estimated savings as measured results. The output keeps each tradeoff and calculation separate for farmer choice.

## Spatial boundary

With `OI_ROOT` configured, alternatives use the existing pinned `OiRunnerTransport` to read the source scene head and call OI's `validate`. A changed scene revision or invalid alternative blocks it. Missing runtime, failed checks and unresolved findings are explicit. The application never invokes `compile` or `commit` while generating recommendations.

The pinned validator cannot establish all entity-link, physical clearance, accessibility, load or quality claims. Those checks remain unvalidated even after successful schema validation. A declared spatial change without a supplied alternative also defers. Models must declare spatial changes; semantic interpretation of the model's narrative still requires farmer review. No local geometry validator or replacement renderer is introduced.

## API

- `GET /api/improvement-context`: current persisted operator inputs.
- `POST /api/improvement-context` with `{ "context": ... }`: validate and persist changed inputs. Earlier reviews become stale.
- `POST /api/refresh`: existing optimizer generation, using persisted context.
- `GET /api/improvements`: all reviews with current freshness and decision history.
- `GET /api/improvements/<review-id>`: a single review.
- `POST /api/improvements/<review-id>` with `{ "candidate_id": "...", "status": "accepted|rejected|deferred", "rationale": "..." }`: record a farmer decision.

`GET /api/overview` refreshes the linked improvement review and checked plan so rejected, deferred or stale proposals are not shown as ranked actions. Decisions and revision checks share a SQLite transaction. Process versions are captured before generation; changes while the model or OI is working make the resulting review stale.

## Verification

`npm test` runs offline regression coverage for evidence grounding, mismatched frames, workload normalization and arithmetic, missing inputs, invalid units/numbers, conflicting constraints, quality/effort tradeoffs, OI failures and read-only operations, process/context staleness, persistence, API decisions and the real optimizer CLI replay. Live model quality, real farmer benefit and physical layout feasibility are not claimed by these tests.
