# Room Scanner — Literature & Prior Art

## Depth from a single camera

- **MiDaS** established cross-dataset relative depth (scale- and shift-invariant
  loss, trained on a data mix including 3D films) — enough for ordering surfaces,
  not measurements. ([Ultralytics depth-estimation glossary](https://www.ultralytics.com/glossary/depth-estimation))
- **Depth Anything V2** (25M–1.3B params) is the current open reference for
  robust monocular depth; **Metric3D** targets metric (real-scale) depth and
  performs well indoors (ScanNet-like data); **Align3R** (CVPR 2025) extends
  aligned depth to dynamic video; SfM-guided methods fuse monocular priors with
  multi-view geometry. ([Align3R](https://openaccess.thecvf.com/content/CVPR2025/papers/Lu_Align3R_Aligned_Monocular_Depth_Estimation_for_Dynamic_Videos_CVPR_2025_paper.pdf),
  [SfM-guided monocular depth](https://ar5iv.labs.arxiv.org/html/2503.14483))
- Takeaway: relative depth is solved and open; metric scale still needs a prior
  (known object size, AR session, or one user measurement).

## SAM for rooms and floor plans

- **FloorSAM**: SAM-guided floor-plan reconstruction with semantic-geometric
  fusion; zero-shot room segmentation from point-density maps.
  ([arXiv:2509.15750](https://arxiv.org/html/2509.15750v1))
- **QueSTMaps**: natural-language-queryable room-level topological + semantic
  maps of 3D indoor scenes. ([arXiv:2404.06442](https://arxiv.org/html/2404.06442v1))
- **Layout Anything**: transformer room-layout estimation under Manhattan-world
  constraints. ([arXiv:2512.02952](https://arxiv.org/html/2512.02952))
- SAM mask guidance is also used to separate meshes from 3D Gaussians in indoor
  reconstruction; joint depth+segmentation from sparse views goes back to
  **IterNet**. ([review](https://www.themoonlight.io/tw/review/integrating-meshes-and-3d-gaussians-for-indoor-scene-reconstruction-with-sam-mask-guidance),
  [IterNet](https://ar5iv.labs.arxiv.org/html/1906.07892))

## Products

- **magicplan**: AR-assisted scans, 2D/3D plans, cost estimates, Xactimate
  integration; Android capture limited; subscription.
  ([review](https://illustrarch.com/articles/architectural-technology/73956-magicplan-review.html))
- **Polycam**: LiDAR + photogrammetry, rich 3D meshes, measurements on LiDAR
  captures; power-user oriented.
  ([comparison](https://roomio.io/articles/best-floor-plan-apps-real-estate/))
- **RoomScan Pro**: point-and-tap capture, wall-face mapping handles cluttered
  sites well; quick basic plans.
  ([review](https://illustrarch.com/articles/design-softwares/110334-roomscan-pro-review.html))
- Also: **Canvas** (Structure Sensor hardware), **CubiCasa**, **RoomSketcher**
  (FloorCapture needs LiDAR iPhone), **CamPlan**, **Metaroom**, **KIRI Engine**.
  ([scanner roundup](https://roomscanner.app/blog/best-3d-room-scanner-apps/),
  [floor-plan workflows](https://roomscanner.app/blog/best-software-to-create-floor-plans-by-scanning-your-space/))

## Gap

Everything consumer-grade either needs LiDAR, limits Android, demands manual
touch-ups, or charges a subscription — and none combine zero-shot
open-vocabulary segmentation (SAM), monocular depth, and a conversational
question layer in one phone-only flow. That combination is this project's
opening.

## Open problems

- **Scale ambiguity.** A single image cannot know absolute size; fixes today
  need fiducial markers or learned object-size priors. The product sidestep is
  one user-supplied reference measurement.
- **Transparent/reflective surfaces.** Depth models assume one depth per pixel,
  which breaks on mirrors, windows, and glass tables (ICCV 2025 TRICKY
  challenge). A strong build detects these and flags unreliable depth instead
  of failing silently.
- **Clutter and occlusion.** Furniture hides the walls and floor being measured;
  cluttered rooms remain the hard case for every capture method.
- **Non-boxy rooms.** Layout methods lean on Manhattan-world (right-angle)
  assumptions; angled walls and open plans break them.
- **Temporal consistency.** Stable depth and masks across shaky walkthrough
  video is still active research (e.g. Align3R, 2025).
