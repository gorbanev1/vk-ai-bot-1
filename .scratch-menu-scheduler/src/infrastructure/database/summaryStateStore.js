/**
 * V187.2 durable content-addressed cache for explicit large summaries.
 * Re-running the same summary over the same message blocks must not spend GPT
 * tokens again. The cache lives outside bot.sqlite so restoring the main DB or
 * replacing the source tree does not erase already-paid summary work.
 */
import { mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { resolveAutoSummaryStateDirectory } from './autoSummaryStateStore.js';

export const SUMMARY_STATE_DB_FILENAME = 'summary-v1872.sqlite';

export function createSummaryStateStore({
    directory = resolveAutoSummaryStateDirectory(),
    databasePath = '',
} = {}) {
    const path = databasePath
        ? resolve(String(databasePath))
        : join(resolve(String(directory)), SUMMARY_STATE_DB_FILENAME);

    mkdirSync(dirname(path), { recursive: true });
    const db = new DatabaseSync(path);
    db.exec(`
        PRAGMA journal_mode = WAL;
        PRAGMA synchronous = FULL;
        PRAGMA busy_timeout = 5000;

        CREATE TABLE IF NOT EXISTS summary_cache (
            cache_key TEXT PRIMARY KEY,
            stage TEXT NOT NULL,
            model TEXT NOT NULL,
            input_count INTEGER NOT NULL DEFAULT 0,
            output_text TEXT NOT NULL,
            created_at INTEGER NOT NULL,
            updated_at INTEGER NOT NULL
        );

        CREATE INDEX IF NOT EXISTS summary_cache_updated_idx
        ON summary_cache (updated_at DESC);
    `);

    const getStatement = db.prepare(`
        SELECT stage, model, input_count, output_text, created_at, updated_at
        FROM summary_cache
        WHERE cache_key = ?
        LIMIT 1
    `);
    const saveStatement = db.prepare(`
        INSERT INTO summary_cache (
            cache_key, stage, model, input_count, output_text, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(cache_key) DO UPDATE SET
            stage = excluded.stage,
            model = excluded.model,
            input_count = excluded.input_count,
            output_text = excluded.output_text,
            updated_at = excluded.updated_at
    `);
    const pruneStatement = db.prepare(`
        DELETE FROM summary_cache
        WHERE updated_at < ?
    `);

    function get(cacheKey) {
        const row = getStatement.get(String(cacheKey));
        if (!row) return null;
        return {
            stage: String(row.stage || ''),
            model: String(row.model || ''),
            inputCount: Number(row.input_count || 0),
            outputText: String(row.output_text || ''),
            createdAt: Number(row.created_at || 0),
            updatedAt: Number(row.updated_at || 0),
        };
    }

    function save({ cacheKey, stage, model, inputCount = 0, outputText }) {
        const now = Math.floor(Date.now() / 1000);
        saveStatement.run(
            String(cacheKey),
            String(stage || ''),
            String(model || ''),
            Math.max(0, Number(inputCount) || 0),
            String(outputText || ''),
            now,
            now,
        );
    }

    function prune({ maxAgeDays = 120 } = {}) {
        const cutoff = Math.floor(Date.now() / 1000) - Math.max(1, Number(maxAgeDays) || 120) * 86400;
        return Number(pruneStatement.run(cutoff).changes || 0);
    }

    return { path, get, save, prune, close: () => db.close() };
}

const summaryStateStore = createSummaryStateStore();
export const SUMMARY_STATE_DB_PATH = summaryStateStore.path;
export const getCachedSummaryStage = (...args) => summaryStateStore.get(...args);
export const saveCachedSummaryStage = (...args) => summaryStateStore.save(...args);
export const pruneSummaryStateCache = (...args) => summaryStateStore.prune(...args);
