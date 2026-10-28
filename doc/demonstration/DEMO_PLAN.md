# Demo plan — head-mounted planting, two sessions

## Concept

One grower, one phone strapped to the forehead, one garden bed, two visits.
No checklist is touched on camera. The system watches both sessions and
produces what no todo app can: what changed, what stage the work is at, and
what to do next.

## Session 1 — planting day (~3–5 min)

- Mount: forehead strap (you look where your hands are). Test once for bounce.
- Task: transplant a row of seedlings — empty bed → holes → seedlings in →
  watered. Dense visible state change per minute.
- Capture: continuous phone video, natural work, no narration for the model.
- Run: `task-scan-video.mjs bed-session1.mp4 --frames 8 --srt`
- Expect: an SRT of phases (prepare → plant → water), plus the progression
  JSON as the session-1 state file.

## Session 2 — check-in, ~3 days later (~2 min)

- Same bed, same mount, walk the row once.
- Run: compare mode on session 1 vs session 2 (to be built).
- Expect: per-spot diff — what grew, what wilted, what was disturbed —
  folded into a resume briefing: "here is where things stand."

## What the judges see (estimated)

1. **Side-by-side frames**, day 1 vs day 4, same corner auto-aligned.
2. **Change callouts** overlaid or listed: new growth, disturbed soil, a
   leaning seedling flagged for attention.
3. **The briefing**, generated live: stage, progress toward the grower's
   stated goal ("established row before the dry spell"), next actions,
   one safety note.
4. **The SRT** scrolling under the session-1 replay — proof the machine
   actually watched the work.

Total stage time: under 4 minutes. Backup: pre-recorded run of the same
pipeline in case of dead wifi or flat battery. Never demo true-live camera;
the video file played at 1× is indistinguishable and far safer.

## Shot list (session 1)

1. Wide pass of the empty bed (establishes the spot).
2. Digging holes along the row (phase 1).
3. Seedlings from tray into holes (phase 2).
4. Watering pass (phase 3).
5. Closing wide pass (end state for session-2 comparison).
