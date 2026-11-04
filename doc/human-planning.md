# Goal-linked tasks and human day planning (#47)

The Plan tab now connects goals, canonical tasks, availability, and an advisory
day plan. Calendar task blocks open the same task record. The first policy is
single-person, deterministic, and conservative about missing information.

## User flow

1. Add a goal, success criteria, priority, and optional date-only deadline.
2. Add a task or choose **Review as task** on an optimizer recommendation.
   Existing video checklist actions already appear in the task list with their
   original IDs and source event/media links. Unreviewed actions need confirmation.
3. Open the task, explain and confirm its contribution to one or more goals,
   and record completion criteria, estimates, dependencies, resources, and
   prerequisites. Proposed/rejected associations remain visibly distinct.
4. Set the project timezone, working intervals, daily work limit, and resource
   availability. Add breaks/fixed commitments through the same calendar store.
5. Propose a day plan. Review next action, timing, estimates, unknowns, conflicts,
   and unscheduled work. Accept or reject with a reason. Pin fixed task times.
6. Record actual work and remaining minutes/quantity. Partial work pauses the
   task; explicitly resume when ready. Replan and review any downstream conflicts.
7. Check the goal's outcome separately. Completed task counts are not a percentage
   of goal success. Marking a task done never marks its goal done.

Task → goal → linked task → calendar navigation uses stable action IDs. Calendar
goal filters hide unrelated task blocks but retain fixed commitments and other
calendar entries. Accepted blocks are reservations, not evidence of execution.

The optimizer's former “done” button incorrectly completed its goal. It now
creates/reopens an idempotent task proposal with unconfirmed model goal links.
The task editor/checklist owns task completion; goal outcome confirmation remains
an explicit operator action.

## Store and migration

There is no second task table. Existing `actions` rows gain `task_json` and
`task_rev`; `events` gain optional `timing_json`; goals gain `success_criteria`.
Legacy checklist IDs, open/done state, source events and media remain intact.
Manual tasks use an ordinary action row and a source note event. Intentional
repeated work uses a new create-request ID; retrying an identical create request
returns the same task, while reusing its ID with different input is rejected.

Task metadata records execution/review state, contribution links, explicit
prerequisites, estimates and their source, original estimate, remaining work,
setup/travel/passive durations, split permission, resources, person, location,
allowed window, date-only deadline, defer-until time, optional process
ID/revision/step reference, quantity, actual intervals, and correction history.
Model proposals and human confirmations have distinct link review/origin fields.
Removing a link retains the underlying task and its history.

`human-schedule` in `docs` contains settings, accepted/released blocks, pin state,
and operator decisions. Each `human-plan:<id>` retains its exact input snapshot,
digest, policy version, proposed blocks, preserved blocks, explanations, and
unresolved work. The latest proposal is marked stale when tasks, goals,
commitments, settings, accepted blocks, or referenced process revisions change.
These records can feed #46; this implementation does not train a model.

## Baseline policy

Version: `single-person-greedy/1`.

- Only reviewed tasks with a remaining-time estimate/source, completion criteria,
  the configured person, satisfied prerequisites, and available resources can
  receive new blocks. Unknown/blocked inputs return an explicit explanation.
- Among ready tasks, rank by **maximum** confirmed open-goal priority, then
  earliest task/goal deadline, immediate dependents unlocked, setup+travel cost,
  and stable task ID. Additional goal links do not multiply workload or priority.
- Place work in the earliest feasible free intervals. Dependency completion
  includes passive waiting. Split active work only when allowed. Setup/travel is
  charged once per newly planned task sequence; passive waiting releases the
  operator but reserves that task's required resources.
- Fixed commitments reserve the operator only when marked blocking. Resource-only
  events reserve their named resources. Scans, date-only deadlines, and untimed
  notes do not reserve capacity. Daily limits include logged actual work and
  remaining accepted reservations.
- If all remaining active work cannot fit, leave the task unscheduled and report
  the shortfall. This baseline does not commit partial proposals or extend hours.
- Accepted/pinned blocks stay in place across replans. Changed prerequisites,
  estimates, hours, resource reservations, or dependent timing produce conflicts.
  Resolve them by explicitly releasing affected blocks and reviewing a new plan.
- An elapsed reservation never completes a task or unlocks its dependent work.
  Record actual work or release the reservation before planning from that state.

