# GIGORAVE V188.123 — выборочные проверенные исправления VK/event pipeline

Основа: V188.122 WHOLE TEXT THEN BATCHES. Это наложение на существующую установку, не автономный проект: в архивной линии отсутствуют `src/index.js` и часть scripts. Не удаляйте отсутствующие в архиве файлы рабочей установки.

Перед установкой остановите процесс бота, сохраните копию проекта, `.env`, пользовательских SQLite-баз и `data/audit-jobs`; распакуйте поверх существующей папки, не стирайте `.env`, `data` и job directories. После запуска проверьте `[BOT BUILD] V188.123`.

Маршрут TXT/MD и ZIP аудита Astra наследуется от V188.122 без изменений: этот релиз посвящён VK/event pipeline, а не подтверждению живой работы роутера.

## Исправлено в этом патче

- `sourcePostFingerprint.js`: degraded/url-fallback больше нельзя принять за переиспользуемый или неизменившийся fingerprint; успешные SHA/visualHash остаются сравнимыми.
- `allPartyDedupe.js`: primary и secondary с известными несовместимыми пулами не склеиваются. QTickets по-прежнему допускает совпадение с одним из пулов, но не может транзитивно склеить primary с secondary; групповая совместимость проверяется перед union.
- `manualProcessingPool.js`: сбой callback диагностики не помечает завершённый worker как failed и не обрывает обход до обработки следующего элемента.
- `eventProvenance.js`: canonical VK wall URL требует VK-хост и точный wall-путь или параметр `w`; не превращает чужие домены в VK-посты.
- `eventMultiAnnouncementBlocks.js`: отсеиваются невозможные цифровые календарные даты; явно указанный год проверяется с учётом високосности.
- `vkPublicScraper.js`: исправлено описание snapshot/live-DOM в журнале и подсчёт контуров для составного `parserPass`.
- `eventAnnouncementNormalization.js`: пустой AI `displayDate` не стирает уже существующую displayDate.

## Что из аудита Astra сознательно не перенесено

- Совету заменить `dateKey(match[2], match[1])` на `dateKey(match[3], match[2])` **не следовать**: у регулярного выражения две захватывающие группы, `match[3]` не существует. Старый код даёт правильные день и месяц; регрессионный тест проверяет привязку афиши.
- Не заменять `imagePaths` на первый случайный путь: безопасность публикации зависит от проверенной пары изображение/Vision-метаданные; первому пути доверять нельзя.
- Не стирать автоматически старые события после пустого повторного parse: политика сохранения намеренно защищает от временных сбоев источника; требуется отдельная модель подтверждённого удаления.
- Не удалять legacy dedupe-пути, источник-specific defaults, parser trace или особую обработку QTickets без тестирования DB + UI + всех команд. Их риски остаются открытыми, а предложения из аудита ещё не являются готовыми безопасными патчами.

## Проверки и пределы

Новые 12 поведенческих тестов находятся в `tests/events/v188123VerifiedVkAudit.test.mjs`. Запуск:

```
node --test tests/events/v188123VerifiedVkAudit.test.mjs tests/events/v18888AllPartiesAggregate.test.mjs tests/events/eventProvenancePosterV18867.test.mjs tests/events/v18899CanonicalDedupePoster.test.mjs tests/events/v18893PosterMetadataSearch.test.mjs tests/events/completeVkEventParsingV18818.test.mjs tests/scrapers/multiAnnouncementPosterRepairV18861.test.mjs tests/scrapers/manualSourceRegistryV152.test.mjs
```

Итог: 50/50 passed в выбранном регрессионном наборе после добавления трёх тестов. Пять исторических тестов в дополнительном наборе падают уже в исходном V188.122 (старые версии dedupe/legacy static assertions и старое ожидание по времени); они не заявлены как пройденные и требуют отдельной актуализации. Живые Telegram/VK/Astra-интеграции на вашей установке НЕ проверялись. Не отправляйте сразу большой платный архив из-за этого события: изменения относятся к VK-event-пайплайну.

### Для независимой проверки Astra
Отдельный файл `GIGORAVE_V188123_HANDOFF_ALL_CHANGED_CODE_RU.txt` содержит полный текст изменённых исходников и тестов, unified diff, результаты проверок и вопросы. Он НЕ обязателен для установки бота и не содержит пользовательские `.env` и SQLite.
