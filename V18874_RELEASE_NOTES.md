# Gigorave V188.74 — parser-all final dedupe + forensic DOM logging

## Dedupe: Vadim Kurylev class of duplicates

The remaining duplicate class was caused by venue conflict logic. A named venue such as `Мама Анархия` and an address-only representation such as `г. Воронеж, Плехановская 48` had zero venue-token overlap, so `venuesClearlyDifferent()` treated them as a hard conflict. That hard negative blocked merge even when the event date/name/participants matched.

V188.74 treats **named venue vs address-only venue as unknown/compatible rather than different**. Generic venue words (`бар`, `паб`, `клуб`, `hall`, etc.) remain excluded from venue identity. Two genuinely different named venues, or explicit conflicting addresses, still remain separate.

`парсер все` now ends with an additional **exhaustive same-day duplicate sweep** after the optimized two-contour dedupe, fixed-point verification and paranoid collapse. It compares all remaining cards inside each exact calendar day, so an obvious duplicate cannot survive merely because a blocking key missed the pair. The final report records compared pairs, merges and any remaining deterministic duplicate invariant violations.

## Source loading cadence and refresh

Parser-all source launch spacing is now **15 seconds by default** (`SCRAPER_ALL_LAUNCH_STAGGER_MS`, configurable up to 60 seconds). This reduces simultaneous browser/network pressure.

VK source pages are refreshed when the page contains a transient load error, returns an empty completed DOM, returns zero parsed posts, or stalls while page health reports a load failure. Automatic reload remains bounded (maximum 3). CAPTCHA/login gates are not looped.

## Full DOM / media / AI forensic logging

Every complete DOM snapshot is written verbatim to a `*.dom.html` artifact. `trace.jsonl` records its exact path, byte length, character count and SHA-256 (`dom.snapshot.full`). Before and after every automatic reload, a complete DOM snapshot is saved.

For each media candidate, diagnostics now retain:

- every DOM attribute on the media node;
- tag/id/full class string;
- ancestor selector chain and ancestor attributes;
- stable anchor URL / VK photo identity when available;
- document ordinal and sibling index;
- nearby text and bounded `outerHTML`;
- local image path/fingerprint;
- full vision response;
- all event binding candidates, scores/reasons and final selected event.

The complete source media decision audit remains persisted into the source-row `image_media_json`; parsed vision facts remain in `image_vision_facts_json`.

## Safety

The change does not re-enable source-membership-as-poster proof. Ordinary photos remain rejected unless vision explicitly classifies and matches them as a poster for the event. Multiple independently verified posters merged from duplicate announcements remain available on the canonical event.
