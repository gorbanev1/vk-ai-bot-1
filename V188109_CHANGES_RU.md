# Gigorave V188.109 — durable Astra file transport и защита от повторной оплаты

V188.109 интегрирует транспортные рекомендации независимого Astra-аудита поверх V188.108. Главный инвариант: после того как дорогой inference мог начаться, бот не имеет права автоматически создавать второй Astra POST.

## Что изменено

- Project-audit сохраняет входной ZIP на диск **до** detached job и до продвижения durable Telegram offset. Загрузка идёт потоково в `.part`, с idle-watchdog, лимитом фактических байт, SHA-256, fsync и atomic rename.
- SINGLE-SHOT строит sanitized ZIP только из разрешённых исходников + `ASTRA_INPUT_MANIFEST.json`; `.env`, runtime data, базы, cookies, browser profiles и другие исключённые пути не передаются.
- Большой project ZIP передаётся Astra через `POST /files` и `input_file.file_id`; исходники больше не дублируются огромным Base64/текстовым prompt.
- Для Responses используется стабильный `Idempotency-Key`. После background create `responseId` немедленно сохраняется в `state.json`.
- Polling временных 408/409/425/429/5xx/524 продолжает **тот же responseId**. 404 после существующего responseId больше не трактуется как основание создать SSE inference.
- Background → stream fallback разрешён только для явной capability-ошибки создания background **до** начала inference.
- Network/HTTP/stream ошибки Astra после POST или любой stream activity получают `inferenceMayHaveStarted`; failover/retry не создаёт новый платный запрос.
- MULTIPASS принудительно сериализован (`concurrency=1`), поэтому соседний дорогой worker не может продолжать тратить токены после ошибки другого worker.
- Project Astra failover использует `failuresBeforeQuarantine: 1`, `maxCandidates: 1`, `failoverMaxRounds: 1`. Общий failover также не ретраит ошибки с `inferenceMayHaveStarted`, `streamOutputStarted` или `responseId`.
- Router, вернувший обычный JSON при `stream=true`, обрабатывается как JSON-ответ, а не ошибочно как SSE.
- `state.json` записывается атомарно `.tmp → rename` и сохраняет предыдущие durable поля.
- При старте после подключения Telegram recovery worker: `astra-running` продолжает polling сохранённого `responseId`; `ready-to-send` / `delivery-failed` повторяют только Telegram delivery. Новый Astra inference recovery не создаёт.
- Скачивание generated artifact для project-audit теперь идёт потоково в `data/audit-jobs/<jobId>/artifacts/*.part`, затем `fsync → rename`, SHA-256 и ZIP/CRC validation; сетевой путь не собирает массив chunk-буферов.
- SINGLE-SHOT и MULTIPASS сохраняют итоговый ZIP в `data/audit-jobs/<jobId>/outbox` **до** Telegram.
- `sendDocument` принимает `filePath`, использует `openAsBlob`, отдельный большой timeout (default 2h), abort + timeout composition, свежий FormData на retry, 408/409/425/429/5xx retry и уважение `retry_after`.
- `getFile` имеет отдельный timeout; Telegram retry delay abortable.
- Telegram ZIP update не подтверждается persisted offset, пока project-audit не сохранил source ZIP/state или маршрут не завершился иным образом.
- Несколько ZIP в одном audit-запросе явно отклоняются и не проваливаются в обычный Base64 file-input route.
- Обычные скрытые повторные генерации (length/deferred retry) отключены для Astra, если они могли создать повторную оплату.
- Attachment failure reporter не сериализует Buffer/Uint8Array в диагностический JSON.
- Provider-key audit исключает все `OPENAI_COMPAT_API_KEY_N`, а не только базовый ключ.

## Ограничения

- Надёжное restart-resume дорогой модели возможно только в background transport, где router выдаёт стабильный `responseId`. Если router не поддерживает background и используется SSE fallback, оборванный процесс нельзя безопасно «продолжить» без новой inference; V188.109 в таком случае предпочитает остановиться, а не платить второй раз автоматически.
- Валидация ZIP по-прежнему требует чтения уже сохранённого архива в память ZIP-parser'ом. Сетевой download при этом потоковый и не держит дополнительный массив chunk'ов.

## Финансовый инвариант

```text
Telegram ZIP
→ durable source.zip
→ ZIP/CRC/SHA validation
→ sanitized ZIP
→ /files
→ file_id
→ ONE Responses POST
→ responseId checkpoint
→ poll same responseId
→ durable outbox
→ Telegram delivery retry only
```
