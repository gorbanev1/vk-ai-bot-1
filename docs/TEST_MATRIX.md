# V188.66: актуальный release gate

- `npm test` / `npm run test:active` запускает поддерживаемый активный набор регрессий в изолированной временной SQLite.
- `npm run verify` выполняет syntax/import/named-import/docs checks, активные тесты и release-data guard. Это основной release gate.
- `npm run test:legacy` оставлен для исторического массива тестов. Каждый legacy-файл запускается с отдельной временной БД; падение устаревшего теста не должно затрагивать production data.
- Любой тестовый процесс, который попробует открыть проектный `data/bot.sqlite` без явной test-isolation, аварийно остановится до открытия файла.

# V149 regression

- `tests/v149Features.test.mjs` — AI gate: exact title/date без GPT; partial same-date через GPT; разные даты/hard conflict без GPT; persistent active chat wiring.
- `tests/personality/activeCommunicationRouting.test.mjs` — `активное общение N`, фиксированные N-message windows, одна случайная позиция на окно, случайные persona.
- `tests/personality/communicationStyleDatabase.test.mjs` и `tests/infrastructure/chatHistoryMigrationV132.test.mjs` — interval/target/count сохраняются в SQLite и при history rebind.

# Матрица тестов

## V140 regression

- `tests/events/eventSourceRefreshV140.test.mjs` — безопасное merge-обновление уже сохранённой тусы, восстановление imagePaths и сопоставление multi-event source.
- `tests/events/eventProposalSourceRefreshV140.test.mjs` — existing-source fast path до обычной предложки, точный VK API без page-open, bounded browser/AI waits, асинхронная пересборка snapshot и один реальный poster repair.


## Автоматически проверяется

| Область | Тесты |
|---|---|
| OpenAI SSE и ошибки stream | `tests/ai/openAIStream.test.mjs` |
| Извлечение image candidates | `tests/ai/openAIImageStream.test.mjs` |
| Ключи моделей и астрологические режимы | `tests/ai/gptModeRouting.test.mjs`, `tests/ai/proInferencePolicy.test.mjs`, `tests/astrology/astrologyRouting.test.mjs`, `tests/astrology/natalRouting.test.mjs`, `tests/astrology/astrologyOutputPolicy.test.mjs`, `tests/astrology/ephemerisMaximum.test.mjs` |
| Длина ответа | `tests/ai/responseLengthRouting.test.mjs` |
| Неизвестные термины | `tests/ai/unknownTermRouting.test.mjs` |
| Явная память | `tests/memory/memoryRouting.test.mjs` |
| Telegram меню и адаптер | `tests/platforms/telegramBot.test.mjs` |
| События: candidate, strict validation, metadata, dedupe | `tests/events/*` |
| Роли, теплота, активное общение, перепалка и адресная прожарка | `tests/personality/*`, включая границы 40/40/20, выбор Luna/Terra 50/50, новое окно 1–60 минут, промпты без клоунского абсурда, `roastCommandRouting.test.mjs` и `flatterCommandRouting.test.mjs` |
| SQLite migration и настройки | `tests/infrastructure/*`, database tests в personality/platforms |
| Команды, даты, VK reply/quote addressing, source config | `tests/shared/*`, включая `botAddressing.test.mjs`, и `tests/scrapers/*` |
| Новая структура и entrypoint | `tests/architecture/architecture.test.mjs` |

## Не проверяется без отдельного стенда

- реальный VK Long Poll;
- реальный Telegram getUpdates/sendMessage/sendPhoto;
- фактический router.cheap model availability и цены;
- long-running Sol response на несколько минут;
- GigaChat OAuth;
- Google Geocoding;
- Chrome login/captcha/DOM VK;
- численная точность Swiss/Moshier относительно внешнего эталонного астрономического ПО;
- фактическая доступность optional-астероидов, звёзд и систем домов на production `sweph`;
- реальная отправка фонового выкрика по таймеру.

## Проверка релиза

```bash
npm run verify
```

После локальных тестов на реальном экземпляре выполнить smoke test:

