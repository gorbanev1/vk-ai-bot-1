/**
 * Durable paid-summary state.
 *
 * V188.43 keeps the legacy hierarchy tables for backward compatibility, but
 * scheduled accumulation uses an immutable calendar rollup:
 * raw messages -> intraday batch revisions -> daily revisions -> week/month-clipped week segments -> monthly revisions.
 * Every raw message and every lower-level revision can be promoted only once.
 * Late recovered messages therefore create delta revisions instead of causing
 * an already-paid corpus to be summarized again.
 */
import { mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { resolveAutoSummaryStateDirectory } from './autoSummaryStateStore.js';

export const HIERARCHICAL_SUMMARY_DB_FILENAME = 'hierarchical-summary-v188.sqlite';

function mapNode(row) {
    if (!row) return null;
    let childKeys = [];
    try {
        const parsed = JSON.parse(String(row.child_keys_json || '[]'));
        if (Array.isArray(parsed)) childKeys = parsed.map(String);
    } catch {
        childKeys = [];
    }
    return {
        nodeKey: String(row.node_key || ''),
        peerId: Number(row.peer_id || 0),
        level: Number(row.level || 0),
        kind: String(row.kind || ''),
        startAt: Number(row.start_at || 0),
        endAt: Number(row.end_at || 0),
        messageCount: Number(row.message_count || 0),
        estimatedTokens: Number(row.estimated_tokens || 0),
        inputHash: String(row.input_hash || ''),
        model: String(row.model || ''),
        summaryText: String(row.summary_text || ''),
        childKeys,
        createdAt: Number(row.created_at || 0),
        updatedAt: Number(row.updated_at || 0),
    };
}


function mapBatch(row) {
    if (!row) return null;
    return {
        peerId: Number(row.peer_id || 0),
        dayKey: String(row.day_key || ''),
        slotLabel: String(row.slot_label || ''),
        sliceKey: String(row.slice_key || ''),
        revision: Number(row.revision || 0),
        startAt: Number(row.start_at || 0),
        endAt: Number(row.end_at || 0),
        inputHash: String(row.input_hash || ''),
        summaryText: String(row.summary_text || ''),
        model: String(row.model || ''),
        messageCount: Number(row.message_count || 0),
        generatedAt: Number(row.generated_at || 0),
        deliveredAt: Number(row.delivered_at || 0),
    };
}

function mapDaily(row) {
    if (!row) return null;
    return {
        peerId: Number(row.peer_id || 0),
        dayKey: String(row.day_key || ''),
        revision: Number(row.revision || 0),
        startAt: Number(row.start_at || 0),
        endAt: Number(row.end_at || 0),
        inputHash: String(row.input_hash || ''),
        summaryText: String(row.summary_text || ''),
        model: String(row.model || ''),
        messageCount: Number(row.message_count || 0),
        generatedAt: Number(row.generated_at || 0),
        deliveredAt: Number(row.delivered_at || 0),
    };
}

function mapWeekly(row) {
    if (!row) return null;
    return {
        peerId: Number(row.peer_id || 0),
        weekKey: String(row.week_key || ''),
        monthKey: String(row.month_key || ''),
        segmentKey: String(row.segment_key || ''),
        revision: Number(row.revision || 0),
        startAt: Number(row.start_at || 0),
        endAt: Number(row.end_at || 0),
        inputHash: String(row.input_hash || ''),
        summaryText: String(row.summary_text || ''),
        model: String(row.model || ''),
        sourceCount: Number(row.source_count || 0),
        messageCount: Number(row.message_count || 0),
        generatedAt: Number(row.generated_at || 0),
    };
}

function mapMonthly(row) {
    if (!row) return null;
    return {
        peerId: Number(row.peer_id || 0),
        monthKey: String(row.month_key || ''),
        revision: Number(row.revision || 0),
        startAt: Number(row.start_at || 0),
        endAt: Number(row.end_at || 0),
        inputHash: String(row.input_hash || ''),
        summaryText: String(row.summary_text || ''),
        model: String(row.model || ''),
        sourceCount: Number(row.source_count || 0),
        messageCount: Number(row.message_count || 0),
        generatedAt: Number(row.generated_at || 0),
    };
}

function mapDelivery(row) {
    if (!row) return null;
    return {
        peerId: Number(row.peer_id || 0),
        periodType: String(row.period_type || ''),
        periodKey: String(row.period_key || ''),
        contentHash: String(row.content_hash || ''),
        deliveredAt: Number(row.delivered_at || 0),
    };
}

export function createHierarchicalSummaryStateStore({
    directory = resolveAutoSummaryStateDirectory(),
    databasePath = '',
} = {}) {
    const path = databasePath
        ? resolve(String(databasePath))
        : join(resolve(String(directory)), HIERARCHICAL_SUMMARY_DB_FILENAME);
    mkdirSync(dirname(path), { recursive: true });
    const db = new DatabaseSync(path);
    db.exec(`
        PRAGMA busy_timeout = 5000;
        PRAGMA journal_mode = WAL;
        PRAGMA synchronous = FULL;

        CREATE TABLE IF NOT EXISTS hierarchy_nodes (
            node_key TEXT PRIMARY KEY,
            peer_id INTEGER NOT NULL,
            level INTEGER NOT NULL DEFAULT 0,
            kind TEXT NOT NULL,
            start_at INTEGER NOT NULL DEFAULT 0,
            end_at INTEGER NOT NULL DEFAULT 0,
            message_count INTEGER NOT NULL DEFAULT 0,
            estimated_tokens INTEGER NOT NULL DEFAULT 0,
            input_hash TEXT NOT NULL,
            model TEXT NOT NULL DEFAULT '',
            summary_text TEXT NOT NULL,
            child_keys_json TEXT NOT NULL DEFAULT '[]',
            created_at INTEGER NOT NULL,
            updated_at INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS hierarchy_nodes_peer_level_idx
        ON hierarchy_nodes (peer_id, level, start_at, end_at);
        CREATE INDEX IF NOT EXISTS hierarchy_nodes_peer_kind_idx
        ON hierarchy_nodes (peer_id, kind, start_at, end_at);

        CREATE TABLE IF NOT EXISTS hierarchy_message_state (
            message_key TEXT PRIMARY KEY,
            peer_id INTEGER NOT NULL,
            content_hash TEXT NOT NULL,
            node_key TEXT NOT NULL,
            source_peer_id INTEGER NOT NULL DEFAULT 0,
            conversation_message_id INTEGER NOT NULL DEFAULT 0,
            created_at INTEGER NOT NULL DEFAULT 0,
            updated_at INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS hierarchy_message_peer_idx
        ON hierarchy_message_state (peer_id, created_at, source_peer_id, conversation_message_id);
        CREATE INDEX IF NOT EXISTS hierarchy_message_node_idx
        ON hierarchy_message_state (node_key);
        CREATE INDEX IF NOT EXISTS hierarchy_message_content_idx
        ON hierarchy_message_state (peer_id, content_hash);

        CREATE TABLE IF NOT EXISTS hierarchy_peer_state (
            peer_id INTEGER PRIMARY KEY,
            root_node_key TEXT NOT NULL DEFAULT '',
            bootstrap_complete INTEGER NOT NULL DEFAULT 0,
            last_scan_at INTEGER NOT NULL DEFAULT 0,
            updated_at INTEGER NOT NULL DEFAULT 0
        );

        CREATE TABLE IF NOT EXISTS hierarchy_period_runs (
            peer_id INTEGER NOT NULL,
            period_type TEXT NOT NULL,
            period_key TEXT NOT NULL,
            start_at INTEGER NOT NULL,
            end_at INTEGER NOT NULL,
            input_hash TEXT NOT NULL,
            summary_text TEXT NOT NULL,
            model TEXT NOT NULL DEFAULT '',
            message_count INTEGER NOT NULL DEFAULT 0,
            generated_at INTEGER NOT NULL,
            delivered_at INTEGER NOT NULL DEFAULT 0,
            PRIMARY KEY (peer_id, period_type, period_key)
        );

        CREATE TABLE IF NOT EXISTS hierarchy_batch_summaries (
            peer_id INTEGER NOT NULL,
            day_key TEXT NOT NULL,
            slot_label TEXT NOT NULL,
            slice_key TEXT NOT NULL,
            revision INTEGER NOT NULL,
            start_at INTEGER NOT NULL,
            end_at INTEGER NOT NULL,
            input_hash TEXT NOT NULL,
            summary_text TEXT NOT NULL,
            model TEXT NOT NULL DEFAULT '',
            message_count INTEGER NOT NULL DEFAULT 0,
            generated_at INTEGER NOT NULL,
            delivered_at INTEGER NOT NULL DEFAULT 0,
            PRIMARY KEY (peer_id, slice_key, revision),
            UNIQUE (peer_id, slice_key, input_hash)
        );
        CREATE INDEX IF NOT EXISTS hierarchy_batch_peer_period_idx
        ON hierarchy_batch_summaries (peer_id, start_at, end_at, day_key, slot_label, revision);

        CREATE TABLE IF NOT EXISTS hierarchy_daily_summaries (
            peer_id INTEGER NOT NULL,
            day_key TEXT NOT NULL,
            revision INTEGER NOT NULL,
            start_at INTEGER NOT NULL,
            end_at INTEGER NOT NULL,
            input_hash TEXT NOT NULL,
            summary_text TEXT NOT NULL,
            model TEXT NOT NULL DEFAULT '',
            message_count INTEGER NOT NULL DEFAULT 0,
            generated_at INTEGER NOT NULL,
            delivered_at INTEGER NOT NULL DEFAULT 0,
            PRIMARY KEY (peer_id, day_key, revision),
            UNIQUE (peer_id, day_key, input_hash)
        );
        CREATE INDEX IF NOT EXISTS hierarchy_daily_peer_period_idx
        ON hierarchy_daily_summaries (peer_id, start_at, end_at, day_key, revision);

        CREATE TABLE IF NOT EXISTS hierarchy_weekly_summaries (
            peer_id INTEGER NOT NULL,
            week_key TEXT NOT NULL,
            month_key TEXT NOT NULL,
            segment_key TEXT NOT NULL,
            revision INTEGER NOT NULL,
            start_at INTEGER NOT NULL,
            end_at INTEGER NOT NULL,
            input_hash TEXT NOT NULL,
            summary_text TEXT NOT NULL,
            model TEXT NOT NULL DEFAULT '',
            source_count INTEGER NOT NULL DEFAULT 0,
            message_count INTEGER NOT NULL DEFAULT 0,
            generated_at INTEGER NOT NULL,
            PRIMARY KEY (peer_id, segment_key, revision),
            UNIQUE (peer_id, segment_key, input_hash)
        );
        CREATE INDEX IF NOT EXISTS hierarchy_weekly_peer_week_idx
        ON hierarchy_weekly_summaries (peer_id, week_key, start_at, end_at, revision);
        CREATE INDEX IF NOT EXISTS hierarchy_weekly_peer_month_idx
        ON hierarchy_weekly_summaries (peer_id, month_key, start_at, end_at, revision);

        CREATE TABLE IF NOT EXISTS hierarchy_monthly_summaries (
            peer_id INTEGER NOT NULL,
            month_key TEXT NOT NULL,
            revision INTEGER NOT NULL,
            start_at INTEGER NOT NULL,
            end_at INTEGER NOT NULL,
            input_hash TEXT NOT NULL,
            summary_text TEXT NOT NULL,
            model TEXT NOT NULL DEFAULT '',
            source_count INTEGER NOT NULL DEFAULT 0,
            message_count INTEGER NOT NULL DEFAULT 0,
            generated_at INTEGER NOT NULL,
            PRIMARY KEY (peer_id, month_key, revision),
            UNIQUE (peer_id, month_key, input_hash)
        );
        CREATE INDEX IF NOT EXISTS hierarchy_monthly_peer_period_idx
        ON hierarchy_monthly_summaries (peer_id, start_at, end_at, month_key, revision);

        CREATE TABLE IF NOT EXISTS hierarchy_rollup_edges (
            peer_id INTEGER NOT NULL,
            target_level TEXT NOT NULL,
            target_period_key TEXT NOT NULL,
            target_revision INTEGER NOT NULL,
            source_level TEXT NOT NULL,
            source_period_key TEXT NOT NULL,
            source_revision INTEGER NOT NULL,
            created_at INTEGER NOT NULL,
            PRIMARY KEY (
                peer_id, target_level, target_period_key, target_revision,
                source_level, source_period_key, source_revision
            ),
            UNIQUE (peer_id, target_level, source_level, source_period_key, source_revision)
        );
        CREATE INDEX IF NOT EXISTS hierarchy_rollup_edges_source_idx
        ON hierarchy_rollup_edges (peer_id, source_level, source_period_key, source_revision);

        CREATE TABLE IF NOT EXISTS hierarchy_rollup_delivery (
            peer_id INTEGER NOT NULL,
            period_type TEXT NOT NULL,
            period_key TEXT NOT NULL,
            content_hash TEXT NOT NULL DEFAULT '',
            delivered_at INTEGER NOT NULL,
            PRIMARY KEY (peer_id, period_type, period_key)
        );
    `);

    const getNodeStmt = db.prepare(`SELECT * FROM hierarchy_nodes WHERE node_key = ? LIMIT 1`);
    const nodesStmt = db.prepare(`
        SELECT * FROM hierarchy_nodes
        WHERE peer_id = ? AND kind = ?
        ORDER BY start_at ASC, end_at ASC, node_key ASC
    `);
    const saveNodeStmt = db.prepare(`
        INSERT INTO hierarchy_nodes (
            node_key, peer_id, level, kind, start_at, end_at, message_count,
            estimated_tokens, input_hash, model, summary_text, child_keys_json,
            created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(node_key) DO UPDATE SET
            summary_text = excluded.summary_text,
            model = excluded.model,
            updated_at = excluded.updated_at
    `);
    const messageStmt = db.prepare(`
        SELECT message_key, content_hash, node_key, source_peer_id,
               conversation_message_id, created_at
        FROM hierarchy_message_state WHERE message_key = ? LIMIT 1
    `);
    const peerMessagesStmt = db.prepare(`
        SELECT message_key, content_hash, node_key, source_peer_id,
               conversation_message_id, created_at
        FROM hierarchy_message_state
        WHERE peer_id = ?
        ORDER BY created_at ASC, source_peer_id ASC, conversation_message_id ASC
    `);
    const upsertMessageStmt = db.prepare(`
        INSERT INTO hierarchy_message_state (
            message_key, peer_id, content_hash, node_key, source_peer_id,
            conversation_message_id, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(message_key) DO NOTHING
    `);
    const getPeerStmt = db.prepare(`SELECT * FROM hierarchy_peer_state WHERE peer_id = ? LIMIT 1`);
    const savePeerStmt = db.prepare(`
        INSERT INTO hierarchy_peer_state (peer_id, root_node_key, bootstrap_complete, last_scan_at, updated_at)
        VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(peer_id) DO UPDATE SET
            root_node_key = excluded.root_node_key,
            bootstrap_complete = excluded.bootstrap_complete,
            last_scan_at = excluded.last_scan_at,
            updated_at = excluded.updated_at
    `);
    const getPeriodStmt = db.prepare(`
        SELECT * FROM hierarchy_period_runs
        WHERE peer_id = ? AND period_type = ? AND period_key = ? LIMIT 1
    `);
    const savePeriodStmt = db.prepare(`
        INSERT INTO hierarchy_period_runs (
            peer_id, period_type, period_key, start_at, end_at, input_hash,
            summary_text, model, message_count, generated_at, delivered_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(peer_id, period_type, period_key) DO UPDATE SET
            start_at = excluded.start_at,
            end_at = excluded.end_at,
            input_hash = excluded.input_hash,
            summary_text = excluded.summary_text,
            model = excluded.model,
            message_count = excluded.message_count,
            generated_at = excluded.generated_at,
            delivered_at = MAX(hierarchy_period_runs.delivered_at, excluded.delivered_at)
    `);
    const markDeliveredStmt = db.prepare(`
        UPDATE hierarchy_period_runs SET delivered_at = ?
        WHERE peer_id = ? AND period_type = ? AND period_key = ?
    `);

    const batchByHashStmt = db.prepare(`
        SELECT * FROM hierarchy_batch_summaries
        WHERE peer_id = ? AND slice_key = ? AND input_hash = ? LIMIT 1
    `);
    const batchRevisionStmt = db.prepare(`
        SELECT COALESCE(MAX(revision), 0) AS revision
        FROM hierarchy_batch_summaries WHERE peer_id = ? AND slice_key = ?
    `);
    const insertBatchStmt = db.prepare(`
        INSERT INTO hierarchy_batch_summaries (
            peer_id, day_key, slot_label, slice_key, revision, start_at, end_at, input_hash,
            summary_text, model, message_count, generated_at, delivered_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const batchForSliceStmt = db.prepare(`
        SELECT * FROM hierarchy_batch_summaries
        WHERE peer_id = ? AND slice_key = ? ORDER BY revision ASC
    `);
    const allBatchStmt = db.prepare(`
        SELECT * FROM hierarchy_batch_summaries
        WHERE peer_id = ? ORDER BY start_at ASC, slice_key ASC, revision ASC
    `);
    const unconsumedBatchStmt = db.prepare(`
        SELECT b.* FROM hierarchy_batch_summaries b
        WHERE b.peer_id = ? AND NOT EXISTS (
            SELECT 1 FROM hierarchy_rollup_edges e
            WHERE e.peer_id = b.peer_id
              AND e.target_level = 'day'
              AND e.source_level = 'batch'
              AND e.source_period_key = b.slice_key
              AND e.source_revision = b.revision
        )
        ORDER BY b.start_at ASC, b.slice_key ASC, b.revision ASC
    `);
    const markBatchDeliveredStmt = db.prepare(`
        UPDATE hierarchy_batch_summaries SET delivered_at = MAX(delivered_at, ?)
        WHERE peer_id = ? AND slice_key = ?
    `);

    const dailyByHashStmt = db.prepare(`
        SELECT * FROM hierarchy_daily_summaries
        WHERE peer_id = ? AND day_key = ? AND input_hash = ? LIMIT 1
    `);
    const dailyRevisionStmt = db.prepare(`
        SELECT COALESCE(MAX(revision), 0) AS revision
        FROM hierarchy_daily_summaries WHERE peer_id = ? AND day_key = ?
    `);
    const insertDailyStmt = db.prepare(`
        INSERT INTO hierarchy_daily_summaries (
            peer_id, day_key, revision, start_at, end_at, input_hash,
            summary_text, model, message_count, generated_at, delivered_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const dailyForDayStmt = db.prepare(`
        SELECT * FROM hierarchy_daily_summaries
        WHERE peer_id = ? AND day_key = ? ORDER BY revision ASC
    `);
    const allDailyStmt = db.prepare(`
        SELECT * FROM hierarchy_daily_summaries
        WHERE peer_id = ? ORDER BY start_at ASC, day_key ASC, revision ASC
    `);
    const unconsumedDailyStmt = db.prepare(`
        SELECT d.* FROM hierarchy_daily_summaries d
        WHERE d.peer_id = ? AND NOT EXISTS (
            SELECT 1 FROM hierarchy_rollup_edges e
            WHERE e.peer_id = d.peer_id
              AND e.target_level = 'week'
              AND e.source_level = 'day'
              AND e.source_period_key = d.day_key
              AND e.source_revision = d.revision
        )
        ORDER BY d.start_at ASC, d.day_key ASC, d.revision ASC
    `);
    const markDailyDeliveredStmt = db.prepare(`
        UPDATE hierarchy_daily_summaries SET delivered_at = MAX(delivered_at, ?)
        WHERE peer_id = ? AND day_key = ?
    `);

    const weeklyByHashStmt = db.prepare(`
        SELECT * FROM hierarchy_weekly_summaries
        WHERE peer_id = ? AND segment_key = ? AND input_hash = ? LIMIT 1
    `);
    const weeklyRevisionStmt = db.prepare(`
        SELECT COALESCE(MAX(revision), 0) AS revision
        FROM hierarchy_weekly_summaries WHERE peer_id = ? AND segment_key = ?
    `);
    const insertWeeklyStmt = db.prepare(`
        INSERT INTO hierarchy_weekly_summaries (
            peer_id, week_key, month_key, segment_key, revision, start_at, end_at,
            input_hash, summary_text, model, source_count, message_count, generated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const weeklyForWeekStmt = db.prepare(`
        SELECT * FROM hierarchy_weekly_summaries
        WHERE peer_id = ? AND week_key = ? ORDER BY start_at ASC, segment_key ASC, revision ASC
    `);
    const allWeeklyStmt = db.prepare(`
        SELECT * FROM hierarchy_weekly_summaries
        WHERE peer_id = ? ORDER BY start_at ASC, segment_key ASC, revision ASC
    `);
    const unconsumedWeeklyStmt = db.prepare(`
        SELECT w.* FROM hierarchy_weekly_summaries w
        WHERE w.peer_id = ? AND NOT EXISTS (
            SELECT 1 FROM hierarchy_rollup_edges e
            WHERE e.peer_id = w.peer_id
              AND e.target_level = 'month'
              AND e.source_level = 'week'
              AND e.source_period_key = w.segment_key
              AND e.source_revision = w.revision
        )
        ORDER BY w.start_at ASC, w.segment_key ASC, w.revision ASC
    `);

    const monthlyByHashStmt = db.prepare(`
        SELECT * FROM hierarchy_monthly_summaries
        WHERE peer_id = ? AND month_key = ? AND input_hash = ? LIMIT 1
    `);
    const monthlyRevisionStmt = db.prepare(`
        SELECT COALESCE(MAX(revision), 0) AS revision
        FROM hierarchy_monthly_summaries WHERE peer_id = ? AND month_key = ?
    `);
    const insertMonthlyStmt = db.prepare(`
        INSERT INTO hierarchy_monthly_summaries (
            peer_id, month_key, revision, start_at, end_at, input_hash, summary_text,
            model, source_count, message_count, generated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const monthlyForMonthStmt = db.prepare(`
        SELECT * FROM hierarchy_monthly_summaries
        WHERE peer_id = ? AND month_key = ? ORDER BY revision ASC
    `);
    const allMonthlyStmt = db.prepare(`
        SELECT * FROM hierarchy_monthly_summaries
        WHERE peer_id = ? ORDER BY start_at ASC, month_key ASC, revision ASC
    `);

    const insertEdgeStmt = db.prepare(`
        INSERT INTO hierarchy_rollup_edges (
            peer_id, target_level, target_period_key, target_revision,
            source_level, source_period_key, source_revision, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const deliveryStmt = db.prepare(`
        SELECT * FROM hierarchy_rollup_delivery
        WHERE peer_id = ? AND period_type = ? AND period_key = ? LIMIT 1
    `);
    const upsertDeliveryStmt = db.prepare(`
        INSERT INTO hierarchy_rollup_delivery (
            peer_id, period_type, period_key, content_hash, delivered_at
        ) VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(peer_id, period_type, period_key) DO UPDATE SET
            content_hash = CASE
                WHEN hierarchy_rollup_delivery.content_hash = '' THEN excluded.content_hash
                ELSE hierarchy_rollup_delivery.content_hash
            END,
            delivered_at = MIN(hierarchy_rollup_delivery.delivered_at, excluded.delivered_at)
    `);

    function withImmediateTransaction(callback) {
        db.exec('BEGIN IMMEDIATE');
        try {
            const result = callback();
            db.exec('COMMIT');
            return result;
        } catch (error) {
            try { db.exec('ROLLBACK'); } catch { /* ignore rollback failure */ }
            throw error;
        }
    }

    function insertMessageState(state, now) {
        upsertMessageStmt.run(
            String(state.messageKey), Number(state.peerId), String(state.contentHash), String(state.nodeKey),
            Number(state.sourcePeerId || 0), Number(state.conversationMessageId || 0), Number(state.createdAt || 0), now,
        );
    }

    function insertEdge({ peerId, targetLevel, targetPeriodKey, targetRevision, sourceLevel, sourcePeriodKey, sourceRevision }, now) {
        insertEdgeStmt.run(
            Number(peerId), String(targetLevel), String(targetPeriodKey), Number(targetRevision),
            String(sourceLevel), String(sourcePeriodKey), Number(sourceRevision), now,
        );
    }

    return {
        path,
        getNode(nodeKey) { return mapNode(getNodeStmt.get(String(nodeKey))); },
        getNodes(peerId, kind = 'leaf') { return nodesStmt.all(Number(peerId), String(kind)).map(mapNode); },
        saveNode(node) {
            const now = Math.floor(Date.now() / 1000);
            saveNodeStmt.run(
                String(node.nodeKey), Number(node.peerId), Number(node.level || 0), String(node.kind),
                Number(node.startAt || 0), Number(node.endAt || 0), Number(node.messageCount || 0),
                Number(node.estimatedTokens || 0), String(node.inputHash || ''), String(node.model || ''),
                String(node.summaryText || ''), JSON.stringify(node.childKeys || []), now, now,
            );
            return this.getNode(node.nodeKey);
        },
        getMessageState(messageKey) {
            const row = messageStmt.get(String(messageKey));
            return row ? {
                messageKey: String(row.message_key), contentHash: String(row.content_hash),
                nodeKey: String(row.node_key), sourcePeerId: Number(row.source_peer_id || 0),
                conversationMessageId: Number(row.conversation_message_id || 0), createdAt: Number(row.created_at || 0),
            } : null;
        },
        getMessageStates(peerId) {
            return peerMessagesStmt.all(Number(peerId)).map((row) => ({
                messageKey: String(row.message_key), contentHash: String(row.content_hash),
                nodeKey: String(row.node_key), sourcePeerId: Number(row.source_peer_id || 0),
                conversationMessageId: Number(row.conversation_message_id || 0), createdAt: Number(row.created_at || 0),
            }));
        },
        saveMessageState(state) {
            insertMessageState(state, Math.floor(Date.now() / 1000));
        },
        getPeerState(peerId) {
            const row = getPeerStmt.get(Number(peerId));
            return row ? {
                peerId: Number(row.peer_id), rootNodeKey: String(row.root_node_key || ''),
                bootstrapComplete: Boolean(row.bootstrap_complete), lastScanAt: Number(row.last_scan_at || 0),
            } : null;
        },
        savePeerState(state) {
            const now = Math.floor(Date.now() / 1000);
            savePeerStmt.run(Number(state.peerId), String(state.rootNodeKey || ''), state.bootstrapComplete ? 1 : 0, Number(state.lastScanAt || 0), now);
        },
        getPeriod(peerId, periodType, periodKey) {
            const row = getPeriodStmt.get(Number(peerId), String(periodType), String(periodKey));
            return row ? {
                peerId: Number(row.peer_id), periodType: String(row.period_type), periodKey: String(row.period_key),
                startAt: Number(row.start_at), endAt: Number(row.end_at), inputHash: String(row.input_hash),
                summaryText: String(row.summary_text), model: String(row.model || ''), messageCount: Number(row.message_count || 0),
                generatedAt: Number(row.generated_at || 0), deliveredAt: Number(row.delivered_at || 0),
            } : null;
        },
        savePeriod(row) {
            const now = Math.floor(Date.now() / 1000);
            savePeriodStmt.run(
                Number(row.peerId), String(row.periodType), String(row.periodKey), Number(row.startAt), Number(row.endAt),
                String(row.inputHash), String(row.summaryText), String(row.model || ''), Number(row.messageCount || 0),
                Number(row.generatedAt || now), Number(row.deliveredAt || 0),
            );
        },
        markPeriodDelivered(peerId, periodType, periodKey, deliveredAt = Math.floor(Date.now() / 1000)) {
            markDeliveredStmt.run(Number(deliveredAt), Number(peerId), String(periodType), String(periodKey));
        },

        getBatchSummaries(peerId, sliceKey = '') {
            const rows = sliceKey
                ? batchForSliceStmt.all(Number(peerId), String(sliceKey))
                : allBatchStmt.all(Number(peerId));
            return rows.map(mapBatch);
        },
        getUnconsumedBatchSummaries(peerId) {
            return unconsumedBatchStmt.all(Number(peerId)).map(mapBatch);
        },
        saveBatchRevisionWithMessages(row, messageStates = []) {
            const existing = batchByHashStmt.get(Number(row.peerId), String(row.sliceKey), String(row.inputHash));
            if (existing) return mapBatch(existing);
            return withImmediateTransaction(() => {
                const again = batchByHashStmt.get(Number(row.peerId), String(row.sliceKey), String(row.inputHash));
                if (again) return mapBatch(again);
                const now = Math.floor(Date.now() / 1000);
                const revision = Number(batchRevisionStmt.get(Number(row.peerId), String(row.sliceKey))?.revision || 0) + 1;
                insertBatchStmt.run(
                    Number(row.peerId), String(row.dayKey), String(row.slotLabel), String(row.sliceKey), revision,
                    Number(row.startAt), Number(row.endAt), String(row.inputHash), String(row.summaryText),
                    String(row.model || ''), Number(row.messageCount || 0), Number(row.generatedAt || now), Number(row.deliveredAt || 0),
                );
                const nodeKey = `batch:${String(row.sliceKey)}:${revision}`;
                for (const state of messageStates) insertMessageState({ ...state, nodeKey }, now);
                return mapBatch(batchByHashStmt.get(Number(row.peerId), String(row.sliceKey), String(row.inputHash)));
            });
        },
        markBatchDelivered(peerId, sliceKey, deliveredAt = Math.floor(Date.now() / 1000)) {
            markBatchDeliveredStmt.run(Number(deliveredAt), Number(peerId), String(sliceKey));
        },

        getDailySummaries(peerId, dayKey = '') {
            const rows = dayKey
                ? dailyForDayStmt.all(Number(peerId), String(dayKey))
                : allDailyStmt.all(Number(peerId));
            return rows.map(mapDaily);
        },
        getUnconsumedDailySummaries(peerId) {
            return unconsumedDailyStmt.all(Number(peerId)).map(mapDaily);
        },
        saveDailyRevisionWithMessages(row, messageStates = []) {
            const existing = dailyByHashStmt.get(Number(row.peerId), String(row.dayKey), String(row.inputHash));
            if (existing) return mapDaily(existing);
            return withImmediateTransaction(() => {
                const again = dailyByHashStmt.get(Number(row.peerId), String(row.dayKey), String(row.inputHash));
                if (again) return mapDaily(again);
                const now = Math.floor(Date.now() / 1000);
                const revision = Number(dailyRevisionStmt.get(Number(row.peerId), String(row.dayKey))?.revision || 0) + 1;
                insertDailyStmt.run(
                    Number(row.peerId), String(row.dayKey), revision, Number(row.startAt), Number(row.endAt),
                    String(row.inputHash), String(row.summaryText), String(row.model || ''), Number(row.messageCount || 0),
                    Number(row.generatedAt || now), Number(row.deliveredAt || 0),
                );
                const nodeKey = `daily:${String(row.dayKey)}:${revision}`;
                for (const state of messageStates) insertMessageState({ ...state, nodeKey }, now);
                return mapDaily(dailyByHashStmt.get(Number(row.peerId), String(row.dayKey), String(row.inputHash)));
            });
        },
        saveDailyRevisionWithSources(row, sources = []) {
            const existing = dailyByHashStmt.get(Number(row.peerId), String(row.dayKey), String(row.inputHash));
            if (existing) return mapDaily(existing);
            return withImmediateTransaction(() => {
                const again = dailyByHashStmt.get(Number(row.peerId), String(row.dayKey), String(row.inputHash));
                if (again) return mapDaily(again);
                const now = Math.floor(Date.now() / 1000);
                const revision = Number(dailyRevisionStmt.get(Number(row.peerId), String(row.dayKey))?.revision || 0) + 1;
                insertDailyStmt.run(
                    Number(row.peerId), String(row.dayKey), revision, Number(row.startAt), Number(row.endAt),
                    String(row.inputHash), String(row.summaryText), String(row.model || ''), Number(row.messageCount || 0),
                    Number(row.generatedAt || now), Number(row.deliveredAt || 0),
                );
                for (const source of sources) {
                    insertEdge({
                        peerId: row.peerId,
                        targetLevel: 'day',
                        targetPeriodKey: row.dayKey,
                        targetRevision: revision,
                        sourceLevel: 'batch',
                        sourcePeriodKey: source.sliceKey,
                        sourceRevision: source.revision,
                    }, now);
                }
                return mapDaily(dailyByHashStmt.get(Number(row.peerId), String(row.dayKey), String(row.inputHash)));
            });
        },
        markDailyDelivered(peerId, dayKey, deliveredAt = Math.floor(Date.now() / 1000)) {
            markDailyDeliveredStmt.run(Number(deliveredAt), Number(peerId), String(dayKey));
        },

        getWeeklySummaries(peerId, weekKey = '') {
            const rows = weekKey
                ? weeklyForWeekStmt.all(Number(peerId), String(weekKey))
                : allWeeklyStmt.all(Number(peerId));
            return rows.map(mapWeekly);
        },
        getUnconsumedWeeklySummaries(peerId) {
            return unconsumedWeeklyStmt.all(Number(peerId)).map(mapWeekly);
        },
        saveWeeklyRevisionWithSources(row, sources = []) {
            const existing = weeklyByHashStmt.get(Number(row.peerId), String(row.segmentKey), String(row.inputHash));
            if (existing) return mapWeekly(existing);
            return withImmediateTransaction(() => {
                const again = weeklyByHashStmt.get(Number(row.peerId), String(row.segmentKey), String(row.inputHash));
                if (again) return mapWeekly(again);
                const now = Math.floor(Date.now() / 1000);
                const revision = Number(weeklyRevisionStmt.get(Number(row.peerId), String(row.segmentKey))?.revision || 0) + 1;
                insertWeeklyStmt.run(
                    Number(row.peerId), String(row.weekKey), String(row.monthKey), String(row.segmentKey), revision,
                    Number(row.startAt), Number(row.endAt), String(row.inputHash), String(row.summaryText), String(row.model || ''),
                    Number(row.sourceCount || sources.length), Number(row.messageCount || 0), Number(row.generatedAt || now),
                );
                for (const source of sources) {
                    insertEdge({
                        peerId: row.peerId,
                        targetLevel: 'week',
                        targetPeriodKey: row.segmentKey,
                        targetRevision: revision,
                        sourceLevel: 'day',
                        sourcePeriodKey: source.dayKey,
                        sourceRevision: source.revision,
                    }, now);
                }
                return mapWeekly(weeklyByHashStmt.get(Number(row.peerId), String(row.segmentKey), String(row.inputHash)));
            });
        },

        getMonthlySummaries(peerId, monthKey = '') {
            const rows = monthKey
                ? monthlyForMonthStmt.all(Number(peerId), String(monthKey))
                : allMonthlyStmt.all(Number(peerId));
            return rows.map(mapMonthly);
        },
        saveMonthlyRevisionWithSources(row, sources = []) {
            const existing = monthlyByHashStmt.get(Number(row.peerId), String(row.monthKey), String(row.inputHash));
            if (existing) return mapMonthly(existing);
            return withImmediateTransaction(() => {
                const again = monthlyByHashStmt.get(Number(row.peerId), String(row.monthKey), String(row.inputHash));
                if (again) return mapMonthly(again);
                const now = Math.floor(Date.now() / 1000);
                const revision = Number(monthlyRevisionStmt.get(Number(row.peerId), String(row.monthKey))?.revision || 0) + 1;
                insertMonthlyStmt.run(
                    Number(row.peerId), String(row.monthKey), revision, Number(row.startAt), Number(row.endAt),
                    String(row.inputHash), String(row.summaryText), String(row.model || ''), Number(row.sourceCount || sources.length),
                    Number(row.messageCount || 0), Number(row.generatedAt || now),
                );
                for (const source of sources) {
                    insertEdge({
                        peerId: row.peerId,
                        targetLevel: 'month',
                        targetPeriodKey: row.monthKey,
                        targetRevision: revision,
                        sourceLevel: 'week',
                        sourcePeriodKey: source.segmentKey,
                        sourceRevision: source.revision,
                    }, now);
                }
                return mapMonthly(monthlyByHashStmt.get(Number(row.peerId), String(row.monthKey), String(row.inputHash)));
            });
        },

        getRollupDelivery(peerId, periodType, periodKey) {
            return mapDelivery(deliveryStmt.get(Number(peerId), String(periodType), String(periodKey)));
        },
        markRollupDelivered(peerId, periodType, periodKey, contentHash = '', deliveredAt = Math.floor(Date.now() / 1000)) {
            upsertDeliveryStmt.run(Number(peerId), String(periodType), String(periodKey), String(contentHash || ''), Number(deliveredAt));
            return this.getRollupDelivery(peerId, periodType, periodKey);
        },
        close() { db.close(); },
    };
}

const hierarchicalSummaryStateStore = createHierarchicalSummaryStateStore();
export const HIERARCHICAL_SUMMARY_DB_PATH = hierarchicalSummaryStateStore.path;
export const getHierarchyNode = (...args) => hierarchicalSummaryStateStore.getNode(...args);
export const getHierarchyNodes = (...args) => hierarchicalSummaryStateStore.getNodes(...args);
export const saveHierarchyNode = (...args) => hierarchicalSummaryStateStore.saveNode(...args);
export const getHierarchyMessageState = (...args) => hierarchicalSummaryStateStore.getMessageState(...args);
export const getHierarchyMessageStates = (...args) => hierarchicalSummaryStateStore.getMessageStates(...args);
export const saveHierarchyMessageState = (...args) => hierarchicalSummaryStateStore.saveMessageState(...args);
export const getHierarchyPeerState = (...args) => hierarchicalSummaryStateStore.getPeerState(...args);
export const saveHierarchyPeerState = (...args) => hierarchicalSummaryStateStore.savePeerState(...args);
export const getHierarchyPeriod = (...args) => hierarchicalSummaryStateStore.getPeriod(...args);
export const saveHierarchyPeriod = (...args) => hierarchicalSummaryStateStore.savePeriod(...args);
export const markHierarchyPeriodDelivered = (...args) => hierarchicalSummaryStateStore.markPeriodDelivered(...args);

export const getHierarchyBatchSummaries = (...args) => hierarchicalSummaryStateStore.getBatchSummaries(...args);
export const getHierarchyUnconsumedBatchSummaries = (...args) => hierarchicalSummaryStateStore.getUnconsumedBatchSummaries(...args);
export const saveHierarchyBatchRevisionWithMessages = (...args) => hierarchicalSummaryStateStore.saveBatchRevisionWithMessages(...args);
export const markHierarchyBatchDelivered = (...args) => hierarchicalSummaryStateStore.markBatchDelivered(...args);
export const getHierarchyDailySummaries = (...args) => hierarchicalSummaryStateStore.getDailySummaries(...args);
export const getHierarchyUnconsumedDailySummaries = (...args) => hierarchicalSummaryStateStore.getUnconsumedDailySummaries(...args);
export const saveHierarchyDailyRevisionWithMessages = (...args) => hierarchicalSummaryStateStore.saveDailyRevisionWithMessages(...args);
export const saveHierarchyDailyRevisionWithSources = (...args) => hierarchicalSummaryStateStore.saveDailyRevisionWithSources(...args);
export const markHierarchyDailyDelivered = (...args) => hierarchicalSummaryStateStore.markDailyDelivered(...args);
export const getHierarchyWeeklySummaries = (...args) => hierarchicalSummaryStateStore.getWeeklySummaries(...args);
export const getHierarchyUnconsumedWeeklySummaries = (...args) => hierarchicalSummaryStateStore.getUnconsumedWeeklySummaries(...args);
export const saveHierarchyWeeklyRevisionWithSources = (...args) => hierarchicalSummaryStateStore.saveWeeklyRevisionWithSources(...args);
export const getHierarchyMonthlySummaries = (...args) => hierarchicalSummaryStateStore.getMonthlySummaries(...args);
export const saveHierarchyMonthlyRevisionWithSources = (...args) => hierarchicalSummaryStateStore.saveMonthlyRevisionWithSources(...args);
export const getHierarchyRollupDelivery = (...args) => hierarchicalSummaryStateStore.getRollupDelivery(...args);
export const markHierarchyRollupDelivered = (...args) => hierarchicalSummaryStateStore.markRollupDelivered(...args);
