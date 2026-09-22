# Gigorave — локальный refactor patch

Основа: присланный минимальный audit archive + отдельно присланный `botApplication.js`.

## Что изменено

- Vision facts: структурированные поля теперь читаются и при разделителе `;`, не только при переносах строк.
- Poster durability / reparse:
  - unsafe/empty reparse больше не удаляет существующую картинку;
  - generated/fallback path не вытесняет source poster;
  - если Vision уже подтвердил `posterImageIndex`, reparse восстанавливает реальный source path по индексу (регрессия CWT №9).
- Owner manual:
  - добавлен persisted `manual_events.owner_manual`;
  - флаг ставится только на прямом owner-add, approved proposals его не получают;
  - automatic reparse для owner-manual строки прекращается на persistence-уровне;
  - duplicate merge асимметричен: содержательные поля/картинка/Vision остаются от owner-card, добавляется lineage источников;
  - AI merge не может затем перетереть owner-card.
- Dedupe:
  - разные конкретные день+месяц — hard different;
  - время не является hard-conflict;
  - обычное расхождение площадки — AI/ambiguity signal, а не hard veto;
  - `Diesel Bar` vs `Diesel Hall` остаётся hard conflict.
- VK scheduling:
  - только VK (`vk-public`, `vk-chat`) открывается capture-sequential;
  - следующий VK source ждёт завершения raw capture предыдущего и random gap 10–20 s;
  - Telegram/Qtickets VK-throttle не получают.
- Добавлен регрессионный тест `tests/events/refactoringTaskRegressionV18889.test.mjs`.

## Проверка

Главный task-regression: 5/5 PASS.

Дополнительный совместный прогон: 10/10 PASS для нового regression + существующих parser-all cross-post dedupe и venue/translit regression.

`eventSourceRefreshV140` + task regression: 8/8 PASS.

В более широком старом наборе остаются stale/conflicting assertions, например ожидание старого времени merge и старого hard-conflict по любым разным площадкам; они противоречат новому ТЗ и не использовались как причина откатывать новую логику.

## Изменённые production-файлы

- `src/app/botApplication.js`
- `src/infrastructure/database/index.js`
- `src/features/events/eventPosterMatching.js`
- `src/features/events/eventDuplicateResolution.js`
- `src/features/events/eventSourceRefresh.js`

Новый тест:

- `tests/events/refactoringTaskRegressionV18889.test.mjs`
