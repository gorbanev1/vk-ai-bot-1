# Gigorave V188.70 verification

Build: `events-v18870-poster-bind-on-ingest-chat-fix-r1`
Package: `0.188.70`

## Poster delivery fix

The V188.68 clean-media rule is now applied at event ingest time, not only by a one-shot startup migration. A direct VK/Telegram source with exactly one strong non-UI local source image receives a durable safe poster binding immediately. Multi-event sources require a unique per-child clean image. VK-chat/repost sources remain stricter: only one child + canonical wall + exactly one clean source image can be grandfathered; ambiguous two-photo chat messages remain fail-closed for poster vision.

Parser-all also forces the deterministic clean-media binding pass after processing and before the verified snapshot is rebuilt. The migration key was advanced to `events-v18870-clean-media-poster-compat-v3`, so installations that already ran the older V188.68 migration repair newly created posterless rows on first V188.70 startup.

## Real supplied DB/data verification

Tested on a copy of the supplied SQLite/WAL family together with `data(5).zip`.

`vk.ru/wall-240444315_7` (`SENAMIRHA / THE LAST OF VAVILONE`) repaired to:

- `poster_match_status=legacy_clean_single_source_poster`
- `poster_image_index=1`
- real poster file `vk_announcements/vavilone_rb/7-1.jpg` (640x960)
- tiny 108x108 / 72x72 / 34x34 UI/avatar/audio images were not admitted as posters.

A simulated subsequent parser replacement with an empty incoming poster status was immediately persisted as:

- `poster_match_status=legacy_clean_single_source_poster`
- `poster_match_reason=ingest-clean-media+single-poster+url-role-filter`
- `poster_image_index=1`

This verifies the original failure mode no longer returns after every parser run.

Database verification on the real-run copy:

- `PRAGMA quick_check = ok`
- `PRAGMA foreign_key_check` returned 0 rows.

## VK chat capture fix

`runFiniteManualPass()` no longer references an undefined `startedAt` while creating its raw-ledger run id; it derives the id from `finitePassStartedAt`. This fixes the reported `startedAt is not defined` failures for chat sources such as conversations 22, 3 and 14.

## Tests

- Focused V188.68/V188.70 event/parser regressions: 16/16 passed.
- Active release suite: 103/103 passed.
- Syntax check: OK (474 files).
- Import check: OK (474 files).
- Named import check: OK (175 files, 0 missing).
- Release runtime-data guard: OK.

No user SQLite/WAL/SHM, `data`, logs, browser profile or runtime state is included in the release ZIP.
