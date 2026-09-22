# Gigorave V188.88

Build: `0.188.88` / `events-v18888-all-parties-compact-r1`.


## V188.88 — «Вообще все тусы» + realtime dedupe + Кратко/Полно

- новый агрегирующий раздел объединяет обычные, второстепенные/быдлячьи и QTickets-события;
- отдельный metadata-индекс `all_party_metadata` хранит название, дату, место, источник и нормализованные слова названия, не переписывая исходные карточки;
- realtime-dedupe агрегата: одинаковая дата + самостоятельное совпавшее слово названия длиннее 3 символов; место хранится как metadata, но не влияет на совпадение; QTickets имеет приоритет в группе дублей;
- metadata-индекс обновляется фоново после verified-проходов парсинга и после QTickets parser, а перед выдачей агрегата выполняется быстрый локальный повторный dedupe;
- «Быдлячьи тусы» возвращены в меню; во всех подразделах тус есть «⬅️ Назад» и переключатель «Кратко»/«Полно»;
- краткая выдача не отправляет фото, сохраняет название/дату/время/место/участников/цену/ссылку и ограничивает только описание четырьмя строками;
- меню «Тусы» показывает примеры команд для дней недели, периодов, числовых и словесных дат, месяцев и QTickets-фильтра цены;
- QTickets listing/root URL больше не показывается как «Купить билет»: только конкретная event/ticket URL.

## V188.87 — QTickets periods + price filter

- QTickets is now a submenu inside «Тусы», matching the normal party-menu workflow.
- Default QTickets window is 7 days; «выходные» shows Friday–Sunday events inside the next 14 days.
- Text queries accept arbitrary day counts and a maximum price, e.g. `тусы на ближайшие 5 дней по цене до 600 рублей`; `руб/рублей` is optional.
- Telegram has a persistent QTickets «Установить фильтр стоимости» action; the input takes the first number from strings like `600`, `до 600`, or `600 рублей`.
- Price filtering affects only QTickets delivery; it does not rewrite QTickets rows or touch event parsing/dedup/posters.

See `V18887_CHANGES_RU.md`.

---

# Gigorave V188.86

Build: `0.188.86` / `events-v18886-real-source-poster-dedupe-r1`.

## V188.86 — real source posters only + conservative dedupe repair

- One event card emits at most one proven real source poster; generated covers are disabled.
- Persisted Vision evidence carries image path/name/SHA-256 and source galleries stay forensic-only.
- Same date/title identity ignores start-time conflicts and keeps the earliest confirmed start time.
- Known venue names are stripped from title identity while explicit different physical venues remain hard conflicts.
- VK parser-all launch stagger is 5–20s; reload backoff is 10–20s with DOM recheck before each of max 3 reloads.
- Healthy changed DOM with real content is not reloaded only because an old exact selector missed.

See `V18886_CHANGES_RU.md`.

---

> V188.66: safety-release после полного аудита: тесты изолированы от рабочей `data/bot.sqlite`; `парсер все чисто` различает captured/processing/final и повторяет незавершённые items; Telegram pending-menu использует общий детектор реальных команд; служебные команды владельца parser/provider/manual-event/diagnostics/routing/rate-reset выполняются только в ЛС. `npm test` теперь запускает поддерживаемый active gate, исторический полный набор вынесен в `npm run test:legacy`.

> V188.65: команда `парсер все чисто` выполняет инкрементальный проход только по новым source-items; уже виденные source+item id отбрасываются по SQLite raw-ledger до алгоритма/vision/AI. Полный `парсер все` сохранён для перепарса и ремонта.

# Gigorave V188.64

Build: `0.188.64`.

## V188.64 — poster vision + durable event images

- Keeps the V188.63 two-stage AI gate: body first, then narrow image-only poster vision for body-rejected items after raw capture is complete.
- Approved proposal images are copied out of temporary `event_proposals/` storage into durable `manual_event_announcements/` before the database row is committed/refreshed.
- `парсер все` performs a bounded maintenance pass for upcoming manual VK events whose saved poster file is missing; the source is re-read and poster vision must bind a concrete image by visible title/date before it is attached.
- Multi-event/digest sources may display an already mapped poster only when that image path is exclusive to the concrete child event; legacy one-poster-for-all-siblings rows remain blocked.
- Fixed poster-gate field parsing so an empty `Название:` on one image cannot consume `Дата:` from the next line/image and fabricate admission.
- User-facing `тусы` remains local-only: it never opens a browser or runs repair/AI during delivery.

Regression: `npm run test:v18864` (48/48).

See `V18864_RELEASE_NOTES.md`.

---

# Gigorave V188.63

Build: `0.188.63`.

## V188.63 — body first, poster vision rescue second

- The cheap strict body gate still runs first.
- If body admission fails but an image exists, parser-all waits until **all raw browser capture is cached**, then runs a narrow image-only poster gate (`афиша? / название / дата / время`).
- A pure-image announcement can enter main AI only when the poster itself contains a usable title plus a today/future event date. Image presence alone is not enough.
- Publication/UI timestamps never become event-date evidence.
- Owner diagnostics show poster-gate checked/rescued counts and mark queue evidence as `текст` or `афиша`; the human audit also shows poster-gate blocks.
- V188.62 strict-date fixes and V188.61 VK capture recovery/10-minute persistent Chromium protection are preserved.

Regression: `npm run test:v18863`.

See `V18863_RELEASE_NOTES.md`.

---

# Gigorave V188.62

Build: `0.188.62`.

## V188.62 — strict AI gate + visible AI queue

