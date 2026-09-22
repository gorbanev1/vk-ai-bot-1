# Gigorave V188.72 verification

Build: `events-v18872-vk-photo-id-reload-poster-r1`

## Automated verification

- Active suite: **105/105 passed**.
- V188.72 focused suite: **18/18 passed**.
- Syntax check: **OK** (479 files).
- Import check: **OK** (479 files).
- Named import check: **OK** (178 files, 0 missing).
- Release runtime-data guard: **OK**.

## Regression coverage relevant to this release

- Two different VK photo anchors that both contain the same stale DOM thumbnail are resolved to two different API media URLs by stable attachment identity.
- `photo-117292629_457263995` is converted to the exact `photos.getById` id `-117292629_457263995`.
- VK transient load-error text causes a bounded page reload.
- A completed page with no wall/post DOM causes a bounded page reload.
- VK login/CAPTCHA state is left to the manual-access flow instead of reload-looping.
- V188.71 venue normalization and multi-poster dedupe regressions remain green.
- V188.70 VK-chat finite-pass `startedAt` regression remains green.
- V188.68 clean-media database repair remains green.

## Release contents

Runtime databases, WAL/SHM files, user `data` directories, logs, browser profiles and captured user media are not included in the release archive.
