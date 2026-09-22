# Gigorave V188.76 — VK source reload backoff

## Change

Automatic VK source reloads no longer happen immediately after an empty/error DOM is detected. Every automatic `page.reload()` now waits **at least 7000 ms** first.

- Default: `VK_PUBLIC_RELOAD_BACKOFF_MS=7000`.
- Hard minimum: 7000 ms even if an environment override is lower.
- Maximum configurable backoff: 120000 ms.
- The initial source load is not delayed by this setting; it applies only to automatic retry/reload.
- Parser-all source launch staggering remains 15000 ms between source starts.
- CAPTCHA/login access-gates remain handled by the manual-access flow and are not put into the reload loop.
- Reload diagnostics now record `reloadBackoffMs` and the console reload line includes `waitMs=...`.
- If the browser page is closed during the backoff, reload is cancelled cleanly.

## Preserved fixes

All V188.75 behavior is preserved, including the hard physical-venue boundary between DIESEL Bar and DIESEL Hall, final parser-all dedupe, full DOM/media audit logging, 15-second source-start staggering, poster vision binding, and bounded VK refresh.
