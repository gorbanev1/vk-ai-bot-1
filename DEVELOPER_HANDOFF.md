# V188.57 handoff

Build: `events-v18857-history-completeness-guard` (`0.188.57`).

- Never reintroduce count-only local-history skip logic. A larger active row count does not prove historical completeness.
- Checkpoint v2 must validate both snapshot inventory and a deterministic coverage hash for rows at/below the saved CMID boundary.
- A legacy checkpoint, changed backup inventory, count regression, coverage-count mismatch, or coverage-hash mismatch must rescan local snapshots.
- Local backup recovery reads `messages NOT INDEXED`; corrupted indexes must not prevent salvage of readable table rows.
- Full owner history pull (`с самого начала` / `всю` / `полностью`) uses no date cutoff and unlimited message budget; automatic startup/periodic recovery stays bounded to 24h / 3500.
- Release archives must continue excluding runtime `data/`, SQLite, WAL/SHM, JSONL and `.env`.
- Regression: `npm run test:v18857`.

# V188.48 handoff

Build: `events-v18848-hard-watchdog-vision-audit-checkpoint` (`0.188.48`).

- Do not bypass `runSupervisedOperation`/`runDetachedSupervisedOperation` for user algorithms or finite background jobs. The global maximum is 2 hours; individual providers should keep shorter timeouts.
- Any retry/backoff loop must observe the current operation AbortSignal; never continue model escalation after the parent operation is cancelled/timed out.
- Long multi-item algorithms must update progress/checkpoints after durable partial results so manual stop preserves completed items.
- Stop handlers must be idempotent and finite; supervisor caps each cleanup handler at 15s.
- All failures/retries/parser outcomes must remain auditable through sanitized `data/logs/operations/*.jsonl`; never write API secrets.
- Universal incoming-image preprocessing is centralized. New text/document modes must consume the central incoming prompt context rather than reading only `message.text`.
- Image editing must retain the original image as the edit target; source analysis is prompt enrichment only.
- Release archives must exclude runtime `data/`, SQLite, WAL/SHM, JSONL and `.env`.
- Regression: `npm run test:v18848`.

# V188.47 handoff

Build: `events-v18847-nonblocking-interruptible-routing` (`0.188.47`).

- Never await a user request from Telegram polling or VK `message_new` ingress. Long work must remain detached and errors caught on the detached task.
- Do not reintroduce a global OpenAI/GigaChat user-request Promise queue.
- Every persistent or in-memory pending input mode must be reachable by the global cancel path.
- Telegram DM menu state expires after 30 minutes and menu sends are detached from polling.
- Keep serialization only for unsafe shared resources (single browser page/live parser stream/verified event snapshot), never for platform ingress.
- Telegram/VK/provider startup is independent; DB integrity preflight remains intentional.
- Regression: `npm run test:v18847`.

# V188.40 handoff

Build: `events-v18840-dossier-any-order-2k-render` (`0.188.40`).

- Dossier routing is order-independent via `parseDossierCommand()`.
- Compact dossier final output uses `renderCompactDossier()` with target 2000 chars, 1800–2200 preferred range, and cache variant `compact-v18840`.
- V188.39 history-retrieval routing remains unchanged.

# V188.39 explicit database-retrieval intent handoff

## V188.39 contract

1. A generic knowledge request must never be routed to SQLite merely because it contains `про X`. In particular `расскажи про X`, `что такое X`, `что известно про X`, and `что знаешь про X` stay on the ordinary AI route.
2. Database retrieval remains mandatory for `кто ...` and for explicit history intent: `проанализируй переписку/чат/сообщения`, `что писали/говорили/обсуждали про X`, and `найди сообщения/упоминания про X`.
3. Explicit `по всей базе` expands conversation analysis globally. Entity-style `кто такой/такая X` remains global; conversational `кто сегодня ...` stays current-peer.
4. Preserve V188.38 word-boundary matching and deepest semantic VK attachment summarization.

# V188.38 database retrieval / deep attachment handoff

## V188.38 contract

1. Requests classified as database retrieval must never fall through to an ungrounded normal GPT answer when the DB lookup is empty.
2. `кто такой/такая X`, short `кто X`, and `что известно/говорили/писали про X` search the full stored message DB.
3. `проанализируй переписку про X` searches the stored current peer by default; explicit `по всей базе` makes it global. Every retained matching message must enter exactly one AI chunk.
4. Entity matching uses word boundaries and Russian inflection suffixes; substring collisions (`боевик`, `солевик` for `ЕВИК`) are excluded.
5. Scoped VK reply/forward summary must hydrate wall posts, follow `copy_history` recursively to the deepest substantial semantic node, and must not load/summarize the surrounding chat unless the user explicitly asks for a history range.