1. `/id` в Telegram;
2. помощь в ЛС;
3. базовый короткий GPT-вопрос;
4. запрос с `pro3` и проверка `[GPT ROUTE RESOLVED]`;
5. кнопка «Тусы»;
6. `стиль общения`;
7. `статус активного общения` в тестовой группе; затем выключить режим и проверить, что `next_outburst_at=0`, фоновая реплика не отправляется и старая перепалка не продолжается;
8. ответить обычным VK reply на сообщение бота без активной сессии и проверить реакцию;
9. переслать/процитировать сообщение бота и проверить реакцию;
10. включить роль `быдло` и проверить, что следующий фоновой запуск попадает в окно 1–60 минут;
11. по логам `[COMMUNICATION OUTBURST]` проверить сценарии `conversation`/`air`/`participant` и модели Luna/Terra;
12. включить активное общение и убедиться, что автономная реплика привязана к реальному контексту, без мягкой клоунады и случайного сюрреализма;
13. `Гигорейв фас` и `Гигорейв фас <имя>` в тестовой группе, проверив отсутствие фактов старше 24 часов;
14. `Гигорейв pro3 прашна локалэфемериды ...`: в `[GPT ROUTE]` проверить `localCalculation=true packet=maximum`;
15. `Гигорейв pro3 натал локал 14.03.1987 19:40 Воронеж`: проверить timezone, `[NATAL EPHEMERIS]`, `auditComplete=true` и непустой payload hash;
16. при `ASTROLOGY_REQUIRE_SWISS_FILES=1` временно убрать `EPHEMERIS_PATH` и убедиться, что запрос останавливается понятной ошибкой, а не переходит на Moshier;
17. с настоящими `*.se1` проверить `precision=swiss-files-confirmed` и Swiss-бит в фактических return flags всех прямых основных тел; без строгого режима проверить явный `precision=moshier-or-mixed-fallback`;
18. ручная ссылка события без сохранения, если дата прошла.
19. в VK отправить обычную команду и проверить, что ответ визуально прикреплён к исходному сообщению; повторить для ответа с изображением.
20. в Telegram повторить текстовый ответ, фото и длинный ответ в группе/теме, проверив нативную плашку reply.
21. во VK и Telegram запросить `pro3` с формулировкой «на 10 000 слов» и убедиться, что бот не спорит о длине, а выдаёт законченный ответ до двух страниц несколькими reply-сообщениями.


## V47

- `tests/ai/openAIRetryRouting.test.mjs` — задержка 5–30 секунд, временные ошибки и порядок усиления моделей.
- `tests/personality/botIdentityProvocationRouting.test.mjs` — конструкции присвоения оскорбительного имени и промпт ответа.
- `tests/memory/memoryRouting.test.mjs` — такие конструкции не попадают в текущую или историческую explicit memory.
- `tests/shared/sharedCommands.test.mjs` — разговорные варианты имени бота.

## V48

- `tests/platforms/messageReplyTransport.test.mjs` — VK `MessageContext.reply`, Telegram `reply_parameters` для JSON и multipart, сохранение исходного `message_id` в текстовых ответах и изображениях.

## V49

- `tests/ai/responseLengthRouting.test.mjs` — единый предел 14 000 символов/10 000 completion tokens для pro, отсутствие правила 8–10 предложений, молчаливый cap чрезмерного запроса и распознавание мета-отписки о длине.



## V50

- `tests/personality/flatterCommandRouting.test.mjs` — разбор `подлизать`, выбор недавнего сообщения, нейтрализация грубых ролей, доброжелательный prompt/fallback.
- `tests/ai/incomingMessagePrompt.test.mjs` — обязательные `message_index`, `participant_name`, `participant_index`, точный текст и отсутствие дублирования блока.
- `tests/platforms/messageReplyTransport.test.mjs` — явный reply на сохранённый индекс сообщения в VK и Telegram.


## V51

- `tests/personality/communicationStyleDatabase.test.mjs` — выключенные строки не попадают в due-выборку и startup-reschedule; очистка всех banter-состояний беседы.
- Оркестратор повторно читает настройки и проверяет epoch перед GPT и непосредственно перед отправкой активной реплики, фонового выкрика и продолжения перепалки.


## V52

