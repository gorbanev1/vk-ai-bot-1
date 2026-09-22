import {
    existsSync,
    mkdirSync,
    unlinkSync,
} from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

/**
 * Tables below are append-only audit/history sources in the main bot database.
 * New rows may appear after a bad/old bot.sqlite was put in place, therefore a
 * simple MAX(created_at) or COUNT(*) comparison is unsafe.  The invariant is
 * stronger: every natural key present in a known-good backup must still exist
 * in the active database.  Active-only keys are allowed and reported as a
 * separate tail.
 */
export const DATABASE_LINEAGE_TABLES = Object.freeze([
    Object.freeze({
        name: 'messages',
        keyColumns: ['peer_id', 'conversation_message_id'],
        timeColumn: 'created_at',
        omitOnMerge: ['id'],
    }),
    Object.freeze({
        name: 'vk_message_archive',
        keyColumns: ['source_peer_id', 'conversation_message_id'],
        timeColumn: 'created_at',
        omitOnMerge: [],
    }),
    Object.freeze({
        name: 'bot_request_events',
        keyColumns: ['platform', 'endpoint_key', 'request_key'],
        timeColumn: 'created_at',
        omitOnMerge: ['id'],
    }),
    Object.freeze({
        name: 'chat_membership_events',
        keyColumns: ['platform', 'source_peer_id', 'conversation_message_id', 'event_type', 'member_id'],
        timeColumn: 'created_at',
        omitOnMerge: [],
    }),
]);

function quoteIdentifier(value) {
    return `"${String(value).replaceAll('"', '""')}"`;
}

function sqliteStringLiteral(value) {
    return `'${String(value).replaceAll("'", "''")}'`;
}

function safeUnlink(path) {
    try {
        if (existsSync(path)) unlinkSync(path);
    } catch {
        // Best effort cleanup only.
    }
}

function tableExists(db, tableName) {
    return Boolean(db.prepare(`
        SELECT 1 AS present
        FROM sqlite_master
        WHERE type = 'table' AND name = ?
        LIMIT 1
    `).get(tableName));
}

function tableColumns(db, tableName) {
    if (!tableExists(db, tableName)) return [];
    return db.prepare(`PRAGMA table_info(${quoteIdentifier(tableName)})`)
        .all()
        .map((row) => String(row.name ?? '').trim())
        .filter(Boolean);
}

function encodeKey(row, keyColumns) {
    return JSON.stringify(keyColumns.map((column) => row[column]));
}

function decodeKey(encoded) {
    try {
        return JSON.parse(encoded);
    } catch {
        return [encoded];
    }
}

function readKeyIndex(db, spec) {
    if (!tableExists(db, spec.name)) {
        return {
            exists: false,
            rows: 0,
            maxTime: 0,
            keys: new Map(),
        };
    }

    const columns = tableColumns(db, spec.name);
    const missingKeyColumns = spec.keyColumns.filter((column) => !columns.includes(column));
    if (missingKeyColumns.length) {
        return {
            exists: true,
            incompatible: true,
            missingKeyColumns,
            rows: 0,
            maxTime: 0,
            keys: new Map(),
        };
    }

    const hasTimeColumn = spec.timeColumn && columns.includes(spec.timeColumn);
    const selected = [
        ...spec.keyColumns.map(quoteIdentifier),
        ...(hasTimeColumn ? [quoteIdentifier(spec.timeColumn)] : []),
    ].join(', ');
    const keys = new Map();
    let maxTime = 0;
    let rows = 0;

    for (const row of db.prepare(`SELECT ${selected} FROM ${quoteIdentifier(spec.name)}`).iterate()) {
        const key = encodeKey(row, spec.keyColumns);
        const rawTime = hasTimeColumn ? Number(row[spec.timeColumn] ?? 0) : 0;
        const time = Number.isFinite(rawTime) ? rawTime : 0;
        keys.set(key, time);
        rows += 1;
        if (time > maxTime) maxTime = time;
    }

    return {
        exists: true,
        incompatible: false,
        rows,
        maxTime,
        keys,
    };
}

/**
 * Compare historical coverage, not "freshness".  A few messages received after
 * startup are active-only tail rows and can never compensate for backup rows
 * that disappeared from the active DB.
 */
