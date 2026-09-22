# Gigorave V188.108 — оптимальный Astra one-shot + целостная доставка ZIP через Telegram

## Задача релиза

V188.106 хорошо восстанавливался после 524, но делал дорогой MULTIPASS по умолчанию. V188.107 вернул финансово безопасный SINGLE-SHOT и убрал 15-секундный timeout `sendDocument`. V188.108 объединяет сильные стороны обоих подходов и добавляет контроль целостности файла на всём пути: Telegram → ZIP parser → Astra → container artifact → локальный outbox → Telegram.

## Astra

- По умолчанию по-прежнему **один ZIP = один платный Astra inference**. MULTIPASS включается только `PROJECT_ARCHIVE_AUDIT_MULTIPASS=1`.
- Новый `PROJECT_ARCHIVE_SINGLE_TRANSPORT=auto|background|stream`, default `auto`.
- `auto` сначала использует Responses `background=true`: после создания `response_id` временные 429/5xx/524/сетевые ошибки polling не запускают новый inference — бот продолжает читать тот же job.
- Если compatible router сразу сообщает, что background Responses не поддерживаются, `auto` один раз переходит на SSE stream. Это capability fallback, а не повтор уже запущенного inference.
- `stream` остаётся полноценным режимом: активность SSE/NDJSON сбрасывает idle-watchdog; короткого 15-минутного wall-clock timeout нет.
- Для project-audit запрещён автоматический stream → non-stream fallback.
- Background polling использует общий supervised ceiling project job (default 24 часа), а не старые 45 минут.
- `PROJECT_ARCHIVE_SINGLE_MAX_OUTPUT_TOKENS` default 64000: Astra max получает достаточный reasoning/output budget и не обрезается прежними 16000 tokens.
- Cost guard `PROJECT_ARCHIVE_SINGLE_MAX_CHARS` сохранён: большой случайный полный проект не превращается автоматически в десятки дорогих вызовов.

## Telegram: приём файлов

- Старый жёсткий лимит 50 MB заменён конфигурируемыми пределами:
  - `TELEGRAM_MODEL_FILE_MAX_MB`, default 256 MB;
  - `TELEGRAM_MODEL_FILES_MAX_TOTAL_MB`, default 512 MB.
- Скачать документ теперь можно медленно: вместо абсолютных 60 секунд используется idle-watchdog (default 10 минут без единого принятого байта).
- `getFile` и скачивание bytes имеют до 5 восстановительных попыток на network/429/5xx/timeout.
- `TELEGRAM_BOT_API_BASE_URL` и `TELEGRAM_BOT_FILE_BASE_URL` позволяют использовать локальный Telegram Bot API endpoint, если нужны лимиты/скорость выше публичного `api.telegram.org`.

## ZIP integrity

Перед дорогим Astra-вызовом архив теперь полностью проверяется:

- central directory и local headers;
- path traversal/absolute paths;
- duplicate paths;
- совпадение имени файла в local header и central directory;
- uncompressed size;
- **CRC32 каждого файла**.

То же самое выполняется для итогового ZIP перед отправкой пользователю.

## Astra generated artifacts

- Лимит relay увеличен с 50 MB до конфигурируемого `OPENAI_RESPONSE_ARTIFACT_MAX_MB` (default 256 MB).
- Artifact скачивается потоково с idle-watchdog и до 5 retry на transient failure.
- Если artifact заявлен как ZIP, он полностью распаковывается в память по безопасным лимитам и проходит CRC-проверку до Telegram delivery.
- Если Astra вместо одного ZIP вернула текст, один не-ZIP файл или несколько файлов, результат **не теряется**: бот автоматически заворачивает всё в один `*_ASTRA_RESULT.zip` вместе с `ASTRA_RESPONSE.md` и `ARTIFACT_FAILURES.json`.

## Telegram: выдача результата

- `sendDocument` не наследует общий 15-секундный API timeout.
- До 8 попыток (`TELEGRAM_DOCUMENT_SEND_MAX_ATTEMPTS`) на network/429/5xx.
- На каждой попытке создаётся новый `FormData`; consumed multipart body не переиспользуется.
- После успешного Telegram ответа сравнивается `document.file_size` с локальным размером файла.
- Перед первой отправкой итоговый ZIP сохраняется в `data/audit-jobs/<jobId>/outbox/` и получает SHA-256.
- Если Telegram delivery всё же не удалась из-за внешней сети/API, файл остаётся на диске, а `state.json` получает `status=delivery-failed`, `localOutputPath`, размер и SHA-256. Готовый результат не пропадает и Astra повторно вызывать не требуется.
- Пользователю всегда возвращается **один итоговый ZIP**.

## Важное ограничение

Код убирает внутренние короткие таймауты и искусственный 50-MB envelope, но не может отменить hard limits самого Telegram/cloud proxy/провайдера. Для очень больших файлов предусмотрена работа через настраиваемый локальный Telegram Bot API endpoint. Даже при внешнем сбое Astra-результат сохраняется в durable outbox и не требует повторной платной генерации.
