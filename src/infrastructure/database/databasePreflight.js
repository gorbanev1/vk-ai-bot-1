/**
 * V160 database preflight.
 *
 * Runs before src/index.js so a damaged release-local SQLite file cannot stop
 * the whole bot from booting. The durable auto-summary database lives outside
 * this path and is intentionally not touched here.
 */
import {
    copyFileSync,
    existsSync,
    mkdirSync,
    readdirSync,
    renameSync,
    rmSync,
    statSync,
    unlinkSync,
    utimesSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import {
    buildHistoricalRecoveryCandidate,
    compareDatabaseLineage,
} from './databaseLineageGuard.js';
import {
    assertTestDatabaseIsolation,
    resolveMainDatabasePath,
} from './runtimePaths.js';

const defaultDatabasePath = resolveMainDatabasePath();
const defaultDataDirectory = dirname(defaultDatabasePath);
assertTestDatabaseIsolation({ databasePath: defaultDatabasePath });
export const HEALTHY_BACKUP_INTERVAL_MS = 6 * 60 * 60 * 1000;
export const HEALTHY_BACKUP_LIMIT = 15;
const HEALTHY_BACKUP_RETRY_MS = 10 * 60 * 1000;

function timestamp(now = Date.now()) {
    return new Date(now).toISOString().replaceAll(':', '-').replaceAll('.', '-');
}

function safeUnlink(path) {
    try {
        if (existsSync(path)) unlinkSync(path);
    } catch {
        // Best effort only. A later open will surface a meaningful error.
    }
}

function quoteIdentifier(value) {
    return `"${String(value).replaceAll('"', '""')}"`;
}

function sqliteErrorLooksCorrupt(error) {
    const text = `${error?.message ?? ''} ${error?.code ?? ''} ${error?.errstr ?? ''}`.toLowerCase();
    return text.includes('malformed')
        || text.includes('database disk image is malformed')
        || text.includes('database corruption')
        || text.includes('file is not a database')
        || text.includes('not a database')
        || Number(error?.errcode) === 11;
}


function splitSqliteHealthMessages(detail) {
    return String(detail ?? '')
        .split(';')
        .map((item) => item.trim())
        .filter(Boolean);
}

/**
 * V188.56: PRAGMA quick_check reports index b-tree inconsistencies with
 * messages such as `wrong # of entries in index ...`. Those failures do not
 * by themselves prove that table rows are damaged. Treat only the narrow,
 * well-understood index diagnostics as eligible for an in-place REINDEX.
 */
export function isIndexOnlySqliteHealthFailure(detail) {
    const messages = splitSqliteHealthMessages(detail);
    if (!messages.length) return false;
    return messages.every((message) => {
        const normalized = message.toLowerCase();
        return /^wrong # of entries in index\s+/u.test(normalized)
            || /^row \d+ missing from index\s+/u.test(normalized);
    });
}

function runSqliteIntegrityCheck(databasePath) {
    let db;
    try {
        db = new DatabaseSync(databasePath, { readOnly: true });
        const rows = db.prepare('PRAGMA integrity_check').all();
        const messages = rows.flatMap((row) => Object.values(row).map((value) => String(value ?? '')));
        const ok = messages.length === 1 && messages[0].trim().toLowerCase() === 'ok';
        return { ok, detail: ok ? 'ok' : messages.join('; ') || 'integrity_check failed' };
    } catch (error) {
        return { ok: false, detail: String(error?.message ?? error) };
    } finally {
        try {
            db?.close();
        } catch {
            // Ignore close errors during integrity diagnosis.
        }
    }
}

/**
 * Rebuild indexes without replacing the active database. The caller must have
 * already copied the complete SQLite family for forensic rollback.
 */
export function tryRepairIndexOnlyCorruption({ databasePath, health, logger = console } = {}) {
    const initialHealth = health ?? checkSqliteHealth(databasePath);
    if (initialHealth.ok || !initialHealth.exists) {
        return { attempted: false, repaired: false, reason: 'database-already-healthy', initialHealth };
    }
    if (!isIndexOnlySqliteHealthFailure(initialHealth.detail)) {
        return { attempted: false, repaired: false, reason: 'not-index-only', initialHealth };
    }

    let db;
    try {
        db = new DatabaseSync(databasePath);
        db.exec('PRAGMA busy_timeout = 15000');
        // REINDEX without a target rebuilds every index in every attached DB.
        // At preflight time only the main database is attached.
        db.exec('REINDEX');
    } catch (error) {
        return {
            attempted: true,
            repaired: false,
            reason: 'reindex-failed',
            initialHealth,
            error: String(error?.message ?? error),
        };
    } finally {
        try {
            db?.close();
        } catch {
            // Ignore.
        }
    }

    const quickCheck = checkSqliteHealth(databasePath);
    const integrityCheck = quickCheck.ok
        ? runSqliteIntegrityCheck(databasePath)
        : { ok: false, detail: 'skipped because quick_check still fails' };
    const repaired = quickCheck.ok && integrityCheck.ok;
    if (repaired) {
        logger.warn?.(
            '[DB PREFLIGHT] index-only inconsistency repaired with REINDEX; active database rows were preserved and no backup restore was performed.',
        );
    }
    return {
        attempted: true,
        repaired,
        reason: repaired ? 'reindexed' : 'post-reindex-health-failed',
        initialHealth,
        quickCheck,
        integrityCheck,
    };
}

export function checkSqliteHealth(databasePath) {
    if (!existsSync(databasePath)) {
        return { exists: false, ok: true, detail: 'missing' };
    }

    let db;
    try {
        db = new DatabaseSync(databasePath, { readOnly: true });
        const rows = db.prepare('PRAGMA quick_check').all();
        const messages = rows.flatMap((row) => Object.values(row).map((value) => String(value ?? '')));
        const ok = messages.length === 1 && messages[0].trim().toLowerCase() === 'ok';
        return {
            exists: true,
            ok,
            detail: ok ? 'ok' : messages.join('; ') || 'quick_check failed',
        };
    } catch (error) {
        return {
            exists: true,
            ok: false,
            detail: String(error?.message ?? error),
            corrupt: sqliteErrorLooksCorrupt(error),
        };
    } finally {
        try {
            db?.close();
        } catch {
            // Ignore close errors during corruption diagnosis.
        }
    }
}

function copyDatabaseFamily(sourceDatabasePath, destinationDirectory) {
    mkdirSync(destinationDirectory, { recursive: true });
    const copied = [];
    for (const suffix of ['', '-wal', '-shm']) {
        const source = `${sourceDatabasePath}${suffix}`;
        if (!existsSync(source)) continue;
        const destination = join(destinationDirectory, `bot.sqlite${suffix}`);
        copyFileSync(source, destination);
        copied.push(destination);
    }
    return copied;
}

function isHealthyBackupName(name) {
    return /^bot-(?:startup|healthy)-.*\.sqlite$/u.test(String(name ?? ''));
}

function healthyBackupCandidates(backupDirectory) {
    if (!existsSync(backupDirectory)) return [];
    return readdirSync(backupDirectory)
        .filter(isHealthyBackupName)
        .map((name) => join(backupDirectory, name))
        .filter((path) => {
            try {
                return statSync(path).isFile();
            } catch {
                return false;
            }
        })
        .sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs);
}

