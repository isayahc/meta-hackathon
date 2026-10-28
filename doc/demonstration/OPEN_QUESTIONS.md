# Open questions this work touches

## In science

1. **Sparse longitudinal tracking.** Vision benchmarks assume dense video or
   fixed cameras. Real farm and site observation is sparse phone captures days
   apart, handheld, uncalibrated. No end-to-end benchmark exists for sparse,
   multi-day observations with handoffs and verified completion (see
   DATASETS.md). This project is a first probe of that regime.
2. **Progress without a plan.** Industrial methods compare observations against
   BIM/4D models. Informal work has no plan artifact — stages and percent
   complete must be inferred from pixels plus a short text description.
3. **Same-spot registration across sessions.** Aligning "this week's photo"
   with "last week's photo" of the same corner under viewpoint, lighting, and
   seasonal change. Solved manually (ghost overlays); automatic alignment at
   phone quality is open.
4. **Calibrated abstention.** A monitor that reports confidence and flags
   blind spots instead of hallucinating progress — the "knows what it doesn't
   see" problem. Current judge-model approaches are GPU-hungry and brittle.
5. **Goal grounding.** Mapping raw visual change to a specific human's goals
   (harvest windows, budgets, safety records). No benchmark, no formalism;
   every briefing is currently a hand-written prompt away from sycophancy.

## Why a hackathon demo belongs in that conversation

Each demo artifact doubles as a probe: the SRT tests temporal segmentation,
the compare tests registration and change description, the briefing tests
goal grounding. Failures are findings — a misaligned pair or a hallucinated
stage is exactly the kind of error case the literature says is underexplored.
Ship the misses alongside the hits; judges in this track reward ambition
that knows its own limits.
