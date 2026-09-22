# Карта исходников

Файл генерируется командой `pnpm manifest`.

## Рабочие модули

| Файл | Строк | Ответственность |
|---|---:|---|
| `src/app/botApplication.js` | 36919 | Главный оркестратор: связывает VK, Telegram, GPT, базу, события и фоновые задачи. Здесь должны оставаться только сценарии верхнего уровня; чистую логику выносим в features/shared. |
| `src/features/ai/allProviderVisualMatrixAudit.js` | 196 | — |
| `src/features/ai/autoSummaryRouting.js` | 468 | — |
| `src/features/ai/calendarSummaryRollup.js` | 80 | — |
| `src/features/ai/calendarSummarySlices.js` | 80 | — |
| `src/features/ai/chatContextRouting.js` | 72 | Распознаёт запросы к истории чата: резюме, анализ всей конфы и связанные режимы. |
| `src/features/ai/compactAiHealthAudit.js` | 403 | — |
| `src/features/ai/directConversationContext.js` | 99 | — |
| `src/features/ai/envKeyCleanup.js` | 454 | — |
| `src/features/ai/externalProviderRouting.js` | 453 | — |
| `src/features/ai/fullAiAudit.js` | 2453 | — |
| `src/features/ai/gigoraveIdentity.js` | 31 | — |
| `src/features/ai/globalWhoDatabaseRouting.js` | 202 | — |
| `src/features/ai/gptModeRouting.js` | 163 | Чистая маршрутизация ключей моделей mini/gpt54/gpt55/pro/pro2/pro3 и профиля прашны. |
| `src/features/ai/imageEditRouting.js` | 62 | — |
| `src/features/ai/imageQuotaPolicy.js` | 19 | Платформенная политика дневной квоты вызовов GPT image-модели. Владелец обходится общим unlimited-механизмом приложения; здесь выбирается только лимит обычного пользователя для соответствующей платформы. |
| `src/features/ai/incomingImageTargets.js` | 749 | — |
| `src/features/ai/incomingMessagePrompt.js` | 108 | Формирует обязательную привязку AI-запроса к конкретному входящему сообщению и, когда пользователь воспользовался штатной функцией reply, к сообщению-цели. Оба блока считаются недоверенными данными и не заменяют системные инструкции. |
| `src/features/ai/legacySecretCleanup.js` | 34 | — |
| `src/features/ai/mediaAudit.js` | 171 | — |
| `src/features/ai/mediaPipeline.js` | 39 | Runs media items deterministically and never lets one broken attachment abort the remaining chain. The caller decides how to log/report each failure. |
| `src/features/ai/modelDiscoveryScheduler.js` | 388 | — |
| `src/features/ai/modelProviderFailover.js` | 324 | — |
| `src/features/ai/nvidiaVisualAudit.js` | 269 | — |
| `src/features/ai/nvidiaVisualGeneration.js` | 639 | — |
| `src/features/ai/openAIImageStream.js` | 185 | Сборщик изображений из потоковых ответов: data URI, base64 и URL-кандидаты. |
| `src/features/ai/openAIRetryRouting.js` | 269 | Политика восстановления текстовых запросов к OpenAI-compatible router. Первый временный отказ повторяется той же моделью через случайные 5–30 секунд. После второго отказа вызывающий код может перейти к следующему более сильному режиму. |
| `src/features/ai/openAIStream.js` | 180 | Парсер SSE-потока OpenAI-compatible API. Собирает текст, usage и корректно замечает ошибку внутри уже начавшегося stream. |
| `src/features/ai/participantQuestionRouting.js` | 711 | — |
| `src/features/ai/proInferencePolicy.js` | 24 | Настройки продвинутых GPT-режимов. * Важно: эти поля являются пожеланием совместимому API. Если router не знает reasoning_effort или verbosity, сетевой слой повторяет запрос без них, поэтому pro-команда не ломается из-за несовместимого параметра. |
| `src/features/ai/providerDiagnostics.js` | 985 | — |
| `src/features/ai/providerKeyAudit.js` | 350 | — |
| `src/features/ai/quotaKeyLifecycle.js` | 308 | — |
| `src/features/ai/reasoningEffortRouting.js` | 124 | — |
| `src/features/ai/replyTargetRouting.js` | 214 | — |
| `src/features/ai/responseLengthRouting.js` | 225 | Ограничения длины ответа: короткий базовый профиль, подробный профиль и расширенный профиль pro/натала. |
| `src/features/ai/runtimeSecretAutoImport.js` | 256 | — |
| `src/features/ai/summaryModelRouting.js` | 30 | — |
| `src/features/ai/thirdRecoverySweep.js` | 612 | — |
| `src/features/ai/tokenUsageLogger.js` | 317 | — |
| `src/features/ai/unknownTermRouting.js` | 205 | Двухэтапная обработка нестандартных терминов: модель выделяет слова, затем определения ищутся в памяти диалога. |
| `src/features/ai/visionRouting.js` | 78 | — |
| `src/features/ai/voiceTranscription.js` | 445 | — |
| `src/features/astrology/astrologyRouting.js` | 134 | Решает, является запрос наталом или прашной, и выбирает локальный либо модельный расчёт. |
| `src/features/astrology/ephemeris.js` | 2737 | Локальный расчёт джйотиш через Swiss Ephemeris/Moshier. Большой математический модуль без платформенной логики. |
| `src/features/astrology/natalRouting.js` | 258 | Извлекает дату, время и место рождения из натального запроса и проверяет полноту данных. |
| `src/features/coords/coordsOverrideRouting.js` | 327 | Специальный дословный ответ на команды «корды» в фиксированное окно. * Окно продукта: 22 августа 2026 года, 11:00–24:00 по Europe/Moscow. Управляющие команды владельца работают независимо от даты. |
| `src/features/documents/documentArtifacts.js` | 231 | — |
| `src/features/documents/documentRouting.js` | 42 | — |
| `src/features/donation/qrCodeRouting.js` | 47 | — |
| `src/features/events/compactPartySummary.js` | 148 | — |
| `src/features/events/dmPartyRouting.js` | 78 | — |
| `src/features/events/eventAiAdmission.js` | 379 | — |
| `src/features/events/eventAnnouncementNormalization.js` | 214 | Очистка и контракт AI-нормализации анонсов. Модель получает сырой текст только как источник фактов, а пользователю возвращается структурированная афиша без служебного мусора интерфейсов VK/Telegram и дублей шапки. |
| `src/features/events/eventAssets.js` | 735 | Скачивание изображений события и создание безопасных локальных превью/заглушек. |
| `src/features/events/eventCandidateRouting.js` | 226 | — |
| `src/features/events/eventDeduplication.js` | 1014 | Объединяет одинаковые события из разных источников, сохраняя лучший текст, ссылки и метаданные. |
| `src/features/events/eventDuplicateAiPolicy.js` | 65 | V149: дешёвый gate перед вторым (AI) контуром дедупликации. * ИИ вызывается только когда: - у карточек есть хотя бы одна общая календарная дата; - нет hard conflict из deterministic contour; - названия НЕ идентичны после нормализации; - но названия частично совпадают или достаточно похожи. * Полное название + дата — deterministic случай, AI там только тратит время. |
| `src/features/events/eventDuplicateResolution.js` | 2811 | V94: глубокая двухконтурная дедупликация городской афиши. * Контур 1 (без ИИ): - календарные интервалы/многодневность; - время (включая двери/начало и расписания по дням); - площадка + адрес + алиасы; - название; - состав участников; - дополнительные совпадения цены/описания/источников; - защита от транзитивной склейки несовместимых карточек. * Контур 2 (ИИ): вызывается только для серой зоны. ИИ не может отменить жёсткий конфликт далёких дат. Для уже подтверждённой группы отдельный callback может аккуратно объединить разные описания и расписание по дням. * После обоих контуров работает paranoid/fixed-point pass: очевидные дубли с тем же нормализованным названием и пересекающимся календарным интервалом не допускаются в итоговую выдачу даже если они пришли из разных источников. |
| `src/features/events/eventImageSelection.js` | 189 | Ранжирование афиш событий и чтение размеров локальных raster-изображений. |
| `src/features/events/eventIngestAudit.js` | 66 | — |
| `src/features/events/eventMetadata.js` | 404 | Извлекает ссылки, цену, участников, площадку и другие структурные поля события. |
| `src/features/events/eventModeration.js` | 345 | — |
| `src/features/events/eventModerationRouting.js` | 52 | — |
| `src/features/events/eventPageCandidateSelection.js` | 71 | — |
| `src/features/events/eventParserTrace.js` | 150 | Durable per-run diagnostics for manual event/proposal parsing. * The trace is intentionally verbose: every important parser branch may write its input/output here. Secrets are redacted before touching disk so a trace can be safely attached to a bug report. |
| `src/features/events/eventPosterMatching.js` | 334 | V188.73 deterministic, auditable poster-to-event matching. * Safety contract: - ordinary photos / logos / covers are never event posters; - a poster must be explicitly confirmed by vision; - the event date must be visible on the image; - venue words alone can never bind an image to a child event; - identity evidence comes from title / artist fields, with venue/common words removed so a CWT poster cannot match STONEHAND merely because both are at Diesel Hall on the same day. |
| `src/features/events/eventPosterPolicy.js` | 83 | — |
| `src/features/events/eventProposalWorkflow.js` | 275 | — |
| `src/features/events/eventProvenance.js` | 214 | — |
| `src/features/events/eventRetry.js` | 126 | V186: единый пяти-круговый retry-контур event-ingest. * Повторяется только упавшая операция, а не весь пост: успешный vision не вызывается заново из-за последующей ошибки SQLite. Каждый exception получает круги 1..5; логический результат `not_event` исключением не является. |
| `src/features/events/eventSourceLink.js` | 68 | — |
| `src/features/events/eventSourceRefresh.js` | 145 | Pure helpers for refreshing a stored event from a newer copy of the same source. The caller is responsible for proving source identity (usually canonical URL equality). |
| `src/features/events/eventText.js` | 83 | Нормализует и форматирует текст анонсов перед сохранением и показом. |
| `src/features/events/eventTextSanitation.js` | 68 | Removes VK interface artefacts that may leak into captured post body text. The sanitizer is intentionally conservative: it removes only standalone UI labels/counters and leaves normal prose untouched. |
| `src/features/events/eventValidation.js` | 225 | Строгая граница качества событий: одновременно требуются понятная суть, дата и конкретное место. |
| `src/features/events/eventVenueInference.js` | 339 | Deterministic venue inference for event announcements. * Goals: - recognize a small set of important Voronezh venues in any common spelling/case; - treat explicit venue-type phrases (bar/pub/club/hall/bowling/etc.) as locations; - collect ambiguous prepositional candidates ("в ...", "на ...") for a later AI audit, without blindly promoting every phrase after a preposition to a venue. |
| `src/features/events/eventVerifiedSnapshot.js` | 88 | — |
| `src/features/events/eventVisionPolicy.js` | 60 | Public event ingest policy. * A poster is source evidence, not an optional decoration. Even when the text already contains title/date/venue, we still inspect eligible source images: the poster can correct or complete the textual announcement and is required for the final event card. |
| `src/features/events/manualParserSimilarity.js` | 95 | — |
| `src/features/events/partyPool.js` | 131 | Separates the normal party feed from the deliberately independent “secondary / быдлячьи” feed. Source identity is the boundary: events from the two pools must never meet in dedupe or public selection. |
| `src/features/events/publicEventRange.js` | 372 | Календарная маршрутизация афиши: преобразует формулировки пользователя и токены GPT-классификатора в строгий диапазон YYYY-MM-DD. |
| `src/features/events/publicPostDateEvidence.js` | 373 | — |
| `src/features/events/publicPostLocalParser.js` | 919 | Pure local parser for public Telegram/VK announcement text. * This module intentionally has no browser/database imports so parser regressions can be exercised directly with unit tests. |
| `src/features/events/secondaryPartyAdmission.js` | 271 | — |
| `src/features/events/secondaryPartyAutoSchedule.js` | 62 | — |
| `src/features/events/sourceContentHash.js` | 53 | — |
| `src/features/events/sourceEventPersistence.js` | 16 | Conservative persistence policy for already accepted source events. * A repeat scrape can temporarily lose lazy-loaded media, hit a network/AI failure or receive a partial DOM/API payload. An empty parse from a source that previously produced accepted events is therefore not evidence that the event disappeared. Expiry/moderation are the destructive paths; routine reparsing is intentionally non-destructive on an empty result. |
| `src/features/events/sourcePostFingerprint.js` | 318 | Deterministic pre-AI fingerprints for public source posts. Text similarity is intentionally local and cheap. Image fingerprints contain an exact SHA-256 plus a metadata-insensitive visual-payload SHA-256 for the common JPEG/PNG/WebP formats, so duplicate posters can be rejected before any vision request. |
| `src/features/events/trustedOwnerEventEvidence.js` | 178 | — |
| `src/features/events/vkCapturedMediaMerge.js` | 55 | — |
| `src/features/events/vkEventLinkEnrichment.js` | 199 | — |
| `src/features/events/vkStructuredEventEvidence.js` | 584 | — |
| `src/features/history/chatHistoryLinkRouting.js` | 44 | Owner-only routing for rebinding the durable history of a deleted group chat to a replacement chat. Parsing stays platform-agnostic; the application layer decides whether the sender is the owner and performs the migration. |
| `src/features/history/localHistoryCheckpoint.js` | 100 | — |
| `src/features/history/localSqliteHistoryRecovery.js` | 434 | — |
| `src/features/history/vkBrowserHistoryRecovery.js` | 456 | — |
| `src/features/history/vkHistoryPullPolicy.js` | 136 | — |
| `src/features/history/vkHistoryRecoveryVisibility.js` | 40 | — |
| `src/features/membership/leaverCommandRouting.js` | 118 | — |
| `src/features/memory/memoryRouting.js` | 583 | — |
| `src/features/personality/activeCommunicationRouting.js` | 217 | Режим самостоятельного участия: один случайный ответ в каждом сохраняемом окне из N подходящих сообщений. |
| `src/features/personality/banterRouting.js` | 163 | Ограниченная адресная перепалка: распознаёт выпад и формирует дерзкий ответ без угроз и травли по признакам. |
| `src/features/personality/botIdentityProvocationRouting.js` | 132 | Распознаёт попытки присвоить боту унизительную «личность» через конструкции «теперь ты ...», «ты ... запомни» и «запомни: теперь ты ...». Такие фразы не являются командами долговременной памяти. |
| `src/features/personality/communicationStyleRouting.js` | 487 | Роли и теплота общения, шаблоны фоновых выкриков и системная инструкция модели. |
| `src/features/personality/flatterCommandRouting.js` | 141 | Чистая логика команды «подлизать»: разбор команды, выбор недавнего сообщения и построение гипертрофированно доброжелательного промпта. |
| `src/features/personality/roastCommandRouting.js` | 776 | — |
| `src/features/personality/roastParticipantRoster.js` | 188 | — |
| `src/features/pinball/pinballServer.js` | 265 | — |
| `src/features/routing/commandPriorityRouting.js` | 701 | Единая чистая таблица приоритетов верхнеуровневых команд. * Правила: 1. Явные административные/локальные команды сильнее любых семантических классификаторов и ключей модели, которые для них неприменимы. 2. Явные AI-действия (прашна, GPT, резюме, генерация/анализ изображения) сильнее семантической афиши и FAQ. 3. Семантические классификаторы запускаются только когда не найдено ни одной явной команды. |
| `src/features/routing/explicitApplicationCommand.js` | 93 | Shared explicit-command detector for platform adapters and the application. It deliberately does not execute anything. Its only job is to answer whether text is an application command that must escape a pending UI mode. |
| `src/features/routing/helpContextProfile.js` | 121 | — |
| `src/features/runtime/processControlRouting.js` | 31 | — |
| `src/features/scrapers/browserRecoveryPolicy.js` | 14 | — |
| `src/features/scrapers/manualParserDiagnostics.js` | 247 | — |
| `src/features/scrapers/manualProcessingPool.js` | 304 | — |
| `src/features/scrapers/manualSourceRegistry.js` | 237 | V152: нормализация и долговечный owner-registry публичных источников афиши. * Хранилище само находится в SQLite maintenance_state (оркестратор отвечает за чтение/запись), а этот модуль остаётся чистым и тестируемым: распознаёт Telegram/VK-ссылки, строит стабильный source-id и сливает конфигурации без дублей. |
| `src/features/scrapers/publicSourcePolicy.js` | 37 | — |
| `src/features/scrapers/scraperCommandRouting.js` | 241 | Разбирает административные команды ручного запуска конкретного скрейпера. |
| `src/features/scrapers/scraperError.js` | 115 | — |
| `src/features/scrapers/sourceConfiguration.js` | 85 | Чистый разбор списков источников из .env с безопасными ограничениями объёма первого прохода. |
| `src/index.js` | 47 | Minimal entrypoint: deletes obsolete parsed_secrets files without parsing them, loads .env, acquires the single-instance lock and starts the orchestrator. |
| `src/infrastructure/browser/browserGrabber.js` | 1821 | Единый постоянный Playwright-контекст для ручного просмотра и скрейперов. Вкладки намеренно могут оставаться открытыми для проверки владельцем. |
| `src/infrastructure/database/autoSummaryStateStore.js` | 420 | Durable auto-summary state. * This database intentionally lives OUTSIDE the bot installation directory by default. Replacing/unpacking a full bot release therefore cannot reset the enabled mode, next scheduled run, or completed-slot history. |
| `src/infrastructure/database/databaseLineageGuard.js` | 390 | — |
| `src/infrastructure/database/databasePreflight.js` | 862 | V160 database preflight. * Runs before src/index.js so a damaged release-local SQLite file cannot stop the whole bot from booting. The durable auto-summary database lives outside this path and is intentionally not touched here. |
| `src/infrastructure/database/databasePreflightRegister.js` | 14 | — |
| `src/infrastructure/database/hierarchicalSummaryStateStore.js` | 829 | Durable paid-summary state. * V188.43 keeps the legacy hierarchy tables for backward compatibility, but scheduled accumulation uses an immutable calendar rollup: raw messages -> intraday batch revisions -> daily revisions -> week/month-clipped week segments -> monthly revisions. Every raw message and every lower-level revision can be promoted only once. Late recovered messages therefore create delta revisions instead of causing an already-paid corpus to be summarized again. |
| `src/infrastructure/database/historyRecoveryStateStore.js` | 79 | V187.2 durable startup-history recovery state. Keeps expensive local-backup scan completion outside bot.sqlite so a normal process restart does not reread every historical backup. If bot.sqlite is rolled back below the saved message count, the scan becomes eligible again. |
| `src/infrastructure/database/index.js` | 11042 | SQLite-слой приложения: схема, мягкие миграции и функции чтения/записи. Модуль не должен знать о VK/Telegram Context и не отправляет сообщения. |
| `src/infrastructure/database/personalizationStateStore.js` | 442 | V187 durable personalization checkpoints. * This database deliberately lives outside the project directory (the same durable state root used by auto-summary), so replacing the source tree or restoring bot.sqlite cannot make already-processed message ranges hit GPT again. * Rules: - style: automatic, at most one GPT call per 500 NEW messages; - dossier: NEVER automatic; only the explicit dossier command advances it; - successful batches are checkpointed immediately, so a later failure does not repeat earlier paid batches. |
| `src/infrastructure/database/runtimePaths.js` | 40 | — |
| `src/infrastructure/database/summaryStateStore.js` | 104 | V187.2 durable content-addressed cache for explicit large summaries. Re-running the same summary over the same message blocks must not spend GPT tokens again. The cache lives outside bot.sqlite so restoring the main DB or replacing the source tree does not erase already-paid summary work. |
| `src/platforms/telegram/telegramBot.js` | 1548 | Адаптер Telegram Bot API: long polling, отправка сообщений/фото, меню и преобразование Telegram update в единый контекст приложения. |
| `src/platforms/telegram/telegramConnectivity.js` | 244 | — |
| `src/platforms/telegram/telegramHtmlScraper.js` | 2266 | Скрейпер публичных Telegram-каналов через браузер: читает посты, сохраняет источники и передаёт только строгие события. |
| `src/platforms/vk/vkChatEventScraper.js` | 5123 | Ручной скрейпер VK-бесед. Не открывает беседы сам при старте; вкладку запускает явная команда владельца. |
| `src/platforms/vk/vkChatEventSource.js` | 97 | Чистые правила выбора публичной ссылки-источника для события из VK-беседы. |
| `src/platforms/vk/vkMessageContent.js` | 923 | — |
| `src/platforms/vk/vkPhotoIdentityMedia.js` | 126 | VK photo attachment identity helpers. * VK's web UI virtualizes gallery cells and can temporarily serialize the previous neighbour's currentSrc for a different photo anchor. The anchor identity (photo<owner>_<id>) is stable, so resolve the bytes/URL by that id through photos.getById instead of trusting a recycled <img> node. |
| `src/platforms/vk/vkPublicScraper.js` | 5211 | Скрейпер публичных VK-страниц. Переиспользует общий браузер и строгую проверку событий. |
| `src/platforms/vk/vkSourcePageHealth.js` | 29 | — |
| `src/runtime/logMaintenanceV18855.js` | 186 | — |
| `src/runtime/operationSupervisor.js` | 590 | — |
| `src/runtime/singleInstanceLock.js` | 106 | Файловая блокировка единственного процесса бота. Нужна, чтобы не дублировать Long Poll, таймеры и запись SQLite. |
| `src/shared/botAddressing.js` | 118 | — |
| `src/shared/buildVersion.js` | 9 | Single release identity used by runtime, diagnostics, and maintenance. Bump this value for every shipped build. The log maintenance boundary uses the same value, so the first startup of a NEW build clears only volatile logs while ordinary restarts of the SAME build keep fresh diagnostics. |
| `src/shared/commands.js` | 241 | Общие короткие команды и распознавание упоминаний VK/Telegram без платформенной отправки сообщений. |
| `src/shared/date.js` | 131 | Небольшие функции работы с календарными датами без сторонней библиотеки. Строки формата YYYY-MM-DD удобны тем, что корректно сравниваются лексически. |
| `src/shared/errors.js` | 52 | Полная диагностическая форма для консоли. Она не предназначена для отправки пользователю: stack и cause могут содержать внутренние детали приложения. |
| `src/shared/incomingReplyTransport.js` | 135 | Единая привязка исходящих ответов к конкретному входящему сообщению в VK и Telegram. |
| `src/shared/numbers.js` | 14 | Преобразует значение в целое число и удерживает его в допустимом диапазоне. Некорректные значения из .env не должны ломать запуск — используется fallback. |
| `src/shared/regex.js` | 5 | — |
| `src/shared/sanitize.js` | 84 | Общая очистка текста перед отправкой во внешние модели. |