export function latestHealthyBackup(backupDirectory) {
    const candidates = healthyBackupCandidates(backupDirectory);
    return candidates[0] ?? '';
}

function rotateHealthyBackups(backupDirectory) {
    const candidates = healthyBackupCandidates(backupDirectory);
    for (const stale of candidates.slice(HEALTHY_BACKUP_LIMIT)) {
        safeUnlink(stale);
    }
}

function sqliteStringLiteral(value) {
    return `'${String(value).replaceAll("'", "''")}'`;
}

/**
 * Create a transactionally consistent SQLite snapshot. VACUUM INTO reads the
 * live WAL state as one database snapshot, so the backup does not depend on
 * copying bot.sqlite at exactly the right instant while the bot is writing.
 * The file is accepted only after PRAGMA quick_check succeeds.
 */
function createValidatedHealthyBackup(databasePath, dataDirectory, now = Date.now()) {
    const backupDirectory = join(dataDirectory, 'healthy-backups');
    mkdirSync(backupDirectory, { recursive: true });

    const destination = join(backupDirectory, `bot-healthy-${timestamp(now)}.sqlite`);
    const temporary = `${destination}.tmp`;
    safeUnlink(temporary);

    let db;
    try {
        db = new DatabaseSync(databasePath, { readOnly: true });
        db.exec('PRAGMA busy_timeout = 15000');
        db.exec(`VACUUM INTO ${sqliteStringLiteral(temporary)}`);
    } finally {
        try {
            db?.close();
        } catch {
            // Ignore.
        }
    }

    const backupHealth = checkSqliteHealth(temporary);
    if (!backupHealth.ok) {
        safeUnlink(temporary);
        throw new Error(`new healthy backup failed quick_check: ${backupHealth.detail}`);
    }

    renameSync(temporary, destination);
    try {
        const createdAt = new Date(now);
        utimesSync(destination, createdAt, createdAt);
    } catch {
        // Filesystem timestamp precision is not required for backup validity.
    }
    rotateHealthyBackups(backupDirectory);
    return destination;
}

