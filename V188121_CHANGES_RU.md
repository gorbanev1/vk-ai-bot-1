# V188.121 — починен приём TXT/MD для Astra

Изменённые файлы относительно V188.120:
- `src/app/botApplication.js`: маршрутизация текстовых вложений до ZIP-аудита и Word; Telegram download → Astra stream → Telegram TXT; источник текста исключён из usage-логов нового маршрута.
- `src/features/audit/astraTextAttachment.js` (новый): строгий формат входа, приоритет намерения текстового анализа, UTF-8/лимиты, отдельный проверяемый workflow.
- `src/shared/buildVersion.js`, `package.json`: версия V188.121.
- `tests/ai/v188121AstraTextAttachment.test.mjs` (новый): маршруты, декодирование и mock/runtime поведение.
- `README_V188121_APPLY_RU.md` (новый): применение, ограничения и проверка.

Ветка текстового ZIP MULTIPASS V188.120 не заменена. Реальные Telegram и Astra запросы не выполнялись.
