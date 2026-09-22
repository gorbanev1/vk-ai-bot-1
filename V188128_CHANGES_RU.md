# V188.128 — что менялось

- `src/features/audit/astraTextAttachment.js`: proactive chunk preflight для больших TXT (>240 000 символов), 72 000 символов на фрагмент, последовательный анализ, метки исходного пути на границе фрагмента, сводка + все отчёты в одном TXT, строгий контекстный отказ `status=null` с числовыми лимитами.
- `src/features/audit/astraTextTransportRetry.js`: отчётное состояние для явно отклонённого контекста, защита от нового POST после получения любого фрагмента SSE. Не меняет существующие ограничения повторов при неизвестном результате.
- `src/app/botApplication.js`: честное начальное сообщение о частях, Telegram и консольный прогресс, выбранные ключом модель и reasoning остаются прежними.
- `src/shared/buildVersion.js`, `package.json`: версия V188.128.
- `tests/ai/v188121AstraTextAttachment.test.mjs`: проверка нового поведения большого файла, маршрута после 413, отказа status=null.
- `tests/ai/v188128ChunkPreflight.test.mjs`: отдельные регрессии обработки отказа Terra, запрета повторного POST при известном responseId и сохранения выбора Sol/max при разделении.

Ни SDK роутера, ни реальный API Telegram не проверялись вживую. Архив — overlay поверх V188.127, не содержит `.env`, SQLite, `data` или `node_modules`.
