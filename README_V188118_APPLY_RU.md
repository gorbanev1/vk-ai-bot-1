# Gigorave V188.118 — применение и ограничения

Обновите код поверх существующего проекта. **Не удаляйте .env, data/audit-jobs и готовые outbox ZIP.** Останавливайте бота перед заменой кода. Проверено локально на Node.js 22; в реальном Telegram/Astra запуск не производился.

В ТОМ ЖЕ окне PowerShell:

```powershell
$env:PROJECT_ARCHIVE_INPUT_MODE = "text"
$env:PROJECT_ARCHIVE_AUDIT_MULTIPASS = "1"
$env:PROJECT_ARCHIVE_MULTIPASS_TRANSPORT = "stream"
$env:PROJECT_ARCHIVE_AUDIT_CONCURRENCY = "1"
$env:PROJECT_ARCHIVE_STREAM_IDLE_MS = "100000"
$env:PROJECT_ARCHIVE_AMBIGUOUS_REPOST_LIMIT = "0"
$env:PROJECT_ARCHIVE_ROUTER_PROBE = "0"
npm start
```

Сначала проверьте конфигурационный лог `mode=multipass inputMode=text transport=stream concurrency=1`; после этого отправляйте ZIP. Ожидаемые журнальные метки `text-multipass-start`, `ai-batch-start`, `preferred=stream`. При включённом `text` /files не используется.

Отдельные *платные* стадии получают `data/audit-jobs/<jobId>/stages/<stage>/{state.json,answer.txt,events.ndjson}`. Полностью завершённая стадия при повторном заходе в **тот же jobId с тем же inputSha256** считывается с диска без повторного POST. При наличии responseId предпринимается GET/poll этого же ответа. **Автоматический перезапуск всего прерванного MULTIPASS job после рестарта пока не реализован**: текущая startup recovery возобновляет готовую Telegram-доставку и single-shot, но не пересоздаёт весь MULTIPASS pipeline. При отсутствии responseId стадия блокируется как ambiguous для безопасного разбора. Не отправляйте заново большой ZIP в расчёте, что новый jobId переиспользует старые платные стадии.

`PROJECT_ARCHIVE_AMBIGUOUS_REPOST_LIMIT=1` разрешает неоднозначный повтор только если отдельно выставлено `PROJECT_ARCHIVE_ROUTER_IDEMPOTENCY_CONFIRMED=1` **после реальной проверки дедупликации POST роутером**. Иначе повтор блокируется. В text-stage повтор неоднозначной стадии блокируется независимо от настройки, если нет способа подтвердить исходный запрос.

Сетевой GET/poll по responseId для streaming-ответов зависит от возможностей совместимого роутера. Если retrieval не поддерживается, стадия сохраняется как прерванная; повторного платного POST не будет. Не считайте пройденные локальные тесты проверкой оплаты, роутера или Telegram.

Тесты: `npm run test:v188118`. Старый job `AUDIT-20260919112534-10957a0c` не изменяется.
