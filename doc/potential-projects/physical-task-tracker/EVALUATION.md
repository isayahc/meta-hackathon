# Physical Task Tracker — Evaluation Plan

Proposed 2026-10-27. No experiments or results are claimed.
See [literature](LITERATURE.md) and [datasets](DATASETS.md).

## Main question

Can sparse, evidence-linked observations reduce resumption and handoff time and errors while distinguishing observed progress from unverified completion?

## Proposed pilot

Start with 20–30 task episodes, each across several sessions. This is a practical pilot size, not a power calculation or evidence of statistical sufficiency.

Candidate tasks:

- Preparing and filling seedling trays.
- Assembling or repairing irrigation.
- Cleaning and returning tools.
- Preparing beds or repairing small structures.

For each session, record before/after photos or short clips, timestamps, location/object identifiers, a brief operator note, task requirements, and independently checked outcomes. Link each state assertion to its supporting observations.

Include no-change examples, changed viewpoints, lighting shifts, occlusion, partial work, incorrect execution, and undo/rework. Include tasks with nonvisual requirements: an attached connector is not evidence of a passed pressure test.

Suggested annotation fields: project ID, task ID, session ID, observation ID, captured time, entity/location, visible state, claimed action, required outcome, verification source, evidence IDs, and reviewer status. Distinguish observed, user-reported, inferred, contradicted, and unverified claims.

## Baselines

| Baseline | Purpose |
|---|---|
| Checklist plus chronological photos | Test value over a simple usable product. |
| Image-pair VLM | Measure comparison without persistent memory. |
| Retrieval over prior observations plus VLM | Measure the contribution of relevant history. |
| Evidence-linked state records plus a task graph | Test structured memory and procedural constraints. |

Keep input evidence and task instructions consistent across automated baselines. Treat confirmations from users or instruments as additional evidence, not model inference.

## Metrics

| Metric | Measurement |
|---|---|
| False completion | Incorrect completion claims / all completion claims; also report counts and completion coverage. |
| Evidence retrieval | Recall at K against annotated supporting observations and whether cited evidence supports the claim. |
| Change detection | Precision/recall for relevant changes, plus false positives on unchanged scenes and viewpoint-only changes. |
| Abstention | Error among answered claims versus coverage; ability to mark missing evidence unverified. |
| Resumption | Time to the first correct resumed action; omissions, repeated steps, and incorrect next actions. |
| Handoff | Recipient reconstruction accuracy and time, using a person who did not perform the prior session. |
| Capture burden | Operator documentation time per session and missed captures. |
| Device performance | Latency, memory, and functionality on target hardware with connectivity unavailable. |

Split by project/site rather than neighboring frames. Keep related captures in the same partition and maintain a held-out evaluation set. Report failure types, sample sizes, and uncertainty rather than only an average score.

For resumption studies, compare equivalent tasks and counterbalance conditions where feasible. Measure documentation overhead alongside time saved. A later larger study needs a sample-size justification based on pilot variability.

## Interpretation limits

- Scene change is not action recognition; action recognition is not verified completion.
- Later images may show regression.
- Occluded or out-of-frame objects are not necessarily removed.
- An unseen action may be unknowable from the available evidence.
- A model-generated confidence score requires calibration before being treated as a probability.
- Percentage complete requires an explicit denominator such as verified units or defined milestones.
- Artificially removing video frames tests sparse observation, not genuine multi-day handoffs.
