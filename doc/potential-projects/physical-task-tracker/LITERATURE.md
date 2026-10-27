# Physical Task Tracker — Literature & Prior Art

Reviewed: 2026-10-27.

## Scope and method

Focused scoping review based on Valency semantic searches and primary paper abstracts, project pages, and dataset documentation. This is not an exhaustive systematic review or a replication of reported results. Search themes: cross-session physical-task progress, episodic memory, object state changes, procedural recognition, viewpoint-robust change detection, and farm-operation datasets. Preprint and conference years are distinguished where available.

The central problem is **evidence-grounded memory for physical work across sessions**. Farm operations means maintaining and operating a farm, not merely diagnosing crops. Construction, renovation, assembly, and repair provide adjacent evidence.

Related documents: [dataset catalog](DATASETS.md), [evaluation plan](EVALUATION.md), [project overview](README.md).

## Problem decomposition

| Capability | Research question | Example |
|---|---|---|
| Session continuity | Can a person recover working context after a break? | Where did we stop repairing irrigation? |
| Evidence retrieval | Can the system retrieve support for an answer? | Last photo before a connection was covered. |
| Visual correspondence | Are observations of the same object or location? | Same bed from different angles. |
| State-change detection | What physically changed? | Pipe added; tray filled; component removed. |
| Task-state inference | Does the observation satisfy a requirement? | Pipe installed versus irrigation tested. |
| Next-step support | What remains and what is unverified? | Pressure test still needs evidence. |

A changed scene, a performed action, and a completed task require different labels. For example, an attached connector does not visually establish that a pressure test passed.

## Core literature