- AI admission now requires an event date in the actual post/message body, title/participants, and at least one today/future event date.
- Publication/UI timestamps do not create date evidence; publication time is used only to infer a missing year for a day/month already present in body text.
- Past-only and no-date structural candidates stay in diagnostics but no longer consume event AI.
- Owner status shows concrete queued examples; full reasons are saved to `run-ai-queue.audit.txt` and `run-ai-queue.parser-report.json`.
- Date parsing no longer treats `4.09-800₽` or a next-line `19:00` as a year; `26го сентября` is supported.
- VK capture-recovery hotfix from V188.61 is preserved.

Regression: `npm run test:v18862`.

See `V18862_RELEASE_NOTES.md` and `AI_QUEUE_AUDIT_2026-09-13.md`.

---

# Gigorave V188.57

Build: `events-v18857-history-completeness-guard` (`0.188.57`).

## V188.57 — history completeness guard

- Durable local-history recovery no longer trusts only `currentRows >= checkpointRows`.
- Checkpoint v2 fingerprints the historical coverage up to a saved CMID boundary, so new tail messages cannot hide old gaps.
- The checkpoint also fingerprints the local SQLite snapshot inventory; a new healthy/corruption backup forces a new read-only scan.
- Legacy V187.2/V188.56 checkpoints are intentionally invalidated once, so the first V188.57 startup rechecks all local SQLite snapshots.
- Backup reads use `messages NOT INDEXED` to bypass damaged secondary indexes where table pages remain readable.
- Owner command `Гигорейв подтяни историю с самого начала` performs an unbounded remote reconciliation (fallback walks CMID newest-to-oldest to 1).
- V188.56 index-repair-first, V188.55 log maintenance, V188.54 parser bounds, and V188.53 vision ladder fixes remain preserved.

Regression: `npm run test:v18857`.

# Gigorave V188.48

Build: `events-v18848-hard-watchdog-vision-audit-checkpoint` (`0.188.48`).

## V188.48 — 2h watchdog, resumable operations, audit logs, universal image input

- Every user algorithm and major detached/background job is supervised with a hard 2-hour ceiling; provider-specific deadlines remain shorter.
- Model retry/backoff is abort-aware and stops escalating after operation cancellation/timeout.
- Active operations are discoverable and stoppable with durable checkpoints; completed work is not rolled back.
- Runtime/model/parser failures, retries, ladder steps, timeout diagnostics and operation results are written to sanitized JSONL audit logs.
- Attached Telegram/VK images are centrally vision/OCR-enriched for text/document modes; image editing keeps the image as edit target and also receives source-image analysis.
- V188.41–V188.47 summary/token/routing/non-blocking guarantees are preserved.

Regression: `npm run test:v18848`.

# Gigorave V188.47

Build: `events-v18847-nonblocking-interruptible-routing` (`0.188.47`).

## V188.47 — Telegram/VK requests do not serialize user ingress

- Telegram and VK incoming updates dispatch long-running work independently; one unresolved request does not stop the next update from starting.
- Every pending UI/input mode has an emergency cancel (`отмена`, `cancel`, `стоп`, `сбросить режим`, `выйти`); Telegram menu state also expires after 30 minutes.
- The former global GigaChat Promise queue is removed and GigaChat calls have finite deadlines.
- Telegram startup/retry, VK long polls, and optional provider diagnostics no longer wait on each other.
- Resource-local serialization remains only where concurrency would corrupt one shared browser page or one verified-event snapshot; it is detached from user-ingress routing.
- V188.41–V188.46 summary, token-budget, identity, and same-sentence command-routing guarantees are preserved.

Regression: `npm run test:v18847`.

# Gigorave V188.40

Build: `events-v18840-dossier-any-order-2k-render` (`0.188.40`).

## V188.40 — dossier in any word order + ~2000-char compact render

- `досье <имя>`, `<имя> досье`, `полное досье <имя>`, `<имя> полное досье` and the same forms after addressing Gigorave all route to the same dossier handler.
- The router canonicalizes the command before target resolution, so placing `досье` after a participant name no longer falls through to ordinary GPT.
- Normal dossier output is finalized by a dedicated cached render targeting about 2000 characters (1800–2200 when evidence is sufficient).
- Existing accumulated dossier facts/checkpoints remain reusable; the final V188.40 render has its own cache key so old two-line cached portraits are not reused as the final answer.
- Full dossier remains a separate, larger mode.

## V188.39 — explicit history retrieval, ordinary knowledge stays ordinary

- Database-message retrieval is opt-in by intent: `кто ...`, explicit history analysis (`проанализируй переписку/чат/сообщения`), `что писали/говорили/обсуждали про X`, or `найди сообщения/упоминания про X`.
- Ordinary knowledge requests such as `расскажи про riddim`, `что такое riddim`, `что известно про riddim`, and `что знаешь про riddim` do not inspect the local message database and continue through the normal AI route.
- Short conversational `кто ...` questions still use current-peer message retrieval; entity-style `кто такой/такая X` uses the full stored message database.
- V188.38 deepest VK reply/forward attachment summarization and word-aware entity matching are preserved.

# Gigorave V188.38

Build: `events-v18838-database-retrieval-deep-attachment` (`0.188.38`).

## V188.38 — database-grounded questions + deepest VK attachment

- Identity/topic questions such as `кто такая ЕВИК`, `кто X`, `что известно про X` are grounded in a full-database message lookup before the model answers. Every retained DB match is included exactly once in AI chunks.
- Word-aware matching accepts Russian inflections (`евик/евика/евиком/евику`) while rejecting substring collisions such as `боевик` and `солевик`.
- `проанализируй переписку про X` searches the stored current-conversation history; an explicit `по всей базе` expands retrieval across all stored chats. A database-classified request with zero matches does not fall back to ungrounded GPT.
- Reply/forward summarization resolves the deepest semantic VK attachment (`wall/copy_history/...`) and hydrates wall posts with `wall.getById` before summarization, instead of summarizing the surrounding chat.
- Existing V188.37 compact party output and single-link event reparse behavior are preserved.

