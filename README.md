# Meta Hackathon

Project repo for the Meta Global AI Developer Hackathon 2026. Candidate builds
are being evaluated under [doc/potential-projects](doc/potential-projects).

## Run the demo

Prerequisites: **Node.js 22 or newer** and npm. From the repository root:

```powershell
cd C:\Users\isaya\meta-hackathon
npm install
npm start
```

The root is an npm workspace: installation includes the Field Ops app, and
`npm start` builds it, serves it at http://localhost:8123, and opens your browser.
Existing project data stays in `app/physical-task-tracker/my-farm`.

Use `npm run build`, `npm test`, or `npm run capabilities -- list` from the
root as well. Running the app's commands directly from
`app/physical-task-tracker` remains supported.

Opening the dashboard does not require an API key. Live video analysis requires
the configured model credentials and network access. See the
[app README](app/physical-task-tracker/README.md) for setup and individual commands.

## Run with Docker

```sh
docker compose up --build -d
```

Open http://localhost:8123. Project data and saved credentials use separate
persistent named volumes; the local `my-farm` folder is not imported automatically.
See [Docker deployment and recovery](doc/docker.md) for Windows/WSL2 and Linux,
keys, existing-project migration, backups, upgrades, and verification.

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


### Live MongoDB records (optional)

Goals, tasks, workflow reviews, process revisions and calendar decisions can now
use MongoDB as their sole record authority. See [setup and explicit import](doc/mongo-records.md)
for the authenticated Docker replica set, `npm start` settings and recovery limits.
Existing projects remain on SQLite until explicitly imported; videos/GIFs remain local.
