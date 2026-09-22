# Gigorave V188.85 — точечный патч афиш

## Что исправлено

- Выдача больше не считает уже подтверждённую Vision-афишу «плохой» только из-за размера. После `exact_poster_match` проверяются provenance и реальное наличие файла; низкий размер остаётся лишь ранним фильтром совсем мелкого UI.
- Startup repair запускается под новым migration key и восстанавливает реальную афишу по сохранённому `posterImageIndex`, если файл источника существует. Неподтверждённый локальный файл больше не блокирует repair.
- Если реальную афишу после существующих контуров доказать нельзя, годное событие сохраняется и получает детерминированную generated cover; уже подтверждённая настоящая афиша всегда приоритетнее fallback.
- Исправлено чтение Vision-фактов: пустое `Место:` больше не захватывает следующую строку `Участники:`.
- Скачанные media-файлы immutable: существующий путь никогда не перезаписывается другими байтами; при коллизии создаётся hash-qualified filename.
- Multi-event VK binding остаётся строгим `[IMAGE N] -> event`; одна афиша не раздаётся нескольким дочерним событиям без доказанного соответствия.
- Exact DOM pass использует immutable HTML как источник структуры/текста; live `currentSrc` может заменить snapshot URL только при той же стабильной photo identity / attachment key. Посторонние live-картинки в exact-набор не добавляются.
- Полный DOM forensic snapshot дополнен `*.dom-state.json`: `currentSrc`, `src`, `srcset`, размеры, rect/visibility, attributes, ownership post/message, backgrounds, доступные iframe HTML/images, open shadow DOM, SHA-256 связи с HTML. Progressive snapshots сохраняются по ходу обхода.
- QTickets detail хранит одну авторитетную картинку (JSON-LD/OG в приоритете), без хвоста галереи/рекламного баннера. Startup migration обрезает старые QTickets `image_paths_json` до первой уже привязанной картинки, не меняя её.
- QTickets listing восстанавливает canonical numeric detail links даже вне старого `<li class="item">`.
- Exact-source dedupe дополнен инвариантом canonical source URL + дата + identity, чтобы 1:1 карточки одного физического поста не возвращались из-за разных `screenName`/источников.

## Первый запуск

- Перестраивает deterministic dedupe registry.
- Выполняет V188.85 four-contour media repair один раз под новым marker `events-v18885-four-contour-media-repair-v2`.
- Восстанавливает сохранённые exact poster bindings, включая случаи, когда старый generated fallback отсутствует, но исходный indexed media-файл существует.
- Не заменяет уже рабочую provenance-safe реальную афишу generated cover.
- Чистит QTickets multi-image binding до одного первого уже рабочего постера.

## Проверка сборки

- `npm test`: 158/158 active tests passed.
- V188.85 regression suite: 7/7 passed.
- `npm run check:syntax`: 503 files OK.
- `npm run check:named-imports`: OK.
- `npm run check:imports`: OK.
- `npm run check:release-clean`: OK.

## Изменённые файлы относительно V188.84

- `src/app/botApplication.js`
- `src/features/events/eventAssets.js`
- `src/features/events/eventPosterMatching.js`
- `src/features/events/qticketsParser.js`
- `src/features/events/vkCapturedMediaMerge.js`
- `src/features/scrapers/manualParserDiagnostics.js`
- `src/infrastructure/database/index.js`
- `src/platforms/qtickets/qticketsScraper.js`
- `src/platforms/vk/vkChatEventScraper.js`
- `src/platforms/vk/vkPublicScraper.js`
- `src/shared/buildVersion.js`
- `package.json`
- `CODE_ONLY_README_RU.md`
- новый тест `tests/events/v18885PosterDomOutputRepair.test.mjs`