# Gigorave V188.37

Build: `events-v18837-brief-list-single-link-reparse` (`0.188.37`).

## V188.37 — true compact list + single-link reparse

- `тусы ... кратко/коротко` sends one text-only list: title, date/time, venue and price; no descriptions, participants, sources or poster-per-event messages.
- Owner command `парсер ссылка <URL>` reparses only one source link, updates existing rows and rebuilds the verified party snapshot.
- Diagnostic single-link reparse stores exact and final full DOM snapshots plus parser report and trace under `data/logs/manual-parser/<runId>/`.
- If one source post has one confirmed poster and multiple event dates, that same poster is safely attached to all events from the post (e.g. two-day opening).

## V188.35 — current VK DOM exact parser + prefilter/trace

- Exact VK Messenger/Public parsing is grounded in the immutable full DOM saved before Stage 1.
- Messenger separates direct content, deepest wall/repost content and owned poster media; UI timestamps/avatars/reactions cannot create candidates.
- Public exact parsing uses current `data-testid` structure and strict outer-vs-nested media ownership.
- Candidate filtering happens before expensive AI; repost hydration is allowed only as evidence recovery.
- Trace now distinguishes queued/global-slot/start/finish and records sanitized AI model failover events.
- History slow-scroll keeps the 1.8s lazy-load pause without the redundant second 1.8s settle on every window.

## V188.34

Build: `events-v18834-cached-dom-background-processing` (`0.188.34`).


## V188.34 — cached DOM-first parser + background processing

- VK Messenger and VK Public capture the complete available DOM into diagnostics/raw cache before exact parsing. Messenger saves every virtual-scroll window because VK does not keep all backfilled messages in one DOM at once.
- The exact pass parses the same immutable HTML string that is written to `.dom.html`; adaptive/heuristic parsing only supplements it.
- `парсер все` has a capture barrier: after all raw sources are cached, the owner is notified that parsing is complete and algorithm/AI processing starts immediately, independent of browser close.
- Ten minutes is a soft owner-status boundary only. Pending suspicious announcement candidates continue in background and are reported as source + first ~30 characters.
- Event AI work uses bounded per-request timeouts, parallel shared limiting and the configured model ladder with two technical failures before escalation.
- Full diagnostic timeline is written to `trace.jsonl`; raw source cache and full DOM snapshots stay together for reproducible postmortem parsing.

## V188.33 — human-content VK parser

- VK Messenger/Public now use exact → adaptive → semantic stages; Stage 3 discovers repeated central content blocks and treats class words such as `message/post` only as hints.
- Messenger history-backfill is generic. Any enabled chat gets at least 50 **real older** messages, counted only when stable `CMID < initialMinCmid`.
- Generic UI/emoji/avatar/logo images are rejected; poster-like generic media starts at 300×300, while explicit VK attachment containers retain a safe rendered-size fallback.
- Deep nested repost text is preferred as evidence. Public owned media (`primary-attachment-image-content` etc.) excludes nested repost images from competition whenever a suitable own poster exists.
- Any explicit event date enters AI review, including yearless dates when `published_at` is missing. AI explicitly extracts performers, venue, date, time, price and a short announcement.
- AI dedupe skips only exact source text that already produced an announcement; previous no-event text can be checked again.
- Added Liverpool / Ливерпуль / Liverpool Bar/Pub aliases as `Liverpool Pub`.
- Focused suite: 25/25. Static checks green. Full suite remains at the V188.32 baseline: 223 files / 14 known failures, no new failures.

Regression: `npm run test:v18833`.

---

# Gigorave V188.31

Build: `events-v18831-priority-chat-22-fifty-slow-backfill` (`0.188.31`).

## V188.31 — приоритетная VK-беседа 2000000022

- `https://vk.ru/im/convo/2000000022` / `https://vk.ru/im?sel=c22` считаются одной беседой по canonical peer id, поэтому VK redirect больше не вызывает повторный `goto()` и пустой capture.
- Peer `2000000022` всегда запускается первым в `Гигорейв парсер все`.
- Для peer `2000000022` hard floor автопрокрутки = 50 сообщений, даже если старый `.env` содержит `|25`.
- 50 — это именно старые сообщения сверх первоначально отрисованного DOM, а не первые уже видимые сообщения.
- Скролл идёт блоками примерно по 10 сообщений с паузой не меньше 1.8 сек и media-settle между подъёмами.
- Приоритетная беседа не сдаётся после 5 пустых lazy-load раундов: допускается до 20 пустых циклов.
- Если после readiness timeout DOM ещё пустой, парсер продолжает ждать и повторять capture, а не закрывает вкладку как «пустую».
- Конечная проверка VK-беседы держит реально готовую вкладку открытой минимум 60 секунд и делает финальный capture перед закрытием.
- Одиночный запуск приоритетной беседы использует тот же 50-message older-backfill contract.

Сохранены V188.30: батчи перепарса ссылок по 10 вкладок, минимум 60 секунд на browser review, non-destructive event persistence, правильный приоритет афиши VK, backup SQLite каждые 6 часов с хранением 15 копий.

Regression: `pnpm test:v18831`.

---

# Gigorave V188.30

Build: `events-v18830-ten-tab-event-reparse-batches` (`0.188.30`).

## V188.30 — массовый перепарс ссылок по 10 вкладок

