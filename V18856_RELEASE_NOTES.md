# V188.56 — SQLite index repair first

The startup preflight now distinguishes a narrow class of index-only `PRAGMA quick_check` failures from general database corruption.

For diagnostics such as:

- `wrong # of entries in index ...`
- `row N missing from index ...`

the bot first copies `bot.sqlite`, `bot.sqlite-wal` and `bot.sqlite-shm` to the timestamped corruption backup, then runs `REINDEX` against the same active database. The repair is accepted only when both `PRAGMA quick_check` and `PRAGMA integrity_check` return `ok`.

If REINDEX does not fully repair the database, the prior V188.53–V188.55 WAL/healthy-backup/salvage recovery remains unchanged. The lineage guard remains enabled and prevents creating a new healthy backup over missing older history.

This avoids replacing the whole active database merely because index entry counts became inconsistent after a crash/interrupted WAL sequence.
