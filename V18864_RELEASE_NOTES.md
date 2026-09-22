# Gigorave V188.64 — poster vision + durable poster delivery

Build: `0.188.64`.

## Why this patch exists

The supplied runtime data showed two separate classes of “event without image”:

1. an approved manual/proposal event could keep `image_paths_json` pointing into the temporary `event_proposals/...` staging directory; when that directory was no longer present, the DB still claimed that the event had images but delivery could not resolve any local file;
2. a multi-event/digest VK post could already have a correct, different JPEG mapped to each child event, but the delivery policy rejected every poster merely because the source was classified as `inline_schedule`/digest.

V188.64 fixes both while keeping the old protection against wrong posters.

## Poster gate

The V188.63 two-stage admission model is preserved:

1. strict body-text gate;
2. after all configured sources finish durable raw capture, body-rejected items with image candidates receive narrow image-only poster vision;
3. only an image that independently proves `афиша события = да`, a title and a today/future event date can rescue the item into main AI.

The poster-gate parser was hardened: horizontal whitespace is now used around labeled fields and `[IMAGE N]` boundaries, so an empty `Название:` cannot consume the following `Дата:` line or combine evidence from another image.

## Durable approved proposal images

`event_proposals/` is now treated strictly as staging. At proposal approval/auto-approval time, existing staged image files are copied to:

`data/manual_event_announcements/proposal-<id>/...`

The durable paths are then used both for refreshing an existing canonical-source row and for inserting a new `manual_events` row.

## Repair of old broken manual rows

At the end of `парсер все`, before rebuilding the verified snapshot, a bounded maintenance pass checks upcoming manual events with exact VK wall URLs whose local poster is missing or invalid.

For each target it:

- tries the exact VK wall API first;
- falls back to the persistent browser recovery path if needed;
- runs the narrow poster-vision reader on candidate source images;
- requires deterministic `[IMAGE N]` matching by the stored event title/date;
- downloads at most the selected matching poster to durable `manual_event_announcements/` storage;
- updates only the image path of the existing manual row.

It never blindly attaches the first gallery image. The owner receives a short repair summary (`targets`, `repaired`, `noSafeMatch`). The normal public `тусы` command remains local-only and never triggers browser/AI repair.

Default repair cap per `парсер все`: `MANUAL_PARSER_MISSING_POSTER_REPAIR_LIMIT=12` (bounded to 1..50).

## Correct multi-event poster delivery

Digest protection is now evidence-based. If several DB rows share one canonical source post, a child event may use a stored poster only when its mapped image path is not used by any sibling row from that source. Thus:

- three child events with `2705-3.jpg`, `2705-1.jpg`, `2705-4.jpg` can each show their own poster;
- three child events all pointing to the same `shared.jpg` still show no poster until repaired.

VK UI/avatar filtering remains unchanged and fail-closed.

## Regression

- `npm run check:syntax` — PASS
- `npm run check:imports` — PASS
- `npm run check:named-imports` — PASS
- `npm run check:docs` — PASS
- `npm run test:v18864` — **48/48 PASS**
