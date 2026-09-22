# Gigorave V188.62 — strict body-date/title AI gate + transparent AI queue audit

Build: `0.188.62`.

## Why this hotfix exists

A real `парсер все` run on 2026-09-13 captured 317 items, marked 258 as structural candidates and planned 251 items for AI. The broad structural detector was intentionally recall-heavy: an explicit date by itself admitted an item, while an old date only reduced priority; poster + time/event-word/repost could also admit items with no calendar date at all.

That policy is no longer allowed to decide expensive AI admission.

## New strict AI admission policy

Structural detection remains broad for diagnostics/recovery, but an item reaches the AI processing queue only when all of these are true:

1. An event-date candidate is present in the actual post/message body.
2. A usable event title or participants/title evidence is present in the body.
3. At least one event-date candidate is today or in the future.
4. A publication/UI timestamp never creates date evidence. `publishedAt` may only disambiguate the year when the body already contains day/month without a year.
5. Dates that are clearly administrative (for example `Дата розыгрыша`, a deadline, ticket-sale deadline) are tagged separately and cannot by themselves satisfy the event-date gate.

Known-card media refresh is also subject to the strict gate.

## Transparent owner diagnostics

After capture, the owner now gets:

- the exact number of structural candidates, strict-gate rejects and actual AI queue items;
- up to 8 concrete AI-queue items directly in the status message, with source/id, body date and detected title;
- `run-ai-queue.audit.txt` — human-readable `AI` / `BLOCK` rows with URL, why admitted/rejected and text preview;
- `run-ai-queue.parser-report.json` — full machine-readable audit with every prefilter row and date/title evidence.

Date evidence contains `raw`, resolved date, surrounding body context, role, and `yearInferenceSource` (`body-explicit-year`, `published-at-for-year-only`, or fallback).

## Date parser repairs

- `4.09-800₽` can no longer be read as date `4.09` with fake year `800`/`2800`.
- `27 сентября\n19:00` can no longer swallow `19` from the next-line time as a year.
- Common colloquial dates such as `26го сентября` are recognized.

## Replay of the supplied 2026-09-13 capture

On the same 317 raw cached items:

- structural candidates stay at **258**;
- strict body/title/date gate leaves **31** eligible before DB handling;
- **227** former structural candidates are blocked before AI: **72** have no calendar date in body, **155** only have past event dates;
- using the same DB-match state from the supplied trace, the expected expensive processing queue is about **25**, rather than 251 (known source-owned public cards may still enter media-refresh when they themselves pass the strict gate).

## Regression

- `npm run check:syntax` — PASS
- `npm run check:imports` — PASS
- `npm run check:named-imports` — PASS
- `npm run test:v18862` — **34/34 PASS**
