# V188.96 — доставка афиш во VK без тихой потери картинки

## Подтверждённая причина

В operation log 17.09 для запроса «Гигорейв тусы в котельной сегодня» зафиксирован реальный сбой VK upload:
`Code №100 - One of the parameters specified was missing or invalid: photo is undefined` внутри `vk.upload.messagePhoto` / `photos.saveMessagesPhoto`.
Telegram при этом использует локальный файл напрямую как photo attachment и не проходит этот VK upload contour.

## Изменения

1. Для event poster VK сначала используется прямой multipart `photos.getMessagesUploadServer -> POST -> photos.saveMessagesPhoto`.
2. Прямой upload повторяется до трёх раз с новым upload server; между попытками 450 и 1250 мс.
3. После первой неудачи остаётся `vk-io` buffer fallback.
4. Ошибка event-poster upload больше не превращается молча в текстовую карточку без картинки.
5. Если в БД есть подтверждённая source-афиша, а VK transport не принял её после повторов, карточка временно удерживается и пользователю выводится один общий warning; остальные события выдачи продолжают отправляться.
6. События, у которых подтверждённой афиши действительно нет, по-прежнему могут выводиться текстом.

## Отдельная ошибка из новых логов

Входящие картинки из VK скачиваются нормально, но несколько OCR/Vision операций 18.09 падают после `gpt-5.4-mini` timeout и затем `AI_CREDENTIAL_QUARANTINED`. Например операция `mu6obmh9-895a1507`: download-success (JPEG 1116x793), затем vision/ocr fail из-за карантина AI provider. Это отдельный контур и не является причиной отсутствия event poster во VK.
