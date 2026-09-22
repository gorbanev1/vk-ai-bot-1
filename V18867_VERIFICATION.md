# V188.67 verification

## Static/release gates

- `npm run check:syntax` — OK (462 files)
- `npm run check:imports` — OK (462 files)
- `npm run check:named-imports` — OK (172 files, missing=0)
- `npm run test:v18867` — OK (56/56)
- `npm test` / active regression suite — OK (71/71)
- `npm run check:release-clean` — OK

## Single-open and chat unread-tail audit

The supplied historical DOM snapshots explain the VK-chat failure mode directly. In
`logs/manual-parser/2026-09-13T14-31-51-707Z_parser-all_893fc1/` the first
`chat-2000000003.001.window-001.dom.html` contains:

- `.ConvoHistory__unreadSeparator` / heading `Новые сообщения`;
- button `Перейти к непрочитанным сообщениям. 114 сообщений`;
- visible `data-itemkey` range 117451..117480.

The last old upward-only window from the same run has visible range 117322..117480.
The minimum CMID moved upward into history, while the maximum CMID stayed 117480.
That proves the old algorithm never traversed the unread tail below VK's last-read
starting position.

V188.67 now records the initial stable CMID frontier, detects both DOM unread markers
and actual remaining scroll distance, sweeps DOWN on the same page until bottom, then
walks UP again. For clean mode, ordinary target-count cannot stop the scan until the
initial frontier has been reached again. Full mode then continues its historical
backfill above that frontier.

Single-open invariants checked in code/regressions:

- manual source wrapper calls `startManualScraperSource(source.id, options)` once;
- target-close and ordinary failure cannot auto-open a recovery source tab;
- manual VK-public capture has one capture attempt and a reusable finite source page;
- VK-chat uses one `vk-chat:<peerId>` reusable page for both scroll directions;
- Telegram finite pagination keeps the same `telegram-public:<channel>` page;
- parser-all poster maintenance is forbidden from calling browser poster recovery after source capture;
- startup `about:blank` is reused; surplus blank tabs are cleaned; blank-only Chromium is closed promptly after the last parser lease, while meaningful owner pages prevent cleanup.

## Submitted DB copy

Input family used only as a copy: `bot(10).sqlite`, `bot(10).sqlite-wal`, `bot(10).sqlite-shm`.
The V188.67 DB module was initialized against the copied DB only.

After migration/check:
- `PRAGMA quick_check` — `ok`
- `PRAGMA foreign_key_check` — no rows
- provenance columns exist on all four event tables
- poster match/audit columns exist on all four event tables
- source-side vision fact columns exist on VK/Telegram source tables

Observed real problem records after provenance backfill:
- Liverpool source post `wall-95062430_2705`: child events on 2026-09-19, 2026-09-20 and 2026-09-26 all retain the same canonical wall URL while keeping separate stored JPEG paths.
- VK chat CMID 4928 (`Юбилейная 5-я вылазка-знакомство…`): canonical origin is recovered as `https://vk.ru/wall34296976_8093`; chat identity/CMID remain separate origin metadata.
- Stored venue for that chat event remains `в уютной усадьбе` and is not erased by the migration.

## Historical media/provenance cross-check

The supplied parser logs confirm that source post 2705 exposed six images and that
Poster Vision ran per image. Historical DB state had three separate Liverpool child
image paths. V188.67 no longer uses JPEG exclusivity as proof; each child must
independently pass date+title / date+strong-facts matching, and a single verified
calendar poster may be shared when each child independently matches.

For CMID 4928 the saved raw source contains both the chat text and `wall34296976_8093`,
validating chat provenance resolution instead of treating the conversation/search URL
as the event source.

## Environment limitation

A live `парсер все` network/AI/browser re-run was not executed in this build environment
because the submitted release source intentionally contains no runtime `.env`
credentials or authenticated browser session. No success is claimed for a network
operation that could not be performed. The navigation logic was instead matched against
the supplied real DOM snapshots, and the migration, persistence, matching, formatter,
clean/full-mode routing, single-open browser lifecycle, regression suite, submitted-DB
integrity, and historical raw/trace data were checked locally.