- `tests/ai/incomingMessagePrompt.test.mjs` — отдельные поля reply-цели, автор и индекс исходной реплики, полный текст, описание вложений, недоверенный характер цитаты и отсутствие дублирования контекста.
- Оркестратор извлекает `replyMessage` / `message.reply_message` во VK и Telegram, добавляет reply-контекст ко всем OpenAI-compatible GPT-вызовам и к явному GigaChat-ответу.
- Ручной smoke-test: ответить на чужую реплику сообщением «Гигорейв, оцени это сообщение» и проверить, что анализ относится к исходной реплике, а не к тексту команды.

## V57

- `tests/ai/participantQuestionRouting.test.mjs` — распознавание вопроса об участнике, сопоставление `Тимосин` → `Тимофей`, прямой VK mention и отсутствие ложного маршрута для обычного вопроса.
- Интеграция оркестратора — сбор участников из SQLite, разрешение настоящих VK-имён, выбор sender_id, анализ всех его сообщений блоками и окончательный ответ по материалам.
- Ручной smoke-test: спросить `Гигорейв почему Тимосин всё время хочет пиздеться?` при наличии в базе сообщений Тимофея; ответ должен назвать Тимофея и ссылаться на закономерности его сообщений, а не писать, что не знает человека.

## V58

- `tests/ai/participantQuestionRouting.test.mjs` — поиск сообщений по форме `Тимосин`, настоящему имени, склонению `Тимофея`, VK mention и Telegram username.
- Проверяется исключение сообщений, написанных самим целевым участником, из блока «что писали о нём».
- Интеграция оркестратора — отдельный анализ собственных сообщений и сторонних упоминаний, отдельные блоки в финальном промпте и отдельные счётчики в ответе.
- Ручной smoke-test: создать в истории сообщения `Тимосин опять спорит`, `Тимофей сегодня спокойный`, затем спросить о Тимосине. В заголовке ответа должны быть ненулевые счётчики собственных сообщений и упоминаний другими людьми.

## V59

- `tests/ai/imageEditRouting.test.mjs` проверяет не только разбор команд редактирования, но и наличие `parseImageEditRequest` в import-блоке оркестратора.
- Тот же тест проверяет, что секция `[TELEGRAM STARTUP ERROR]` не содержит повторного `throw error` до запуска VK Long Poll.
- Ручной smoke-test: запустить с недоступным `api.telegram.org` и заполненным `TELEGRAM_BOT_TOKEN`; в логе должны появиться `TELEGRAM STARTUP ERROR`, `TELEGRAM STARTUP DEGRADED` и затем `Запускаю VK Long Poll…`.
- Ручной smoke-test обычной команды: `Гигорейв что такое ПРЛ`; не должно быть `ReferenceError: parseImageEditRequest is not defined`.

## V60

- вопрос про самого бота не запускает participant database route;
- `все` не сопоставляется с `Михаил Витасепт` после общей нормализации stop-words;
- `Тимосин` по-прежнему сопоставляется с `Тимофей Тимофеев`;
- слабое fuzzy-совпадение ниже 0.84 отклоняется.

## V61

- обычная форма `досье тимасин` разрешается без требования вопросительного предложения;
- alias `@timasin228` участвует в локальном fuzzy-поиске;
- оркестратор вызывает `resolveDossierTarget(context, requestText)` и хранит числовой `targetUserId`;
- при пустом досье запускается `buildDossierFromStoredMessages` по собственным сообщениям цели;
- в постоянное досье не попадают чужие упоминания и медицинские диагнозы;
- версия сборки: `events-v61-dossier-fuzzy-target-backfill`.

## V62: owner-only доступ к досье

- посторонний пользователь получает `Команда недоступна.` до разрешения цели;
- постороннему не показывается запрос пароля;
- `beginDossierAuthorization` и `finishDossierAuthorization` повторно проверяют владельца;
- старое pending-ожидание пароля удаляется для не владельца;
- владелец сохраняет fuzzy-поиск цели и on-demand построение досье V61.


## V64: жёсткая маршрутизация парсера и Telegram offline guard

