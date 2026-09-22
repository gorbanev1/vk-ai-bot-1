# Gigorave V188.102 — Astra SSE stream + возврат файлов в Telegram

- Astra (`gpt-6-astra`) теперь всегда вызывается через Responses API с `stream: true` и читается как SSE (`response.output_text.delta` / `response.completed`). Старый transport-audit больше не может молча переключить Astra в non-stream.
- Для Astra-запросов из Telegram подключается встроенный `code_interpreter` с auto-container. Это позволяет модели реально создавать CSV/XLSX/PDF/ZIP/код/изображения и другие артефакты, когда они нужны для ответа.
- `container_file_citation` из ответа собираются из полного Responses payload/SSE events. По `container_id + file_id` бот скачивает точные байты через `/containers/{container_id}/files/{file_id}/content`.
- Созданные моделью файлы отправляются пользователю обратно как Telegram documents после текстового ответа, без перекодирования.
- File-only ответ допустим: если модель создала файл без текста, пользователю приходит `Готово.` и сам файл.
- Ограничение безопасности: до 10 файлов по 50 MB каждый; ошибки скачивания/Telegram upload не скрываются — пользователь получает предупреждение, а основной текстовый ответ не теряется.
- Входящие Telegram-файлы из V188.100 по-прежнему передаются модели как `input_file` / `input_image`; это совместимо с новым streaming-контуром.