## Совместимые старые пути

Новый код не должен импортировать эти re-export файлы.

| Файл | Строк |
|---|---:|
| `src/activeCommunicationRouting.js` | 6 |
| `src/astrologyRouting.js` | 6 |
| `src/banterRouting.js` | 6 |
| `src/browserGrabber.js` | 6 |
| `src/chatContextRouting.js` | 6 |
| `src/communicationStyleRouting.js` | 6 |
| `src/database.js` | 6 |
| `src/ephemeris.js` | 6 |
| `src/eventAssets.js` | 6 |
| `src/eventCandidateRouting.js` | 6 |
| `src/eventDeduplication.js` | 6 |
| `src/eventMetadata.js` | 6 |
| `src/eventText.js` | 6 |
| `src/eventValidation.js` | 6 |
| `src/gptModeRouting.js` | 6 |
| `src/memoryRouting.js` | 6 |
| `src/natalRouting.js` | 6 |
| `src/openAIImageStream.js` | 6 |
| `src/openAIStream.js` | 6 |
| `src/responseLengthRouting.js` | 6 |
| `src/sanitize.js` | 6 |
| `src/scraperCommandRouting.js` | 6 |
| `src/telegramBot.js` | 6 |
| `src/telegramHtmlScraper.js` | 6 |
| `src/unknownTermRouting.js` | 6 |
| `src/vkChatEventScraper.js` | 6 |
| `src/vkChatEventSource.js` | 6 |
| `src/vkPublicScraper.js` | 6 |
