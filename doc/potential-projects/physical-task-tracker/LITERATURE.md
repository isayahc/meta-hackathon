# Physical Task Tracker — Literature & Prior Art

## Research: machines watching work progress

- Construction progress monitoring is an established CV field: image
  segmentation trained on synthetic data + 3D reconstruction + BIM; UAV imagery
  through object detectors; daily site photos registered against 4D BIM for
  closed-loop Plan–Do–Check–Act management.
  ([SSRN 5049036](https://papers.ssrn.com/sol3/papers.cfm?abstract_id=5049036),
  [Buildings 2026](https://mdpi-res.com/d_attachment/buildings/buildings-16-02319/article_deploy/buildings-16-02319.pdf?version=1781086431),
  [daily photos + BIM](https://www.mdpi.com/430988))
- Factories get the same treatment: instance segmentation tracks modular-unit
  assembly from surveillance cameras in near real time (NREL/ORNL work).
  ([OSTI 2305395](https://www.osti.gov/biblio/2305395),
  [CRC 2022](https://ascelibrary.org/doi/10.1061/9780784483961.086))
- Robotics approaches the same problem from the other side: appearance-invariant
  embeddings let an agent estimate task progress from images across long-horizon
  tasks; milestone verification keeps vision-and-language agents on track.
  ([arXiv:2003.06977](https://arxiv.org/abs/2003.06977),
  [M-Track](https://ar5iv.labs.arxiv.org/html/2202.07028))
- Takeaway: the *technology* (photo → state → progress) is proven in
  industrial settings with fixed cameras and BIM models. Nothing brings it to
  informal, handheld, consumer projects.

## Products

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

## Gap

Every consumer tool is a *manual* journal: the human writes down state, sorts
photos, and remembers context. Itermark's ghost overlay is the closest to
visual continuity, but it aligns framing without understanding content. No
consumer product automatically compares visual state across sessions ("what
changed since Tuesday"), links photos to plan steps, or briefs you on resume
("here is where things stand"). Research proves the vision side works; the
opening is packaging it for non-industrial, handheld use — with a conversational
layer that answers "what's next?" from actual observed state.

## Open problems

- **Occlusion, lighting, viewpoint.** The endlessly cited trio: equipment and
  people block the work, lighting shifts between sessions, handheld photos
  never share a viewpoint. Fixed site cameras dodge this; phone photos don't.
- **Same-spot registration.** Automatically aligning this week's photo with
  last week's photo of the same corner. Manual ghost overlays exist; automatic
  alignment is the open version — and the most demoable problem to solve.
- **Progress without a plan.** Industrial methods compare photos against a
  BIM/4D model; homes and DIY projects have none. Inferring stages and percent
  complete from pixels plus a text description is wide open.
- **Uncertainty calibration.** A monitor that reports confidence and flags
  blind spots instead of hallucinating progress (recent SAM-3-plus-judge work
  tries this but is GPU-hungry and brittle).
- **Privacy and dataset gaps.** People in frames; open datasets
  under-represent occlusion, lighting, and weather (OpenConstruction gap
  analysis).