function compareAgainstLatestHealthyBackup(databasePath, dataDirectory) {
    const backupPath = latestHealthyBackup(join(dataDirectory, 'healthy-backups'));
    if (!backupPath || !existsSync(databasePath)) {
        return { checked: false, regressed: false, backupPath: '', report: null };
    }

    const backupHealth = checkSqliteHealth(backupPath);
    if (!backupHealth.ok) {
        return {
            checked: false,
            regressed: false,
            backupPath,
            report: null,
            skippedReason: `backup-unhealthy:${backupHealth.detail}`,
        };
    }

    const report = compareDatabaseLineage({
        activeDatabasePath: databasePath,
        backupDatabasePath: backupPath,
    });
    return {
        checked: true,
        regressed: report.regressed,
        backupPath,
        report,
    };
}

function logLineageRegression(logger, lineage) {
    const report = lineage?.report;
    if (!report?.regressed) return;
    logger.error?.(
        '[DB LINEAGE GUARD] ACTIVE_DB_OLDER_THAN_BACKUP:',
        `backup=${lineage.backupPath}`,
        `backupOnly=${report.backupOnlyRows}`,
        `activeOnly=${report.activeOnlyRows}`,
        `activeOnlyTail=${report.activeOnlyTailRows}`,
        'New active-only rows do NOT cancel missing backup history; healthy-backup creation is blocked.',
    );
    for (const table of report.tables ?? []) {
        if (!Number(table?.backupOnlyRows ?? 0)) continue;
        logger.error?.(
            '[DB LINEAGE GUARD TABLE]',
            `table=${table.table}`,
            `missingFromActive=${table.backupOnlyRows}`,
            `newTail=${table.activeOnlyTailRows ?? 0}`,
            `backupRows=${table.backupRows ?? 0}`,
            `activeRows=${table.activeRows ?? 0}`,
        );
    }
}

function maybeCreateHealthyBackup(databasePath, dataDirectory, now = Date.now()) {
    if (!existsSync(databasePath)) return { path: '', created: false };
    const backupDirectory = join(dataDirectory, 'healthy-backups');
    mkdirSync(backupDirectory, { recursive: true });
    const latest = latestHealthyBackup(backupDirectory);
    if (latest) {
        try {
            if (now - statSync(latest).mtimeMs < HEALTHY_BACKUP_INTERVAL_MS) {
                return { path: latest, created: false };
            }
        } catch {
            // Continue and create a fresh backup.
        }
    }

    const path = createValidatedHealthyBackup(databasePath, dataDirectory, now);
    return { path, created: true };
}

export function createHealthyBackupIfDue({
    databasePath = defaultDatabasePath,
    dataDirectory = dirname(databasePath),
    now = Date.now(),
} = {}) {
    const health = checkSqliteHealth(databasePath);
    if (!health.exists) return { ok: true, created: false, path: '', reason: 'missing' };
    if (!health.ok) return { ok: false, created: false, path: '', reason: 'unhealthy', health };

    const lineage = compareAgainstLatestHealthyBackup(databasePath, dataDirectory);
    if (lineage.regressed) {
        return {
            ok: false,
            created: false,
            path: lineage.backupPath,
            reason: 'lineage-regression',
            health,
            lineage,
        };
    }

    const backup = maybeCreateHealthyBackup(databasePath, dataDirectory, now);
    return { ok: true, ...backup, health, lineage };
}

