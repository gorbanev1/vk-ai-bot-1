# V188.60 — parser-all poster refresh + multi-announcement completeness guard

## Confirmed from `logs(1).zip`

The parser bug was reproduced in the supplied runtime trace, not inferred from screenshots.

### One digest post was collapsed into one event

VK post `rb_diesel/13738` (`https://vk.ru/wall-117292629_13738`) contains a September schedule with at least ten separate announcements and 10 source images. The old trace processed only IMAGE 1..8 and then wrote exactly one DB event (`effectiveEventCount=1`, date `2026-09-25`, title `запись закреплена`).

### Community avatar entered poster candidates

Raw cache contains VK image URLs with `ava=1` among ordinary post images. Confirmed examples include `vk:overlockbar` and `vk:deadway36`. These are profile/community avatar candidates, not event posters.

### Parser-all skipped already-known DB cards

The old prefilter treated an existing event as `database-known` and did not send that source post through media/vision again. Therefore a stale avatar or empty poster could survive unlimited repeated manual `парсер все` runs.

## Fixes

- Manual `парсер` / `парсер все` is now a media repair pass for DB-known VK public posts when current real post media exists.
- Known cards are rechecked by vision instead of being blindly skipped.
- Fresh event-level poster replaces stale stored media for confidently matched event rows.
- Partial reparse cannot delete unmatched stored events. If fresh extraction returns fewer events than are already stored, only confidently matched rows are updated.
- A successful richer reparse may expand an old collapsed digest row into multiple event rows.
- `?ava=1` / obvious avatar URLs are rejected again at fingerprint/download time (defense in depth).
- VK API `preview-only` images are no longer admitted as event poster candidates. Better no image than a community avatar/link-preview image.
- Up to 12 source images survive pre-AI fingerprinting and poster vision. The old hidden 8-image loss is removed.
- Explicit per-event `image_indexes` is preserved, so different announcements from the same post can receive different posters.
- Public multi-event extraction has a 6000-token output budget.
- Added a finite completeness retry: when the source clearly contains multiple dates / many `[IMAGE N]` blocks but the first AI extraction returns only 0–1 events, the parser performs one stronger re-extraction and keeps the result only if it recovers more events.
- Parser-all diagnostics now report `databaseRefreshCount`, `[VK EVENT MEDIA FULL RECHECK]`, `databaseWriteMode`, stored/fresh event counts and media-refresh matches.

## Safety

No database migration deletes event history. The media refresh path is update/replace only for a proven same-source VK post, and partial extraction is protected against destructive row loss.

## Verification

- `npm run test:v18860`: 10/10 PASS
- `npm run test:v18858`: 20/20 PASS
- `npm run test:v18857`: 18/18 PASS
- `npm run test:v18853`: 16/16 PASS
- Direct `node --check` passes for all changed JS/MJS files.

The project-wide `check:syntax` helper was not used as proof because it previously exceeded the tool timeout in this environment; changed files were checked directly instead.
