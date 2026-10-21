import {
    existsSync,
    mkdirSync,
    readdirSync,
    statSync,
    writeFileSync,
} from 'node:fs';
import { basename, join, relative, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import {
    createDatabaseComparisonSnapshot,
    DATABASE_LINEAGE_TABLES,
} from '../src/infrastructure/database/databaseLineageGuard.js';

const dataDirectory = resolve(process.argv[2] || 'data');
const activeDatabasePath = join(dataDirectory, 'bot.sqlite');
if (!existsSync(activeDatabasePath)) throw new Error(`active DB not found: ${activeDatabasePath}`);

const stamp = new Date().toISOString().replaceAll(':', '-').replaceAll('.', '-');
const auditDirectory = join(dataDirectory, 'recovery-audit', `full-history-${stamp}`);
mkdirSync(auditDirectory, { recursive: true });
const activeSnapshotPath = join(auditDirectory, 'active-snapshot.sqlite');
const reportPath = join(auditDirectory, 'history-coverage.json');
createDatabaseComparisonSnapshot({ sourceDatabasePath: activeDatabasePath, snapshotPath: activeSnapshotPath });

function quoteIdentifier(value) {
    return `"${String(value).replaceAll('"', '""')}"`;
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

function encodeKey(row, columns) {
    return JSON.stringify(columns.map((column) => row[column]));
}

function decodeKey(key) {
    try { return JSON.parse(key); } catch { return [key]; }
}

function walkSqliteFiles(root) {
    const result = [];
    const skipDirectoryNames = new Set(['node_modules', 'recovery-audit', 'recovery-candidates']);
    const visit = (directory) => {
        let entries = [];
        try { entries = readdirSync(directory, { withFileTypes: true }); } catch { return; }
        for (const entry of entries) {
            const path = join(directory, entry.name);
            if (entry.isDirectory()) {
                if (!skipDirectoryNames.has(entry.name)) visit(path);
                continue;
            }
            if (!entry.isFile()) continue;
            if (!/\.(?:sqlite|sqlite3|db)$/iu.test(entry.name)) continue;
            if (resolve(path) === resolve(activeDatabasePath)) continue;
            result.push(path);
        }
    };
    visit(root);
    return result.sort();
}

function readTableKeys(databasePath, spec) {
    let db;
    const result = {
        databasePath,
        table: spec.name,
        exists: false,
        rowsRead: 0,
        complete: true,
        error: '',
        keys: new Map(),
        minTime: null,
        maxTime: null,
    };
    try {
        db = new DatabaseSync(databasePath, { readOnly: true });
        db.exec('PRAGMA busy_timeout = 15000');
        if (!tableExists(db, spec.name)) return result;
        result.exists = true;
        const columns = tableColumns(db, spec.name);
        const missingKeyColumns = spec.keyColumns.filter((column) => !columns.includes(column));
        if (missingKeyColumns.length) {
            result.complete = false;
            result.error = `missing key columns: ${missingKeyColumns.join(',')}`;
            return result;
        }
        const hasTime = spec.timeColumn && columns.includes(spec.timeColumn);
        const selected = [
            ...spec.keyColumns.map(quoteIdentifier),
            ...(hasTime ? [quoteIdentifier(spec.timeColumn)] : []),
        ].join(', ');
        try {
            for (const row of db.prepare(`SELECT ${selected} FROM ${quoteIdentifier(spec.name)}`).iterate()) {
                const rawTime = hasTime ? Number(row[spec.timeColumn] ?? 0) : 0;
                const time = Number.isFinite(rawTime) ? rawTime : 0;
                const key = encodeKey(row, spec.keyColumns);
                result.keys.set(key, time);
                result.rowsRead += 1;
                if (hasTime) {
                    if (result.minTime === null || time < result.minTime) result.minTime = time;
                    if (result.maxTime === null || time > result.maxTime) result.maxTime = time;
                }
            }
        } catch (error) {
            // A corrupt snapshot can still yield readable rows before SQLite hits
            // a damaged page. Preserve those keys, but mark the source incomplete.
            result.complete = false;
            result.error = String(error?.message ?? error);
        }
        return result;
    } catch (error) {
        result.complete = false;
        result.error = String(error?.message ?? error);
        return result;
    } finally {
        try { db?.close(); } catch {}
    }
}

const discoveredSnapshots = walkSqliteFiles(dataDirectory);
const sourceReports = discoveredSnapshots.map((path) => ({
    path,
    relativePath: relative(dataDirectory, path),
    size: (() => { try { return statSync(path).size; } catch { return 0; } })(),
    tables: {},
    errors: [],
}));

const tableReports = [];
let totalMissingUniqueRows = 0;
let incompleteSources = 0;

for (const spec of DATABASE_LINEAGE_TABLES) {
    const active = readTableKeys(activeSnapshotPath, spec);
    if (!active.exists) {
        tableReports.push({ table: spec.name, skipped: true, reason: 'absent-in-active' });
        continue;
    }

    const missing = new Map();
    const sourceContributions = [];
    const peerMissingCounts = new Map();
    let readableSnapshotRows = 0;
    let sourcesWithTable = 0;
    let tableIncompleteSources = 0;

    for (const sourceReport of sourceReports) {
        const read = readTableKeys(sourceReport.path, spec);
        sourceReport.tables[spec.name] = {
            exists: read.exists,
            rowsRead: read.rowsRead,
            complete: read.complete,
            error: read.error,
            minTime: read.minTime,
            maxTime: read.maxTime,
        };
        if (read.error) sourceReport.errors.push(`${spec.name}: ${read.error}`);
        if (!read.exists) continue;
        sourcesWithTable += 1;
        readableSnapshotRows += read.rowsRead;
        if (!read.complete) tableIncompleteSources += 1;

        let contributed = 0;
        for (const [key, time] of read.keys.entries()) {
            if (active.keys.has(key)) continue;
            if (!missing.has(key)) {
                missing.set(key, {
                    key: decodeKey(key),
                    time,
                    firstSource: sourceReport.relativePath,
                    sources: [sourceReport.relativePath],
                });
                contributed += 1;
                if (spec.name === 'messages') {
                    const peerId = String(decodeKey(key)[0]);
                    peerMissingCounts.set(peerId, (peerMissingCounts.get(peerId) ?? 0) + 1);
                }
            } else {
                const item = missing.get(key);
                if (item.sources.length < 12) item.sources.push(sourceReport.relativePath);
            }
        }
        if (contributed > 0) {
            sourceContributions.push({ source: sourceReport.relativePath, firstSeenMissingRows: contributed });
        }
    }

    const missingItems = [...missing.values()];
    missingItems.sort((a, b) => Number(a.time ?? 0) - Number(b.time ?? 0));
    totalMissingUniqueRows += missingItems.length;
    incompleteSources += tableIncompleteSources;
    tableReports.push({
        table: spec.name,
        activeRows: active.rowsRead,
        activeMinTime: active.minTime,
        activeMaxTime: active.maxTime,
        sourcesWithTable,
        readableSnapshotRows,
        incompleteSources: tableIncompleteSources,
        missingUniqueRows: missingItems.length,
        missingSampleEarliest: missingItems.slice(0, 20),
        missingSampleLatest: missingItems.slice(-20),
        sourceContributions,
        ...(spec.name === 'messages'
            ? { missingByPeer: Object.fromEntries([...peerMissingCounts.entries()].sort((a, b) => Number(a[0]) - Number(b[0]))) }
            : {}),
    });
}

const sourcesWithErrors = sourceReports.filter((source) => source.errors.length > 0);
const verdict = totalMissingUniqueRows > 0
    ? 'ACTIVE_MISSING_READABLE_LOCAL_HISTORY'
    : sourcesWithErrors.length > 0
        ? 'INCONCLUSIVE_UNREADABLE_LOCAL_SNAPSHOTS'
        : 'ACTIVE_COVERS_ALL_READABLE_LOCAL_SNAPSHOTS';

const report = {
    version: 'V188.53',
    generatedAt: new Date().toISOString(),
    dataDirectory,
    liveDatabasePath: activeDatabasePath,
    activeSnapshotPath,
    scannedSnapshotCount: discoveredSnapshots.length,
    verdict,
    totalMissingUniqueRows,
    sourcesWithErrors: sourcesWithErrors.map((source) => ({
        path: source.relativePath,
        errors: source.errors,
    })),
    limitation: 'This proves coverage only against locally retained readable SQLite snapshots. It cannot prove that VK messages absent from every surviving local snapshot were never lost upstream.',
    tables: tableReports,
    sources: sourceReports.map((source) => ({
        path: source.relativePath,
        size: source.size,
        tables: source.tables,
        errors: source.errors,
    })),
};
writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`);

console.log(`[DB FULL HISTORY AUDIT] verdict=${verdict}`);
console.log(`[DB FULL HISTORY AUDIT] active=${activeDatabasePath}`);
console.log(`[DB FULL HISTORY AUDIT] snapshots=${discoveredSnapshots.length} missingUnique=${totalMissingUniqueRows} unreadableSources=${sourcesWithErrors.length}`);
for (const table of tableReports) {
    if (table.skipped) {
        console.log(`[DB FULL HISTORY TABLE] ${table.table} skipped=${table.reason}`);
        continue;
    }
    console.log(`[DB FULL HISTORY TABLE] ${table.table} active=${table.activeRows} missing=${table.missingUniqueRows} sources=${table.sourcesWithTable} incomplete=${table.incompleteSources}`);
    if (table.missingByPeer && Object.keys(table.missingByPeer).length) {
        console.log(`[DB FULL HISTORY PEERS] ${JSON.stringify(table.missingByPeer)}`);
    }
}
for (const source of sourcesWithErrors.slice(0, 10)) {
    console.log(`[DB FULL HISTORY SOURCE ERROR] ${source.relativePath} ${source.errors.join(' | ')}`);
}
console.log(`[DB FULL HISTORY AUDIT] report=${reportPath}`);

if (totalMissingUniqueRows > 0) process.exitCode = 2;
else if (sourcesWithErrors.length > 0) process.exitCode = 3;