- `Гигорейв тусы перепарсить ссылки` больше не открывает источники по одному. Уникальные source URL обрабатываются браузерными батчами: **10 вкладок одновременно по умолчанию**, и значение конфигурации не может опустить батч ниже 10 (верхний защитный предел 20). Последний неполный батч содержит остаток ссылок.
- Внутри каждого батча используется `Promise.allSettled`: один сломанный источник не останавливает остальные девять.
- Видимый browser-review запускается параллельно с VK API hydration, поэтому медленный `wall.getById` не задерживает открытие соответствующей вкладки.
- Каждая вкладка по-прежнему обязана прожить **минимум 60 секунд** до финального DOM/media snapshot. То есть десять страниц реально грузятся одновременно, а не быстро мигают по очереди.
- На весь bulk-reparse удерживается browser activity lease: после закрытия вкладок первого батча Chromium не должен закрываться и заново открываться пустым окном перед следующей десяткой.
- Следующий батч открывается после завершения текущего, чтобы не создавать неограниченное число вкладок.
- Сохраняются все V188.29/V188.28 исправления: hard 60s dwell, non-destructive event persistence, приоритет собственной VK-афиши над logo/preview, backup каждые 6 часов с хранением 15 баз.

Regression: `node --test tests/scrapers/eventReparseBatchV18830.test.mjs tests/scrapers/browserMinimumDwellV18829.test.mjs`.

# Gigorave V188.29

Build: `events-v18829-minimum-60s-browser-dwell-source-integrity` (`0.188.29`).


## V188.29 — вкладка источника не закрывается раньше минуты

- Любой конечный browser review/reparse ссылки держит страницу открытой **минимум 60 секунд после готовности вкладки**, затем делает финальный DOM/media snapshot и только потом закрывает вкладку.
- `Гигорейв тусы перепарсить ссылки` использует этот общий путь, поэтому ссылка больше не может открыться на долю секунды и закрыться до lazy-load.
- Public VK и Telegram также имеют жёсткий минимум **60 секунд** на конечную вкладку (env может увеличить время, но не уменьшить ниже минуты).
- Конечный проход VK-чата также поднят с 30 до **60 секунд**.
- Все исправления V188.28 (non-destructive events, правильная VK-афиша, backup 6ч/15 копий) сохранены.

## V188.28 — сохранность анонсов и правильная афиша VK

- Повторный парсинг больше не удаляет уже принятые события, если новый проход временно вернул 0 карточек из-за media/AI/network/DOM ошибки. Это действует для VK public, Telegram public и VK chat.
- Startup strict-check стал audit-only: запуск бота больше не делает destructive DELETE событий/источников только из-за неполного venue/title. Явное удаление и expiry остаются отдельными сценариями.
- VK poster priority: real wall/repost photo → exact post DOM media → link/document preview. Preview/лого сообщества не может перебить собственную афишу поста.
- Exact VK browser extraction фильтрует avatar/profile/logo/icon/badge/emoji/reaction UI media.
- Source-link reparse теперь сливает exact VK API + exact browser post; API preview-only больше не перетирает найденную браузером афишу.
- `REPAIR_EVENT_DB_FROM_BACKUPS.mjs` безопасно возвращает только недостающие будущие event/source rows из `data/healthy-backups`, предварительно делая emergency snapshot текущей БД.
- Сохраняются V188.27 browser lifecycle и V188.26 healthy SQLite backup: каждые 6 часов, 15 копий.

### Восстановление базы анонсов

Остановить бота, из корня проекта выполнить `node .\REPAIR_EVENT_DB_FROM_BACKUPS.mjs`, затем запустить бота и в owner-чате выполнить `Гигорейв тусы перепарсить ссылки` и `Гигорейв тусы проверить`.

## V188.26

Build: `events-v18827-stable-scraper-browser-lifecycle` (`0.188.27`).

## V188.27 — стабильный lifecycle браузера парсера

- Public VK/Telegram source-tab больше не закрывается сразу после снятия DOM: конечный проход держит вкладку до завершения обработки полученных постов/картинок/AI.
- Для конечного public-прохода окно источника получает минимум 30 секунд на lazy-load; `VK_PUBLIC_PAGE_HOLD_SECONDS` и `TELEGRAM_HTML_PAGE_HOLD_SECONDS` ограничены безопасным диапазоном 30–60 секунд (по умолчанию 30).
- Persistent Chromium защищён activity-lease на весь проход источника, поэтому после закрытия source-tab `context.request` не поднимает снова пустой браузер для картинок.
- Idle cleanup persistent context отложен на 60 секунд и не работает, пока есть активные parser leases.
- Программное закрытие последней вкладки больше не считается `[SCRAPER OWNER STOP]`; stop-generation меняется только при внешнем закрытии persistent browser context.
- Стартовая `about:blank` вкладка переиспользуется и конечными источниками, чтобы не плодить пустые окна/вкладки.

Regression: `node --test tests/scrapers/browserLifecycleV18827.test.mjs tests/scrapers/parserAllFiniteV18817.test.mjs tests/scrapers/manualBrowserCloseFinishV153.test.mjs`.

Healthy SQLite backups are now created while the bot is running, not only at startup. The scheduler targets one verified snapshot every 6 hours and retains the newest 15 databases in `data/healthy-backups/`. Snapshot creation uses SQLite `VACUUM INTO` so committed WAL state is captured consistently, then `PRAGMA quick_check` validates the new file before it is admitted to rotation. Legacy `bot-startup-*.sqlite` backups remain valid restore candidates alongside new `bot-healthy-*.sqlite` files. If a periodic backup fails or the active DB is unhealthy, no older healthy backup is deleted; the scheduler retries later.

Regression: `node --test tests/infrastructure/databasePreflightV160.test.mjs tests/infrastructure/databaseHealthyBackupV18826.test.mjs`.

