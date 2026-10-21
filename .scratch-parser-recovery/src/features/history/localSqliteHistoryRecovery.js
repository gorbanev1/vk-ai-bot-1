import { copyFileSync, existsSync, mkdtempSync, readdirSync, realpathSync, rmSync, statSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';

const currentDirectory = dirname(fileURLToPath(import.meta.url));
const dataDirectory = resolve(currentDirectory, '..', '..', '..', 'data');
const activeDatabasePath = join(dataDirectory, 'bot.sqlite');


function isReadonlyWriteError(error) {
    return /(?:attempt to write a readonly database|readonly database)/iu.test(
        String(error?.message ?? error),
    );
}

function copySqliteFamilyToTemporaryDirectory(sourcePath) {
    const directory = mkdtempSync(join(tmpdir(), 'gigorave-history-snapshot-'));
    const destinationPath = join(directory, basename(sourcePath));
    copyFileSync(sourcePath, destinationPath);
    for (const suffix of ['-wal', '-shm']) {
        const sidecar = `${sourcePath}${suffix}`;
        if (!existsSync(sidecar)) continue;
        try {
            copyFileSync(sidecar, `${destinationPath}${suffix}`);
        } catch {
            // A racing WAL/SHM is best-effort. The immutable source is never
            // modified; SQLite will use the copy that was successfully made.
        }
    }
    return { directory, destinationPath };
}

function readSqliteSnapshot(path, reader, { logger = console, logPrefix = '[VK HISTORY LOCAL SQLITE READ COPY]' } = {}) {
    let database = null;
    try {
        database = new DatabaseSync(path, { readOnly: true });
        try {
            database.exec('PRAGMA query_only = ON; PRAGMA temp_store = MEMORY; PRAGMA busy_timeout = 5000');
        } catch {
            // Some damaged snapshots reject pragmas but still allow SELECTs.
        }
        return reader(database, { temporaryCopy: false, sourcePath: path });
    } catch (error) {
        if (!isReadonlyWriteError(error)) throw error;
    } finally {
        try { database?.close(); } catch { /* malformed snapshot */ }
    }

    // Certain WAL/index states make SQLite request a write transaction even
    // for a logical read. Never relax read-only on forensic evidence itself:
    // clone the complete SQLite family into a disposable directory and open
    // that copy normally. This preserves the original backup byte-for-byte.
    const temporary = copySqliteFamilyToTemporaryDirectory(path);
    try {
        logger.log?.(logPrefix, `file=${path}`, `copy=${temporary.destinationPath}`);
        database = new DatabaseSync(temporary.destinationPath);
        try {
            database.exec('PRAGMA temp_store = MEMORY; PRAGMA busy_timeout = 5000');
        } catch {
            // Continue with ordinary SELECTs when optional pragmas fail.
        }
        return reader(database, { temporaryCopy: true, sourcePath: path });
    } finally {
        try { database?.close(); } catch { /* ignore */ }
        try { rmSync(temporary.directory, { recursive: true, force: true }); } catch { /* ignore */ }
    }
}

async function readSqliteSnapshotAsync(path, reader, {
    logger = console,
    logPrefix = '[VK HISTORY LOCAL SQLITE READ COPY]',
} = {}) {
    let database = null;
    try {
        database = new DatabaseSync(path, { readOnly: true });
        try {
            database.exec('PRAGMA query_only = ON; PRAGMA temp_store = MEMORY; PRAGMA busy_timeout = 5000');
        } catch {
            // Some damaged snapshots reject pragmas but still allow SELECTs.
        }
        return await reader(database, { temporaryCopy: false, sourcePath: path });
    } catch (error) {
        if (!isReadonlyWriteError(error)) throw error;
    } finally {
        try { database?.close(); } catch { /* malformed snapshot */ }
        database = null;
    }

    const temporary = copySqliteFamilyToTemporaryDirectory(path);
    try {
        logger.log?.(logPrefix, `file=${path}`, `copy=${temporary.destinationPath}`);
        database = new DatabaseSync(temporary.destinationPath);
        try {
            database.exec('PRAGMA temp_store = MEMORY; PRAGMA busy_timeout = 5000');
        } catch {
            // Continue with ordinary SELECTs when optional pragmas fail.
        }
        return await reader(database, { temporaryCopy: true, sourcePath: path });
    } finally {
        try { database?.close(); } catch { /* ignore */ }
        try { rmSync(temporary.directory, { recursive: true, force: true }); } catch { /* ignore */ }
    }
}

function yieldToEventLoop() {
    return new Promise((resolvePromise) => setImmediate(resolvePromise));
}

function walkSqliteFiles(rootDirectory) {
    const result = [];
    const stack = [rootDirectory];

    while (stack.length) {
        const current = stack.pop();
        let entries = [];
        try {
            entries = readdirSync(current, { withFileTypes: true });
        } catch {
            continue;
        }

        for (const entry of entries) {
            const fullPath = join(current, entry.name);
            if (entry.isDirectory()) {
                stack.push(fullPath);
                continue;
            }
            if (!entry.isFile()) continue;
            if (!/\.sqlite$/iu.test(entry.name)) continue;
            result.push(fullPath);
        }
    }

    return result;
}

function sameFile(left, right) {
    try {
        return realpathSync(left) === realpathSync(right);
    } catch {
        return resolve(left) === resolve(right);
    }
}

function listLocalSqliteCandidates() {
    if (!existsSync(dataDirectory)) return [];
    return walkSqliteFiles(dataDirectory)
        .filter((path) => !sameFile(path, activeDatabasePath))
        .sort((left, right) => {
            try {
                return statSync(right).mtimeMs - statSync(left).mtimeMs;
            } catch {
                return 0;
            }
        });
}

export function getLocalSqliteBackupInventoryFingerprint() {
    const hash = createHash('sha256');
    const candidates = listLocalSqliteCandidates();
    for (const path of [...candidates].sort()) {
        let size = 0;
        let mtimeMs = 0;
        try {
            const stat = statSync(path);
            size = Number(stat.size || 0);
            mtimeMs = Math.trunc(Number(stat.mtimeMs || 0));
        } catch {
            // Keep the path itself in the fingerprint even when stat races.
        }
        hash.update(`${resolve(path)}\0${size}\0${mtimeMs}\n`);
    }
    return {
        hash: hash.digest('hex'),
        files: candidates.length,
    };
}

export function getActiveMessageCoverageFingerprint({ peerId, maxCmid = 0 } = {}) {
    const numericPeerId = Number(peerId);
    if (!Number.isSafeInteger(numericPeerId) || numericPeerId < 2_000_000_000 || !existsSync(activeDatabasePath)) {
        return { maxCmid: 0, coveredCount: 0, coverageHash: '' };
    }

    let database = null;
    try {
        database = new DatabaseSync(activeDatabasePath, { readOnly: true });
        database.exec('PRAGMA busy_timeout = 5000');
        const ceilingRow = database.prepare(`
            SELECT MAX(conversation_message_id) AS max_cmid
            FROM messages NOT INDEXED
            WHERE peer_id = ?
        `).get(numericPeerId);
        const activeMaxCmid = Math.max(0, Number(ceilingRow?.max_cmid || 0));
        const requestedMax = Math.max(0, Number(maxCmid) || 0);
        const coverageMaxCmid = requestedMax > 0 ? Math.min(requestedMax, activeMaxCmid) : activeMaxCmid;
        if (coverageMaxCmid <= 0) {
            return { maxCmid: activeMaxCmid, coveredCount: 0, coverageHash: createHash('sha256').digest('hex') };
        }

        const rows = database.prepare(`
            SELECT conversation_message_id, sender_id, created_at, text
            FROM messages NOT INDEXED
            WHERE peer_id = ? AND conversation_message_id <= ?
            ORDER BY conversation_message_id ASC
        `).all(numericPeerId, coverageMaxCmid);
        const hash = createHash('sha256');
        for (const row of rows) {
            hash.update(String(Number(row.conversation_message_id || 0)));
            hash.update('\0');
            hash.update(String(Number(row.sender_id || 0)));
            hash.update('\0');
            hash.update(String(Number(row.created_at || 0)));
            hash.update('\0');
            hash.update(String(row.text ?? ''));
            hash.update('\n');
        }
        return {
            maxCmid: activeMaxCmid,
            coverageMaxCmid,
            coveredCount: rows.length,
            coverageHash: hash.digest('hex'),
        };
    } finally {
        try { database?.close(); } catch { /* ignore */ }
    }
}

function normalizeRow(row, targetPeerId) {
    const conversationMessageId = Number(row?.conversation_message_id ?? 0);
    const senderId = Number(row?.sender_id ?? 0);
    const createdAt = Number(row?.created_at ?? 0);

    if (!Number.isSafeInteger(conversationMessageId) || conversationMessageId <= 0) return null;
    if (!Number.isSafeInteger(senderId)) return null;
    if (!Number.isFinite(createdAt) || createdAt <= 0) return null;

    return {
        peerId: Number(targetPeerId),
        sourcePeerId: Number(row?.peer_id ?? targetPeerId),
        senderId,
        conversationMessageId,
        text: String(row?.text ?? ''),
        createdAt,
    };
}

export async function recoverHistoryFromLocalSqliteBackups({
    targetPeerId,
    sourcePeerIds = [],
    saveMessage,
    logger = console,
    batchSize = 250,
} = {}) {
    const numericTarget = Number(targetPeerId);
    if (!Number.isSafeInteger(numericTarget) || numericTarget < 2_000_000_000) {
        return { files: 0, readable: 0, rows: 0, saved: 0 };
    }
    if (typeof saveMessage !== 'function') {
        throw new TypeError('saveMessage callback is required');
    }

    const peers = [...new Set([
        numericTarget,
        ...sourcePeerIds.map(Number),
    ].filter((value) => Number.isSafeInteger(value)))];
    const placeholders = peers.map(() => '?').join(', ');

    if (!existsSync(dataDirectory)) {
        return { files: 0, readable: 0, rows: 0, saved: 0 };
    }

    const candidates = listLocalSqliteCandidates();

    let readable = 0;
    let rows = 0;
    let saved = 0;

    const safeBatchSize = Math.max(25, Math.min(2_000, Number(batchSize) || 250));

    for (const path of candidates) {
        try {
            const found = await readSqliteSnapshotAsync(path, async (database) => {
                const table = database.prepare(
                    "SELECT name FROM sqlite_master WHERE type='table' AND name='messages'",
                ).get();
                if (!table) return null;

                // V188.69: never materialize an entire historical snapshot and
                // merge hundreds of thousands of rows in one synchronous turn.
                // Page by rowid and yield after every small batch so VK Long Poll
                // handlers remain responsive while recovery runs in background.
                const statement = database.prepare(`
                    SELECT rowid AS recovery_rowid,
                           peer_id, sender_id, conversation_message_id, text, created_at
                    FROM messages NOT INDEXED
                    WHERE peer_id IN (${placeholders}) AND rowid > ?
                    ORDER BY rowid ASC
                    LIMIT ?
                `);
                let lastRowId = 0;
                let fileRows = 0;
                let fileSaved = 0;

                while (true) {
                    const batch = statement.all(...peers, lastRowId, safeBatchSize);
                    if (!batch.length) break;

                    for (const row of batch) {
                        const normalized = normalizeRow(row, numericTarget);
                        if (!normalized) continue;
                        saveMessage(normalized);
                        fileSaved += 1;
                    }

                    fileRows += batch.length;
                    lastRowId = Number(batch[batch.length - 1]?.recovery_rowid || lastRowId);
                    await yieldToEventLoop();
                }

                return { rows: fileRows, saved: fileSaved };
            }, { logger });
            if (!found) continue;

            readable += 1;
            rows += Number(found.rows || 0);
            saved += Number(found.saved || 0);

            if (Number(found.rows || 0) > 0) {
                logger.log?.(
                    '[VK HISTORY LOCAL SQLITE]',
                    `file=${path}`,
                    `rows=${found.rows}`,
                    `target=${numericTarget}`,
                );
            }

            await yieldToEventLoop();
        } catch (error) {
            logger.warn?.(
                '[VK HISTORY LOCAL SQLITE SKIP]',
                `file=${path}`,
                `error=${String(error?.message ?? error).slice(0, 300)}`,
            );
        }
    }

    return {
        files: candidates.length,
        readable,
        rows,
        saved,
    };
}


export function getLocalSqlitePeerCmidBounds(peerIds = [], { logger = console } = {}) {
    const peers = [...new Set((Array.isArray(peerIds) ? peerIds : [peerIds])
        .map(Number)
        .filter((value) => Number.isSafeInteger(value)))];

    if (!peers.length || !existsSync(dataDirectory)) return [];

    const placeholders = peers.map(() => '?').join(', ');
    const candidates = listLocalSqliteCandidates();
    const aggregate = new Map();

    for (const path of candidates) {
        try {
            const rows = readSqliteSnapshot(path, (database) => {
                const table = database.prepare(
                    "SELECT name FROM sqlite_master WHERE type='table' AND name='messages'",
                ).get();
                if (!table) return null;

                return database.prepare(`
                    SELECT
                        peer_id,
                        COUNT(*) AS message_count,
                        MIN(conversation_message_id) AS min_cmid,
                        MAX(conversation_message_id) AS max_cmid
                    FROM messages NOT INDEXED
                    WHERE peer_id IN (${placeholders})
                    GROUP BY peer_id
                `).all(...peers);
            }, {
                logger,
                logPrefix: '[VK HISTORY LOCAL BOUNDS READ COPY]',
            });
            if (!rows) continue;

            for (const row of rows) {
                const peerId = Number(row.peer_id);
                const minCmid = Number(row.min_cmid ?? 0);
                const maxCmid = Number(row.max_cmid ?? 0);
                const messageCount = Number(row.message_count ?? 0);
                if (!Number.isSafeInteger(peerId)) continue;
                if (!Number.isSafeInteger(maxCmid) || maxCmid <= 0) continue;

                const current = aggregate.get(peerId) ?? {
                    peerId,
                    minCmid: Number.MAX_SAFE_INTEGER,
                    maxCmid: 0,
                    messageCount: 0,
                    files: 0,
                };
                current.minCmid = Math.min(current.minCmid, minCmid > 0 ? minCmid : current.minCmid);
                current.maxCmid = Math.max(current.maxCmid, maxCmid);
                current.messageCount += Math.max(0, messageCount);
                current.files += 1;
                aggregate.set(peerId, current);
            }
        } catch (error) {
            logger.warn?.(
                '[VK HISTORY LOCAL BOUNDS SKIP]',
                `file=${path}`,
                `error=${String(error?.message ?? error).slice(0, 300)}`,
            );
        }
    }

    return [...aggregate.values()]
        .map((item) => ({
            ...item,
            minCmid: Number.isSafeInteger(item.minCmid) && item.minCmid !== Number.MAX_SAFE_INTEGER
                ? item.minCmid
                : 0,
        }))
        .sort((left, right) => left.peerId - right.peerId);
}
