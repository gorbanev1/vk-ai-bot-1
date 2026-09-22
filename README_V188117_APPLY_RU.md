# Установка V188.117 — текстовый MULTIPASS/stream

Это **снимок изменённых исходников поверх рабочей установки, не самодостаточный бот**.
В архиве отсутствует `src/index.js`. Сделайте резервную копию и распакуйте его
поверх работающего проекта без удаления локальных файлов, `data`, `.env`, job directories
и токенов. Старую неудачную задачу не нужно запускать повторно.

Остановите бота (`Ctrl+C`) и задайте в **том же окне PowerShell**:

```powershell
$env:PROJECT_ARCHIVE_INPUT_MODE = "text"
$env:PROJECT_ARCHIVE_AUDIT_MULTIPASS = "1"
$env:PROJECT_ARCHIVE_MULTIPASS_TRANSPORT = "stream"
$env:PROJECT_ARCHIVE_AUDIT_CONCURRENCY = "1"
$env:PROJECT_ARCHIVE_ROUTER_PROBE = "0"
npm start
```

Результат V188.117: `PROJECT_ARCHIVE_INPUT_MODE=text` выбирает MULTIPASS независимо
от значения `PROJECT_ARCHIVE_AUDIT_MULTIPASS`. Исходный ZIP сохраняется/проверяется локально,
Astra получает исходники текстовыми batch-запросами (никакого input_file и /files).
`PROJECT_ARCHIVE_MULTIPASS_TRANSPORT=stream` включает SSE для анализа пакетов,
сведения результатов и генерации патчей; одновременных платных запросов — не больше одного.
При отсутствии transport-переменной текстовый режим тоже выбирает stream.

До отправки ZIP проверьте при запуске строку `[PROJECT AUDIT CONFIG] mode=multipass inputMode=text transport=stream concurrency=1`.
Затем при отправке нового ZIP проверьте его `jobId`: в логах последовательно ищите `document-received`,
`source-persisted`, `archive-validated`, `source-files-filtered`, `mode=multipass`,
`text-multipass-start`, `ai-batch-start` и `AI RUNTIME TRANSPORT ... preferred=stream`.
Только после проверки выбранного режима повторно отправляйте проектный ZIP.
Каждый завершённый batch записывается в checkpoint на диск. **Полное возобновление
после перезапуска с пропуском оплаченных batch не гарантируется**.

Если `PROJECT_ARCHIVE_ROUTER_PROBE=1` остаётся включённым, обработчик отклонит
конфликтующие настройки до аудита: отключите probe, не пытайтесь использовать `/files`.
Обновление не подтверждает совместимость конкретного Astra/роутера и не запускает
реальный сетевой аудит при локальном тестировании.

Тесты: `node --test tests/ai/v188117TextMultipassStream.test.mjs`.
