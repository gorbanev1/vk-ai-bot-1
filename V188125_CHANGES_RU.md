# V188.125 — Text Responses GET recovery

Основа — исходники V188.124 с сохранением изменений VK событий из V188.123.

* Новый `src/features/audit/astraTextResponseRecovery.js`: долговременная запись адресата TXT, поиск прерванных заданий, GET/poll только по сохранённому ID, локальное сохранение ответа, Telegram TXT доставка, журнал статуса; одноразовая миграция указанного пользователем ID из V188.124.
* `src/app/botApplication.js`: запуск восстановления ПОСЛЕ подключения Telegram, использование исходного compat API-key старой Astra сессии, GPT-5.6 Terra по умолчанию для НОВЫХ TXT/MD, GPT-5.5 по явному выбору; ZIP-аудит по-прежнему Astra. Нет повторного платного POST при восстановлении.
* `src/features/audit/astraTextAttachment.js`: передача стабильного jobId и маршрутизация явной GPT-5.6 Terra команды.
* `src/features/audit/astraTextTransportRetry.js`: сохраняет endpoint и имя ключа из metadata вместе с responseId, будущие восстановления получают тот же провайдерский контекст.
* `tests/ai/v188125TextRecovery.test.mjs`: модельный GET/Telegram delivery, HTTP 404 и защита от повторной отправки, адресаты новых заданий.

43 профильных теста пройдены локально; живой роутер и Telegram не проверены.