## V188.25

Build: `events-v18825-windowed-history-detached-result-leavers` (`0.188.25`).

Long-running owner history pulls now send their completion/error message as a detached VK message instead of replying to the original command. This prevents VK API error 100 (`cannot reply this message`) after multi-minute history scans. The history data is still persisted during the scan; only the transport of the final acknowledgement changed. Leaver routing/rebuild from V188.24 remains enabled (`вчера`, explicit date, rolling N days, rebuild from archived VK service actions).

## V188.23

Build: `events-v18823-windowed-vk-history-owner-pull-strict-posters` (`0.188.23`).

VK remote history repair is now strictly bounded during startup and periodic checks: the bot reads only the newest 24 hours and never more than 3500 messages, whichever boundary is reached first. `messages.getHistory` is preferred; the CMID fallback now scans newest→oldest and obeys the same bound instead of walking from CMID 1. Every incoming message is INSERT-or-ignore compared against SQLite and recovery logs/reporting separate new rows from rows already present. The browser fallback also obeys the same time/count window.

Deeper remote history is owner-command only: `Гигорейв подтяни историю`, `... 6 часов`, `... 2 дня`, `... 1 неделя`, etc. A bare command means one day. The former automatic full archive crawler and its startup/timer/side-command triggers were removed, so `кто вышел` and service reports no longer start an implicit deep crawl. Local SQLite-backup recovery remains as a corruption/restart safety mechanism and is not a remote VK history crawl.

Regression: `node --test tests/infrastructure/vkHistoryPullPolicyV18823.test.mjs tests/infrastructure/vkHistoryRecoveryVisibilityV18822.test.mjs tests/infrastructure/historyRecoveryCheckpointV1872.test.mjs tests/v177/vkServiceArchiveV177.test.mjs`.

## V188.20

Build: `events-v18820-recursive-repost-poster-ai-failover-translit-dedupe-weekend` (`0.188.20`).

VK event parsing now follows `copy_history` recursively to four repost levels, keeps the largest/original image for every photo attachment, parses multiple posters independently, and sends every real poster through the final multimodal extractor. AI fields are authoritative; deterministic extraction only fills fields left blank by the model. Event-parser failover retries each candidate twice and escalates through `default → gpt54 → gpt55 → pro → pro2 → pro3` without persistent health quarantine blocking subsequent sources. Bulk link reparse handles multi-event sources instead of skipping them. Dedupe compares transliterated title identity (`PEREGRUZ`/`ПЕРЕГРУЗ`) plus date/place/source evidence. `Эти выходные` spans Friday through Sunday.

Regression: `npm run test:v18820`.

## V188.16

Build: `events-v18816-venue-labels-quiet-active-ack` (`0.188.16`).

V188.16 fixes the two regressions reproduced by the September parser logs. Venue recovery no longer depends only on a small proper-name list or on AI: explicit `Место:`, `Где:`, `Локация:`, `Площадка:` and `Адрес:` lines are parsed deterministically, city-only placeholders such as `Место: Воронеж` are skipped, and `Котельная` is now a canonical known venue with inflection support. This fixes pages where the VK structured event block says only `Воронеж` while the announcement itself says `Место: Котельная`, even when all AI providers are temporarily unavailable.

The command `активное общение <N>` now sends only a short acknowledgement (`✅ ... Интервал: N сообщений.`). Full SQLite counters, timestamps, last model/error and health details remain available only through the explicit `статус активного общения` command and server logs. Event-poster vision now writes per-batch success/error details into the parser JSONL, and failover errors preserve the previous reason when every credential is currently quarantined instead of collapsing to the unhelpful generic `Все AI provider/key завершились с ошибкой`.

Regression suite: `npm run test:v18816` (plus `npm run test:v18814` and `npm run test:v18815`).

## V188.15

Build: `events-v18815-startup-autosummary-token-ledger` (`0.188.15`).

V188.15 makes scheduled auto-summary restart-safe. The first scheduler tick after process startup is marked as a catch-up scan. If a summary slot became due while the bot was offline, the bot collapses stale intermediate slots into the latest due slot, reloads the complete relevant window from local history plus VK `messages.getHistory` (up to the existing 100,000-message safety ceiling), and immediately sends the missed summary. For cumulative slots the missed window is extended from the scheduled slot to startup time, but never across the 06:00 bot-day boundary; closed day-only 06:00→06:00 summaries remain closed.

AI calls now produce a token ledger. Every core OpenAI-compatible text/vision/image request and GigaChat request records the operation, provider, key name, model, transport, duration, input/output/total/cached/reasoning tokens when the provider returns usage, plus a clearly marked text-token estimate when exact usage is absent. Explicit external provider chat routes are logged too, including Gemini/Anthropic/OpenAI-compatible usage formats. Auto-summary stages are split into `auto-summary:leaf` and `auto-summary:merge` so later optimization can target the expensive stage. Daily JSONL is written to `data/ai-token-usage/YYYY-MM-DD.jsonl`; override with `AI_TOKEN_USAGE_LOG_DIR`. Run `npm run tokens:report` to aggregate all saved rows by operation/provider/model. Prompts and API-key secrets are not written to this ledger.

Regression suite: `npm run test:v18815`.

## V188.14

Build: `events-v18814-venue-semantic-link-restart` (`0.188.14`).

V188.14 completes the venue/review fixes on top of V188.12. A fresh VK/Telegram source URL now escapes an existing proposal `review` state before draft-correction parsing, so a second wall link starts a new parse instead of producing «Не понял правку черновика». Venue extraction now has a deterministic Voronezh venue catalog (Тупик, Сто Ручьёв, The Last of Vavilone, DIESEL HALL / Rock Bar DIESEL, Overlock Bar, Meet Bowling, Паб Мама Анархия), semantic `в/во/на` candidates, and a bounded focused AI audit when venue remains uncertain. Poster vision facts are passed into that audit; `is_event=false` is honored. `СКОЛЬКО:` is recognized as a price label.

