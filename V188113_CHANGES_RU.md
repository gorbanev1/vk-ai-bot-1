# V188.113 — аварийная правка приёма ZIP из Telegram

## Причина

После `[PROJECT AUDIT STAGE] stage=document-received` V188.112 выбрасывала `ReferenceError: contentEncoding is not defined` в `downloadTelegramFileToPath`: проверка итогового размера использовала переменную, объявленную только в другой функции `downloadTelegramFileBuffer`. Из-за этого любой успешно скачанный ZIP с `Content-Length > 0` падал до ZIP-валидации и до платного Astra inference.

## Что сделано

- `src/app/botApplication.js`: в `downloadTelegramFileToPath` локально считывается `Content-Encoding` и корректно сравнивается фактический размер с `Content-Length` для identity. HTTP 206 отклоняется до записи файла; проверка максимального размера защищена для случаев прозрачного декодирования.
- В `downloadTelegramFileBuffer` добавлена такая же проверка фактической длины: ошибка `TELEGRAM_PARTIAL_DOWNLOAD` и retry только скачивания.
- `tests/ai/v188113TelegramArchiveDownload.test.mjs`: поведенческие тесты с mock HTTP, реальной записью `.part`/rename и SHA-256, отклонением усечённого ответа, повтором только скачивания и обработкой `Content-Encoding`.

## Эксплуатация

Заменить запущенную V188.112 на V188.113, затем **повторно отправить исходный ZIP как документ с подписью/командой аудита в одном сообщении**. Старый Telegram update уже мог быть подтверждён; ожидать его повторной обработки без новой отправки не стоит. В приведённом логе нет признаков, что Astra inference по этому ZIP вообще начался. Другие ранее известные ограничения router/Telegram этой узкой правкой не менялись.
