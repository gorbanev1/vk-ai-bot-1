# Изменения V188.133

1. `src/platforms/telegram/telegramLongReply.js` + адаптер и streaming-сессия: сохранение всех частей большого ответа Telegram, Unicode/whitespace-safe разделение, защита от повтора уже доставленного текста, полноценный TXT-резерв при сбое доставки потока.
2. `src/features/diagnostics/cloudflareProbe.js`: ранняя owner-DM-команда `/cfprobe`, реальный учёт момента поступления HTTP-байтов и SSE-комментариев, безопасные режимы, явный платный live-запрос, отдельный текстовый лог с автоматической отправкой владельцу.
3. `src/features/diagnostics/cloudflareProbeModes.js`: необязательные экспериментальные test-origin режимы streaming тела POST, H2 ping, WS application ping/pong и create-then-GET async. Не используются для обычного AI-ответа и не объявляются решением проблемы heartbeat.
4. `tests/platforms/v188132TelegramLongReply.test.mjs` и `v188133CloudflareProbe.test.mjs`: регрессионные проверки без реальных платных вызовов.
5. Остальная цепочка событий, слепка, Astra TXT и безопасность повторных AI POST не переделываются этой версией. V188.133 — накопительный патч от исходной V188.128.
