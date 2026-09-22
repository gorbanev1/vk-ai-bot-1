# V188.118 — сверка с дополнительным ТЗ

Ранее в V188.117 уже работали: text MULTIPASS при `PROJECT_ARCHIVE_INPUT_MODE=text`, stream без fallback, одиночная параллельность, локальный intake/ZIP validation, /files probe отдельно, Telegram outbox и прежний потоковый журнал.

Добавлено в этом выпуске: отдельный checkpoint каждого платного текстового этапа (пакеты, synthesis, final plan, patch) по input SHA-256; при повторном входе в тот же jobId завершённый этап читается с диска; responseId из stream сохраняется, известный responseId восстанавливается через GET/poll, неизвестный блокирует платный повтор; задан PROJECT_ARCHIVE_STREAM_IDLE_MS (100000 по умолчанию); telemetry callback не вызывает дополнительный failover; дополнительные runtime tests для stage journal/failover; исходящий итоговый ZIP проходит CRC перед помещением в outbox, временный файл fsync перед rename. Неоднозначные re-POST без явно подтверждённой поддержки идемпотентности отключены.

ОГРАНИЧЕНИЯ: автоматический restart всего прерванного MULTIPASS job отсутствует, recovery streaming responseId через GET зависит от роутера, полноценный mock end-to-end Telegram → Astra → ZIP и 10–15-минутный временной тест не добавлены. Не объявлять 100% выполнение большого ТЗ без этих проверок.
