# OpenIndustries import boundary (meta-hackathon #36)

Field Ops imports OpenIndustries as a **version-pinned external runtime**,
not an npm dependency. The thin connector (`app/physical-task-tracker/src/lib/oi-connector.ts`)
shapes Meta model observations into SpaceIR v0.1 and runs OI's own
implementation — validate, compile, local commit — inside the pinned checkout.
OI stays authoritative for spatial validation, geometry, persistence, and
preview (including the 2D plan viewport). Field Ops stores OI references
(scene/revision/entity ids) plus run evidence, never geometry.

## Pin

- Repo: `Mapped-Assembly/OpenIndustries`
- Commit: `50f78e0bef23c5a6958d80c50e9232066ecc11d2` (main; includes #96 2D plan
  viewport and the SpaceIR compiler)
- SpaceIR schema: `mapped-assembly.space-ir` v`0.1.0`
- Upstream package `open-industries@0.1.1` on npm predates #96 and is NOT used.

## Why not an npm dependency

Upstream publishes no library entry point: the root package has no `exports`,
and `@openindustries/space-ir` is private with TypeScript-source exports.
Installing the whole repo would drag react/three/vite/playwright into the
zero-runtime-dependency Field Ops app. The supported interfaces are the MCP
stdio server, the local scene backend, and the workbench — all runtime
interfaces, so OI is resolved at runtime via `OI_ROOT` (same category as the
ffmpeg dependency), with the pin verified per run and recorded in evidence.

## Pinned interface (all paths inside the OI checkout)

| File | Used for |
| --- | --- |
| `packages/space-ir/src/index.ts` | `validateSpaceIR` — authoritative SpaceIR verdict |
| `src/lib/space-ir-compiler.ts` | `compileSpaceIR` — walls/partitions/portals to workspace |
| `src/lib/workspace.ts` | `makeManifest`/`canonicalJSON` — manifest + digests |
| `server/local-scene-backend.ts` | `LocalSceneBackend` — local scene persistence |
| `server/mcp-scene-contract.mjs` | error codes (`SceneToolError`) |
| `src/lib/scene-links.ts` | `sceneURLs` — workbench preview links |
| `src/lib/plan-projection.ts` | 2D plan viewport (runs in the OI workbench, #96) |

Invocation: `node --import tsx/esm <dist>/lib/oi-runner.mjs` with cwd =
`OI_ROOT` (tsx/three/ajv resolve from OI's own `node_modules`). The runner
passes document JSON in and verdict JSON out; it contains no spatial logic.

## Setup

```bash
git init <oi-dir> && cd <oi-dir>
git remote add origin https://github.com/Mapped-Assembly/OpenIndustries.git
git fetch --depth 1 origin 50f78e0bef23c5a6958d80c50e9232066ecc11d2
git checkout FETCH_HEAD
npm install --omit=dev --omit=optional --no-audit --no-fund
set OI_ROOT=<oi-dir>   # persistent env; the connector resolves it per run
```

Field Ops env (see `src/example.env`):

- `OI_ROOT` — OI checkout (required for live runs; `--mock-oi` skips it)
- `OI_SCENE_DATA_DIR` — OI scene store; default `<project>/oi-scenes` (OI's
  backend format/code, per-project directory)
- `OI_WORKBENCH_ORIGIN` — preview link base; default `http://127.0.0.1:5173`
- `OI_STRICT_PIN=true` — fail when the checkout is not the pinned commit
  (default: warn, record actual SHA, continue)

To inspect a committed scene in the OI workbench (2D Plan mode), serve OI
with `OI_SCENE_BACKEND=local` and `OI_SCENE_DATA_DIR` pointed at the
project's `oi-scenes` dir, then open the run's `revision_url`.

## Ownership

| Component | Responsibility |
| --- | --- |
| Meta app / Field Ops | image input, Meta model call, observation shaping, task/spot links, run evidence |
| Thin OI connector | SpaceIR envelope, runner transport, ID/provenance propagation, error surfacing |
| OpenIndustries | SpaceIR validation, compilation, units/frames, persistence, preview |

The connector defines request-shaping types for OI's document interface
(required by any API client) and rejects malformed model output
(`OBS_*` codes) before it reaches OI. All spatial verdicts — findings,
diagnostics, conflicts, digests, preview URLs — come from OI modules.

## Recorded upstream gaps (belong in OI, not here)

1. No published `@openindustries/space-ir` package — vendoring was refused;
   the runner imports pinned sources instead.
2. No MCP tool for SpaceIR compile/commit — the runner calls OI's TS modules
   directly (same modules OI's own server uses).
3. Cloud MCP scene tools accept only `cloud`/`example` asset refs, so
   compiled (generated) wall geometry cannot persist through them; the local
   backend path is used instead.
4. Regions/occupancies compile to diagnostics, not geometry
   (`UNKNOWN_REGION_GEOMETRY`, `UNCOMPILED_OCCUPANCY`); equipment footprints
   have no scene representation yet.
5. Openings compile as full-height gaps (`OPENING_ONLY`); leaves/lintels are
   not generated.
6. `localSceneRequest` cannot create scenes (requires base revision >= 1);
   the runner commits new scenes via `LocalSceneBackend.save` with base 0,
   mirroring OI's own verification order.

## Site height rule (verified against the pin)

OI validates a non-null site strictly: width, depth, and height must each
be within 1–100 m (`SITE` error otherwise). A null site validates with an
`UNSCALED` unresolved finding, but `compileSpaceIR` throws
`UNSCALED_SITE` for it — so known width/depth with unknown height cannot
compile as-is. Field Ops therefore never sends a zero or guessed height:
unknown heights fail fast (`OBS_MISSING_HEIGHT`) unless the run carries an
explicit `--assume-height` value, which is labeled as a user assumption in
the SpaceIR `unresolved` notes and the run evidence. Fully unscaled plans
fail fast the same way (`OBS_MISSING_SIZE`) unless `--assume-size <WIDTHxDEPTH>`
supplies an explicit footprint; observed sites always win over either flag.


## Reviewed reconstruction seam (#53)

The same pinned runtime now accepts `oi-reviewed-reconstruction/1` through a
standalone provider-neutral adapter. It reuses immutable local assets and upstream
scene mutation/persistence, adds preview-token gating and revisioned evidence
lineage, and explicitly reports unsupported raw meshes/point clouds/regions.
See [reconstruction-import.md](reconstruction-import.md) for the audited interface,
known metadata/export limitations, scale semantics and headless commands.

## Read-only route assessment (#54)

The pinned OI route adapter composes SpaceIR validation/connectivity, scene/asset
reads, existing conservative plan footprints and runtime geometry primitives.
It reports its supported subset separately from full physical traversability,
which remains unsupported. See [route-assessment.md](route-assessment.md) for
contracts, fixtures, source binding, scale requirements and read-only guarantees.
