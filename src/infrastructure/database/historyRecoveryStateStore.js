/**
 * V187.2 durable startup-history recovery state.
 * Keeps expensive local-backup scan completion outside bot.sqlite so a normal
 * process restart does not reread every historical backup. If bot.sqlite is
 * rolled back below the saved message count, the scan becomes eligible again.
 */
import { mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { resolveAutoSummaryStateDirectory } from './autoSummaryStateStore.js';

export const HISTORY_RECOVERY_STATE_DB_FILENAME = 'history-recovery-v1872.sqlite';

export function createHistoryRecoveryStateStore({
    directory = resolveAutoSummaryStateDirectory(),
    databasePath = '',
} = {}) {
    const path = databasePath
        ? resolve(String(databasePath))
        : join(resolve(String(directory)), HISTORY_RECOVERY_STATE_DB_FILENAME);
    mkdirSync(dirname(path), { recursive: true });
    const db = new DatabaseSync(path);
    db.exec(`
        PRAGMA journal_mode = WAL;
        PRAGMA synchronous = FULL;
        PRAGMA busy_timeout = 5000;
        CREATE TABLE IF NOT EXISTS local_sqlite_scan_state (
            peer_id INTEGER PRIMARY KEY,
            source_signature TEXT NOT NULL DEFAULT '',
            target_message_count INTEGER NOT NULL DEFAULT 0,
            scanned_rows INTEGER NOT NULL DEFAULT 0,
            completed_at INTEGER NOT NULL
        );
    `);
    const getStatement = db.prepare(`
        SELECT peer_id, source_signature, target_message_count, scanned_rows, completed_at
        FROM local_sqlite_scan_state WHERE peer_id = ? LIMIT 1
    `);
    const saveStatement = db.prepare(`
        INSERT INTO local_sqlite_scan_state (
            peer_id, source_signature, target_message_count, scanned_rows, completed_at
        ) VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(peer_id) DO UPDATE SET
            source_signature = excluded.source_signature,
            target_message_count = excluded.target_message_count,
            scanned_rows = excluded.scanned_rows,
            completed_at = excluded.completed_at
    `);

    function get(peerId) {
        const row = getStatement.get(Number(peerId));
        if (!row) return null;
        return {
            peerId: Number(row.peer_id),
            sourceSignature: String(row.source_signature || ''),
            targetMessageCount: Number(row.target_message_count || 0),
            scannedRows: Number(row.scanned_rows || 0),
            completedAt: Number(row.completed_at || 0),
        };
    }

    function save({ peerId, sourceSignature = '', targetMessageCount = 0, scannedRows = 0 }) {
        saveStatement.run(
            Number(peerId),
            String(sourceSignature || ''),
            Math.max(0, Number(targetMessageCount) || 0),
            Math.max(0, Number(scannedRows) || 0),
            Math.floor(Date.now() / 1000),
        );
    }

    return { path, get, save, close: () => db.close() };
}

const historyRecoveryStateStore = createHistoryRecoveryStateStore();
export const HISTORY_RECOVERY_STATE_DB_PATH = historyRecoveryStateStore.path;
export const getLocalHistoryScanState = (...args) => historyRecoveryStateStore.get(...args);
export const saveLocalHistoryScanState = (...args) => historyRecoveryStateStore.save(...args);
