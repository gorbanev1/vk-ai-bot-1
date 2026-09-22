# Gigorave V188.92 — image metadata durability + hang fix

## Что исправлено

1. Любая автоматическая смена event poster теперь проходит строгую проверку metadata картинки против карточки: дата обязательна, затем содержательные identity-сигналы title/participants. Просто `poster=true` больше недостаточно.
2. Уже сохранённая metadata-совместимая source-картинка становится sticky и не заменяется другой картинкой галереи при reparse/merge/refresh.
3. Если у существующей source-картинки metadata отсутствует, автоматический reparse её сохраняет и помечает `metadata_pending_existing_poster`; generated `event_message_cards` этим иммунитетом не пользуются.
4. Добавлена явная owner-команда `тусы метаданные картинок` — CSV-ревью всех event-image metadata.
5. Добавлена явная owner-команда `тусы метаданные картинок заполнить` — Vision-backfill отсутствующих metadata, затем безопасная reconciliation event↔poster и CSV after-backfill. Owner-manual image не заменяется: для неё команда может только добавить metadata.
6. Vision metadata расширены: image type, poster flag/confidence, readability, title, date, time/start/end, venue, city/locality, address, participants, price, age, program, recognized text, reason.
7. Multi-announcement parsing теперь формирует последовательные date-led text blocks: блок с датой + весь текст до следующей даты. Vision/OCR metadata исключены из определения количества/границ карточек и работают только как последующая валидация изображения.
8. Legacy startup media repair V18883/V18885 больше не запускается автоматически. Import-time `backfillCleanLegacyPosterBindingsV18868()` удалён. Maintenance/backfill — только явной owner-командой.
9. User-facing анализ входящих картинок больше не проходит полный 120-second × 2 × all-model ladder. По умолчанию timeout одного кандидата 25 секунд, максимум 2 кандидата, одна попытка на mode, без эскалации в Terra/Sol для обычного OCR.
10. Сохранены предыдущие исправления V188.89–V188.91: CWT #9, owner-manual lock, VK 10–20 sec only, Telegram menu, operational-status false-positive.

## Команды

- `тусы метаданные картинок`
- `тусы метаданные картинок заполнить`
- существующая `тусы перепарсить ссылки` остаётся отдельной явной командой; никаких старых startup-reparse при запуске бота V188.92 не стартует.

## Проверки

Targeted regression set V188.89–V188.92: **17/17 PASS**.
