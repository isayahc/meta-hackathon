# Reviewed reconstruction import (#53)

This provider-neutral adapter is tracked in meta-hackathon. OI is the spatial
runtime and storage authority; there is no new scene database, renderer, Meta
inference dependency, or OI-repository workstream.

## Audited interface and supported subset

Pinned OI: `Mapped-Assembly/OpenIndustries` at
`50f78e0bef23c5a6958d80c50e9232066ecc11d2` (same pin as the floor-plan connector).
The adapter checks the actual checkout before any scene operation.

| Upstream public interface | Use |
| --- | --- |
| SpaceIR validator and compiler | Existing floor-plan path remains available; regions/occupancies do not automatically become persistent scene instances. |
| `LocalSceneBackend.asset/geometry`, `parseCloudBundle` | Resolve and verify existing immutable asset geometry. |
| `validateSceneRequest`, `mutateScene` | Validate additions/updates, identity, animation references and final geometry. Preview intercepts `save` in memory. |
| `LocalSceneBackend.read/receipt/save` | One authoritative revision store, optimistic concurrency and durable retry receipts. No direct database access. |
| `readManifest`, `sceneURLs`, existing workbench | Reopen and render actual OI instances in existing 2D/3D views. |
| `scene.ts.finalizeAsset`, `persistAsset` | The standalone fixture imports its explicitly synthetic metric geometry through OI. |

**Supported:** human-reviewed placement/correction of an existing immutable local
OI asset in an existing scene. The reviewer must establish asset correspondence;
a mask or centroid is not an asset. The asset's vertices remain metric in its
immutable local frame. Source-to-world scale applies to **placement coordinates**,
not to that asset's dimensions. Position and XYZ Euler orientation are transformed
using the pinned runtime's Three math types, then validated by OI's mutation path.
This adapter supplies the missing transform/lineage seam; it is not an upstream
native reconstruction API.

**Explicit gaps:** raw mesh, point-cloud and region imports, reflection/left-handed
assets, nonuniform scale/shear, cloud persistence, automatic identity matching,
and route/clearance certification. Such geometry candidates return loss diagnostics;
no bounding-box or guessed geometry substitutes for them. SpaceIR remains the
supported path for structural floor-plan geometry. Unknown or failed calibration
blocks placement; a successful parse never establishes metric accuracy.

## Headless usage

From the app directory, build with `npm run build`, set `OI_ROOT` to the pinned
checkout with its dependencies installed, then:

```bash
node dist/task-capabilities.js list
node dist/task-capabilities.js test reconstruction --out /absolute/new-reconstruction-test
node dist/task-reconstruction.js capabilities
node dist/task-reconstruction.js preview --input /absolute/preview-input.json
node dist/task-reconstruction.js commit --input /absolute/commit-input.json
node dist/task-reconstruction.js inspect --input /absolute/inspect-input.json
```

The capability test runs **real OI with deterministic synthetic evidence**, not
model inference or a mock spatial service. It reports `blocked` if the pinned
runtime/dependencies are absent. It retains requests, outputs and the OI scene
store. It does not start the app or a server.

`preview-input.json` is `{ "dataDir": "/absolute/oi-data", "request": REQUEST }`.
Commit adds `"previewToken": "<preview.preview_token>"` to the same payload.
Inspect uses `{ "dataDir": "/absolute/oi-data", "sceneId": "UUID", "revision": 2 }`.
`workbenchOrigin` is optional, default `http://127.0.0.1:5173`; the workbench must
be configured to use the **same local data directory** for its scene links to resolve.

The schema returned by `capabilities` is the complete versioned request contract.
The executable fixture in `app/physical-task-tracker/src/samples/reconstruction-fixture.mjs`
provides a populated example. Its output includes the actual immutable asset ID,
request, preview, committed revision and correction/inspection receipts.

### Standalone, without Field Ops

Copy **only** `src/lib/oi-reconstruction.mjs` and
`src/samples/reconstruction-fixture.mjs` anywhere outside the app. With pinned OI
and its normal dependencies already installed:

```bash
node --import /absolute/OI/node_modules/tsx/dist/esm/index.mjs \
  /absolute/reconstruction-fixture.mjs /absolute/OI \
  /absolute/new-oi-data /absolute/oi-reconstruction.mjs
```

No Field Ops application, build, model packages, checkpoints or API keys are
required. The fixture creates its surveyed metric asset and empty scene through
OI public APIs, previews/imports, retries, corrects, and reopens the old revision.
For custom requests, the standalone adapter accepts JSON on stdin:

```bash
OI_RUNNER_ROOT=/absolute/OI node --import /absolute/OI/node_modules/tsx/dist/esm/index.mjs \
  /absolute/oi-reconstruction.mjs < /absolute/request.json
```

The envelope is `{ "op": "preview", "payload": { "dataDir": "...", "request": REQUEST } }`;
other operations are `capabilities`, `commit`, and `inspect`. It emits one
`{ok,result}` or `{ok:false,code,message,details}` JSON object.

## Contract, evidence and scale