This is a reproducible baseline, not global optimization. It models one person
and exclusive named resources, not multiple people or fractional capacities.
Calendar proposals are conditional on their planned prerequisites being performed;
they are not evidence those prerequisites have already happened. Learned policies,
external calendar sync, automated process decomposition, and automatic new-video
reconciliation remain outside this change (#50 owns reconciliation). Existing
optimizer suggestions can be adopted and reviewed as tasks.

Actual work logs require an ID, nonoverlapping offset-bearing start/end instants,
an outcome, remaining active minutes, and an explicit done flag. Repeated log IDs
are idempotent. Recording work retires that task's overlapping/future **unpinned**
reservations; pinned and downstream reservations remain for explicit review.
Original estimates, actual intervals, and past plans are retained. Overruns can
therefore make a prior accepted plan infeasible without rewriting its history.

## Time handling

Store timed work as UTC instants and render it in the configured IANA timezone.
Date-only deadlines remain dates. The `time` command converts local wall times
using that project zone, independent of the host/browser zone. DST gaps are
rejected; repeated hours require `fold: earlier|later` (the UI exposes this choice).
Planning spans one local calendar day, including 23/25-hour DST days where local
midnight exists. Zones with a nonexistent/ambiguous midnight need an explicitly
supported day-boundary policy before planning that date; they are rejected rather
than guessed. Working intervals and daily limits are supplied explicitly.

## Headless commands

```bash
npm --prefix /absolute/path/meta-hackathon/app/physical-task-tracker run build
node /absolute/path/meta-hackathon/app/physical-task-tracker/dist/task-planning.js view --root /absolute/path/test-farm
node /absolute/path/meta-hackathon/app/physical-task-tracker/dist/task-planning.js --root /absolute/path/test-farm --command /absolute/path/command.json
node /absolute/path/meta-hackathon/app/physical-task-tracker/dist/task-capabilities.js test planning --out /absolute/path/new-planning-report
```

The scenario stores synthetic tray preparation: one task linked to two goals,
four dependent tasks, a break, an accepted plan, an actual overrun, and a revised
proposal that exposes downstream conflicts. It preserves `baseline.json`,
`after-overrun.json`, `state.json`, and SQLite state. No model/server is invoked.

HTTP: `GET /api/task-planning` returns the shared view; `POST` accepts the same
command objects as the CLI. Stale writes return 409, invalid commands 400.

Example create command (goal ID must already exist):

```json
{"command":"create","request_id":"tray-staging-occurrence-1","task":{"text":"Stage trays and soil","completion_criteria":"Trays and soil are ready at the bench","active_minutes":20,"estimate_source":"Operator estimate","links":[{"goal_id":"prepare-trays-1","explanation":"Makes materials ready for filling","origin":"human","review":"confirmed"}]}}
```

Other commands:

| Command | Inputs |
| --- | --- |
| `view` | None |
| `edit` | `id`, current task `revision`, editable `patch`, `reason` |
| `work` | `id`, task `revision`, `work: {id,start,end,outcome,remaining_minutes,done,quantity?}` |
| `configure` | schedule `revision`, `config: {timezone,person,max_minutes,availability:[{start,end}],resources:{name:available/unavailable/unknown}}` |
| `commitment` | `event: {id,title,start,end,blocking,resources}`; same ID updates that commitment |
| `propose` | local `day` and offset-bearing `now`; use a future review margin for proposed starts |
| `decide` | plan `id`, `decision: accepted/rejected`, `reason`; stale/past-start proposals are rejected |
| `block` | block `id`, schedule `revision`, `action: pin/release`, `reason` |
| `time` | `local: YYYY-MM-DDTHH:MM`, `timezone`, optional `fold: earlier/later` |
| `goal` | goal `id`, exact `expected` goal from view, `patch` for text/criteria/priority/deadline, `reason` |
| `plan` | historical plan `id`; returns preserved input snapshot and current stale status |

Tasks can be marked paused/blocked/cancelled, given `defer_until` or an allowed
`window`, and resumed through `edit`. Edit scheduling by changing the task/window,
explicitly releasing obsolete accepted blocks, and accepting a new proposal.
The API does not move accepted work silently. Goal editing supports text,
`success_criteria`, `weight`, and `deadline`; outcome status still uses the existing
explicit goal-status operation.

## Validation and remaining acceptance

Node tests cover shared-goal deduplication, link review/unlinking, invalid goal
references, migration/checklist compatibility, dependency cycles, fixed and
resource-only commitments, split permission, passive waits, capacity, unknown
inputs, stale/idempotent decisions, pinned blocks, actual overruns, elapsed
reservations, timezone/DST conversion, and HTTP/CLI/calendar identity.

Run the mobile browser check on a machine with Playwright and Chromium:

```bash
node /absolute/path/meta-hackathon/app/physical-task-tracker/scripts/planning-ui-smoke.mjs /absolute/path/planning-ui-qa
```

Optional `PLAYWRIGHT_CHROMIUM_EXECUTABLE` selects an installed browser. Requests
are intercepted and driven through the actual handler without a listening server.
The script checks link assignment/reload, calendar filtering/navigation, task vs
goal completion, mobile width, and writes a screenshot for visual inspection.
Execution in the coding environment was blocked by Chromium's process-singleton
socket restriction. **Mobile/keyboard visual acceptance remains outstanding;
#47 must not be closed on unit tests alone.** Live farmer usability and model
recommendation quality are not established by the synthetic scenario.