| Work | Contribution | Relevance and limitation |
|---|---|---|
| Trafton et al., 2003 — [Preparing to resume an interrupted task](https://www.sciencedirect.com/science/article/pii/S1071581903000235) | Experimental support for prospective goal encoding and rehearsal of interrupted task state. | Motivates end-of-session checkpoints and resumption briefings. Transfer from laboratory interruptions to multi-day physical work requires testing. |
| Maeda et al., IROS 2020 — [Visual Task Progress Estimation with Appearance Invariant Embeddings](https://arxiv.org/abs/2003.06977) | Learns task-phase representations from discrete snapshots with appearance variations; simulated counting and pouring tasks. | Direct precedent for snapshot-based progress. Does not establish general percentage-complete estimation for arbitrary projects. |
| Park et al., 2019 — [Robust Change Captioning](https://arxiv.org/abs/1901.02527) | Separates semantic changes from nuisance viewpoint changes; introduces CLEVR-Change. | Establishes before/after change descriptions as a research task. Synthetic results do not establish farm robustness. |
| Ego4D — [Episodic Memory](https://ego4d-data.org/docs/benchmarks/episodic-memory/) and [Hand & Object Interactions](https://ego4d-data.org/docs/benchmarks/hands-and-objects/) | Retrieves temporal/spatial evidence about prior experience and benchmarks object state changes. | Relevant to object history and evidence-linked answers. Dense egocentric video differs from sparse session captures. |
| Ashutosh et al., 2023 — [Video-Mined Task Graphs for Keystep Recognition](https://arxiv.org/abs/2307.08763) | Learns probabilistic step relationships from instructional videos instead of one rigid script. | Supports alternative step orders. Learned procedural expectations should not override conflicting observations. |
| Peddi et al., NeurIPS 2024 — [CaptainCook4D](https://aria-research-lab.github.io/projects/CaptainCook4D/) | Benchmarks normal and erroneous procedural execution, step localization, and procedure learning. | Distinguishes attempted actions from correct completion. Cooking and induced errors limit direct domain transfer. |
| Varghese et al., ICCV 2025 — [ViewDelta](https://joshuakgao.github.io/viewdelta/) | Text-conditioned change segmentation using potentially unaligned images. | Allows task-relevant changes rather than every visible difference. Field transfer remains untested here. |
| Mandikal et al., WACV 2026; preprint 2025 — [SPOC](https://vision.cs.utexas.edu/projects/spoc-spatially-progressing-osc/) | Segments actionable and transformed regions within objects. | Closely related to partial completion, such as which surface regions were treated. Benchmarks emphasize material/food transformations. |
| Wu et al., ECCV 2026; preprint 2025 — [SceneDiff](https://yuqunw.github.io/SceneDiff/) | Multiview object change detection using 3D alignment and semantic/spatial features. | Strong match for handheld before/after captures. Added/removed/moved objects do not establish procedural correctness. |

## Construction and industrial context

[OpenConstruction](https://doi.org/10.1061/JCCEE5.CPENG-7313) is a survey and selection framework for open construction visual datasets. It categorizes modalities, temporal properties, annotations, and applications; it is not one unified progress dataset.

Earlier project notes identified the following construction and factory references. Retained as follow-up leads; their detailed claims were not fully revalidated during this review:

- [SSRN 5049036](https://papers.ssrn.com/sol3/papers.cfm?abstract_id=5049036)
- [Buildings 2026 article](https://mdpi-res.com/d_attachment/buildings/buildings-16-02319/article_deploy/buildings-16-02319.pdf?version=1781086431)
- [Daily photos and BIM reference](https://www.mdpi.com/430988)
- [OSTI 2305395](https://www.osti.gov/biblio/2305395) — retrieval timed out during this review.
- [CRC 2022](https://ascelibrary.org/doi/10.1061/9780784483961.086)
- [M-Track](https://ar5iv.labs.arxiv.org/html/2202.07028)

## Product research leads

The following inventory is retained from earlier notes. Descriptions are leads for a separate competitive audit, not freshly verified feature, pricing, or absence claims. This review does not establish that no competing product exists.

- **Pro / contractor**: Procore (before/after photo tooling), Buildertrend —
  enterprise priced and process-heavy.
  ([Procore docs](https://pl-pl.support.procore.com/@api/deki/pages/2695/pdf/Create%2bBefore%2band%2bAfter%2bPhotos%2b(Android).pdf))
- **Homeowner**: HomeZada (budget + photos + action lists), Home Stories (free
  iOS tracker: tasks, photos, time), Budget My Reno (budget + journal + photos).
  ([HomeZada](https://www.homezada.com/home-improvement.html),
  [Home Stories](https://home-stories.12f.dk/),
  [Budget My Reno](https://budgetmyreno.com/))
- **Makers / visual**: BuildLog.diy (session photos stitched into build
  timelapses, materials tracking), Itermark (progress camera with ghost overlay
  for matched framing, before/after timelines), ProgressKit (client-facing
  progress pages with photos).
  ([BuildLog.diy](https://buildlog.diy/), [Itermark](https://itermark.app/),
  [ProgressKit](https://www.progresskit.app/))
- **Farm operations**: Agworld (spray/fertilizer logs, compliance records),
  EOSDA Crop Monitoring (scouting tasks, growth-stage reports), Farmstand
  (visual season timelines, same-angle weekly photos), Planfix-style photo
  verification on task close, GRAS smallholder app (certification records).
  ([Agworld](https://agworld.com/za/growers/digital-records-permanent/),
  [EOSDA](https://www.appbrain.com/app/crop-monitoring/com.eos.scouting),
  [Farmstand](https://www.farmstandapp.com/61920/how-to-incorporate-farm-observations-into-production-records/),
  [Planfix](https://planfix.com/blog/industry-insights/real-time-monitoring-of-agricultural-projects-using-task-management-software/),
  [GRAS](https://www.gras-system.org/service-competence/our-services/smallholder-monitoring/))


## Evidence-supported gap and open questions

Individual capabilities have research demonstrations. Their reliable integration across sparse, uncontrolled sessions remains a hypothesis to evaluate.

- **Correspondence under nuisance changes:** distinguish real work from camera motion, lighting, weather, occlusion, or objects leaving the frame.
- **Partial and non-monotonic progress:** support unfinished work, mistakes, undoing, and rework; later does not necessarily mean closer to completion.
- **Progress without a formal plan:** infer observable states and propose milestones, but require a defined denominator for percentages.
- **Uncertainty:** separate observed, user-reported, inferred, contradicted, and unverified status. Model confidence alone is not calibrated evidence.
- **Sparse observations:** unseen work and hidden properties may be impossible to recover from photographs.
- **Operational context:** combine photos with notes, confirmations, timestamps, and optional measurements.
- **Offline use:** evaluate local capability and capture/sync under real device and connectivity constraints; do not assume all farms have identical needs.
- **Human outcomes:** establish whether briefings reduce resumption time and errors enough to offset documentation effort.

Segmentation supplies candidate regions. Correspondence and state reasoning must establish meaningful change; task requirements and adequate evidence must establish completion.

## Research question

Can sparse, evidence-linked observations reduce the time and errors involved in resuming and handing off physical work, while reliably distinguishing observed progress from unverified completion?
