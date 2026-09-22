# V188.79 verification

## Проверка причины reload

По приложенным старым trace-логам подтверждён дефект: `page-health` уже возвращал `ready=true`, `reason=wall-content-present`, но `forceReason=parser-zero-posts` всё равно ставил `forced=true` и выполнял `page.reload()`. В V188.79 этот путь удалён.

Новый порядок:

1. health check;
2. если страница здоровая — reload запрещён, даже если exact selector дал 0;
3. если есть реальный empty/error/still-loading recovery candidate — ожидание >=10 секунд;
4. повторный health check той же страницы;
5. только если повторная проверка всё ещё подтверждает reloadable empty/error — `page.reload()`.

## Tests

- active regression suite: 143/143 passed;
- syntax check: OK (488 JS files);
- import check: OK;
- named import check: OK (179 files, missing=0);
- docs link check: OK;
- release runtime-data guard: OK.

Дополнительно добавлены regression checks на:

- healthy VK page + parser-zero-posts => no forced reload;
- delayed page-health recheck before actual reload;
- Telegram keyboard hide button and absence of `is_persistent`;
- hierarchical Back navigation;
- decorated secondary party button;
- removal of Telegram Litera while keeping VK `literabar`.
