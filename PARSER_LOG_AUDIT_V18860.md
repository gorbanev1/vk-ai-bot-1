# Parser audit behind V188.60

Source: user-provided `logs(1).zip`.

## rb_diesel/13738

The raw cache contains 10 image URLs and a text schedule:

- 12.09 — HALL + BAR announcements
- 17.09 — BAR
- 18.09 — BAR
- 19.09 — HALL + BAR
- 25.09 — BAR
- 26.09 — HALL + BAR
- 27.09 — BAR

That is at least ten independently advertised items in one parent post.

The old trace contains poster-vision records only for image numbers 1 through 8. Its final DB write is:

- `effectiveEventCount=1`
- `acceptedEventCount=1`
- `imagePathCount=8`
- only event date `2026-09-25`
- title `запись закреплена`

Therefore the old pipeline had both an image-count truncation and an event-cardinality collapse.

## Avatar contamination

Raw cache examples contain URLs with `ava=1` among the post's image list, including `vk:overlockbar` and `vk:deadway36`. Such URLs are community/profile avatar media and must not be selected as announcement posters.

## Why re-running parser-all did not fix stored cards

The prior prefilter only queued `decision.candidate && !existing`. A card already present in the DB was marked known and skipped before vision/media enrichment, so a stale avatar or no-image row could not be repaired by repeated manual parser-all runs.

V188.60 changes manual parsing into a repair pass for known same-source posts with current real media and makes the refresh non-destructive when the new extraction is incomplete.