# V188.37 compact/reparse handoff

## V188.37 contract

1. Explicit `кратко/коротко` party output is a single text list. Never call `getEventAttachments()` or append summaries/participants/source lists in this mode.
2. `парсер ссылка <URL>` is owner-only and reparses just that URL. It must update existing rows by safe source/date/title matching and rebuild/invalidate the verified snapshot.
3. Diagnostic link reparse must retain the full early exact DOM and final DOM plus a parser report; trace stores references/metadata rather than duplicating the full HTML blob.
4. A single confirmed source poster may be shared by multiple event dates extracted from the same source post. Multiple ambiguous source images must not be assigned blindly.

# V188.35 current-DOM parser handoff

## V188.35 additions

- Current Messenger Stage 1: `VirtualScrollItem[data-itemkey]`, direct `.MessageText`, repost `.AttachWallNew__message`, poster `.PhotoItem__img`; `.AttachWallNew__subtitle`, avatars, emoji and reactions are metadata/UI only.
- Current Public Stage 1: `[data-testid="post"][data-post-id]`, `post-content-container`, `showmoretext`, `post_date_block_preview`, `primary-attachment-image-content`; deepest repost is separate fallback evidence.
- `contentText/repostText/imageOrigin` remain structural fields in raw cache.
- AI trace events must remain sanitized; never log key secrets.
- Global processing trace semantics: queued -> slot -> start -> fulfilled/rejected.
- Full suite baseline after this patch: 224 files / 14 pre-existing failures.

# V188.34 cached DOM-first parser handoff

## V188.34 critical contract

1. Browser capture and AI processing are separate phases. Every VK source must first produce durable raw cache and full DOM diagnostics.
2. Exact parsing consumes the same immutable HTML snapshot that was logged. VK chat additionally logs every virtual-scroll window.
3. The capture-complete notification is sent before processing starts; browser closure is not a trigger.
4. The 10-minute boundary never cancels processing. Remaining event candidates continue in background until the processing promise settles.
5. Pending status contains only algorithmically prefiltered event candidates, with source and a ~30-character preview.
6. Diagnostics live under `data/logs/manual-parser/<runId>/`: `trace.jsonl`, raw cache files and `.dom.html` snapshots. Release archives must exclude runtime `data/`.


- Core policy: repeated content structure first; current VK selectors only accelerate Stage 1.
- Messenger backfill direction is proven only by stable CMID. Capture `initialMinCmid`; count an older item only when `cmid < initialMinCmid`. Synthetic ids and new incoming messages never count.
- `autoScrollMessages > 0` is generic history-backfill and floors to 50. Peer 2000000022 is not hardcoded in parser/app logic; source configuration retains only a legacy migration default.
- Public media ownership: if outer primary/photo/media exists, nested repost images are excluded from event-image competition.
- Event admission: raw date syntax is sufficient for AI candidate review, even without published_at/year inference. Strict validation remains the final event gate.
- AI dedupe: exact raw text + stored event suppresses text AI. A prior no-event result is not a permanent suppression key.
- `getVkChatMessageMeta()` must continue returning `rawText`; removing it silently breaks exact text dedupe.
- Liverpool aliases resolve to `Liverpool Pub`.
- Verification: `npm run test:v18833` 25/25; syntax/import checks green; full suite 223 files / same 14 legacy failures as V188.32.
- Release ZIP must contain no `data/`, DB/SQLite, WAL/SHM, JSONL or `.env`.

---

# V188.31 priority VK chat 22 handoff

- Priority peer: `2000000022`.
- Canonical readiness compares peer IDs, not URL path, so `/im?sel=c22` and `/im/convo/2000000022` are equivalent.
- Hard minimum priority backfill: 50 older messages beyond the initial DOM snapshot.
- Priority scroll delay: >= 1800 ms; lazy-load empty-round tolerance: 20.
- Finite chat page remains open >= 60 seconds after `openLivePage()` readiness/settle returns, then performs final DOM/media capture before close.
- `parser all` sorts peer 2000000022 first.
- Old `.env` explicit `|25` is raised to 50.
- Focused regression: `pnpm test:v18831`.
- Release ZIP must contain no `data/`, SQLite, WAL/SHM, JSONL, or `.env`.

---

# V188.30 ten-tab bulk event reparse handoff