export function compareDatabaseLineage({
    activeDatabasePath,
    backupDatabasePath,
    tables = DATABASE_LINEAGE_TABLES,
    sampleLimit = 12,
} = {}) {
    if (!activeDatabasePath || !existsSync(activeDatabasePath)) {
        throw new Error(`active database not found: ${activeDatabasePath || '<empty>'}`);
    }
    if (!backupDatabasePath || !existsSync(backupDatabasePath)) {
        throw new Error(`backup database not found: ${backupDatabasePath || '<empty>'}`);
    }

    let active;
    let backup;
    try {
        active = new DatabaseSync(activeDatabasePath, { readOnly: true });
        backup = new DatabaseSync(backupDatabasePath, { readOnly: true });
        active.exec('PRAGMA busy_timeout = 15000');
        backup.exec('PRAGMA busy_timeout = 15000');

        const tableReports = [];
        let backupOnlyRows = 0;
        let activeOnlyRows = 0;
        let activeOnlyTailRows = 0;
        let activeOnlyHistoricalRows = 0;
        let incompatibleTables = 0;

        for (const spec of tables) {
            const backupIndex = readKeyIndex(backup, spec);
            const activeIndex = readKeyIndex(active, spec);

            if (!backupIndex.exists) {
                tableReports.push({
                    table: spec.name,
                    skipped: true,
                    reason: 'absent-in-backup',
                });
                continue;
            }

            if (backupIndex.incompatible || activeIndex.incompatible) {
                incompatibleTables += 1;
                tableReports.push({
                    table: spec.name,
                    incompatible: true,
                    backupMissingKeyColumns: backupIndex.missingKeyColumns ?? [],
                    activeMissingKeyColumns: activeIndex.missingKeyColumns ?? [],
                });
                continue;
            }

            const missingFromActive = [];
            for (const key of backupIndex.keys.keys()) {
                if (!activeIndex.keys.has(key)) {
                    if (missingFromActive.length < sampleLimit) missingFromActive.push(decodeKey(key));
                    backupOnlyRows += 1;
                }
            }

            let tableActiveOnly = 0;
            let tableActiveOnlyTail = 0;
            let tableActiveOnlyHistorical = 0;
            const activeOnlySample = [];
            for (const [key, time] of activeIndex.keys.entries()) {
                if (backupIndex.keys.has(key)) continue;
                tableActiveOnly += 1;
                activeOnlyRows += 1;
                if (time > backupIndex.maxTime) {
                    tableActiveOnlyTail += 1;
                    activeOnlyTailRows += 1;
                } else {
                    tableActiveOnlyHistorical += 1;
                    activeOnlyHistoricalRows += 1;
                }
                if (activeOnlySample.length < sampleLimit) {
                    activeOnlySample.push({ key: decodeKey(key), time });
                }
            }

            const tableBackupOnly = Math.max(0, backupIndex.rows - [...backupIndex.keys.keys()].filter((key) => activeIndex.keys.has(key)).length);
            tableReports.push({
                table: spec.name,
                backupRows: backupIndex.rows,
                activeRows: activeIndex.rows,
                sharedRows: backupIndex.rows - tableBackupOnly,
                backupOnlyRows: tableBackupOnly,
                activeOnlyRows: tableActiveOnly,
                activeOnlyTailRows: tableActiveOnlyTail,
                activeOnlyHistoricalRows: tableActiveOnlyHistorical,
                backupMaxTime: backupIndex.maxTime,
                missingFromActiveSample: missingFromActive,
                activeOnlySample,
            });
        }

        return {
            activeDatabasePath,
            backupDatabasePath,
            checkedTables: tableReports.filter((item) => !item.skipped).length,
            backupOnlyRows,
            activeOnlyRows,
            activeOnlyTailRows,
            activeOnlyHistoricalRows,
            incompatibleTables,
            regressed: backupOnlyRows > 0,
            verdict: backupOnlyRows > 0
                ? 'ACTIVE_DB_MISSING_BACKUP_HISTORY'
                : 'ACTIVE_DB_CONTAINS_BACKUP_HISTORY',
            tables: tableReports,
        };
    } finally {
        try { active?.close(); } catch {}
        try { backup?.close(); } catch {}
    }
}

/**
 * Make a transactionally consistent, read-only comparison snapshot of a live
 * SQLite DB. VACUUM INTO includes committed WAL content without replacing or
 * mutating the live database.
 */
