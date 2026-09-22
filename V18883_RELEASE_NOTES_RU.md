# Gigorave V188.83 — финальная сборка парсинга

Ключевые изменения:

- VK public/VK chat: трёхконтурный DOM-разбор сохранён и усилен: exact -> adaptive/structural -> heuristic.
- Автоматический reload не срабатывает на здоровой странице только из-за нулевого exact-result; наличие scroll/DOM-прогресса считается признаком загрузки. Перед реальным reload действует задержка 10–15 секунд.
- Все конечные parser-tabs живут не менее 180 секунд.
- Парсер `все` запускает независимые источники ближе к параллельному режиму; poster/image gate использует отдельный параллелизм изображений.
- Исправлены ложные даты и пограничные даты: адрес `ул. 9 Января`, `Версия 2.10`, `Скидка 11-11`, ISO, относительные даты, диапазоны, rollover года и поздние VK timestamps.
- Single-event пост сохраняет всю релевантную галерею; до 10 изображений события выдаются единым Telegram media group с подписью события на первом media.
- Vision-факты изображений сохраняются и используются для повторного сопоставления.
- Добавлен четвёртый media-контур для события без картинки: сохранённые media исходника -> строгий матч по сохранённым vision-метаданным -> повторный source DOM exact/adaptive/heuristic + vision -> сгенерированная карточка только если реального media не найдено.
- Первый запуск V188.83 выполняет one-time repair будущих событий и media; известные тестовые V103/2099 записи переводятся в `ignored`.
- QTickets: отдельные команда и Telegram-кнопка, отдельный физический SQLite `data/qtickets.sqlite`; обычный event-dedupe не видит QTickets. Поддерживается до 10 изображений события.
- Порог clean-mode 97% не изменён.

Проверки финальной сборки:

- `npm run check:syntax` — OK (502 файла)
- `npm run check:imports` — OK
- `npm run check:named-imports` — OK
- `npm test` — 158/158 OK
- `npm run test:qtickets` — 8/8 OK
- targeted parser/media/startup tests — 18/18 OK
- startup-миграции проверены на копии предоставленной SQLite+WAL: `PRAGMA integrity_check = ok`
- QTickets DB isolation проверена: в основной БД `qtickets_events` отсутствует, в отдельной `qtickets.sqlite` присутствует.
