# Gigorave V188.54 — parser/model-ladder audit fixes

Built from V188.53 after a structured audit of `logs.rar`.

## Fixes

- Active/autonomous communication no longer starts randomly on Luna/Terra. The finite chain is now:
  `default (gpt-5.4-mini) -> gpt-5.4 -> gpt-5.5 -> Luna -> Terra -> Sol`.
- Active communication AI timeout is configurable via `ACTIVE_COMMUNICATION_AI_TIMEOUT_SECONDS` and defaults to 75 seconds (15–180s clamp). The previous 25s timeout was below observed normal model latency in the supplied runtime log.
- Event/manual parser AI attempt timeout defaults to 75 seconds (15–180s clamp) instead of 15 seconds. Supplied parser traces showed thousands of failures clustered at ~15.0s while normal runtime mini successes took ~21–70s.
- Manual parser retries are bounded: default max 6 retry cycles and max 2 hours elapsed. Retry exhaustion becomes an explicit rejected result and is logged as `source.processing.retry-exhausted`.
- Keeps V188.53 vision alias/failover repair, V188.52 DB-lineage guard and V188.51 recursive media context.

## Supplied-log audit highlights

- Big parser-all trace: 257 captured items, 145 AI queue, 125 pipeline errors (123 timeout, 2 fetch failed), 99 retry cycles; final completion took about 8h48m only because legacy retry loop was unbounded.
- Worst observed item needed 42 processing cycles; several others needed 16–21 cycles.
- All 11 sources eventually reported success in that legacy run, but the time/cost behavior was pathological.
- Historical event-parser traces still produced an event even when VK direct-wall access returned Code 27, by falling back to browser/local parsing.
- Runtime GPT log in the supplied time window shows mini normally worked: 11 successful mini responses, median ~35.1s, max ~69.7s; one gpt-5.4 fallback success. No Terra runtime attempt is present in that log window.
- The screenshot showing `gpt-5.6-terra` is consistent with the old active-communication routing, which intentionally selected Luna or Terra first 50/50. It was not proof that lower models failed.

## Verification

Passed on this tree:
- `npm run test:v18854` — 10/10
- `npm run test:v18853` — 16/16
- `npm run test:v18852` — 10/10
- `npm run test:v18851` — 13/13
- `npm run test:v18848` — 13/13 (plus nested V18847 69/69)

A targeted legacy parser/static test selection still has 3 failures, and the exact same 3 fail on V188.53 baseline; these are stale source-shape assertions, not new V188.54 failures.
