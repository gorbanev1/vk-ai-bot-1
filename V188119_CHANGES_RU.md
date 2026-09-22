# V188.119 — defaults текстового маршрута

Основа: V188.118 TEXT MULTIPASS DURABLE. Исправлено `inputMode=auto transport=auto` при отсутствии env: теперь text + stream — значения по умолчанию; `auto` и неизвестные значения input также переводятся в text, даже если старый toggle multipass выключен. Для text режима устаревшее background/auto транспорта не влияет на выбор SSE. File SINGLE-SHOT оставлен только при явном `inputMode=file` и не предназначен для текущего роутера.

В лог `text-multipass-start` добавлены `batches`, `inputMode`; в лог каждого batch — `transport`; Telegram-уведомление теперь поясняет, что исходный ZIP не загружается через `/files`. Усилены проверки записи общего checkpoint после начала аудита и после каждого завершённого batch; batch checkpoint дополнен `stage`, `status=completed`, `completedAt`. Существующие per-stage журналы с inputSha256 и responseId сохранены без переписывания.

Добавлен исполняемый тест конфигурации на разных сочетаниях env, обновлён тест V188.117 и добавлена команда `test:v188119`. Новые default и локальный mock НЕ являются доказательством успешной длительной сессии на роутере, полного resume job или Telegram end-to-end.
