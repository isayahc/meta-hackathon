# Process and video locations (#41)

Field Ops stores reviewed associations between an observed process step, a source
clip/range, and either an existing named work area or a pinned OI reference.
OpenIndustries continues to own scenes, objects, geometry, revisions and viewing.
No geometry, SpaceIR validator, spatial renderer or replacement scene store is
introduced.

## In the app

From a workflow's observed step, choose **Link work location**. A task with a
process reference also offers **Open process location links**. Workspace has a
**Work locations & source evidence** section; a named area's **Open linked
process evidence** button filters it to that area.

Choose the reviewed process/action and a range inside one recorded evidence
span. A sampled frame is a single instant, not evidence of continuous activity
between frames. Choose an existing named area, or read a saved OI scene and pick
an object by name. Another scene/reference can be entered under the optional
reference-details disclosure. Supply an identity decision and a reason.

Each saved card shows the action, location, original source range, review status
and freshness/uncertainty separately. **Open source** opens the retained clip at
that timestamp; bounded intervals pause at their end. **Open pinned OI scene**
and **Inspect current scene** use OI's supported viewer URLs. The browser keeps
Field Ops available as the contextual return path. No entity-selection URL or
embedded viewer capability is invented.

A changed process or scene stays pinned to its original revision. Missing
objects are never replaced by nearby or similarly named objects. Use **Review /
re-anchor location** to explicitly choose the reviewed current process/scene;
the prior anchor and reason remain in history. **Keep unresolved** represents
ambiguous cross-visit identity. Rejecting a link preserves its source and review
history. Confirming identity does not clear stale revisions, resolve unsupported
objects, establish scale, or complete a task/goal.

## Persistence and commands

`spatial-association:*` documents in the existing `fieldops.db` store:

- Process ID/revision and step ID.
- Safe local source filename, SHA-256, start/end seconds.
- Named spot ID or OI scene ID/revision, namespace and stable entity ID.
- Human/model origin, proposed/ambiguous/confirmed/rejected review, reason,
  timestamps and prior revisions.

Mutations use atomic retry receipts and optimistic association revisions.
Creating the same source/location association again does not create another
record. A rejected association cannot be resurrected by replaying a new model
proposal. Model-origin creation accepts only proposed or ambiguous identities;
confirmation is a separate explicit review. Media checksum mismatch disables
playback rather than presenting changed bytes as the original evidence.

HTTP: `GET /api/spatial-evidence` lists processes, work areas, known scene
references and checked associations. `POST` accepts the same command as the CLI.
`GET /api/spatial-evidence?scene_id=<id>&revision=<n>` reads the pinned OI
catalog. Stale process/association writes return HTTP 409. No endpoint commits
or mutates an OI scene.

Headless use (replace the absolute example paths with your checkout/project):

```bash
node /absolute/path/meta-hackathon/app/physical-task-tracker/dist/task-spatial.js view --root /absolute/path/project
node /absolute/path/meta-hackathon/app/physical-task-tracker/dist/task-spatial.js apply --root /absolute/path/project --input /absolute/path/location-command.json
node /absolute/path/meta-hackathon/app/physical-task-tracker/dist/task-spatial.js inspect --root /absolute/path/project --scene 11111111-1111-4111-8111-111111111111 --revision 1
node /absolute/path/meta-hackathon/app/physical-task-tracker/dist/task-capabilities.js test spatial --out /absolute/path/new-spatial-run
```

Example creation command; select real IDs/revisions/spans from `view`. The IDs
below illustrate the synthetic test fixture, not a real farm observation:

```json
{
  "command": "save",
  "request_id": "operator-location-1",
  "source": {
    "process_id": "spatial-trays",
    "process_revision": 1,
    "step_id": "spatial-trays-o0",
    "start_s": 4,
    "end_s": 4
  },
  "target": {
    "kind": "oi",
    "scene_id": "11111111-1111-4111-8111-111111111111",
    "revision": 1,
    "entity_kind": "instance",
    "entity_id": "station"
  },
  "origin": "human",
  "review": "confirmed",
  "reason": "Operator recognizes the station in this source frame"
}
```

