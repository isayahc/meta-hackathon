# floorplan-web-10

Ten real-world floor plans run end to end through the
image -> model -> OI flow (model `muse-spark-1.1`, prompt `floorplan-v5`,
live OI at pin `50f78e0`). Tests extraction robustness across styles,
densities, and dimension styles.

## Layout

- `images/` — the ten inputs (unedited downloads).
- `manifest.json` — ids, provenance, licenses, method constants.
- `run.mjs` — the runner (`npm run dataset:floorplan-web-10`).
- `runs/<id>/` — per-plan `attempt-N.stdout/stderr`, `oi-evidence/`
  (`observations.json`, `space-ir.json`, `run-*.json`), `oi-scenes/`.
- `summary.json` — machine-readable aggregate.

## Sources

All images are from Wikimedia Commons; each entry's `page` field links
the file page for author/attribution.

| id | source file | license |
|----|-------------|---------|
| 01-bedroom-handdrawn | BedroomHandDrawnPlan.jpg | CC BY-SA 3.0 |
| 02-benin-house | Benin House Plan.jpg | CC BY-SA 4.0 |
| 03-bilik-biru | BILIK BIRU.jpg | CC BY-SA 4.0 |
| 04-denah-lantai1 | A04 - DENAH LANTAI 1 Model (1).png | CC BY-SA 4.0 |
| 05-affordable-palace-1-500 | Affordable Palace Opposite Office Floorplan1-500.jpg | CC BY 4.0 |
| 06-areal-domu | Areal Domu cp 332 Kamenicky Senov ul 9 kvetna.png | CC BY-SA 4.0 |
| 07-bently-reserve-office | All Hands 2019 Bently Reserve First Floor.png | CC BY-SA 4.0 |
| 08-barnimstrasse-prison-cell | Barnimstrasse ... Berlin.svg (rasterized) | CC BY-SA 4.0 |
| 09-areas-room-for-rent | Areas completas.jpg | CC BY-SA 4.0 |
| 10-aquileia-superposed | Aquileia-First and Current bldgs Superposed.png | Public domain |

## Method

- Fixed TEST scale: `--assume-size 18x14 --assume-height 2.7`, applied
  only when the model reports no site. Not any building's real size.
- Up to 2 attempts per plan; no retry on truncated output.
- Needs `META_API_KEY` and `OI_ROOT` (plus optional `MAX_TOKENS`).
- Observed vs assumed scale: `observations.json` stores the effective
  site; `run-*.json` keeps `sizeAssumptionM`/`heightAssumptionM`
  (non-null = flag was applied, observed values always win).

## Results (2026-11-03)

10 ok / 0 failed. 31,090 prompt + 48,764 completion tokens, ~3.5 min.

| id | rooms | walls | openings | equip | findings | diags | tries |
|----|------:|------:|---------:|------:|---------:|------:|------:|
| 01-bedroom-handdrawn | 1 | 8 | 1 | 6 | 0 | 22 | 2 |
| 02-benin-house | 13 | 47 | 7 | 0 | 0 | 57 | 2 |
| 03-bilik-biru | 1 | 4 | 0 | 9 | 0 | 23 | 1 |
| 04-denah-lantai1 | 10 | 10 | 4 | 2 | 0 | 23 | 1 |
| 05-affordable-palace-1-500 | 2 | 8 | 0 | 0 | 0 | 18 | 1 |
| 06-areal-domu | 5 | 29 | 10 | 2 | 0 | 42 | 1 |
| 07-bently-reserve-office | 14 | 16 | 10 | 0 | 0 | 25 | 1 |
| 08-barnimstrasse-prison-cell | 15 | 11 | 3 | 0 | 0 | 21 | 1 |
| 09-areas-room-for-rent | 6 | 12 | 3 | 3 | 3 | 25 | 1 |
| 10-aquileia-superposed | 6 | 19 | 0 | 0 | 0 | 29 | 1 |

Notes:

- Dense plans extract coarsely, not wrongly: the 100+ room palace
  yields 2 rooms, the prison 15, the CAD floor 10. No truncation
  occurred; the model self-limits granularity. Recall on dense plans
  is the known limitation, not commit reliability.
- The two retries were model variance, both passing on attempt 2:
  01 hit `OI_SPACE_IR_INVALID` (boundary/portal refs), 02 hit
  `OBS_BAD_SHAPE` (wall regions). First-try rate: 8/10.
- Only 01 produced an observed footprint (3.5x3.8 m, from its scale
  bar). All other footprints and every height are the test
  assumptions — including 08, whose 130 m of dimension lines the
  model did not synthesize into a site.
- 09's 3 findings are `UNKNOWN_GEOMETRY` (severity `unresolved`):
  the model left 3 entities unlocated; OI still committed.

## Renders

`node render.mjs` (or `npm run dataset:render-floorplan-web-10`)
draws each committed `space-ir.json` top-down into
`runs/<id>/render.svg` and rebuilds `index.html`, a side-by-side
gallery of input vs render. Convention: x = world +X (east right),
y = world −Z (north up). Green spans are portals over their parent
wall; orange dashed footprints are equipment; the dashed grey rect is
the site. Entities without geometry are counted in the SVG footer,
not drawn.

## License

Images keep their Commons licenses (see table; CC BY-SA share-alike
applies to image redistribution). Runner, manifest, and run outputs
are project material.