- Bulk source-link event reparse uses `EVENT_REPARSE_BROWSER_BATCH_SIZE`, hard-minimum 10, default 10, capped at 20.
- `reparseAllStoredEventLinks()` chunks unique source URLs and runs each chunk through `Promise.allSettled`, so at least ten source jobs are active together whenever ten links remain.
- `reparseStoredEventSourceUrl()` starts `openEventLinkForReview()` and exact VK API hydration in the same `Promise.all`, preventing API latency from serializing visible tab opening.
- Each review tab still inherits the V188.29 >=60s minimum dwell before final DOM/media extraction.
- A scraper browser activity lease spans the entire owner-command bulk reparse, preventing idle context shutdown between batches.
- Per-link failures are isolated and included in the final report; the next batch begins only after the current batch settles.
- Focused suite: `tests/scrapers/eventReparseBatchV18830.test.mjs` + `browserMinimumDwellV18829.test.mjs`. Syntax/import/named-import checks green.
- Preserve V188.28 source integrity and V188.26 6h/15-copy database backups. Release archives must exclude `data/`, SQLite/DB, WAL/SHM and runtime JSONL.

# V188.29 minimum-browser-dwell handoff

- Finite event link review/reparse has a hard minimum 60s dwell after the Playwright page is ready; final DOM/media extraction occurs only after the dwell.
- `Гигорейв тусы перепарсить ссылки` uses this guarded path, so a source cannot flash open and close before lazy VK/TG media has had time to load.
- Public VK and Telegram finite tabs now enforce >=60s hold (env may increase to 120s but cannot lower below 60s).
- VK chat finite post-scan hold is 60s.
- V188.28 event integrity/poster priority, V188.26 6h/15-backup policy, and V188.27 browser activity lease remain intact.
- Focused browser dwell suite: 9/9. Syntax/import/named-import checks green. Full suite: same 14 legacy failing files, no new failures.

# V188.28 source-integrity handoff

- Startup event validation is audit-only; no automatic destructive purge.
- Empty repeat parses preserve prior VK/TG/VK-chat event rows.
- VK poster precedence is real wall/repost photo > exact DOM post media > preview.
- Generic exact VK browser extraction filters avatars/logos/UI media.
- Source-link reparse merges API and browser evidence.
- `REPAIR_EVENT_DB_FROM_BACKUPS.mjs` merges only missing future event/source rows from healthy backups after writing an emergency snapshot.
- Keep V188.26 backups: every 6h, 15 retained. V188.29 supersedes the old 30s finite-source hold with a hard 60s minimum.
- Full suite has the same 14 legacy failing files as V188.27; new V188.28 integrity tests pass.

## V188.23 handoff

- Automatic remote VK history repair: newest 24h, hard cap 3500 messages. `getHistory` stops on either boundary; CMID fallback scans newest→oldest and never starts from 1 during automatic recovery.
- Explicit deep pull is owner-only in the target VK chat: `Гигорейв подтяни историю [N часов|N дней|N недель]`; bare command = 1 day. Manual pulls are time-bounded by the requested period and are not subject to the 3500 automatic cap.
- DB comparison is explicit: `saveIncomingMessage()` result changes are counted as new vs already-existing rows.
- Remote current-peer `last_message.conversation_message_id` is authoritative for the CMID ceiling; direct-source archive data is only fallback, preventing linked old-chat CMIDs from inflating the current peer range.
- Browser recovery receives the same cutoff/max and stops at the time/count boundary.
- Removed the separate automatic deep `runVkArchiveRecovery` crawler and all startup, timer, `кто вышел`, and service-report triggers for it.
- Local SQLite snapshot recovery remains deliberately full because it repairs local corruption; it does not call VK and is not part of the remote-history window policy.
- Focused history suite: 17/17. Syntax/import/named-import checks green. Full repository suite still has the same 14 legacy event/Telegram-parser failures that predate this history change.

## V188.20 handoff

- Recursive VK `copy_history` evidence depth: 4. Largest/original image per VK photo attachment; poster-anchored multimodal parsing for every real poster.
- Event parser uses two attempts per model/key candidate and advanced model escalation with persistent health filtering disabled for these independent parse operations.
- AI result wins non-empty fields; local parser is fallback-only. Bulk reparse handles multi-card sources and performs safe record matching.
- Friday is included in `weekend`; transliterated title/source/place dedupe covers Latin/Cyrillic identity variants.
- Regression: `npm run test:v18820` plus V188.19/V188.18/V188.17 suites.

## V188.15 handoff

