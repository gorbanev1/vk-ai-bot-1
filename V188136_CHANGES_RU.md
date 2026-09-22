# V188.136 (относительно V188.135)

1. `src/features/audit/aiResponseTrace.js` — новый raw byte HTTP trace для owner TXT, metadata, chunk timestamps, error cause, diagnosis JSON.
2. `src/app/botApplication.js` — включение trace для Responses/Chat Completion, SSE event/error classification, `response.incomplete`, исправление Telegram document message_id и stage `whole-file`.
3. `src/features/audit/astraTextTransportRetry.js` — передача trace request metadata и запись пути диагностики в обычный лог задания.
4. `src/features/audit/telegramTextJobControl.js` — сохранённый whole-file stage виден `/txt_status`.
5. `src/features/audit/astraTextResponseRecovery.js` — GET-only startup recovery для whole-file, защита от повторной неоднозначной отправки документа, корректный Telegram message_id.
6. `tests/ai/v188136AstraStreamForensics.test.mjs`, `package.json`, `src/shared/buildVersion.js` — тесты, команда и версия.

Сохраняются код V188.130–V188.135 и данные, созданные предыдущими версиями. Сторонний AI-роутер не модифицирован.
