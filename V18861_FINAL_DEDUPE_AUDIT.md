# V188.61 — аудит финального dedupe по присланной `bot.sqlite`

Проверка выполнялась read-only по `bot(5).sqlite + WAL + SHM`.

## Подтверждённая пара

`vk_chat_events.id=8`
- дата: 2026-09-19
- title: `NO PLACE FOR OLD PADS — выступление дуэта с электронной музыкой и гитарными риффами`
- source: `https://vk.ru/oldpads`
- картинка: `vk_chat_announcements/vk-chat-2000000022/244307104794401-1.jpg`

`vk_chat_events.id=15`
- дата: 2026-09-19
- time: 18:30
- title: `NO PLACE FOR OLD PADS — авторская ритмичная электронная музыка в тяжелых стилях`
- source: `https://vk.ru/wall-240648015_4`
- картинка: `vk_chat_announcements/vk-chat-2000000022/5075-1.jpg`

Семантика одна, но старый алгоритм не сливал карточки, потому что полный title similarity был недостаточно высоким, participants сильно различались, а у одной карточки не было времени.

## Новый deterministic result

V188.61: verdict `same`, reason `same-named-lead-calendar-rule`.

Защита от false merge:
- разные даты -> different;
- явный time conflict на одной дате -> different;
- Diesel Bar vs Diesel Hall -> different;
- same-title lead не переопределяет hard conflicts.

## Финал `парсер все`

После завершения всех source jobs выполняется final canonical reconcile. Persistent `event_dedupe_members`/`event_dedupe_groups` пересобираются; verified snapshot содержит одну объединённую карточку вместо дублей.
