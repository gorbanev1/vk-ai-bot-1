# Gigorave V188.66 — safety / command / clean-parser hardening

## Зачем релиз

V188.66 закрывает четыре высокоприоритетные проблемы, найденные полным аудитом V188.65: риск записи тестов в рабочую SQLite, потерю нового item после прерывания `парсер все чисто`, поглощение реальных команд Telegram незавершённым menu-mode и неполное соблюдение обещания «служебные команды владельца — только в ЛС».

## 1. Тесты больше не должны касаться рабочей `data/bot.sqlite`

- Основная SQLite поддерживает `GIGORAVE_DB_PATH` / `BOT_DB_PATH` и `GIGORAVE_DATA_DIR`.
- В test-процессе открытие production `data/bot.sqlite` без явной изоляции аварийно запрещено.
- Guard распознаёт `NODE_ENV=test`, Node test-runner и запуск файлов из `tests/`.
- `scripts/run-test-isolated.mjs` создаёт временные `data/` и state DB.
- `npm test` / `npm run test:active` используют только temp runtime data.
- Исторический полный набор сохранён как `npm run test:legacy`; каждый legacy test также запускается на отдельной temp DB.
- `npm run verify` теперь включает active tests и release runtime-data guard.

## 2. `парсер все чисто` стал crash-safe

`manual_parser_seen_items` теперь хранит:

- `attempt_count`;
- `processed_at`;
- `last_error`;
- `last_run_id`;
- состояния `captured`, `processing`, `failed_retryable`, `processed_event`, `processed_not_event`, `processed_rejected`, `processed_existing`.

Clean-mode пропускает только финально обработанные записи. Если процесс умер после capture/во время AI, item остаётся retryable и на следующем `парсер все чисто` будет обработан снова. Старые мигрированные `event` / `not_event` считаются финальными legacy-status.

## 3. Telegram pending-mode больше не должен съедать команды

Удалён огромный вручную поддерживаемый regex `TELEGRAM_EXPLICIT_NON_IMAGE_COMMAND`. Добавлен общий detector `features/routing/explicitApplicationCommand.js`, который переиспользует реальные command parsers/router.

Проверены команды в pending `image`, `image_edit`, `document_*`, `propose_event`, `add_event`, включая:

- `резюмируй за неделю`;
- `досье` / `полное досье`;
- `кто вышел сегодня`;
- `подтяни историю 2 дня`;
- `лс участникам ...`;
- event moderation (`проверить тусы на совпадения`, `вернуть тусу`, `чёрный список тус`);
- provider/model audits;
- `создай pdf ...`;
- `парсер все чисто`;
- `лимиты сбросить`.

Явная команда генерации картинки (`рисуй ...`, `нарисуй ...`) в image-mode по-прежнему остаётся image-командой и не ломает режим.

## 4. Служебные команды владельца действительно ограничены ЛС

Добавлена единая policy `requireOwnerDm()` и применена к:

- manual parser/reparse/source management;
- ручному owner-add/update события;
- provider/API/model diagnostics;
- Telegram diagnostics;
- routing audit / explain;
- rate-limit reset;
- остановке ручных VK-chat parsers.

Групповые owner-функции, которым по смыслу нужна конкретная беседа (например membership/history fast-path), не были глобально запрещены.

## Дополнительно

- VK owner ID теперь можно переопределить через `VK_OWNER_USER_ID` или `BOT_OWNER_VK_ID`; старое значение оставлено как backward-compatible fallback.
- Одноразовая Telegram-кнопка благодарности за событие больше не отображается бесконечно после августа 2026.
- `playwright` закреплён на `1.62.0` вместо `latest` (lock уже использовал 1.62.0).
- `parseEventModerationCommand` вынесен в отдельный routing-module и переиспользуется Telegram detector.

## Проверки

- `npm run test:v18866` — 34/34 PASS.
- `npm run test:active` — 58/58 PASS.
- `check:syntax` — PASS.
- `check:imports` — PASS.
- `check:named-imports` — PASS.
- `check:docs` — PASS.
- `check:release-clean` — PASS.
- Миграция проверена на копии пользовательской SQLite+WAL/SHM: `PRAGMA quick_check = ok`, 581 legacy ledger rows сохранены, новые колонки добавлены.

## Команды тестирования

- `npm test` — поддерживаемый active release gate.
- `npm run test:legacy` — весь исторический набор; нужен для анализа backward-compatibility, но не является release gate.
- `npm run verify` — syntax/import/docs + active tests + release-data guard.
