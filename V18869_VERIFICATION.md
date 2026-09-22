# Gigorave V188.69 verification

Build: `events-v18869-startup-responsive-history-recovery-r1`

## Startup responsiveness fix

The startup delay reported after V188.68 was traced to local SQLite history recovery running synchronously on the Node main thread. `runDetachedSupervisedOperation()` detached the Promise but did not move synchronous work off the event loop. A full local recovery could therefore scan ~900k rows while VK Long Poll was already started, starving command handlers until the scan finished.

V188.69 changes this in three layers:

1. `recoverHistoryFromLocalSqliteBackups()` is asynchronous and paged in bounded batches (default 250 rows), yielding with `setImmediate()` after each batch and each source file.
2. Startup history recovery begins only after transport readiness, with a default 5 second delay (`VK_HISTORY_STARTUP_DELAY_MS`, bounded 1-60s). The runtime logs `[BOT READY] ... commands=available-now` before the maintenance recovery begins.
3. Local-history checkpoint validation now treats monotonic coverage growth as healthy when the source inventory is unchanged. New/fill-in rows no longer force a complete immutable-backup rescan. Regressed coverage, changed source inventory, peer-map changes, or forced recovery still trigger the safety scan.

GigaChat startup probing and Telegram reconnect were already detached in V188.68 and remain non-blocking.

## Verification

- Syntax check: OK
- Import check: OK
- Named-import check: OK
- V188.69 startup/history regression suite: 13/13 passed
- V188.68 media/sanitation/repost/dedupe regression suite: 28/28 passed
- Active release suite: 103/103 passed
- Release runtime-data guard: OK

No user SQLite database, WAL/SHM, `data/`, logs, or runtime state is included in the release archive.
