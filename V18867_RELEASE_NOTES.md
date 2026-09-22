# Gigorave V188.67

## Что изменено

- Введён постоянный provenance-слой для `manual_events`, `telegram_events`, `vk_events`, `vk_chat_events`: canonical post URL, тип источника, chat/cmid, source item/original URL и диагностический `canonical_origin`.
- Для VK-бесед canonical source выбирается в порядке: repost/wall attachment → wall URL в тексте → attachment link → chat-message-only. Conversation URL остаётся origin metadata и не подменяет исходный wall-post.
- `тусы кратко` теперь заканчивает каждую строку источником; полная карточка всегда содержит `Источник:`. Для чистого chat-message используется `💬 Беседа «…» — сообщение #CMID`.
- Место сохраняется lossless: новый непустой venue → poster venue → уже сохранённый venue → `место не указано`. Пустой повторный AI-проход не стирает хорошее значение.
- Poster Vision сохраняет по каждому `[IMAGE N]` title/artists/date/time/venue/poster flag. Финальная привязка изображения требует date + title либо date + сильные факты. Title-only запрещён.
- Общая календарная афиша может быть подтверждена для нескольких дочерних событий. Отдельные афиши сохраняют отдельные media-path.
- Удалён fallback «первая фотография». Событие без подтверждённой афиши остаётся в базе и публикуется текстом без картинки.
- Сохраняются `poster_match_status`, `poster_match_reason`, `poster_image_index`, vision facts; trace/DB log показывает accepted/rejected/no-safe-poster.
- Pre-gate vision facts переиспользуются как cache на дальнейших этапах и участвуют в post-extraction matching.
- `парсер все чисто` по-прежнему пропускает финально обработанные ledger items до vision/AI; capture ledger теперь сохраняет provenance/attachment metadata. Полный `парсер все` может переобрабатывать уже известные VK-chat сообщения для repair.
- Одноразовый V188.67 backfill заполняет provenance старых записей без ухудшения существующих данных и консервативно восстанавливает подписанное место из сохранённого source text.
- Broken manual poster repair остаётся fail-closed: только vision-confirmed image копируется в `manual_event_announcements/...` и получает poster-match metadata.

## Regression gate

Добавлены `tests/events/eventProvenancePosterV18867.test.mjs` и `tests/infrastructure/eventPersistenceV18867.test.mjs`: VK post/chat provenance, chat-message-only, three-posters multi-event, shared calendar poster, title-only rejection, non-poster couple photo, poster-only venue, non-destructive reparse, DB provenance fields и SQLite integrity checks.

## Runtime data

Release ZIP не должен содержать `.env`, `bot.sqlite`, `*.sqlite`, `*-wal`, `*-shm` или другие runtime DB artifacts; это дополнительно проверяется `check:release-clean`.

## Single-open / VK chat unread navigation hotfix

- Для ручного `парсер все` каждый настроенный source запускается ровно один раз. Внешний recovery больше не имеет права второй раз вызывать `startManualScraperSource()` после ошибки; повтор возможен только новой командой владельца.
- VK public в manual parser получает `singleOpenPerRun=true`: внутри одного parser-all нет второй capture-попытки с новой вкладкой. Страница finite-pass переиспользуется по `reuseKey`.
- Telegram finite pagination и VK chat работают в одной reusable-вкладке на source; переходы/DOM-снимки внутри этой вкладки не создают новые source-tabs.
- VK chat теперь распознаёт старт на last-read frontier по реальному `scrollTop/scrollHeight`, `.ConvoHistory__unreadSeparator`, heading `Новые сообщения` и кнопке `Перейти к непрочитанным сообщениям…`.
- Если ниже стартовой позиции есть контент, алгоритм сначала сохраняет стартовый CMID-frontier, идёт ВНИЗ до фактического bottom, захватывая unread tail, затем разворачивается ВВЕРХ. Чистый режим не может завершиться по target-count, пока не вернулся как минимум к исходному frontier. Полный режим после возврата продолжает history-backfill вверх.
- Тот же down→up контракт добавлен для одиночного manual запуска VK-беседы и scheduled chat collection, чтобы поведение не зависело от команды запуска.
- Parser-all poster maintenance больше не вызывает browser poster recovery после закрытия source-tabs. Если уже сохранённых/API-visible media недостаточно, repair fail-closed оставляет событие без изображения. Browser recovery остаётся только в явном owner reparse-by-link flow.
- Startup `about:blank` по-прежнему переиспользуется как первая рабочая вкладка; лишние unmanaged blank tabs удаляются. После завершения последнего parser lease пустой Chromium закрывается коротким blank-only cleanup, но meaningful page владельца не закрывается.
- Добавлен regression `tests/scrapers/chatUnreadSingleOpenV18867.test.mjs`, фиксирующий down-before-up, возврат к frontier, one-start-per-source, single capture для manual VK public и запрет browser revisit в parser-all maintenance.

