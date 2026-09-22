# Gigorave V188.110 — success-first transport

V188.110 меняет приоритет project-audit с жёсткого at-most-once на bounded success-first, сохраняя durable recovery. Цель — не потерять многочасовой аудит из-за кратковременного сбоя сети/router.

## Изменения

- `TELEGRAM_DOCUMENT_SEND_TIMEOUT_MS`: default 4 часа (max 6 часов).
- `TELEGRAM_DOCUMENT_SEND_MAX_ATTEMPTS`: default 12.
- `PROJECT_ARCHIVE_MAX_POLL_TRANSIENT_FAILURES`: default 1000. Эти повторы делают только GET существующего `responseId`, новый inference не создаётся.
- `OPENAI_STREAM_IDLE_TIMEOUT_SECONDS`: default 4 часа, max 6 часов. Это защищает fallback SSE от ложного обрыва во время очень долгого reasoning без входящих байтов; hard ceiling project-audit остаётся отдельным.
- Исправлен скрытый лимит `operationSupervisor`: раньше любой явно заданный timeout всё равно обрезался до `DEFAULT_OPERATION_TIMEOUT_MS=2h`. Теперь обычный default остаётся 2 часа, но явная операция может жить до `OPERATION_MAX_TIMEOUT_HOURS` (default/max 72h). Поэтому project-audit реально получает свои 24 часа по умолчанию.
- Telegram file download idle: default 30 минут, max 2 часа; download attempts: default 10.
- `/files` upload attempts: default 8.
- Astra artifact download attempts: default 10.
- SINGLE-SHOT ordinary retry limit: default 3 (`PROJECT_ARCHIVE_SINGLE_RETRY_LIMIT`).
- Добавлен `PROJECT_ARCHIVE_AMBIGUOUS_REPOST_LIMIT` (default 2, max 10). Если технический сбой произошёл после того, как POST мог быть принят, но `responseId` получить не удалось, разрешено до двух bounded re-POST с тем же стабильным `Idempotency-Key`. Это осознанный компромисс в пользу завершения job: router без idempotency может реально запустить дубликат.
- Если `responseId` уже известен, re-POST по-прежнему запрещён: выполняется только восстановление/polling того же response.

## Рекомендуемые defaults первого большого запуска

```env
TELEGRAM_DOCUMENT_SEND_TIMEOUT_MS=14400000
TELEGRAM_DOCUMENT_SEND_MAX_ATTEMPTS=12
PROJECT_ARCHIVE_MAX_POLL_TRANSIENT_FAILURES=1000
OPENAI_STREAM_IDLE_TIMEOUT_SECONDS=14400
PROJECT_ARCHIVE_AUDIT_OPERATION_TIMEOUT_HOURS=24
OPERATION_MAX_TIMEOUT_HOURS=72
PROJECT_ARCHIVE_SINGLE_RETRY_LIMIT=3
PROJECT_ARCHIVE_AMBIGUOUS_REPOST_LIMIT=2
TELEGRAM_MODEL_FILE_DOWNLOAD_IDLE_MS=1800000
TELEGRAM_MODEL_FILE_DOWNLOAD_ATTEMPTS=10
OPENAI_INPUT_FILE_UPLOAD_ATTEMPTS=8
OPENAI_ARTIFACT_DOWNLOAD_ATTEMPTS=10
```

`PROJECT_ARCHIVE_AMBIGUOUS_REPOST_LIMIT=0` возвращает строгий V188.109 cost-safe режим.
