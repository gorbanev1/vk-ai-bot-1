# V188.80 verification

## Проверено

- Secondary semantic pre-gate требует body-date и не принимает publication/UI metadata как дату события.
- Direct route: body date + body time + likely title.
- Heuristic route: body date + event/party intent >=65% + likely-title confidence >=65%.
- Carousel `1/10` не создаёт date evidence.
- Poster/joint vision request создаётся только после secondary semantic pre-gate.
- Joint vision получает смысловой текст + одну candidate-image и возвращает отдельное решение announcement yes/no.
- Multi-image batch считается joint-accepted, если хотя бы одна конкретная картинка подтверждена; отклонённая первая картинка не скрывает более позднюю афишу.
- Финальный media binding использует те же `[IMAGE N]` facts; подтверждённый joint visual попадает в существующий poster binding / `prepareEventImages` pipeline.
- Clean ledger пропускает обработанное при similarity >=97%, но не пропускает существенно изменившийся пост только по совпадению source/id.
- Full secondary parser не применяет clean similarity skip.
- Scheduler привязан к 04:00 локальной timezone и сохраняет трёхдневный cadence.
- Runtime process names и capture checkpoints различают secondary/full/clean/auto режимы.

## Автоматические проверки

`npm test`:

- active regression suite: **153/153 passed**.

`npm run verify`:

- syntax check: **OK (495 files)**;
- import check: **OK (495 files)**;
- named import check: **OK (182 files, missing=0)**;
- documentation link check: **OK (56 files)**;
- active regression suite: **153/153 passed**;
- release runtime-data guard: **OK**.

Новые V188.80 regression cases:

- `v18880SecondaryPartyAdmission.test.mjs`;
- `v18880ManualParserSimilarity.test.mjs`;
- `v18880SecondaryAutoSchedule.test.mjs`;
- `v18880SecondaryVisionGateIntegration.test.mjs`.