## Media compatibility hotfix — старые нормальные афиши не исчезают

Первый V188.67 build сделал выдачу слишком строгой: старые V188.66 события уже имели корректные `image_paths_json`, но новое поле `poster_match_status` после ALTER TABLE было пустым. `getEventAttachments()` трактовал пустой status как `unsafe` и поэтому скрывал даже нормальные сохранённые афиши.

Исправление не возвращает fallback «первая фотография». Добавлен отдельный compatibility-backfill с узкими правилами:

- VK/Telegram: если у одного source-item ровно одно событие и ровно одна сохранённая source-картинка, старый path получает `legacy_single_source_poster`;
- multi-event VK/Telegram: старый path получает `legacy_unique_source_poster` только если этот exact source-path используется ровно одним sibling event;
- manual: уже материализованная картинка из `manual_event_announcements/...` получает `legacy_manual_poster`;
- VK-chat: legacy media по умолчанию **не** доверяются. Исключение — реальный wall-repost, один child event и ровно одна source image; такой path получает `legacy_single_repost_poster`;
- chat message с несколькими source-фото остаётся без картинки до Poster Vision. Это специально сохраняет защиту от известного случая `Юбилейная 5-я вылазка-знакомство`, где в source record было две фотографии и старая `4928-1.jpg` могла быть обычным фото людей.

На копии присланной БД compatibility-backfill восстановил показ 17 single-source VK posters, 3 unique multi-event VK posters, 6 Telegram posters, 3 durable manual posters и 6 single-image VK-chat repost posters. При этом CMID 4928 остался untrusted.

Проверены конкретные записи из пользовательского примера:

- `vk_events.id=91`, `https://vk.ru/wall-226190294_1153`: старый `vk_announcements/idmamaanarchy/1153-1.jpg` -> `legacy_single_source_poster`;
- `vk_chat_events.id=21`, `DANSE MACABRE PARTY`, CMID 4420: `vk_chat_announcements/vk-chat-2000000022/4420-1.jpg` -> `legacy_single_repost_poster`, canonical wall `https://vk.ru/wall-240869396_3`;
- `vk_chat_events.id=11`, CMID 4928: две source photos -> status остаётся пустым, случайная фотография автоматически не возвращается.

## Runtime media-path / fresh-log boundary hotfix

- Исправлен cwd-dependent media lookup. Раньше публичная карточка искала `image_paths_json` через `resolve('./data')`, тогда как SQLite уже использовала project/runtime data directory. При запуске Node из другой рабочей папки БД читалась нормально, JPEG физически существовали рядом с `bot.sqlite`, но `getEventAttachments()` видел их как отсутствующие и уходил в text-only fallback. Теперь event media root = `RUNTIME_DATA_DIRECTORY`.
- Verified event snapshot также переведён с cwd-relative `data/event-verified-snapshot.json` на runtime data directory. Snapshot schema поднята до v7, поэтому старый media-unaware cache больше не может пережить обновление и скрывать уже валидные poster bindings.
- Build identity поднят до `events-v18867-provenance-multi-poster-repair-r4-media-path`.
- Первый запуск каждой новой build identity очищает только volatile logs/audits (`data/logs`, media audit, AI token usage, ingest audit и audit result dirs). Повторный запуск той же сборки свежие логи сохраняет. DB/WAL/SHM, event posters, raw source, ledger, backups/journals/checkpoints не являются cleanup targets.
- Добавлен regression `tests/events/eventMediaRuntimeRootV18867.test.mjs`; media runtime-root, snapshot v7 и per-build log boundary включены в V188.67 gate.
