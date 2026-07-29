import { mkdirSync } from 'node:fs';
import { randomInt } from 'node:crypto';
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

    /*
     * Отображение внешних идентификаторов других платформ в безопасные
     * внутренние INTEGER-идентификаторы SQLite. VK продолжает использовать
     * свои исходные ID, Telegram получает отдельный диапазон без коллизий.
     */
    CREATE TABLE IF NOT EXISTS platform_identities (
        platform TEXT NOT NULL,
        entity_type TEXT NOT NULL CHECK (entity_type IN ('peer', 'user')),
        external_id TEXT NOT NULL,
        internal_id INTEGER NOT NULL UNIQUE,
        created_at INTEGER NOT NULL,
        PRIMARY KEY (platform, entity_type, external_id)
    );

    CREATE INDEX IF NOT EXISTS platform_identities_lookup_idx
    ON platform_identities (platform, entity_type, external_id);

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

    /*
     * Постоянные настройки манеры общения для конкретного диалога.
     * warmth — не sampling temperature API, а человеческая теплота 1–10.
     * Случайные выкрики разрешены только для групп и только у ролей
     * bydlo/durachila. Время следующего запуска хранится в БД, поэтому
     * перезапуск процесса не сбрасывает расписание.
     */
    CREATE TABLE IF NOT EXISTS communication_settings (
        peer_id INTEGER PRIMARY KEY,
        platform TEXT NOT NULL DEFAULT 'vk',
        external_peer_id TEXT NOT NULL DEFAULT '',
        is_group INTEGER NOT NULL DEFAULT 0 CHECK (is_group IN (0, 1)),
        warmth INTEGER NOT NULL DEFAULT 5 CHECK (warmth BETWEEN 1 AND 10),
        persona TEXT NOT NULL DEFAULT 'neutral',
        next_outburst_at INTEGER NOT NULL DEFAULT 0,
        last_outburst_at INTEGER NOT NULL DEFAULT 0,
        last_target_user_id INTEGER NOT NULL DEFAULT 0,
        updated_by INTEGER NOT NULL DEFAULT 0,
        updated_at INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS communication_settings_due_idx
    ON communication_settings (is_group, persona, next_outburst_at);

    CREATE TABLE IF NOT EXISTS communication_participants (
        peer_id INTEGER NOT NULL,
        user_id INTEGER NOT NULL,
        platform TEXT NOT NULL DEFAULT 'vk',
        external_user_id TEXT NOT NULL DEFAULT '',
        display_name TEXT NOT NULL DEFAULT '',
        last_seen_at INTEGER NOT NULL,
        PRIMARY KEY (peer_id, user_id)
    );

    CREATE INDEX IF NOT EXISTS communication_participants_recent_idx
    ON communication_participants (peer_id, last_seen_at DESC);

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

    /*
     * Явная долговременная память. В эту таблицу попадают только сообщения,
     * для которых пользователь прямо написал команду «запомни» или её синоним.
     * raw_message хранит исходное сообщение целиком, memory_text — полезную часть
     * для поиска и передачи GPT. Память изолирована по peer_id.
     */
    CREATE TABLE IF NOT EXISTS explicit_memories (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        peer_id INTEGER NOT NULL,
        author_id INTEGER NOT NULL,
        conversation_message_id INTEGER NOT NULL,
        raw_message TEXT NOT NULL,
        memory_text TEXT NOT NULL,
        normalized_text TEXT NOT NULL,
        source_message_text TEXT NOT NULL DEFAULT '',
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
        UNIQUE (peer_id, conversation_message_id)
    );

    CREATE INDEX IF NOT EXISTS explicit_memories_peer_lookup_idx
    ON explicit_memories (peer_id, active, updated_at DESC, id DESC);

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

    /*
     * В этой таблице нет текста личных сообщений. Она хранит только момент,
     * когда конкретному VK-пользователю снова нужно показать уведомление о том,
     * что в ЛС отвечает искусственный интеллект.
     */
    CREATE TABLE IF NOT EXISTS dm_ai_notice_state (
        user_id INTEGER PRIMARY KEY,
        next_notice_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
    );

    /*
     * Публичные быстрые ответы для личных сообщений.
     * Здесь нет пользовательской переписки: только подготовленные триггеры
     * и тексты ответов сообщества.
     */
    CREATE TABLE IF NOT EXISTS dm_faq_answers (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        topic TEXT NOT NULL,
        trigger TEXT NOT NULL UNIQUE,
        answer TEXT NOT NULL,
        priority INTEGER NOT NULL DEFAULT 100,
        enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
        updated_at INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS dm_faq_answers_enabled_priority_idx
    ON dm_faq_answers (enabled, priority DESC, id ASC);

    /*
     * Канонические ответы на три темы о ближайшей тусе. Пользовательские
     * сообщения сюда не записываются. GigaChat определяет только intent,
     * а сам ответ бот читает из этой таблицы и отправляет дословно.
     */
    CREATE TABLE IF NOT EXISTS dm_party_faq (
        intent TEXT PRIMARY KEY
            CHECK (intent IN ('party_date', 'party_format', 'party_info')),
        answer TEXT NOT NULL,
        enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
        updated_at INTEGER NOT NULL
    );
`);


/*
 * Публичные публикации Telegram-канала и извлечённые из них мероприятия.
 * Это не личная переписка пользователей VK. Таблицы добавляются через
 * CREATE TABLE IF NOT EXISTS, поэтому существующая база не пересоздаётся.
 */
database.exec(`
    CREATE TABLE IF NOT EXISTS telegram_source_posts (
        channel TEXT NOT NULL,
        message_id INTEGER NOT NULL,
        source_url TEXT NOT NULL,
        published_at INTEGER NOT NULL DEFAULT 0,
        raw_text TEXT NOT NULL DEFAULT '',
        image_urls_json TEXT NOT NULL DEFAULT '[]',
        image_paths_json TEXT NOT NULL DEFAULT '[]',
        content_hash TEXT NOT NULL,
        parse_status TEXT NOT NULL DEFAULT 'pending',
        fetched_at INTEGER NOT NULL,
        PRIMARY KEY (channel, message_id)
    );

    CREATE INDEX IF NOT EXISTS telegram_source_posts_published_idx
    ON telegram_source_posts (channel, published_at DESC, message_id DESC);

    CREATE TABLE IF NOT EXISTS telegram_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        channel TEXT NOT NULL,
        message_id INTEGER NOT NULL,
        event_index INTEGER NOT NULL DEFAULT 0,
        title TEXT NOT NULL DEFAULT '',
        event_date TEXT NOT NULL,
        event_time TEXT,
        venue TEXT NOT NULL DEFAULT '',
        participants TEXT NOT NULL DEFAULT '',
        price TEXT NOT NULL DEFAULT '',
        description TEXT NOT NULL DEFAULT '',
        evidence TEXT NOT NULL DEFAULT '',
        source_url TEXT NOT NULL,
        image_paths_json TEXT NOT NULL DEFAULT '[]',
        parse_method TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending'
            CHECK (status IN ('approved', 'pending', 'ignored')),
        updated_at INTEGER NOT NULL,
        UNIQUE (channel, message_id, event_index),
        FOREIGN KEY (channel, message_id)
            REFERENCES telegram_source_posts(channel, message_id)
            ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS telegram_events_date_idx
    ON telegram_events (event_date, event_time, status);

    CREATE TABLE IF NOT EXISTS telegram_scraper_state (
        channel TEXT PRIMARY KEY,
        last_message_id INTEGER NOT NULL DEFAULT 0,
        last_success_at INTEGER NOT NULL DEFAULT 0,
        last_attempt_at INTEGER NOT NULL DEFAULT 0,
        last_error TEXT NOT NULL DEFAULT '',
        initial_completed INTEGER NOT NULL DEFAULT 0
            CHECK (initial_completed IN (0, 1)),
        posts_seen INTEGER NOT NULL DEFAULT 0,
        events_found INTEGER NOT NULL DEFAULT 0
    );
`);

const selectPlatformIdentityStatement = database.prepare(`
    SELECT internal_id
    FROM platform_identities
    WHERE platform = ?
      AND entity_type = ?
      AND external_id = ?
`);

const nextPlatformUserIdentityStatement = database.prepare(`
    SELECT COALESCE(MAX(internal_id), 2999999999) + 1 AS next_id
    FROM platform_identities
    WHERE entity_type = 'user'
`);

const nextPlatformPeerIdentityStatement = database.prepare(`
    SELECT COALESCE(MIN(internal_id), -2999999999) - 1 AS next_id
    FROM platform_identities
    WHERE entity_type = 'peer'
`);

const insertPlatformIdentityStatement = database.prepare(`
    INSERT INTO platform_identities (
        platform,
        entity_type,
        external_id,
        internal_id,
        created_at
    ) VALUES (?, ?, ?, ?, ?)
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

const allMessagesStatement = database.prepare(`
    SELECT
        peer_id,
        sender_id,
        conversation_message_id,
        text,
        created_at
    FROM messages
    WHERE peer_id = ?
    ORDER BY created_at ASC, id ASC
`);

const allStoredMessagesStatement = database.prepare(`
    SELECT
        peer_id,
        sender_id,
        conversation_message_id,
        text,
        created_at
    FROM messages
    ORDER BY peer_id ASC, created_at ASC, id ASC
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

const selectCommunicationSettingsStatement = database.prepare(`
    SELECT
        peer_id,
        platform,
        external_peer_id,
        is_group,
        warmth,
        persona,
        next_outburst_at,
        last_outburst_at,
        last_target_user_id,
        updated_by,
        updated_at
    FROM communication_settings
    WHERE peer_id = ?
    LIMIT 1
`);

const upsertCommunicationSettingsStatement = database.prepare(`
    INSERT INTO communication_settings (
        peer_id,
        platform,
        external_peer_id,
        is_group,
        warmth,
        persona,
        next_outburst_at,
        last_outburst_at,
        last_target_user_id,
        updated_by,
        updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT (peer_id) DO UPDATE SET
        platform = excluded.platform,
        external_peer_id = excluded.external_peer_id,
        is_group = excluded.is_group,
        warmth = excluded.warmth,
        persona = excluded.persona,
        next_outburst_at = excluded.next_outburst_at,
        last_outburst_at = excluded.last_outburst_at,
        last_target_user_id = excluded.last_target_user_id,
        updated_by = excluded.updated_by,
        updated_at = excluded.updated_at
`);

const selectDueCommunicationSettingsStatement = database.prepare(`
    SELECT
        peer_id,
        platform,
        external_peer_id,
        is_group,
        warmth,
        persona,
        next_outburst_at,
        last_outburst_at,
        last_target_user_id,
        updated_by,
        updated_at
    FROM communication_settings
    WHERE is_group = 1
      AND persona IN ('bydlo', 'durachila')
      AND next_outburst_at > 0
      AND next_outburst_at <= ?
    ORDER BY next_outburst_at ASC
    LIMIT ?
`);

const updateCommunicationOutburstScheduleStatement = database.prepare(`
    UPDATE communication_settings
    SET next_outburst_at = ?,
        last_outburst_at = ?,
        last_target_user_id = ?,
        updated_at = ?
    WHERE peer_id = ?
`);

const upsertCommunicationParticipantStatement = database.prepare(`
    INSERT INTO communication_participants (
        peer_id,
        user_id,
        platform,
        external_user_id,
        display_name,
        last_seen_at
    ) VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT (peer_id, user_id) DO UPDATE SET
        platform = excluded.platform,
        external_user_id = CASE
            WHEN excluded.external_user_id <> '' THEN excluded.external_user_id
            ELSE communication_participants.external_user_id
        END,
        display_name = CASE
            WHEN excluded.display_name <> '' THEN excluded.display_name
            ELSE communication_participants.display_name
        END,
        last_seen_at = excluded.last_seen_at
`);

const selectRecentCommunicationParticipantsStatement = database.prepare(`
    SELECT
        peer_id,
        user_id,
        platform,
        external_user_id,
        display_name,
        last_seen_at
    FROM communication_participants
    WHERE peer_id = ?
      AND last_seen_at >= ?
    ORDER BY last_seen_at DESC
    LIMIT ?
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

const upsertExplicitMemoryStatement = database.prepare(`
    INSERT INTO explicit_memories (
        peer_id,
        author_id,
        conversation_message_id,
        raw_message,
        memory_text,
        normalized_text,
        source_message_text,
        created_at,
        updated_at,
        active
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1)
    ON CONFLICT (peer_id, conversation_message_id) DO UPDATE SET
        author_id = excluded.author_id,
        raw_message = excluded.raw_message,
        memory_text = excluded.memory_text,
        normalized_text = excluded.normalized_text,
        source_message_text = excluded.source_message_text,
        updated_at = excluded.updated_at,
        active = 1
    RETURNING id, created_at, updated_at
`);

const selectExplicitMemoriesStatement = database.prepare(`
    SELECT
        id,
        peer_id,
        author_id,
        conversation_message_id,
        raw_message,
        memory_text,
        normalized_text,
        source_message_text,
        created_at,
        updated_at
    FROM explicit_memories
    WHERE peer_id = ?
      AND active = 1
    ORDER BY updated_at DESC, id DESC
    LIMIT ?
`);

const selectExplicitMemorySourceKeysStatement = database.prepare(`
    SELECT
        peer_id,
        conversation_message_id,
        active
    FROM explicit_memories
    ORDER BY peer_id ASC, conversation_message_id ASC
`);

const deactivateExplicitMemoryStatement = database.prepare(`
    UPDATE explicit_memories
    SET active = 0,
        updated_at = ?
    WHERE peer_id = ?
      AND id = ?
      AND active = 1
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

const dmAiNoticeStateStatement = database.prepare(`
    SELECT next_notice_at
    FROM dm_ai_notice_state
    WHERE user_id = ?
`);

const upsertDmAiNoticeStateStatement = database.prepare(`
    INSERT INTO dm_ai_notice_state (
        user_id,
        next_notice_at,
        updated_at
    ) VALUES (?, ?, ?)
    ON CONFLICT (user_id) DO UPDATE SET
        next_notice_at = excluded.next_notice_at,
        updated_at = excluded.updated_at
`);

const insertDmFaqAnswerStatement = database.prepare(`
    INSERT OR IGNORE INTO dm_faq_answers (
        topic,
        trigger,
        answer,
        priority,
        enabled,
        updated_at
    ) VALUES (?, ?, ?, ?, 1, ?)
`);

const selectDmFaqAnswersStatement = database.prepare(`
    SELECT topic, trigger, answer, priority
    FROM dm_faq_answers
    WHERE enabled = 1
    ORDER BY priority DESC, id ASC
`);

const insertDmPartyFaqStatement = database.prepare(`
    INSERT OR IGNORE INTO dm_party_faq (
        intent,
        answer,
        enabled,
        updated_at
    ) VALUES (?, ?, 1, ?)
`);

const selectDmPartyFaqAnswerStatement = database.prepare(`
    SELECT answer
    FROM dm_party_faq
    WHERE intent = ?
      AND enabled = 1
    LIMIT 1
`);


const selectTelegramPostMetaStatement = database.prepare(`
    SELECT
        content_hash,
        image_paths_json,
        (
            SELECT COUNT(*)
            FROM telegram_events
            WHERE telegram_events.channel = telegram_source_posts.channel
              AND telegram_events.message_id = telegram_source_posts.message_id
        ) AS event_count
    FROM telegram_source_posts
    WHERE channel = ?
      AND message_id = ?
    LIMIT 1
`);

const upsertTelegramSourcePostStatement = database.prepare(`
    INSERT INTO telegram_source_posts (
        channel,
        message_id,
        source_url,
        published_at,
        raw_text,
        image_urls_json,
        image_paths_json,
        content_hash,
        parse_status,
        fetched_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT (channel, message_id) DO UPDATE SET
        source_url = excluded.source_url,
        published_at = excluded.published_at,
        raw_text = excluded.raw_text,
        image_urls_json = excluded.image_urls_json,
        image_paths_json = excluded.image_paths_json,
        content_hash = excluded.content_hash,
        parse_status = excluded.parse_status,
        fetched_at = excluded.fetched_at
`);

const deleteTelegramEventsForPostStatement = database.prepare(`
    DELETE FROM telegram_events
    WHERE channel = ?
      AND message_id = ?
`);

const insertTelegramEventStatement = database.prepare(`
    INSERT INTO telegram_events (
        channel,
        message_id,
        event_index,
        title,
        event_date,
        event_time,
        venue,
        participants,
        price,
        description,
        evidence,
        source_url,
        image_paths_json,
        parse_method,
        status,
        updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`);

const selectTelegramScraperStateStatement = database.prepare(`
    SELECT
        channel,
        last_message_id,
        last_success_at,
        last_attempt_at,
        last_error,
        initial_completed,
        posts_seen,
        events_found,
        (
            SELECT COUNT(*)
            FROM telegram_source_posts
            WHERE telegram_source_posts.channel = telegram_scraper_state.channel
        ) AS stored_posts,
        (
            SELECT COUNT(*)
            FROM telegram_events
            WHERE telegram_events.channel = telegram_scraper_state.channel
        ) AS stored_events
    FROM telegram_scraper_state
    WHERE channel = ?
    LIMIT 1
`);

const upsertTelegramScraperStateStatement = database.prepare(`
    INSERT INTO telegram_scraper_state (
        channel,
        last_message_id,
        last_success_at,
        last_attempt_at,
        last_error,
        initial_completed,
        posts_seen,
        events_found
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT (channel) DO UPDATE SET
        last_message_id = excluded.last_message_id,
        last_success_at = excluded.last_success_at,
        last_attempt_at = excluded.last_attempt_at,
        last_error = excluded.last_error,
        initial_completed = excluded.initial_completed,
        posts_seen = excluded.posts_seen,
        events_found = excluded.events_found
`);

const selectTelegramUpcomingEventsStatement = database.prepare(`
    SELECT
        id,
        channel,
        message_id,
        title,
        event_date,
        event_time,
        venue,
        participants,
        price,
        description,
        source_url,
        image_paths_json,
        parse_method,
        status
    FROM telegram_events
    WHERE channel = ?
      AND status IN ('approved', 'pending')
      AND event_date >= ?
    ORDER BY event_date ASC,
             COALESCE(event_time, '23:59') ASC,
             id ASC
    LIMIT ?
`);

const PARTY_DATE_ANSWER =
    'Ориентировочная дата ближайшей тусы — 22 августа. ' +
    'Дата пока предварительная.';

const PARTY_FORMAT_ANSWER =
    'Формат ближайшей тусы — гиг. ' +
    'Музыкальные направления и состав участников формируются. ' +
    'Любая помощь будет полезна — пишите [id755496806|Севе] в ЛС.';

const PARTY_INFO_ANSWER =
    'Точная информация уточняется. ' +
    'Как только всё подтвердится, она сразу появится в посте сообщества «Гигорейв» ' +
    'и в профиле [id755496806|Севы].';

const DM_FAQ_SEED = [
    ['party_date', 'когда туса', PARTY_DATE_ANSWER, 300],
    ['party_date', 'когда тусовка', PARTY_DATE_ANSWER, 300],
    ['party_date', 'когда будет туса', PARTY_DATE_ANSWER, 300],
    ['party_date', 'когда будет тусовка', PARTY_DATE_ANSWER, 300],
    ['party_date', 'когда следующая туса', PARTY_DATE_ANSWER, 300],
    ['party_date', 'дата тусы', PARTY_DATE_ANSWER, 300],
    ['party_date', 'какого числа туса', PARTY_DATE_ANSWER, 300],
    ['party_date', 'когда ближайшая туса', PARTY_DATE_ANSWER, 300],

    ['party_format', 'что за туса будет следующая', PARTY_FORMAT_ANSWER, 250],
    ['party_format', 'какая будет следующая туса', PARTY_FORMAT_ANSWER, 250],
    ['party_format', 'что за следующая туса', PARTY_FORMAT_ANSWER, 250],
    ['party_format', 'что будет на тусе', PARTY_FORMAT_ANSWER, 250],
    ['party_format', 'какой формат тусы', PARTY_FORMAT_ANSWER, 250],
    ['party_format', 'какая музыка будет на тусе', PARTY_FORMAT_ANSWER, 250],
    ['party_format', 'кто будет выступать', PARTY_FORMAT_ANSWER, 250],
    ['party_format', 'кто будет играть на тусе', PARTY_FORMAT_ANSWER, 250],

    ['party_info', 'когда будет точная инфа', PARTY_INFO_ANSWER, 200],
    ['party_info', 'когда будет точная информация', PARTY_INFO_ANSWER, 200],
    ['party_info', 'когда точная инфа', PARTY_INFO_ANSWER, 200],
    ['party_info', 'когда будут подробности', PARTY_INFO_ANSWER, 200],
    ['party_info', 'когда будет анонс', PARTY_INFO_ANSWER, 200],
    ['party_info', 'где будет точная информация', PARTY_INFO_ANSWER, 200],
    ['party_info', 'где будут подробности', PARTY_INFO_ANSWER, 200],
];

const dmFaqSeedTimestamp = Math.floor(Date.now() / 1000);

for (const [topic, trigger, answer, priority] of DM_FAQ_SEED) {
    insertDmFaqAnswerStatement.run(
        topic,
        trigger,
        answer,
        priority,
        dmFaqSeedTimestamp,
    );
}

for (const [intent, answer] of [
    ['party_date', PARTY_DATE_ANSWER],
    ['party_format', PARTY_FORMAT_ANSWER],
    ['party_info', PARTY_INFO_ANSWER],
]) {
    insertDmPartyFaqStatement.run(
        intent,
        answer,
        dmFaqSeedTimestamp,
    );
}

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

function normalizeDmFaqText(value) {
    return String(value ?? '')
        .toLowerCase()
        .replace(/ё/g, 'е')
        .replace(/[\p{P}\p{S}]+/gu, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}

/**
 * Возвращает подготовленный ответ для ЛС либо null.
 * Совпадение допускает ввод вроде «привет, а когда туса?».
 */
export function getDmFaqAnswer(text) {
    const normalizedText = normalizeDmFaqText(text);

    if (!normalizedText) {
        return null;
    }

    const rows = selectDmFaqAnswersStatement.all();
    let bestMatch = null;

    for (const row of rows) {
        const normalizedTrigger = normalizeDmFaqText(row.trigger);

        if (!normalizedTrigger) {
            continue;
        }

        const exact = normalizedText === normalizedTrigger;
        const contained = normalizedText.includes(normalizedTrigger);

        if (!exact && !contained) {
            continue;
        }

        const score =
            (exact ? 100000 : 0) +
            Number(row.priority ?? 0) * 100 +
            normalizedTrigger.length;

        if (!bestMatch || score > bestMatch.score) {
            bestMatch = {
                score,
                answer: String(row.answer ?? '').trim(),
            };
        }
    }

    return bestMatch?.answer || null;
}

/**
 * Резервный локальный классификатор для точных известных формулировок.
 * Он возвращает только topic; фактический ответ всё равно читается из
 * канонической таблицы dm_party_faq.
 */
export function getDmFaqIntent(text) {
    const normalizedText = normalizeDmFaqText(text);

    if (!normalizedText) {
        return null;
    }

    const rows = selectDmFaqAnswersStatement.all();
    let bestMatch = null;

    for (const row of rows) {
        const normalizedTrigger = normalizeDmFaqText(row.trigger);

        if (!normalizedTrigger) {
            continue;
        }

        const exact = normalizedText === normalizedTrigger;
        const contained = normalizedText.includes(normalizedTrigger);

        if (!exact && !contained) {
            continue;
        }

        const score =
            (exact ? 100000 : 0) +
            Number(row.priority ?? 0) * 100 +
            normalizedTrigger.length;

        if (!bestMatch || score > bestMatch.score) {
            bestMatch = {
                score,
                topic: String(row.topic ?? '').trim(),
            };
        }
    }

    return bestMatch?.topic || null;
}

/**
 * Возвращает канонические ответы из отдельной таблицы в заданном порядке.
 * Входные значения фильтруются по белому списку, поэтому произвольный SQL
 * или произвольные ключи сюда попасть не могут.
 */
export function getDmPartyFaqAnswers(intents) {
    const allowed = new Set([
        'party_date',
        'party_format',
        'party_info',
    ]);
    const unique = [];

    for (const rawIntent of Array.isArray(intents) ? intents : [intents]) {
        const intent = String(rawIntent ?? '').trim();

        if (!allowed.has(intent) || unique.includes(intent)) {
            continue;
        }

        unique.push(intent);
    }

    return unique
        .map((intent) =>
            selectDmPartyFaqAnswerStatement.get(intent),
        )
        .map((row) => String(row?.answer ?? '').trim())
        .filter(Boolean);
}


function safeJsonArray(value) {
    if (!Array.isArray(value)) {
        return [];
    }

    return value
        .map((item) => String(item ?? '').trim())
        .filter(Boolean)
        .slice(0, 100);
}

function currentIsoDate() {
    const now = new Date();
    return [
        String(now.getFullYear()).padStart(4, '0'),
        String(now.getMonth() + 1).padStart(2, '0'),
        String(now.getDate()).padStart(2, '0'),
    ].join('-');
}

export function getTelegramPostMeta({ channel, messageId }) {
    const row = selectTelegramPostMetaStatement.get(
        String(channel ?? '').trim(),
        Number(messageId),
    );

    if (!row) {
        return null;
    }

    return {
        contentHash: String(row.content_hash ?? ''),
        imagePathsJson: String(row.image_paths_json ?? '[]'),
        eventCount: Number(row.event_count ?? 0),
    };
}

export function upsertTelegramSourcePost({
    channel,
    messageId,
    sourceUrl,
    publishedAt,
    rawText,
    imageUrls,
    imagePaths,
    contentHash,
    parseStatus,
    fetchedAt,
}) {
    upsertTelegramSourcePostStatement.run(
        String(channel ?? '').trim(),
        Number(messageId),
        String(sourceUrl ?? '').trim(),
        Number(publishedAt ?? 0),
        String(rawText ?? ''),
        JSON.stringify(safeJsonArray(imageUrls)),
        JSON.stringify(safeJsonArray(imagePaths)),
        String(contentHash ?? '').trim(),
        String(parseStatus ?? 'pending').trim(),
        Number(fetchedAt),
    );
}

export function replaceTelegramEventsForPost({
    channel,
    messageId,
    sourceUrl,
    imagePaths,
    events,
    updatedAt,
}) {
    const safeChannel = String(channel ?? '').trim();
    const safeMessageId = Number(messageId);
    const safeEvents = Array.isArray(events) ? events : [];
    const imagePathsJson = JSON.stringify(safeJsonArray(imagePaths));

    database.exec('BEGIN IMMEDIATE');

    try {
        deleteTelegramEventsForPostStatement.run(
            safeChannel,
            safeMessageId,
        );

        safeEvents.forEach((event, index) => {
            const eventImagePathsJson = JSON.stringify(
                safeJsonArray(event?.imagePaths ?? imagePaths),
            );
            insertTelegramEventStatement.run(
                safeChannel,
                safeMessageId,
                index,
                String(event?.title ?? '').trim(),
                String(event?.eventDate ?? '').trim(),
                event?.eventTime
                    ? String(event.eventTime).trim()
                    : null,
                String(event?.venue ?? '').trim(),
                String(event?.participants ?? '').trim(),
                String(event?.price ?? '').trim(),
                String(event?.description ?? '').trim(),
                String(event?.evidence ?? '').trim(),
                String(sourceUrl ?? '').trim(),
                eventImagePathsJson || imagePathsJson,
                String(event?.parseMethod ?? 'unknown').trim(),
                String(event?.status ?? 'pending').trim(),
                Number(updatedAt),
            );
        });

        database.exec('COMMIT');
    } catch (error) {
        database.exec('ROLLBACK');
        throw error;
    }
}

export function getTelegramScraperState(channel) {
    const row = selectTelegramScraperStateStatement.get(
        String(channel ?? '').trim(),
    );

    if (!row) {
        return null;
    }

    return {
        channel: String(row.channel ?? ''),
        lastMessageId: Number(row.last_message_id ?? 0),
        lastSuccessAt: Number(row.last_success_at ?? 0),
        lastAttemptAt: Number(row.last_attempt_at ?? 0),
        lastError: String(row.last_error ?? ''),
        initialCompleted: Boolean(row.initial_completed),
        postsSeen: Number(row.posts_seen ?? 0),
        eventsFound: Number(row.events_found ?? 0),
        storedPosts: Number(row.stored_posts ?? 0),
        storedEvents: Number(row.stored_events ?? 0),
    };
}

export function updateTelegramScraperState({
    channel,
    lastMessageId,
    lastSuccessAt,
    lastAttemptAt,
    lastError,
    initialCompleted,
    postsSeen,
    eventsFound,
}) {
    upsertTelegramScraperStateStatement.run(
        String(channel ?? '').trim(),
        Number(lastMessageId ?? 0),
        Number(lastSuccessAt ?? 0),
        Number(lastAttemptAt ?? 0),
        String(lastError ?? '').slice(0, 2000),
        initialCompleted ? 1 : 0,
        Number(postsSeen ?? 0),
        Number(eventsFound ?? 0),
    );
}

export function getTelegramUpcomingEvents({
    channel,
    fromDate = currentIsoDate(),
    limit = 10,
}) {
    const safeLimit = Math.min(100, Math.max(1, Number(limit) || 10));

    return selectTelegramUpcomingEventsStatement
        .all(
            String(channel ?? '').trim(),
            String(fromDate ?? currentIsoDate()),
            safeLimit,
        )
        .map((row) => ({
            id: Number(row.id),
            channel: String(row.channel ?? ''),
            messageId: Number(row.message_id),
            title: String(row.title ?? ''),
            eventDate: String(row.event_date ?? ''),
            eventTime: row.event_time
                ? String(row.event_time)
                : null,
            venue: String(row.venue ?? ''),
            participants: String(row.participants ?? ''),
            price: String(row.price ?? ''),
            description: String(row.description ?? ''),
            sourceUrl: String(row.source_url ?? ''),
            imagePaths: (() => {
                try {
                    return safeJsonArray(JSON.parse(row.image_paths_json ?? '[]'));
                } catch {
                    return [];
                }
            })(),
            parseMethod: String(row.parse_method ?? ''),
            status: String(row.status ?? ''),
        }));
}

export function getOrCreatePlatformIdentity({
    platform,
    entityType,
    externalId,
}) {
    const cleanPlatform = String(platform ?? '').trim().toLowerCase();
    const cleanEntityType = String(entityType ?? '').trim().toLowerCase();
    const cleanExternalId = String(externalId ?? '').trim();

    if (!cleanPlatform || !['peer', 'user'].includes(cleanEntityType) || !cleanExternalId) {
        throw new Error('Некорректные параметры platform identity.');
    }

    const existing = selectPlatformIdentityStatement.get(
        cleanPlatform,
        cleanEntityType,
        cleanExternalId,
    );

    if (existing) {
        return Number(existing.internal_id);
    }

    database.exec('BEGIN IMMEDIATE');

    try {
        const rechecked = selectPlatformIdentityStatement.get(
            cleanPlatform,
            cleanEntityType,
            cleanExternalId,
        );

        if (rechecked) {
            database.exec('COMMIT');
            return Number(rechecked.internal_id);
        }

        const row = cleanEntityType === 'user'
            ? nextPlatformUserIdentityStatement.get()
            : nextPlatformPeerIdentityStatement.get();
        const internalId = Number(row?.next_id);

        if (!Number.isSafeInteger(internalId)) {
            throw new Error('Закончился безопасный диапазон внутренних ID платформ.');
        }

        insertPlatformIdentityStatement.run(
            cleanPlatform,
            cleanEntityType,
            cleanExternalId,
            internalId,
            Math.floor(Date.now() / 1000),
        );
        database.exec('COMMIT');
        return internalId;
    } catch (error) {
        database.exec('ROLLBACK');
        throw error;
    }
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


export function getAllMessages(peerId) {
    return allMessagesStatement
        .all(Number(peerId))
        .map(mapMessage);
}


export function getAllStoredMessages() {
    return allStoredMessagesStatement
        .all()
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

function mapCommunicationSettingsRow(row, peerId = 0) {
    if (!row) {
        return {
            peerId: Number(peerId),
            platform: 'vk',
            externalPeerId: String(peerId ?? ''),
            isGroup: false,
            warmth: 5,
            persona: 'neutral',
            nextOutburstAt: 0,
            lastOutburstAt: 0,
            lastTargetUserId: 0,
            updatedBy: 0,
            updatedAt: 0,
        };
    }

    return {
        peerId: Number(row.peer_id),
        platform: String(row.platform ?? 'vk'),
        externalPeerId: String(row.external_peer_id ?? ''),
        isGroup: Boolean(row.is_group),
        warmth: Number(row.warmth ?? 5),
        persona: String(row.persona ?? 'neutral'),
        nextOutburstAt: Number(row.next_outburst_at ?? 0),
        lastOutburstAt: Number(row.last_outburst_at ?? 0),
        lastTargetUserId: Number(row.last_target_user_id ?? 0),
        updatedBy: Number(row.updated_by ?? 0),
        updatedAt: Number(row.updated_at ?? 0),
    };
}

export function getCommunicationSettings(peerId) {
    return mapCommunicationSettingsRow(
        selectCommunicationSettingsStatement.get(Number(peerId)),
        peerId,
    );
}

export function saveCommunicationSettings({
    peerId,
    platform = 'vk',
    externalPeerId = '',
    isGroup = false,
    warmth = 5,
    persona = 'neutral',
    nextOutburstAt = 0,
    lastOutburstAt = 0,
    lastTargetUserId = 0,
    updatedBy = 0,
    updatedAt = Math.floor(Date.now() / 1000),
}) {
    const safeWarmth = Math.min(10, Math.max(1, Math.round(Number(warmth) || 5)));

    upsertCommunicationSettingsStatement.run(
        Number(peerId),
        String(platform ?? 'vk').trim() || 'vk',
        String(externalPeerId ?? '').trim(),
        isGroup ? 1 : 0,
        safeWarmth,
        String(persona ?? 'neutral').trim() || 'neutral',
        Math.max(0, Number(nextOutburstAt) || 0),
        Math.max(0, Number(lastOutburstAt) || 0),
        Math.max(0, Number(lastTargetUserId) || 0),
        Number(updatedBy) || 0,
        Number(updatedAt) || Math.floor(Date.now() / 1000),
    );

    return getCommunicationSettings(peerId);
}

export function getDueCommunicationSettings(
    now = Math.floor(Date.now() / 1000),
    limit = 50,
) {
    return selectDueCommunicationSettingsStatement
        .all(
            Number(now),
            Math.min(200, Math.max(1, Number(limit) || 50)),
        )
        .map((row) => mapCommunicationSettingsRow(row));
}

export function updateCommunicationOutburstSchedule({
    peerId,
    nextOutburstAt,
    lastOutburstAt = 0,
    lastTargetUserId = 0,
    updatedAt = Math.floor(Date.now() / 1000),
}) {
    updateCommunicationOutburstScheduleStatement.run(
        Math.max(0, Number(nextOutburstAt) || 0),
        Math.max(0, Number(lastOutburstAt) || 0),
        Math.max(0, Number(lastTargetUserId) || 0),
        Number(updatedAt) || Math.floor(Date.now() / 1000),
        Number(peerId),
    );

    return getCommunicationSettings(peerId);
}

export function touchCommunicationParticipant({
    peerId,
    userId,
    platform = 'vk',
    externalUserId = '',
    displayName = '',
    lastSeenAt = Math.floor(Date.now() / 1000),
}) {
    const numericPeerId = Number(peerId);
    const numericUserId = Number(userId);

    if (!Number.isFinite(numericPeerId) || !Number.isFinite(numericUserId)) {
        return;
    }

    upsertCommunicationParticipantStatement.run(
        numericPeerId,
        numericUserId,
        String(platform ?? 'vk').trim() || 'vk',
        String(externalUserId ?? '').trim(),
        String(displayName ?? '').replace(/\s+/gu, ' ').trim().slice(0, 120),
        Number(lastSeenAt) || Math.floor(Date.now() / 1000),
    );
}

export function getRecentCommunicationParticipants({
    peerId,
    sinceTimestamp,
    limit = 100,
}) {
    return selectRecentCommunicationParticipantsStatement
        .all(
            Number(peerId),
            Number(sinceTimestamp) || 0,
            Math.min(500, Math.max(1, Number(limit) || 100)),
        )
        .map((row) => ({
            peerId: Number(row.peer_id),
            userId: Number(row.user_id),
            platform: String(row.platform ?? 'vk'),
            externalUserId: String(row.external_user_id ?? ''),
            displayName: String(row.display_name ?? ''),
            lastSeenAt: Number(row.last_seen_at ?? 0),
        }));
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

export function saveExplicitMemory({
    peerId,
    authorId,
    conversationMessageId,
    rawMessage,
    memoryText,
    normalizedText,
    sourceMessageText = '',
    createdAt = Math.floor(Date.now() / 1000),
}) {
    const safeCreatedAt = Number(createdAt) || Math.floor(Date.now() / 1000);
    const safeConversationMessageId = Number.isSafeInteger(
        Number(conversationMessageId),
    )
        ? Number(conversationMessageId)
        : safeCreatedAt * 100000 + Math.floor(Math.random() * 100000);
    const cleanMemoryText = String(memoryText ?? '').trim();

    if (!cleanMemoryText) {
        throw new TypeError('Нельзя сохранить пустую явную память.');
    }

    const row = upsertExplicitMemoryStatement.get(
        Number(peerId),
        Number(authorId),
        safeConversationMessageId,
        String(rawMessage ?? '').trim(),
        cleanMemoryText,
        String(normalizedText ?? '').trim(),
        String(sourceMessageText ?? '').trim(),
        safeCreatedAt,
        Math.floor(Date.now() / 1000),
    );

    return {
        id: Number(row?.id ?? 0),
        createdAt: Number(row?.created_at ?? safeCreatedAt),
        updatedAt: Number(row?.updated_at ?? safeCreatedAt),
    };
}

export function getExplicitMemories(peerId, limit = 1000) {
    const safeLimit = Math.min(5000, Math.max(1, Number(limit) || 1000));

    return selectExplicitMemoriesStatement
        .all(Number(peerId), safeLimit)
        .map((row) => ({
            id: Number(row.id),
            peerId: Number(row.peer_id),
            authorId: Number(row.author_id),
            conversationMessageId: Number(row.conversation_message_id),
            rawMessage: String(row.raw_message ?? ''),
            memoryText: String(row.memory_text ?? ''),
            normalizedText: String(row.normalized_text ?? ''),
            sourceMessageText: String(row.source_message_text ?? ''),
            createdAt: Number(row.created_at),
            updatedAt: Number(row.updated_at),
        }));
}


export function getExplicitMemorySourceKeys() {
    return selectExplicitMemorySourceKeysStatement
        .all()
        .map((row) => ({
            peerId: Number(row.peer_id),
            conversationMessageId: Number(row.conversation_message_id),
            active: Number(row.active) === 1,
        }));
}


export function deactivateExplicitMemories(peerId, memoryIds) {
    const safePeerId = Number(peerId);
    const ids = [...new Set(
        (Array.isArray(memoryIds) ? memoryIds : [])
            .map((value) => Number(value))
            .filter((value) => Number.isSafeInteger(value) && value > 0),
    )];

    if (!Number.isSafeInteger(safePeerId) || safePeerId <= 0 || !ids.length) {
        return 0;
    }

    const updatedAt = Math.floor(Date.now() / 1000);
    let changed = 0;

    database.exec('BEGIN IMMEDIATE');

    try {
        for (const id of ids) {
            const result = deactivateExplicitMemoryStatement.run(
                updatedAt,
                safePeerId,
                id,
            );
            changed += Number(result?.changes ?? 0);
        }

        database.exec('COMMIT');
    } catch (error) {
        database.exec('ROLLBACK');
        throw error;
    }

    return changed;
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

/**
 * Атомарно проверяет, пора ли снова показывать уведомление в ЛС.
 *
 * В базе сохраняются только VK user_id и два Unix-времени в секундах.
 * Содержимое личной переписки сюда никогда не попадает.
 */
export function consumeDmAiNotice({
    userId,
    now = Math.floor(Date.now() / 1000),
    minimumDays = 1,
    maximumDays = 7,
}) {
    const safeUserId = Number(userId);
    const safeNow = Number(now);
    const safeMinimumDays = Number(minimumDays);
    const safeMaximumDays = Number(maximumDays);

    if (!Number.isSafeInteger(safeUserId) || safeUserId <= 0) {
        throw new TypeError('userId должен быть положительным целым числом');
    }

    if (!Number.isSafeInteger(safeNow) || safeNow <= 0) {
        throw new TypeError('now должен быть положительным Unix-временем');
    }

    if (
        !Number.isSafeInteger(safeMinimumDays) ||
        !Number.isSafeInteger(safeMaximumDays) ||
        safeMinimumDays < 1 ||
        safeMaximumDays < safeMinimumDays ||
        safeMaximumDays > 365
    ) {
        throw new TypeError('Диапазон дней указан неверно');
    }

    database.exec('BEGIN IMMEDIATE');

    try {
        const row = dmAiNoticeStateStatement.get(safeUserId);
        const nextNoticeAt = Number(row?.next_notice_at ?? 0);

        if (nextNoticeAt > safeNow) {
            database.exec('COMMIT');

            return {
                shouldSend: false,
                nextNoticeAt,
                intervalDays: null,
            };
        }

        const intervalDays = randomInt(
            safeMinimumDays,
            safeMaximumDays + 1,
        );
        const newNextNoticeAt =
            safeNow + intervalDays * 24 * 60 * 60;

        upsertDmAiNoticeStateStatement.run(
            safeUserId,
            newNextNoticeAt,
            safeNow,
        );

        database.exec('COMMIT');

        return {
            shouldSend: true,
            nextNoticeAt: newNextNoticeAt,
            intervalDays,
        };
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

/*
 * Публичные записи VK-паблика и извлечённые из них мероприятия.
 * Существующие таблицы и пользовательские данные не изменяются.
 */
database.exec(`
    CREATE TABLE IF NOT EXISTS vk_source_posts (
        screen_name TEXT NOT NULL,
        owner_id INTEGER NOT NULL DEFAULT 0,
        post_id INTEGER NOT NULL,
        source_url TEXT NOT NULL,
        published_at INTEGER NOT NULL DEFAULT 0,
        raw_text TEXT NOT NULL DEFAULT '',
        image_urls_json TEXT NOT NULL DEFAULT '[]',
        image_paths_json TEXT NOT NULL DEFAULT '[]',
        content_hash TEXT NOT NULL,
        parse_status TEXT NOT NULL DEFAULT 'pending',
        fetched_at INTEGER NOT NULL,
        PRIMARY KEY (screen_name, post_id)
    );

    CREATE INDEX IF NOT EXISTS vk_source_posts_published_idx
    ON vk_source_posts (screen_name, published_at DESC, post_id DESC);

    CREATE TABLE IF NOT EXISTS vk_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        screen_name TEXT NOT NULL,
        post_id INTEGER NOT NULL,
        event_index INTEGER NOT NULL DEFAULT 0,
        title TEXT NOT NULL DEFAULT '',
        event_date TEXT NOT NULL,
        event_time TEXT,
        venue TEXT NOT NULL DEFAULT '',
        participants TEXT NOT NULL DEFAULT '',
        price TEXT NOT NULL DEFAULT '',
        description TEXT NOT NULL DEFAULT '',
        evidence TEXT NOT NULL DEFAULT '',
        source_url TEXT NOT NULL,
        image_paths_json TEXT NOT NULL DEFAULT '[]',
        parse_method TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending'
            CHECK (status IN ('approved', 'pending', 'ignored')),
        updated_at INTEGER NOT NULL,
        UNIQUE (screen_name, post_id, event_index),
        FOREIGN KEY (screen_name, post_id)
            REFERENCES vk_source_posts(screen_name, post_id)
            ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS vk_events_date_idx
    ON vk_events (event_date, event_time, status);

    CREATE TABLE IF NOT EXISTS vk_scraper_state (
        screen_name TEXT PRIMARY KEY,
        owner_id INTEGER NOT NULL DEFAULT 0,
        last_post_id INTEGER NOT NULL DEFAULT 0,
        last_success_at INTEGER NOT NULL DEFAULT 0,
        last_attempt_at INTEGER NOT NULL DEFAULT 0,
        last_error TEXT NOT NULL DEFAULT '',
        initial_completed INTEGER NOT NULL DEFAULT 0
            CHECK (initial_completed IN (0, 1)),
        posts_seen INTEGER NOT NULL DEFAULT 0,
        events_found INTEGER NOT NULL DEFAULT 0
    );
`);


/*
 * Одноразовая миграция v8: старые версии могли сохранить публикации как
 * not_event и больше не перепроверять их. Сбрасываем только состояние
 * парсеров; исходные посты, события, личные данные и история чатов не удаляются.
 */
database.exec(`
    CREATE TABLE IF NOT EXISTS scraper_code_migrations (
        migration_key TEXT PRIMARY KEY,
        applied_at INTEGER NOT NULL
    );
`);

const scraperV8MigrationKey = 'public-html-local-v8-reparse';
const scraperV8Migration = database.prepare(`
    SELECT migration_key
    FROM scraper_code_migrations
    WHERE migration_key = ?
    LIMIT 1
`).get(scraperV8MigrationKey);

if (!scraperV8Migration) {
    database.exec(`
        UPDATE telegram_scraper_state
        SET initial_completed = 0,
            last_error = '';

        UPDATE vk_scraper_state
        SET initial_completed = 0,
            last_error = '';
    `);

    database.prepare(`
        INSERT INTO scraper_code_migrations (migration_key, applied_at)
        VALUES (?, ?)
    `).run(scraperV8MigrationKey, Math.floor(Date.now() / 1000));
}

/*
 * v10 повторно проходит заданное количество публикаций: теперь прошедшие
 * события не сохраняются, а у каждого будущего события должна быть картинка.
 */
const scraperV10MigrationKey = 'public-events-v10-future-images';
const scraperV10Migration = database.prepare(`
    SELECT migration_key
    FROM scraper_code_migrations
    WHERE migration_key = ?
    LIMIT 1
`).get(scraperV10MigrationKey);

if (!scraperV10Migration) {
    database.exec(`
        UPDATE telegram_scraper_state
        SET initial_completed = 0,
            last_error = '';

        UPDATE vk_scraper_state
        SET initial_completed = 0,
            last_error = '';
    `);

    database.prepare(`
        INSERT INTO scraper_code_migrations (migration_key, applied_at)
        VALUES (?, ?)
    `).run(scraperV10MigrationKey, Math.floor(Date.now() / 1000));
}

const selectVkPostMetaStatement = database.prepare(`
    SELECT
        content_hash,
        image_paths_json,
        (
            SELECT COUNT(*)
            FROM vk_events
            WHERE vk_events.screen_name = vk_source_posts.screen_name
              AND vk_events.post_id = vk_source_posts.post_id
        ) AS event_count
    FROM vk_source_posts
    WHERE screen_name = ?
      AND post_id = ?
    LIMIT 1
`);

const upsertVkSourcePostStatement = database.prepare(`
    INSERT INTO vk_source_posts (
        screen_name,
        owner_id,
        post_id,
        source_url,
        published_at,
        raw_text,
        image_urls_json,
        image_paths_json,
        content_hash,
        parse_status,
        fetched_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT (screen_name, post_id) DO UPDATE SET
        owner_id = excluded.owner_id,
        source_url = excluded.source_url,
        published_at = excluded.published_at,
        raw_text = excluded.raw_text,
        image_urls_json = excluded.image_urls_json,
        image_paths_json = excluded.image_paths_json,
        content_hash = excluded.content_hash,
        parse_status = excluded.parse_status,
        fetched_at = excluded.fetched_at
`);

const deleteVkEventsForPostStatement = database.prepare(`
    DELETE FROM vk_events
    WHERE screen_name = ?
      AND post_id = ?
`);

const insertVkEventStatement = database.prepare(`
    INSERT INTO vk_events (
        screen_name,
        post_id,
        event_index,
        title,
        event_date,
        event_time,
        venue,
        participants,
        price,
        description,
        evidence,
        source_url,
        image_paths_json,
        parse_method,
        status,
        updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`);

const selectVkScraperStateStatement = database.prepare(`
    SELECT
        screen_name,
        owner_id,
        last_post_id,
        last_success_at,
        last_attempt_at,
        last_error,
        initial_completed,
        posts_seen,
        events_found,
        (
            SELECT COUNT(*)
            FROM vk_source_posts
            WHERE vk_source_posts.screen_name = vk_scraper_state.screen_name
        ) AS stored_posts,
        (
            SELECT COUNT(*)
            FROM vk_events
            WHERE vk_events.screen_name = vk_scraper_state.screen_name
        ) AS stored_events
    FROM vk_scraper_state
    WHERE screen_name = ?
    LIMIT 1
`);

const upsertVkScraperStateStatement = database.prepare(`
    INSERT INTO vk_scraper_state (
        screen_name,
        owner_id,
        last_post_id,
        last_success_at,
        last_attempt_at,
        last_error,
        initial_completed,
        posts_seen,
        events_found
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT (screen_name) DO UPDATE SET
        owner_id = excluded.owner_id,
        last_post_id = excluded.last_post_id,
        last_success_at = excluded.last_success_at,
        last_attempt_at = excluded.last_attempt_at,
        last_error = excluded.last_error,
        initial_completed = excluded.initial_completed,
        posts_seen = excluded.posts_seen,
        events_found = excluded.events_found
`);

const selectVkUpcomingEventsStatement = database.prepare(`
    SELECT
        id,
        screen_name,
        post_id,
        title,
        event_date,
        event_time,
        venue,
        participants,
        price,
        description,
        source_url,
        image_paths_json,
        parse_method,
        status
    FROM vk_events
    WHERE screen_name = ?
      AND status IN ('approved', 'pending')
      AND event_date >= ?
    ORDER BY event_date ASC,
             COALESCE(event_time, '23:59') ASC,
             id ASC
    LIMIT ?
`);

export function getVkPostMeta({ screenName, postId }) {
    const row = selectVkPostMetaStatement.get(
        String(screenName ?? '').trim(),
        Number(postId),
    );

    if (!row) {
        return null;
    }

    return {
        contentHash: String(row.content_hash ?? ''),
        imagePathsJson: String(row.image_paths_json ?? '[]'),
        eventCount: Number(row.event_count ?? 0),
    };
}

export function upsertVkSourcePost({
    screenName,
    ownerId,
    postId,
    sourceUrl,
    publishedAt,
    rawText,
    imageUrls,
    imagePaths,
    contentHash,
    parseStatus,
    fetchedAt,
}) {
    upsertVkSourcePostStatement.run(
        String(screenName ?? '').trim(),
        Number(ownerId ?? 0),
        Number(postId),
        String(sourceUrl ?? '').trim(),
        Number(publishedAt ?? 0),
        String(rawText ?? ''),
        JSON.stringify(safeJsonArray(imageUrls)),
        JSON.stringify(safeJsonArray(imagePaths)),
        String(contentHash ?? '').trim(),
        String(parseStatus ?? 'pending').trim(),
        Number(fetchedAt),
    );
}

export function replaceVkEventsForPost({
    screenName,
    postId,
    sourceUrl,
    imagePaths,
    events,
    updatedAt,
}) {
    const safeScreenName = String(screenName ?? '').trim();
    const safePostId = Number(postId);
    const safeEvents = Array.isArray(events) ? events : [];
    const imagePathsJson = JSON.stringify(safeJsonArray(imagePaths));

    database.exec('BEGIN IMMEDIATE');

    try {
        deleteVkEventsForPostStatement.run(safeScreenName, safePostId);

        safeEvents.forEach((event, index) => {
            const eventImagePathsJson = JSON.stringify(
                safeJsonArray(event?.imagePaths ?? imagePaths),
            );
            insertVkEventStatement.run(
                safeScreenName,
                safePostId,
                index,
                String(event?.title ?? '').trim(),
                String(event?.eventDate ?? '').trim(),
                event?.eventTime ? String(event.eventTime).trim() : null,
                String(event?.venue ?? '').trim(),
                String(event?.participants ?? '').trim(),
                String(event?.price ?? '').trim(),
                String(event?.description ?? '').trim(),
                String(event?.evidence ?? '').trim(),
                String(sourceUrl ?? '').trim(),
                eventImagePathsJson || imagePathsJson,
                String(event?.parseMethod ?? 'unknown').trim(),
                String(event?.status ?? 'pending').trim(),
                Number(updatedAt),
            );
        });

        database.exec('COMMIT');
    } catch (error) {
        database.exec('ROLLBACK');
        throw error;
    }
}

export function getVkScraperState(screenName) {
    const row = selectVkScraperStateStatement.get(
        String(screenName ?? '').trim(),
    );

    if (!row) {
        return null;
    }

    return {
        screenName: String(row.screen_name ?? ''),
        ownerId: Number(row.owner_id ?? 0),
        lastPostId: Number(row.last_post_id ?? 0),
        lastSuccessAt: Number(row.last_success_at ?? 0),
        lastAttemptAt: Number(row.last_attempt_at ?? 0),
        lastError: String(row.last_error ?? ''),
        initialCompleted: Boolean(row.initial_completed),
        postsSeen: Number(row.posts_seen ?? 0),
        eventsFound: Number(row.events_found ?? 0),
        storedPosts: Number(row.stored_posts ?? 0),
        storedEvents: Number(row.stored_events ?? 0),
    };
}

export function updateVkScraperState({
    screenName,
    ownerId,
    lastPostId,
    lastSuccessAt,
    lastAttemptAt,
    lastError,
    initialCompleted,
    postsSeen,
    eventsFound,
}) {
    upsertVkScraperStateStatement.run(
        String(screenName ?? '').trim(),
        Number(ownerId ?? 0),
        Number(lastPostId ?? 0),
        Number(lastSuccessAt ?? 0),
        Number(lastAttemptAt ?? 0),
        String(lastError ?? '').slice(0, 2000),
        initialCompleted ? 1 : 0,
        Number(postsSeen ?? 0),
        Number(eventsFound ?? 0),
    );
}

export function getVkUpcomingEvents({
    screenName,
    fromDate = currentIsoDate(),
    limit = 10,
}) {
    const safeLimit = Math.min(100, Math.max(1, Number(limit) || 10));

    return selectVkUpcomingEventsStatement
        .all(
            String(screenName ?? '').trim(),
            String(fromDate ?? currentIsoDate()),
            safeLimit,
        )
        .map((row) => ({
            id: Number(row.id),
            sourceType: 'vk',
            sourceName: String(row.screen_name ?? ''),
            postId: Number(row.post_id),
            title: String(row.title ?? ''),
            eventDate: String(row.event_date ?? ''),
            eventTime: row.event_time ? String(row.event_time) : null,
            venue: String(row.venue ?? ''),
            participants: String(row.participants ?? ''),
            price: String(row.price ?? ''),
            description: String(row.description ?? ''),
            sourceUrl: String(row.source_url ?? ''),
            imagePaths: (() => {
                try {
                    return safeJsonArray(JSON.parse(row.image_paths_json ?? '[]'));
                } catch {
                    return [];
                }
            })(),
            parseMethod: String(row.parse_method ?? ''),
            status: String(row.status ?? ''),
        }));
}

/*
 * Сообщения из выбранных VK-бесед, которые прошли предварительный фильтр
 * даты/времени и были проверены GigaChat. Обычная переписка сюда не попадает.
 */
database.exec(`
    CREATE TABLE IF NOT EXISTS vk_chat_source_messages (
        peer_id INTEGER NOT NULL,
        conversation_message_id INTEGER NOT NULL,
        conversation_url TEXT NOT NULL,
        conversation_name TEXT NOT NULL DEFAULT '',
        sender_id INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL DEFAULT 0,
        raw_text TEXT NOT NULL DEFAULT '',
        links_json TEXT NOT NULL DEFAULT '[]',
        image_urls_json TEXT NOT NULL DEFAULT '[]',
        image_paths_json TEXT NOT NULL DEFAULT '[]',
        content_hash TEXT NOT NULL,
        parse_status TEXT NOT NULL DEFAULT 'pending',
        fetched_at INTEGER NOT NULL,
        PRIMARY KEY (peer_id, conversation_message_id)
    );

    CREATE INDEX IF NOT EXISTS vk_chat_source_messages_created_idx
    ON vk_chat_source_messages (peer_id, created_at DESC, conversation_message_id DESC);

    CREATE TABLE IF NOT EXISTS vk_chat_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        peer_id INTEGER NOT NULL,
        conversation_message_id INTEGER NOT NULL,
        event_index INTEGER NOT NULL DEFAULT 0,
        title TEXT NOT NULL DEFAULT '',
        event_date TEXT NOT NULL,
        event_time TEXT,
        venue TEXT NOT NULL DEFAULT '',
        participants TEXT NOT NULL DEFAULT '',
        price TEXT NOT NULL DEFAULT '',
        description TEXT NOT NULL DEFAULT '',
        evidence TEXT NOT NULL DEFAULT '',
        source_url TEXT NOT NULL,
        image_paths_json TEXT NOT NULL DEFAULT '[]',
        parse_method TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending'
            CHECK (status IN ('approved', 'pending', 'ignored')),
        updated_at INTEGER NOT NULL,
        UNIQUE (peer_id, conversation_message_id, event_index),
        FOREIGN KEY (peer_id, conversation_message_id)
            REFERENCES vk_chat_source_messages(peer_id, conversation_message_id)
            ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS vk_chat_events_date_idx
    ON vk_chat_events (event_date, event_time, status);

    CREATE TABLE IF NOT EXISTS vk_chat_scraper_state (
        peer_id INTEGER PRIMARY KEY,
        conversation_url TEXT NOT NULL,
        conversation_name TEXT NOT NULL DEFAULT '',
        last_message_id INTEGER NOT NULL DEFAULT 0,
        last_success_at INTEGER NOT NULL DEFAULT 0,
        last_attempt_at INTEGER NOT NULL DEFAULT 0,
        last_error TEXT NOT NULL DEFAULT '',
        initial_completed INTEGER NOT NULL DEFAULT 0
            CHECK (initial_completed IN (0, 1)),
        messages_seen INTEGER NOT NULL DEFAULT 0,
        candidates_checked INTEGER NOT NULL DEFAULT 0,
        events_found INTEGER NOT NULL DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS maintenance_state (
        task_key TEXT PRIMARY KEY,
        last_run_at INTEGER NOT NULL DEFAULT 0,
        details_json TEXT NOT NULL DEFAULT '{}'
    );
`);

const deleteTelegramSourcePostStatement = database.prepare(`
    DELETE FROM telegram_source_posts
    WHERE channel = ? AND message_id = ?
`);

const deleteVkSourcePostStatement = database.prepare(`
    DELETE FROM vk_source_posts
    WHERE screen_name = ? AND post_id = ?
`);

const selectVkChatMessageMetaStatement = database.prepare(`
    SELECT
        content_hash,
        image_paths_json,
        (
            SELECT COUNT(*)
            FROM vk_chat_events
            WHERE vk_chat_events.peer_id = vk_chat_source_messages.peer_id
              AND vk_chat_events.conversation_message_id = vk_chat_source_messages.conversation_message_id
        ) AS event_count
    FROM vk_chat_source_messages
    WHERE peer_id = ?
      AND conversation_message_id = ?
    LIMIT 1
`);

const upsertVkChatSourceMessageStatement = database.prepare(`
    INSERT INTO vk_chat_source_messages (
        peer_id,
        conversation_message_id,
        conversation_url,
        conversation_name,
        sender_id,
        created_at,
        raw_text,
        links_json,
        image_urls_json,
        image_paths_json,
        content_hash,
        parse_status,
        fetched_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT (peer_id, conversation_message_id) DO UPDATE SET
        conversation_url = excluded.conversation_url,
        conversation_name = excluded.conversation_name,
        sender_id = excluded.sender_id,
        created_at = excluded.created_at,
        raw_text = excluded.raw_text,
        links_json = excluded.links_json,
        image_urls_json = excluded.image_urls_json,
        image_paths_json = excluded.image_paths_json,
        content_hash = excluded.content_hash,
        parse_status = excluded.parse_status,
        fetched_at = excluded.fetched_at
`);

const deleteVkChatEventsForMessageStatement = database.prepare(`
    DELETE FROM vk_chat_events
    WHERE peer_id = ?
      AND conversation_message_id = ?
`);

const deleteVkChatSourceMessageStatement = database.prepare(`
    DELETE FROM vk_chat_source_messages
    WHERE peer_id = ?
      AND conversation_message_id = ?
`);

const insertVkChatEventStatement = database.prepare(`
    INSERT INTO vk_chat_events (
        peer_id,
        conversation_message_id,
        event_index,
        title,
        event_date,
        event_time,
        venue,
        participants,
        price,
        description,
        evidence,
        source_url,
        image_paths_json,
        parse_method,
        status,
        updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`);

const selectVkChatScraperStateStatement = database.prepare(`
    SELECT
        peer_id,
        conversation_url,
        conversation_name,
        last_message_id,
        last_success_at,
        last_attempt_at,
        last_error,
        initial_completed,
        messages_seen,
        candidates_checked,
        events_found,
        (
            SELECT COUNT(*)
            FROM vk_chat_source_messages
            WHERE vk_chat_source_messages.peer_id = vk_chat_scraper_state.peer_id
        ) AS stored_messages,
        (
            SELECT COUNT(*)
            FROM vk_chat_events
            WHERE vk_chat_events.peer_id = vk_chat_scraper_state.peer_id
        ) AS stored_events
    FROM vk_chat_scraper_state
    WHERE peer_id = ?
    LIMIT 1
`);

const upsertVkChatScraperStateStatement = database.prepare(`
    INSERT INTO vk_chat_scraper_state (
        peer_id,
        conversation_url,
        conversation_name,
        last_message_id,
        last_success_at,
        last_attempt_at,
        last_error,
        initial_completed,
        messages_seen,
        candidates_checked,
        events_found
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT (peer_id) DO UPDATE SET
        conversation_url = excluded.conversation_url,
        conversation_name = excluded.conversation_name,
        last_message_id = excluded.last_message_id,
        last_success_at = excluded.last_success_at,
        last_attempt_at = excluded.last_attempt_at,
        last_error = excluded.last_error,
        initial_completed = excluded.initial_completed,
        messages_seen = excluded.messages_seen,
        candidates_checked = excluded.candidates_checked,
        events_found = excluded.events_found
`);

const selectVkChatUpcomingEventsStatement = database.prepare(`
    SELECT
        events.id,
        events.peer_id,
        events.conversation_message_id,
        source.conversation_name,
        events.title,
        events.event_date,
        events.event_time,
        events.venue,
        events.participants,
        events.price,
        events.description,
        events.source_url,
        events.image_paths_json,
        events.parse_method,
        events.status
    FROM vk_chat_events AS events
    JOIN vk_chat_source_messages AS source
      ON source.peer_id = events.peer_id
     AND source.conversation_message_id = events.conversation_message_id
    WHERE events.peer_id = ?
      AND events.status IN ('approved', 'pending')
      AND events.event_date >= ?
    ORDER BY events.event_date ASC,
             COALESCE(events.event_time, '23:59') ASC,
             events.id ASC
    LIMIT ?
`);

const selectMaintenanceStateStatement = database.prepare(`
    SELECT last_run_at, details_json
    FROM maintenance_state
    WHERE task_key = ?
    LIMIT 1
`);

const upsertMaintenanceStateStatement = database.prepare(`
    INSERT INTO maintenance_state (task_key, last_run_at, details_json)
    VALUES (?, ?, ?)
    ON CONFLICT (task_key) DO UPDATE SET
        last_run_at = excluded.last_run_at,
        details_json = excluded.details_json
`);

export function removeTelegramSourcePost({ channel, messageId }) {
    return Number(deleteTelegramSourcePostStatement.run(
        String(channel ?? '').trim(),
        Number(messageId),
    ).changes ?? 0);
}

export function removeVkSourcePost({ screenName, postId }) {
    return Number(deleteVkSourcePostStatement.run(
        String(screenName ?? '').trim(),
        Number(postId),
    ).changes ?? 0);
}

export function getVkChatMessageMeta({ peerId, conversationMessageId }) {
    const row = selectVkChatMessageMetaStatement.get(
        Number(peerId),
        Number(conversationMessageId),
    );

    if (!row) {
        return null;
    }

    return {
        contentHash: String(row.content_hash ?? ''),
        imagePathsJson: String(row.image_paths_json ?? '[]'),
        eventCount: Number(row.event_count ?? 0),
    };
}

export function upsertVkChatSourceMessage({
    peerId,
    conversationMessageId,
    conversationUrl,
    conversationName,
    senderId,
    createdAt,
    rawText,
    links,
    imageUrls,
    imagePaths,
    contentHash,
    parseStatus,
    fetchedAt,
}) {
    upsertVkChatSourceMessageStatement.run(
        Number(peerId),
        Number(conversationMessageId),
        String(conversationUrl ?? '').trim(),
        String(conversationName ?? '').trim(),
        Number(senderId ?? 0),
        Number(createdAt ?? 0),
        String(rawText ?? ''),
        JSON.stringify(safeJsonArray(links)),
        JSON.stringify(safeJsonArray(imageUrls)),
        JSON.stringify(safeJsonArray(imagePaths)),
        String(contentHash ?? '').trim(),
        String(parseStatus ?? 'pending').trim(),
        Number(fetchedAt ?? Math.floor(Date.now() / 1000)),
    );
}

export function replaceVkChatEventsForMessage({
    peerId,
    conversationMessageId,
    sourceUrl,
    imagePaths,
    events,
    updatedAt,
}) {
    const safePeerId = Number(peerId);
    const safeMessageId = Number(conversationMessageId);
    const safeEvents = Array.isArray(events) ? events : [];

    database.exec('BEGIN IMMEDIATE');

    try {
        deleteVkChatEventsForMessageStatement.run(
            safePeerId,
            safeMessageId,
        );

        safeEvents.forEach((event, index) => {
            insertVkChatEventStatement.run(
                safePeerId,
                safeMessageId,
                index,
                String(event?.title ?? '').trim(),
                String(event?.eventDate ?? '').trim(),
                event?.eventTime ? String(event.eventTime).trim() : null,
                String(event?.venue ?? '').trim(),
                String(event?.participants ?? '').trim(),
                String(event?.price ?? '').trim(),
                String(event?.description ?? '').trim(),
                String(event?.evidence ?? '').trim(),
                String(sourceUrl ?? '').trim(),
                JSON.stringify(safeJsonArray(event?.imagePaths ?? imagePaths)),
                String(event?.parseMethod ?? 'gigachat_chat_lite').trim(),
                String(event?.status ?? 'pending').trim(),
                Number(updatedAt ?? Math.floor(Date.now() / 1000)),
            );
        });

        database.exec('COMMIT');
    } catch (error) {
        database.exec('ROLLBACK');
        throw error;
    }
}

export function removeVkChatSourceMessage({
    peerId,
    conversationMessageId,
}) {
    return Number(deleteVkChatSourceMessageStatement.run(
        Number(peerId),
        Number(conversationMessageId),
    ).changes ?? 0);
}

export function getVkChatScraperState(peerId) {
    const row = selectVkChatScraperStateStatement.get(Number(peerId));

    if (!row) {
        return null;
    }

    return {
        peerId: Number(row.peer_id),
        conversationUrl: String(row.conversation_url ?? ''),
        conversationName: String(row.conversation_name ?? ''),
        lastMessageId: Number(row.last_message_id ?? 0),
        lastSuccessAt: Number(row.last_success_at ?? 0),
        lastAttemptAt: Number(row.last_attempt_at ?? 0),
        lastError: String(row.last_error ?? ''),
        initialCompleted: Boolean(row.initial_completed),
        messagesSeen: Number(row.messages_seen ?? 0),
        candidatesChecked: Number(row.candidates_checked ?? 0),
        eventsFound: Number(row.events_found ?? 0),
        storedMessages: Number(row.stored_messages ?? 0),
        storedEvents: Number(row.stored_events ?? 0),
    };
}

export function updateVkChatScraperState({
    peerId,
    conversationUrl,
    conversationName,
    lastMessageId,
    lastSuccessAt,
    lastAttemptAt,
    lastError,
    initialCompleted,
    messagesSeen,
    candidatesChecked,
    eventsFound,
}) {
    upsertVkChatScraperStateStatement.run(
        Number(peerId),
        String(conversationUrl ?? '').trim(),
        String(conversationName ?? '').trim(),
        Number(lastMessageId ?? 0),
        Number(lastSuccessAt ?? 0),
        Number(lastAttemptAt ?? 0),
        String(lastError ?? '').slice(0, 2000),
        initialCompleted ? 1 : 0,
        Number(messagesSeen ?? 0),
        Number(candidatesChecked ?? 0),
        Number(eventsFound ?? 0),
    );
}

export function getVkChatUpcomingEvents({
    peerId,
    fromDate = currentIsoDate(),
    limit = 10,
}) {
    const safeLimit = Math.min(100, Math.max(1, Number(limit) || 10));

    return selectVkChatUpcomingEventsStatement
        .all(
            Number(peerId),
            String(fromDate ?? currentIsoDate()),
            safeLimit,
        )
        .map((row) => ({
            id: Number(row.id),
            sourceType: 'vk_chat',
            sourceName: String(row.conversation_name ?? `Беседа ${row.peer_id}`),
            peerId: Number(row.peer_id),
            conversationMessageId: Number(row.conversation_message_id),
            title: String(row.title ?? ''),
            eventDate: String(row.event_date ?? ''),
            eventTime: row.event_time ? String(row.event_time) : null,
            venue: String(row.venue ?? ''),
            participants: String(row.participants ?? ''),
            price: String(row.price ?? ''),
            description: String(row.description ?? ''),
            sourceUrl: String(row.source_url ?? ''),
            imagePaths: (() => {
                try {
                    return safeJsonArray(JSON.parse(row.image_paths_json ?? '[]'));
                } catch {
                    return [];
                }
            })(),
            parseMethod: String(row.parse_method ?? ''),
            status: String(row.status ?? ''),
        }));
}

export function getMaintenanceState(taskKey) {
    const row = selectMaintenanceStateStatement.get(
        String(taskKey ?? '').trim(),
    );

    if (!row) {
        return null;
    }

    let details = {};

    try {
        details = JSON.parse(row.details_json ?? '{}');
    } catch {
        details = {};
    }

    return {
        lastRunAt: Number(row.last_run_at ?? 0),
        details,
    };
}

export function cleanupExpiredEventData({
    beforeDate = currentIsoDate(),
    now = Math.floor(Date.now() / 1000),
} = {}) {
    const safeDate = String(beforeDate ?? currentIsoDate()).trim();
    const details = {
        telegramEvents: 0,
        vkEvents: 0,
        vkChatEvents: 0,
        telegramPosts: 0,
        vkPosts: 0,
        vkChatMessages: 0,
    };

    database.exec('BEGIN IMMEDIATE');

    try {
        details.telegramEvents = Number(database.prepare(`
            DELETE FROM telegram_events
            WHERE event_date < ?
        `).run(safeDate).changes ?? 0);

        details.vkEvents = Number(database.prepare(`
            DELETE FROM vk_events
            WHERE event_date < ?
        `).run(safeDate).changes ?? 0);

        details.vkChatEvents = Number(database.prepare(`
            DELETE FROM vk_chat_events
            WHERE event_date < ?
        `).run(safeDate).changes ?? 0);

        details.telegramPosts = Number(database.prepare(`
            DELETE FROM telegram_source_posts
            WHERE parse_status = 'event'
              AND NOT EXISTS (
                  SELECT 1 FROM telegram_events
                  WHERE telegram_events.channel = telegram_source_posts.channel
                    AND telegram_events.message_id = telegram_source_posts.message_id
              )
        `).run().changes ?? 0);

        details.vkPosts = Number(database.prepare(`
            DELETE FROM vk_source_posts
            WHERE parse_status = 'event'
              AND NOT EXISTS (
                  SELECT 1 FROM vk_events
                  WHERE vk_events.screen_name = vk_source_posts.screen_name
                    AND vk_events.post_id = vk_source_posts.post_id
              )
        `).run().changes ?? 0);

        details.vkChatMessages = Number(database.prepare(`
            DELETE FROM vk_chat_source_messages
            WHERE parse_status = 'event'
              AND NOT EXISTS (
                  SELECT 1 FROM vk_chat_events
                  WHERE vk_chat_events.peer_id = vk_chat_source_messages.peer_id
                    AND vk_chat_events.conversation_message_id = vk_chat_source_messages.conversation_message_id
              )
        `).run().changes ?? 0);

        upsertMaintenanceStateStatement.run(
            'weekly_event_cleanup',
            Number(now),
            JSON.stringify(details),
        );

        database.exec('COMMIT');
        return details;
    } catch (error) {
        database.exec('ROLLBACK');
        throw error;
    }
}
