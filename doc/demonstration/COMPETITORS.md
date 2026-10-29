# Competitors & landscape — Field Ops physical-task tracker

Deep-research brief for the Meta Global AI Developer Hackathon 2026
submission packet. See also `WHY_IT_MATTERS.md`, `DEMO_PLAN.md`.

## Our loop in one paragraph

Phone video/photo in, task list out: frame extraction → Muse vision
analysis (observed task, stage, progression, next steps) → spot state with
session history → goals + optimizer → eco fusion → calendar, all in
`fieldops.db`, zero runtime deps. Differentiators: no BIM model required,
no 360° rig, no manual logging — a plain phone clip becomes structured tasks.

## Similar technology

- **Construction reality capture.** OpenSpace (360° photo walks mapped to
  plans), Buildots (hardhat-camera footage vs BIM/schedule), Doxel (LiDAR +
  360° for installed quantities), plus Disperse, Cupix, Track3D. All are
  enterprise, quote-priced, and need special capture hardware or a BIM model.
  ([2026 vendor roundup](https://www.constructionplacements.com/best-construction-progress-monitoring-software/),
  [Doxel landscape](https://businessmodelcanvastemplate.com/blogs/competitors/doxel-competitive-landscape))
- **VLM progress-monitoring research.**
  [GPT-4 Vision for construction progress tracking](https://arxiv.org/abs/2412.16108v1)
  (aerial imagery, change over time);
  [VLM-MOA occlusion analysis](https://ascelibrary.org/doi/10.1061/9780784486436.052)
  (2025);
  [ISARC 2024 on mapping segmentation to schedule activities without BIM](https://staging.iaarc.org/publications/fulltext/109_ISARC_2024_Paper_316.pdf)
  — vision + language with no BIM, directly our thesis.
- **Ag human-activity recognition.**
  [Video activity classification of pickers](https://arxiv.org/abs/2311.10885v1)
  (Mask R-CNN + temporal, a benchmark);
  [egocentric strawberry-harvest annotation](https://link.springer.com/chapter/10.1007/978-3-032-15375-3_13)
  (head-mounted camera — our demo setup);
  [SlowFast behavior detection for field manual labor](https://www.mdpi.com/2076-3417/14/7/2976).
  Literature consensus: HAR in agriculture is new and thinly researched.

## Open problems (where we claim novelty)

- Long-horizon task tracking from casual monocular video: multi-minute
  evolving work, not 3-second action clips, with no BIM and no fixed camera.
- Grounding free-text task output in persistent, queryable state
  (spots/sessions) instead of one-shot captions.
- Date/identity provenance for farm clips (our estimated-recording work).
- Offline-first operation — fieldmargin wins users largely on
  works-without-signal ([source](https://www.agri-tech-e.co.uk/fieldmargin-connected-farm/));
  we are server-dependent today.

## Recently solved (what we get for free)

- Open-vocabulary segmentation (SAM lineage) — no per-crop training.
- VLM scene understanding good enough for progress deltas (2024–25 papers).
- Monocular depth estimation (our room-scanner fallback path).
- Cheap structured JSON output from frontier models.

## Competitors and the gap each leaves

| Competitor | What they do | Gap we exploit |
|---|---|---|
| OpenSpace / Buildots / Doxel | 360°/BIM progress tracking, quote-priced enterprise | No hardware, no BIM, indie-farm priced |
| Procore / Fieldwire / Raken | Logs, photos, reports — manual entry | Video generates the tasks, nobody types |
| Conservis–Traction / Granular | Enterprise money + inventory ops ([G2](https://www.g2.com/categories/farm-management/resources)) | Nothing for the small farm's daily work list |
| Farmbrite / fieldmargin / AgriWebb | Small-farm records, maps, offline notes | Records what you tell them; we see the work itself |

Closest collision risk: OpenSpace's automated trackers moving downmarket,
and fieldmargin adding AI to its offline map. Our moat: the only
video→task-list loop that runs on a phone with no rig and no model setup.
