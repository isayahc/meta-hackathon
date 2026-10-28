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

## Video understanding test

`task-scan-video.mjs` sends N time-ordered frames (default 4) and asks what
changed between them — task progression, the tracker's core mechanic:

```bash
node task-scan-video.mjs <phone-video.mp4 | frames-dir> [--frames 6]
```

Video files need `ffmpeg` (`ffprobe` for duration); a directory of frame
images skips that. Same key handling and env vars as above.

## Action SRT

Add `--srt` to get timestamped action segments as a subtitle file instead of
the progression JSON (frame dirs also need `--duration SECS`):

```bash
node task-scan-video.mjs <phone-video.mp4> --frames 6 --srt
```

Writes `<video>.srt` (or `actions.srt` inside a frames dir). Try it on
ActivityNet video 1 (javelin throw,
[1QIUV7WYKXg](https://www.youtube.com/watch?v=1QIUV7WYKXg)) and compare the
model's cues against the official temporal annotations.

## Field segmentation (SAM 3.1)

`sam-segment.mjs` sends an image plus a short noun-phrase concept to SAM 3.1
(via `/v1/responses` — the chat endpoint rejects SAM) and writes an SVG
overlay of boxes + decoded mask paths:

```bash
node sam-segment.mjs samples/kansas-tile.jpg "center pivot irrigation field" --out pivots.svg
```

Prompts must be bare noun phrases (`agricultural field`), never instructions
(`segment the fields`) — the latter returns nothing. Generic concepts merge
everything into one mask; specific ones separate instances. Needs
`@meta-sam/parser` (`npm install`). Tests: `node --test sam-segment.test.mjs`.

## Sample

"Harvesting carrots" — agricultural workers harvesting carrots into crates,
Imperial Valley, California, circa 1948.
Source: [Wikimedia Commons](https://commons.wikimedia.org/wiki/File:Harvesting_carrots.jpg)
(Los Angeles Daily News / UCLA collection).
