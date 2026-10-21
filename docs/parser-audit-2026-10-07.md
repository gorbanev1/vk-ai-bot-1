# Аудит парсинга тусовок: 2026-10-07

## Объект проверки

Проверен последний forensic-архив:

data/parser-forensic-archives/2026-10-06T12-37-39-495Z_parser-all-clean_062f99

В запуске было 15 источников и 180 захваченных записей: 11 VK-пабликов, 3 VK-беседы и один Telegram-канал. 14 источников переиспользовали raw-cache; этот replay не измеряет стоимость полного свежего DOM-захвата.

## Цепочка текущего кода (не развёрнута перезапуском)

1. Браузерный захват DOM выполняет конечный проход, сохраняет immutable final DOM и пишет raw-cache с runId.
2. Конечные exact/adaptive-контуры читают один и тот же финальный DOM. При этом выходной collected также сохраняет записи более ранних scroll-итераций; они не заменяются целиком последним DOM. Для parser-all-clean часть forensic-снимков отключена, но throttled checkpoint-наблюдения остаются.
3. Prefilter читает raw-cache, ledger и recency-политику. Неизменённые финальные записи отбрасываются из processingPosts до Vision/AI. Повторная admission-проверка может ошибочно вернуть их в список pending; это отдельный дефект ниже.
4. Poster-gate допускается только после барьера всех raw-cache. Неразрешённый root-текст репоста не повторяется платным AI-контуром.
5. Обработка идёт через pool с лестницей моделей. После обработки сохраняются source row, event rows и ledger status.
6. При полном проходе строится verified snapshot и выполняется cross-source dedupe. При частичном проходе глобальный dedupe пропускается и сохраняется checkpoint для recovery.
7. Выдача читает persisted event rows и configured dedupe registry, затем применяет диапазон дат и pool-фильтр.

## Измерения последнего запуска

| Этап | Наблюдение | Вывод |
|---|---:|---|
| DOM/raw-cache | около 22 секунд; 14 из 15 источников из кэша | захват DOM не объясняет часовую задержку |
| Captured | 180 записей | объём входа умеренный |
| Incremental skip | 175 | ledger/hash уже отсекает большую часть до AI |
| Candidate queue | 9 ключей | это смешанный счётчик AI-кандидатов и unresolved-записей, а не 9 вызовов AI |
| Vision/AI | отдельные вызовы до 150–180 секунд | одна попытка Luna/Vision всё ещё может быть дорогой |
| Retry до исправления | до 6 циклов на одну запись | лестница запускалась повторно и умножала задержку |
| Финальный dedupe до исправления | около 474 секунд при 44 событиях | узкое место было в повторных mini-GPT батчах и полном перескане базы |
| VK API | 0 вызовов | DOM был фактическим источником данных |

В trace видно, что rb_diesel#13875, deadway36#8355 и idmamaanarchy#5 повторно проходили AI; у одной записи цикл доходил до 6. Это и давало десятки минут, хотя raw-cache был готов почти сразу.

## Подготовлено в worktree, без развёртывания

- Public/chat processing pool ограничен двумя циклами всего. Один цикл содержит настроенную лестницу моделей. Повтор пока запускается и для transport error, и для fulfilled `{ unresolved: true }`; формулировка «только временный транспорт» в комментарии к коду строже фактического поведения.
- ROOT_POST_TEXT_UNRESOLVED и POSTER_GATE_UNRESOLVED больше не запускают бессмысленную повторную платную лестницу. Эти состояния требуют DOM/hydration, а не нового AI.
- При partial run полный глобальный dedupe пропускается. В checkpoint сохраняются незавершённые кандидаты и trace; recovery переиспользует только cache с provenance выбранного запуска.
- Для parser-all-clean включена final-DOM-only политика. Raw-cache записывается атомарно и содержит runId.
- DOM-парсер уже использует owner-scoped ключи при сборе и merge. Добавлена защита: если DOM сообщает владельца текущей страницы, вложенные wall-owner_post другого владельца не становятся отдельными постами источника, но остаются частью evidence внешнего репоста.
- Исправлен legacy owner-scoped regression: одинаковый числовой postId разных VK-владельцев сохраняется раздельно.

## Критичный оставшийся дефект

В raw-cache idmamaanarchy реально есть два разных поста с одинаковым postId=5:

- wall-241363728_5
- wall-241527692_5

DOM-слой их различает, но публичный downstream-контур ещё местами строит itemId как один числовой postId. В vkPublicScraper это затрагивает candidateDecisions, ledger lookup, AI queue, processing callbacks и diagnostics. Поэтому два поста могут перезаписать решение друг друга ещё до SQLite.

