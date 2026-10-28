# Meta Hackathon

Project repo for the Meta Global AI Developer Hackathon 2026. Candidate builds
are being evaluated under [doc/potential-projects](doc/potential-projects).

## Run the demo

Prerequisites: Node 18+ (`node --version`). No `npm install` — zero
dependencies. The working build is the farm-operations task tracker:

```bash
cd C:\Users\isaya\meta-hackathon\doc\potential-projects\physical-task-tracker\demo
node task-optimize.mjs ./my-farm --goal "Transplant bed 3 by Friday" --weight 5 --offline
node serve-dashboard.mjs ./my-farm --port 8123
# open http://localhost:8123 in a browser
```

Two commands, no API key, no network — dashboard up with a starter goal.
Full loop (scan → compare → briefing → optimizer → ecology → dashboard)
with per-step commands: [demo README](doc/potential-projects/physical-task-tracker/demo/README.md).

## Meta Global AI Developer Hackathon — Scope

Built for the [Meta Global AI Developer Hackathon 2026](https://cerebralvalley.ai/e/meta-ai-developer-hackathon) (Meta + Cerebral Valley, Oct 26 – Nov 4, 2026; submissions due Nov 4, 9:00 PM ET). Indie track: judged on creativity, technical ambition, and whether it works.

Meta technologies available for this build:

### Meta Model API

All four models are served through the Meta Model API (`api.meta.ai/v1`), which is OpenAI-SDK compatible.

- **Muse Spark series** — Meta's closed-weights reasoning models from Superintelligence Labs, built for agentic work: tool use, computer use, coding, and multimodal understanding, including visual chain-of-thought and multi-agent orchestration. The current generation offers a 1M-token context window. Example uses: coding agents (Spark powers Muse Code), long multi-step tool workflows, agents that operate apps and browsers.
- **Muse Wonder (and Wonder Full)** — Meta's frontier agent models for complex personal and professional tasks, with 1M-token context ($4 / $20 per 1M input/output tokens via the API). Example uses: interpreting leases and contracts, navigating insurance claims, reviewing financial documents and medical information, long-running coding tasks, domain work in law, finance, and health.
- **Muse Image** — Meta's image generation and editing model, live in Meta AI, Instagram, and WhatsApp. It reasons over prompts before rendering, and handles edits, multi-photo blends, object removal, and legible text inside visuals. Example uses: posters and marketing visuals, infographics, custom QR codes, room redesigns, stickers, photo cleanup.
- **SAM 3.1** — promptable visual segmentation foundation model: describe an object in words (or point at an example/box) and it detects, masks, and tracks every match across images and video, zero-shot. v3.1 adds object multiplexing (up to 16 objects in one pass) and roughly 2x faster video tracking. Example uses: real-time multi-object video tracking, creative masking and editing, robotics perception, open-vocabulary visual search, inspection workflows.
- **Meta open-weights models** — via partner credits to select participants: Baseten ($100 + 2M TPM rate limits), Modal ($100, plus serverless GPUs, sandboxes, and LLM training tools), Fireworks ($25 + workshop from Sinan Ozdemir)
- **Muse Code** — Meta's agentic coding agent, used to build this project
- **Workshops + Discord office hours** — live support from Meta and partners during the build window

## Potential Projects

See [doc/potential-projects](doc/potential-projects) for candidate problem statements.

## License

MIT
