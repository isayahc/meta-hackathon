# Video to a next action

New workflows open the existing segment-GIF review. Confirming the review opens one compact next-action card, without requiring a goal, priority, improvement objective, or written reason.

- **Do next:** accept the suggested action into the existing task store.
- **Later:** retain it as unscheduled work, without inventing a date.
- **Already done:** save an operator report in workflow history, without claiming the video verified success or creating future work.
- **Finish here:** save the observation and stop.
- **Correct:** edit the proposed action and intended result. Corrections persist across reloads and subsequent analysis changes; changed evidence requires review before accepting another action.

The proposal uses the latest reviewed process's first unobserved, not-started suggestion, or “Check the result of the recorded work” when none exists. The last observed action and inferred outcome are shown as context, not verified task completion. This increment uses retained analysis; it makes no additional model call.

Each retained clip appears in the calendar, linked back to its workflow. Recording timestamps take precedence; otherwise the entry explicitly uses upload time. Calendar days/times use the configured planning timezone. These observations reserve no time. Task estimates, completion criteria and goal links remain unknown until supplied; future reservations still use the existing explicit plan-acceptance workflow.

Detailed goals and planning remain under **More options**. Previously configured workflows keep their existing planning flow. Per-step GIF generation and corrections remain unchanged.

## Validation

`npm test` covers proposal acceptance, retries, stale evidence, correction persistence and timezone-aware calendar observations. Browser checks drive the real HTTP handler and SQLite store without a listening port:

```
node app/physical-task-tracker/scripts/review-ui-smoke.mjs /absolute/new-output-directory
node app/physical-task-tracker/scripts/journey-ui-smoke.mjs /absolute/other-output-directory
```

Set `PLAYWRIGHT_CHROMIUM_EXECUTABLE` if using a separately installed Chromium. The focused check uses generated video and real FFmpeg GIFs with injected analysis, exercises all four choices without typing, reloads, calendar navigation, and viewport sizes 1440, 390 and 320 pixels. The full journey check covers the optional planning and follow-up flow. These checks do not establish live model quality.