- Startup auto-summary catch-up: `runAutoSummaryTick({ startupCatchUp: true })` runs once after durable schedule repair. An overdue cumulative slot is resolved with `resolveStartupAutoSummaryCatchUpWindow()`, extends through startup time, and is capped at the next local 06:00 bot-day boundary. The VK live-history scan ceiling now derives from `AUTO_SUMMARY_MAX_MESSAGES / AUTO_SUMMARY_VK_HISTORY_PAGE_SIZE` (100,000 / 200 = 500 pages), while stopping early as soon as the requested window start is reached.
- Token accounting: `src/features/ai/tokenUsageLogger.js` appends daily JSONL and process totals. Prefer explicit `tokenUsageOperation` labels at call sites; otherwise `inferAiTokenOperation()` provides a stable category. Provider usage is exact; missing usage is marked `estimated`, never presented as exact. `npm run tokens:report` aggregates JSONL by operation/provider/model.
- Auto-summary token labels: `auto-summary:leaf` and `auto-summary:merge`. Hierarchical summaries use `hierarchical-<period>-summary:{leaf|merge}`.
- Regression: `npm run test:v18815`; retain V188.14 event-parser tests.

## V188.14

Build: `events-v18814-venue-semantic-link-restart` (`0.188.14`).

V188.14 completes the venue/review fixes on top of V188.12. A fresh VK/Telegram source URL now escapes an existing proposal `review` state before draft-correction parsing, so a second wall link starts a new parse instead of producing «Не понял правку черновика». Venue extraction now has a deterministic Voronezh venue catalog (Тупик, Сто Ручьёв, The Last of Vavilone, DIESEL HALL / Rock Bar DIESEL, Overlock Bar, Meet Bowling, Паб Мама Анархия), semantic `в/во/на` candidates, and a bounded focused AI audit when venue remains uncertain. Poster vision facts are passed into that audit; `is_event=false` is honored. `СКОЛЬКО:` is recognized as a price label.

Regression suite: `npm run test:v18814`.

## V188.13

Internal venue-inference step included in V188.14: hard venue aliases/inflections, semantic preposition candidates, local Tupik/Diesel recovery, and poster-aware venue AI fallback. It was not shipped as a separate final archive in this conversation.

## V188.12

Build: `events-v18812-fast-proposal-moderation` (`0.188.12`).

V188.12 fixes the multi-minute pause after owner replies such as `да 5`. Approval/rejection is resolved from the already parsed `event_proposals` draft; no browser/parser pass is started. New approved rows invalidate the verified-party snapshot immediately and queue its expensive AI rebuild in the background, so the moderation reply is not blocked by snapshot generation. Runtime logs now include `EVENT PROPOSAL MODERATION FASTPATH`, `EVENT PROPOSAL MODERATION DONE`, and background snapshot completion/error timings.

## V188.11

Build: `events-v18811-vk-raw-wall-bounded-proposal-ai` (`0.188.11`).

Root cause from the V188.10 trace: direct `wall.getById` can fail with VK code 27 under group auth even though the exact wall payload is already embedded in raw `window.cur.apiPrefetchCache`. V188.10 preserved structured event objects but lost that exact wall record after SPA hydration, leaving DOM `publishedAt=0`; yearless dates therefore could not be anchored. The proposal then entered model failover, whose default `maxRounds=0` is intentionally unlimited and could run for hours when providers were unavailable.

V188.11 invariants:
1. Exact VK wall URLs recover `wall.getById` recursively from raw bootstrap before scrolling, preserving wall timestamp, exact text and only wall photo attachments. This is a priority pass, not a fixed page-template parser; generic page parsing remains the fallback.
2. If the recovered owner is an event community and the wall page itself has no `start_date`, fetch the related `/event...` page once through the authenticated Playwright request context and parse its structured bootstrap.
3. Duplicate exact DOM containers are ranked deterministically; exact links do not invoke GPT merely to choose the primary post.
4. Local parsing accepts bullet lineups and VK owner `eventTitle`. A recovered wall timestamp is valid year evidence for yearless dates.
5. Event-proposal vision/text fallback is bounded to one round, up to two candidates, one technical failure before rotation and <=20s per provider request. If deterministic parsing already has required fields plus time/title/participants, AI is skipped; missing price alone never triggers vision.
6. Operational SQLite/WAL/SHM, `.env`, browser profiles, parser traces and live credentials must not be bundled.

## V188.10

Build: `events-v18810-full-parser-trace` (`0.188.10`).

