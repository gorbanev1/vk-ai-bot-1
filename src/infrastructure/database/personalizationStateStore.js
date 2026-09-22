/**
 * V187 durable personalization checkpoints.
 *
 * This database deliberately lives outside the project directory (the same
 * durable state root used by auto-summary), so replacing the source tree or
 * restoring bot.sqlite cannot make already-processed message ranges hit GPT
 * again.
 *
 * Rules:
 * - style: automatic, at most one GPT call per 500 NEW messages;
 * - dossier: NEVER automatic; only the explicit dossier command advances it;
 * - successful batches are checkpointed immediately, so a later failure does
 *   not repeat earlier paid batches.
 */
import { mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { resolveAutoSummaryStateDirectory } from './autoSummaryStateStore.js';

export const PERSONALIZATION_STATE_DB_FILENAME = 'personalization-v187.sqlite';

function normalizeFacts(value) {
    if (!Array.isArray(value)) return [];
    return value
        .map((item) => ({
            fact: String(item?.fact ?? '').replace(/\s+/gu, ' ').trim(),
            rating: Math.max(1, Math.min(9999, Number.parseInt(item?.rating, 10) || 1)),
        }))
        .filter((item) => item.fact);
}

function normalizeCursor({ lastCreatedAt = 0, lastConversationMessageId = 0 } = {}) {
    return {
        lastCreatedAt: Math.max(0, Number(lastCreatedAt) || 0),
        lastConversationMessageId: Math.max(0, Number(lastConversationMessageId) || 0),
    };
}

export function createPersonalizationStateStore({
    directory = resolveAutoSummaryStateDirectory(),
    databasePath = '',
} = {}) {
    const path = databasePath
        ? resolve(String(databasePath))
        : join(resolve(String(directory)), PERSONALIZATION_STATE_DB_FILENAME);

    mkdirSync(dirname(path), { recursive: true });
    const db = new DatabaseSync(path);
    db.exec(`
        PRAGMA journal_mode = WAL;
        PRAGMA synchronous = FULL;
        PRAGMA busy_timeout = 5000;

        CREATE TABLE IF NOT EXISTS style_batch_state (
            peer_id INTEGER NOT NULL,
            user_id INTEGER NOT NULL,
            last_created_at INTEGER NOT NULL DEFAULT 0,
            last_cmid INTEGER NOT NULL DEFAULT 0,
            processed_message_count INTEGER NOT NULL DEFAULT 0,
            style_text TEXT NOT NULL DEFAULT '',
            updated_at INTEGER NOT NULL,
            PRIMARY KEY (peer_id, user_id)
        );

        CREATE TABLE IF NOT EXISTS communication_style_examples (
            peer_id INTEGER NOT NULL,
            user_id INTEGER NOT NULL,
            source_created_at INTEGER NOT NULL DEFAULT 0,
            source_cmid INTEGER NOT NULL DEFAULT 0,
            example_text TEXT NOT NULL,
            updated_at INTEGER NOT NULL,
            PRIMARY KEY (peer_id, user_id, source_created_at, source_cmid, example_text)
        );

        CREATE INDEX IF NOT EXISTS communication_style_examples_lookup
        ON communication_style_examples(peer_id, user_id, updated_at DESC);

        CREATE TABLE IF NOT EXISTS dossier_command_state (
            peer_id INTEGER NOT NULL,
            user_id INTEGER NOT NULL,
            last_created_at INTEGER NOT NULL DEFAULT 0,
            last_cmid INTEGER NOT NULL DEFAULT 0,
            processed_message_count INTEGER NOT NULL DEFAULT 0,
            facts_json TEXT NOT NULL DEFAULT '[]',
            portrait_text TEXT NOT NULL DEFAULT '',
            updated_at INTEGER NOT NULL,
            PRIMARY KEY (peer_id, user_id)
        );


        CREATE TABLE IF NOT EXISTS dossier_source_state (
            peer_id INTEGER NOT NULL,
            user_id INTEGER NOT NULL,
            source_peer_id INTEGER NOT NULL,
            last_created_at INTEGER NOT NULL DEFAULT 0,
            last_cmid INTEGER NOT NULL DEFAULT 0,
            processed_message_count INTEGER NOT NULL DEFAULT 0,
            updated_at INTEGER NOT NULL,
            PRIMARY KEY (peer_id, user_id, source_peer_id)
        );

        CREATE TABLE IF NOT EXISTS dossier_render_cache (
            peer_id INTEGER NOT NULL,
            user_id INTEGER NOT NULL,
            variant TEXT NOT NULL,
            input_hash TEXT NOT NULL,
            portrait_text TEXT NOT NULL DEFAULT '',
            updated_at INTEGER NOT NULL,
            PRIMARY KEY (peer_id, user_id, variant)
        );
    `);

    const getStyleStatement = db.prepare(`
        SELECT peer_id, user_id, last_created_at, last_cmid,
               processed_message_count, style_text, updated_at
        FROM style_batch_state
        WHERE peer_id = ? AND user_id = ?
        LIMIT 1
    `);
    const saveStyleStatement = db.prepare(`
        INSERT INTO style_batch_state (
            peer_id, user_id, last_created_at, last_cmid,
            processed_message_count, style_text, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(peer_id, user_id) DO UPDATE SET
            last_created_at = excluded.last_created_at,
            last_cmid = excluded.last_cmid,
            processed_message_count = excluded.processed_message_count,
            style_text = excluded.style_text,
            updated_at = excluded.updated_at
    `);

    const getStyleExamplesStatement = db.prepare(`
        SELECT source_created_at, source_cmid, example_text, updated_at
        FROM communication_style_examples
        WHERE peer_id = ? AND user_id = ?
        ORDER BY updated_at DESC, source_created_at DESC, source_cmid DESC
        LIMIT ?
    `);
    const saveStyleExampleStatement = db.prepare(`
        INSERT OR IGNORE INTO communication_style_examples (
            peer_id, user_id, source_created_at, source_cmid, example_text, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?)
    `);
    const pruneStyleExamplesStatement = db.prepare(`
        DELETE FROM communication_style_examples
        WHERE rowid IN (
            SELECT rowid FROM communication_style_examples
            WHERE peer_id = ? AND user_id = ?
            ORDER BY updated_at DESC, source_created_at DESC, source_cmid DESC
            LIMIT -1 OFFSET ?
        )
    `);

    const getDossierStatement = db.prepare(`
        SELECT peer_id, user_id, last_created_at, last_cmid,
               processed_message_count, facts_json, portrait_text, updated_at
        FROM dossier_command_state
        WHERE peer_id = ? AND user_id = ?
        LIMIT 1
    `);
    const saveDossierStatement = db.prepare(`
        INSERT INTO dossier_command_state (
            peer_id, user_id, last_created_at, last_cmid,
            processed_message_count, facts_json, portrait_text, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(peer_id, user_id) DO UPDATE SET
            last_created_at = excluded.last_created_at,
            last_cmid = excluded.last_cmid,
            processed_message_count = excluded.processed_message_count,
            facts_json = excluded.facts_json,
            portrait_text = excluded.portrait_text,
            updated_at = excluded.updated_at
    `);

    const getDossierRenderCacheStatement = db.prepare(`
        SELECT input_hash, portrait_text, updated_at
        FROM dossier_render_cache
        WHERE peer_id = ? AND user_id = ? AND variant = ?
        LIMIT 1
    `);
    const saveDossierRenderCacheStatement = db.prepare(`
        INSERT INTO dossier_render_cache (
            peer_id, user_id, variant, input_hash, portrait_text, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(peer_id, user_id, variant) DO UPDATE SET
            input_hash = excluded.input_hash,
            portrait_text = excluded.portrait_text,
            updated_at = excluded.updated_at
    `);

    const getDossierSourceStatesStatement = db.prepare(`
        SELECT source_peer_id, last_created_at, last_cmid,
               processed_message_count, updated_at
        FROM dossier_source_state
        WHERE peer_id = ? AND user_id = ?
        ORDER BY source_peer_id ASC
    `);
    const saveDossierSourceStateStatement = db.prepare(`
        INSERT INTO dossier_source_state (
            peer_id, user_id, source_peer_id, last_created_at, last_cmid,
            processed_message_count, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(peer_id, user_id, source_peer_id) DO UPDATE SET
            last_created_at = excluded.last_created_at,
            last_cmid = excluded.last_cmid,
            processed_message_count = excluded.processed_message_count,
            updated_at = excluded.updated_at
    `);

    function getStyleState(peerId, userId) {
        const row = getStyleStatement.get(Number(peerId), Number(userId));
        if (!row) return null;
        return {
            peerId: Number(row.peer_id),
            userId: Number(row.user_id),
            lastCreatedAt: Number(row.last_created_at || 0),
            lastConversationMessageId: Number(row.last_cmid || 0),
            processedMessageCount: Number(row.processed_message_count || 0),
            styleText: String(row.style_text || '').trim(),
            updatedAt: Number(row.updated_at || 0),
        };
    }

    function saveStyleState({
        peerId,
        userId,
        lastCreatedAt = 0,
        lastConversationMessageId = 0,
        processedMessageCount = 0,
        styleText = '',
        updatedAt = Math.floor(Date.now() / 1000),
    }) {
        const cursor = normalizeCursor({ lastCreatedAt, lastConversationMessageId });
        saveStyleStatement.run(
            Number(peerId),
            Number(userId),
            cursor.lastCreatedAt,
            cursor.lastConversationMessageId,
            Math.max(0, Number(processedMessageCount) || 0),
            String(styleText || '').trim(),
            Math.max(0, Number(updatedAt) || 0),
        );
    }

    function getStyleExamples(peerId, userId, limit = 12) {
        const safeLimit = Math.max(1, Math.min(40, Number.parseInt(limit, 10) || 12));
        return getStyleExamplesStatement
            .all(Number(peerId), Number(userId), safeLimit)
            .map((row) => ({
                createdAt: Number(row.source_created_at || 0),
                conversationMessageId: Number(row.source_cmid || 0),
                text: String(row.example_text || '').trim(),
                updatedAt: Number(row.updated_at || 0),
            }))
            .filter((row) => row.text);
    }

    function saveStyleExamples({
        peerId,
        userId,
        examples = [],
        maxStored = 32,
        updatedAt = Math.floor(Date.now() / 1000),
    }) {
        const safePeerId = Number(peerId);
        const safeUserId = Number(userId);
        const safeMax = Math.max(8, Math.min(100, Number.parseInt(maxStored, 10) || 32));
        db.exec('BEGIN IMMEDIATE');
        try {
            for (const example of Array.isArray(examples) ? examples : []) {
                const text = String(example?.text ?? '').replace(/\s+/gu, ' ').trim().slice(0, 700);
                if (!text) continue;
                saveStyleExampleStatement.run(
                    safePeerId,
                    safeUserId,
                    Math.max(0, Number(example?.createdAt) || 0),
                    Math.max(0, Number(example?.conversationMessageId) || 0),
                    text,
                    Math.max(0, Number(updatedAt) || 0),
                );
            }
            pruneStyleExamplesStatement.run(safePeerId, safeUserId, safeMax);
            db.exec('COMMIT');
        } catch (error) {
            db.exec('ROLLBACK');
            throw error;
        }
    }

    function getDossierState(peerId, userId) {
        const row = getDossierStatement.get(Number(peerId), Number(userId));
        if (!row) return null;
        let facts = [];
        try {
            facts = normalizeFacts(JSON.parse(String(row.facts_json || '[]')));
        } catch {
            facts = [];
        }
        return {
            peerId: Number(row.peer_id),
            userId: Number(row.user_id),
            lastCreatedAt: Number(row.last_created_at || 0),
            lastConversationMessageId: Number(row.last_cmid || 0),
            processedMessageCount: Number(row.processed_message_count || 0),
            facts,
            portraitText: String(row.portrait_text || '').trim(),
            updatedAt: Number(row.updated_at || 0),
        };
    }

    function saveDossierState({
        peerId,
        userId,
        lastCreatedAt = 0,
        lastConversationMessageId = 0,
        processedMessageCount = 0,
        facts = [],
        portraitText = '',
        updatedAt = Math.floor(Date.now() / 1000),
    }) {
        const cursor = normalizeCursor({ lastCreatedAt, lastConversationMessageId });
        saveDossierStatement.run(
            Number(peerId),
            Number(userId),
            cursor.lastCreatedAt,
            cursor.lastConversationMessageId,
            Math.max(0, Number(processedMessageCount) || 0),
            JSON.stringify(normalizeFacts(facts)),
            String(portraitText || '').trim(),
            Math.max(0, Number(updatedAt) || 0),
        );
    }

    function getDossierRenderCache(peerId, userId, variant, inputHash = '') {
        const safeVariant = String(variant || '').trim().toLowerCase();
        if (!safeVariant) return null;
        const row = getDossierRenderCacheStatement.get(
            Number(peerId),
            Number(userId),
            safeVariant,
        );
        if (!row) return null;
        const storedHash = String(row.input_hash || '').trim();
        const expectedHash = String(inputHash || '').trim();
        if (expectedHash && storedHash !== expectedHash) return null;
        return {
            inputHash: storedHash,
            portraitText: String(row.portrait_text || '').trim(),
            updatedAt: Number(row.updated_at || 0),
        };
    }

    function saveDossierRenderCache({
        peerId,
        userId,
        variant,
        inputHash,
        portraitText,
        updatedAt = Math.floor(Date.now() / 1000),
    }) {
        const safeVariant = String(variant || '').trim().toLowerCase();
        const safeHash = String(inputHash || '').trim();
        if (!safeVariant || !safeHash) {
            throw new TypeError('variant и inputHash обязательны для dossier render cache');
        }
        saveDossierRenderCacheStatement.run(
            Number(peerId),
            Number(userId),
            safeVariant,
            safeHash,
            String(portraitText || '').trim(),
            Math.max(0, Number(updatedAt) || 0),
        );
    }

    function getDossierSourceStates(peerId, userId) {
        return getDossierSourceStatesStatement
            .all(Number(peerId), Number(userId))
            .map((row) => ({
                sourcePeerId: Number(row.source_peer_id),
                lastCreatedAt: Number(row.last_created_at || 0),
                lastConversationMessageId: Number(row.last_cmid || 0),
                processedMessageCount: Number(row.processed_message_count || 0),
                updatedAt: Number(row.updated_at || 0),
            }));
    }

    function saveDossierSourceState({
        peerId,
        userId,
        sourcePeerId,
        lastCreatedAt = 0,
        lastConversationMessageId = 0,
        processedMessageCount = 0,
        updatedAt = Math.floor(Date.now() / 1000),
    }) {
        const cursor = normalizeCursor({ lastCreatedAt, lastConversationMessageId });
        saveDossierSourceStateStatement.run(
            Number(peerId),
            Number(userId),
            Number(sourcePeerId),
            cursor.lastCreatedAt,
            cursor.lastConversationMessageId,
            Math.max(0, Number(processedMessageCount) || 0),
            Math.max(0, Number(updatedAt) || 0),
        );
    }

    return {
        path,
        getStyleState,
        saveStyleState,
        getStyleExamples,
        saveStyleExamples,
        getDossierState,
        saveDossierState,
        getDossierRenderCache,
        saveDossierRenderCache,
        getDossierSourceStates,
        saveDossierSourceState,
        close() {
            db.close();
        },
    };
}

const personalizationStateStore = createPersonalizationStateStore();

export const PERSONALIZATION_STATE_DB_PATH = personalizationStateStore.path;
export const getStyleBatchState = (...args) => personalizationStateStore.getStyleState(...args);
export const saveStyleBatchState = (...args) => personalizationStateStore.saveStyleState(...args);
export const getDossierCommandState = (...args) => personalizationStateStore.getDossierState(...args);
export const saveDossierCommandState = (...args) => personalizationStateStore.saveDossierState(...args);
export const getDossierRenderCache = (...args) => personalizationStateStore.getDossierRenderCache(...args);
export const saveDossierRenderCache = (...args) => personalizationStateStore.saveDossierRenderCache(...args);
export const getDossierSourceStates = (...args) => personalizationStateStore.getDossierSourceStates(...args);
export const saveDossierSourceState = (...args) => personalizationStateStore.saveDossierSourceState(...args);

export const getCommunicationStyleExamples = (...args) => personalizationStateStore.getStyleExamples(...args);
export const saveCommunicationStyleExamples = (...args) => personalizationStateStore.saveStyleExamples(...args);