## Media-compatibility regression fix

The first V188.67 release candidate exposed an upgrade-compatibility bug: existing V188.66 rows had durable `image_paths_json`, but the newly added `poster_match_status` column started empty. Public delivery therefore rejected all such images even though the files were still present.

A second idempotent compatibility migration (`events-v18867-legacy-poster-compat-v3`) now restores only structurally unambiguous legacy bindings; it does not reintroduce a generic first-photo fallback.

Real submitted DB-copy verification after the new migration:

- `vk_events.id=91`, wall `-226190294_1153`: `vk_announcements/idmamaanarchy/1153-1.jpg` -> `legacy_single_source_poster`, image index 1;
- `vk_chat_events.id=21`, `DANSE MACABRE PARTY`, CMID 4420: canonical wall `-240869396_3`, one source image -> `legacy_single_repost_poster`, image index 1;
- `vk_chat_events.id=15` and `id=22` (`NO PLACE FOR OLD PADS`) likewise restore as single-image wall reposts;
- `vk_chat_events.id=11`, `Юбилейная 5-я вылазка-знакомство`, CMID 4928: two source image URLs -> legacy status remains empty and the old chat image is not auto-restored.

Compatibility totals on the submitted DB copy:

- VK public: 17 `legacy_single_source_poster`, 3 `legacy_unique_source_poster`;
- Telegram: 6 `legacy_single_source_poster`;
- manual: 3 `legacy_manual_poster`;
- VK chat: 6 `legacy_single_repost_poster`; 4 legacy chat rows remain intentionally untrusted.

SQLite after this migration: `PRAGMA quick_check = ok`; `PRAGMA foreign_key_check` = 0 rows.

Updated regression gates:

- `npm run test:v18867` — OK (57/57)
- active regression suite — OK (72/72)
- syntax — OK (462 files)
- imports — OK (462 files)
- named imports — OK (172 files, missing=0)
- release runtime-data guard — OK

## Runtime media root / snapshot / log-boundary hotfix

User screenshots confirmed that poster JPEG files exist locally while public cards were still text-only. A concrete path inconsistency was found in code: database/runtime paths are project-root based, but `EVENT_IMAGE_ROOT` used `resolve('./data')`, which depends on the shell/service working directory. This can make every stored poster path fail `existsSync()` even though the files are present beside the real runtime DB.

Applied fixes:
- `EVENT_IMAGE_ROOT = RUNTIME_DATA_DIRECTORY`;
- verified snapshot file now lives in `resolveRuntimeDataDirectory()`;
- `EVENT_VERIFIED_SNAPSHOT_VERSION` bumped 6 -> 7;
- build id bumped to `events-v18867-provenance-multi-poster-repair-r4-media-path`, forcing a new per-build volatile-log cleanup boundary;
- startup log cleanup is rooted at project root, not arbitrary process cwd.

Regression results after the hotfix:
- `npm run test:v18867` — 67/67 passed;
- active suite — 75/75 passed;
- syntax — OK (464 files);
- imports — OK (464 files);
- named imports — OK (173 files, missing=0);
- release runtime-data guard — OK.

Submitted DB-copy recheck after current migrations:
- `PRAGMA quick_check` = `ok`;
- `PRAGMA foreign_key_check` = 0 rows;
- `wall-226190294_1189` (`МАНАГЕР`) retains `vk_announcements/idmamaanarchy/1189-1.jpg` and `legacy_single_source_poster`;
- `wall-226190294_1153` retains `vk_announcements/idmamaanarchy/1153-1.jpg` and `legacy_single_source_poster`.

A live filesystem check against the user's current machine still requires the current runtime DB family/log if further anomalies remain, because the user's local `data/` tree is not mounted in this environment. The code-level cwd mismatch itself is deterministic and covered by regression.
