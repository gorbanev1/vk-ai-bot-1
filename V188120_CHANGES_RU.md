# V188.120 — исправление ошибочной генерации Word вместо аудита ZIP

- `src/features/documents/documentRouting.js`: удалено неявное сопоставление «отчёт + файл + верни» → DOCX; запрет DOCX при явной команде Astra-аудита ZIP, даже если в тексте упоминается Word.
- `src/features/audit/projectArchiveIntent.js`: общий чистый предикат распознавания команды Astra и намерения проверить проектный ZIP.
- `src/platforms/telegram/telegramBot.js`: входящий документ/архив выходит из ожидающего Word-режима меню, исходная подпись сохраняется; форма меню документов не перехватывает следующий аудиторский ZIP.
- `src/app/botApplication.js`: при Astra-аудите с TXT/DOCX вместо ZIP или при запросе ZIP без приложения вернуть понятное сообщение до GPT/Word; при корректном ZIP прежний текстовый pipeline не меняется.
- `tests/ai/v188120ArchiveVsWordRouting.test.mjs`: 10 регрессионных тестов включая реальное выполнение раннего отказа обработчика Telegram-аудита с mock.
- `src/shared/buildVersion.js`, `package.json`: версия и новая тестовая команда.

Ограничения: проект представлен как patch-overlay, не автономный запуск; реальные сетевые запросы к Astra/Telegram в тестах не делались.
