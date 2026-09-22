# Gigorave V188.68

## Исправлено

- Clean-media compatibility repair: UI/avatar/audio media отбрасываются до legacy poster admission.
- VK carousel/UI sanitation: `N/M` рядом с carousel controls не считается датой.
- Retrospective/photo-report negative gate без блокировки отдельного подтверждённого будущего анонса.
- Lossless outer/repost media capture с provenance и repost depth.
- Bounded VK child-link enrichment: whitelist, depth=1, visited cache, per-parent/per-run limits, reusable tab, safe vk.cc redirect handling.
- Provenance-aware dedupe с canonical direct wall при сохранении parent source.
- Non-blocking log cleanup через atomic rotate + detached delete after readiness.
- DB repair tests for clean-media poster recovery, retrospective false positives and collapsed schedule expansion.

## Safety

- Двухфоточные ambiguous source media по-прежнему fail-closed: первая картинка автоматически не выбирается.
- Release runtime-data guard исключает SQLite/WAL/SHM и runtime backup/state из ZIP.