Diagnostic release: every `Предложить тусу` parse now writes a durable JSONL trace under `data/logs/event-parser/` (plus `latest.jsonl`). The trace records direct VK `wall.getById`, owner `groups.getById`, structured candidates including `start_date`, early raw VK bootstrap/HTML, finite browser scan steps, DOM extraction, primary-post selection, local parse, vision/AI result, dedupe, final draft, errors and tab cleanup. Secrets/tokens are redacted before disk write. The bot replies with the concrete trace path so a failing run can be attached verbatim.

## V188.9

Build: `events-v1889-direct-wall-owner-structured-first` (`0.188.9`).

Critical fix: exact VK wall proposal flow now queries the wall owner via `groups.getById` for `start_date`/`finish_date` before AI and before browser. If deterministic date evidence is still absent, it falls back to the finite full-page browser parser and merges the exact wall API result back in. This fixes the V188.8 hole where successful `wall.getById` bypassed the very browser/bootstrap path that contained the event `start_date`.

## V188.8

Build: `events-v1888-finite-vk-parser-early-bootstrap-fallback` (`0.188.8`).

New invariants:
1. Public VK/Telegram manual-source runs and event/proposal link reads are finite by default and close their tabs automatically. Browser closure is not the normal completion signal. Only VK chat sessions remain live-until-close.
2. VK event structured bootstrap must be snapshotted before scrolling/slow parsing. Runtime objects and raw HTML JSON bootstrap are both valid first-pass sources because the SPA may consume `apiPrefetchCache`.
3. Structured fields are evidence-first, not template-exclusive: recursively extract event-shaped objects, then preserve the ordinary DOM/meta/body/post/image parser as the fallback/enrichment stage.
4. If structured event fields are present but venue/participants/price/description are missing, merge the strongest generic page evidence into the same selected event instead of treating neighboring page fragments as unrelated events.
5. A line like `VENUE, 19 сентября в 19:00` is valid deterministic venue evidence.
6. Operational SQLite/WAL/SHM, journals, `.env`, browser profiles and live credentials must not be bundled in release archives.

---

## V188.7

Build: `events-v1887-strict-participant-summary-vk-event-evidence` (`0.188.7`).

New invariants:
1. Fuzzy participant resolution is never accepted at exactly 0.80. At least one name/nickname part must be `> 0.80`, except exact VK id/username references and explicit configured identity groups.
2. The built-in `timasin-dual-profile` group maps standalone `Тимасин`/`Тимофей` forms to exactly `Тимофей Тимофеев` and `Тимасин Тимасинский`. A different explicit full name must win over the standalone alias bridge.
3. Participant-focused summaries search the complete linked history. They include all target-profile messages plus qualifying mentions by others; every mention starts with ±10 messages of context, overlapping windows are merged, and an AI filtering pass must remove unrelated branches before final synthesis.
4. Bare/unclear `резюмируй` must return `SUMMARY_USAGE_HINT`; there is no hidden last-100 fallback. Time-based ranges must not be silently clipped to `MAX_MESSAGES`.
5. Weekly hierarchy delivery is valid only during the Sunday 20:00 `Europe/Moscow` send window. Monthly hierarchy delivery is valid only during 20:00 on the last calendar day. Startup/restart must never replay either report on later days.
6. Monthly summary source interval is current-month day 1 00:00 through last-day 20:00.
7. VK event-page extraction is two-stage: recursively inspect available structured VK bootstrap/runtime objects for event semantics + a start timestamp first; if that yields nothing, preserve the generic full-page/post/meta/image parsing path. Do not couple this to one literal `groups.getById` snippet.
8. Operational SQLite/WAL/SHM, journals, `.env`, browser profiles and live credentials must not be bundled in release archives.

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
# V188.2 developer handoff

Build: `events-v1884-compact-ai-health-grok-image` / `0.188.4`.

New invariants:
1. Default mini (`gpt-5.4-mini` family) is not a user-quota bucket anymore for direct text or default vision requests. Do not call `consumeGptModelDailyRateLimit` for mode `default`. Advanced text modes and image generation retain quota enforcement.
2. User-visible text-model labels are suppressed only when the actual selected model belongs to the default mini family. A real fallback/selection to another model may still be shown. Internal logs and interaction records retain model identity.
3. Active communication remains asynchronous and keeps its 50-message context. Its mini response has no model banner; a non-mini fallback can show its model banner. Autonomous fallback does not mutate explicit-user advanced-model quotas.
4. `полное досье` routes through the local dossier command and never replays already-checkpointed raw history merely to make the output longer. First ensure the normal command checkpoint/facts are current, then render the detailed portrait from accumulated facts.
5. Normal dossier cap remains 2,800 chars. Full dossier cap is exactly 11,200 chars.
6. Full dossier render cache is durable in `personalization-v187.sqlite`, keyed by participant + variant + content hash. Identical source facts/checkpoint must return with zero new GPT calls.
7. Operational SQLite/WAL/SHM and journals must not be bundled.

