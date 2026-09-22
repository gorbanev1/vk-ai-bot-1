# Gigorave V188.71 release notes

Build: `events-v18871-event-media-multposter-venue-dedupe-r1`

## Fixed

- Dedupe now ignores generic venue-type words such as `бар`, `паб`, `клуб`, `hall`, `зал`, `cafe` when comparing venue identity. The meaningful venue core is compared instead; conflicting address numbers remain a hard conflict.
- When two duplicate event records each have independently verified posters, the merged event preserves all verified poster paths instead of dropping one.
- Public event delivery can send multiple verified images for one canonical event (bounded to six attachments).
- Single-event sources may preserve all strong UI-filtered source media. This fixes old single-event chat announcements such as CMID 4928 without guessing that the first source photo is the only poster.
- Multi-event sources remain strict: child events still require per-event poster mapping, so a schedule gallery is not blindly copied to every child.
- VK public media capture now tracks `photo<owner>_<id>` attachment identity and merges immutable snapshot media with rendered `currentSrc`, preventing a stale neighbouring carousel thumbnail from replacing the real poster.
- Multi-event VK posts force poster vision mapping when a gallery is present, even when text alone already identifies the child events.
- Verified snapshot schema bumped to 8 and dedupe algorithm identity bumped to `event-dedupe-v18871-venue-generic-media-merge-1` so old cached canonical results are invalidated.

## Compatibility

V188.71 includes the V188.70 poster-ingest fix, V188.70 VK-chat `startedAt` fix, V188.69 startup responsiveness changes, and V188.68 media/sanitation/repost/enrichment fixes.