Regression suite: `npm run test:v18814`.

## V188.13

Internal venue-inference step included in V188.14: hard venue aliases/inflections, semantic preposition candidates, local Tupik/Diesel recovery, and poster-aware venue AI fallback. It was not shipped as a separate final archive in this conversation.

## V188.7

Build: `events-v1887-strict-participant-summary-vk-event-evidence` (`0.188.7`).

- Participant matching now has a hard acceptance rule: at least one name/nickname part must have **strictly more than 80%** normalized similarity. The boundary case `связь` → `Святой ...` is exactly 80% and is rejected. Direct VK IDs/usernames remain exact references.
- `Тимасин` / standalone `Тимофей` are the project-level identity alias for the two known profiles `Тимофей Тимофеев` + `Тимасин Тимасинский`; an explicitly different full name is not merged into that identity.
- Participant-focused `резюмируй <имя>` scans the complete linked chat history, combines the participant's own messages with all qualifying mentions, takes ±10 messages around each mention, merges overlapping windows, and uses AI to discard unrelated branches before the final summary.
- Bare/unclear `резюмируй` no longer has any hidden “last 100 messages” fallback: it returns a usage hint. Rolling time ranges are not silently truncated to `MAX_MESSAGES`.
- Weekly hierarchical results are eligible only on **Sunday at 20:00 Europe/Moscow**; there is no Monday/Tuesday restart catch-up. Monthly results are eligible only on the **last calendar day at 20:00**, covering the calendar month from day 1 00:00 to that boundary.
- VK event/community pages use a resilient structured-data first pass: event-shaped bootstrap objects are scanned recursively for semantic event markers and start timestamps (`start_date`/equivalent key shapes), without requiring one exact VK method/template. If structured evidence is unavailable, the normal title/description/body/post/image parser remains active. For the reproduced `club239795426` payload, `start_date=1789833600` resolves to `2026-09-19 19:00` in `Europe/Moscow`.

Regression suite: `npm run test:v1887`.

---

## V188.6

Build: `events-v1886-vk-bootstrap-poster-temporal-fusion` (`0.188.6`).

- Exact VK wall links now recover the structured `wall.getById` payload already embedded in the page (`window.cur.apiPrefetchCache`) when direct VK API hydration is unavailable. This preserves the real wall timestamp, exact post text, and direct photo attachments instead of relying only on the modal DOM.
- Manual/event-proposal extraction fuses deterministic text/poster date-time evidence with model output. A model draft can no longer erase a locally proven date/time.
- Poster vision is explicitly prompted to emit `Дата:` and `Время:` on separate lines and copy printed numeric values exactly.
- Owner/manual exact-post flow merges VK API and browser/bootstrap evidence and always keeps the selected post photo as the event image source.


## V188.4

- Owner command `Гигорейв проверить рабочие модели`: compact parallel live audit. Key catalogs are probed concurrently; every selected text/chat model is tested in `stream` and `non-stream` at the same time.
- Latest health is persisted in `ai_key_health` and `ai_model_health`; only successful combinations are copied into `ai_runtime_modes`. No secrets are stored in SQLite.
- Definitive invalid-key failures (401/invalid key) are removed from `.env` with an automatic backup. Temporary timeout/429/5xx are marked unavailable, not destroyed.
- Runtime routing consults health state and skips definitively dead key/model combinations.
- Explicit `Гигорейв грок нарисуй <prompt>` / `xai нарисуй ...` routes to xAI image generation with the existing 3-failures-per-key failover.
# Gigorave V188.3 — resilient model failover + Grok/xAI + real chat-style examples

Build: `events-v1884-compact-ai-health-grok-image` (`0.188.4`).

V188.3 keeps the V188.2 unlimited-mini/full-dossier behavior and adds resilient model failover, optional xAI/Grok fallback and durable real-message style examples.

- Default `gpt-5.4-mini` text/vision requests no longer consume the per-user daily GPT model quota.
- The normal mini response does not print `GPT mini Осталось ...` and does not prepend `🤖 gpt-5.4-mini`. If routing/fallback actually uses another text model, its model label remains visible.
- Explicit `gpt54`, `gpt55`, `pro`, `pro2`, `pro3` and image generation keep their existing quotas.
- Active communication keeps its existing 50-message context; mini replies stay clean, while a non-mini fallback may show its model label.
- `полное досье <имя>` is a local group-chat command with a hard cap of 11,200 characters (4× the normal 2,800-character dossier).
- Full dossier reuses the already-paid accumulated dossier facts/checkpoints. Its detailed render is stored in the external durable personalization SQLite and reused with zero GPT calls while its source facts/checkpoint are unchanged.

V188 hierarchy, weekly/monthly summaries, operational `за день` range, V188.1 40-message direct context, V187 linked-history dossier, and V185–V186 event fixes remain included.

---

# Gigorave V188 — hierarchical chat memory + calendar summaries + correct “за день”

Build: `events-v188-hierarchical-chat-memory-weekly-monthly` (`0.188.0`).

V188 adds a durable hierarchical summary memory for linked chat history. Raw messages are sealed into adaptive token-budgeted leaves, reused by a higher-level summary tree, and stored outside `bot.sqlite` in `%LOCALAPPDATA%\Gigorave\state\hierarchical-summary-v188.sqlite`. The default context assumption is 128k tokens with a 90% working ratio and explicit prompt/response reserve; context overflow automatically bisects a leaf instead of failing the whole job.

