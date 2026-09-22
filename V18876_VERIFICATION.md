# V188.76 Verification

Build: `events-v18876-vk-reload-backoff-r1`
Package: `0.188.76`

## Requested behavior

Automatic VK source reload now waits at least **7000 ms before every `page.reload()`**.

- `VK_PUBLIC_RELOAD_BACKOFF_MS` default: `7000`
- enforced minimum: `7000`
- configurable maximum: `120000`
- source-start staggering from V188.74 remains `15000 ms`
- the delay applies only to reload/retry, not the first source opening
- if the page is closed during the delay, the reload is cancelled
- diagnostics record `reloadBackoffMs`; console reload records include `waitMs=`

## Verification results

- V188.76 targeted suite: **15/15 passed**
- Active suite: **120/120 passed**
- Syntax: **OK (483 files)**
- Import check: **OK (483 files)**
- Named imports: **OK (178 files, missing=0)**
- Documentation links: **OK (49 files)**
- Release runtime-data guard: **OK**

The targeted test verifies that the backoff operation appears before `page.reload()` and that its minimum/default is 7000 ms.