---

# V188 developer handoff

Build: `events-v188-hierarchical-chat-memory-weekly-monthly` / `0.188.0`.

New invariants:
1. Hierarchical summary state is durable and external to operational `bot.sqlite`. A content-identical historical leaf must never need another GPT call.
2. Leaf sizing is token-budget based: conservative 128k context baseline, 90% working ratio, separate system/output reserves, and recursive split on context overflow.
3. Initial bootstrap includes linked VK predecessor history plus the current peer. Later scans process only message keys/content hashes not already represented by a leaf.
4. Weekly/monthly period output is durable. Current delivery boundaries are defined by V188.7: Sunday 20:00 and last-calendar-day 20:00 only, with no later catch-up.
5. `резюмируй за день` is an operational-day range starting at 06:00 Europe/Moscow. It must never silently become the 100-message default. Before 06:00, the start is the previous calendar date at 06:00.
6. `резюмируй за сутки` remains rolling 24h and `резюмируй за неделю` remains rolling 7d. Numeric forms keep the existing rolling-duration behavior.
7. Large explicit summaries (>=5000 messages / whole history) stay owner-only.
8. No release archive may contain operational SQLite/WAL/SHM or live/archive journals.

---

# V187.2 developer handoff

Build: `events-v1872-summary-cache-linked-dossier-history` / `0.187.2`.

Invariants added in V187.2:
1. Explicit large summaries split source history into stable day-aligned batches capped at 500 messages / 90k characters. Every leaf and merge output is cached by content+model+style hash outside `bot.sqlite`; an identical repeated summary must be able to complete with zero new GPT calls.
2. Dossier source truth is the union of canonical `messages` and `vk_message_archive`. Archive rows win cross-store duplicates so their physical `source_peer_id` is preserved.
3. Dossier cursors are per `(canonical peer, user, source peer)`. V187's single cursor is migrated only to the current peer, intentionally leaving newly discovered predecessor peers unprocessed.
4. Archive-only participant IDs participate in fuzzy VK name resolution.
5. Local backup-history scanning has an external durable checkpoint. It is skipped only when source-peer configuration matches and the current main DB has not fallen below the saved row count. `VK_FORCE_LOCAL_HISTORY_SCAN=1` forces a rescan.
6. Once the normal VK history endpoint has already fallen back successfully to `getByConversationMessageId`, later completed runs reuse that method and start after the previous CMID instead of replaying 500 old CMIDs.
7. Operational state SQLite files are never bundled in release archives.

---

# V183 developer handoff

Build: `events-v183-autosummary-persistent-ai-0600-day` / `0.183.0`.

Current V183 autoresume invariants:
1. Scheduled autoresume with non-empty history is AI-only. No local/emergency transcript, raw excerpt dump, or deterministic fallback may ever be delivered to the chat.
2. A failed AI generation does not advance `next_run_at` and does not mark the run finished. The same due slot retries indefinitely every 30 seconds after each failed attempt.
3. Retries rotate configured GPT modes (`pro3`, `pro2`, `gpt55`, `gpt54`, `pro`, `default`) using durable `consecutiveFailures`, so restart does not reset the model-retry sequence.
4. The former 90-second timeout around the whole multi-chunk summary is removed. Individual GPT network calls remain bounded by the existing OpenAI request timeout; peer watchdog is 90 minutes to avoid duplicate concurrent summary jobs.
5. Reporting-day boundary is 06:00 in `Europe/Moscow`. Normal slots are cumulative from 06:00; day-only mode is scheduled at 06:00 and covers previous 06:00→current 06:00. Persisted pre-V183 day-only 00:00 schedules are migrated on startup.
6. Every numbered release must include PATCH_NOTES before packaging. V183 uses `PATCH_NOTES_V183.txt`.
7. Full-source ZIP must not contain operational `data/bot.sqlite`, WAL/SHM, or live/archive journals.

---

# V182 developer handoff

Build: `events-v182-leaver-period-auto-participant-dm` / `0.182.0`.

