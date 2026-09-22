# Gigorave V188.71 verification

Build: `events-v18871-event-media-multposter-venue-dedupe-r1`

## Automated verification

- Active suite: **105/105 passed**.
- V188.71 focused suite: **33/33 passed**.
- Syntax check: **OK** (476 files).
- Import check: **OK** (476 files).
- Named import check: **OK** (176 files, 0 missing).
- Release runtime-data guard: **OK**.

## Regression coverage relevant to this release

- `Бар «Крылья»` and `клуб Крылья` compare as the same venue core.
- `Diesel Hall` and `DIESEL Bar` compare as the same venue core when no conflicting address exists.
- Conflicting explicit address numbers remain `different-venue`.
- Duplicate events keep both independently verified poster paths.
- Single-event chat/source media may retain multiple strong UI-filtered images.
- Multi-event schedule media remains per-event verified rather than blindly shared.
- V188.70 VK-chat finite pass no longer references undefined `startedAt`.
- V188.67/V188.68/V188.69/V188.70 active regressions remain green.

## Release contents

Runtime databases, WAL/SHM files, user data directories, logs, and browser profiles are not included in the release archive.
