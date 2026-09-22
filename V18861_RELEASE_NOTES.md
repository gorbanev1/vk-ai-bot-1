# Gigorave V188.61 — parser-all poster repair + final cross-post dedupe

## Что исправлено

### 1. `парсер все` теперь заканчивается явным финальным dedupe/reconcile

После capture/AI/media processing обязательно выполняется `rebuildVerifiedPartySnapshotQueued()` и пересобирается persistent `event_dedupe_registry`. В trace добавлены стадии:

- `run.final-dedupe.start`
- `run.final-dedupe.complete`

В финальном сообщении отдельно показываются canonical count, merge count, dedupe groups и duplicate members.

Raw event-строки не удаляются: они остаются evidence. Пользовательская выдача и verified snapshot используют объединённую canonical card.

### 2. Исправлен конкретный дубль NO PLACE FOR OLD PADS

В присланной БД реально есть две карточки одного события 19.09.2026:

- `vk_chat_events.id=15`: полный анонс с временем 18:30, ценой 500 и афишей; source `wall-240648015_4`;
- `vk_chat_events.id=8`: тизер/описание дуэта без времени; source `vk.ru/oldpads`.

Старый deep-dedupe давал только ~0.50 title similarity из-за разных поясняющих хвостов после длинного тире и оставлял две карточки.

V188.61 выделяет устойчивое именованное начало заголовка (`NO PLACE FOR OLD PADS`) и на одной календарной дате считает его strong identity anchor. Явный конфликт времени или площадки по-прежнему запрещает merge.

После merge сохраняются:

- лучшее название/время/площадка;
- объединённый состав участников;
- объединённые описания;
- обе source URL в `mergedSources`;
- media evidence обеих карточек;
- обе `_dedupeRefs`, поэтому persistent registry скрывает duplicate row.

### 3. Сохранены media/poster fixes V188.60/V188.61

- `ava=1`, audio/UI/tiny images отбрасываются;
- DB-known VK posts перепроверяются в `парсер все`;
- stored clean source URLs используются как repair fallback;
- multi-announcement Diesel digest разбирается в несколько событий;
- AI не может схлопнуть более богатый deterministic multi-event parse;
- poster/text AI timeout имеет floor 60 секунд.

## Forensic preview на присланной БД

Read-only deterministic preview по будущим raw events: 49 raw -> 41 canonical, 8 merges. Среди найденных merge есть именно пара `NO PLACE FOR OLD PADS` из двух разных постов.

Это preview по snapshot пользователя; V188.61 ничего не меняяет в присланном файле автоматически. Реальный `парсер все` пересоберёт registry/snapshot уже на рабочей DB.

## Тесты

- `npm run test:v18861`: 18/18 PASS.
- `npm run test:v18860`: 10/10 PASS.
- `npm run test:v18859`: 12/12 PASS.
- `npm run test:v18858`: PASS.
- Полный `tests/events/*.test.mjs`: тот же набор 18 старых baseline failures, что и V188.60; новых failures V188.61 не добавляет.

## Hotfix 2026-09-13 — VK capture recovery

По runtime-логу `page.evaluate: ReferenceError: isLikelyVkNonPosterUiImageUrl is not defined` исправлена граница Node/browser realm: фильтр VK UI/avatar media теперь имеет browser-safe реализацию внутри `page.evaluate`, поэтому импортированный Node helper больше не вызывается из DOM callback.

Для finite `парсер все` добавлена защитная стратегия capture:

- persistent Chromium после освобождения не закрывается раньше 10 минут (`SCRAPER_BROWSER_IDLE_CLOSE_MS` может увеличить, но не уменьшить этот минимум);
- VK capture по умолчанию имеет 2 попытки (`VK_PUBLIC_CAPTURE_ATTEMPTS`, максимум 3);
- неудачная finite-вкладка закрывается до retry, повторная попытка открывает свежую вкладку в том же persistent context;
- retry делает 8 дополнительных scroll steps (`VK_PUBLIC_RECOVERY_SCROLL_STEPS`) и повторно ждёт lazy-media;
- отдельная вкладка не удерживается 10 минут искусственно: штатный capture по-прежнему имеет минимум 60 секунд settle/hold, чтобы `парсер все` не умножал 10 минут на каждый источник.

Новые trace-события: `source.capture.retry-failure`, `source.capture.retry-success`, `source.capture.recovery-scroll.start`, `source.capture.recovery-scroll.finish`.

После hotfix `npm run test:v18861`: 26/26 PASS.