- `tests/scrapers/scraperCommandRouting.test.mjs` проверяет голые команды `парсер`/`парсеры` как запрос подсказки.
- Проверяются `парсер все`, `парсер всё`, `парсер запустить все` и `run all scrapers` как режим запуска всех источников.
- Проверяется короткая форма `парсер tg:kurazhcity`; старые команды одного источника и legacy-команды остаются совместимыми.
- Проверяется, что объектная ошибка форматируется без `[object Object]` и без публикации токенов.
- Интеграционная проверка подтверждает ранний вызов `handleManualScraperCommand` до GigaChat/GPT и наличие Telegram offline guard.
- Интеграционная проверка подтверждает наличие `startAllManualScraperSources`, текста подсказки и версии `events-v66-dm-party-routing-provider-tests` в оркестраторе.
- Ручной smoke-test: `Гигорейв парсер` должен вывести список источников; `Гигорейв парсер все` — поочерёдно запустить каждый и вывести итоговые счётчики.


## V65: Telegram connectivity

- `tests/platforms/telegramConnectivity.test.mjs` проверяет классификацию nested `ECONNRESET` как TLS reset.
- HTTP 401 классифицируется как non-retryable invalid token.
- Bot API и t.me проверяются независимо.
- Форматирование ошибки не содержит `[object Object]`.
- Интеграционная проверка подтверждает startup retries, reconnect timer и owner-команду диагностики.


## V66: DM party routing и API providers

- `tests/events/dmPartyRouting.test.mjs` проверяет, что обычные личные вопросы не получают ответы про организаторскую тусу.
- Явные вопросы о дате, формате и подробностях следующей тусы сохраняют локальный FAQ.
- `tests/ai/providerDiagnostics.test.mjs` проверяет отдельный разбор команд OpenAI/NVIDIA и изоляцию конфигураций.


## V99: party announcement + coords

- `ближайшая туса`, `Ближайшая тусовка?`, `что за ближайшая туса`, `когда ближайшая туса`, `ближайший гиг` должны попадать в organizer party route.
- Произвольный DM не должен попадать в party route.
- Публичные response-команды: `координаты`, `корды`, `корды пересоздание`, `корды случайное пересоздание`.
- 22.08.2026 Europe/Moscow: 10:59:59 — выключено, 11:00:00 — включено, 23:59:59.999 — включено, 23.08 00:00:00 — выключено.
- Owner получает сохранённые координаты вне публичного окна.
- Первая V99-миграция записывает `51.691730, 39.251385`; после owner-замены и рестарта migration marker не возвращает хардкод.
- Если запрос одновременно классифицирован как несколько party-intent с одинаковым каноническим текстом, отправляется одно сообщение.
- В Telegram `координаты`, `корды` и `ближайшая туса` должны выходить из pending image-mode как обычные команды, а не превращаться в image prompt.

## V100: nearest party fast-path + coords wait + no notice repeats

- `ближайшая туса`, `когда ближайшая туса`, `ближайший гиг` классифицируются как единственная организаторская туса.
- `ближайшие тусы`, `следующие тусы`, `ближайшие тусовки` не попадают в organizer FAQ и остаются public-events.
- Organizer-party fast-path расположен до `consumeDmAiNotice` и отправляет только первый канонический FAQ-ответ.
- AI/privacy notice для одного `user_id` отправляется максимум один раз; существующая строка `dm_ai_notice_state` блокирует повтор.
- `координаты`/`корды`/`карды` до 11:00 22.08.2026 получают локальное сообщение о времени открытия, в 11:00–24:00 — сохранённый текст, после 24:00 — локальное сообщение о завершении окна.
- Границы окна: 08:59:59.999Z before, 09:00:00Z active, 20:59:59.999Z active, 21:00:00Z after.
- V100 SQLite migration обновляет только party FAQ и не меняет owner-controlled coords message.


## V101: full coords event message

- SQLite source содержит миграцию `events-v101-coords-full-event-message`.
- Новый сохранённый ответ начинается с `51.691730, 39.251385`.
- В ответе присутствуют блок добровольного доната, правила, `Начало в 17:00` и `https://vk.ru/peresosdanie`.
- Длина сообщения остаётся ниже owner-лимита 3500 символов, поэтому VK отправляет его одним сообщением.


## V102: Sber donation details in coords

- SQLite source содержит миграцию `events-v102-coords-sber-donation`.
- Полный ответ `корды` содержит `+79968257889 (Сбер)` сразу после добровольного donation notice.
- Миграция V102 одноразово обновляет существующую настройку, после чего owner может заменить её через `корды сообщение`.