Current V182 invariants:
1. `кто вышел` manual periods: today, rolling day/N days/week, and current calendar week; timestamps use `Europe/Moscow`.
2. `кто вышел авто день|N дней|неделя` is owner-only, stored in `chat_leaver_auto_settings`, and survives restart. A late run covers from the previous successful boundary instead of discarding exits.
3. Leaver/member/actor names remain VK-native clickable mentions (`[id<id>|name]`); conversation URLs are never synthesized.
4. `лс участникам <text>` and `лс участникам активным N дней <text>` are explicit owner-only commands in a VK group conversation. Current roster is authoritative; active filtering uses durable `messages` history.
5. Participant DM broadcast is sequential and reports VK delivery failures. No background unsolicited broadcast is enabled without the explicit command.
6. Every numbered release must have PATCH_NOTES before packaging. V182 uses `PATCH_NOTES_V182.txt`.
7. Full-source ZIP must not contain operational `data/bot.sqlite`, `bot.sqlite-wal`, `bot.sqlite-shm`, `live-message-journal.jsonl`, or `vk-message-archive-journal.jsonl`.

---

# V161 developer handoff

Build: `events-v161-autosummary-delivery-guarantee` / `0.161.0`.

Ключевые инварианты авторезюме:
1. `next_run_at` двигается только после успешной отправки или уже зафиксированного finished run.
2. Никакого stale-skip по lateness больше нет.
3. После downtime применяется `coalesceOverdueAutoSummaryRunAt`: для накопительных слотов отправляется последний due slot, чтобы не спамить устаревшими промежуточными резюме.
4. Ошибка оставляет слот due и ставит только in-memory retry delay 60s.
5. VK history = local SQLite first + optional API enrichment; API failure non-fatal when local data exists.
6. VK send/history tries preferred endpoint, then alternate endpoint.
7. Delivery health stored in dedicated `auto_summary_health` table inside durable auto-summary SQLite.
8. `авторезюме сейчас` is a manual delivery self-test.

## V163

Root causes fixed for active communication:
1. The runtime used a per-peer Promise queue and awaited it inline from the incoming message handler. A single OpenAI call could remain pending up to the global 15-minute request timeout, leaving every later autonomous turn behind the same unresolved Promise.
2. Autonomous mode randomly selected only `pro`/`pro2`. `resolveGptModel()` accepts configured/default IDs without proving the endpoint actually serves those IDs, so a router that handled the normal default model but not Luna/Terra could make active communication fail on every attempt while normal bot replies still worked.
3. Active send had no dedicated timeout and failures were only visible in console logs.

V163 detaches autonomous work from the incoming handler, uses finite watchdogs, falls back through model modes and GigaChat, and exposes runtime health in `активное общение статус`.

## V164

Voice transcription invariants:
1. Native VK `audio_message.transcript` wins and is persisted immediately.
2. Missing VK transcripts fall back to downloadable `link_mp3`/`link_ogg`, including `doc.preview.audio_msg` and nested forwarded/repost structures.
3. Telegram voice-only updates must enter `onMessage`; `getFile` download and STT happen inside the detached message task, so long polling/menu remain independent.
4. `voice_transcripts(platform, attachment_key)` is the durable cache. Successful transcripts survive restarts and repeated manual history scans.
5. STT errors never crash message handling. They store `status=error` + `retry_after`; normal text/image/repost logic continues unchanged.
6. VK chat event hydration injects voice text before event-candidate routing. This is especially important for `peer_id=2000000022`: spoken date/time/place plus an attached poster are one event evidence packet.
7. VK auto-summary API history enrichment also resolves voices. Telegram auto-summary gets voice text because live Telegram voice messages are saved to the ordinary `messages` table after transcription.
8. Provider order: explicit `AUDIO_TRANSCRIPTION_*` -> direct OpenAI key -> Groq key -> existing OpenAI-compatible router. Override model list with `AUDIO_TRANSCRIPTION_MODELS`.

## V177 lossless VK service archive
- `vk_message_archive` stores every VK payload obtainable from Long Poll/CMID recovery: normal, outbox and service/action messages.
- Raw `action_json` and `raw_message_json` are preserved in `bot.sqlite`.
- New live VK payloads use `data/vk-message-archive-journal.jsonl` before SQLite.
- V177 runs a separate full CMID archive pass using maintenance key `vk-archive-recovery-v177:*`.
- Commands: `Гигорейв список кто вышел` and `Гигорейв отчёт служебных` / `Гигорейв служебные сообщения`.

## V179 linked-chat archive recovery

