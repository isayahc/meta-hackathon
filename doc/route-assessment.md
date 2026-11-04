# Read-only route and clearance assessment (#54)

Field Ops consumes revision-pinned assessments from a provider-neutral adapter
executed inside the existing OI runtime. OI remains the authority for scene
geometry, poses, frame resolution, SpaceIR validation, portal connectivity and
rendering. This integration is tracked and implemented in meta-hackathon; it does
not create a separate OI-repository workstream, database, renderer or planner.

## Audit and scope

The runtime is pinned to OpenIndustries
`50f78e0bef23c5a6958d80c50e9232066ecc11d2`, matching #36/#53.

| Existing OI public interface | Reuse |
| --- | --- |
| `validateSpaceIR`, `resolveMetricPoint`, `accessibleRegions` | Schema, canonical geometry and explicit portal connectivity. Adjacency is not a route. |
| `compileSpaceIR`, `makeManifest` | Verify supplied boundary source identities, poses and actual immutable part geometry against the scene. |
| `LocalSceneBackend.read/asset/geometry` | Read the immutable scene and hash-verified assets; no scene or asset writes. |
| `readManifest`, `hydrateManifest` | Validate scene/alternative poses and resolve missing assets explicitly. |
| `projectWorkspacePlan`, `planContains` | The existing 2D projection's conservative geometry envelopes and point containment. |
| Pinned runtime's Three `Vector3`, `Line3`, `Ray` | Segment lengths and distances composed into a bounded horizontal assessment. |
| `sceneURLs` and existing workbench | Inspect the accepted pinned scene; no new rendering implementation. |

The audited version has **no complete route, physical clearance or path-planning
API**. OI #55 is a broader decision/economics/physical-validation epic, not a
ready route solver. This adapter adds the missing query composition over existing
public operations. `validator.name` is `oi-route-adapter`; a result is not falsely
attributed to an upstream native route solver or certification service.

Supported subset:

- Explicit finite polylines in canonical `oi-world-m-Y-up`, at **Y=0** only.
- Supplied person/cart horizontal width plus per-side margin; circular swept
  profile, with contact conservatively treated as a violation.
- Conservative upstream asset footprints, explicit SpaceIR occupancy polygons,
  bound wall/partition geometry, traversable portal widths, sourced horizontal
  clearance minimums, and the OI planning envelope.
- Proposed translations of existing instance IDs, validated in memory. No new
  assets, geometry, rotation, automatic adoption or persisted alternative revision.

**Not supported:** shortest paths, automatic navigation meshes, verified floor
support/slope, stairs, headroom, door state, dynamic obstacles, cart turning radius,
load/ergonomics, safety/code compliance or full physical traversability. Envelopes
can overestimate an object's occupied area. A failed envelope check means the
proposal violates that conservative check; it does not prove exact mesh collision.

## Commands for OpenCode and other agents

Build the app, set `OI_ROOT` to the pinned checkout with dependencies installed,
and use the CLI. These commands never start a dashboard, server or Meta model:

```bash
npm --prefix /absolute/meta-hackathon/app/physical-task-tracker run build
node /absolute/meta-hackathon/app/physical-task-tracker/dist/task-capabilities.js test routes --out /absolute/new-route-test
node /absolute/meta-hackathon/app/physical-task-tracker/dist/task-routes.js capabilities
node /absolute/meta-hackathon/app/physical-task-tracker/dist/task-routes.js assess --input /absolute/route-input.json
node /absolute/meta-hackathon/app/physical-task-tracker/dist/task-routes.js compare --input /absolute/comparison-input.json
```

`capabilities` returns the complete `oi-route-assessment/1` request schema and its
applicability limits. The fixture is
`app/physical-task-tracker/src/samples/route-assessment-fixture.mjs`; its retained
output contains populated requests and results with real scene IDs and digests.
The capability test reports **blocked**, not a mock pass, when pinned OI is absent.

An assessment input is:

```json
{
  "dataDir": "/absolute/existing-oi-scenes",
  "request": "REPLACE WITH THE REQUEST OBJECT DESCRIBED BELOW"
}
```

Comparison replaces `request` with `baseline` and `proposed` request objects.
Both identify the same scene/revision; the baseline has no alternative. Optional
`workbenchOrigin` defaults to `http://127.0.0.1:5173`. Its OI workbench must use
the same local scene data directory.

## Request semantics

| Field | Meaning |
| --- | --- |
| `scene_id`, `revision` | Exact accepted scene snapshot. A changed head returns a failed revision check and no metric length. |
| `frame` | Must be `oi-world-m-Y-up`; no silent unit or axis conversion. |
| `station_ids` | Two distinct existing instance IDs, in route order. Missing/deleted identities stay unknown; no name/proximity matching. |
| `route` | Explicit `[x,y,z]` vertices, at least two, up to 200, with distinct consecutive points. No inferred intermediate path. |
| `profile` | `person` or `cart`, `width_m`, per-side `margin_m` and source. Null dimensions mean insufficient clearance evidence. |
| `evidence` | Unique external reference IDs, URIs and SHA-256 digests. The query retains references; it does not fetch or certify external bytes. |
| `scale` | The #53 measurement evidence shape, with calibration and separate reviewer-attested holdout anchors **in canonical world coordinates**. Raw predicted scale remains separate. |
| `environment` | Explicit complete/partial coverage declaration, source and unknowns. Completeness is an external assertion, never inferred from scene visibility. |
| `space` | Optional SpaceIR document, canonical SHA-256, endpoint region IDs and source. Upstream validation and compilation bind its boundaries to actual scene geometry before semantic checks. |
| `alternative` | Null for baseline, otherwise ID, expected base revision and unique `{entity_id,position}` translations of existing instances. |