## V103: event dedupe registry

- `tests/events/eventDuplicateResolution.test.mjs` проверяет, что `_dedupeRefs` переживают глубокий merge и связывают canonical event с конкретными SQLite rows.
- `tests/events/eventDedupeRegistryV103.test.mjs` создаёт две raw manual-event строки, сохраняет canonical/duplicate membership в отдельный scope registry и проверяет, что обе raw строки остаются видимыми как source evidence.
- Тот же тест проверяет `EVENT_VERIFIED_SNAPSHOT_VERSION=2` и отказ принимать snapshot version 1.
- Owner dry-run читает все четыре event-таблицы напрямую, а apply не меняет raw statuses.

## V104

- `tests/events/eventProposalV104.test.mjs` — schema/create/read/resolve/24h due-flow заявок.
- `tests/platforms/telegramBot.test.mjs` — публичная кнопка `Предложить тусу`, owner-add label, предупреждение меню тус и безопасное ограничение media caption.
- `tests/routing/commandPriorityRouting.test.mjs` — новые event fast-path не должны падать в GPT/image routing.
- Ручной smoke-test VK wall: добавить `https://vk.ru/wall-240709021_13` и проверить, что при наличии photo attachment используется фото самого поста, а не аватар/OG preview.
- Ручной smoke-test Telegram: событие с картинкой приходит одним photo/document message с caption, без второго текстового сообщения.
- На копии production SQLite: `тусы дубли проверить` → `тусы дубли статус` → `тусы дубли применить` → `тусы перепарсить ссылки`; проверить, что первый проход локальный и быстрый, status становится completed, registry записывается сразу, а verified snapshot rebuild не блокирует owner-команду.


### V109 post-event feedback

- `разослать всем пересоздание` готовит шаблон, но не отправляет без `пересоздание отправить`.
- В feedback-state попадают только endpoints с успешной доставкой.
- Для одного endpoint следующий сохранённый отзыв закрывает ожидание; повторное сообщение уже не является отзывом автоматически.
- Telegram-кнопка благодарности преобразуется в локальную команду `пересоздание спасибо` и не попадает в image prompt.
- Отзыв хранится в SQLite и уведомление owner содержит платформу, external user ID и текст.


### V110 QR second-message delivery

- `корды`: full text is sent first; supplied donation QR is a separate second message.
- `пересоздание спасибо`: thanks text first; supplied donation QR second.
- post-event broadcast: text delivery precedes QR delivery for every successful endpoint.
- `QR-код убрать` disables QR only for the current prepared post-event broadcast; `QR-код вернуть` restores it.
- `npm run verify` must pass before packaging.

## V139: event posters + Telegram navigation

- `tests/events/eventPosterSelectionV139.test.mjs` — large/source poster wins over UI/icon candidates; PNG dimensions; VK API-over-DOM rule; exact-wall image recovery before generated card; one attachment per event; parser hash V139.
- `tests/platforms/telegramBot.test.mjs` — `➕ Предложить тусу` is in the first main-menu row, Pinball is absent, action branches expose `⬅️ Назад`, typed `назад` clears pending state.
- `tests/platforms/telegramPinballV123.test.mjs` — legacy Pinball backend remains testable, but V139 verifies it is not exposed in Telegram routing/menu.
- `tests/platforms/telegramEventDeletionMenuV115.test.mjs` — deletion/restore menu contains both `⬅️ Назад` and `🏠 На главную`.
- `tests/scrapers/vkMediaRecoveryV131.test.mjs` + `tests/platforms/vkEventPhotoDeliveryV134.test.mjs` remain regression coverage for hydration and hardened VK upload.

## V156: public compact dossier

- маршрут `dossier` не проверяет владельца;
- `DOSSIER_PASSWORD`, pending authorization и ответы `пароль?`/`неверный пароль` отсутствуют;
- справка объявляет команду доступной всем участникам групповой беседы;
- ответ ограничен 2800 символами и отправляется одним сообщением;
- модель ограничена 1100 токенами, выборка — 180 сообщений;
- в ЛС команда остаётся group-only.
