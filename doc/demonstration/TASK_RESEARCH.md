# Task understanding & automation research — Field Ops tracker

Research brief for the Meta Global AI Developer Hackathon 2026 submission
packet. Companion to `COMPETITORS.md`. See also `WHY_IT_MATTERS.md`.

## A. Human task understanding

Three layers, bottom to top:

- **Action recognition (what).** Short-clip classifiers (SlowFast lineage)
  label 3-second windows. Solved for benchmarks; brittle on real farm
  footage with occlusion and repetitive motion. Ag-specific work is thin —
  e.g. [video activity classification of pickers](https://arxiv.org/abs/2311.10885v1),
  framed by its authors as a first benchmark, not a solved problem.
- **Temporal action segmentation (when).** Splitting long untrimmed work
  into steps with boundaries. The field runs on procedural benchmarks:
  [Assembly101](https://arxiv.org/pdf/2203.14712v1) (513h, toy assembly,
  ~24 actions/video), EPIC-KITCHENS / Ego4D / Ego-Exo4D for egocentric daily
  life, and 2026's
  [EgoIndAssembly](http://openaccess.thecvf.com/content/CVPR2026W/SAUAFG/papers/Sasaki_EgoIndAssembly_Diagnosing_Fine-Grained_Temporal_Hand_Reasoning_in_Vision-Language_Models_for_CVPRW_2026_paper.pdf)
  showing VLMs still struggle with fine-grained temporal hand reasoning.
  No farm-work equivalent of Assembly101 exists.
- **VLM task description (so what).** Frames + a frontier model returning
  structured JSON (our approach). Strong on progress deltas per recent
  construction VLM papers, but it skips boundaries and timing — which is why
  our per-frame intervals are heuristic, not detected.

Unsolved across all three: open-vocabulary step labels on long, repetitive,
outdoor manual work.

## B. Task automation in agriculture

All steel, no software-for-thought:

- **Weeding/thinning:** [Carbon Robotics LaserWeeder G2](https://www.behindrobotics.com/news/farms-automate-before-factories-agricultural-robots)
  (~$1.4M, $100M+ revenue), FarmWise Titan (acquired by Taylor Farms Apr
  2025), Naïo, ecoRobotix. Weeding robots led 2025 precision-ag funding.
- **Harvest:** Tevel flying fruit-pickers ($18M Series C), Tortuga,
  Dogtooth. Still crop-narrow.
- **Haulage:** Burro (800+ robots, 1M+ autonomous hours) moves picked
  produce — least glamorous, most deployed.
- **Spraying:** DJI Agras line (~400k ag drones in use).
- Pattern ([The Mixing Bowl](https://terrier-mayflower-4gh5.squarespace.com/landscape/crop-robotics-2022-beyond-the-valley-of-death-2)):
  winners pair robotics experts with farm experts; "smart implements"
  (tractor-pulled, autonomy-optional) beat full autonomy on cost.

Limit: one task, one crop, high capex per system. Nobody sells
*understanding* the work — they sell *replacing* one motion.

## C. Task automation in construction

Commercially proven scopes are narrow and repetitive
([market map](https://avvale.co.uk/pages/construction-robot-business-plan-template),
[$2.78B 2025 → $8.99B 2032](http://prsync.com/pw-consulting/--pw-consulting-global-construction-robot-market-hits--b-in--surges-to--b-by--at--cagr-5201612/)):

- **Rebar:** TyBOT/IronBOT (up to 1,100 ties/hr).
- **Layout:** Dusty FieldPrinter (1.6mm plan-on-slab).
- **Masonry:** Hadrian X, SAM100, Monumental; **drywall:** Canvas;
  **earthmoving:** Built ExoSystem retrofit.
- Software side is still manual logs + photo reports
  (Procore/Fieldwire/Raken) with AI only recently layered on.

Limit: one robot per motion at enterprise prices, and progress
*understanding* lives in a separate (also enterprise) product category.

## D. What this means for Field Ops

- Our layer — understanding any task from any phone clip — sits underneath
  both industries' automation stacks and is sold by nobody at indie scale.
- The dataset gap (no Assembly101 for farm/construction hand work) is both
  our risk (no benchmark to prove against) and our novelty claim.
- Every robot above still needs humans doing everything else — those
  humans' work is our input.