export function startHealthyBackupScheduler({
    databasePath = defaultDatabasePath,
    dataDirectory = dirname(databasePath),
    logger = console,
    now = () => Date.now(),
    setTimeoutFn = setTimeout,
    clearTimeoutFn = clearTimeout,
} = {}) {
    let timer = null;
    let stopped = false;

    const schedule = (delayMs) => {
        if (stopped) return;
        timer = setTimeoutFn(run, Math.max(1_000, delayMs));
        timer?.unref?.();
    };

    const nextDelay = () => {
        const latest = latestHealthyBackup(join(dataDirectory, 'healthy-backups'));
        if (!latest) return HEALTHY_BACKUP_INTERVAL_MS;
        try {
            const age = Math.max(0, now() - statSync(latest).mtimeMs);
            return Math.max(1_000, HEALTHY_BACKUP_INTERVAL_MS - age);
        } catch {
            return HEALTHY_BACKUP_RETRY_MS;
        }
    };

    const run = () => {
        if (stopped) return;
        try {
            const result = createHealthyBackupIfDue({
                databasePath,
                dataDirectory,
                now: now(),
            });
            if (!result.ok) {
                if (result.reason === 'lineage-regression') {
                    logLineageRegression(logger, result.lineage);
                    logger.error?.('[DB HEALTHY BACKUP] blocked: active DB is missing history that exists in a healthy backup.');
                } else {
                    logger.error?.('[DB HEALTHY BACKUP] skipped because active SQLite is unhealthy:', result.health?.detail ?? result.reason);
                }
                schedule(HEALTHY_BACKUP_RETRY_MS);
                return;
            }
            if (result.created) {
                logger.log?.('[DB HEALTHY BACKUP]', `created=${result.path} retained=${HEALTHY_BACKUP_LIMIT} intervalHours=6`);
            }
            schedule(nextDelay());
        } catch (error) {
            logger.error?.('[DB HEALTHY BACKUP] periodic backup failed:', error?.message ?? error);
            schedule(HEALTHY_BACKUP_RETRY_MS);
        }
    };

    schedule(nextDelay());
    logger.log?.('[DB HEALTHY BACKUP SCHEDULER]', `intervalHours=6 retained=${HEALTHY_BACKUP_LIMIT}`);

    return {
        stop() {
            stopped = true;
            if (timer) clearTimeoutFn(timer);
            timer = null;
        },
    };
}

function restoreHealthyBackup(databasePath, dataDirectory) {
    const backup = latestHealthyBackup(join(dataDirectory, 'healthy-backups'));
    if (!backup) return '';
    copyFileSync(backup, databasePath);
    safeUnlink(`${databasePath}-wal`);
    safeUnlink(`${databasePath}-shm`);
    return checkSqliteHealth(databasePath).ok ? backup : '';
}

function copyRowsBestEffort({ source, target, tableName, columns }) {
    if (!columns.length) return { copied: 0, error: '' };
    const quotedTable = quoteIdentifier(tableName);
    const quotedColumns = columns.map(quoteIdentifier).join(', ');
    const placeholders = columns.map(() => '?').join(', ');
    const insert = target.prepare(`INSERT OR IGNORE INTO ${quotedTable} (${quotedColumns}) VALUES (${placeholders})`);
    let copied = 0;
    let errorText = '';

    try {
        for (const row of source.prepare(`SELECT ${quotedColumns} FROM ${quotedTable}`).iterate()) {
            try {
                insert.run(...columns.map((column) => row[column]));
                copied += 1;
            } catch {
                // One invalid row must not stop recovery of the rest of a readable table.
            }
        }
    } catch (error) {
        errorText = String(error?.message ?? error);
    }
    return { copied, error: errorText };
}

/**
 * Creates a logically recovered database from a quarantined SQLite family.
 * It intentionally works table-by-table so a damaged page in one table does
 * not prevent readable rows from other tables being kept.
 */
