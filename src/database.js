import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

const currentDirectory = dirname(fileURLToPath(import.meta.url));
const dataDirectory = join(currentDirectory, '..', 'data');

mkdirSync(dataDirectory, {
    recursive: true,
});

const database = new DatabaseSync(
    join(dataDirectory, 'bot.sqlite'),
);

database.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA synchronous = NORMAL;
    PRAGMA foreign_keys = ON;

    CREATE TABLE IF NOT EXISTS messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        peer_id INTEGER NOT NULL,
        sender_id INTEGER NOT NULL,
        conversation_message_id INTEGER NOT NULL,
        text TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        UNIQUE (peer_id, conversation_message_id)
    );

    CREATE INDEX IF NOT EXISTS messages_peer_created_idx
    ON messages (peer_id, created_at);

    CREATE INDEX IF NOT EXISTS messages_peer_sender_created_idx
    ON messages (peer_id, sender_id, created_at);

    CREATE TABLE IF NOT EXISTS dossier_facts (
        peer_id INTEGER NOT NULL,
        user_id INTEGER NOT NULL,
        normalized_fact TEXT NOT NULL,
        fact TEXT NOT NULL,
        rating INTEGER NOT NULL DEFAULT 1,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY (peer_id, user_id, normalized_fact)
    );

    CREATE INDEX IF NOT EXISTS dossier_facts_lookup_idx
    ON dossier_facts (peer_id, user_id, rating DESC, updated_at DESC);

    CREATE TABLE IF NOT EXISTS dossier_daily_runs (
        peer_id INTEGER NOT NULL,
        user_id INTEGER NOT NULL,
        source_day TEXT NOT NULL,
        processed_at INTEGER NOT NULL,
        PRIMARY KEY (peer_id, user_id, source_day)
    );

    CREATE TABLE IF NOT EXISTS participant_styles (
        peer_id INTEGER NOT NULL,
        user_id INTEGER NOT NULL,
        profile_text TEXT NOT NULL DEFAULT '',
        updated_at INTEGER NOT NULL,
        PRIMARY KEY (peer_id, user_id)
    );

    CREATE TABLE IF NOT EXISTS interaction_memory (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        peer_id INTEGER NOT NULL,
        user_id INTEGER NOT NULL,
        role TEXT NOT NULL CHECK (role IN ('user', 'assistant')),
        text TEXT NOT NULL,
        created_at INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS interaction_memory_lookup_idx
    ON interaction_memory (peer_id, user_id, created_at DESC, id DESC);

    CREATE TABLE IF NOT EXISTS user_rate_limits (
        user_id INTEGER PRIMARY KEY,
        window_started_at INTEGER NOT NULL,
        request_count INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS gpt_daily_rate_limits (
        user_id INTEGER PRIMARY KEY,
        day_key TEXT NOT NULL,
        request_count INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS gpt_model_daily_rate_limits (
        user_id INTEGER NOT NULL,
        bucket TEXT NOT NULL,
        day_key TEXT NOT NULL,
        request_count INTEGER NOT NULL,
        PRIMARY KEY (user_id, bucket)
    );
`);

const insertMessageStatement = database.prepare(`
    INSERT OR IGNORE INTO messages (
        peer_id,
        sender_id,
        conversation_message_id,
        text,
        created_at
    ) VALUES (?, ?, ?, ?, ?)
`);

const chatMessageCountStatement = database.prepare(`
    SELECT COUNT(*) AS count
    FROM messages
    WHERE peer_id = ?
`);

const chatParticipantCountStatement = database.prepare(`
    SELECT COUNT(DISTINCT sender_id) AS count
    FROM messages
    WHERE peer_id = ?
      AND sender_id > 0
`);

const chatTopStatement = database.prepare(`
    SELECT
        sender_id,
        COUNT(*) AS message_count
    FROM messages
    WHERE peer_id = ?
      AND sender_id > 0
    GROUP BY sender_id
    ORDER BY message_count DESC, sender_id ASC
    LIMIT 10
`);

const messagesByCountStatement = database.prepare(`
    SELECT
        peer_id,
        sender_id,
        conversation_message_id,
        text,
        created_at
    FROM messages
    WHERE peer_id = ?
    ORDER BY created_at DESC, id DESC
    LIMIT ?
`);

const messagesSinceStatement = database.prepare(`
    SELECT
        peer_id,
        sender_id,
        conversation_message_id,
        text,
        created_at
    FROM messages
    WHERE peer_id = ?
      AND created_at >= ?
    ORDER BY created_at ASC, id ASC
    LIMIT ?
`);

const recentParticipantMessagesStatement = database.prepare(`
    SELECT
        peer_id,
        sender_id,
        conversation_message_id,
        text,
        created_at
    FROM messages
    WHERE peer_id = ?
      AND sender_id = ?
      AND text <> ''
    ORDER BY created_at DESC, id DESC
    LIMIT ?
`);

const participantPairsStatement = database.prepare(`
    SELECT DISTINCT
        peer_id,
        sender_id
    FROM messages
    WHERE created_at >= ?
      AND created_at < ?
      AND sender_id > 0
    ORDER BY peer_id ASC, sender_id ASC
`);

const participantMessagesStatement = database.prepare(`
    SELECT
        peer_id,
        sender_id,
        conversation_message_id,
        text,
        created_at
    FROM messages
    WHERE peer_id = ?
      AND sender_id = ?
      AND created_at >= ?
      AND created_at < ?
    ORDER BY created_at ASC, id ASC
    LIMIT ?
`);

const dossierFactsStatement = database.prepare(`
    SELECT
        fact,
        rating,
        created_at,
        updated_at
    FROM dossier_facts
    WHERE peer_id = ?
      AND user_id = ?
    ORDER BY rating DESC, updated_at DESC, fact ASC
`);

const deleteDossierFactsStatement = database.prepare(`
    DELETE FROM dossier_facts
    WHERE peer_id = ?
      AND user_id = ?
`);

const insertDossierFactStatement = database.prepare(`
    INSERT INTO dossier_facts (
        peer_id,
        user_id,
        normalized_fact,
        fact,
        rating,
        created_at,
        updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?)
`);

const dailyRunStatement = database.prepare(`
    SELECT 1 AS found
    FROM dossier_daily_runs
    WHERE peer_id = ?
      AND user_id = ?
      AND source_day = ?
`);

const markDailyRunStatement = database.prepare(`
    INSERT OR REPLACE INTO dossier_daily_runs (
        peer_id,
        user_id,
        source_day,
        processed_at
    ) VALUES (?, ?, ?, ?)
`);

const participantStyleStatement = database.prepare(`
    SELECT
        profile_text,
        updated_at
    FROM participant_styles
    WHERE peer_id = ?
      AND user_id = ?
`);

const upsertParticipantStyleStatement = database.prepare(`
    INSERT INTO participant_styles (
        peer_id,
        user_id,
        profile_text,
        updated_at
    ) VALUES (?, ?, ?, ?)
    ON CONFLICT (peer_id, user_id) DO UPDATE SET
        profile_text = excluded.profile_text,
        updated_at = excluded.updated_at
`);

const insertInteractionStatement = database.prepare(`
    INSERT INTO interaction_memory (
        peer_id,
        user_id,
        role,
        text,
        created_at
    ) VALUES (?, ?, ?, ?, ?)
`);

const recentInteractionsStatement = database.prepare(`
    SELECT
        role,
        text,
        created_at
    FROM interaction_memory
    WHERE peer_id = ?
      AND user_id = ?
    ORDER BY created_at DESC, id DESC
    LIMIT ?
`);

const trimInteractionsStatement = database.prepare(`
    DELETE FROM interaction_memory
    WHERE peer_id = ?
      AND user_id = ?
      AND id NOT IN (
          SELECT id
          FROM interaction_memory
          WHERE peer_id = ?
            AND user_id = ?
          ORDER BY created_at DESC, id DESC
          LIMIT ?
      )
`);

const userRateLimitStatement = database.prepare(`
    SELECT
        window_started_at,
        request_count
    FROM user_rate_limits
    WHERE user_id = ?
`);

const upsertUserRateLimitStatement = database.prepare(`
    INSERT INTO user_rate_limits (
        user_id,
        window_started_at,
        request_count
    ) VALUES (?, ?, ?)
    ON CONFLICT (user_id) DO UPDATE SET
        window_started_at = excluded.window_started_at,
        request_count = excluded.request_count
`);

const refundUserRateLimitStatement = database.prepare(`
    UPDATE user_rate_limits
    SET request_count = CASE
        WHEN request_count > 0 THEN request_count - 1
        ELSE 0
    END
    WHERE user_id = ?
      AND window_started_at = ?
`);

const gptDailyRateLimitStatement = database.prepare(`
    SELECT
        day_key,
        request_count
    FROM gpt_daily_rate_limits
    WHERE user_id = ?
`);

const upsertGptDailyRateLimitStatement = database.prepare(`
    INSERT INTO gpt_daily_rate_limits (
        user_id,
        day_key,
        request_count
    ) VALUES (?, ?, ?)
    ON CONFLICT (user_id) DO UPDATE SET
        day_key = excluded.day_key,
        request_count = excluded.request_count
`);

const refundGptDailyRateLimitStatement = database.prepare(`
    UPDATE gpt_daily_rate_limits
    SET request_count = CASE
        WHEN request_count > 0 THEN request_count - 1
        ELSE 0
    END
    WHERE user_id = ?
      AND day_key = ?
`);

const gptModelDailyRateLimitStatement = database.prepare(`
    SELECT
        day_key,
        request_count
    FROM gpt_model_daily_rate_limits
    WHERE user_id = ?
      AND bucket = ?
`);

const upsertGptModelDailyRateLimitStatement = database.prepare(`
    INSERT INTO gpt_model_daily_rate_limits (
        user_id,
        bucket,
        day_key,
        request_count
    ) VALUES (?, ?, ?, ?)
    ON CONFLICT (user_id, bucket) DO UPDATE SET
        day_key = excluded.day_key,
        request_count = excluded.request_count
`);

const refundGptModelDailyRateLimitStatement = database.prepare(`
    UPDATE gpt_model_daily_rate_limits
    SET request_count = CASE
        WHEN request_count > 0 THEN request_count - 1
        ELSE 0
    END
    WHERE user_id = ?
      AND bucket = ?
      AND day_key = ?
`);

const clearUserRateLimitsStatement = database.prepare(`
    DELETE FROM user_rate_limits
`);

const clearGptDailyRateLimitsStatement = database.prepare(`
    DELETE FROM gpt_daily_rate_limits
`);

const clearGptModelDailyRateLimitsStatement = database.prepare(`
    DELETE FROM gpt_model_daily_rate_limits
`);

function mapMessage(row) {
    return {
        peerId: Number(row.peer_id),
        senderId: Number(row.sender_id),
        conversationMessageId: Number(row.conversation_message_id),
        text: String(row.text ?? ''),
        createdAt: Number(row.created_at),
    };
}

function normalizeFact(value) {
    return String(value)
        .toLowerCase()
        .replace(/ё/g, 'е')
        .replace(/[\p{P}\p{S}]+/gu, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}

export function saveIncomingMessage({
    peerId,
    senderId,
    conversationMessageId,
    text,
    createdAt = Math.floor(Date.now() / 1000),
}) {
    const safeConversationMessageId =
        Number.isSafeInteger(Number(conversationMessageId))
            ? Number(conversationMessageId)
            : Number(createdAt) * 100000 + Math.floor(Math.random() * 100000);

    insertMessageStatement.run(
        Number(peerId),
        Number(senderId),
        safeConversationMessageId,
        String(text ?? ''),
        Number(createdAt),
    );
}

export function getChatStats(peerId) {
    const messageCount = Number(
        chatMessageCountStatement.get(Number(peerId))?.count ?? 0,
    );

    const participantCount = Number(
        chatParticipantCountStatement.get(Number(peerId))?.count ?? 0,
    );

    const top = chatTopStatement
        .all(Number(peerId))
        .map((row) => ({
            senderId: Number(row.sender_id),
            messageCount: Number(row.message_count),
        }));

    return {
        messageCount,
        participantCount,
        top,
    };
}

export function getMessagesByCount(peerId, count) {
    return messagesByCountStatement
        .all(Number(peerId), Number(count))
        .map(mapMessage)
        .reverse();
}

export function getMessagesSince(peerId, sinceTimestamp, limit) {
    return messagesSinceStatement
        .all(
            Number(peerId),
            Number(sinceTimestamp),
            Number(limit),
        )
        .map(mapMessage);
}

export function getRecentParticipantMessages(peerId, userId, limit = 12) {
    return recentParticipantMessagesStatement
        .all(
            Number(peerId),
            Number(userId),
            Number(limit),
        )
        .map(mapMessage)
        .reverse();
}

export function getParticipantPairsBetween(startTimestamp, endTimestamp) {
    return participantPairsStatement
        .all(
            Number(startTimestamp),
            Number(endTimestamp),
        )
        .map((row) => ({
            peerId: Number(row.peer_id),
            userId: Number(row.sender_id),
        }));
}

export function getParticipantMessagesBetween({
    peerId,
    userId,
    startTimestamp,
    endTimestamp,
    limit = 20000,
}) {
    return participantMessagesStatement
        .all(
            Number(peerId),
            Number(userId),
            Number(startTimestamp),
            Number(endTimestamp),
            Number(limit),
        )
        .map(mapMessage);
}

export function getDossierFacts(peerId, userId) {
    return dossierFactsStatement
        .all(Number(peerId), Number(userId))
        .map((row) => ({
            fact: String(row.fact),
            rating: Number(row.rating),
            createdAt: Number(row.created_at),
            updatedAt: Number(row.updated_at),
        }));
}

export function replaceDossierFacts(peerId, userId, facts) {
    const now = Math.floor(Date.now() / 1000);
    const uniqueFacts = new Map();

    for (const item of facts) {
        const fact = String(item.fact ?? '')
            .replace(/\s+/g, ' ')
            .trim();

        const rating = Math.max(
            1,
            Math.min(9999, Number.parseInt(item.rating, 10) || 1),
        );

        const normalizedFact = normalizeFact(fact);

        if (!fact || !normalizedFact) {
            continue;
        }

        const existing = uniqueFacts.get(normalizedFact);

        if (!existing || rating > existing.rating) {
            uniqueFacts.set(normalizedFact, {
                fact,
                rating,
            });
        }
    }

    database.exec('BEGIN IMMEDIATE');

    try {
        deleteDossierFactsStatement.run(
            Number(peerId),
            Number(userId),
        );

        for (const [normalizedFact, item] of uniqueFacts) {
            insertDossierFactStatement.run(
                Number(peerId),
                Number(userId),
                normalizedFact,
                item.fact,
                item.rating,
                now,
                now,
            );
        }

        database.exec('COMMIT');
    } catch (error) {
        database.exec('ROLLBACK');
        throw error;
    }
}

export function hasDossierDailyRun(peerId, userId, sourceDay) {
    return Boolean(
        dailyRunStatement.get(
            Number(peerId),
            Number(userId),
            String(sourceDay),
        ),
    );
}

export function markDossierDailyRun(peerId, userId, sourceDay) {
    markDailyRunStatement.run(
        Number(peerId),
        Number(userId),
        String(sourceDay),
        Math.floor(Date.now() / 1000),
    );
}

export function getParticipantStyle(peerId, userId) {
    const row = participantStyleStatement.get(
        Number(peerId),
        Number(userId),
    );

    return row
        ? {
            profileText: String(row.profile_text ?? ''),
            updatedAt: Number(row.updated_at),
        }
        : {
            profileText: '',
            updatedAt: 0,
        };
}

export function setParticipantStyle(peerId, userId, profileText) {
    upsertParticipantStyleStatement.run(
        Number(peerId),
        Number(userId),
        String(profileText ?? '').trim(),
        Math.floor(Date.now() / 1000),
    );
}

export function saveInteraction({
    peerId,
    userId,
    role,
    text,
    createdAt = Math.floor(Date.now() / 1000),
}) {
    if (!['user', 'assistant'].includes(role)) {
        throw new TypeError(`Неизвестная роль памяти: ${role}`);
    }

    const cleanText = String(text ?? '').trim();

    if (!cleanText) {
        return;
    }

    insertInteractionStatement.run(
        Number(peerId),
        Number(userId),
        role,
        cleanText,
        Number(createdAt),
    );

    trimInteractionsStatement.run(
        Number(peerId),
        Number(userId),
        Number(peerId),
        Number(userId),
        200,
    );
}

export function getRecentInteractions(peerId, userId, limit = 16) {
    return recentInteractionsStatement
        .all(
            Number(peerId),
            Number(userId),
            Number(limit),
        )
        .map((row) => ({
            role: String(row.role),
            text: String(row.text ?? ''),
            createdAt: Number(row.created_at),
        }))
        .reverse();
}

export function consumeUserRateLimit({
    userId,
    limit = 10,
    windowSeconds = 3600,
    now = Math.floor(Date.now() / 1000),
}) {
    const safeUserId = Number(userId);
    const safeLimit = Number(limit);
    const safeWindowSeconds = Number(windowSeconds);
    const safeNow = Number(now);

    if (!Number.isSafeInteger(safeUserId) || safeUserId <= 0) {
        throw new TypeError('userId должен быть положительным целым числом');
    }

    if (!Number.isSafeInteger(safeLimit) || safeLimit <= 0) {
        throw new TypeError('limit должен быть положительным целым числом');
    }

    if (
        !Number.isSafeInteger(safeWindowSeconds) ||
        safeWindowSeconds <= 0
    ) {
        throw new TypeError(
            'windowSeconds должен быть положительным целым числом',
        );
    }

    if (!Number.isSafeInteger(safeNow) || safeNow <= 0) {
        throw new TypeError('now должен быть положительным Unix-временем');
    }

    database.exec('BEGIN IMMEDIATE');

    try {
        const row = userRateLimitStatement.get(safeUserId);

        let windowStartedAt = row
            ? Number(row.window_started_at)
            : safeNow;

        let requestCount = row
            ? Number(row.request_count)
            : 0;

        if (
            !row ||
            safeNow >= windowStartedAt + safeWindowSeconds
        ) {
            windowStartedAt = safeNow;
            requestCount = 0;
        }

        const resetAt = windowStartedAt + safeWindowSeconds;

        if (requestCount >= safeLimit) {
            database.exec('COMMIT');

            return {
                allowed: false,
                limit: safeLimit,
                used: requestCount,
                remaining: 0,
                windowStartedAt,
                resetAt,
            };
        }

        requestCount += 1;

        upsertUserRateLimitStatement.run(
            safeUserId,
            windowStartedAt,
            requestCount,
        );

        database.exec('COMMIT');

        return {
            allowed: true,
            limit: safeLimit,
            used: requestCount,
            remaining: Math.max(0, safeLimit - requestCount),
            windowStartedAt,
            resetAt,
        };
    } catch (error) {
        database.exec('ROLLBACK');
        throw error;
    }
}



export function refundUserRateLimit({
    userId,
    windowStartedAt,
}) {
    const safeUserId = Number(userId);
    const safeWindowStartedAt = Number(windowStartedAt);

    if (!Number.isSafeInteger(safeUserId) || safeUserId <= 0) {
        throw new TypeError('userId должен быть положительным целым числом');
    }

    if (
        !Number.isSafeInteger(safeWindowStartedAt) ||
        safeWindowStartedAt <= 0
    ) {
        throw new TypeError(
            'windowStartedAt должен быть положительным Unix-временем',
        );
    }

    database.exec('BEGIN IMMEDIATE');

    try {
        const result = refundUserRateLimitStatement.run(
            safeUserId,
            safeWindowStartedAt,
        );

        database.exec('COMMIT');

        return Number(result.changes ?? 0) > 0;
    } catch (error) {
        database.exec('ROLLBACK');
        throw error;
    }
}

export function consumeGptDailyRateLimit({
    userId,
    dayKey,
    limit = 5,
    resetAt,
}) {
    const safeUserId = Number(userId);
    const safeDayKey = String(dayKey ?? '').trim();
    const safeLimit = Number(limit);
    const safeResetAt = Number(resetAt);

    if (!Number.isSafeInteger(safeUserId) || safeUserId <= 0) {
        throw new TypeError('userId должен быть положительным целым числом');
    }

    if (!/^\d{4}-\d{2}-\d{2}$/u.test(safeDayKey)) {
        throw new TypeError('dayKey должен иметь формат YYYY-MM-DD');
    }

    if (!Number.isSafeInteger(safeLimit) || safeLimit <= 0) {
        throw new TypeError('limit должен быть положительным целым числом');
    }

    if (!Number.isSafeInteger(safeResetAt) || safeResetAt <= 0) {
        throw new TypeError('resetAt должен быть положительным Unix-временем');
    }

    database.exec('BEGIN IMMEDIATE');

    try {
        const row = gptDailyRateLimitStatement.get(safeUserId);
        let requestCount = row && String(row.day_key) === safeDayKey
            ? Number(row.request_count)
            : 0;

        if (requestCount >= safeLimit) {
            database.exec('COMMIT');

            return {
                allowed: false,
                limit: safeLimit,
                used: requestCount,
                remaining: 0,
                dayKey: safeDayKey,
                resetAt: safeResetAt,
            };
        }

        requestCount += 1;

        upsertGptDailyRateLimitStatement.run(
            safeUserId,
            safeDayKey,
            requestCount,
        );

        database.exec('COMMIT');

        return {
            allowed: true,
            limit: safeLimit,
            used: requestCount,
            remaining: Math.max(0, safeLimit - requestCount),
            dayKey: safeDayKey,
            resetAt: safeResetAt,
        };
    } catch (error) {
        database.exec('ROLLBACK');
        throw error;
    }
}

export function refundGptDailyRateLimit({ userId, dayKey }) {
    const safeUserId = Number(userId);
    const safeDayKey = String(dayKey ?? '').trim();

    if (!Number.isSafeInteger(safeUserId) || safeUserId <= 0) {
        throw new TypeError('userId должен быть положительным целым числом');
    }

    if (!/^\d{4}-\d{2}-\d{2}$/u.test(safeDayKey)) {
        throw new TypeError('dayKey должен иметь формат YYYY-MM-DD');
    }

    database.exec('BEGIN IMMEDIATE');

    try {
        const result = refundGptDailyRateLimitStatement.run(
            safeUserId,
            safeDayKey,
        );

        database.exec('COMMIT');
        return Number(result.changes ?? 0) > 0;
    } catch (error) {
        database.exec('ROLLBACK');
        throw error;
    }
}

export function consumeGptModelDailyRateLimit({
    userId,
    bucket,
    dayKey,
    limit,
    resetAt,
}) {
    const safeUserId = Number(userId);
    const safeBucket = String(bucket ?? '').trim().toLowerCase();
    const safeDayKey = String(dayKey ?? '').trim();
    const safeLimit = Number(limit);
    const safeResetAt = Number(resetAt);

    if (!Number.isSafeInteger(safeUserId) || safeUserId <= 0) {
        throw new TypeError('userId должен быть положительным целым числом');
    }

    if (!/^[a-z0-9_-]{1,32}$/u.test(safeBucket)) {
        throw new TypeError('bucket содержит недопустимые символы');
    }

    if (!/^\d{4}-\d{2}-\d{2}$/u.test(safeDayKey)) {
        throw new TypeError('dayKey должен иметь формат YYYY-MM-DD');
    }

    if (!Number.isSafeInteger(safeLimit) || safeLimit <= 0) {
        throw new TypeError('limit должен быть положительным целым числом');
    }

    if (!Number.isSafeInteger(safeResetAt) || safeResetAt <= 0) {
        throw new TypeError('resetAt должен быть положительным Unix-временем');
    }

    database.exec('BEGIN IMMEDIATE');

    try {
        const row = gptModelDailyRateLimitStatement.get(
            safeUserId,
            safeBucket,
        );
        let requestCount = row && String(row.day_key) === safeDayKey
            ? Number(row.request_count)
            : 0;

        if (requestCount >= safeLimit) {
            database.exec('COMMIT');

            return {
                allowed: false,
                limit: safeLimit,
                used: requestCount,
                remaining: 0,
                bucket: safeBucket,
                dayKey: safeDayKey,
                resetAt: safeResetAt,
            };
        }

        requestCount += 1;

        upsertGptModelDailyRateLimitStatement.run(
            safeUserId,
            safeBucket,
            safeDayKey,
            requestCount,
        );

        database.exec('COMMIT');

        return {
            allowed: true,
            limit: safeLimit,
            used: requestCount,
            remaining: Math.max(0, safeLimit - requestCount),
            bucket: safeBucket,
            dayKey: safeDayKey,
            resetAt: safeResetAt,
        };
    } catch (error) {
        database.exec('ROLLBACK');
        throw error;
    }
}

export function refundGptModelDailyRateLimit({
    userId,
    bucket,
    dayKey,
}) {
    const safeUserId = Number(userId);
    const safeBucket = String(bucket ?? '').trim().toLowerCase();
    const safeDayKey = String(dayKey ?? '').trim();

    if (!Number.isSafeInteger(safeUserId) || safeUserId <= 0) {
        throw new TypeError('userId должен быть положительным целым числом');
    }

    if (!/^[a-z0-9_-]{1,32}$/u.test(safeBucket)) {
        throw new TypeError('bucket содержит недопустимые символы');
    }

    if (!/^\d{4}-\d{2}-\d{2}$/u.test(safeDayKey)) {
        throw new TypeError('dayKey должен иметь формат YYYY-MM-DD');
    }

    database.exec('BEGIN IMMEDIATE');

    try {
        const result = refundGptModelDailyRateLimitStatement.run(
            safeUserId,
            safeBucket,
            safeDayKey,
        );

        database.exec('COMMIT');
        return Number(result.changes ?? 0) > 0;
    } catch (error) {
        database.exec('ROLLBACK');
        throw error;
    }
}

export function resetAllRateLimits() {
    database.exec('BEGIN IMMEDIATE');

    try {
        const hourlyResult = clearUserRateLimitsStatement.run();
        const legacyGptResult = clearGptDailyRateLimitsStatement.run();
        const modelGptResult = clearGptModelDailyRateLimitsStatement.run();

        database.exec('COMMIT');

        const hourly = Number(hourlyResult.changes ?? 0);
        const gptLegacy = Number(legacyGptResult.changes ?? 0);
        const gptModels = Number(modelGptResult.changes ?? 0);

        return {
            hourly,
            gptLegacy,
            gptModels,
            total: hourly + gptLegacy + gptModels,
        };
    } catch (error) {
        database.exec('ROLLBACK');
        throw error;
    }
}