- Initial bootstrap walks the linked predecessor+current chat once and persists immutable summarized chunks.
- New messages only create new leaves when enough material accumulates; unchanged old leaves are not sent to GPT again.
- Weekly summary is default-on for the Sunday 20:00 → Sunday 20:00 window (V188.7 supersedes the original V188 21:00 boundary).
- Monthly summary is default-on only at 20:00 on the final calendar day (V188.7); no next-month catch-up is sent.
- `резюмируй всю историю` reuses the durable hierarchy root and is owner-only for large history.
- `резюмируй за день` now means the operational chat day from 06:00 Europe/Moscow to now (before 06:00 it starts at 06:00 of the previous calendar date). It no longer falls through to the legacy 100-message default.
- Natural `резюмируй за неделю` and `резюмируй за сутки` also no longer fall through to 100 messages.

V187.2 durable summary cache, linked-history dossier, recovery checkpoints, V187 batched personalization, and V185–V186 event fixes remain included.

---

# Gigorave V187.2 — cached large summaries + linked-history dossier + restart recovery checkpoint

Build: `events-v1872-summary-cache-linked-dossier-history` (`0.187.2`).

V187.2 fixes three expensive/history-related regressions:
- explicit `резюмируй N` uses stable batches of at most 500 messages and a durable content-addressed cache in `%LOCALAPPDATA%\Gigorave\state\summary-v1872.sqlite`; already-paid leaf/merge stages are reused instead of sent to GPT again;
- `досье <участник>` reads both canonical `messages` and the linked VK archive (`vk_message_archive`) across every `source_peer_id`, with separate durable cursors per physical source chat, so predecessor-chat messages are not hidden by a newer replacement-chat checkpoint;
- startup local SQLite recovery is checkpointed outside `bot.sqlite`; a normal restart skips the expensive backup scan when the current DB still contains at least the checkpointed row count. A restored/rolled-back DB automatically makes the scan eligible again. Known `getHistory` access denial also stays on the working CMID fallback without re-testing the denied endpoint, and completed CMID recovery no longer re-reads the previous 500 IDs.

V187/V187.1 rules remain: dossier is command-only; background communication style waits for 500 new messages; unchanged event posts do not reparse merely because the release version changed.

---

# Gigorave V183 — persistent AI-only autoresume + 06:00 reporting day

Build: `events-v183-autosummary-persistent-ai-0600-day` (`0.183.0`).

V183 removes the autoresume emergency/local transcript fallback entirely. A scheduled slot with real messages is considered complete only after a normal AI summary is generated and delivered; failures stay pending and retry indefinitely, rotating configured GPT model modes. The old whole-summary 90-second timeout is removed because a large day can require many sequential chunk/merge requests.

The autoresume reporting day now starts at 06:00 `Europe/Moscow`: cumulative 13:00/18:00/21:00/23:00 releases cover 06:00→slot, and `авторезюме только день` runs at 06:00 for the completed 06:00→06:00 period.

V182 leaver-period reports, automatic leaver reports, clickable VK profile mentions and owner participant-DM broadcasts remain included.

Release notes: `PATCH_NOTES_V183.txt`; cumulative recovery-series index: `RELEASE_NOTES_INDEX_V166_V183.txt`. Operational SQLite files are not part of the full-source release archive.

---

V161 исправляет главный дефект V158–V160: авторезюме могло быть включено и сохранено, но пропущенный более чем на 10 минут слот код сам объявлял устаревшим и молча переносил расписание дальше. Теперь слот не считается выполненным, пока сообщение реально не отправлено.

- После перезапуска пропущенные накопительные слоты схлопываются в последний актуальный и догоняются.
- При ошибке AI/VK/Telegram `next_run_at` не сдвигается; повтор через 60 секунд.
- Для VK используется сохранённая SQLite-история даже если `messages.getHistory` временно не работает.
- Если один VK endpoint не имеет доступа к беседе, чтение/отправка пробуют второй.
- `авторезюме статус` показывает последний успех/ошибку.
- `авторезюме сейчас` запускает контрольный выпуск немедленно.
- Durable state по-прежнему лежит вне релиза в `%LOCALAPPDATA%\\Gigorave\\state\\auto-summary.sqlite` (Windows).

Проверка: `npm run test:v161`, затем полный `npm test`/`npm run verify` в рабочей Node 24+ среде.

## V163 — active communication runtime repair

- Active communication is no longer awaited by the incoming-message handler.
- Removed the per-peer Promise queue that could remain stuck behind one long GPT request.
- Autonomous replies use a 25-second model request timeout and 15-second send timeout.
- Model routing now falls back from `pro`/`pro2` to `default`/`gpt54`, then to GigaChat when configured.
- Added a watchdog/run-id invalidation so a stale generation cannot send after replacement.
- `активное общение`, `активное общение статус`, enable/disable variants are direct group fast-path commands in VK and Telegram.
- Status reports last eligible message, attempt, successful reply, model and last runtime error for the current process.
- V163 also contains the V162 auto-summary scheduler watchdog fixes.

## V164 — расшифровка голосовых VK и Telegram

V164 добавляет голосовые сообщения в тот же смысловой контур, что обычный текст.