export function salvageDatabase({ sourceDatabasePath, targetDatabasePath }) {
    safeUnlink(targetDatabasePath);
    safeUnlink(`${targetDatabasePath}-wal`);
    safeUnlink(`${targetDatabasePath}-shm`);

    let source;
    let target;
    const result = {
        tablesCreated: 0,
        rowsCopied: 0,
        tablesWithReadErrors: [],
        schemaReadable: false,
    };

    try {
        source = new DatabaseSync(sourceDatabasePath, { readOnly: true });
        target = new DatabaseSync(targetDatabasePath);
        target.exec('PRAGMA foreign_keys = OFF; PRAGMA journal_mode = DELETE;');

        let schemaRows = [];
        try {
            schemaRows = source.prepare(`
                SELECT type, name, tbl_name, sql
                FROM sqlite_master
                WHERE sql IS NOT NULL
                  AND name NOT LIKE 'sqlite_%'
                ORDER BY CASE type WHEN 'table' THEN 0 WHEN 'index' THEN 1 WHEN 'trigger' THEN 2 ELSE 3 END,
                         name
            `).all();
            result.schemaReadable = true;
        } catch {
            schemaRows = [];
        }

        const tableRows = schemaRows.filter((row) => String(row.type) === 'table');
        for (const row of tableRows) {
            const tableName = String(row.name ?? '').trim();
            const sql = String(row.sql ?? '').trim();
            if (!tableName || !sql) continue;
            try {
                target.exec(sql);
                result.tablesCreated += 1;
            } catch {
                continue;
            }

            let columns = [];
            try {
                columns = source.prepare(`PRAGMA table_info(${quoteIdentifier(tableName)})`)
                    .all()
                    .map((column) => String(column.name ?? '').trim())
                    .filter(Boolean);
            } catch {
                columns = [];
            }
            if (!columns.length) continue;

            const copied = copyRowsBestEffort({ source, target, tableName, columns });
            result.rowsCopied += copied.copied;
            if (copied.error) result.tablesWithReadErrors.push(tableName);
        }

        for (const row of schemaRows.filter((item) => String(item.type) !== 'table')) {
            const sql = String(row.sql ?? '').trim();
            if (!sql) continue;
            try {
                target.exec(sql);
            } catch {
                // Index/trigger recovery is optional; app startup recreates known indexes.
            }
        }

        try {
            target.exec('PRAGMA journal_mode = WAL;');
        } catch {
            // App startup will set it again.
        }
    } finally {
        try {
            source?.close();
        } catch {
            // Ignore.
        }
        try {
            target?.close();
        } catch {
            // Ignore.
        }
    }
    return result;
}

/**
 * V188.53 safety bridge: after a healthy backup was restored, preserve any
 * append-only/history rows that remain readable in the quarantined database.
 * The restored backup is authoritative for keys it already contains; only
 * missing natural keys are added. The source quarantine is never modified.
 */
export function mergeReadableHistoryIntoRestoredBackup({
    databasePath,
    quarantinedDatabasePath,
    workingDirectory,
    logger = console,
} = {}) {
    if (!databasePath || !existsSync(databasePath)) {
        return { attempted: false, merged: false, reason: 'restored-database-missing' };
    }
    if (!quarantinedDatabasePath || !existsSync(quarantinedDatabasePath)) {
        return { attempted: false, merged: false, reason: 'quarantined-database-missing' };
    }

    const directory = workingDirectory || dirname(quarantinedDatabasePath);
    mkdirSync(directory, { recursive: true });
    const salvageDatabasePath = join(directory, 'readable-salvage.sqlite');
    const mergedCandidatePath = join(directory, 'restored-plus-salvage.sqlite');
    const salvage = salvageDatabase({
        sourceDatabasePath: quarantinedDatabasePath,
        targetDatabasePath: salvageDatabasePath,
    });
    const salvageHealth = checkSqliteHealth(salvageDatabasePath);
    if (!salvage?.schemaReadable || salvage?.rowsCopied <= 0 || !salvageHealth.ok) {
        return {
            attempted: true,
            merged: false,
            reason: 'no-healthy-readable-salvage',
            salvage,
            salvageHealth,
            salvageDatabasePath,
        };
    }

    const candidate = buildHistoricalRecoveryCandidate({
        activeDatabasePath: databasePath,
        backupDatabasePath: salvageDatabasePath,
        candidateDatabasePath: mergedCandidatePath,
    });
    const candidateHealth = checkSqliteHealth(mergedCandidatePath);
    if (!candidate.valid || !candidateHealth.ok) {
        return {
            attempted: true,
            merged: false,
            reason: 'candidate-rejected',
            salvage,
            salvageHealth,
            candidate,
            candidateHealth,
            salvageDatabasePath,
            mergedCandidatePath,
        };
    }

    copyFileSync(mergedCandidatePath, databasePath);
    safeUnlink(`${databasePath}-wal`);
    safeUnlink(`${databasePath}-shm`);
    logger.warn?.(
        '[DB PREFLIGHT] restored backup reconciled with readable quarantined history:',
        candidate.merge
            .filter((item) => !item.skipped)
            .map((item) => `${item.table}:+${item.inserted ?? 0}`)
            .join(' '),
    );
    return {
        attempted: true,
        merged: true,
        reason: 'merged-readable-history',
        salvage,
        salvageHealth,
        candidate,
        candidateHealth,
        salvageDatabasePath,
        mergedCandidatePath,
    };
}