- Active chat archive state from V177 is preserved and is not re-downloaded.
- Linked predecessor chats now start at the locally known `min_cmid` instead of CMID 1.
- If a linked/deleted chat returns five consecutive empty CMID batches inside a locally known populated range, the API scan stops and the source is marked `unavailableViaApi`; local SQLite backups remain the source of truth for that predecessor chat.
- Commands reporting leavers/service events explicitly disclose when an old linked chat is unavailable through VK API instead of pretending that indexing is still running forever.
- No database file is bundled with the source archive.


## V184 event cache invariant
Verified event snapshots are caches only. Party commands must compare sourceRevision against current configured SQLite event rows and immediately fall back to SQLite on any mismatch. Never return an empty party list solely because a snapshot exists.

## V188.3 model reliability and chat style

- Normal user-facing text, vision, image, GigaChat, external-provider chat, STT and NVIDIA Visual paths use credential failover: 3 technical failures on one key, then rotate.
- `AI_FAILOVER_MAX_ROUNDS=0` keeps retrying temporary outages across the configured key/provider pool; invalid requests and policy/content refusals are not retried forever.
- Optional xAI runtime fallback uses `XAI_API_KEY[_N]`, `https://api.x.ai/v1`, `grok-4.6` for text/vision and `grok-imagine-image-2.0` for image generation.
- Durable `communication_style_examples` stores real participant messages. Direct and active-chat prompts use these examples to imitate actual syntax, brevity, vocabulary and punctuation; default response style is one short chat sentence unless more detail is needed.

## V188.49 — AI model discovery + mandatory Swiss Ephemeris
- `src/features/ai/modelDiscoveryScheduler.js`: durable 03:00 Europe/Moscow discovery schedule (daily 14 days, then Monday weekly), full new-model qualification, JSONL logs and owner report formatting.
- `ai_model_discovery` SQLite registry stores every seen model and qualification state.
- New models are quarantined until live qualification. Qualified compatible models are appended after the static ladder; never replace default/cheap stages.
- `натал` / `прашна` are hard-gated on local Swiss Ephemeris. No model self-calculation path. Deploy must set `EPHEMERIS_PATH` to a directory containing `*.se1`.
- Logs: `data/logs/model-discovery/`, `AI_FULL_AUDIT_RESULTS/`, and `data/logs/operations/`.

## V188.54 parser/model-ladder audit patch (2026-09-13)

See `V18854_RELEASE_NOTES.md`. This patch makes autonomous communication cheap-first, raises too-short parser/active-communication AI timeouts to realistic 75s defaults, and bounds manual parser retry cycles/elapsed time. It preserves V188.51–V188.53 media/DB fixes.

## V188.55 — fresh-log boundary

Build: `events-v18855-fresh-runtime-logs` (`0.188.55`).

1. `src/index.js` runs `clearPreviouslyProcessedLogsV18855()` only after acquiring the single-instance lock and before importing the application runtime.
2. The cleanup function has an explicit volatile-artifact allowlist. It must never be generalized to delete arbitrary `data/` contents.
3. `data/.log-cleanup-v18855.done.json` makes cleanup one-time. Restarts preserve all logs created after the V188.55 boundary.
4. `FORCE_V18855_LOG_CLEANUP=1` is the only supported forced re-clean switch.
5. SQLite databases, WAL/SHM, healthy/corruption backups, message journals, operation checkpoints and LocalAppData state are invariants: never delete them during log cleanup.
6. Preserve V188.53 media fix and V188.54 bounded manual parser + cheap-first active communication routing.

## V188.56 — index-only SQLite repair-first preflight

Build: `events-v18856-index-repair-first` (`0.188.56`).

The V188.55 preflight treated every failed `PRAGMA quick_check` as general corruption. V188.56 narrows the special repair path to diagnostics consisting only of `wrong # of entries in index ...` / `row N missing from index ...`. The complete SQLite family is copied to the existing corruption-backup directory before any repair. `REINDEX` is then attempted against the active DB; success is accepted only after both `quick_check` and `integrity_check` are `ok`. If either check fails, the prior WAL/healthy-backup/logical-salvage flow runs unchanged. Do not broaden the classifier to malformed pages, duplicate unique-index entries, schema damage, or mixed errors.

## V188.60 parser-all poster refresh

See `V18860_RELEASE_NOTES.md` and `PARSER_LOG_AUDIT_V18860.md`. Manual VK public parser runs now recheck media for same-source DB-known posts, reject profile avatars/preview-only media, preserve multi-poster ownership, protect partial reparses from deleting unmatched rows, and perform one finite completeness retry when a multi-announcement digest collapses to 0–1 extracted events.