- VK: сначала используется готовый `audio_message.transcript`, если VK его уже вернул.
- Если транскрипта VK нет, бот берёт `link_mp3`/`link_ogg` (включая `doc.preview.audio_msg`) и делает speech-to-text через настроенный OpenAI-compatible endpoint.
- Обход рекурсивный: обычное сообщение, reply, `fwd_messages`, wall/repost и `copy_history`.
- Специальный VK chat parser (включая `2000000022`) подмешивает расшифровку голосового к тексту сообщения до поиска тус, поэтому голос + афиша/репост анализируются вместе.
- VK auto-summary при API-догрузке истории тоже распознаёт голосовые, если их не было в локальной истории.
- Telegram Bot API теперь принимает voice-only update. Файл скачивается через `getFile`, расшифровывается и дальше участвует в авторезюме, активном общении, обычных ответах, досье и памяти как обычный текст участника.
- Telegram reply на голосовое получает транскрипт в reply-context; forwarded voice распознаётся как обычный `voice` текущего сообщения.
- Транскрипты хранятся в SQLite `voice_transcripts`, поэтому одинаковое голосовое не отправляется в speech-to-text повторно после рестарта/повторного прохода.
- Ошибка STT кэшируется на короткий retry-window, чтобы один недоступный endpoint не долбился на каждом проходе.

Speech-to-text provider выбирается автоматически в таком порядке: явные `AUDIO_TRANSCRIPTION_*`, затем `OPENAI_API_KEY`, `GROQ_API_KEY`, затем существующий `OPENAI_COMPAT_API_KEY`. Для VK готовый transcript от VK всегда имеет приоритет и внешнего STT не требует.

## V179 linked-chat archive recovery

- Active chat archive state from V177 is preserved and is not re-downloaded.
- Linked predecessor chats now start at the locally known `min_cmid` instead of CMID 1.
- If a linked/deleted chat returns five consecutive empty CMID batches inside a locally known populated range, the API scan stops and the source is marked `unavailableViaApi`; local SQLite backups remain the source of truth for that predecessor chat.
- Commands reporting leavers/service events explicitly disclose when an old linked chat is unavailable through VK API instead of pretending that indexing is still running forever.
- No database file is bundled with the source archive.

## V188.3 model reliability and chat style

- Normal user-facing text, vision, image, GigaChat, external-provider chat, STT and NVIDIA Visual paths use credential failover: 3 technical failures on one key, then rotate.
- `AI_FAILOVER_MAX_ROUNDS=0` keeps retrying temporary outages across the configured key/provider pool; invalid requests and policy/content refusals are not retried forever.
- Optional xAI runtime fallback uses `XAI_API_KEY[_N]`, `https://api.x.ai/v1`, `grok-4.6` for text/vision and `grok-imagine-image-2.0` for image generation.
- Durable `communication_style_examples` stores real participant messages. Direct and active-chat prompts use these examples to imitate actual syntax, brevity, vocabulary and punctuation; default response style is one short chat sentence unless more detail is needed.

### V188.49: автоматический реестр AI-моделей
Бот проверяет каталоги всех настроенных AI-ключей после 03:00 `Europe/Moscow`: первые 14 суток ежедневно, затем по понедельникам раз в неделю. Новая модель сначала сохраняется как `pending`, проходит полный live qualification (text transports, reasoning/intelligence levels, JSON/tools, vision/image при наличии), и только затем может быть допущена в runtime failover. Подробности: `V18849_RELEASE_NOTES_RU.txt`.

Для `натал` и `прашна` обязателен локальный Swiss Ephemeris. Установите `EPHEMERIS_PATH` на каталог с `*.se1`; без подтверждённого Swiss-расчёта LLM-интерпретация не запускается.

## V188.55 — one-time cleanup of already processed diagnostic logs

Build: `events-v18855-fresh-runtime-logs` (`0.188.55`).

On the first V188.55 startup, the bot establishes a clean diagnostic boundary by deleting only volatile old logs/audit artifacts: `data/logs`, media forensic audit files, AI token-usage logs, event-ingest audit, `AI_FULL_AUDIT_RESULTS`, and `GRAPHICS_MATRIX_RESULTS`. A durable marker prevents ordinary restarts from deleting newly collected logs. Databases, history journals, healthy/corruption backups, operation checkpoints and LocalAppData state are outside the cleanup allowlist and are never touched.

V188.55 includes V188.53 recursive-image/vision fixes and V188.54 parser retry/timeout + active-communication cheap-first ladder fixes.

## V188.56 — index repair before database replacement

Build: `events-v18856-index-repair-first` (`0.188.56`).

If SQLite `PRAGMA quick_check` reports only index-entry inconsistencies (for example `wrong # of entries in index ...`), startup first preserves the full SQLite family in `data/corruption-backups/<timestamp>/`, then runs `REINDEX`, followed by both `quick_check` and `integrity_check`. A healthy result keeps the same active database and all rows; no healthy-backup restore is performed. General/mixed corruption still uses the existing WAL/backup/salvage recovery path. The lineage guard remains authoritative and blocks blessing a database that is missing older history.

## V188.60 — parser-all repairs stale/missing event posters

Manual `Гигорейв парсер` / `Гигорейв парсер все` now rechecks current media for VK-public events that already exist in the database instead of treating every known source post as finished forever. Real event-level posters can replace stale community-avatar or empty media; VK `?ava=1` and API preview-only images are rejected as poster candidates. Partial reparses cannot delete unmatched stored events. Multi-announcement digest posts retain up to 12 poster images, preserve `image_indexes`, and receive one bounded completeness retry if a clearly multi-event source collapses to 0–1 extracted events. See `V18860_RELEASE_NOTES.md` and `PARSER_LOG_AUDIT_V18860.md`.


## V188.61 — финальный parser-all dedupe

`Гигорейв парсер все` после обработки всех источников выполняет финальный cross-post/cross-source dedupe. Разные посты одного и того же именованного события на одной дате объединяются в canonical card, если нет явного конфликта времени/площадки. Raw строки сохраняются как evidence. Также сохранён V188.61 poster repair: аватарки/UI VK исключаются, DB-known посты проходят media-refresh.