/**
 * Ensures the release-local bot.sqlite cannot brick the process on startup.
 */
export function runDatabasePreflight({
    databasePath = defaultDatabasePath,
    dataDirectory = dirname(databasePath),
    now = Date.now(),
    logger = console,
} = {}) {
    mkdirSync(dataDirectory, { recursive: true });
    const health = checkSqliteHealth(databasePath);
    if (health.ok) {
        if (health.exists) {
            try {
                const lineage = compareAgainstLatestHealthyBackup(databasePath, dataDirectory);
                if (lineage.regressed) {
                    logLineageRegression(logger, lineage);
                    return {
                        ok: true,
                        action: 'healthy-lineage-regression',
                        health,
                        lineage,
                    };
                }

                const backup = maybeCreateHealthyBackup(databasePath, dataDirectory, now);
                if (backup.created) logger.log('[DB PREFLIGHT]', `healthy backup created=${backup.path}`);
                else if (backup.path) logger.log('[DB PREFLIGHT]', `healthy backup current=${backup.path}`);
            } catch (error) {
                logger.warn?.('[DB PREFLIGHT] healthy backup/lineage check failed:', error?.message ?? error);
            }
        }
        return { ok: true, action: health.exists ? 'healthy' : 'new', health };
    }

    const corruptionDirectory = join(dataDirectory, 'corruption-backups', timestamp(now));
    let copiedFiles = [];
    try {
        copiedFiles = copyDatabaseFamily(databasePath, corruptionDirectory);
    } catch (error) {
        logger.error?.('[DB PREFLIGHT] failed to copy corrupt database family:', error);
    }

    logger.error?.(
        '[DB PREFLIGHT] SQLite corruption detected; quarantining and recovering instead of crashing:',
        health.detail,
    );

    // V188.56: index-only quick_check failures are often repairable without
    // replacing bot.sqlite. We already preserved the complete database family
    // above, so REINDEX is safe to attempt before deleting WAL/SHM or restoring
    // an older healthy backup.
    const indexRepair = tryRepairIndexOnlyCorruption({ databasePath, health, logger });
    if (indexRepair.repaired) {
        try {
            const lineage = compareAgainstLatestHealthyBackup(databasePath, dataDirectory);
            if (lineage.regressed) {
                logLineageRegression(logger, lineage);
                return {
                    ok: true,
                    action: 'reindexed-index-only-lineage-regression',
                    health,
                    corruptionDirectory,
                    copiedFiles,
                    indexRepair,
                    lineage,
                };
            }
        } catch (error) {
            logger.warn?.('[DB PREFLIGHT] post-REINDEX lineage check failed:', error?.message ?? error);
        }
        return {
            ok: true,
            action: 'reindexed-index-only',
            health,
            corruptionDirectory,
            copiedFiles,
            indexRepair,
        };
    }
    if (indexRepair.attempted) {
        logger.error?.(
            '[DB PREFLIGHT] REINDEX did not fully repair the database; falling back to WAL/backup recovery:',
            indexRepair.reason,
            indexRepair.error ?? indexRepair.quickCheck?.detail ?? indexRepair.integrityCheck?.detail ?? '',
        );
    }

    // WAL/SHM damage is common after an interrupted process. First see whether
    // the checkpointed main file is still valid before rebuilding anything.
    safeUnlink(`${databasePath}-wal`);
    safeUnlink(`${databasePath}-shm`);
    const withoutWal = checkSqliteHealth(databasePath);
    if (withoutWal.ok) {
        logger.warn?.('[DB PREFLIGHT] recovered by discarding damaged WAL/SHM; main bot.sqlite passes SQLite health checks.');
        try {
            const lineage = compareAgainstLatestHealthyBackup(databasePath, dataDirectory);
            if (lineage.regressed) {
                logLineageRegression(logger, lineage);
                return {
                    ok: true,
                    action: 'discarded-corrupt-wal-lineage-regression',
                    health,
                    corruptionDirectory,
                    copiedFiles,
                    lineage,
                };
            }
        } catch (error) {
            logger.warn?.('[DB PREFLIGHT] post-WAL lineage check failed:', error?.message ?? error);
        }
        return {
            ok: true,
            action: 'discarded-corrupt-wal',
            health,
            corruptionDirectory,
            copiedFiles,
        };
    }

    // Main database is damaged too. Keep the quarantined family and rebuild a
    // bootable database. A known-good rotating backup is preferred, then any
    // readable rows from the corrupt file are merged into it.
    safeUnlink(databasePath);
    safeUnlink(`${databasePath}-wal`);
    safeUnlink(`${databasePath}-shm`);

    const restoredBackup = restoreHealthyBackup(databasePath, dataDirectory);
    let salvage = null;
    let restoredHistoryMerge = null;
    const quarantinedDatabase = join(corruptionDirectory, 'bot.sqlite');

    if (restoredBackup && existsSync(quarantinedDatabase)) {
        // V188.53: restoring a healthy backup must not silently discard rows that
        // are still readable from the quarantined database. Existing backup rows
        // win; only missing append-only/history natural keys are added.
        try {
            restoredHistoryMerge = mergeReadableHistoryIntoRestoredBackup({
                databasePath,
                quarantinedDatabasePath: quarantinedDatabase,
                workingDirectory: corruptionDirectory,
                logger,
            });
            salvage = restoredHistoryMerge.salvage ?? null;
            if (restoredHistoryMerge.attempted && !restoredHistoryMerge.merged) {
                logger.error?.(
                    '[DB PREFLIGHT] readable-history merge after healthy-backup restore was not applied; quarantine preserved:',
                    restoredHistoryMerge.reason,
                );
            }
        } catch (error) {
            logger.error?.('[DB PREFLIGHT] readable-history merge after healthy-backup restore failed; quarantine preserved:', error);
        }
    } else if (!restoredBackup && existsSync(quarantinedDatabase)) {
        try {
            salvage = salvageDatabase({
                sourceDatabasePath: quarantinedDatabase,
                targetDatabasePath: databasePath,
            });
        } catch (error) {
            logger.error?.('[DB PREFLIGHT] logical salvage failed:', error);
        }
    }

    if (!existsSync(databasePath)) {
        const fresh = new DatabaseSync(databasePath);
        fresh.close();
    }

    const recoveredHealth = checkSqliteHealth(databasePath);
    if (!recoveredHealth.ok) {
        // Never leave a malformed target in place. The application schema will
        // be recreated in a brand-new DB, while the original remains backed up.
        safeUnlink(databasePath);
        safeUnlink(`${databasePath}-wal`);
        safeUnlink(`${databasePath}-shm`);
        const fresh = new DatabaseSync(databasePath);
        fresh.close();
    }

    logger.warn?.(
        '[DB PREFLIGHT] recovery complete:',
        restoredBackup
            ? `restored healthy backup ${restoredBackup}`
            : `salvaged tables=${salvage?.tablesCreated ?? 0} rows=${salvage?.rowsCopied ?? 0}`,
        `corrupt backup=${corruptionDirectory}`,
    );

    return {
        ok: true,
        action: restoredBackup ? 'restored-backup' : 'salvaged-or-fresh',
        health,
        corruptionDirectory,
        copiedFiles,
        restoredBackup,
        salvage,
        restoredHistoryMerge,
    };
}