SQLite дополнительно хранит vk_source_posts и vk_events с ключами (screen_name, post_id) и внешним ключом на эту пару. Полная защита требует миграции на (screen_name, owner_id, post_id) во всех связанных таблицах, включая:

- vk_source_posts, vk_events и уникальные ограничения;
- manual-parser ledger и source/event upsert/delete;
- все JOIN, refresh-запросы, poster repair и dedupe provenance;
- старые строки и индексы с сохранением обратной совместимости.

Эту миграцию не выполнял автоматически: частичный патч может скрыть старые события или связать poster/event с неправильным wall. Следующий безопасный этап — отдельная миграция с копированием таблиц, проверкой внешних ключей, backfill owner_id из source_url и regression на одинаковый postId.

## Дедуп и выдача

Текущий полный проход строит dedupe после обработки источников, а partial-pass его откладывает. Алгоритм содержит deterministic contour, bounded AI arbitration, verification contours, paranoid collapse и ограниченный same-day sweep. Это корректно по порядку, но полный verified snapshot всё ещё читает persisted upcoming events всей базы, потому что ему нужен cross-source результат. Поэтому ускорять его фильтром только по текущим событиям можно только после отдельной политики stale registry; иначе выдача потеряет ранее сохранённые карточки из источников, которые не попали в текущий запуск.

Для обычной выдачи диапазон дат применяется после configured duplicate refs и pool-фильтра. Источник данных и флаги предыдущих стадий сохраняются в event provenance и poster metadata. Помимо owner-key разрыва найдены несогласованные состояния pending/rejected и версия итогового snapshot; они описаны ниже.

## Recovery и provenance

Проверки recovery подтверждают:

- cache другого источника или повреждённый cache не подменяет выбранный запуск;
- cache с runId принимается только при наличии соответствующей trace lineage;
- partial checkpoint сохраняет source/cache maps и незавершённые кандидаты;
- recovery идемпотентен: завершённые записи пропускаются по content hash, незавершённые повторяются;
- автоматическое продолжение claim-ится один раз.

## Проверки

Успешно:

- node --check src/platforms/vk/vkPublicScraper.js;
- изолированный набор postIdentityOwnerScoped, parserCacheReplay, parserAllRecovery, interruptedCheckpointRecovery: 29/29 тестов.

Отдельные старые тесты, запущенные без изолятора, падают на защите production SQLite в NODE_ENV=test; это ошибка окружения запуска теста. Один статический тест cleanIncrementalParserV18865 ожидает старый текстовый шаблон и требует обновления теста под текущую структуру attachments; это не runtime-сбой.

## Рекомендуемый порядок следующего изменения

1. Owner-aware SQLite migration с dry-run отчётом конфликтующих (screen_name, post_id).
2. Перевод public ledger/queue/diagnostics на единый ownerId:postId item key.
3. Regression: два одинаковых postId разных owners проходят prefilter, AI queue, persistence, refresh и delete независимо.
4. Только после этого оптимизировать verified snapshot/dedupe на уровне текущего run scope.

## Дополнительный аудит выдачи и повторных проходов

### Где используется последний слепок

В финальном проходе VK exact, legacy-regex и adaptive/heuristic contours читают
одну строку `fullDomHtml` после пагинации. Но `collectVkPostsWithBrowser` сначала
добавляет записи каждой scroll-итерации в `collected`, а в конце обновляет только
совпавшие ключи. `buildResult()` возвращает весь `collected`. Поэтому ответ на
«только ли последний слепок?» — нет: финальный контур использует последний,
выход представляет накопленный набор. Это может быть нужно при виртуализации
ленты, но у каждой записи должен быть собственный snapshot hash/sequence, иначе
невозможно доказать, из какого наблюдения пришли её текст и медиа.

Отдельный final DOM sidecar снимается ещё одним чтением страницы после extraction,
а не получает уже использованный `fullDomHtml`. В режиме `finalDomOnly` обычный
`captureDomSnapshot` пропускает запись, поэтому сохранённый sidecar может отличаться
от строки, по которой выполнялся exact. Throttled checkpoint-наблюдения остаются
(до 12 на источник); они диагностические и не являются отдельным входом AI.

В последнем архиве `artifacts.domSnapshots` пуст, но 14 из 15 источников
переиспользовали raw-cache, поэтому этот факт не доказывает работу новой
политики `finalDomOnly` на свежем браузерном захвате. При этом старый архивный
raw-cache `idmamaanarchy` не содержит верхнеуровневого `runId`, хотя текущий
`cacheSource` его записывает. Такие архивы следует помечать `legacy-replay` и не
считать криптографически связанными с runId восстановления.

### Лишние чтения и дедуп-проходы

