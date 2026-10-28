# Demo: task-scan

Sends a farm-work photo to a Muse model and gets back structured task state:
what work is happening, what stage it's at, visible progress cues, safety
flags, and suggested next steps as JSON.

## Run

```bash
node task-scan.mjs https://upload.wikimedia.org/wikipedia/commons/0/0a/Harvesting_carrots.jpg
```

You'll be prompted for your Meta API key (typed blind) — once. Say yes when
asked and it's remembered in `%APPDATA%\meta-hackathon\demo-key.json` (outside
the repo, never committed), so later runs skip the prompt. Precedence:
`META_API_KEY` env, then the saved key, then the prompt. Delete that file to
forget the key. Any `https://` image URL or local path works
(drop your own photo into `samples/`). `META_API_BASE` and `MUSE_MODEL` env
vars override the endpoint and model. `MAX_TOKENS` (default 4096) sizes the
token budget — the default 800 starved the model's reasoning and returned
`finish_reason='length'` with null content. `REASONING_EFFORT` is forwarded as
`reasoning_effort` only when set (low|medium|high, provider-dependent).
See `example.env` for the full variable list (placeholders only, no secrets).

Null, empty, truncated, or non-JSON responses are hard errors (nonzero exit),
never printed as successful analysis.

## Regression test

```bash
node --test task-scan.test.mjs
```

Covers the captured `length`/null-content failure shape plus the request
builder defaults.

## Sample

"Harvesting carrots" — agricultural workers harvesting carrots into crates,
Imperial Valley, California, circa 1948.
Source: [Wikimedia Commons](https://commons.wikimedia.org/wiki/File:Harvesting_carrots.jpg)
(Los Angeles Daily News / UCLA collection).
