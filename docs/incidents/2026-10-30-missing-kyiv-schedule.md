# Kyiv missing schedule after midnight on 30 October 2026

The [incident commit](https://github.com/Baskerville42/outage-data-ua/commit/0e1768d602711386b0d41f9841ed83a94af09be4) published an empty Kyiv schedule for 30 October. Missing factual data appeared as white cells, visually indistinguishable from electricity being available. The summary also incorrectly claimed that no outages were expected. The timestamp 28 October came directly from the source's `fact.update`; it was not the schedule date or the image generation date.

## Evidence and timeline

All times below use Europe/Kyiv (UTC+02:00 on these dates). Snapshot times are the stored `lastUpdated` values, not commit creation times.

| Snapshot time | Commit | Factual data |
| --- | --- | --- |
| 28 October 23:56:02 | [02aa3ebd](https://github.com/Baskerville42/outage-data-ua/commit/02aa3ebd58e255e10a616cf690488cc98650e773) | `today` is 28 October; both 28 and 29 October are present. Source update is `28.10.2026 23:35`. |
| 29 October 00:01:37 | [99411648](https://github.com/Baskerville42/outage-data-ua/commit/994116488184eb6c2d3a580117151d6da8e4cb7f) | Normal rollover: `today` becomes 29 October; the already published 29 October schedule remains. |
| 29 October 23:51:07 | [e85b9562](https://github.com/Baskerville42/outage-data-ua/commit/e85b9562cd34b09994e660845dd06b115a81455d) | The run triggered around 23:50 still contains valid data for 29 October. No 30 October schedule is present. |
| 29 October 23:55:53 | [2ccb5dc8](https://github.com/Baskerville42/outage-data-ua/commit/2ccb5dc872fa7bf4ae09ad6f420eb55050416f2f) | Last nonempty snapshot before the incident. Only 29 October is present. |
| 30 October 00:01:29 | [0e1768d6](https://github.com/Baskerville42/outage-data-ua/commit/0e1768d602711386b0d41f9841ed83a94af09be4) | `today=1793311200` (30 October midnight), `data=[]`, source update still `28.10.2026 23:35`. |
| 30 October 00:05–00:31 | Subsequent snapshots | Six more successfully parsed snapshots remain empty. |
| 30 October 00:36 and 00:41 | [3c86f907](https://github.com/Baskerville42/outage-data-ua/commit/3c86f90719860f44c299e37872a9434a195e19c9), [0069d418](https://github.com/Baskerville42/outage-data-ua/commit/0069d418f033768bb1c6701440a093948ff68dfc) | Missing fact marker produces error 422. The existing fallback preserves the already empty snapshot from 00:31. |
| 30 October 00:46:10 | [21fad162](https://github.com/Baskerville42/outage-data-ua/commit/21fad162ecb18b90c9407679f9163d438b3d6b98) | First recovered snapshot for 30 October. Source update changes to `29.10.2026 20:44`. |

Forty historical snapshots were inspected, including all nine commits from the initial empty snapshot through the last empty commit. For GPV45.1, the valid 29 October schedule contains explicit outage slots; the recovered 30 October schedule also contains outages. An empty snapshot cannot be interpreted as an all-day `yes` schedule.

The [incident workflow run](https://github.com/Baskerville42/outage-data-ua/actions/runs/40962494619) started at 00:00:52 and committed at 00:03:14. Its Kyiv fetch retrieved 459001 bytes of HTML. All six jobs checked out `2ccb5dc8`; the render and commit jobs consumed the same JSON artifact. The Kyiv render reported 266 successful tasks, and the push succeeded without a rebase.

Every archived file was compared byte for byte with the incident commit: all **516 files** match. The downloaded ZIP SHA256 values also match GitHub artifact metadata.

| Artifact | Artifact ID | Files |
| --- | --- | --- |
| json-data | 12936931492 | 4 JSON |
| images-kyiv | 12935254858 | 266 PNG |
| images-kyiv-region | 12936732372 | 50 PNG |
| images-dnipro | 12935239628 | 98 PNG |
| images-odesa | 12936473181 | 98 PNG |

This rules out artifact mixing or an image/JSON mismatch in this run. The original workflow did not retain HTML, so the upstream mechanism behind the empty assignment—such as a rollover response, stale source cache, or a script placeholder—cannot be determined from the retained evidence. The known failure is how the pipeline represented a missing current-day schedule.

## Failure mechanism

1. The fetched source assignment advances `fact.today` to the new day without providing a schedule for that day. `fact.update` remains the previous source publication timestamp.
2. The parser accepts valid JSON containing an empty `fact.data`. Syntax success does not imply that the source has published a current-day schedule.
3. Batch rendering enumerates groups from the weekly `preset`, so every group is rendered even when its factual schedule is absent.
4. `buildToday` previously created 24 cells without states. Those cells looked like the white `yes` state, and the renderer accepted their existence as completion.
5. `buildSummary` previously treated missing intervals as evidence of no expected outages. Tomorrow selection could also fall back to today or an old available date.

## Corrected behavior

- Missing day/group data produces an explicit dated “Дані графіка відсутні” row. Missing or invalid individual slots use a striped `?` state.
- Missing or incomplete summaries use a neutral `?` badge and never claim ON or OFF. Twenty-four explicit `yes` slots retain the all-day ON behavior; complete outage schedules retain their intervals and icons.
- The source publication timestamp and the snapshot receipt timestamp have separate labels. The source timestamp is preserved rather than replaced with the generation date.
- Tomorrow means the next Kyiv calendar day, including 23-hour and 25-hour DST days. It cannot fall back to today, yesterday, or a later available date.
- PNG rendering waits for explicit completion markers set after template construction. Static summary placeholders no longer count as completed output.
- Parser logs include day keys and group counts, with a warning when the current day has no factual groups. Valid empty source data remains preserved; yesterday's schedule is never relabeled as today's.
- The workflow retains fetched HTML as `fetch-snapshots` for seven days, including on later step failure, and runs parser and Chromium regression tests.

## Reproduction and validation

`tests/fixtures/kyiv-midnight.json` preserves the incident's `fact` and snapshot timestamp; its weekly preset is reduced to GPV45.1. It is independent of changing production data.

```sh
npm ci
npx playwright install chromium
npm test
npm run test:render
node scripts/render_png.mjs --json tests/fixtures/kyiv-midnight.json --gpv GPV45.1 --html templates/html/emergency-template.html --out /tmp/kyiv-midnight-fixed.png
```

The regression suites cover the incident, alternative empty payloads, missing groups, stale day keys, partial and invalid slots, explicit all-day `yes`, half-hour outage intervals, tomorrow selection, DST and year transitions, all template completion markers, and actual PNG output. An uninitialized summary must fail rendering rather than screenshot its static OFF placeholder.