\`selectVerifiedEventSnapshotItems\` на каждый пользовательский запрос перечитывает
до 20 000 строк SQLite и пересчитывает SHA полного набора, чтобы проверить
\`sourceRevision\`. При устаревшем snapshot запускается repair, а all-party/public
fallback параллельно выполняет локальный дедуп. В all-party запросе до выбора
кандидатов заново полностью пересобирается производный \`all_party_metadata\`
индекс, после чего он снова читается по диапазону. Это корректно, но повторяет
работу, которая уже может быть выполнена после parser run; безопасная оптимизация
требует durable revision/invalidation marker и теста на гонку обновления.

В последнем архиве `source.link-enrichment` записан для 11 VK-источников, но
`opened=0` у каждого. Переходы по связанным страницам не объясняют задержку
этого запуска. Возможность открыть до 36 страниц на источник существует в коде,
но её нельзя выдавать за измеренную причину последнего сбоя.

Полный snapshot rebuild повторно читает raw SQLite: сначала для deep dedupe с
\`limitPerTable=2000\`, затем для \`sourceRevision\` с \`limitPerTable=20000\`. При
более чем 2000 будущих строк в таблице snapshot строится на усечённом наборе,
но revision считается по полному набору после обработки. Это опаснее простого
повторного rebuild: неполный snapshot получает revision полного набора и может
считаться актуальным, скрывая события за пределом первых 2000 строк таблицы.
Дополнительно запись в SQLite во время await внутри дедупа может попасть в
revision в конце, хотя она не входила в исходный scan. Нужны одинаковый scope
чтения, версия входа до обработки и сравнение версии перед публикацией.

### Разрыв QTickets и all-party

До этого аудита dedicated QTickets выдача исключала карточки с конфликтом
города (например, Москва без Воронежа), а \`вообще все тусы\` добавляла QTickets
после проверки диапазона без того же city gate. Это позволяло плохой карточке
обойти фильтр через агрегированную команду. Фильтр унифицирован в коде и покрыт
регрессионным тестом.

### Идентичность и флаги

Secondary revalidation берёт raw text через \`getVkPostMeta(screenName, postId)\`;
это тот же owner-unaware ключ, что и ledger/AI queue VK public. Поэтому два
поста одного screen name с одинаковым числовым \`postId\` могут получить
перепутанный \`parseStatus\`, raw text или event rows ещё до verified snapshot.
Owner-aware migration должна охватить этот read path, а не только таблицы.

Read-only проверка последнего архива и текущей SQLite-базы подтверждает
реальную, а не теоретическую коллизию. В архиве есть 80 VK-постов и 79 пар
`(screen_name, post_id)`: для `idmamaanarchy/#5` захвачены одновременно
`wall-241363728_5` и `wall-241527692_5`. В `vk_source_posts` осталась строка
с `owner_id=-241363728` и первым URL, а в `manual_parser_seen_items` для того
же `item_id=5` записан URL второго владельца. Значит, contentHash, parseStatus
и source URL одного поста уже могут описывать другой. Диагностика выполняется
скриптом `scripts/audit-parser-owner-keys.mjs` в режиме SQLite read-only;
миграция и исправление данных им не выполняются.

В том же запуске `item.processing.start` записан 21 раз, но уникальных
`sourceId:itemId` только четыре. Два разных поста `idmamaanarchy/#5` стартуют
в одной очереди с одинаковым ключом. Поэтому `candidateCount=9` нельзя
интерпретировать как девять независимых AI-вызовов: в него попали пять
записей с `repost-root-text-unresolved`/прошлой датой, которые были отмечены
как pending или failed. Пять записей были пропущены ledger, но всё равно остались
в candidateState; ещё одна unresolved-запись беседы действительно повторялась.
Текстовые AI-вызовы связаны с тремя legacy-ключами (один ключ скрывает два
разных поста); это следует показывать раздельными
счётчиками (`captured`, `ledger-new`, `ai-admitted`, `blocked-unresolved`,
`retry-attempts`).

### Проверки

