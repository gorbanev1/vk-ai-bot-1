# V188.74 verification

## Targeted regression suite

`npm run test:v18874`: **15/15 passed**.

Includes:

- Vadim Kurylev duplicate: named venue vs address-only representation merges;
- genuinely different named venues remain separate;
- parser-all final same-day exhaustive dedupe sweep exists;
- 15-second source launch staggering;
- complete DOM snapshot SHA-256 logging;
- pre/post reload DOM snapshots;
- full DOM media selector/attribute/ancestor audit;
- V188.73 poster-to-event and AI audit regressions.

## Active regression suite

`npm run test:active`: **119/119 passed**.

## Static / release checks

- Parallel Node syntax check: **483/483 files OK**.
- `npm run check:imports`: **OK (483 files)**.
- `npm run check:named-imports`: **OK (178 files, missing=0)**.
- `npm run check:docs`: **OK (44 files)**.
- `npm run check:release-clean`: **OK**.

## Supplied SQLite integrity

Using the latest supplied SQLite/WAL/SHM copy assembled as one WAL database:

- `PRAGMA quick_check`: **ok**
- `PRAGMA foreign_key_check`: **0 rows**

No user SQLite/WAL/SHM or runtime `data/` directory is added to the release archive.
