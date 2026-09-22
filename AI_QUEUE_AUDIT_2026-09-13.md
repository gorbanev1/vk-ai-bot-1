# AI queue audit — supplied parser-all run 2026-09-13

Run: `2026-09-13T16-59-48-980Z_parser-all_209da5`.

## What happened in the old run

The capture itself succeeded for 317 items. The old prefilter classified 258 as structural candidates and planned 251 for AI after DB handling.

Among the 258 structural candidates:

- **193** had some calendar-date-looking text;
- **65** had no calendar date at all and were admitted by combinations such as poster + time, poster + event word, or repost/wall-link + poster;
- **150** were explicitly tagged `past-date-deprioritized`, but that tag only lowered score — it did **not** block AI;
- only **34** had the old `upcoming-date-priority` signal.

The biggest single source was `chat:2000000003`: 98 captured, 90 structural candidates, 76 with a date, and 71 already marked as past. In other words, a large part of the 251 queue was historical material, not fresh announcements.

Examples of no-date structural candidates in the trace include text previews such as `Егор Жданов 23:12` (`event-time + poster-media`) and several chat messages consisting mostly of a user name/video duration/time plus an image.

The trace snapshot contains 158 model-call events over 40 unique items before the copied log ends. It includes old August events such as `Summer Sound Fest 8 августа 2026`, `Станция 3.14 8 августа 2026`, `Ghost Gig 14 августа 2026`, etc. That confirms the old `past-date-deprioritized` rule was not a hard gate.

## Was the event date being taken from post metadata?

Not as the day/month evidence. The exact raw-cache format keeps `publishedLabel` / `publishedAt` separate from the body text, and candidate date detection reads `contentText` / `repostText` / `text`.

There is one important nuance: when the body says something like `27 сентября` without a year, publication timestamp is useful to infer the year of that body date. V188.62 makes this explicit in the audit as `published-at-for-year-only`; publication metadata is never allowed to create a date when the body has no date.

## Two date-parser bugs found during the audit

1. The old numeric regex accepted a 3-digit year. Text like `до 4.09-800₽` could be interpreted as a date with a bogus year derived from `800`.
2. The old Russian-month regex used whitespace that could cross a newline, so `27 сентября\n19:00` could consume `19` from the time as a year.

Both are fixed in V188.62.

## New admission rule

The broad structural detector is retained only so capture diagnostics do not lose suspicious material. The expensive AI queue now requires all of the following in the actual body text: event date, event title/participants, and a date that is today/future. Administrative dates (draw/deadline/sale cutoff) are marked separately. Publication/UI timestamp never satisfies the date requirement.

Replay over the supplied raw cache gives **31** strict-eligible items out of 317; **227** of the old 258 structural candidates are stopped before AI. With the same DB-match decisions seen in the trace, the expected processing queue is about **25** instead of 251.

The live bot status now prints the first 8 queued items with detected date/title, and writes a full human-readable `run-ai-queue.audit.txt` so each admission/rejection can be inspected without reading JSONL manually.
