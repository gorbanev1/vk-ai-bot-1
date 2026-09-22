# Gigorave V188.103 — общий streaming transport + progressive Telegram

## Что изменено

1. Убран специальный транспортный инвариант «только Astra всегда stream». Теперь одна политика применяется ко всем текстовым моделям OpenAI-compatible ladder.
2. Все модели имеют два режима транспорта: stream и non-stream. Для `high`, `xhigh`, `max` stream имеет приоритет. Для остальных уровней используется runtime/env preference.
3. При технической ошибке до первого delta выполняется один same-model fallback на противоположный транспорт. Это происходит до переключения ключа/провайдера.
4. Если stream уже показал пользователю текст, автоматический failover генерации останавливается, чтобы не смешать начало одного ответа с продолжением другого.
5. В Responses API обрабатываются `response.output_text.delta`, а в Chat Completions — обычные incremental deltas; оба контура передают текст в единый callback `onTextDelta`.
6. Telegram теперь умеет `editMessageText` и `deleteMessage`. Ответ появляется постепенно и обновляется с throttling.
7. Для длинных ответов создаются дополнительные Telegram-сообщения. При финализации старые лишние stream-chunks удаляются, а существующие редактируются до итогового текста.
8. Повторная pro/astrology генерация сбрасывает stream buffer перед новым ответом.
9. Возврат файлов из V188.102 сохранён: generated artifacts отправляются после итогового текста.

## Проверки

- syntax check `botApplication.js` — OK;
- syntax check `telegramBot.js` — OK;
- V188.100–V188.103 AI regression tests — 21/21.
