# Physical Task Tracker — Dataset Catalog

Reviewed: 2026-10-27. See [literature review](LITERATURE.md) and [evaluation plan](EVALUATION.md).

These datasets test components, not the complete product. None of the reviewed datasets establishes an end-to-end benchmark for sparse, multi-day farm observations, handoffs, and verified task completion. Sizes below are source-reported, not locally audited. Downloads and model runs have not been performed.

| Dataset | Contents / annotations | Best use | Limitations and access |
|---|---|---|---|
| [SceneDiff](https://huggingface.co/datasets/yuqun/SceneDiff) | 350 video pairs; 1,009 annotated objects; added/removed/moved labels and dense masks. | Correspondence and object changes across viewpoints. | Does not label task correctness. Card lists MIT; kitchen subset derives from HD-EPIC, whose applicable source terms should also be checked. |
| [CSeg / ViewDelta](https://huggingface.co/datasets/hoskerelab/CSeg) | 501,153 image pairs; 374,169 unique prompts; change masks. | Task-conditioned change segmentation. | Synthetic training data; real-field transfer needs evaluation. Dataset license not independently confirmed in this review. |
| [WhereToChange / SPOC](https://vision.cs.utexas.edu/projects/spoc-spatially-progressing-osc/) | 17,000 pseudo-labeled training clips; 1,162 human-annotated evaluation clips; 10 transformation activities. | Partial completion within objects. | Predominantly material/food transformations. Separate human labels from pseudo-labels. Dataset license not independently confirmed. |
| [Ego4D](https://ego4d-data.org/) | Egocentric video; episodic-memory and hand/object state-change benchmarks. | Evidence retrieval, object history, and state-change localization. | Dense video differs from sparse phone captures. Dataset agreement required; do not infer unrestricted reuse. |
| [CaptainCook4D](https://aria-research-lab.github.io/projects/CaptainCook4D/) | 384 recordings / 94.5 hours; 5.3K step annotations and 10K action annotations; normal/error executions. | False-completion testing, error detection, step localization. | Cooking and induced errors. Official project page states Apache 2.0 and links downloader, annotations, task graphs, and baselines. |
| [IKEA ASM](https://ikeaasm.github.io/) | 371 assemblies; three RGB views, depth, action labels, object segments/tracks, poses. | Assembly stage and component tracking. | Controlled scenes. Dataset CC BY-NC 4.0; code MIT. Commercial licensing requires contacting authors. |
| [EgoProceL](https://sid2697.github.io/egoprocel/) | 62 hours, 130 participants, 16 tasks; key-step labels including PC assembly/disassembly and tent assembly. | Procedural structure, missing/repeated steps. | Combines underlying datasets; check their conditions separately. Current page links Google Drive and a mirror; old OneDrive links are expired. |
| [Manual strawberry harvesting operations](https://doi.org/10.5061/dryad.cvdncjtfm) | Published Dec 17, 2025; season-long cart GPS, IMU, harvest mass, tray records, Pick/NoPick labels; 7.63 GB listed. | Farm event tracking and measurable output; multimodal validation. | Sensor data, not imagery. Cart records do not uniquely identify workers. Dataset-specific license not independently confirmed in this review. |

## Supporting sources

- [SceneDiff paper/project](https://yuqunw.github.io/SceneDiff/)
- [ViewDelta paper/project and exact CSeg counts](https://joshuakgao.github.io/viewdelta/)
- [WhereToChange source repository](https://github.com/priyankamandikal/spoc)
- [Ego4D episodic-memory definition](https://ego4d-data.org/docs/benchmarks/episodic-memory/)
- [Ego4D hand/object benchmark](https://ego4d-data.org/docs/benchmarks/hands-and-objects/)
- [IKEA ASM code](https://github.com/IkeaASM/IKEA_ASM_Dataset)
- [EgoProceL code and download guidance](https://github.com/Sid2697/EgoProceL-egocentric-procedure-learning)
- [Harvest dataset code](https://github.com/uddhavbhattarai/HumanActivityRecognitionEfficiencyEstimation)
- [OpenConstruction survey](https://doi.org/10.1061/JCCEE5.CPENG-7313): discovery framework, not one unified dataset.

## Recommended starting set

1. **SceneDiff:** test change detection across handheld viewpoints.
2. **A purpose-built farm-operation pilot:** test the actual multi-session workflow and evidence requirements.
3. **CaptainCook4D:** test incorrect execution and false completion.
4. Add **Ego4D** for historical evidence retrieval, **SPOC** for partial transformations, and **CSeg** for task-conditioned change detection as those capabilities become necessary.

Use subsets and official splits first. Preserve source IDs, label provenance, and applicable terms. Do not present artificially sparsified continuous video as a real multi-day longitudinal dataset.
