# V188.104 — Astra project ZIP audit + safe AI correlation

Дата: 2026-09-18

## Что исправлено

- ZIP проекта из Telegram больше не отправляется модели как непрозрачный `application/octet-stream`.
- Владелец в ЛС может отправить ZIP с подписью `astra max аудит ...`; бот безопасно разбирает ZIP локально, исключает `.env*`, базы, `node_modules`, runtime/data, cookies и browser profiles, строит manifest и пакетно передаёт исходники Astra.
- Astra сначала делает batch-аудит, затем сводный план, после чего для каждого выбранного файла возвращает структурированные точные `old -> new` edits с SHA-256 исходника. Бот применяет только уникальные совпадения и откатывает изменения, не прошедшие статическую проверку JS/JSON.
- Исходный архив пересобирается с сохранением непереданных модели файлов и получает `ASTRA_AUDIT_REPORT.md` + `ASTRA_AUDIT_MANIFEST.json`, затем ZIP отправляется обратно в Telegram.
- Во время долгого аудита Telegram получает сообщения о стадиях и прогрессе batch-анализа.
- Reasoning-only/пустой ответ Responses помечается `EMPTY_MODEL_TEXT`, считается retryable и продолжает same-model transport/failover вместо общего падения.
- Для `high/xhigh/max` введён минимальный `max_output_tokens` budget (Astra/max: 8000), чтобы скрытый reasoning не съедал весь лимит и не оставлял `text_tokens=0`.
- Добавлен `requestId` в AsyncLocalStorage входящего GPT-запроса, failover-логи и Telegram handler error для корреляции параллельных VK/Telegram запросов.
- Убран eager media/vision pre-route анализ: OCR/vision запускается только маршрутом, которому реально нужен media context.
- Unknown-term classifier теперь получает только сырой пользовательский текст и не видит внутренние markers `message_text_begin`, `reply_target_*`, `peer_index` и т.п.

## Команда

Отправить владельцу бота в Telegram ЛС ZIP с caption:

```text
astra max аудит полный проекта: найди дефекты, исправь безопасно и верни патченный архив
```

## Безопасность

Автоматически не выполняются package scripts или тестовые команды из присланного архива. Для изменённых `.js/.mjs/.cjs` выполняется только `node --check`, для `.json` — `JSON.parse`.