#53's shared transform/measurement evaluator evaluates canonical-world anchors
with the identity transform. Scale must have a passing calibration **and an
independent passing holdout** before any meter-distance result is available.
Repeated anchor IDs/coincident points are rejected. Survey and reconstruction
accuracy remain external evidence: `accuracy_certified` stays false. Convert #53
source-frame anchors through its recorded transform before using them here; raw
model pixels or source coordinates are not canonical-world anchors.

Route endpoints are supplied reviewed access points associated with the named
stations. The adapter does not invent docking positions or certify those access
points. All physical scene instances participate, including visually hidden ones;
hiding an object is not removing an obstacle. Animation is assessed at its base
pose and flagged as incomplete motion evidence.

## Results and interpretation

Every result carries the exact scene/revision, scene/input/result digests, adapter
version, OI pin, source/constraint evidence, assumptions, per-segment observations,
and separate `passed | failed | unknown | unsupported` checks.

- **Request/SpaceIR schema:** valid data is not a physical-feasibility result.
- **Geometric length:** sum of the supplied horizontal polyline segments in
  calibrated canonical meters. Unknown/failed scale, unsupported elevation,
  unresolved station identity or a stale revision cannot produce a meter claim.
- **Obstruction/clearance:** segment checks against supported geometry. Raw meshes
  contribute conservative OI envelopes, not exact collision surfaces. Unknown
  occupancies, missing assets and unmatched source geometry stay explicit.
- **Connectivity:** explicit traversable portals only, with window traversal
  excluded. A connected region graph alone does not establish route reachability.
- **Portal checks:** a route through a window/nontraversable/ambiguous opening
  fails even when the compiler renders it as a full-height gap. Horizontal width
  is checked separately from unsupported lintel height and door state.
- **Sourced constraints:** known horizontal minimums apply conservatively to route
  segments touching the declared region. Access rules and missing geometry/values
  remain unsupported/unknown.

`validated_walkable_route_length_m` is always **null** in this version. Overall
`traversability` is `failed` if a supported check fails, otherwise `unknown` because
the full physical checks are unavailable. No blanket pass is emitted.

A geometric length may be available for an obstructed route. The comparison's
`geometric_length_delta_m` is available only for compatible station IDs, profile,
evidence and scale; it is **not** validated walking-distance savings, trip-count
inference, labor savings, or a decision to adopt. Field Ops owns those business
inputs and subsequent review/follow-up evidence.

## Revision, persistence and views

Assessment only calls the backend's public read/asset/geometry methods. It does
not invoke `save`, `persistAsset`, `mutateScene` or compile/commit transport
operations. `compileSpaceIR` is a pure in-memory source check. An existing backend
is required; OI's constructor may perform SQLite metadata housekeeping, but no
scene revision or asset content is written. The standalone integration fixture
makes write methods throw during queries and verifies zero attempts, unchanged
scene snapshots, and unchanged asset records.

Proposed translations are applied to a cloned manifest and validated by OI's
existing reader/hydrator. They are never adopted. If a proposal moves a source
boundary away from the supplied SpaceIR, its semantic binding becomes unknown.
The head is checked again after evaluation to detect a concurrent edit. Repeating
identical pinned inputs yields the same result and digest.

Existing workbench links point to the **accepted revision** only. They do not
render uncommitted alternatives or route overlays. The JSON result labels that
view scope explicitly; this feature adds no replacement renderer.

## Standalone without Field Ops or Meta

Copy these four files together into one isolated directory:

- `src/lib/oi-route-assessment.mjs`
- `src/lib/oi-reconstruction.mjs`
- `src/samples/route-assessment-fixture.mjs`
- `src/samples/reconstruction-fixture.mjs`

Then run:

```bash
node --import /absolute/OI/node_modules/tsx/dist/esm/index.mjs \
  /absolute/isolated/route-assessment-fixture.mjs /absolute/OI \
  /absolute/new-fixture-data /absolute/isolated/oi-route-assessment.mjs
```

The fixture declares **8 m** for the bent route and **√32 m** for the straight
proposal before executing any query. It imports its explicitly synthetic geometry
through OI first, then performs repeatable read-only assessments/comparison with
scene writes disabled. No app build, model packages, checkpoints, keys, or inference
is required. These results establish integration/arithmetic, not field accuracy.

For supplied requests, the standalone adapter reads
`{"op":"assess","payload":{"dataDir":"...","request":{...}}}` on stdin with
`OI_RUNNER_ROOT=/absolute/OI`; `capabilities` and `compare` use the same protocol.

## Intervention comparison (#42)

A workflow context's spatial option can include `route_assessment: REQUEST` beside
its existing `space_ir`. Scene/revision/station references and the SpaceIR source
must match that reviewed option. The existing optimizer asks OI for a fresh
assessment, using `OI_SCENE_DATA_DIR` or `<project>/oi-scenes`, and retains the
checks/metrics under `assessment.spatial.route_assessment`.

Failed supported checks block that proposal. Unknown/unsupported physical checks
keep it deferred. Field Ops does not recalculate geometry, automatically turn the
geometric path into a distance measurement, infer trips, or claim realized savings.
The original schema-only option remains supported, explicitly unvalidated for
physical feasibility.