- `source` supplies a stable namespace, run ID/revision, schema and external
  artifact URI/SHA-256 pairs. URI bytes are not fetched by the OI adapter: they are
  durable evidence references, not a claim that external bytes were verified.
  The Field Ops adapter rechecks its retained files and current reviews.
- `frame` declares source ID, units, handedness, axes, row-major 4×4 matrix,
  `source-to-oi` direction, and `oi-world-m-Y-up` target. The supplied matrix
  includes unit conversion; there is **no implicit second conversion**. Only
  finite, invertible, proper uniform similarities are supported. Convert camera
  poses into the declared source world frame before proposing asset poses.
- `scale.predicted_m_per_unit` preserves the raw prediction independently of the
  matrix's applied scale. Calibration and holdout each supply distinct source
  3D anchor IDs/points, artifact ID, measured meters and tolerance in meters.
  Original pixel selections remain consumer evidence; this adapter does not
  silently treat image pixels or centroids as world measurement endpoints.
- Calibration and holdout lengths/residuals are evaluated after transformation.
  Reused anchor IDs or coincident points are rejected, even when renamed.
  `reviewer-attested` independence is required for `holdout-passed`; it remains an
  external attestation, not proof that separate images depict different anchors.
- Scale statuses: `unknown`, `calibration-failed`, `calibrated-unverified`,
  `holdout-failed`, `holdout-passed`. Only successful calibration with no failed
  holdout permits placement. Missing/unattested holdout remains explicitly
  unverified. **`accuracy_certified` is always false.** Original prediction,
  calibration, applied transform and holdout remain separately inspectable.
- Candidates preserve epistemic status, model confidence, unknowns and observation
  IDs. Only `confirmed` candidates can bind. Multiple views of one station belong
  in **one explicitly reviewed candidate**; overlapping observations or duplicate
  proposed targets across candidates are rejected as ambiguous. Names/proximity
  never merge objects.

## Preview, commit, correction and lineage

Preview returns accepted/rejected/unsupported items, proposed poses/bindings,
scale evidence, source provenance, warnings/loss report and an exact preview token.
It performs full upstream mutation validation without saving a scene revision or
asset. Opening OI's backend can initialize/check its database metadata, but preview
does not write scene content. Partial acceptance is explicit; the token covers the
entire request and base snapshot, including every rejected/unsupported item.

Commit requires that token and the unchanged `base_revision`. No accepted items
means no commit. A changed base returns `CONFLICT`; inspect/review with a new
request ID. A reused request ID with different content returns `REQUEST_ID_REUSED`.
Identical retries return the original receipt even after later revisions, without
writing or reverting the current head. Repeating the observations under a new
request ID cannot silently create duplicate stations.

New instance IDs are deterministic within source/candidate identity unless an
explicit ID is supplied. Corrections use `identity.action: "update"`, the existing
entity ID, a fresh request ID, and the current base revision. Stable observation
bindings cannot silently move to a different instance. Older source revisions and
changed artifacts under the same run revision are rejected.

The OI revision document's `reconstruction_imports` extension retains original
requests, evidence digests, bindings and preview receipts. Ordinary `mutateScene`
corrections preserve this extension. Inspection compares a pinned revision with
head and reports `unchanged`, `changed`, `rebound`, `deleted`, or `lineage-missing`,
plus revision staleness. #41 can use the returned scene/revision/instance IDs as
ordinary OI references; no automatic relinking occurs, and its generic scene
inspector conservatively continues to show scale as unknown.

**Upstream metadata gap:** full-scene replacement and portable export do not
promise preservation of custom reconstruction metadata. Historical revisions in
the original backend retain the import; inspection flags missing head lineage.
Use existing instance mutations for corrections and keep the original revision
reference. This adapter does not claim portable export preserves its lineage or
that the generic OI viewer displays calibration status. Metadata is bounded to
1 MiB per scene revision; raw evidence stays in the consumer store.

## Walkthrough (#45) consumer

1. Capture/replay and review stations using the existing walkthrough tools.
2. Supply a plan using the request fields above **without `source`**. It must name
   `mapanything-world` / `predicted_m`, explicit reviewed immutable assets/poses,
   and explicit 3D calibration/holdout endpoints. Raw NPZ depth decoding and
   camera-convention interpretation remain the consumer's responsibility.
3. Package it:

```bash
node dist/task-reconstruction.js prepare-walkthrough --root /absolute/project \
  --id RUN_UUID --revision 2 --input /absolute/import-plan.json
```

4. Put the resulting request in a preview payload with `dataDir` and
   `projectRoot: "/absolute/project"`. Preview, review all losses and scale status,
   then explicitly commit with its token. `projectRoot` is required for this source
   type: preview/commit recheck current reviews, run revision and artifact hashes.

Preparation forces honest replay/live provenance and model confidence, rejects
unreviewed/dynamic/depthless observations, and never derives authoritative station
geometry from a mask/centroid. Original run/review/image/measurement evidence stays
in Field Ops; OI stores references and derivation lineage. A provider-neutral caller
is responsible for equivalently verifying its own source evidence before commit.
