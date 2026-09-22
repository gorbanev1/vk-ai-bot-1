# V188.135

- Удалён локальный abort after 3h/no bytes в `telegramTextJobControl.js` для owner-TXT; предупреждения и `/txt_stop` сохранены.
- Для TXT streaming POST отключён локальный idle watchdog и общий operation AbortSignal в `botApplication.js`; другие маршруты оставлены без изменения.
- Исправлен пропуск реальной `onActivity({bytes})` метрики в Responses TXT; теперь логируются сырые поступления байтов в обоих поддерживаемых текстовых streaming-API.
- Дополнен разбор SSE comment-only frames, отдельный журнал заголовков HTTP и комментариев; SSE комментарии не участвуют в тексте отчёта и не создаются на клиенте.
- В `/txt_status` появились `headersReceived`, `httpStatus`, `sseComments`, `bytes`; сохранён механизм неизвестного исхода без повторного платного POST.
- Добавлены тесты на отсутствие abort после суток тишины и выделение server SSE comments без примеси в модельный текст.
