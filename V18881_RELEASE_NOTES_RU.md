# Gigorave V188.81

Hotfix по фактическому `parser-all-secondary` run от 15.09.2026.

## Исправлено

- **Secondary события снова видны в SQLite-backed выдаче.** `getRawUpcomingEventsForModeration()` раньше считал configured только primary `telegramHtmlScrapers` / `vkPublicScrapers`, поэтому строки, созданные secondary-парсерами, отбрасывались до `partyPool`-классификации. Теперь configured set — объединение primary + secondary массивов.
- **Старые secondary-строки повторно проверяются по смысловому тексту источника.** Для secondary дата события обязана подтверждаться исходным текстом поста. Это позволяет после обновления скрыть старые poisoned rows без повторного двухчасового парсинга.
- **Диапазон `26.08-30.08` больше не превращается в 2030 год.** Двузначный хвост диапазона не трактуется как explicit year.
- **Телефон `+7(905)655-11-11` больше не создаёт фальшивую дату `11-11`.** Date extractor отсекает phone fragments.
- **Telegram poster binding больше не падает с `ReferenceError: traceAi is not defined`.** `traceAi` стал явным optional callback и прокидывается из manual-parser diagnostics.
- **AI evidence с несколькими точными цитатами через `||` теперь реально валидируется.** Раньше весь joined evidence проверялся как один substring, поэтому корректные ответы AI silently discarded, а результат подменялся local fallback.
- В строгую event essence добавлена **дегустация**, чтобы реальные анонсы дегустаций не отклонялись после корректной evidence-проверки.

## Что показал приложенный старый run

- Capture: 250 items.
- Main AI queue: 30.
- В SQLite реально были записаны 7 secondary events, несмотря на пустую Telegram-выдачу.
- 4 Telegram items упали именно на `traceAi is not defined`.
- Обнаружены две подтверждённые ложные даты: `26.08-30.08 -> 2030-08-26` и телефон `...655-11-11 -> 2026-11-11`.

## Совместимость со старой БД

Новый полный парсинг не требуется только для того, чтобы уже сохранённые валидные secondary events появились в меню. После запуска V188.81 public selection читает их из существующей SQLite и применяет новую semantic-date sanitation на чтении.