For a spot, replace target with `{"kind":"spot","spot_id":"bench"}`. To
review, send `command: "review"`, the association `id` and `revision`, a new
`request_id`, `review` and `reason`. To re-anchor, use `save` with the existing
association `id`/`revision` and the complete reviewed source and target. A retry
must retain the same request ID and input; a different intention uses a new ID.

## Supported OI boundary

The connector remains pinned to
`Mapped-Assembly/OpenIndustries@50f78e0bef23c5a6958d80c50e9232066ecc11d2`.
The new `inspect` operation calls the pin's `LocalSceneBackend.read`,
`readManifest`, `canonicalJSON` and `sceneURLs`; it does not read or write OI's
SQLite tables directly. It projects instance identities from the upstream
manifest and compares pinned/current instance and asset metadata digests.
Pose changes therefore require review without introducing a local geometry
assessment. Read operations do not invoke commit or asset persistence.

| Reference / condition | Behavior |
| --- | --- |
| Existing named Field Ops spot | Resolve its existing ID and name; no geometry claim |
| OI whole scene or object instance | Resolve from the pinned manifest; check current revision and instance metadata |
| Region / SpaceIR equipment occupancy | Preserve the explicit reference, but mark resolution unsupported at this pin |
| Missing pinned scene/revision | `scene_unavailable`; preserve link and source |
| Entity missing at pinned/current revision | Separate missing-reference warnings; no automatic substitution |
| Changed scene or process | Stale association until explicit re-anchoring |
| Unavailable runtime or wrong OI checkout | Unverified reference with actionable setup error; source still opens |
| Unscaled or unknown scale | Explicit warning; identity confirmation does not establish measured geometry |
| Changed/missing source bytes | Playback disabled, historical checksum/reference retained |

The old floor-plan compiler does not persist every region/equipment occupancy
as an addressable scene instance. Supporting those identities requires #53;
this feature does not pretend a source label is an OI instance. Meter units in
a scene manifest are not independent calibration evidence, so the real adapter
reports physical scale as unknown. Unscaled inputs are independently rejected
by the upstream compilation path. Route/clearance assessments remain #54.

Set `OI_ROOT` to the pinned checkout with its dependencies installed.
`OI_SCENE_DATA_DIR` selects the existing OI store; otherwise it is the project's
`oi-scenes` directory. `OI_WORKBENCH_ORIGIN` configures the supported viewer.
Reference checking requires the reviewed pin; it does not silently trust a
changed checkout.

## Verification

Unit/HTTP/CLI checks exercise persistence, repeat and conflicting requests,
model review, ambiguity/rejection, revision conflicts, source ranges/checksums,
removed steps, missing work areas, changed/missing entities, unsupported
namespaces, unscaled responses and unavailable OI. The headless `spatial`
capability retains a synthetic replay report; mock OI is explicitly labeled.

The final full suite passed **312 tests** with the pinned OI runtime enabled.
The real pinned OI integration suite was run against an isolated checkout with
installed dependencies. All six integration checks passed, including creating
a scene fixture, moving an instance, deleting it in another revision, reading
the original reference, and confirming inspection did not advance scene state.
This establishes connector identity/revision behavior, not physical scale or
reconstruction quality.

`scripts/spatial-ui-smoke.mjs` exercises the real HTTP handlers with a generated
colored video and synthetic OI responses. It checks source seeking, reload,
stale/missing identity, ambiguity review and keyboard source opening, and
captures 390×844, 1440×900 and 320×844 screenshots. It requires Playwright,
Chromium and ffmpeg. Pass an absolute screenshot output directory as the first
argument after the script path.

Browser execution was attempted on 2026-11-04 but failed before page creation:
Chromium's process-singleton socket was denied (`Operation not permitted`).
No browser-flow pass, screenshot inspection or mobile visual validation is
claimed. Keep that acceptance item open until the script runs and its real
screenshots are inspected on a browser-capable host.
