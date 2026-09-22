V188.124 по отношению к V188.123:
- Новый src/features/audit/astraTextTransportRetry.js: ограниченные последовательные попытки TXT, стабильный логический и idempotency ключ, durable state/partial/full answer, явная фиксация риска двойной оплаты, блокирование повтора при известном responseId.
- src/features/audit/astraTextAttachment.js: общий wrapper для полного запроса, частей и synthesis; полноразмерный запрос первым, деление только после явного отказа по размеру.
- src/app/botApplication.js: запрет вложенных credential retry и чужого контекста для TXT, один credential, исправленная трактовка явно отклонённого большого payload, строгая проверка завершения SSE для TXT.
- tests/ai/v188124AstraTextRetry.test.mjs: 5 поведенческих регрессий; обновлён тест opt-out для старой безопасной политики.
- Не менялись VK history recovery, event DB, project ZIP-audit pipeline, Word, Telegram outbox.
