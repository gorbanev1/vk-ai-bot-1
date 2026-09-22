# V188.138 — DOM fixture до парсера

- Добавлен `src/features/scrapers/vkDomFixtureCapture.js`: браузерный DOM (`outerHTML`) и runtime state из одного вызова `page.evaluate`; файлы каждого прохода сохраняются в отдельном неизменяемом каталоге с SHA-256 и manifest.
- Добавлен `captureVkDomFixture` в существующую ручную диагностику. Журнал `vk.fixture.persisted` фиксирует источник, итерацию и sha; `vk.fixture.failed` фиксирует сбой записи/браузера.
- `vkPublicScraper`: capture каждого наблюдаемого окна даже если `snapshotEveryScroll` выключен, дополнительный финальный capture до exact; при ошибке обязательного capture ручной проход не маскирует её пустым результатом.
- `vkChatEventScraper`: capture down-sweep, каждого window и финального DOM до exact из той же неизменяемой строки; нет дополнительного скролла и изменения admission.
- `scripts/vk-dom-fixture-verify.mjs`: офлайн проверка байтов HTML и SHA-256 без VK/браузера/сети.
- Не реализует новый офлайн-парсер и не создаёт fake expected announcements; их разрабатывают по реальным fixtures после первого capture.
