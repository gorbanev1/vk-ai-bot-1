# Gigorave V188.68 verification

Build: `events-v18868-media-sanitation-repost-enrichment-dedupe-r1`
Package: `0.188.68`

## Release checks

- `npm run check:syntax` — PASS, 472 files.
- `npm run check:imports` — PASS, 472 files.
- `npm run check:named-imports` — PASS, 175 files, missing=0.
- `npm run check:release-clean` — PASS; runtime SQLite/WAL/SHM/data/logs are not shipped.
- V188.68 targeted regression batch — PASS, 28/28.
- V188.67 regression suite after release-identity update — PASS, 67/67.

## Fresh user database integrity

The uploaded SQLite family was opened as a consistent WAL-backed database copy before release packaging.

- `PRAGMA quick_check` — `ok`.
- `PRAGMA foreign_key_check` — 0 violations.
- Snapshot row counts observed during integrity check: `vk_events=29`, `vk_chat_events=10`.

The user's database and media/log archives are verification inputs only and are NOT included in this release ZIP.

## V188.68 regression coverage

- clean-media compatibility repair: real poster + small UI thumbnail -> poster restored;
- ambiguous two-photo chat event remains fail-closed;
- `1/10` VK carousel counter never becomes 1 October;
- same-node carousel UI sanitation;
- ordinary `11/10` date remains valid;
- retrospective/photo-report rejection while preserving separately proven future announcements;
- lossless outer + nested repost media capture;
- media provenance/repost depth preservation;
- bounded VK child-link whitelist and safe `vk.cc` redirect handling;
- provenance-aware parent schedule/direct-wall dedupe;
- explicit time/venue conflicts still prevent incorrect merges;
- collapsed schedule database repair regression;
- non-blocking atomic log rotation with detached deletion;
- runtime data-root and event poster durability regressions.

## Release contents

Source code, tests, docs and release notes only. No live SQLite, WAL/SHM, runtime `data/`, runtime logs, backups or user media are bundled.
