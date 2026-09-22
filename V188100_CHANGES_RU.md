# Gigorave V188.100 — файлы Telegram → непосредственно в AI-модель

## Что исправлено

До V188.100 произвольный `message.document` без подписи мог вообще не попасть из Telegram long-poll в обработчик: входной gate считал значимыми только текст, caption, image-document/photo и voice. Даже когда документ имел caption и сообщение доходило до GPT-маршрута, байты документа не попадали в основной запрос к модели: модель видела только текст и отдельно собранный image/OCR-контекст.

V188.100 добавляет отдельный контур model file input для **файлов, приложенных к текущему Telegram-сообщению**:

- `message.document` теперь является полноценным входным событием даже без caption;
- лучшая версия `message.photo` и `message.document` описываются как model-input descriptors;
- файл скачивается через Telegram `getFile` только когда запрос действительно доходит до обычного GPT-ответа;
- скачивание кэшируется внутри `AsyncLocalStorage` одного входящего сообщения, поэтому retry/failover не качает Telegram-файл заново;
- для запроса с вложениями используется OpenAI Responses API: изображения передаются как `input_image`, остальные Telegram documents — как `input_file` с `filename` и inline base64 `file_data`;
- запрос без вложения остаётся на прежнем `/chat/completions` transport;
- file-only сообщение в ЛС (или файл в группе, отправленный ответом боту) получает нейтральный default prompt «проанализируй прикреплённый файл…» и больше не теряется на `if (!text) return`; неадресованные файлы в группах по-прежнему не запускают GPT;
- действует жёсткий лимит 50 MB на один файл и 50 MB суммарно на один модельный запрос;
- в token-usage metadata пишутся только имя/MIME/размер входного файла, не его содержимое.

## Совместимость с V188.92–V188.99

Этот патч **не меняет event/poster pipeline**. В частности:

- V188.92 Vision metadata/backfill и запрет startup-backfill остаются как были;
- V188.97/V188.98 owner correction/replacement flow не ослабляется;
- V188.99 strict poster metadata gate, exact image-path binding, canonical dedupe и metadata-ranked poster selection не меняются;
- специальные event/proposal/QR/image-edit handlers по-прежнему выполняются раньше generic file-only GPT route. Если такой handler забрал сообщение, вложение не дублируется в обычный GPT-чат.

## Transport

`/responses` используется только когда в обычный GPT-ответ реально передаётся Telegram attachment. Это нужно для first-class `input_file` на PDF/документах/таблицах/текстовых и code-файлах. Для изображений используется `input_image`. Без Telegram attachment транспорт V188.99 не меняется.

Если OpenAI-compatible provider не поддерживает `/responses`, ошибка file-input transport считается retryable для capability/model failover на следующую доступную credential/model. Файл при этом не выбрасывается и не заменяется молча одним текстом.

## Тесты

Добавлен `tests/ai/v188100TelegramModelFileInput.test.mjs`, который фиксирует:

1. document-only Telegram update не отбрасывается;
2. адресованный file-only message входит в обычный GPT route без обхода group/session gating;
3. загрузка идёт через Telegram `getFile`/`buildFileUrl` и кэшируется на запрос;
4. вложения реально входят в GPT request options;
5. payload содержит first-class `input_file`/`input_image` и идёт в `/responses`;
6. text-only запросы по-прежнему идут через `/chat/completions`.
