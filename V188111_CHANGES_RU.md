# V188.111 — транспорт Astra/Telegram: интеграция трёх независимых аудитов

База: GIGORAVE V188.110. VK/event/parser/dedupe и 4-часовая success-first транспортная политика намеренно не изменялись.

## Исправлено

- `modelProviderFailover.js`: синхронная или асинхронная ошибка `onEvent` больше не превращает успешный платный запрос в новый model POST. Запрет общего failover дополнен признаком `inferenceCompleted`.
- В Responses background: ошибка callback/checkpoint после появления `responseId` несёт этот ID и `inferenceMayHaveStarted`, поэтому нельзя ошибочно начать новый POST. Ошибка `onResponseArtifacts` после получения результата тоже помечается как уже начавшийся inference. Ошибки UI-обновления текста не меняют судьбу ответа.
- Перед дорогостоящим API вызовом критические `state.json` checkpoints теперь обязательны: при ошибке записи операция останавливается до POST. Временный checkpoint имеет уникальное имя, файл `fsync`-ится перед `rename`.
- Ошибка позднего этапа не затирает уже существующее `ready-to-send`/`delivery-failed` или известный `responseId` статусом `failed`. Известный ID сохраняется для восстановления polling; неоднозначный запрос без ID отмечается явно.
- Recovery: если в outbox уже есть итоговый ZIP, проверяется SHA/размер, а при отсутствии сохранённого SHA — также ZIP/CRC, затем возобновляется только доставка; учитываются stale `astra-completed`/`output-ready`. `responseId` восстанавливается по GET без нового POST. Промежуточный этап без ID не пропускается молча: отмечается `recovery-needs-attention`, владелец получает Telegram-уведомление при возможности.
- Telegram download и Astra artifact download сравнивают фактические байты с `Content-Length` для неупакованного HTTP-тела, отклоняют неожиданный `206 Partial Content`. Ошибка скачивания artifact не повторяет inference.
- Artifact остаётся в `.part` до проверки ZIP/CRC; повреждённая попытка не перезаписывает ранее валидный файл. Имена artifact очищаются от путей/точек и collision-имена получают порядковый префикс в fallback ZIP.
- ZIP reader сравнивает local/central flags/method/CRC/sizes (учтён флаг data descriptor), проверяет заявленный размер central directory. CRC-прогон и выбор исходников освобождают кэш распакованных entries; разбору большого ZIP не требуется одновременно хранить *все* entry buffers.
- SHA итогового файла при recovery считается потоково. Fallback ZIP из ответа Astra не дублирует весь исходный проект: исходник сохраняется в `data/audit-jobs/<jobId>/source/` и идентифицируется по SHA в `SOURCE_REFERENCE.json`.

## Не менялось

- SINGLE-SHOT по умолчанию, MULTIPASS только по явному флагу.
- Telegram document upload: 4-часовой timeout, до 12 попыток.
- Astra background polling: до 1000 последовательных временных неудач на **том же** `responseId`; SSE idle 4 часа; supervisor project-audit 24 часа.
- Success-first допуск до двух неоднозначных повторных POST без известного `responseId`. Наличие одинакового `Idempotency-Key` **не доказывает** поддержку дедупликации сторонним router: это осознанный риск дополнительных платных вызовов, а не гарантия exactly-once.

## Важные ограничения (не скрывать при развёртывании)

1. Полное автоматическое продолжение любого промежуточного шага, в частности `astra-starting` без известного `responseId`, невозможно безопасно обеспечить без контракта восстановления/идемпотентности стороннего router. Job и исходный ZIP остаются на диске и помечаются для проверки, но новый платный inference не запускается только ради recovery.
2. ZIP parser всё ещё Buffer-based; хотя CRC-прогон освобождает `entry.data`, исходный большой ZIP и отдельные нужные entries могут размещаться в памяти. Для 100+ МБ/архивов с огромной распаковкой нужен отдельный disk-native ZIP parser и нагрузочный тест на целевом сервере.
3. Для Telegram sendDocument нет сквозного серверного exactly-once: если Telegram принял документ, но HTTP-ответ потерялся, повтор доставки может создать дубликат сообщения. Outbox не теряет файл, а политика пользователя — доставить хотя бы один раз.
4. Не проводились реальные операции с платным сторонним router, 100+ МБ файлом, сетевыми отключениями и аварийным рестартом процесса. Существующие legacy-тесты преимущественно source-smoke; V188.111 добавляет поведенческие тесты модели failover и ZIP integrity.
5. Если router не поддерживает `/files`, `input_file.file_id`, background retrieval или Code Interpreter artifacts, текущий project-audit маршрут не может сделать его совместимым кодом клиента. Проверяйте его capabilities до дорогой операции.

## Тесты

`node --test tests/ai/v188111AuditTransportBehavior.test.mjs` — реальные вызовы функции failover и ZIP parser без платного API. Более широкий набор транспортных регрессий — `tests/ai/v188104*` … `v188111*`.
