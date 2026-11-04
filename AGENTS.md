# AGENTS.md — working agreement for coding agents on meta-hackathon

## Project

Field Ops physical-task tracker for the Meta Global AI Developer Hackathon
2026 (indie track). Farm ops first, construction second: phone video/photo
in, task lists out. The app lives at
`C:\Users\isaya\meta-hackathon\app\physical-task-tracker` — TypeScript
strict, `src/` compiles to `dist/`, zero runtime dependencies (Node
builtins only; `node:sqlite` is allowed).

## Commands (run from the app dir)

```bash
npm install   # one-time
npm run build # tsc + copy dashboard/samples into dist/
npm test      # rebuild + full suite from dist/ — must stay green
npm start     # build + serve ./my-farm on :8123 + open browser
```

## Conventions

### Headless capability testing (OpenCode and other agents)

When asked to test a capability without the app, read
`doc/headless-testing.md`. Do not start the dashboard or a server. Build the app,
then use `dist/task-capabilities.js list` and `test <capability|all> --out <new
absolute directory>` for repeatable offline scenarios. Use the documented
individual CLIs for supplied media or explicitly requested live model/OI tests.
Keep test projects separate from the user's working farm. Report passed, failed,
and blocked separately; include artifact paths and whether inference was live,
replayed, or mocked. A replay pass never proves live model quality or UI behavior.

### Implementation conventions

- Keep the suite green (`node:test`, no frameworks). Every behavior change
  ships with a committed test next to the code it covers.
- Single-file dashboard (`src/dashboard/index.html`), mobile-friendly, no
  frontend build step. Verify UI changes headless and read the screenshot.
- `lib/` owns shared logic; `task-*.ts` files are thin CLIs with pure-JSON
  stdout (notes go to stderr) because the server parses them.
- Project state lives in `<project>/fieldops.db` (+ `<project>/media/` for
  clips). Legacy JSON migrates once, automatically.
- Use full absolute paths in every command, edit, and answer.
- Never commit secrets. `.env` is gitignored; `example.env` holds
  placeholders only. The API key lives outside the repo at
  `%APPDATA%\meta-hackathon\demo-key.json` and is never printed.

## Sandbox limits (do not fight these)

- No outbound `api.meta.ai`, no `bind()`/`listen()`. Server tests drive the
  request handler directly with mock req/res — no sockets.
- The user runs anything needing a key, a browser pop, or a live port.
  Verify everything else yourself before reporting done.

## Git and PR workflow

- Everything lands through pull requests against `main` on
  `isayahc/meta-hackathon`. Never push directly to `main`.
- One focused branch per change; merge promptly — stacked branches rot fast
  and the merge races are real.
- **Check PR status yourself, regularly.** Before claiming anything about
  merge state ("PR #N is open/merged", "merge X next"), run
  `gh pr view <n>` / `gh pr list` and `git fetch` first. The user merges
  without warning; never write roadmap, status, or next-step guidance from a
  stale snapshot. If a merge landed mid-task, rebase your plan on it before
  continuing.
- After opening or updating a PR, report its URL and what is in it.
