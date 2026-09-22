# Gigorave V188.77 — one-time startup poster repair

## Why this release exists

V188.73 deliberately invalidated legacy heuristic poster bindings so ordinary photos could no longer be shown as event posters. That safety migration preserved source media, but it left many older upcoming events without an event-level image until their source happened to be reparsed by a newer parser run. `logs(10)` confirms that newly reparsed sources can obtain `exact_poster_match`, while older stored events can remain text-only even though their cached source images still exist.

## V188.77 behavior

On the first successful startup of this build, after `[BOT READY]`, the bot schedules a detached one-time poster repair. It scans upcoming VK-public, Telegram, and VK-chat event sources that still have posterless/unsafe event bindings and evaluates the already cached local source images.

- Existing stored vision facts are reused when available.
- Images without stored vision facts are sent individually through the poster-vision gate.
- Obvious VK UI/avatar media is excluded before AI.
- The same deterministic poster-to-event matcher used by the parser assigns images to child events; multi-event sources remain one-to-one and cannot blindly share one image between several announcements.
- Only a real `exact_poster_match` is written back to the event.
- Source-level vision facts are persisted, so future forensic logs/repairs have durable evidence.
- Ordinary photos, logos, avatars, album art, UI and uncertain images stay unbound.

The pass begins only after the bot is ready to accept commands and yields between sources so it does not monopolize the Node event loop.

## Exactly once

A durable migration marker `events-v18877-startup-poster-vision-repair-v1` is written only after a pass completes without errors. Once that marker exists, normal restarts skip the repair permanently. If an AI/provider failure interrupts the repair, the marker is not written and the next restart retries it instead of falsely declaring success.

## Preserved behavior

- V188.76: minimum 7-second delay before automatic VK `page.reload()` retries.
- V188.74+: 15-second stagger between source starts and complete DOM/media diagnostics.
- V188.75: DIESEL Bar and DIESEL Hall remain a hard venue boundary; generic words such as bar/pub/club/hall are otherwise ignored for normal venue-core comparison.
- V188.73: unsafe source-membership-only poster bindings are not considered trustworthy.

## Release identity

- package version: `0.188.77`
- build: `events-v18877-startup-poster-repair-r1`
