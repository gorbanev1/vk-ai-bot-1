# Gigorave V188.78 — three-contour immutable parser / secondary party pool

Сборка по handoff от 2026-09-15.

## Что изменено

- VK public и VK chats: exact → structural/fuzzy → heuristic работают по одному immutable DOM snapshot после завершения capture/lazy-media этапа.
- Полные `*.dom.html` сохраняются без обрезки с URL/source/timestamp/bytes/SHA-256; parser report содержит доказательство `sameSnapshotForAllThreeContours`.
- Автоматический VK reload при 0 posts/ошибке/недогрузе ограничен и выполняется только после ожидания минимум 10 секунд; CAPTCHA/login не превращаются в reload-loop.
- DOM/media audit расширен: tag/id/class/all attributes/data-*/href/alt/title/aria/selector/path/ancestor chain/sibling/document position/nearby text/full outerHTML; сохраняется photo-id и media origin/repost depth.
- Poster matching остаётся image × child-event и fail-closed: одна афиша не раздаётся нескольким child events без подтверждения; несколько подтверждённых афиш одного merged event сохраняются вместе.
- Одноразовый startup poster repair V188.77 сохранён: marker ставится только после полного успешного прохода.
- Финальный dedupe `парсер все` выполняется раздельно для primary и secondary pool, затем строится verified snapshot. Diesel Bar и Diesel Hall остаются жёстко различными; обычные `Бар X`/`Клуб X` сравниваются по venue core.
- Добавлен полностью отдельный пул `Второстепенные / быдлячьи тусы`, отдельное Telegram-меню и команды добавления источников.
- Начальный secondary registry: 26 VK/TG источников из handoff; для secondary источников `initialCount=10`, stagger 10–20 секунд, progressive DOM snapshots и lifetime вкладки не менее 180 секунд.
- Browser/page ownership остаётся source-local: ошибка/закрытие одной вкладки не должна завершать остальные источники; уже захваченный raw-cache сохраняется.
- Финальный отчёт `парсер все` теперь включает loaded/reloaded/failed sources, DOM snapshots, exact/structural/heuristic counts, created/updated events, vision checked images, poster accepted/rejected, final dedupe merges и posterless breakdown (`no source media`, `ordinary photo only`, `vision mismatch`, `source failed`, `ambiguous multi-event`).

## Команды secondary pool

- `тусы быдлячьи добавить источник <url>` — каноническая команда.
- `тусы второстепенные добавить источник <url>` — алиас.
- `быдлячьи тусы парсер все` — отдельный parser-all secondary pool.

## Версия

- package: `0.188.78`
- build: `events-v18878-three-contour-secondary-pool-r1`