export function createDatabaseComparisonSnapshot({ sourceDatabasePath, snapshotPath }) {
    if (!sourceDatabasePath || !existsSync(sourceDatabasePath)) {
        throw new Error(`source database not found: ${sourceDatabasePath || '<empty>'}`);
    }
    if (!snapshotPath) throw new Error('snapshotPath is required');
    mkdirSync(dirname(snapshotPath), { recursive: true });
    safeUnlink(snapshotPath);
    safeUnlink(`${snapshotPath}-wal`);
    safeUnlink(`${snapshotPath}-shm`);

    let source;
    try {
        source = new DatabaseSync(sourceDatabasePath, { readOnly: true });
        source.exec('PRAGMA busy_timeout = 15000');
        source.exec(`VACUUM INTO ${sqliteStringLiteral(snapshotPath)}`);
    } finally {
        try { source?.close(); } catch {}
    }
    return snapshotPath;
}

function backupCreateTableSql(db, tableName) {
    return String(db.prepare(`
        SELECT sql
        FROM sqlite_master
        WHERE type = 'table' AND name = ?
        LIMIT 1
    `).get(tableName)?.sql ?? '').trim();
}

/**
 * Build (never install) a recovery candidate from the CURRENT active snapshot,
 * then add historical rows missing from a healthy backup. This direction is
 * deliberate: messages received after the accidental overwrite remain intact.
 */
export function buildHistoricalRecoveryCandidate({
    activeDatabasePath,
    backupDatabasePath,
    candidateDatabasePath,
    tables = DATABASE_LINEAGE_TABLES,
} = {}) {
    if (!candidateDatabasePath) throw new Error('candidateDatabasePath is required');
    createDatabaseComparisonSnapshot({
        sourceDatabasePath: activeDatabasePath,
        snapshotPath: candidateDatabasePath,
    });

    let backup;
    let candidate;
    const merge = [];
    try {
        backup = new DatabaseSync(backupDatabasePath, { readOnly: true });
        candidate = new DatabaseSync(candidateDatabasePath);
        candidate.exec('PRAGMA busy_timeout = 15000; PRAGMA foreign_keys = OFF;');
        candidate.exec('BEGIN IMMEDIATE');

        for (const spec of tables) {
            if (!tableExists(backup, spec.name)) {
                merge.push({ table: spec.name, skipped: true, reason: 'absent-in-backup' });
                continue;
            }
            if (!tableExists(candidate, spec.name)) {
                const createSql = backupCreateTableSql(backup, spec.name);
                if (!createSql) {
                    merge.push({ table: spec.name, skipped: true, reason: 'schema-unavailable' });
                    continue;
                }
                candidate.exec(createSql);
            }

            const backupColumns = tableColumns(backup, spec.name);
            const candidateColumns = new Set(tableColumns(candidate, spec.name));
            const omitted = new Set(spec.omitOnMerge ?? []);
            const columns = backupColumns.filter((column) => candidateColumns.has(column) && !omitted.has(column));
            const missingKeyColumns = spec.keyColumns.filter((column) => !columns.includes(column));
            if (!columns.length || missingKeyColumns.length) {
                merge.push({
                    table: spec.name,
                    skipped: true,
                    reason: 'incompatible-schema',
                    missingKeyColumns,
                });
                continue;
            }

            const quotedColumns = columns.map(quoteIdentifier).join(', ');
            const placeholders = columns.map(() => '?').join(', ');
            const insert = candidate.prepare(
                `INSERT OR IGNORE INTO ${quoteIdentifier(spec.name)} (${quotedColumns}) VALUES (${placeholders})`,
            );
            let inserted = 0;
            let scanned = 0;
            for (const row of backup.prepare(
                `SELECT ${quotedColumns} FROM ${quoteIdentifier(spec.name)}`,
            ).iterate()) {
                scanned += 1;
                const result = insert.run(...columns.map((column) => row[column]));
                inserted += Number(result?.changes ?? 0);
            }
            merge.push({ table: spec.name, scanned, inserted });
        }

        candidate.exec('COMMIT');
    } catch (error) {
        try { candidate?.exec('ROLLBACK'); } catch {}
        throw error;
    } finally {
        try { backup?.close(); } catch {}
        try { candidate?.close(); } catch {}
    }

    const lineage = compareDatabaseLineage({
        activeDatabasePath: candidateDatabasePath,
        backupDatabasePath,
        tables,
    });

    return {
        candidateDatabasePath,
        merge,
        lineage,
        valid: !lineage.regressed,
    };
}