После city-gate fix прошли \`node --check src/app/botApplication.js\` и 10
целевых тестов QTickets/all-party. Изолированный recovery/cache/identity набор
остаётся 29/29 passed по предыдущему этапу.

## Нарушения переходов между этапами

### P1: skipped снова становится pending

`vkPublicScraper.js:5210` сначала получает `before.incrementalKnown` и
recency-решение. Затем блок `repostRootTextReady` безусловно ставит
`rootTextUnresolved`, а строка 5303 добавляет запись в `candidateIds`.
Позже `processingPosts` (строка 5384) удаляет все incremental-known записи.
Итог: coordinator ждёт кандидат, который вообще не поставлен в worker.
В последнем trace пять таких записей остались pending: bashnyakult/86,
overlockbar/188 и /191, rb_diesel/13873, storuvrn/448. Это может держать
проход в partial даже после завершения всех реально поставленных задач.

Предложение для review: зафиксировать терминальные решения prefilter как
неизменяемые для текущей версии contentHash. В pending добавлять только
scheduled processing либо отдельное `blocked-capture`, которое не обозначается
как вызов AI. Эффект: очереди, checkpoint и итоговый счётчик сходятся;
повторный запуск не пытается закончить уже пропущенные записи.

### P1: unresolved public repost может стать окончательно rejected

У public worker (`vkPublicScraper.js:5410`) отсутствует специальная ветка для
`decision.rootTextUnresolved`. При `aiCandidate=false` он записывает
`processed_rejected`, а этот статус считается финальным ledger. Следующий
clean-run с тем же contentHash пропустит такой пост, хотя AI-решения
«это не событие» не было. У chat worker (`vkChatEventScraper.js:5181`)
аналогичное состояние бросает `ROOT_POST_TEXT_UNRESOLVED` и остаётся retryable.

Предложение: единый технический статус `capture_unresolved`/`failed_retryable`
для обоих источников, без платных повторов прежнего входа. Повтор допустим
после нового DOM или изменения root-text evidence. Это не ослабляет требование
добыть корневой текст, а сохраняет возможность завершить обработку.

### P1: snapshot может подтвердить вход, которого не обрабатывал

`rebuildVerifiedPartySnapshot` (`botApplication.js:24722`) захватывает до
2000 строк на таблицу, затем ждёт AI и меняет registry. На строке 24897
revision вычисляется повторным чтением до 20000 строк. `selectVerified...`
сравнивает с таким же поздним полным чтением. Новые/изменённые строки во время
await и хвост после лимита 2000 могут отсутствовать в items, но входить в
revision, поэтому проверка свежести пройдёт ошибочно.

Предложение: единая ревизия данных, входной read snapshot, контроль версии
перед commit dedupe/публикацией. Если данные изменились, результат не объявлять
verified и не удалять строки по устаревшему сравнению. Для большого набора
использовать пагинацию, а не разные молчаливые пределы.

## Контракт стадий для review

| Этап | На что должен ссылаться результат | Проверка/проблема |
|---|---|---|
| DOM capture | runId, sourceId, snapshot SHA, sequence, capturedAt | Финальные contours используют одну строку; accumulated rows могут быть из ранней итерации |
| Root repost | ID корневого wall, root text, evidence container, resolved flag | DOM остаётся основой; техническое отсутствие текста не равно not-event |
| Raw-cache | capture lineage, schema/parser version, item identity, hash | Atomic write/runId подготовлены; replay старого кэша должен явно обозначаться legacy |
| Prefilter | raw item key + contentHash + policy version | Ledger skip и recency нельзя отменять последующим root-gate |
| Poster gate | тот же item key, identity изображений, outcome/error | pending/error не является отрицательным AI-решением |
| AI | admitted decision + exact input + ladder/attempt | Одна ступень Luna может повториться при повторе внешнего pool |
| Persistence | source identity + accepted event IDs + image evidence + final ledger | Нужна единая транзакция; owner_id теряется в ключах и JOIN |
| Dedupe | event IDs, source versions, complete member lineage | Не применять результат к изменившемуся во время await набору |
| Snapshot/выдача | verified revision, pool, date policy, registry version | Одинаковый входной scope и durable invalidation вместо полного SHA на каждый запрос |

## Пакет owner-aware миграции для review

1. Сначала dry-run только последнего архива и связанных с ним строк. Готовая
   read-only команда: `node scripts/audit-parser-owner-keys.mjs --archive data/parser-forensic-archives/2026-10-06T12-37-39-495Z_parser-all-clean_062f99 --from-date 2026-10-07`.
2. Внести `owner_id` в `vk_events`; перестроить PK/FK/UNIQUE через новые
   таблицы, сохранив прежние event IDs и все метаданные. Owner брать из
   подтверждённой identity, не угадывать из screenName. Конфликтующие и
   неизвестные строки выводить в отчёт, не переносить final ledger вслепую.
3. Перевести queue, poster gate, callbacks, ledger, media paths и sourceItemId
   на один helper полного wall key; JOIN, UPSERT, refresh/delete обязаны
   принимать ownerId. Legacy numeric ledger переносить только при однозначном
   совпадении владельца и URL.
4. На копии базы проверить сохранность event IDs, FK, metadata, poster paths,
   duplicate registry; два поста с одним номером должны независимо проходить
   prefilter, AI, persistence, обновление и удаление.
5. Публиковать миграцию и runtime одновременно после review. Частичное
   изменение одного itemId оставит ключи других этапов несовместимыми.

Миграция не применялась. Бот и парсер в ходе этого продолжения не запускались
и не перезапускались; рабочая база была открыта только read-only.

