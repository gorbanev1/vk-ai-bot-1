/**
 * SQLite-слой приложения: схема, мягкие миграции и функции чтения/записи. Модуль не должен знать о VK/Telegram Context и не отправляет сообщения.
 */
import {
    appendFileSync,
    existsSync,
    mkdirSync,
    readFileSync,
    writeFileSync,
} from 'node:fs';
import { basename, dirname, join, resolve, sep } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';

import {
    createAutoSummaryStateStore,
} from './autoSummaryStateStore.js';
import {
    extractExplicitDateMentions,
    extractRawDateMentions,
    isEventDateConsistentWithSource,
} from '../../features/events/publicPostDateEvidence.js';
import {
    explainRetrospectivePost,
} from '../../features/events/eventTextSanitation.js';
import {
    parsePublicPostLocally,
} from '../../features/events/publicPostLocalParser.js';
import {
    assignEventImageIndexesFromFacts,
    evaluatePosterFactForEvent,
    selectBestCompatiblePosterFact,
} from '../../features/events/eventPosterMatching.js';
import {
    detectRasterImageDimensions,
} from '../../features/events/eventImageSelection.js';
import {
    buildPermanentEventFingerprint,
    compareEventToPermanentFingerprint,
    permanentEventFingerprintLabel,
} from '../../features/events/eventPermanentDeletion.js';
import {
    assertTestDatabaseIsolation,
    resolveMainDatabasePath,
    resolveQticketsDatabasePath,
    resolveRuntimeDataDirectory,
    DEFAULT_QTICKETS_DATABASE_PATH,
} from './runtimePaths.js';

const dataDirectory = resolveRuntimeDataDirectory();
const databasePath = resolveMainDatabasePath();
const qticketsDatabasePath = resolveQticketsDatabasePath();
const journalDirectory = dirname(databasePath) || dataDirectory;
const liveMessageJournalPath = join(journalDirectory, 'live-message-journal.jsonl');
const vkMessageArchiveJournalPath = join(journalDirectory, 'vk-message-archive-journal.jsonl');

assertTestDatabaseIsolation({ databasePath });
assertTestDatabaseIsolation({
    databasePath: qticketsDatabasePath,
    productionPath: DEFAULT_QTICKETS_DATABASE_PATH,
});
mkdirSync(dirname(databasePath), { recursive: true });
mkdirSync(dirname(qticketsDatabasePath), { recursive: true });
mkdirSync(journalDirectory, { recursive: true });

export const MAIN_DATABASE_PATH = databasePath;
export const QTICKETS_DATABASE_PATH = qticketsDatabasePath;
export const RUNTIME_DATA_DIRECTORY = dataDirectory;

const database = new DatabaseSync(databasePath);
const qticketsDatabase = new DatabaseSync(qticketsDatabasePath);

qticketsDatabase.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA synchronous = NORMAL;
    PRAGMA foreign_keys = ON;
`);

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

    /*
     * V164: persistent speech-to-text cache. Voice attachments can be seen
     * repeatedly by manual VK history scans or through replies/forwards; the
     * transcript is paid/computed once and then reused across restarts.
     */
    CREATE TABLE IF NOT EXISTS voice_transcripts (
        platform TEXT NOT NULL,
        attachment_key TEXT NOT NULL,
        peer_id INTEGER NOT NULL DEFAULT 0,
        conversation_message_id INTEGER NOT NULL DEFAULT 0,
        transcript TEXT NOT NULL DEFAULT '',
        source TEXT NOT NULL DEFAULT '',
        model TEXT NOT NULL DEFAULT '',
        status TEXT NOT NULL DEFAULT 'ok' CHECK (status IN ('ok', 'error')),
        last_error TEXT NOT NULL DEFAULT '',
        retry_after INTEGER NOT NULL DEFAULT 0,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY (platform, attachment_key)
    );

    CREATE INDEX IF NOT EXISTS voice_transcripts_message_idx
    ON voice_transcripts (platform, peer_id, conversation_message_id, updated_at DESC);

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
        active_chat_enabled INTEGER NOT NULL DEFAULT 0 CHECK (active_chat_enabled IN (0, 1)),
        active_chat_message_count INTEGER NOT NULL DEFAULT 0,
        active_chat_interval INTEGER NOT NULL DEFAULT 10,
        active_chat_target_offset INTEGER NOT NULL DEFAULT 0,
        active_chat_last_reply_at INTEGER NOT NULL DEFAULT 0,
        updated_by INTEGER NOT NULL DEFAULT 0,
        updated_at INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS communication_settings_due_idx
    ON communication_settings (is_group, persona, next_outburst_at);

    /*
     * V148: минимальная статистика обращений к боту без хранения текста ЛС.
     * request_key идемпотентен для одного входящего сообщения, поэтому
     * повторная доставка webhook/long-poll после рестарта не раздувает счётчик.
     */
    CREATE TABLE IF NOT EXISTS bot_request_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        platform TEXT NOT NULL,
        endpoint_key TEXT NOT NULL DEFAULT '',
        peer_id INTEGER NOT NULL,
        user_id INTEGER NOT NULL,
        external_peer_id TEXT NOT NULL DEFAULT '',
        external_user_id TEXT NOT NULL DEFAULT '',
        is_group INTEGER NOT NULL DEFAULT 0 CHECK (is_group IN (0, 1)),
        request_key TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        UNIQUE (platform, endpoint_key, request_key)
    );

    CREATE INDEX IF NOT EXISTS bot_request_events_period_idx
    ON bot_request_events (created_at, is_group, platform, endpoint_key);

    CREATE INDEX IF NOT EXISTS bot_request_events_user_idx
    ON bot_request_events (platform, external_user_id, created_at);

    CREATE TABLE IF NOT EXISTS auto_summary_settings (
        peer_id INTEGER PRIMARY KEY,
        platform TEXT NOT NULL DEFAULT 'vk',
        endpoint_key TEXT NOT NULL DEFAULT 'vk:primary',
        external_peer_id TEXT NOT NULL DEFAULT '',
        mode TEXT NOT NULL DEFAULT 'full' CHECK (mode IN ('full', 'day', 'evening')),
        enabled INTEGER NOT NULL DEFAULT 0 CHECK (enabled IN (0, 1)),
        next_run_at INTEGER NOT NULL DEFAULT 0,
        updated_by INTEGER NOT NULL DEFAULT 0,
        updated_at INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS auto_summary_settings_due_idx
    ON auto_summary_settings (enabled, next_run_at);

    CREATE TABLE IF NOT EXISTS auto_summary_runs (
        peer_id INTEGER NOT NULL,
        summary_date TEXT NOT NULL,
        slot_label TEXT NOT NULL,
        scheduled_at INTEGER NOT NULL,
        started_at INTEGER NOT NULL,
        finished_at INTEGER NOT NULL DEFAULT 0,
        message_count INTEGER NOT NULL DEFAULT 0,
        summary_text TEXT NOT NULL DEFAULT '',
        PRIMARY KEY (peer_id, summary_date, slot_label)
    );

    CREATE INDEX IF NOT EXISTS auto_summary_runs_peer_idx
    ON auto_summary_runs (peer_id, scheduled_at DESC);

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

    /*
     * Активная шуточная перепалка после фонового выпадa. Состояние хранится
     * по конкретному участнику, чтобы после перезапуска бот не забывал,
     * кому адресовалась реплика и кто продолжил нападать на бота.
     */
    CREATE TABLE IF NOT EXISTS communication_banter_state (
        peer_id INTEGER NOT NULL,
        target_user_id INTEGER NOT NULL,
        platform TEXT NOT NULL DEFAULT 'vk',
        external_peer_id TEXT NOT NULL DEFAULT '',
        target_external_user_id TEXT NOT NULL DEFAULT '',
        target_display_name TEXT NOT NULL DEFAULT '',
        active_until INTEGER NOT NULL DEFAULT 0,
        last_attack_at INTEGER NOT NULL DEFAULT 0,
        last_reply_at INTEGER NOT NULL DEFAULT 0,
        reply_count INTEGER NOT NULL DEFAULT 0,
        last_bot_text TEXT NOT NULL DEFAULT '',
        updated_at INTEGER NOT NULL,
        PRIMARY KEY (peer_id, target_user_id)
    );

    CREATE INDEX IF NOT EXISTS communication_banter_active_idx
    ON communication_banter_state (peer_id, target_user_id, active_until);

    /*
     * Мероприятия, вручную добавленные владельцем через VK или Telegram.
     * Они проходят ту же строгую проверку даты, места и сути события.
     */
    CREATE TABLE IF NOT EXISTS manual_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        title TEXT NOT NULL,
        event_date TEXT NOT NULL,
        event_time TEXT,
        venue TEXT NOT NULL,
        participants TEXT NOT NULL DEFAULT '',
        price TEXT NOT NULL DEFAULT '',
        description TEXT NOT NULL DEFAULT '',
        evidence TEXT NOT NULL DEFAULT '',
        source_url TEXT NOT NULL DEFAULT '',
        source_text TEXT NOT NULL DEFAULT '',
        image_paths_json TEXT NOT NULL DEFAULT '[]',
        status TEXT NOT NULL DEFAULT 'approved'
            CHECK (status IN ('approved', 'pending', 'ignored')),
        created_by_platform TEXT NOT NULL DEFAULT 'vk',
        created_by INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS manual_events_date_idx
    ON manual_events (event_date, event_time, status);

    /*
     * V104: предложения тус от обычных пользователей. Сначала материал
     * парсится в нормализованную карточку и ждёт owner-модерации. Если
     * владелец не ответил за 24 часа, карточка может быть принята автоматически.
     */
    CREATE TABLE IF NOT EXISTS event_proposals (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        submitter_platform TEXT NOT NULL DEFAULT 'vk',
        submitter_external_id TEXT NOT NULL DEFAULT '',
        submitter_internal_id INTEGER NOT NULL DEFAULT 0,
        raw_submission TEXT NOT NULL DEFAULT '',
        source_url TEXT NOT NULL DEFAULT '',
        parsed_events_json TEXT NOT NULL DEFAULT '[]',
        status TEXT NOT NULL DEFAULT 'pending'
            CHECK (status IN ('pending', 'approved', 'rejected', 'auto_approved')),
        submitted_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL,
        resolved_at INTEGER NOT NULL DEFAULT 0,
        reviewed_by_platform TEXT NOT NULL DEFAULT '',
        reviewed_by INTEGER NOT NULL DEFAULT 0
    );

    CREATE INDEX IF NOT EXISTS event_proposals_pending_idx
    ON event_proposals (status, expires_at, id);

    /*
     * V103: non-destructive registry of duplicate groups. Raw event rows remain
     * source evidence; the registry records which rows were collapsed into one
     * canonical event by the current dedupe algorithm.
     */
    CREATE TABLE IF NOT EXISTS event_dedupe_groups (
        scope TEXT NOT NULL,
        group_key TEXT NOT NULL,
        canonical_json TEXT NOT NULL,
        member_count INTEGER NOT NULL DEFAULT 0,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY (scope, group_key)
    );

    CREATE TABLE IF NOT EXISTS event_dedupe_members (
        scope TEXT NOT NULL,
        source_type TEXT NOT NULL,
        event_id INTEGER NOT NULL,
        group_key TEXT NOT NULL,
        role TEXT NOT NULL CHECK (role IN ('canonical', 'duplicate')),
        updated_at INTEGER NOT NULL,
        PRIMARY KEY (scope, source_type, event_id),
        FOREIGN KEY (scope, group_key)
            REFERENCES event_dedupe_groups(scope, group_key)
            ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS event_dedupe_members_group_idx
    ON event_dedupe_members (scope, group_key, role);

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

    /*
     * V132: журнал одноразовой привязки истории удалённой групповой беседы
     * к новой. Он защищает от случайного повторного слияния другой беседы
     * в тот же новый peer_id.
     */
    CREATE TABLE IF NOT EXISTS peer_history_migrations (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        platform TEXT NOT NULL,
        source_peer_id INTEGER NOT NULL,
        target_peer_id INTEGER NOT NULL,
        source_message_count INTEGER NOT NULL DEFAULT 0,
        target_message_count_before INTEGER NOT NULL DEFAULT 0,
        remapped_target_message_ids INTEGER NOT NULL DEFAULT 0,
        backup_path TEXT NOT NULL DEFAULT '',
        migrated_at INTEGER NOT NULL,
        UNIQUE (platform, target_peer_id)
    );

    CREATE INDEX IF NOT EXISTS peer_history_migrations_source_idx
    ON peer_history_migrations (platform, source_peer_id, migrated_at DESC);

    /*
     * V176: durable membership timeline for group chats. VK represents both a
     * voluntary leave and an administrator kick as chat_kick_user; when the
     * actor is the same user as action.member_id it is a voluntary leave.
     * source_peer_id preserves which physical VK conversation produced the
     * service event, while peer_id points at the canonical/rebound chat whose
     * history the bot exposes to commands.
     */
    CREATE TABLE IF NOT EXISTS chat_membership_events (
        platform TEXT NOT NULL,
        peer_id INTEGER NOT NULL,
        source_peer_id INTEGER NOT NULL,
        conversation_message_id INTEGER NOT NULL,
        event_type TEXT NOT NULL
            CHECK (event_type IN ('left', 'kicked', 'joined')),
        actor_id INTEGER NOT NULL DEFAULT 0,
        member_id INTEGER NOT NULL,
        created_at INTEGER NOT NULL,
        raw_action_type TEXT NOT NULL DEFAULT '',
        PRIMARY KEY (
            platform,
            source_peer_id,
            conversation_message_id,
            event_type,
            member_id
        )
    );

    CREATE INDEX IF NOT EXISTS chat_membership_events_peer_created_idx
    ON chat_membership_events (platform, peer_id, created_at DESC);

    CREATE INDEX IF NOT EXISTS chat_membership_events_peer_member_idx
    ON chat_membership_events (platform, peer_id, member_id, created_at DESC);

    /*
     * V180: durable VK display-name cache used by membership reports. The
     * report must show profile names even when VK users.get is temporarily
     * unavailable. Names are refreshed opportunistically whenever users.get
     * succeeds.
     */
    CREATE TABLE IF NOT EXISTS vk_user_name_cache (
        user_id INTEGER PRIMARY KEY,
        full_name TEXT NOT NULL,
        updated_at INTEGER NOT NULL
    );

    /*
     * V182: restart-safe automatic leaver reports. The interval is measured
     * from the moment the command is enabled; last_run_at marks the beginning
     * of the next report window so a restart cannot silently drop exits.
     */
    CREATE TABLE IF NOT EXISTS chat_leaver_auto_settings (
        peer_id INTEGER PRIMARY KEY,
        platform TEXT NOT NULL DEFAULT 'vk',
        endpoint_key TEXT NOT NULL DEFAULT 'vk:primary',
        external_peer_id TEXT NOT NULL DEFAULT '',
        interval_days INTEGER NOT NULL DEFAULT 1 CHECK (interval_days BETWEEN 1 AND 365),
        enabled INTEGER NOT NULL DEFAULT 0 CHECK (enabled IN (0, 1)),
        next_run_at INTEGER NOT NULL DEFAULT 0,
        last_run_at INTEGER NOT NULL DEFAULT 0,
        updated_by INTEGER NOT NULL DEFAULT 0,
        updated_at INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS chat_leaver_auto_settings_due_idx
    ON chat_leaver_auto_settings (enabled, next_run_at);

    /*
     * V177: lossless VK conversation archive. Unlike messages, which is the
     * semantic incoming-user history consumed by GPT features, this table
     * stores EVERY VK message object that we can obtain: incoming, outgoing and
     * service/action messages. action_json and raw_message_json preserve the
     * original VK payload so future reports can be rebuilt without another API
     * crawl. source_peer_id keeps the physical conversation before history
     * rebinding; peer_id is the canonical conversation exposed to commands.
     */
    CREATE TABLE IF NOT EXISTS vk_message_archive (
        peer_id INTEGER NOT NULL,
        source_peer_id INTEGER NOT NULL,
        conversation_message_id INTEGER NOT NULL,
        message_id INTEGER NOT NULL DEFAULT 0,
        sender_id INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL DEFAULT 0,
        is_outbox INTEGER NOT NULL DEFAULT 0 CHECK (is_outbox IN (0, 1)),
        text TEXT NOT NULL DEFAULT '',
        action_type TEXT NOT NULL DEFAULT '',
        action_json TEXT NOT NULL DEFAULT '',
        raw_message_json TEXT NOT NULL DEFAULT '',
        first_seen_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY (source_peer_id, conversation_message_id)
    );

    CREATE INDEX IF NOT EXISTS vk_message_archive_peer_created_idx
    ON vk_message_archive (peer_id, created_at, conversation_message_id);

    CREATE INDEX IF NOT EXISTS vk_message_archive_peer_action_idx
    ON vk_message_archive (peer_id, action_type, created_at, conversation_message_id);

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

    /*
     * Глобальный owner-controlled дословный ответ на команды «корды» в
     * фиксированное окно 22.08.2026 11:00–24:00 Europe/Moscow.
     * Одна строка намеренно общая для всех диалогов и платформ.
     */
    CREATE TABLE IF NOT EXISTS coords_override_settings (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        message_text TEXT NOT NULL DEFAULT '',
        enabled INTEGER NOT NULL DEFAULT 0 CHECK (enabled IN (0, 1)),
        updated_by INTEGER NOT NULL DEFAULT 0,
        updated_at INTEGER NOT NULL DEFAULT 0
    );

    INSERT OR IGNORE INTO coords_override_settings (
        id,
        message_text,
        enabled,
        updated_by,
        updated_at
    ) VALUES (1, '', 0, 0, 0);

    /*
     * Пользователи, которые явно запрашивали координаты в личке.
     * endpoint_key различает основное VK-сообщество, VK-встречу и Telegram,
     * поэтому один человек может получить рассылку в каждой точке входа,
     * где он действительно писал «корды». Текст личной переписки не хранится.
     */
    CREATE TABLE IF NOT EXISTS coords_request_recipients (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        platform TEXT NOT NULL CHECK (platform IN ('vk', 'telegram')),
        endpoint_key TEXT NOT NULL,
        external_user_id TEXT NOT NULL,
        external_peer_id TEXT NOT NULL,
        external_username TEXT NOT NULL DEFAULT '',
        first_requested_at INTEGER NOT NULL,
        last_requested_at INTEGER NOT NULL,
        request_count INTEGER NOT NULL DEFAULT 1,
        UNIQUE (platform, endpoint_key, external_user_id)
    );

    CREATE INDEX IF NOT EXISTS idx_coords_request_recipients_last_request
    ON coords_request_recipients(last_requested_at DESC);

    /*
     * V109/V110: одноразовое ожидание отзыва после пост-ивентной рассылки
     * или Telegram-кнопки благодарности. Содержимое обычных ЛС здесь не
     * сохраняется — только сообщение, которое пользователь отправил именно
     * как ожидаемый отзыв после явного приглашения.
     */
    CREATE TABLE IF NOT EXISTS post_event_feedback_requests (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        campaign_key TEXT NOT NULL,
        platform TEXT NOT NULL CHECK (platform IN ('vk', 'telegram')),
        endpoint_key TEXT NOT NULL,
        external_user_id TEXT NOT NULL,
        external_peer_id TEXT NOT NULL,
        sent_at INTEGER NOT NULL,
        awaiting_feedback INTEGER NOT NULL DEFAULT 1 CHECK (awaiting_feedback IN (0, 1)),
        feedback_received_at INTEGER NOT NULL DEFAULT 0,
        UNIQUE (campaign_key, platform, endpoint_key, external_user_id)
    );

    CREATE INDEX IF NOT EXISTS idx_post_event_feedback_requests_pending
    ON post_event_feedback_requests(campaign_key, awaiting_feedback, sent_at DESC);

    CREATE TABLE IF NOT EXISTS post_event_feedback_reviews (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        campaign_key TEXT NOT NULL,
        platform TEXT NOT NULL CHECK (platform IN ('vk', 'telegram')),
        endpoint_key TEXT NOT NULL,
        external_user_id TEXT NOT NULL,
        external_peer_id TEXT NOT NULL,
        review_text TEXT NOT NULL,
        received_at INTEGER NOT NULL,
        UNIQUE (campaign_key, platform, endpoint_key, external_user_id)
    );

    CREATE INDEX IF NOT EXISTS idx_post_event_feedback_reviews_campaign
    ON post_event_feedback_reviews(campaign_key, received_at DESC);

    /*
     * Глобальные реквизиты, показываемые вместе с QR-кодом. Картинка хранится
     * локально в data/qr-code, а в SQLite лежит только относительный путь.
     * Один набор настроек общий для VK (оба сообщества) и Telegram.
     */
    CREATE TABLE IF NOT EXISTS qr_code_settings (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        message_text TEXT NOT NULL DEFAULT '89968257889 Сбер Игорь Анатольевич.',
        image_path TEXT NOT NULL DEFAULT '',
        updated_by INTEGER NOT NULL DEFAULT 0,
        updated_at INTEGER NOT NULL DEFAULT 0
    );

    INSERT OR IGNORE INTO qr_code_settings (
        id,
        message_text,
        image_path,
        updated_by,
        updated_at
    ) VALUES (1, '89968257889 Сбер Игорь Анатольевич.', '', 0, 0);

    /*
     * Общие одноразовые миграции кода. В отличие от scraper_code_migrations,
     * эта таблица используется для продуктовых настроек, которые нужно
     * применить к уже существующей базе ровно один раз.
     */
    CREATE TABLE IF NOT EXISTS bot_code_migrations (
        migration_key TEXT PRIMARY KEY,
        applied_at INTEGER NOT NULL
    );
`);

/*
 * QTickets — отдельный источник афиши. Он не смешивается с manual_events:
 * обычная «тусовая» выдача не должна показывать карточки агрегатора, а
 * отдельная команда QTickets должна читать именно этот контур.
 */
qticketsDatabase.exec(`
    CREATE TABLE IF NOT EXISTS qtickets_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        external_id TEXT NOT NULL DEFAULT '',
        detail_url TEXT NOT NULL UNIQUE,
        listing_url TEXT NOT NULL DEFAULT '',
        title TEXT NOT NULL,
        event_date TEXT NOT NULL,
        event_time TEXT,
        event_end_date TEXT NOT NULL DEFAULT '',
        date_label TEXT NOT NULL DEFAULT '',
        venue TEXT NOT NULL DEFAULT '',
        participants TEXT NOT NULL DEFAULT '',
        price TEXT NOT NULL DEFAULT '',
        event_type TEXT NOT NULL DEFAULT '',
        age_restriction TEXT NOT NULL DEFAULT '',
        description TEXT NOT NULL DEFAULT '',
        evidence TEXT NOT NULL DEFAULT '',
        source_text TEXT NOT NULL DEFAULT '',
        ticket_url TEXT NOT NULL DEFAULT '',
        image_urls_json TEXT NOT NULL DEFAULT '[]',
        image_paths_json TEXT NOT NULL DEFAULT '[]',
        status TEXT NOT NULL DEFAULT 'approved'
            CHECK (status IN ('approved', 'ignored')),
        parse_method TEXT NOT NULL DEFAULT '',
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS qtickets_events_date_idx
    ON qtickets_events (event_date, event_end_date, event_time, status);

    CREATE INDEX IF NOT EXISTS qtickets_events_listing_idx
    ON qtickets_events (listing_url, status, updated_at);
`);

// V188.88: отдельный индекс метаданных агрегированного раздела «Вообще все тусы».
// Он не меняет исходные event-таблицы и не участвует в их основном дедупе.
database.exec(`
    CREATE TABLE IF NOT EXISTS all_party_metadata (
        source_type TEXT NOT NULL,
        event_id INTEGER NOT NULL,
        party_pool TEXT NOT NULL DEFAULT '',
        title TEXT NOT NULL DEFAULT '',
        event_date TEXT NOT NULL DEFAULT '',
        venue TEXT NOT NULL DEFAULT '',
        source_url TEXT NOT NULL DEFAULT '',
        title_tokens_json TEXT NOT NULL DEFAULT '[]',
        updated_at INTEGER NOT NULL,
        PRIMARY KEY (source_type, event_id)
    );

    CREATE INDEX IF NOT EXISTS all_party_metadata_date_idx
    ON all_party_metadata (event_date, source_type, event_id);
`);
ensureTableColumn('all_party_metadata', 'venue_key', "TEXT NOT NULL DEFAULT ''");
ensureTableColumn('all_party_metadata', 'tags_json', "TEXT NOT NULL DEFAULT '[]'");




// One-time compatibility import from releases where QTickets lived inside
// bot.sqlite. The two stores remain physically isolated after this copy, so
// ordinary event dedupe can never query or mutate QTickets rows.
if (resolve(qticketsDatabasePath) !== resolve(databasePath)) {
    try {
        const legacyTable = database.prepare(`
            SELECT name FROM sqlite_master
            WHERE type = 'table' AND name = 'qtickets_events'
            LIMIT 1
        `).get();
        if (legacyTable?.name) {
            const legacyRows = database.prepare(`
                SELECT external_id, detail_url, listing_url, title, event_date,
                       event_time, event_end_date, date_label, venue, participants,
                       price, event_type, age_restriction, description, evidence,
                       source_text, ticket_url, image_urls_json, image_paths_json,
                       status, parse_method, created_at, updated_at
                FROM qtickets_events
            `).all();
            if (legacyRows.length) {
                const importStatement = qticketsDatabase.prepare(`
                    INSERT OR IGNORE INTO qtickets_events (
                        external_id, detail_url, listing_url, title, event_date,
                        event_time, event_end_date, date_label, venue, participants,
                        price, event_type, age_restriction, description, evidence,
                        source_text, ticket_url, image_urls_json, image_paths_json,
                        status, parse_method, created_at, updated_at
                    ) VALUES (
                        ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
                    )
                `);
                qticketsDatabase.exec('BEGIN IMMEDIATE');
                try {
                    for (const row of legacyRows) {
                        importStatement.run(
                            row.external_id, row.detail_url, row.listing_url, row.title, row.event_date,
                            row.event_time, row.event_end_date, row.date_label, row.venue, row.participants,
                            row.price, row.event_type, row.age_restriction, row.description, row.evidence,
                            row.source_text, row.ticket_url, row.image_urls_json, row.image_paths_json,
                            row.status, row.parse_method, row.created_at, row.updated_at,
                        );
                    }
                    qticketsDatabase.exec('COMMIT');
                    console.log('[QTICKETS DB MIGRATION]', `imported-or-known=${legacyRows.length}`);
                } catch (error) {
                    qticketsDatabase.exec('ROLLBACK');
                    throw error;
                }
            }
        }
    } catch (error) {
        // A legacy schema from an experimental build may not have every current
        // column. Do not block application startup; fresh QTickets parsing will
        // populate the isolated database normally.
        console.warn('[QTICKETS DB MIGRATION SKIPPED]', String(error?.message ?? error));
    }
}

/*
 * V155: author-summary settings/runs are additionally kept in a dedicated
 * user-level SQLite database outside the release directory. The legacy tables
 * above remain for backwards compatibility and one-time migration.
 */
const autoSummaryStateStore = createAutoSummaryStateStore();

try {
    const legacySettings = database.prepare(`
        SELECT peer_id, platform, endpoint_key, external_peer_id, mode, enabled,
               next_run_at, updated_by, updated_at
        FROM auto_summary_settings
    `).all();
    const legacyRuns = database.prepare(`
        SELECT peer_id, summary_date, slot_label, scheduled_at, started_at,
               finished_at, message_count, summary_text
        FROM auto_summary_runs
    `).all();
    const migrated = autoSummaryStateStore.importLegacy({
        settings: legacySettings,
        runs: legacyRuns,
    });
    if (migrated.settingsImported || migrated.runsImported) {
        console.log(
            '[AUTO SUMMARY STATE MIGRATION]',
            `settings=${migrated.settingsImported}`,
            `runs=${migrated.runsImported}`,
            `database=${autoSummaryStateStore.databasePath}`,
        );
    }
} catch (error) {
    console.error('[AUTO SUMMARY STATE MIGRATION ERROR]', error);
}

/*
 * V118: рабочий runtime-реестр AI-моделей. В таблице нет секретов: только
 * имя env-slot, маска ключа, model id, capability и endpoint последнего
 * успешного live-теста. Полный аудит атомарно пересобирает таблицу и тем
 * самым удаляет все не прошедшие тест комбинации из рабочего реестра.
 */
database.exec(`
    CREATE TABLE IF NOT EXISTS ai_runtime_modes (
        provider TEXT NOT NULL,
        env_name TEXT NOT NULL,
        masked_key TEXT NOT NULL DEFAULT '',
        model TEXT NOT NULL,
        capability TEXT NOT NULL CHECK (capability IN ('text', 'image')),
        endpoint TEXT NOT NULL DEFAULT '',
        tested_at INTEGER NOT NULL,
        PRIMARY KEY (provider, env_name, model, capability)
    );

    CREATE INDEX IF NOT EXISTS ai_runtime_modes_capability_idx
    ON ai_runtime_modes (capability, provider, model);
`);


function ensureTableColumn(tableName, columnName, definition) {
    const columns = new Set(
        database.prepare(`PRAGMA table_info(${tableName})`)
            .all()
            .map((row) => String(row.name ?? '')),
    );

    if (!columns.has(columnName)) {
        database.exec(
            `ALTER TABLE ${tableName} ADD COLUMN ${columnName} ${definition}`,
        );
    }
}

/*
 * Мягкая миграция существующей базы V39. CREATE TABLE IF NOT EXISTS не
 * добавляет новые поля, поэтому активное общение расширяется отдельно без
 * удаления истории и текущих настроек роли/теплоты.
 */
ensureTableColumn(
    'coords_request_recipients',
    'external_username',
    "TEXT NOT NULL DEFAULT ''",
);


/* V119: transport/reasoning policy learned by the full live AI audit. */
ensureTableColumn('ai_runtime_modes', 'preferred_transport', "TEXT NOT NULL DEFAULT ''");
ensureTableColumn('ai_runtime_modes', 'fallback_transport', "TEXT NOT NULL DEFAULT ''");
ensureTableColumn('ai_runtime_modes', 'fallback_endpoint', "TEXT NOT NULL DEFAULT ''");
ensureTableColumn('ai_runtime_modes', 'non_stream_ok', 'INTEGER NOT NULL DEFAULT 0');
ensureTableColumn('ai_runtime_modes', 'stream_ok', 'INTEGER NOT NULL DEFAULT 0');
ensureTableColumn('ai_runtime_modes', 'reasoning_modes_json', "TEXT NOT NULL DEFAULT '[]'");
ensureTableColumn('ai_runtime_modes', 'reasoning_policy_json', "TEXT NOT NULL DEFAULT '{}'");


/*
 * V188.4: compact live health registry for keys/models. This registry keeps
 * the last observed state for BOTH working and failed combinations. Secrets
 * are never persisted: env slot + masked key are enough to keep routing
 * deterministic after a restart. ai_runtime_modes remains the allow-list of
 * combinations that actually passed a live call.
 */
database.exec(`
    CREATE TABLE IF NOT EXISTS ai_key_health (
        provider TEXT NOT NULL,
        env_name TEXT NOT NULL,
        masked_key TEXT NOT NULL DEFAULT '',
        status TEXT NOT NULL DEFAULT 'unknown',
        catalog_status INTEGER NOT NULL DEFAULT 0,
        catalog_latency_ms INTEGER NOT NULL DEFAULT 0,
        models_seen INTEGER NOT NULL DEFAULT 0,
        working_models INTEGER NOT NULL DEFAULT 0,
        last_error TEXT NOT NULL DEFAULT '',
        checked_at INTEGER NOT NULL,
        PRIMARY KEY (provider, env_name)
    );

    CREATE TABLE IF NOT EXISTS ai_model_health (
        provider TEXT NOT NULL,
        env_name TEXT NOT NULL,
        masked_key TEXT NOT NULL DEFAULT '',
        model TEXT NOT NULL,
        capability TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'unknown',
        non_stream_ok INTEGER NOT NULL DEFAULT 0,
        stream_ok INTEGER NOT NULL DEFAULT 0,
        non_stream_status INTEGER NOT NULL DEFAULT 0,
        stream_status INTEGER NOT NULL DEFAULT 0,
        non_stream_latency_ms INTEGER NOT NULL DEFAULT 0,
        stream_latency_ms INTEGER NOT NULL DEFAULT 0,
        preferred_transport TEXT NOT NULL DEFAULT '',
        last_error TEXT NOT NULL DEFAULT '',
        checked_at INTEGER NOT NULL,
        PRIMARY KEY (provider, env_name, model, capability)
    );

    CREATE INDEX IF NOT EXISTS ai_model_health_lookup_idx
    ON ai_model_health (provider, env_name, model, capability, status);

    /* V188.49: durable discovery/qualification registry. Catalog presence never
     * implies production eligibility: only qualification_status='qualified' may
     * be appended to runtime failover ladders. */
    CREATE TABLE IF NOT EXISTS ai_model_discovery (
        provider TEXT NOT NULL,
        env_name TEXT NOT NULL,
        masked_key TEXT NOT NULL DEFAULT '',
        model TEXT NOT NULL,
        capabilities_json TEXT NOT NULL DEFAULT '[]',
        first_seen_at INTEGER NOT NULL,
        last_seen_at INTEGER NOT NULL,
        qualification_status TEXT NOT NULL DEFAULT 'pending',
        qualification_json TEXT NOT NULL DEFAULT '{}',
        qualified_at INTEGER NOT NULL DEFAULT 0,
        promoted INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (provider, env_name, model)
    );

    CREATE INDEX IF NOT EXISTS ai_model_discovery_qualification_idx
    ON ai_model_discovery (qualification_status, provider, model);
`);

/*
 * V117: V109/V110 существовали в нескольких вариантах схемы. В части рабочих
 * баз не было feedback_received_at, а в более ранней схеме отсутствовал и id.
 * Одного ALTER TABLE недостаточно: ON CONFLICT ниже также требует канонический
 * UNIQUE(campaign_key, platform, endpoint_key, external_user_id). Поэтому до
 * prepare() приводим таблицу к одной устойчивой схеме, сохраняя старые строки.
 */
function migratePostEventFeedbackRequestsSchema() {
    ensureTableColumn(
        'post_event_feedback_requests',
        'feedback_received_at',
        'INTEGER NOT NULL DEFAULT 0',
    );

    const columns = database.prepare('PRAGMA table_info(post_event_feedback_requests)').all();
    const columnNames = new Set(columns.map((row) => String(row.name ?? '')));
    const hasId = columnNames.has('id');

    const uniqueIndexes = database.prepare("PRAGMA index_list('post_event_feedback_requests')").all();
    const hasCanonicalUnique = uniqueIndexes.some((indexRow) => {
        if (!Number(indexRow.unique)) return false;
        const indexName = String(indexRow.name ?? '').replaceAll("'", "''");
        if (!indexName) return false;
        const indexedColumns = database.prepare(`PRAGMA index_info('${indexName}')`)
            .all()
            .map((row) => String(row.name ?? ''));
        return indexedColumns.length === 4
            && indexedColumns[0] === 'campaign_key'
            && indexedColumns[1] === 'platform'
            && indexedColumns[2] === 'endpoint_key'
            && indexedColumns[3] === 'external_user_id';
    });

    if (hasId && hasCanonicalUnique) return;

    database.exec('BEGIN IMMEDIATE');
    try {
        database.exec(`
            DROP TABLE IF EXISTS post_event_feedback_requests_v117;
            CREATE TABLE post_event_feedback_requests_v117 (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                campaign_key TEXT NOT NULL,
                platform TEXT NOT NULL CHECK (platform IN ('vk', 'telegram')),
                endpoint_key TEXT NOT NULL,
                external_user_id TEXT NOT NULL,
                external_peer_id TEXT NOT NULL,
                sent_at INTEGER NOT NULL,
                awaiting_feedback INTEGER NOT NULL DEFAULT 1 CHECK (awaiting_feedback IN (0, 1)),
                feedback_received_at INTEGER NOT NULL DEFAULT 0,
                UNIQUE (campaign_key, platform, endpoint_key, external_user_id)
            );

            INSERT INTO post_event_feedback_requests_v117 (
                campaign_key,
                platform,
                endpoint_key,
                external_user_id,
                external_peer_id,
                sent_at,
                awaiting_feedback,
                feedback_received_at
            )
            SELECT
                campaign_key,
                platform,
                endpoint_key,
                external_user_id,
                MAX(external_peer_id) AS external_peer_id,
                MAX(sent_at) AS sent_at,
                CASE
                    WHEN MAX(feedback_received_at) > 0 THEN 0
                    ELSE MAX(CASE WHEN awaiting_feedback <> 0 THEN 1 ELSE 0 END)
                END AS awaiting_feedback,
                MAX(feedback_received_at) AS feedback_received_at
            FROM post_event_feedback_requests
            WHERE platform IN ('vk', 'telegram')
              AND TRIM(campaign_key) <> ''
              AND TRIM(endpoint_key) <> ''
              AND TRIM(external_user_id) <> ''
            GROUP BY campaign_key, platform, endpoint_key, external_user_id;

            DROP TABLE post_event_feedback_requests;
            ALTER TABLE post_event_feedback_requests_v117 RENAME TO post_event_feedback_requests;
            CREATE INDEX IF NOT EXISTS idx_post_event_feedback_requests_pending
            ON post_event_feedback_requests(campaign_key, awaiting_feedback, sent_at DESC);
        `);
        database.exec('COMMIT');
    } catch (error) {
        database.exec('ROLLBACK');
        throw error;
    }
}

migratePostEventFeedbackRequestsSchema();

ensureTableColumn(
    'communication_settings',
    'active_chat_enabled',
    'INTEGER NOT NULL DEFAULT 0 CHECK (active_chat_enabled IN (0, 1))',
);
ensureTableColumn(
    'communication_settings',
    'active_chat_message_count',
    'INTEGER NOT NULL DEFAULT 0',
);
ensureTableColumn(
    'communication_settings',
    'active_chat_interval',
    'INTEGER NOT NULL DEFAULT 10',
);
ensureTableColumn(
    'communication_settings',
    'active_chat_target_offset',
    'INTEGER NOT NULL DEFAULT 0',
);
ensureTableColumn(
    'communication_settings',
    'active_chat_last_reply_at',
    'INTEGER NOT NULL DEFAULT 0',
);

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

// V151: сохраняем локальные pre-AI fingerprints, чтобы повторно не гонять
// почти неизменившиеся посты и одинаковые изображения через модели.
ensureTableColumn(
    'telegram_source_posts',
    'text_fingerprint',
    "TEXT NOT NULL DEFAULT ''",
);
ensureTableColumn(
    'telegram_source_posts',
    'image_fingerprints_json',
    "TEXT NOT NULL DEFAULT '[]'",
);

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

function appendIncomingMessageJournalEntry(entry) {
    try {
        appendFileSync(
            liveMessageJournalPath,
            `${JSON.stringify(entry)}\n`,
            { encoding: 'utf8' },
        );
        return true;
    } catch (error) {
        console.error(
            '[LIVE MESSAGE JOURNAL WRITE ERROR]',
            String(error?.message ?? error),
        );
        return false;
    }
}

function replayIncomingMessageJournal() {
    if (!existsSync(liveMessageJournalPath)) return;

    let content = '';
    try {
        content = readFileSync(liveMessageJournalPath, 'utf8');
    } catch (error) {
        console.error(
            '[LIVE MESSAGE JOURNAL READ ERROR]',
            String(error?.message ?? error),
        );
        return;
    }

    if (!content.trim()) return;

    let parsed = 0;
    let replayed = 0;
    let invalid = 0;

    for (const line of content.split(/\r?\n/u)) {
        const clean = line.trim();
        if (!clean) continue;

        let item;
        try {
            item = JSON.parse(clean);
        } catch {
            invalid += 1;
            continue;
        }

        const peerId = Number(item?.peerId);
        const senderId = Number(item?.senderId);
        const conversationMessageId = Number(item?.conversationMessageId);
        const createdAt = Number(item?.createdAt);
        if (
            !Number.isSafeInteger(peerId) ||
            !Number.isSafeInteger(senderId) ||
            !Number.isSafeInteger(conversationMessageId) ||
            !Number.isFinite(createdAt) ||
            createdAt <= 0
        ) {
            invalid += 1;
            continue;
        }

        parsed += 1;
        try {
            insertMessageStatement.run(
                peerId,
                senderId,
                conversationMessageId,
                String(item?.text ?? ''),
                createdAt,
            );
            replayed += 1;
        } catch (error) {
            console.error(
                '[LIVE MESSAGE JOURNAL REPLAY ERROR]',
                String(error?.message ?? error),
            );
            return;
        }
    }

    try {
        // INSERT OR IGNORE makes replay idempotent. Once every valid record has
        // been accepted by SQLite, the crash journal can start fresh.
        writeFileSync(liveMessageJournalPath, '', 'utf8');
    } catch (error) {
        console.warn(
            '[LIVE MESSAGE JOURNAL COMPACT ERROR]',
            String(error?.message ?? error),
        );
    }

    console.log(
        '[LIVE MESSAGE JOURNAL REPLAY]',
        `parsed=${parsed}`,
        `replayed=${replayed}`,
        `invalid=${invalid}`,
    );
}

replayIncomingMessageJournal();

const getVoiceTranscriptStatement = database.prepare(`
    SELECT
        platform,
        attachment_key AS attachmentKey,
        peer_id AS peerId,
        conversation_message_id AS conversationMessageId,
        transcript,
        source,
        model,
        status,
        last_error AS lastError,
        retry_after AS retryAfter,
        updated_at AS updatedAt
    FROM voice_transcripts
    WHERE platform = ? AND attachment_key = ?
    LIMIT 1
`);

const upsertVoiceTranscriptStatement = database.prepare(`
    INSERT INTO voice_transcripts (
        platform,
        attachment_key,
        peer_id,
        conversation_message_id,
        transcript,
        source,
        model,
        status,
        last_error,
        retry_after,
        updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(platform, attachment_key) DO UPDATE SET
        peer_id = excluded.peer_id,
        conversation_message_id = excluded.conversation_message_id,
        transcript = CASE
            WHEN excluded.transcript <> '' THEN excluded.transcript
            ELSE voice_transcripts.transcript
        END,
        source = CASE
            WHEN excluded.source <> '' THEN excluded.source
            ELSE voice_transcripts.source
        END,
        model = CASE
            WHEN excluded.model <> '' THEN excluded.model
            ELSE voice_transcripts.model
        END,
        status = excluded.status,
        last_error = excluded.last_error,
        retry_after = excluded.retry_after,
        updated_at = excluded.updated_at
`);

const insertBotRequestEventStatement = database.prepare(`
    INSERT OR IGNORE INTO bot_request_events (
        platform,
        endpoint_key,
        peer_id,
        user_id,
        external_peer_id,
        external_user_id,
        is_group,
        request_key,
        created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
`);

const botRequestBreakdownStatement = database.prepare(`
    SELECT
        platform,
        endpoint_key,
        is_group,
        COUNT(*) AS request_count,
        COUNT(DISTINCT (
            platform || ':' ||
            CASE
                WHEN external_user_id <> '' THEN external_user_id
                ELSE CAST(user_id AS TEXT)
            END
        )) AS unique_users
    FROM bot_request_events
    WHERE created_at >= ?
      AND created_at < ?
    GROUP BY platform, endpoint_key, is_group
    ORDER BY is_group ASC, platform ASC, endpoint_key ASC
`);

const botRequestTotalsStatement = database.prepare(`
    SELECT
        is_group,
        COUNT(*) AS request_count,
        COUNT(DISTINCT (
            platform || ':' ||
            CASE
                WHEN external_user_id <> '' THEN external_user_id
                ELSE CAST(user_id AS TEXT)
            END
        )) AS unique_users
    FROM bot_request_events
    WHERE created_at >= ?
      AND created_at < ?
    GROUP BY is_group
    ORDER BY is_group ASC
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

const messagesBetweenStatement = database.prepare(`
    SELECT
        peer_id,
        sender_id,
        conversation_message_id,
        text,
        created_at
    FROM messages
    WHERE peer_id = ?
      AND created_at >= ?
      AND created_at < ?
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

const searchStoredMessagesByTextStatement = database.prepare(`
    SELECT
        peer_id,
        sender_id,
        conversation_message_id,
        text,
        created_at
    FROM messages
    WHERE text LIKE ? OR text LIKE ? OR text LIKE ? OR text LIKE ?
    ORDER BY created_at ASC, id ASC
`);

const getAutoSummarySettingsStatement = database.prepare(`
    SELECT
        peer_id, platform, endpoint_key, external_peer_id, mode, enabled,
        next_run_at, updated_by, updated_at
    FROM auto_summary_settings
    WHERE peer_id = ?
`);

const upsertAutoSummarySettingsStatement = database.prepare(`
    INSERT INTO auto_summary_settings (
        peer_id, platform, endpoint_key, external_peer_id, mode, enabled,
        next_run_at, updated_by, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(peer_id) DO UPDATE SET
        platform = excluded.platform,
        endpoint_key = excluded.endpoint_key,
        external_peer_id = excluded.external_peer_id,
        mode = excluded.mode,
        enabled = excluded.enabled,
        next_run_at = excluded.next_run_at,
        updated_by = excluded.updated_by,
        updated_at = excluded.updated_at
`);

const dueAutoSummarySettingsStatement = database.prepare(`
    SELECT
        peer_id, platform, endpoint_key, external_peer_id, mode, enabled,
        next_run_at, updated_by, updated_at
    FROM auto_summary_settings
    WHERE enabled = 1
      AND next_run_at > 0
      AND next_run_at <= ?
    ORDER BY next_run_at ASC, peer_id ASC
`);

const getAutoSummaryRunStatement = database.prepare(`
    SELECT
        peer_id, summary_date, slot_label, scheduled_at, started_at,
        finished_at, message_count, summary_text
    FROM auto_summary_runs
    WHERE peer_id = ?
      AND summary_date = ?
      AND slot_label = ?
`);

const upsertAutoSummaryRunStatement = database.prepare(`
    INSERT INTO auto_summary_runs (
        peer_id, summary_date, slot_label, scheduled_at, started_at,
        finished_at, message_count, summary_text
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(peer_id, summary_date, slot_label) DO UPDATE SET
        scheduled_at = excluded.scheduled_at,
        started_at = excluded.started_at,
        finished_at = excluded.finished_at,
        message_count = excluded.message_count,
        summary_text = excluded.summary_text
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
        active_chat_enabled,
        active_chat_message_count,
        active_chat_interval,
        active_chat_target_offset,
        active_chat_last_reply_at,
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
        active_chat_enabled,
        active_chat_message_count,
        active_chat_interval,
        active_chat_target_offset,
        active_chat_last_reply_at,
        updated_by,
        updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT (peer_id) DO UPDATE SET
        platform = excluded.platform,
        external_peer_id = excluded.external_peer_id,
        is_group = excluded.is_group,
        warmth = excluded.warmth,
        persona = excluded.persona,
        next_outburst_at = excluded.next_outburst_at,
        last_outburst_at = excluded.last_outburst_at,
        last_target_user_id = excluded.last_target_user_id,
        active_chat_enabled = excluded.active_chat_enabled,
        active_chat_message_count = excluded.active_chat_message_count,
        active_chat_interval = excluded.active_chat_interval,
        active_chat_target_offset = excluded.active_chat_target_offset,
        active_chat_last_reply_at = excluded.active_chat_last_reply_at,
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
        active_chat_enabled,
        active_chat_message_count,
        active_chat_interval,
        active_chat_target_offset,
        active_chat_last_reply_at,
        updated_by,
        updated_at
    FROM communication_settings
    WHERE is_group = 1
      AND active_chat_enabled = 1
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

const rescheduleLongCommunicationOutburstsStatement = database.prepare(`
    UPDATE communication_settings
    SET next_outburst_at = ? + ? + ABS(RANDOM() % ?),
        updated_at = ?
    WHERE is_group = 1
      AND active_chat_enabled = 1
      AND persona IN ('bydlo', 'durachila')
      AND next_outburst_at > ? + ?
`);

const clearDisabledCommunicationSchedulesStatement = database.prepare(`
    UPDATE communication_settings
    SET next_outburst_at = 0,
        active_chat_message_count = 0,
        active_chat_target_offset = 0,
        active_chat_last_reply_at = 0,
        updated_at = ?
    WHERE active_chat_enabled = 0
      AND (
        next_outburst_at <> 0 OR
        active_chat_message_count <> 0 OR
        active_chat_target_offset <> 0 OR
        active_chat_last_reply_at <> 0
      )
`);

const clearDisabledCommunicationBanterStatement = database.prepare(`
    DELETE FROM communication_banter_state
    WHERE peer_id IN (
        SELECT peer_id
        FROM communication_settings
        WHERE active_chat_enabled = 0
    )
`);

// V149: старый механизм отдельных грубых outburst-реплик больше не является
// частью активного общения. При обновлении/старте очищаем только его расписания
// и banter-состояния, не трогая enabled/count/interval/target активного режима.
const clearLegacyCommunicationOutburstSchedulesStatement = database.prepare(`
    UPDATE communication_settings
    SET next_outburst_at = 0,
        updated_at = ?
    WHERE next_outburst_at <> 0
`);

const clearAllCommunicationBanterStatement = database.prepare(`
    DELETE FROM communication_banter_state
`);

const updateActiveCommunicationStateStatement = database.prepare(`
    UPDATE communication_settings
    SET active_chat_enabled = ?,
        active_chat_message_count = ?,
        active_chat_interval = ?,
        active_chat_target_offset = ?,
        active_chat_last_reply_at = ?,
        updated_by = ?,
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

const selectCommunicationBanterStateStatement = database.prepare(`
    SELECT
        peer_id,
        target_user_id,
        platform,
        external_peer_id,
        target_external_user_id,
        target_display_name,
        active_until,
        last_attack_at,
        last_reply_at,
        reply_count,
        last_bot_text,
        updated_at
    FROM communication_banter_state
    WHERE peer_id = ? AND target_user_id = ?
    LIMIT 1
`);

const upsertCommunicationBanterStateStatement = database.prepare(`
    INSERT INTO communication_banter_state (
        peer_id,
        target_user_id,
        platform,
        external_peer_id,
        target_external_user_id,
        target_display_name,
        active_until,
        last_attack_at,
        last_reply_at,
        reply_count,
        last_bot_text,
        updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT (peer_id, target_user_id) DO UPDATE SET
        platform = excluded.platform,
        external_peer_id = excluded.external_peer_id,
        target_external_user_id = excluded.target_external_user_id,
        target_display_name = excluded.target_display_name,
        active_until = excluded.active_until,
        last_attack_at = excluded.last_attack_at,
        last_reply_at = excluded.last_reply_at,
        reply_count = excluded.reply_count,
        last_bot_text = excluded.last_bot_text,
        updated_at = excluded.updated_at
`);

const deleteCommunicationBanterStateStatement = database.prepare(`
    DELETE FROM communication_banter_state
    WHERE peer_id = ? AND target_user_id = ?
`);

const deleteCommunicationBanterStatesByPeerStatement = database.prepare(`
    DELETE FROM communication_banter_state
    WHERE peer_id = ?
`);

const insertManualEventStatement = database.prepare(`
    INSERT INTO manual_events (
        title,
        event_date,
        event_time,
        venue,
        participants,
        price,
        description,
        evidence,
        source_url,
        source_text,
        image_paths_json,
        status,
        created_by_platform,
        created_by,
        created_at,
        updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`);

const selectManualUpcomingEventsStatement = database.prepare(`
    SELECT
        id,
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
        status,
        created_by_platform,
        created_by,
        created_at,
        updated_at
    FROM manual_events
    WHERE status IN ('approved', 'pending')
      AND event_date >= ?
      AND NOT EXISTS (
          SELECT 1
          FROM event_dedupe_members AS dm
          WHERE dm.scope = 'configured'
            AND dm.source_type = 'manual'
            AND dm.event_id = manual_events.id
            AND dm.role = 'duplicate'
      )
    ORDER BY event_date ASC,
             COALESCE(event_time, '23:59') ASC,
             id ASC
    LIMIT ?
`);

const upsertQticketsEventStatement = qticketsDatabase.prepare(`
    INSERT INTO qtickets_events (
        external_id,
        detail_url,
        listing_url,
        title,
        event_date,
        event_time,
        event_end_date,
        date_label,
        venue,
        participants,
        price,
        event_type,
        age_restriction,
        description,
        evidence,
        source_text,
        ticket_url,
        image_urls_json,
        image_paths_json,
        status,
        parse_method,
        created_at,
        updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'approved', ?, ?, ?)
    ON CONFLICT(detail_url) DO UPDATE SET
        external_id = excluded.external_id,
        listing_url = excluded.listing_url,
        title = excluded.title,
        event_date = excluded.event_date,
        event_time = excluded.event_time,
        event_end_date = excluded.event_end_date,
        date_label = excluded.date_label,
        venue = excluded.venue,
        participants = excluded.participants,
        price = excluded.price,
        event_type = excluded.event_type,
        age_restriction = excluded.age_restriction,
        description = excluded.description,
        evidence = excluded.evidence,
        source_text = excluded.source_text,
        ticket_url = excluded.ticket_url,
        image_urls_json = excluded.image_urls_json,
        image_paths_json = excluded.image_paths_json,
        status = 'approved',
        parse_method = excluded.parse_method,
        updated_at = excluded.updated_at
`);

const selectQticketsEventIdStatement = qticketsDatabase.prepare(`
    SELECT id
    FROM qtickets_events
    WHERE detail_url = ?
    LIMIT 1
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

const selectCoordsOverrideSettingsStatement = database.prepare(`
    SELECT message_text, enabled, updated_by, updated_at
    FROM coords_override_settings
    WHERE id = 1
    LIMIT 1
`);

const saveCoordsOverrideMessageStatement = database.prepare(`
    INSERT INTO coords_override_settings (
        id,
        message_text,
        enabled,
        updated_by,
        updated_at
    ) VALUES (1, ?, 1, ?, ?)
    ON CONFLICT (id) DO UPDATE SET
        message_text = excluded.message_text,
        enabled = 1,
        updated_by = excluded.updated_by,
        updated_at = excluded.updated_at
`);

const setCoordsOverrideEnabledStatement = database.prepare(`
    UPDATE coords_override_settings
    SET enabled = ?,
        updated_by = ?,
        updated_at = ?
    WHERE id = 1
`);

const deleteCoordsOverrideMessageStatement = database.prepare(`
    UPDATE coords_override_settings
    SET message_text = '',
        enabled = 0,
        updated_by = ?,
        updated_at = ?
    WHERE id = 1
`);

const upsertCoordsRequestRecipientStatement = database.prepare(`
    INSERT INTO coords_request_recipients (
        platform,
        endpoint_key,
        external_user_id,
        external_peer_id,
        external_username,
        first_requested_at,
        last_requested_at,
        request_count
    ) VALUES (?, ?, ?, ?, ?, ?, ?, 1)
    ON CONFLICT (platform, endpoint_key, external_user_id) DO UPDATE SET
        external_peer_id = excluded.external_peer_id,
        external_username = CASE
            WHEN excluded.external_username <> '' THEN excluded.external_username
            ELSE coords_request_recipients.external_username
        END,
        last_requested_at = excluded.last_requested_at,
        request_count = coords_request_recipients.request_count + 1
`);

const selectCoordsRequestRecipientsStatement = database.prepare(`
    SELECT
        id,
        platform,
        endpoint_key,
        external_user_id,
        external_peer_id,
        external_username,
        first_requested_at,
        last_requested_at,
        request_count
    FROM coords_request_recipients
    ORDER BY last_requested_at ASC, id ASC
`);

const clearCoordsRequestRecipientsStatement = database.prepare(`
    DELETE FROM coords_request_recipients
`);

const upsertPostEventFeedbackRequestStatement = database.prepare(`
    INSERT INTO post_event_feedback_requests (
        campaign_key,
        platform,
        endpoint_key,
        external_user_id,
        external_peer_id,
        sent_at,
        awaiting_feedback,
        feedback_received_at
    ) VALUES (?, ?, ?, ?, ?, ?, 1, 0)
    ON CONFLICT (campaign_key, platform, endpoint_key, external_user_id) DO UPDATE SET
        external_peer_id = excluded.external_peer_id,
        sent_at = excluded.sent_at,
        awaiting_feedback = CASE
            WHEN post_event_feedback_requests.feedback_received_at > 0 THEN 0
            ELSE 1
        END
`);

const selectPendingPostEventFeedbackRequestStatement = database.prepare(`
    SELECT
        id,
        campaign_key,
        platform,
        endpoint_key,
        external_user_id,
        external_peer_id,
        sent_at,
        awaiting_feedback,
        feedback_received_at
    FROM post_event_feedback_requests
    WHERE campaign_key = ?
      AND platform = ?
      AND endpoint_key = ?
      AND external_user_id = ?
      AND awaiting_feedback = 1
    LIMIT 1
`);

const insertPostEventFeedbackReviewStatement = database.prepare(`
    INSERT OR IGNORE INTO post_event_feedback_reviews (
        campaign_key,
        platform,
        endpoint_key,
        external_user_id,
        external_peer_id,
        review_text,
        received_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?)
`);

const selectPostEventFeedbackReviewIdStatement = database.prepare(`
    SELECT id
    FROM post_event_feedback_reviews
    WHERE campaign_key = ?
      AND platform = ?
      AND endpoint_key = ?
      AND external_user_id = ?
    LIMIT 1
`);

const consumePostEventFeedbackRequestStatement = database.prepare(`
    UPDATE post_event_feedback_requests
    SET awaiting_feedback = 0,
        feedback_received_at = ?
    WHERE campaign_key = ?
      AND platform = ?
      AND endpoint_key = ?
      AND external_user_id = ?
      AND awaiting_feedback = 1
`);

const cancelPostEventFeedbackRequestStatement = database.prepare(`
    UPDATE post_event_feedback_requests
    SET awaiting_feedback = 0
    WHERE campaign_key = ?
      AND platform = ?
      AND endpoint_key = ?
      AND external_user_id = ?
      AND awaiting_feedback = 1
`);

const selectPostEventFeedbackReviewsStatement = database.prepare(`
    SELECT
        id,
        campaign_key,
        platform,
        endpoint_key,
        external_user_id,
        external_peer_id,
        review_text,
        received_at
    FROM post_event_feedback_reviews
    WHERE campaign_key = ?
    ORDER BY received_at ASC, id ASC
`);

const selectPostEventFeedbackStatsStatement = database.prepare(`
    SELECT
        COUNT(*) AS sent,
        COALESCE(SUM(CASE WHEN awaiting_feedback = 1 THEN 1 ELSE 0 END), 0) AS awaiting
    FROM post_event_feedback_requests
    WHERE campaign_key = ?
`);

const countPostEventFeedbackReviewsStatement = database.prepare(`
    SELECT COUNT(*) AS reviews
    FROM post_event_feedback_reviews
    WHERE campaign_key = ?
`);

const selectQrCodeSettingsStatement = database.prepare(`
    SELECT message_text, image_path, updated_by, updated_at
    FROM qr_code_settings
    WHERE id = 1
    LIMIT 1
`);

const updateQrCodeSettingsStatement = database.prepare(`
    UPDATE qr_code_settings
    SET message_text = COALESCE(?, message_text),
        image_path = COALESCE(?, image_path),
        updated_by = ?,
        updated_at = ?
    WHERE id = 1
`);


const selectTelegramPostMetaStatement = database.prepare(`
    SELECT
        content_hash,
        published_at,
        raw_text,
        text_fingerprint,
        image_fingerprints_json,
        image_paths_json,
        (
            SELECT COUNT(*)
            FROM telegram_events
            WHERE telegram_events.channel = telegram_source_posts.channel
              AND telegram_events.message_id = telegram_source_posts.message_id
        ) AS event_count,
        (
            SELECT COUNT(*)
            FROM telegram_events
            WHERE telegram_events.channel = telegram_source_posts.channel
              AND telegram_events.message_id = telegram_source_posts.message_id
              AND COALESCE(NULLIF(TRIM(telegram_events.image_paths_json), ''), '[]') = '[]'
        ) AS events_without_images
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
        text_fingerprint,
        image_fingerprints_json,
        parse_status,
        fetched_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT (channel, message_id) DO UPDATE SET
        source_url = excluded.source_url,
        published_at = excluded.published_at,
        raw_text = excluded.raw_text,
        image_urls_json = excluded.image_urls_json,
        image_paths_json = excluded.image_paths_json,
        content_hash = excluded.content_hash,
        text_fingerprint = excluded.text_fingerprint,
        image_fingerprints_json = excluded.image_fingerprints_json,
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
        e.id,
        e.channel,
        e.message_id,
        e.title,
        e.event_date,
        e.event_time,
        e.venue,
        e.participants,
        e.price,
        e.description,
        e.source_url,
        e.image_paths_json,
        e.parse_method,
        e.status,
        p.published_at,
        p.raw_text
    FROM telegram_events AS e
    INNER JOIN telegram_source_posts AS p
        ON p.channel = e.channel
       AND p.message_id = e.message_id
    WHERE e.channel = ?
      AND e.status IN ('approved', 'pending')
      AND e.event_date >= ?
      AND NOT EXISTS (
          SELECT 1
          FROM event_dedupe_members AS dm
          WHERE dm.scope = 'configured'
            AND dm.source_type = 'telegram'
            AND dm.event_id = e.id
            AND dm.role = 'duplicate'
      )
    ORDER BY e.event_date ASC,
             COALESCE(e.event_time, '23:59') ASC,
             e.id ASC
    LIMIT ?
`);

const PARTY_2026_08_22_ANNOUNCEMENT =
    'Ближайшая туса — «Случайное Пересоздание», 22 августа.\n\n' +
    'https://vk.ru/peresosdanie\n\n' +
    'Гиг пройдёт в черте города, на открытом воздухе. Вход бесплатный. ' +
    'Если всё понравится и будет возможность поддержать организатора — будем очень благодарны.\n\n' +
    'Координаты откроются 22 августа с 12:00 до 24:00 по московскому времени. ' +
    'В это время напиши «координаты» или «корды».\n\n' +
    'Если нужны не только наши тусы, а вся афиша, напиши: «ближайшие тусы», ' +
    '«тусы на этих выходных», «тусы на этой неделе», «тусы на месяц», ' +
    '«тусы 22 августа», «тусы в августе» или «все тусы».';

const COORDS_2026_08_22_FULL_MESSAGE =
    '51.691730, 39.251385\n\n' +
    '⚡🖤 Вход бесплатный. Если всё понравится, кайфанёте и будет возможность — любой донат будет очень кстати. ' +
    'Всё исключительно добровольно: такие тусы требуют заметных расходов, а ваша поддержка помогает их покрывать и делать всё это дальше. 🖤⚡\n' +
    'Поддержать можно переводом по номеру телефона +79968257889 (Сбер).\n\n' +
    '🚨🚨🚨 ПРАВИЛА ПОВЕДЕНИЯ И НАХОЖДЕНИЯ НА МЕРОПРИЯТИИ 🚨🚨🚨\n\n' +
    '⛔⚠ На сцену не лезть.\n' +
    '⛔⚠ Оборудование, служебные конструкции и элементы декора не трогать. Не плевать в их сторону.\n' +
    '🚫📦 Любые предметы на территории — коробки, упаковки, доски, инструменты, расходники и прочее — без разрешения организаторов не брать и не перемещать.\n' +
    '🥊❌ Конфликты и драки на территории мероприятия запрещены. Если хотите выяснить отношения — делайте это за пределами мероприятия.\n' +
    '🗑🚫 Мусор не разбрасывать — складывать только в мусорные мешки.\n' +
    '🖤⚠ Уважайте организаторов, артистов и других участников мероприятия. ⚠🖤\n\n' +
    'Начало в 17:00. Можно приехать раньше — позагорать или, если есть желание, помочь с подготовкой. ' +
    'Если время начала изменится, актуальную информацию опубликуем в группе:\n' +
    'https://vk.ru/peresosdanie';

const PARTY_DATE_ANSWER = PARTY_2026_08_22_ANNOUNCEMENT;
const PARTY_FORMAT_ANSWER = PARTY_2026_08_22_ANNOUNCEMENT;
const PARTY_INFO_ANSWER = PARTY_2026_08_22_ANNOUNCEMENT;

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

/*
 * V99: применяем новый анонс и координаты к уже существующей bot.sqlite
 * ровно один раз. После этого owner-команды могут менять/отключать/удалять
 * координаты, и последующие перезапуски не вернут хардкод.
 */
const v99PartyCoordsMigrationKey = 'events-v99-party-and-coords-2026-08-22';
const v99PartyCoordsMigration = database.prepare(`
    SELECT migration_key
    FROM bot_code_migrations
    WHERE migration_key = ?
    LIMIT 1
`).get(v99PartyCoordsMigrationKey);

if (!v99PartyCoordsMigration) {
    const appliedAt = Math.floor(Date.now() / 1000);

    database.prepare(`
        UPDATE dm_party_faq
        SET answer = ?,
            enabled = 1,
            updated_at = ?
        WHERE intent IN ('party_date', 'party_format', 'party_info')
    `).run(PARTY_2026_08_22_ANNOUNCEMENT, appliedAt);

    database.prepare(`
        UPDATE dm_faq_answers
        SET answer = ?,
            enabled = 1,
            updated_at = ?
        WHERE topic IN ('party_date', 'party_format', 'party_info')
    `).run(PARTY_2026_08_22_ANNOUNCEMENT, appliedAt);

    saveCoordsOverrideMessageStatement.run(
        '51.691730, 39.251385',
        755496806,
        appliedAt,
    );

    database.prepare(`
        INSERT INTO bot_code_migrations (migration_key, applied_at)
        VALUES (?, ?)
    `).run(v99PartyCoordsMigrationKey, appliedAt);
}


/*
 * V100: обновляем уже существующие V99-базы новым единым анонсом.
 * Координаты здесь не трогаем: owner мог уже заменить их вручную.
 */
const v100NearestPartyMigrationKey = 'events-v100-nearest-party-announcement';
const v100NearestPartyMigration = database.prepare(`
    SELECT migration_key
    FROM bot_code_migrations
    WHERE migration_key = ?
    LIMIT 1
`).get(v100NearestPartyMigrationKey);

if (!v100NearestPartyMigration) {
    const appliedAt = Math.floor(Date.now() / 1000);

    database.prepare(`
        UPDATE dm_party_faq
        SET answer = ?,
            enabled = 1,
            updated_at = ?
        WHERE intent IN ('party_date', 'party_format', 'party_info')
    `).run(PARTY_2026_08_22_ANNOUNCEMENT, appliedAt);

    database.prepare(`
        UPDATE dm_faq_answers
        SET answer = ?,
            enabled = 1,
            updated_at = ?
        WHERE topic IN ('party_date', 'party_format', 'party_info')
    `).run(PARTY_2026_08_22_ANNOUNCEMENT, appliedAt);

    database.prepare(`
        INSERT INTO bot_code_migrations (migration_key, applied_at)
        VALUES (?, ?)
    `).run(v100NearestPartyMigrationKey, appliedAt);
}


/*
 * V101: по прямому запросу владельца обновляем дословный ответ «корды»
 * одним сообщением: координаты + добровольный донат + правила + время старта.
 * Миграция одноразовая: дальнейшая команда `корды сообщение` снова полностью
 * принадлежит owner и не перезаписывается на следующих рестартах.
 */
const v101CoordsFullMessageMigrationKey = 'events-v101-coords-full-event-message';
const v101CoordsFullMessageMigration = database.prepare(`
    SELECT migration_key
    FROM bot_code_migrations
    WHERE migration_key = ?
    LIMIT 1
`).get(v101CoordsFullMessageMigrationKey);

if (!v101CoordsFullMessageMigration) {
    const appliedAt = Math.floor(Date.now() / 1000);

    saveCoordsOverrideMessageStatement.run(
        COORDS_2026_08_22_FULL_MESSAGE,
        755496806,
        appliedAt,
    );

    database.prepare(`
        INSERT INTO bot_code_migrations (migration_key, applied_at)
        VALUES (?, ?)
    `).run(v101CoordsFullMessageMigrationKey, appliedAt);
}


/*
 * V102: добавляем реквизиты Сбера в полный ответ «корды».
 * Одноразово обновляем уже существующие V101-базы; после применения owner снова
 * может заменить сообщение через `корды сообщение`, и рестарт его не откатит.
 */
const v102CoordsSberDonationMigrationKey = 'events-v102-coords-sber-donation';
const v102CoordsSberDonationMigration = database.prepare(`
    SELECT migration_key
    FROM bot_code_migrations
    WHERE migration_key = ?
    LIMIT 1
`).get(v102CoordsSberDonationMigrationKey);

if (!v102CoordsSberDonationMigration) {
    const appliedAt = Math.floor(Date.now() / 1000);

    saveCoordsOverrideMessageStatement.run(
        COORDS_2026_08_22_FULL_MESSAGE,
        755496806,
        appliedAt,
    );

    database.prepare(`
        INSERT INTO bot_code_migrations (migration_key, applied_at)
        VALUES (?, ?)
    `).run(v102CoordsSberDonationMigrationKey, appliedAt);
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

    const seenAnswers = new Set();

    return unique
        .map((intent) =>
            selectDmPartyFaqAnswerStatement.get(intent),
        )
        .map((row) => String(row?.answer ?? '').trim())
        .filter((answer) => {
            if (!answer || seenAnswers.has(answer)) {
                return false;
            }

            seenAnswers.add(answer);
            return true;
        });
}

/**
 * Глобальная настройка дословного ответа «корды».
 * Текст не привязан к peer_id: владелец задаёт один ответ на всё окно.
 */
export function getCoordsOverrideSettings() {
    const row = selectCoordsOverrideSettingsStatement.get();

    return {
        messageText: String(row?.message_text ?? ''),
        enabled: Boolean(row?.enabled),
        updatedBy: Number(row?.updated_by ?? 0),
        updatedAt: Number(row?.updated_at ?? 0),
    };
}

export function saveCoordsOverrideMessage({
    messageText,
    updatedBy = 0,
    updatedAt = Math.floor(Date.now() / 1000),
}) {
    const text = String(messageText ?? '');

    saveCoordsOverrideMessageStatement.run(
        text,
        Number(updatedBy ?? 0),
        Number(updatedAt),
    );

    return getCoordsOverrideSettings();
}

export function setCoordsOverrideEnabled({
    enabled,
    updatedBy = 0,
    updatedAt = Math.floor(Date.now() / 1000),
}) {
    setCoordsOverrideEnabledStatement.run(
        enabled ? 1 : 0,
        Number(updatedBy ?? 0),
        Number(updatedAt),
    );

    return getCoordsOverrideSettings();
}

export function deleteCoordsOverrideMessage({
    updatedBy = 0,
    updatedAt = Math.floor(Date.now() / 1000),
} = {}) {
    deleteCoordsOverrideMessageStatement.run(
        Number(updatedBy ?? 0),
        Number(updatedAt),
    );

    return getCoordsOverrideSettings();
}

/**
 * Настройки публичного QR-кода. messageText/imagePath можно обновлять независимо:
 * null означает «оставить текущее значение».
 */
export function getQrCodeSettings() {
    const row = selectQrCodeSettingsStatement.get();

    return {
        messageText: String(row?.message_text ?? '89968257889 Сбер Игорь Анатольевич.'),
        imagePath: String(row?.image_path ?? ''),
        updatedBy: Number(row?.updated_by ?? 0),
        updatedAt: Number(row?.updated_at ?? 0),
    };
}

export function updateQrCodeSettings({
    messageText = null,
    imagePath = null,
    updatedBy = 0,
    updatedAt = Math.floor(Date.now() / 1000),
} = {}) {
    const nextMessage = messageText === null
        ? null
        : String(messageText ?? '').trim();
    const nextImagePath = imagePath === null
        ? null
        : String(imagePath ?? '').trim();

    updateQrCodeSettingsStatement.run(
        nextMessage,
        nextImagePath,
        Number(updatedBy ?? 0),
        Number(updatedAt),
    );

    return getQrCodeSettings();
}

export function recordCoordsRequestRecipient({
    platform,
    endpointKey,
    externalUserId,
    externalPeerId,
    externalUsername = '',
    requestedAt = Math.floor(Date.now() / 1000),
}) {
    const safePlatform = String(platform ?? '').trim().toLowerCase();
    const safeEndpointKey = String(endpointKey ?? '').trim();
    const safeExternalUserId = String(externalUserId ?? '').trim();
    const safeExternalPeerId = String(externalPeerId ?? '').trim();
    const safeExternalUsername = String(externalUsername ?? '').trim().replace(/^@+/u, '');
    const safeRequestedAt = Number(requestedAt) || Math.floor(Date.now() / 1000);

    if (!['vk', 'telegram'].includes(safePlatform)) {
        throw new Error(`Unsupported coords recipient platform: ${safePlatform}`);
    }

    if (!safeEndpointKey || !safeExternalUserId || !safeExternalPeerId) {
        throw new Error('coords recipient requires endpointKey, externalUserId and externalPeerId');
    }

    upsertCoordsRequestRecipientStatement.run(
        safePlatform,
        safeEndpointKey,
        safeExternalUserId,
        safeExternalPeerId,
        safeExternalUsername,
        safeRequestedAt,
        safeRequestedAt,
    );
}

export function getCoordsRequestRecipients() {
    return selectCoordsRequestRecipientsStatement.all().map((row) => ({
        id: Number(row.id),
        platform: String(row.platform ?? ''),
        endpointKey: String(row.endpoint_key ?? ''),
        externalUserId: String(row.external_user_id ?? ''),
        externalPeerId: String(row.external_peer_id ?? ''),
        externalUsername: String(row.external_username ?? ''),
        firstRequestedAt: Number(row.first_requested_at ?? 0),
        lastRequestedAt: Number(row.last_requested_at ?? 0),
        requestCount: Number(row.request_count ?? 0),
    }));
}

export function clearCoordsRequestRecipients() {
    return Number(clearCoordsRequestRecipientsStatement.run().changes ?? 0);
}

function normalizePostEventFeedbackRecipient({
    campaignKey,
    platform,
    endpointKey,
    externalUserId,
    externalPeerId = '',
} = {}) {
    const normalized = {
        campaignKey: String(campaignKey ?? '').trim(),
        platform: String(platform ?? '').trim().toLowerCase(),
        endpointKey: String(endpointKey ?? '').trim(),
        externalUserId: String(externalUserId ?? '').trim(),
        externalPeerId: String(externalPeerId ?? '').trim(),
    };

    if (!normalized.campaignKey) {
        throw new Error('post-event feedback requires campaignKey');
    }
    if (!['vk', 'telegram'].includes(normalized.platform)) {
        throw new Error(`Unsupported post-event feedback platform: ${normalized.platform}`);
    }
    if (!normalized.endpointKey || !normalized.externalUserId) {
        throw new Error('post-event feedback requires endpointKey and externalUserId');
    }

    return normalized;
}

function mapPostEventFeedbackRequestRow(row) {
    if (!row) return null;
    return {
        id: Number(row.id),
        campaignKey: String(row.campaign_key ?? ''),
        platform: String(row.platform ?? ''),
        endpointKey: String(row.endpoint_key ?? ''),
        externalUserId: String(row.external_user_id ?? ''),
        externalPeerId: String(row.external_peer_id ?? ''),
        sentAt: Number(row.sent_at ?? 0),
        awaitingFeedback: Boolean(row.awaiting_feedback),
        feedbackReceivedAt: Number(row.feedback_received_at ?? 0),
    };
}

export function armPostEventFeedbackRecipients({
    campaignKey,
    recipients = [],
    sentAt = Math.floor(Date.now() / 1000),
} = {}) {
    const safeCampaignKey = String(campaignKey ?? '').trim();
    if (!safeCampaignKey) {
        throw new Error('post-event feedback requires campaignKey');
    }

    const safeSentAt = Number(sentAt) || Math.floor(Date.now() / 1000);
    let armed = 0;

    database.exec('BEGIN IMMEDIATE');
    try {
        for (const recipient of Array.isArray(recipients) ? recipients : []) {
            const normalized = normalizePostEventFeedbackRecipient({
                campaignKey: safeCampaignKey,
                ...recipient,
            });
            if (!normalized.externalPeerId) continue;

            upsertPostEventFeedbackRequestStatement.run(
                normalized.campaignKey,
                normalized.platform,
                normalized.endpointKey,
                normalized.externalUserId,
                normalized.externalPeerId,
                safeSentAt,
            );
            armed += 1;
        }
        database.exec('COMMIT');
    } catch (error) {
        database.exec('ROLLBACK');
        throw error;
    }
    return armed;
}

export function getPendingPostEventFeedbackRequest(recipient = {}) {
    const normalized = normalizePostEventFeedbackRecipient(recipient);
    const row = selectPendingPostEventFeedbackRequestStatement.get(
        normalized.campaignKey,
        normalized.platform,
        normalized.endpointKey,
        normalized.externalUserId,
    );
    return mapPostEventFeedbackRequestRow(row);
}

export function cancelPostEventFeedbackRequest(recipient = {}) {
    const normalized = normalizePostEventFeedbackRecipient(recipient);
    const result = cancelPostEventFeedbackRequestStatement.run(
        normalized.campaignKey,
        normalized.platform,
        normalized.endpointKey,
        normalized.externalUserId,
    );
    return Number(result?.changes ?? 0) > 0;
}

export function savePostEventFeedbackReview({
    campaignKey,
    platform,
    endpointKey,
    externalUserId,
    externalPeerId = '',
    reviewText,
    receivedAt = Math.floor(Date.now() / 1000),
} = {}) {
    const normalized = normalizePostEventFeedbackRecipient({
        campaignKey,
        platform,
        endpointKey,
        externalUserId,
        externalPeerId,
    });
    const safeReviewText = String(reviewText ?? '').trim();
    if (!safeReviewText) return 0;

    const safeReceivedAt = Number(receivedAt) || Math.floor(Date.now() / 1000);
    let reviewId = 0;

    database.exec('BEGIN IMMEDIATE');
    try {
        const pending = selectPendingPostEventFeedbackRequestStatement.get(
            normalized.campaignKey,
            normalized.platform,
            normalized.endpointKey,
            normalized.externalUserId,
        );
        if (!pending) {
            database.exec('COMMIT');
            return 0;
        }

        const peerId = normalized.externalPeerId || String(pending.external_peer_id ?? '');
        insertPostEventFeedbackReviewStatement.run(
            normalized.campaignKey,
            normalized.platform,
            normalized.endpointKey,
            normalized.externalUserId,
            peerId,
            safeReviewText,
            safeReceivedAt,
        );

        const stored = selectPostEventFeedbackReviewIdStatement.get(
            normalized.campaignKey,
            normalized.platform,
            normalized.endpointKey,
            normalized.externalUserId,
        );
        reviewId = Number(stored?.id ?? 0);

        if (reviewId > 0) {
            consumePostEventFeedbackRequestStatement.run(
                safeReceivedAt,
                normalized.campaignKey,
                normalized.platform,
                normalized.endpointKey,
                normalized.externalUserId,
            );
        }
        database.exec('COMMIT');
    } catch (error) {
        database.exec('ROLLBACK');
        throw error;
    }
    return reviewId;
}

export function getPostEventFeedbackReviews({ campaignKey } = {}) {
    const safeCampaignKey = String(campaignKey ?? '').trim();
    if (!safeCampaignKey) return [];

    return selectPostEventFeedbackReviewsStatement.all(safeCampaignKey).map((row) => ({
        id: Number(row.id),
        campaignKey: String(row.campaign_key ?? ''),
        platform: String(row.platform ?? ''),
        endpointKey: String(row.endpoint_key ?? ''),
        externalUserId: String(row.external_user_id ?? ''),
        externalPeerId: String(row.external_peer_id ?? ''),
        reviewText: String(row.review_text ?? ''),
        receivedAt: Number(row.received_at ?? 0),
    }));
}

export function getPostEventFeedbackStats({ campaignKey } = {}) {
    const safeCampaignKey = String(campaignKey ?? '').trim();
    if (!safeCampaignKey) {
        return { sent: 0, awaiting: 0, reviews: 0 };
    }

    const requestStats = selectPostEventFeedbackStatsStatement.get(safeCampaignKey) || {};
    const reviewStats = countPostEventFeedbackReviewsStatement.get(safeCampaignKey) || {};
    return {
        sent: Number(requestStats.sent ?? 0),
        awaiting: Number(requestStats.awaiting ?? 0),
        reviews: Number(reviewStats.reviews ?? 0),
    };
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
        publishedAt: Number(row.published_at ?? 0),
        rawText: String(row.raw_text ?? ''),
        textFingerprint: String(row.text_fingerprint ?? ''),
        imageFingerprintsJson: String(row.image_fingerprints_json ?? '[]'),
        imagePathsJson: String(row.image_paths_json ?? '[]'),
        eventCount: Number(row.event_count ?? 0),
        eventsWithoutImages: Number(row.events_without_images ?? 0),
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
    textFingerprint = '',
    imageFingerprints = [],
    imageVisionFacts = [],
    imageVisionStatuses = [],
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
        String(textFingerprint ?? '').trim(),
        JSON.stringify(Array.isArray(imageFingerprints) ? imageFingerprints.slice(0, 16) : []),
        String(parseStatus ?? 'pending').trim(),
        Number(fetchedAt),
    );
    database.prepare(`
        UPDATE telegram_source_posts SET image_vision_facts_json = ?, image_vision_status_json = ?
        WHERE channel = ? AND message_id = ?
    `).run(
        JSON.stringify(Array.isArray(imageVisionFacts) ? imageVisionFacts : []),
        JSON.stringify(Array.isArray(imageVisionStatuses) && imageVisionStatuses.length ? imageVisionStatuses : deriveImageVisionStatuses(imageVisionFacts, imageUrls)),
        String(channel ?? '').trim(),
        Number(messageId),
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
    const incomingEvents = Array.isArray(events) ? events : [];
    const storedRows = database.prepare(`
        SELECT * FROM telegram_events WHERE channel = ? AND message_id = ? ORDER BY event_index ASC, id ASC
    `).all(safeChannel, safeMessageId);
    let safeEvents = incomingEvents.map((event, index) => mergeIncomingEventWithStoredRow(
        event,
        selectStoredEventForIncoming(storedRows, event, index),
    ));
    const sourceMeta = database.prepare(`
        SELECT image_urls_json, source_url, image_vision_facts_json, raw_text FROM telegram_source_posts
        WHERE channel = ? AND message_id = ? LIMIT 1
    `).get(safeChannel, safeMessageId);
    const sourceUrls = safeStoredJsonArray(sourceMeta?.image_urls_json);
    safeEvents = applyCurrentSourceSafePosterBindings(safeEvents, imagePaths, sourceUrls, {
        sourceKind: 'telegram',
        canonicalPostUrl: String(sourceMeta?.source_url || sourceUrl || ''),
        sourceVisionFacts: parseStoredPosterFacts(sourceMeta?.image_vision_facts_json),
    });
    safeEvents = filterPermanentlyBlockedIncomingEvents(safeEvents, {
        sourceType: 'telegram',
        sourceUrl: String(sourceMeta?.source_url || sourceUrl || ''),
        canonicalPostUrl: String(sourceMeta?.source_url || sourceUrl || ''),
        sourceItemId: `${safeChannel}:${safeMessageId}`,
        sourceText: String(sourceMeta?.raw_text || ''),
        posterVisionFacts: parseStoredPosterFacts(sourceMeta?.image_vision_facts_json),
    }).events;
    const imagePathsJson = JSON.stringify(safeJsonArray(imagePaths));

    const ownsTransaction = !database.isTransaction;
    if (ownsTransaction) database.exec('BEGIN IMMEDIATE');

    try {
        deleteTelegramEventsForPostStatement.run(
            safeChannel,
            safeMessageId,
        );

        safeEvents.forEach((event, index) => {
            const eventImagePathsJson = JSON.stringify(
                safeJsonArray(event?.imagePaths ?? imagePaths),
            );
            const insertResult = insertTelegramEventStatement.run(
                safeChannel,
                safeMessageId,
                index,
                String(event?.title ?? '').trim(),
                String(event?.eventDate ?? '').trim(),
                event?.eventTime
                    ? String(event.eventTime).trim()
                    : null,
                normalizedPersistedVenue(event?.venue),
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
            writeEventV18867Metadata('telegram_events', Number(insertResult.lastInsertRowid || 0), event, {
                canonicalPostUrl: String(event?.canonicalPostUrl || sourceUrl || '').trim(),
                sourceType: 'telegram',
                sourceMessageId: safeMessageId,
                sourceItemId: `${safeChannel}:${safeMessageId}`,
                sourceOriginalUrl: String(sourceUrl || '').trim(),
                canonicalOrigin: 'telegram-post',
                venue: event?.venue,
            });
        });

        if (ownsTransaction) database.exec('COMMIT');
    } catch (error) {
        if (ownsTransaction) database.exec('ROLLBACK');
        throw error;
    }
}

// The source row and its event replacement are one SQLite unit of work.
// Pass ledger metadata from a processing worker to commit its final state
// in the same unit; callers not using ledger retain the existing API.
export function persistTelegramSourceAndEvents({ source, replacement = null, ledger = null }) {
    const ownsTransaction = !database.isTransaction;
    if (ownsTransaction) database.exec('BEGIN IMMEDIATE');
    try {
        upsertTelegramSourcePost(source);
        if (replacement) replaceTelegramEventsForPost(replacement);
        if (ledger) {
            const count = finalizeManualParserSeenItem(ledger);
            if (count !== 1) throw new Error('Telegram ledger row missing during source/event commit');
        }
        if (ownsTransaction) database.exec('COMMIT');
    } catch (error) {
        if (ownsTransaction) database.exec('ROLLBACK');
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
    const safeLimit = Math.min(2000, Math.max(1, Number(limit) || 10));
    const scanLimit = Math.min(5000, Math.max(200, safeLimit * 4));

    return selectTelegramUpcomingEventsStatement
        .all(
            String(channel ?? '').trim(),
            String(fromDate ?? currentIsoDate()),
            scanLimit,
        )
        .filter((row) => isEventDateConsistentWithSource({
            eventDate: row.event_date,
            sourceText: row.raw_text,
            publishedAt: row.published_at,
        }))
        .slice(0, safeLimit)
        .map((row) => ({
            id: Number(row.id),
            sourceType: 'telegram',
            sourceName: `@${String(row.channel ?? '')}`,
            ...readEventV18867MetadataForType('telegram', row.id),
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
    durableJournal = true,
}) {
    const numericPeerId = Number(peerId);
    const numericSenderId = Number(senderId);
    const numericCreatedAt = Number(createdAt);
    const safeConversationMessageId =
        Number.isSafeInteger(Number(conversationMessageId))
            ? Number(conversationMessageId)
            : numericCreatedAt * 100000 + Math.floor(Math.random() * 100000);
    const safeText = String(text ?? '');

    // Live Long Poll persistence is deliberately independent from every
    // recovery strategy. The append happens BEFORE SQLite so a database error,
    // WAL corruption or process crash cannot silently lose a newly received
    // message. Recovery/backfill callers opt out with durableJournal=false.
    if (durableJournal) {
        appendIncomingMessageJournalEntry({
            peerId: numericPeerId,
            senderId: numericSenderId,
            conversationMessageId: safeConversationMessageId,
            text: safeText,
            createdAt: numericCreatedAt,
        });
    }

    return insertMessageStatement.run(
        numericPeerId,
        numericSenderId,
        safeConversationMessageId,
        safeText,
        numericCreatedAt,
    );
}

export function getVoiceTranscriptCache({ platform, attachmentKey }) {
    const cleanPlatform = String(platform ?? '').trim().toLowerCase();
    const cleanAttachmentKey = String(attachmentKey ?? '').trim();
    if (!cleanPlatform || !cleanAttachmentKey) return null;
    return getVoiceTranscriptStatement.get(cleanPlatform, cleanAttachmentKey) ?? null;
}

export function saveVoiceTranscriptCache({
    platform,
    attachmentKey,
    peerId = 0,
    conversationMessageId = 0,
    transcript = '',
    source = '',
    model = '',
    status = 'ok',
    lastError = '',
    retryAfter = 0,
    updatedAt = Math.floor(Date.now() / 1000),
}) {
    const cleanPlatform = String(platform ?? '').trim().toLowerCase();
    const cleanAttachmentKey = String(attachmentKey ?? '').trim();
    if (!cleanPlatform || !cleanAttachmentKey) return false;

    upsertVoiceTranscriptStatement.run(
        cleanPlatform,
        cleanAttachmentKey,
        Number(peerId) || 0,
        Number(conversationMessageId) || 0,
        String(transcript ?? '').trim(),
        String(source ?? '').trim(),
        String(model ?? '').trim(),
        status === 'error' ? 'error' : 'ok',
        String(lastError ?? '').slice(0, 1000),
        Number(retryAfter) || 0,
        Number(updatedAt) || Math.floor(Date.now() / 1000),
    );
    return true;
}

export function recordBotRequestEvent({
    platform,
    endpointKey = '',
    peerId,
    userId,
    externalPeerId = '',
    externalUserId = '',
    isGroup = false,
    requestKey,
    createdAt = Math.floor(Date.now() / 1000),
}) {
    const safePlatform = String(platform ?? '').trim().toLowerCase();
    const safeEndpointKey = String(endpointKey ?? '').trim();
    const safeRequestKey = String(requestKey ?? '').trim();
    if (!safePlatform || !safeRequestKey) return false;

    const result = insertBotRequestEventStatement.run(
        safePlatform,
        safeEndpointKey,
        Number(peerId) || 0,
        Number(userId) || 0,
        String(externalPeerId ?? '').trim(),
        String(externalUserId ?? '').trim(),
        isGroup ? 1 : 0,
        safeRequestKey,
        Number(createdAt) || Math.floor(Date.now() / 1000),
    );

    return Number(result?.changes ?? 0) > 0;
}

export function getBotRequestStats({
    startTimestamp,
    endTimestamp,
} = {}) {
    const start = Number(startTimestamp) || 0;
    const end = Number(endTimestamp) || Math.floor(Date.now() / 1000) + 1;

    const breakdown = botRequestBreakdownStatement
        .all(start, end)
        .map((row) => ({
            platform: String(row.platform ?? ''),
            endpointKey: String(row.endpoint_key ?? ''),
            isGroup: Number(row.is_group ?? 0) === 1,
            requestCount: Number(row.request_count ?? 0),
            uniqueUsers: Number(row.unique_users ?? 0),
        }));

    const totals = {
        direct: { requestCount: 0, uniqueUsers: 0 },
        group: { requestCount: 0, uniqueUsers: 0 },
    };
    for (const row of botRequestTotalsStatement.all(start, end)) {
        const bucket = Number(row.is_group ?? 0) === 1 ? totals.group : totals.direct;
        bucket.requestCount = Number(row.request_count ?? 0);
        bucket.uniqueUsers = Number(row.unique_users ?? 0);
    }

    return {
        startTimestamp: start,
        endTimestamp: end,
        totals,
        breakdown,
    };
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

export function getMessagesBetween(peerId, startTimestamp, endTimestamp, limit = 20000) {
    return messagesBetweenStatement
        .all(
            Number(peerId),
            Number(startTimestamp),
            Number(endTimestamp),
            Number(limit),
        )
        .map(mapMessage);
}

function mapAutoSummarySettings(row) {
    if (!row) return null;
    return {
        peerId: Number(row.peer_id),
        platform: String(row.platform || 'vk'),
        endpointKey: String(row.endpoint_key || (row.platform === 'telegram' ? 'telegram' : 'vk:primary')),
        externalPeerId: String(row.external_peer_id || ''),
        mode: String(row.mode || 'full'),
        schedule: [],
        enabled: Boolean(row.enabled),
        nextRunAt: Number(row.next_run_at || 0),
        updatedBy: Number(row.updated_by || 0),
        updatedAt: Number(row.updated_at || 0),
    };
}

export function getAutoSummarySettings(peerId) {
    return autoSummaryStateStore.getSettings(peerId);
}

export function saveAutoSummarySettings({
    peerId,
    platform = 'vk',
    endpointKey = 'vk:primary',
    externalPeerId = '',
    mode = 'full',
    schedule = [],
    enabled = true,
    nextRunAt = 0,
    updatedBy = 0,
    updatedAt = Math.floor(Date.now() / 1000),
}) {
    const payload = {
        peerId,
        platform,
        endpointKey,
        externalPeerId,
        mode,
        schedule,
        enabled,
        nextRunAt,
        updatedBy,
        updatedAt,
    };

    // Source of truth: durable DB outside the release directory.
    const saved = autoSummaryStateStore.saveSettings(payload);

    // Mirror into legacy bot.sqlite so a rollback to V154 does not immediately
    // forget a setting changed while V155 was running.
    try {
        upsertAutoSummarySettingsStatement.run(
            Number(peerId),
            String(platform || 'vk'),
            String(endpointKey || (platform === 'telegram' ? 'telegram' : 'vk:primary')),
            String(externalPeerId || ''),
            String(mode || 'full'),
            enabled ? 1 : 0,
            Number(nextRunAt) || 0,
            Number(updatedBy) || 0,
            Number(updatedAt) || Math.floor(Date.now() / 1000),
        );
    } catch (error) {
        console.warn('[AUTO SUMMARY LEGACY MIRROR ERROR]', error);
    }

    return saved;
}

export function getDueAutoSummarySettings(nowTimestamp = Math.floor(Date.now() / 1000)) {
    return autoSummaryStateStore.getDueSettings(nowTimestamp);
}

export function getEnabledAutoSummarySettings() {
    return autoSummaryStateStore.getEnabledSettings();
}

export function getAllAutoSummarySettings() {
    return autoSummaryStateStore.getAllSettings();
}

export function getAutoSummaryStateDatabasePath() {
    return autoSummaryStateStore.databasePath;
}

export function getAutoSummaryRun(peerId, summaryDate, slotLabel) {
    return autoSummaryStateStore.getRun(peerId, summaryDate, slotLabel);
}

export function getAutoSummaryHealth(peerId) {
    return autoSummaryStateStore.getHealth(peerId);
}

export function saveAutoSummaryHealth({
    peerId,
    lastAttemptAt = 0,
    lastSuccessAt = 0,
    lastError = '',
    consecutiveFailures = 0,
}) {
    return autoSummaryStateStore.saveHealth({
        peerId,
        lastAttemptAt,
        lastSuccessAt,
        lastError,
        consecutiveFailures,
    });
}

export function saveAutoSummaryRun({
    peerId, summaryDate, slotLabel, scheduledAt, startedAt,
    finishedAt = 0, messageCount = 0, summaryText = '',
}) {
    const payload = {
        peerId,
        summaryDate,
        slotLabel,
        scheduledAt,
        startedAt,
        finishedAt,
        messageCount,
        summaryText,
    };
    const saved = autoSummaryStateStore.saveRun(payload);

    try {
        upsertAutoSummaryRunStatement.run(
            Number(peerId),
            String(summaryDate),
            String(slotLabel),
            Number(scheduledAt) || 0,
            Number(startedAt) || 0,
            Number(finishedAt) || 0,
            Number(messageCount) || 0,
            String(summaryText || ''),
        );
    } catch (error) {
        console.warn('[AUTO SUMMARY RUN LEGACY MIRROR ERROR]', error);
    }

    return saved;
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

export function getStoredGroupPeerIds() {
    // Background summary accumulation must not depend on whether public
    // auto-summary delivery is enabled. Discover every stored group peer we can
    // identify on both supported transports. VK group chats use the native
    // 2_000_000_000+ peer range; Telegram group/supergroup peers are mapped to
    // internal integer ids through platform_identities.
    const rows = database.prepare(`
        SELECT peer_id
        FROM (
            SELECT DISTINCT m.peer_id AS peer_id
            FROM messages AS m
            WHERE m.peer_id >= 2000000000

            UNION

            SELECT DISTINCT m.peer_id AS peer_id
            FROM messages AS m
            INNER JOIN platform_identities AS pi
                ON pi.internal_id = m.peer_id
               AND pi.platform = 'telegram'
               AND pi.entity_type = 'peer'
            WHERE pi.external_id LIKE 'group:%'
               OR pi.external_id LIKE 'supergroup:%'
        )
        ORDER BY peer_id ASC
    `).all();
    return rows
        .map((row) => Number(row.peer_id))
        .filter((peerId) => Number.isSafeInteger(peerId));
}


export function searchStoredMessagesByText(term) {
    const clean = String(term ?? '').replace(/\s+/gu, ' ').trim();
    if (!clean) return [];
    const lower = clean.toLocaleLowerCase('ru-RU');
    const upper = clean.toLocaleUpperCase('ru-RU');
    const title = lower ? lower.charAt(0).toLocaleUpperCase('ru-RU') + lower.slice(1) : clean;
    const variants = [...new Set([clean, lower, upper, title])]
        .map((value) => `%${value}%`);
    while (variants.length < 4) variants.push(variants[0]);
    return searchStoredMessagesByTextStatement
        .all(...variants.slice(0, 4))
        .map(mapMessage)
        .filter((message) => String(message?.text ?? '')
            .toLocaleLowerCase('ru-RU')
            .includes(lower));
}

/*
 * V132: перенос долговечной истории удалённой групповой беседы в новый peer.
 * Это именно миграция данных, а не alias transport peer_id: VK должен продолжать
 * отправлять ответы в новый чат, поэтому новый peer_id остаётся каноническим.
 */
function getStoredGroupPeerRows({ platform = 'vk', excludePeerId = 0, limit = 12 } = {}) {
    const cleanPlatform = String(platform ?? '').trim().toLowerCase();
    const excluded = Number(excludePeerId) || 0;
    const safeLimit = Math.max(1, Math.min(50, Number(limit) || 12));

    if (cleanPlatform === 'telegram') {
        return database.prepare(`
            SELECT
                m.peer_id,
                COUNT(*) AS message_count,
                COUNT(DISTINCT m.sender_id) AS participant_count,
                MIN(m.created_at) AS first_message_at,
                MAX(m.created_at) AS last_message_at,
                MAX(pi.external_id) AS external_peer_id
            FROM messages AS m
            INNER JOIN platform_identities AS pi
                ON pi.internal_id = m.peer_id
               AND pi.platform = 'telegram'
               AND pi.entity_type = 'peer'
            WHERE m.peer_id <> ?
              AND (
                    pi.external_id LIKE 'group:%'
                 OR pi.external_id LIKE 'supergroup:%'
              )
            GROUP BY m.peer_id
            ORDER BY message_count DESC, last_message_at DESC, m.peer_id ASC
            LIMIT ?
        `).all(excluded, safeLimit);
    }

    if (cleanPlatform === 'vk') {
        return database.prepare(`
            SELECT
                peer_id,
                COUNT(*) AS message_count,
                COUNT(DISTINCT sender_id) AS participant_count,
                MIN(created_at) AS first_message_at,
                MAX(created_at) AS last_message_at,
                CAST(peer_id AS TEXT) AS external_peer_id
            FROM messages
            WHERE peer_id >= 2000000000
              AND peer_id <> ?
            GROUP BY peer_id
            ORDER BY message_count DESC, last_message_at DESC, peer_id ASC
            LIMIT ?
        `).all(excluded, safeLimit);
    }

    return [];
}

function getPeerMessageWindow(peerId) {
    const row = database.prepare(`
        SELECT
            COUNT(*) AS message_count,
            COUNT(DISTINCT sender_id) AS participant_count,
            MIN(created_at) AS first_message_at,
            MAX(created_at) AS last_message_at
        FROM messages
        WHERE peer_id = ?
    `).get(Number(peerId));

    return {
        messageCount: Number(row?.message_count ?? 0),
        participantCount: Number(row?.participant_count ?? 0),
        firstMessageAt: Number(row?.first_message_at ?? 0),
        lastMessageAt: Number(row?.last_message_at ?? 0),
    };
}

function getPeerParticipantOverlap(leftPeerId, rightPeerId) {
    const row = database.prepare(`
        SELECT COUNT(*) AS overlap_count
        FROM (
            SELECT DISTINCT sender_id FROM messages WHERE peer_id = ?
            INTERSECT
            SELECT DISTINCT sender_id FROM messages WHERE peer_id = ?
        )
    `).get(Number(leftPeerId), Number(rightPeerId));

    return Number(row?.overlap_count ?? 0);
}

/*
 * V133: выбираем не просто «самый большой чат вообще», а наиболее похожий
 * на оборванную старую беседу. Для замены удалённого чата характерна короткая
 * временная склейка: старая история заканчивается незадолго до первых сообщений
 * в новом peer_id. Внутри такого окна всё равно побеждает самый активный чат,
 * поэтому огромная историческая беседа Гигорейва не уступит случайному чату.
 */
export function getBestStoredGroupPeerForHistoryRebind({
    platform = 'vk',
    targetPeerId = 0,
    limit = 12,
    handoffWindowSeconds = 14 * 24 * 60 * 60,
    futureToleranceSeconds = 6 * 60 * 60,
} = {}) {
    const target = Number(targetPeerId) || 0;
    const rows = getStoredGroupPeerRows({
        platform,
        excludePeerId: target,
        limit,
    });
    if (!rows.length) return null;

    const targetWindow = getPeerMessageWindow(target);
    const candidates = rows.map((row) => {
        const lastMessageAt = Number(row.last_message_at ?? 0);
        const targetFirst = targetWindow.firstMessageAt;
        const handoffGapSeconds = targetFirst
            ? targetFirst - lastMessageAt
            : null;
        const inHandoffWindow = targetFirst
            ? handoffGapSeconds >= -Math.max(0, Number(futureToleranceSeconds) || 0)
                && handoffGapSeconds <= Math.max(0, Number(handoffWindowSeconds) || 0)
            : false;

        return {
            peerId: Number(row.peer_id),
            externalPeerId: String(row.external_peer_id ?? ''),
            messageCount: Number(row.message_count ?? 0),
            participantCount: Number(row.participant_count ?? 0),
            firstMessageAt: Number(row.first_message_at ?? 0),
            lastMessageAt,
            sharedParticipantCount: targetWindow.participantCount
                ? getPeerParticipantOverlap(Number(row.peer_id), target)
                : 0,
            handoffGapSeconds,
            inHandoffWindow,
        };
    });

    const plausible = candidates.filter((candidate) => candidate.inHandoffWindow);
    const pool = plausible.length ? plausible : candidates;

    pool.sort((left, right) => {
        /* Главный сигнал — накопленный объём истории. */
        if (right.messageCount !== left.messageCount) {
            return right.messageCount - left.messageCount;
        }
        /* При близком объёме предпочитаем тех же участников. */
        if (right.sharedParticipantCount !== left.sharedParticipantCount) {
            return right.sharedParticipantCount - left.sharedParticipantCount;
        }
        /* Затем — максимально плотный переход старый чат -> новый чат. */
        const leftGap = left.handoffGapSeconds === null
            ? Number.POSITIVE_INFINITY
            : Math.abs(left.handoffGapSeconds);
        const rightGap = right.handoffGapSeconds === null
            ? Number.POSITIVE_INFINITY
            : Math.abs(right.handoffGapSeconds);
        if (leftGap !== rightGap) return leftGap - rightGap;
        if (right.lastMessageAt !== left.lastMessageAt) {
            return right.lastMessageAt - left.lastMessageAt;
        }
        return left.peerId - right.peerId;
    });

    return {
        ...pool[0],
        selectionStrategy: plausible.length ? 'handoff-window-most-active' : 'most-active-fallback',
        candidateCount: candidates.length,
        plausibleCandidateCount: plausible.length,
        targetMessageCount: targetWindow.messageCount,
        targetParticipantCount: targetWindow.participantCount,
        targetFirstMessageAt: targetWindow.firstMessageAt,
        targetLastMessageAt: targetWindow.lastMessageAt,
    };
}

export function getMostActiveStoredGroupPeer({
    platform = 'vk',
    excludePeerId = 0,
} = {}) {
    const row = getStoredGroupPeerRows({
        platform,
        excludePeerId,
        limit: 1,
    })[0];

    if (!row) return null;

    return {
        peerId: Number(row.peer_id),
        externalPeerId: String(row.external_peer_id ?? ''),
        messageCount: Number(row.message_count ?? 0),
        participantCount: Number(row.participant_count ?? 0),
        firstMessageAt: Number(row.first_message_at ?? 0),
        lastMessageAt: Number(row.last_message_at ?? 0),
    };
}

const upsertVkMessageArchiveStatement = database.prepare(`
    INSERT INTO vk_message_archive (
        peer_id,
        source_peer_id,
        conversation_message_id,
        message_id,
        sender_id,
        created_at,
        is_outbox,
        text,
        action_type,
        action_json,
        raw_message_json,
        first_seen_at,
        updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT (source_peer_id, conversation_message_id) DO UPDATE SET
        peer_id = excluded.peer_id,
        message_id = CASE
            WHEN excluded.message_id <> 0 THEN excluded.message_id
            ELSE vk_message_archive.message_id
        END,
        sender_id = CASE
            WHEN excluded.sender_id <> 0 THEN excluded.sender_id
            ELSE vk_message_archive.sender_id
        END,
        created_at = CASE
            WHEN excluded.created_at > 0 THEN excluded.created_at
            ELSE vk_message_archive.created_at
        END,
        is_outbox = MAX(vk_message_archive.is_outbox, excluded.is_outbox),
        text = CASE
            WHEN excluded.text <> '' THEN excluded.text
            ELSE vk_message_archive.text
        END,
        action_type = CASE
            WHEN excluded.action_type <> '' THEN excluded.action_type
            ELSE vk_message_archive.action_type
        END,
        action_json = CASE
            WHEN excluded.action_json <> '' THEN excluded.action_json
            ELSE vk_message_archive.action_json
        END,
        raw_message_json = CASE
            WHEN excluded.raw_message_json <> '' THEN excluded.raw_message_json
            ELSE vk_message_archive.raw_message_json
        END,
        updated_at = excluded.updated_at
`);

const selectVkMessageArchiveStatsStatement = database.prepare(`
    SELECT
        COUNT(*) AS total_count,
        SUM(CASE WHEN is_outbox = 0 THEN 1 ELSE 0 END) AS incoming_count,
        SUM(CASE WHEN is_outbox = 1 THEN 1 ELSE 0 END) AS outgoing_count,
        SUM(CASE WHEN action_type <> '' THEN 1 ELSE 0 END) AS service_count,
        COUNT(DISTINCT source_peer_id) AS source_peer_count,
        MIN(created_at) AS first_created_at,
        MAX(created_at) AS last_created_at,
        MIN(conversation_message_id) AS min_cmid,
        MAX(conversation_message_id) AS max_cmid
    FROM vk_message_archive
    WHERE peer_id = ?
`);

const selectVkServiceEventSummaryStatement = database.prepare(`
    SELECT
        action_type,
        COUNT(*) AS event_count,
        MIN(created_at) AS first_created_at,
        MAX(created_at) AS last_created_at
    FROM vk_message_archive
    WHERE peer_id = ?
      AND action_type <> ''
    GROUP BY action_type
    ORDER BY event_count DESC, action_type ASC
`);

const selectVkServiceEventsStatement = database.prepare(`
    SELECT
        peer_id,
        source_peer_id,
        conversation_message_id,
        message_id,
        sender_id,
        created_at,
        is_outbox,
        text,
        action_type,
        action_json,
        raw_message_json
    FROM vk_message_archive
    WHERE peer_id = ?
      AND action_type <> ''
    ORDER BY created_at ASC, source_peer_id ASC, conversation_message_id ASC
    LIMIT ?
`);

const selectVkMessageArchiveMessagesStatement = database.prepare(`
    SELECT
        peer_id,
        source_peer_id,
        conversation_message_id,
        message_id,
        sender_id,
        created_at,
        is_outbox,
        text,
        action_type
    FROM vk_message_archive
    WHERE peer_id = ?
      AND is_outbox = 0
      AND text <> ''
      AND action_type = ''
    ORDER BY created_at ASC, source_peer_id ASC, conversation_message_id ASC
`);

const selectVkMessageArchiveUserMessagesStatement = database.prepare(`
    SELECT
        peer_id,
        source_peer_id,
        conversation_message_id,
        message_id,
        sender_id,
        created_at,
        is_outbox,
        text,
        action_type
    FROM vk_message_archive
    WHERE peer_id = ?
      AND sender_id = ?
      AND is_outbox = 0
      AND text <> ''
      AND action_type = ''
    ORDER BY created_at ASC, source_peer_id ASC, conversation_message_id ASC
`);

const selectVkMessageArchiveParticipantIdsStatement = database.prepare(`
    SELECT DISTINCT sender_id
    FROM vk_message_archive
    WHERE peer_id = ?
      AND sender_id > 0
      AND is_outbox = 0
    ORDER BY sender_id ASC
`);

function appendVkMessageArchiveJournalEntry(entry) {
    try {
        appendFileSync(
            vkMessageArchiveJournalPath,
            `${JSON.stringify(entry)}\n`,
            { encoding: 'utf8' },
        );
        return true;
    } catch (error) {
        console.error(
            '[VK MESSAGE ARCHIVE JOURNAL WRITE ERROR]',
            String(error?.message ?? error),
        );
        return false;
    }
}

function normalizeVkArchiveJson(value) {
    if (typeof value === 'string') return value;
    if (value === null || value === undefined) return '';
    try {
        return JSON.stringify(value);
    } catch {
        return '';
    }
}

function saveVkMessageArchiveRecordInternal({
    peerId,
    sourcePeerId = peerId,
    conversationMessageId,
    messageId = 0,
    senderId = 0,
    createdAt = 0,
    isOutbox = false,
    text = '',
    actionType = '',
    actionJson = '',
    rawMessageJson = '',
}) {
    const now = Math.floor(Date.now() / 1000);
    return upsertVkMessageArchiveStatement.run(
        Number(peerId),
        Number(sourcePeerId),
        Number(conversationMessageId),
        Number(messageId || 0),
        Number(senderId || 0),
        Number(createdAt || 0),
        isOutbox ? 1 : 0,
        String(text ?? ''),
        String(actionType ?? '').trim(),
        normalizeVkArchiveJson(actionJson),
        normalizeVkArchiveJson(rawMessageJson),
        now,
        now,
    );
}

function replayVkMessageArchiveJournal() {
    if (!existsSync(vkMessageArchiveJournalPath)) return;

    let content = '';
    try {
        content = readFileSync(vkMessageArchiveJournalPath, 'utf8');
    } catch (error) {
        console.error('[VK MESSAGE ARCHIVE JOURNAL READ ERROR]', String(error?.message ?? error));
        return;
    }
    if (!content.trim()) return;

    let parsed = 0;
    let replayed = 0;
    let invalid = 0;
    for (const line of content.split(/\r?\n/u)) {
        const clean = line.trim();
        if (!clean) continue;
        let item;
        try {
            item = JSON.parse(clean);
        } catch {
            invalid += 1;
            continue;
        }
        const peerId = Number(item?.peerId);
        const sourcePeerId = Number(item?.sourcePeerId ?? peerId);
        const cmid = Number(item?.conversationMessageId);
        if (!Number.isSafeInteger(peerId) || !Number.isSafeInteger(sourcePeerId) || !Number.isSafeInteger(cmid) || cmid <= 0) {
            invalid += 1;
            continue;
        }
        parsed += 1;
        try {
            saveVkMessageArchiveRecordInternal(item);
            replayed += 1;
        } catch (error) {
            console.error('[VK MESSAGE ARCHIVE JOURNAL REPLAY ERROR]', String(error?.message ?? error));
            return;
        }
    }

    try {
        writeFileSync(vkMessageArchiveJournalPath, '', 'utf8');
    } catch (error) {
        console.warn('[VK MESSAGE ARCHIVE JOURNAL COMPACT ERROR]', String(error?.message ?? error));
    }
    console.log('[VK MESSAGE ARCHIVE JOURNAL REPLAY]', `parsed=${parsed}`, `replayed=${replayed}`, `invalid=${invalid}`);
}

export function saveVkMessageArchiveRecord({
    peerId,
    sourcePeerId = peerId,
    conversationMessageId,
    messageId = 0,
    senderId = 0,
    createdAt = 0,
    isOutbox = false,
    text = '',
    actionType = '',
    actionJson = '',
    rawMessageJson = '',
    durableJournal = false,
} = {}) {
    const numericPeerId = Number(peerId);
    const numericSourcePeerId = Number(sourcePeerId);
    const numericCmid = Number(conversationMessageId);
    if (!Number.isSafeInteger(numericPeerId)) return 0;
    if (!Number.isSafeInteger(numericSourcePeerId)) return 0;
    if (!Number.isSafeInteger(numericCmid) || numericCmid <= 0) return 0;

    const entry = {
        peerId: numericPeerId,
        sourcePeerId: numericSourcePeerId,
        conversationMessageId: numericCmid,
        messageId: Number(messageId || 0),
        senderId: Number(senderId || 0),
        createdAt: Number(createdAt || 0),
        isOutbox: Boolean(isOutbox),
        text: String(text ?? ''),
        actionType: String(actionType ?? '').trim(),
        actionJson: normalizeVkArchiveJson(actionJson),
        rawMessageJson: normalizeVkArchiveJson(rawMessageJson),
    };

    if (durableJournal) appendVkMessageArchiveJournalEntry(entry);
    const result = saveVkMessageArchiveRecordInternal(entry);
    return Number(result.changes ?? 0);
}

export function getVkMessageArchiveStats(peerId) {
    const row = selectVkMessageArchiveStatsStatement.get(Number(peerId)) ?? {};
    return {
        totalCount: Number(row.total_count ?? 0),
        incomingCount: Number(row.incoming_count ?? 0),
        outgoingCount: Number(row.outgoing_count ?? 0),
        serviceCount: Number(row.service_count ?? 0),
        sourcePeerCount: Number(row.source_peer_count ?? 0),
        firstCreatedAt: Number(row.first_created_at ?? 0),
        lastCreatedAt: Number(row.last_created_at ?? 0),
        minCmid: Number(row.min_cmid ?? 0),
        maxCmid: Number(row.max_cmid ?? 0),
    };
}

export function getVkServiceEventSummary(peerId) {
    return selectVkServiceEventSummaryStatement.all(Number(peerId)).map((row) => ({
        actionType: String(row.action_type ?? ''),
        eventCount: Number(row.event_count ?? 0),
        firstCreatedAt: Number(row.first_created_at ?? 0),
        lastCreatedAt: Number(row.last_created_at ?? 0),
    }));
}

export function getVkServiceEvents(peerId, { limit = 10000 } = {}) {
    const safeLimit = Math.max(1, Math.min(100000, Number(limit) || 10000));
    return selectVkServiceEventsStatement.all(Number(peerId), safeLimit).map((row) => ({
        peerId: Number(row.peer_id),
        sourcePeerId: Number(row.source_peer_id),
        conversationMessageId: Number(row.conversation_message_id),
        messageId: Number(row.message_id ?? 0),
        senderId: Number(row.sender_id ?? 0),
        createdAt: Number(row.created_at ?? 0),
        isOutbox: Boolean(row.is_outbox),
        text: String(row.text ?? ''),
        actionType: String(row.action_type ?? ''),
        actionJson: String(row.action_json ?? ''),
        rawMessageJson: String(row.raw_message_json ?? ''),
    }));
}


export function getVkMessageArchiveMessages(peerId) {
    return selectVkMessageArchiveMessagesStatement
        .all(Number(peerId))
        .map((row) => ({
            peerId: Number(row.peer_id),
            sourcePeerId: Number(row.source_peer_id),
            conversationMessageId: Number(row.conversation_message_id),
            messageId: Number(row.message_id ?? 0),
            senderId: Number(row.sender_id ?? 0),
            createdAt: Number(row.created_at ?? 0),
            text: String(row.text ?? ''),
        }));
}

export function getVkMessageArchiveUserMessages(peerId, userId) {
    return selectVkMessageArchiveUserMessagesStatement
        .all(Number(peerId), Number(userId))
        .map((row) => ({
            peerId: Number(row.peer_id),
            sourcePeerId: Number(row.source_peer_id),
            conversationMessageId: Number(row.conversation_message_id),
            messageId: Number(row.message_id ?? 0),
            senderId: Number(row.sender_id ?? 0),
            createdAt: Number(row.created_at ?? 0),
            text: String(row.text ?? ''),
        }));
}

export function getVkMessageArchiveParticipantIds(peerId) {
    return selectVkMessageArchiveParticipantIdsStatement
        .all(Number(peerId))
        .map((row) => Number(row.sender_id))
        .filter((userId) => Number.isSafeInteger(userId) && userId > 0);
}

replayVkMessageArchiveJournal();

const upsertChatMembershipEventStatement = database.prepare(`
    INSERT INTO chat_membership_events (
        platform,
        peer_id,
        source_peer_id,
        conversation_message_id,
        event_type,
        actor_id,
        member_id,
        created_at,
        raw_action_type
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT (
        platform,
        source_peer_id,
        conversation_message_id,
        event_type,
        member_id
    ) DO UPDATE SET
        peer_id = excluded.peer_id,
        actor_id = excluded.actor_id,
        created_at = excluded.created_at,
        raw_action_type = excluded.raw_action_type
`);

const selectChatLeaversStatement = database.prepare(`
    SELECT
        member_id,
        COUNT(*) AS exit_count,
        SUM(CASE WHEN event_type = 'left' THEN 1 ELSE 0 END) AS voluntary_count,
        SUM(CASE WHEN event_type = 'kicked' THEN 1 ELSE 0 END) AS kicked_count,
        MIN(created_at) AS first_exit_at,
        MAX(created_at) AS last_exit_at
    FROM chat_membership_events
    WHERE platform = ?
      AND peer_id = ?
      AND event_type IN ('left', 'kicked')
      AND member_id > 0
    GROUP BY member_id
    ORDER BY last_exit_at DESC, member_id ASC
`);

const selectChatExitEventsStatement = database.prepare(`
    SELECT
        source_peer_id,
        conversation_message_id,
        event_type,
        actor_id,
        member_id,
        created_at,
        raw_action_type
    FROM chat_membership_events
    WHERE platform = ?
      AND peer_id = ?
      AND event_type IN ('left', 'kicked')
      AND member_id > 0
    ORDER BY created_at ASC, source_peer_id ASC, conversation_message_id ASC
`);

const selectVkUserNameCacheStatement = database.prepare(`
    SELECT full_name
    FROM vk_user_name_cache
    WHERE user_id = ?
    LIMIT 1
`);

const upsertVkUserNameCacheStatement = database.prepare(`
    INSERT INTO vk_user_name_cache (user_id, full_name, updated_at)
    VALUES (?, ?, ?)
    ON CONFLICT (user_id) DO UPDATE SET
        full_name = excluded.full_name,
        updated_at = excluded.updated_at
`);

const selectChatLeaverAutoSettingsStatement = database.prepare(`
    SELECT peer_id, platform, endpoint_key, external_peer_id, interval_days,
           enabled, next_run_at, last_run_at, updated_by, updated_at
    FROM chat_leaver_auto_settings
    WHERE peer_id = ?
    LIMIT 1
`);

const upsertChatLeaverAutoSettingsStatement = database.prepare(`
    INSERT INTO chat_leaver_auto_settings (
        peer_id, platform, endpoint_key, external_peer_id, interval_days, enabled,
        next_run_at, last_run_at, updated_by, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT (peer_id) DO UPDATE SET
        platform = excluded.platform,
        endpoint_key = excluded.endpoint_key,
        external_peer_id = excluded.external_peer_id,
        interval_days = excluded.interval_days,
        enabled = excluded.enabled,
        next_run_at = excluded.next_run_at,
        last_run_at = excluded.last_run_at,
        updated_by = excluded.updated_by,
        updated_at = excluded.updated_at
`);

const selectDueChatLeaverAutoSettingsStatement = database.prepare(`
    SELECT peer_id, platform, endpoint_key, external_peer_id, interval_days,
           enabled, next_run_at, last_run_at, updated_by, updated_at
    FROM chat_leaver_auto_settings
    WHERE enabled = 1
      AND next_run_at > 0
      AND next_run_at <= ?
    ORDER BY next_run_at ASC, peer_id ASC
`);

const selectEnabledChatLeaverAutoSettingsStatement = database.prepare(`
    SELECT peer_id, platform, endpoint_key, external_peer_id, interval_days,
           enabled, next_run_at, last_run_at, updated_by, updated_at
    FROM chat_leaver_auto_settings
    WHERE enabled = 1
    ORDER BY peer_id ASC
`);

function mapChatLeaverAutoSettingsRow(row) {
    if (!row) return null;
    return {
        peerId: Number(row.peer_id),
        platform: String(row.platform ?? 'vk'),
        endpointKey: String(row.endpoint_key ?? 'vk:primary'),
        externalPeerId: String(row.external_peer_id ?? ''),
        intervalDays: Number(row.interval_days ?? 1),
        enabled: Boolean(row.enabled),
        nextRunAt: Number(row.next_run_at ?? 0),
        lastRunAt: Number(row.last_run_at ?? 0),
        updatedBy: Number(row.updated_by ?? 0),
        updatedAt: Number(row.updated_at ?? 0),
    };
}

export function saveChatMembershipEvent({
    platform = 'vk',
    peerId,
    sourcePeerId = peerId,
    conversationMessageId,
    eventType,
    actorId = 0,
    memberId,
    createdAt = Math.floor(Date.now() / 1000),
    rawActionType = '',
} = {}) {
    const cleanPlatform = String(platform ?? 'vk').trim().toLowerCase();
    const cleanEventType = String(eventType ?? '').trim().toLowerCase();
    const numericPeerId = Number(peerId);
    const numericSourcePeerId = Number(sourcePeerId);
    const numericConversationMessageId = Number(conversationMessageId);
    const numericActorId = Number(actorId ?? 0);
    const numericMemberId = Number(memberId);
    const numericCreatedAt = Number(createdAt);

    if (!['left', 'kicked', 'joined'].includes(cleanEventType)) return 0;
    if (!Number.isSafeInteger(numericPeerId)) return 0;
    if (!Number.isSafeInteger(numericSourcePeerId)) return 0;
    if (!Number.isSafeInteger(numericConversationMessageId) || numericConversationMessageId <= 0) return 0;
    if (!Number.isSafeInteger(numericMemberId) || numericMemberId === 0) return 0;
    if (!Number.isFinite(numericCreatedAt) || numericCreatedAt <= 0) return 0;

    const result = upsertChatMembershipEventStatement.run(
        cleanPlatform,
        numericPeerId,
        numericSourcePeerId,
        numericConversationMessageId,
        cleanEventType,
        Number.isSafeInteger(numericActorId) ? numericActorId : 0,
        numericMemberId,
        numericCreatedAt,
        String(rawActionType ?? '').trim(),
    );

    return Number(result.changes ?? 0);
}

export function getChatLeavers(peerId, { platform = 'vk' } = {}) {
    return selectChatLeaversStatement
        .all(
            String(platform ?? 'vk').trim().toLowerCase(),
            Number(peerId),
        )
        .map((row) => ({
            memberId: Number(row.member_id),
            exitCount: Number(row.exit_count ?? 0),
            voluntaryCount: Number(row.voluntary_count ?? 0),
            kickedCount: Number(row.kicked_count ?? 0),
            firstExitAt: Number(row.first_exit_at ?? 0),
            lastExitAt: Number(row.last_exit_at ?? 0),
        }));
}

export function getChatExitEvents(peerId, { platform = 'vk' } = {}) {
    return selectChatExitEventsStatement
        .all(
            String(platform ?? 'vk').trim().toLowerCase(),
            Number(peerId),
        )
        .map((row) => ({
            sourcePeerId: Number(row.source_peer_id),
            conversationMessageId: Number(row.conversation_message_id),
            eventType: String(row.event_type ?? ''),
            actorId: Number(row.actor_id ?? 0),
            memberId: Number(row.member_id ?? 0),
            createdAt: Number(row.created_at ?? 0),
            rawActionType: String(row.raw_action_type ?? ''),
        }));
}

export function getChatLeaverAutoSettings(peerId) {
    return mapChatLeaverAutoSettingsRow(
        selectChatLeaverAutoSettingsStatement.get(Number(peerId)),
    );
}

export function saveChatLeaverAutoSettings({
    peerId,
    platform = 'vk',
    endpointKey = 'vk:primary',
    externalPeerId = '',
    intervalDays = 1,
    enabled = false,
    nextRunAt = 0,
    lastRunAt = 0,
    updatedBy = 0,
    updatedAt = Math.floor(Date.now() / 1000),
} = {}) {
    const numericPeerId = Number(peerId);
    const numericIntervalDays = Math.max(1, Math.min(365, Math.trunc(Number(intervalDays) || 1)));
    if (!Number.isSafeInteger(numericPeerId)) {
        throw new Error(`Invalid leaver auto-report peer_id: ${peerId}`);
    }
    upsertChatLeaverAutoSettingsStatement.run(
        numericPeerId,
        String(platform ?? 'vk').trim() || 'vk',
        String(endpointKey ?? 'vk:primary').trim() || 'vk:primary',
        String(externalPeerId ?? '').trim(),
        numericIntervalDays,
        enabled ? 1 : 0,
        Math.max(0, Math.trunc(Number(nextRunAt) || 0)),
        Math.max(0, Math.trunc(Number(lastRunAt) || 0)),
        Number(updatedBy || 0),
        Math.max(1, Math.trunc(Number(updatedAt) || Math.floor(Date.now() / 1000))),
    );
    return getChatLeaverAutoSettings(numericPeerId);
}

export function getDueChatLeaverAutoSettings(nowTimestamp = Math.floor(Date.now() / 1000)) {
    return selectDueChatLeaverAutoSettingsStatement
        .all(Math.max(0, Math.trunc(Number(nowTimestamp) || 0)))
        .map(mapChatLeaverAutoSettingsRow)
        .filter(Boolean);
}

export function getEnabledChatLeaverAutoSettings() {
    return selectEnabledChatLeaverAutoSettingsStatement
        .all()
        .map(mapChatLeaverAutoSettingsRow)
        .filter(Boolean);
}

export function getVkCachedUserNames(userIds = []) {
    const names = new Map();
    const ids = [...new Set(
        (Array.isArray(userIds) ? userIds : [])
            .map((value) => Number(value))
            .filter((value) => Number.isSafeInteger(value) && value > 0),
    )];

    for (const userId of ids) {
        const row = selectVkUserNameCacheStatement.get(userId);
        const fullName = String(row?.full_name ?? '').trim();
        if (fullName) names.set(userId, fullName);
    }

    return names;
}

export function saveVkUserNames(users = []) {
    const now = Math.floor(Date.now() / 1000);
    let saved = 0;

    for (const user of Array.isArray(users) ? users : []) {
        const userId = Number(user?.id ?? user?.userId ?? 0);
        const fullName = String(
            user?.fullName ??
            [user?.first_name ?? user?.firstName, user?.last_name ?? user?.lastName]
                .filter(Boolean)
                .join(' '),
        ).replace(/\s+/gu, ' ').trim();
        if (!Number.isSafeInteger(userId) || userId <= 0 || !fullName) continue;
        upsertVkUserNameCacheStatement.run(userId, fullName, now);
        saved += 1;
    }

    return saved;
}

export function getPeerHistoryMigration({ platform = 'vk', targetPeerId = 0 } = {}) {
    const row = database.prepare(`
        SELECT
            id,
            platform,
            source_peer_id,
            target_peer_id,
            source_message_count,
            target_message_count_before,
            remapped_target_message_ids,
            backup_path,
            migrated_at
        FROM peer_history_migrations
        WHERE platform = ? AND target_peer_id = ?
        LIMIT 1
    `).get(
        String(platform ?? '').trim().toLowerCase(),
        Number(targetPeerId),
    );

    if (!row) return null;

    return {
        id: Number(row.id),
        platform: String(row.platform ?? ''),
        sourcePeerId: Number(row.source_peer_id),
        targetPeerId: Number(row.target_peer_id),
        sourceMessageCount: Number(row.source_message_count ?? 0),
        targetMessageCountBefore: Number(row.target_message_count_before ?? 0),
        remappedTargetMessageIds: Number(row.remapped_target_message_ids ?? 0),
        backupPath: String(row.backup_path ?? ''),
        migratedAt: Number(row.migrated_at ?? 0),
    };
}

function createPeerHistoryBackup() {
    const backupDirectory = join(dataDirectory, 'backups');
    mkdirSync(backupDirectory, { recursive: true });

    const fileName = `bot-before-history-link-${Date.now()}.sqlite`;
    const absolutePath = join(backupDirectory, fileName);
    const escapedPath = absolutePath.replaceAll("'", "''");

    database.exec(`VACUUM INTO '${escapedPath}'`);
    return `data/backups/${fileName}`;
}

function countPeerRows(tableName, peerId) {
    const allowed = new Set([
        'messages',
        'dossier_facts',
        'dossier_daily_runs',
        'participant_styles',
        'communication_participants',
        'communication_banter_state',
        'interaction_memory',
        'explicit_memories',
    ]);
    if (!allowed.has(tableName)) {
        throw new Error(`Недопустимая peer-таблица: ${tableName}`);
    }
    const row = database.prepare(
        `SELECT COUNT(*) AS count FROM ${tableName} WHERE peer_id = ?`,
    ).get(Number(peerId));
    return Number(row?.count ?? 0);
}

export function migrateStoredGroupHistory({
    sourcePeerId,
    targetPeerId,
    platform = 'vk',
    targetExternalPeerId = '',
    isGroup = true,
    createBackup = true,
    migratedAt = Math.floor(Date.now() / 1000),
} = {}) {
    const source = Number(sourcePeerId);
    const target = Number(targetPeerId);
    const cleanPlatform = String(platform ?? '').trim().toLowerCase() || 'vk';
    const cleanExternalPeerId = String(targetExternalPeerId ?? '').trim();
    const safeMigratedAt = Math.max(1, Number(migratedAt) || Math.floor(Date.now() / 1000));

    if (!Number.isSafeInteger(source) || !Number.isSafeInteger(target) || source === target) {
        throw new Error('Некорректные source/target peer_id для переноса истории.');
    }
    if (!['vk', 'telegram'].includes(cleanPlatform)) {
        throw new Error('Перенос истории поддерживает только VK и Telegram.');
    }

    const previousMigration = getPeerHistoryMigration({
        platform: cleanPlatform,
        targetPeerId: target,
    });
    if (previousMigration) {
        return {
            migrated: false,
            reason: 'already_migrated',
            previousMigration,
        };
    }

    const sourceMessageCount = countPeerRows('messages', source);
    const targetMessageCountBefore = countPeerRows('messages', target);
    if (sourceMessageCount < 1) {
        return {
            migrated: false,
            reason: 'source_empty',
            sourcePeerId: source,
            targetPeerId: target,
        };
    }

    const counts = {
        messages: sourceMessageCount,
        dossierFacts: countPeerRows('dossier_facts', source),
        dossierDailyRuns: countPeerRows('dossier_daily_runs', source),
        participantStyles: countPeerRows('participant_styles', source),
        participants: countPeerRows('communication_participants', source),
        interactions: countPeerRows('interaction_memory', source),
        explicitMemories: countPeerRows('explicit_memories', source),
        staleBanterCleared: countPeerRows('communication_banter_state', source),
    };

    const backupPath = createBackup ? createPeerHistoryBackup() : '';

    database.exec('BEGIN IMMEDIATE');
    try {
        /*
         * У старой и новой беседы conversation_message_id начинаются заново с
         * малых чисел. Сначала сдвигаем только конфликтующие ID НОВОЙ беседы,
         * чтобы старые исторические cmid остались неизменными. Это также
         * сохраняет связь messages <-> explicit_memories.
         */
        const collisionRows = database.prepare(`
            SELECT conversation_message_id
            FROM (
                SELECT conversation_message_id
                FROM messages
                WHERE peer_id = ?
                UNION
                SELECT conversation_message_id
                FROM explicit_memories
                WHERE peer_id = ?
            ) AS target_ids
            WHERE conversation_message_id IN (
                SELECT conversation_message_id
                FROM messages
                WHERE peer_id = ?
                UNION
                SELECT conversation_message_id
                FROM explicit_memories
                WHERE peer_id = ?
            )
            ORDER BY conversation_message_id ASC
        `).all(target, target, source, source);

        const maxRow = database.prepare(`
            SELECT COALESCE(MAX(conversation_message_id), 0) AS max_id
            FROM (
                SELECT conversation_message_id FROM messages WHERE peer_id IN (?, ?)
                UNION ALL
                SELECT conversation_message_id FROM explicit_memories WHERE peer_id IN (?, ?)
            )
        `).get(source, target, source, target);
        let nextConversationMessageId = Math.max(0, Number(maxRow?.max_id ?? 0)) + 1;

        const remapTargetMessage = database.prepare(`
            UPDATE messages
            SET conversation_message_id = ?
            WHERE peer_id = ? AND conversation_message_id = ?
        `);
        const remapTargetMemory = database.prepare(`
            UPDATE explicit_memories
            SET conversation_message_id = ?
            WHERE peer_id = ? AND conversation_message_id = ?
        `);

        for (const row of collisionRows) {
            if (!Number.isSafeInteger(nextConversationMessageId)) {
                throw new Error('Не удалось выделить безопасный conversation_message_id для новой беседы.');
            }
            const oldId = Number(row.conversation_message_id);
            const newId = nextConversationMessageId;
            nextConversationMessageId += 1;
            remapTargetMessage.run(newId, target, oldId);
            remapTargetMemory.run(newId, target, oldId);
        }

        database.prepare(`UPDATE messages SET peer_id = ? WHERE peer_id = ?`).run(target, source);
        database.prepare(`UPDATE explicit_memories SET peer_id = ? WHERE peer_id = ?`).run(target, source);
        database.prepare(`UPDATE interaction_memory SET peer_id = ? WHERE peer_id = ?`).run(target, source);
        // V177: raw VK archive and derived membership events keep their physical
        // source_peer_id but become visible through the canonical target peer.
        database.prepare(`UPDATE vk_message_archive SET peer_id = ? WHERE peer_id = ?`).run(target, source);
        database.prepare(`UPDATE chat_membership_events SET peer_id = ? WHERE peer_id = ?`).run(target, source);

        /* Досье: не теряем факты новой беседы, а объединяем одинаковые ключи. */
        const sourceFacts = database.prepare(`
            SELECT user_id, normalized_fact, fact, rating, created_at, updated_at
            FROM dossier_facts WHERE peer_id = ?
        `).all(source);
        const getTargetFact = database.prepare(`
            SELECT fact, rating, created_at, updated_at
            FROM dossier_facts
            WHERE peer_id = ? AND user_id = ? AND normalized_fact = ?
        `);
        const insertTargetFact = database.prepare(`
            INSERT INTO dossier_facts (
                peer_id, user_id, normalized_fact, fact, rating, created_at, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?)
        `);
        const updateTargetFact = database.prepare(`
            UPDATE dossier_facts
            SET fact = ?, rating = ?, created_at = ?, updated_at = ?
            WHERE peer_id = ? AND user_id = ? AND normalized_fact = ?
        `);
        for (const row of sourceFacts) {
            const existing = getTargetFact.get(target, row.user_id, row.normalized_fact);
            if (!existing) {
                insertTargetFact.run(
                    target, row.user_id, row.normalized_fact, row.fact,
                    row.rating, row.created_at, row.updated_at,
                );
                continue;
            }
            const sourceIsNewer = Number(row.updated_at) >= Number(existing.updated_at);
            updateTargetFact.run(
                sourceIsNewer ? row.fact : existing.fact,
                Math.max(Number(row.rating) || 0, Number(existing.rating) || 0),
                Math.min(Number(row.created_at) || safeMigratedAt, Number(existing.created_at) || safeMigratedAt),
                Math.max(Number(row.updated_at) || 0, Number(existing.updated_at) || 0),
                target, row.user_id, row.normalized_fact,
            );
        }
        database.prepare(`DELETE FROM dossier_facts WHERE peer_id = ?`).run(source);

        const sourceRuns = database.prepare(`
            SELECT user_id, source_day, processed_at
            FROM dossier_daily_runs WHERE peer_id = ?
        `).all(source);
        const getTargetRun = database.prepare(`
            SELECT processed_at FROM dossier_daily_runs
            WHERE peer_id = ? AND user_id = ? AND source_day = ?
        `);
        const insertTargetRun = database.prepare(`
            INSERT INTO dossier_daily_runs (peer_id, user_id, source_day, processed_at)
            VALUES (?, ?, ?, ?)
        `);
        const updateTargetRun = database.prepare(`
            UPDATE dossier_daily_runs SET processed_at = ?
            WHERE peer_id = ? AND user_id = ? AND source_day = ?
        `);
        for (const row of sourceRuns) {
            const existing = getTargetRun.get(target, row.user_id, row.source_day);
            if (!existing) {
                insertTargetRun.run(target, row.user_id, row.source_day, row.processed_at);
            } else if (Number(row.processed_at) > Number(existing.processed_at)) {
                updateTargetRun.run(row.processed_at, target, row.user_id, row.source_day);
            }
        }
        database.prepare(`DELETE FROM dossier_daily_runs WHERE peer_id = ?`).run(source);

        const sourceStyles = database.prepare(`
            SELECT user_id, profile_text, updated_at
            FROM participant_styles WHERE peer_id = ?
        `).all(source);
        const getTargetStyle = database.prepare(`
            SELECT profile_text, updated_at FROM participant_styles
            WHERE peer_id = ? AND user_id = ?
        `);
        const insertTargetStyle = database.prepare(`
            INSERT INTO participant_styles (peer_id, user_id, profile_text, updated_at)
            VALUES (?, ?, ?, ?)
        `);
        const updateTargetStyle = database.prepare(`
            UPDATE participant_styles SET profile_text = ?, updated_at = ?
            WHERE peer_id = ? AND user_id = ?
        `);
        for (const row of sourceStyles) {
            const existing = getTargetStyle.get(target, row.user_id);
            if (!existing) {
                insertTargetStyle.run(target, row.user_id, row.profile_text, row.updated_at);
            } else if (Number(row.updated_at) >= Number(existing.updated_at)) {
                updateTargetStyle.run(row.profile_text, row.updated_at, target, row.user_id);
            }
        }
        database.prepare(`DELETE FROM participant_styles WHERE peer_id = ?`).run(source);

        const sourceParticipants = database.prepare(`
            SELECT user_id, platform, external_user_id, display_name, last_seen_at
            FROM communication_participants WHERE peer_id = ?
        `).all(source);
        const getTargetParticipant = database.prepare(`
            SELECT platform, external_user_id, display_name, last_seen_at
            FROM communication_participants
            WHERE peer_id = ? AND user_id = ?
        `);
        const insertTargetParticipant = database.prepare(`
            INSERT INTO communication_participants (
                peer_id, user_id, platform, external_user_id, display_name, last_seen_at
            ) VALUES (?, ?, ?, ?, ?, ?)
        `);
        const updateTargetParticipant = database.prepare(`
            UPDATE communication_participants
            SET platform = ?, external_user_id = ?, display_name = ?, last_seen_at = ?
            WHERE peer_id = ? AND user_id = ?
        `);
        for (const row of sourceParticipants) {
            const existing = getTargetParticipant.get(target, row.user_id);
            if (!existing) {
                insertTargetParticipant.run(
                    target, row.user_id, row.platform, row.external_user_id,
                    row.display_name, row.last_seen_at,
                );
                continue;
            }
            const sourceIsNewer = Number(row.last_seen_at) >= Number(existing.last_seen_at);
            const primary = sourceIsNewer ? row : existing;
            const secondary = sourceIsNewer ? existing : row;
            updateTargetParticipant.run(
                String(primary.platform ?? secondary.platform ?? cleanPlatform),
                String(primary.external_user_id ?? '').trim() || String(secondary.external_user_id ?? ''),
                String(primary.display_name ?? '').trim() || String(secondary.display_name ?? ''),
                Math.max(Number(row.last_seen_at) || 0, Number(existing.last_seen_at) || 0),
                target,
                row.user_id,
            );
        }
        database.prepare(`DELETE FROM communication_participants WHERE peer_id = ?`).run(source);

        /*
         * V149: настройки характера, авторежима, его счётчик и выбранная
         * случайная позиция ответа продолжаются при перепривязке истории.
         * Перезапуск/обновление/миграция peer не должны менять поведение.
         */
        const sourceSettings = database.prepare(`
            SELECT * FROM communication_settings WHERE peer_id = ?
        `).get(source);
        const targetSettings = database.prepare(`
            SELECT * FROM communication_settings WHERE peer_id = ?
        `).get(target);
        if (sourceSettings) {
            const selected = targetSettings && Number(targetSettings.updated_at) > Number(sourceSettings.updated_at)
                ? targetSettings
                : sourceSettings;
            database.prepare(`DELETE FROM communication_settings WHERE peer_id IN (?, ?)`).run(source, target);
            database.prepare(`
                INSERT INTO communication_settings (
                    peer_id, platform, external_peer_id, is_group, warmth, persona,
                    next_outburst_at, last_outburst_at, last_target_user_id,
                    active_chat_enabled, active_chat_message_count, active_chat_interval,
                    active_chat_target_offset, active_chat_last_reply_at, updated_by, updated_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            `).run(
                target,
                cleanPlatform,
                cleanExternalPeerId || String(targetSettings?.external_peer_id ?? ''),
                isGroup ? 1 : 0,
                Math.min(10, Math.max(1, Number(selected.warmth) || 5)),
                String(selected.persona ?? 'neutral') || 'neutral',
                Math.max(0, Number(selected.next_outburst_at) || 0),
                Math.max(0, Number(selected.last_outburst_at) || 0),
                Math.max(0, Number(selected.last_target_user_id) || 0),
                Number(selected.active_chat_enabled) ? 1 : 0,
                Math.max(0, Number(selected.active_chat_message_count) || 0),
                Math.min(1000, Math.max(1, Number(selected.active_chat_interval) || 10)),
                Math.max(0, Number(selected.active_chat_target_offset) || 0),
                Math.max(0, Number(selected.active_chat_last_reply_at) || 0),
                Number(selected.updated_by) || 0,
                safeMigratedAt,
            );
        }

        database.prepare(`DELETE FROM communication_banter_state WHERE peer_id = ?`).run(source);

        database.prepare(`
            INSERT INTO peer_history_migrations (
                platform,
                source_peer_id,
                target_peer_id,
                source_message_count,
                target_message_count_before,
                remapped_target_message_ids,
                backup_path,
                migrated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
            cleanPlatform,
            source,
            target,
            sourceMessageCount,
            targetMessageCountBefore,
            collisionRows.length,
            backupPath,
            safeMigratedAt,
        );

        const targetMessageCountAfter = countPeerRows('messages', target);
        const expectedTargetMessageCount = sourceMessageCount + targetMessageCountBefore;
        if (targetMessageCountAfter !== expectedTargetMessageCount) {
            throw new Error(
                `Проверка переноса истории не сошлась: ожидалось ${expectedTargetMessageCount} сообщений, получено ${targetMessageCountAfter}.`,
            );
        }

        const leftoverCounts = {
            messages: countPeerRows('messages', source),
            dossierFacts: countPeerRows('dossier_facts', source),
            dossierDailyRuns: countPeerRows('dossier_daily_runs', source),
            participantStyles: countPeerRows('participant_styles', source),
            participants: countPeerRows('communication_participants', source),
            interactions: countPeerRows('interaction_memory', source),
            explicitMemories: countPeerRows('explicit_memories', source),
        };
        if (Object.values(leftoverCounts).some((count) => count !== 0)) {
            throw new Error(
                `После переноса в старом peer_id остались долговечные данные: ${JSON.stringify(leftoverCounts)}.`,
            );
        }

        database.exec('COMMIT');

        return {
            migrated: true,
            sourcePeerId: source,
            targetPeerId: target,
            platform: cleanPlatform,
            sourceMessageCount,
            targetMessageCountBefore,
            targetMessageCountAfter,
            remappedTargetMessageIds: collisionRows.length,
            backupPath,
            counts,
            verification: {
                expectedTargetMessageCount,
                targetMessageCountAfter,
                sourceLeftovers: leftoverCounts,
            },
            migratedAt: safeMigratedAt,
        };
    } catch (error) {
        database.exec('ROLLBACK');
        throw error;
    }
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
            activeChatEnabled: false,
            activeChatMessageCount: 0,
            activeChatInterval: 10,
            activeChatTargetOffset: 0,
            activeChatLastReplyAt: 0,
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
        activeChatEnabled: Boolean(row.active_chat_enabled),
        activeChatMessageCount: Number(row.active_chat_message_count ?? 0),
        activeChatInterval: Math.min(1000, Math.max(1, Number(row.active_chat_interval ?? 10) || 10)),
        activeChatTargetOffset: Math.max(0, Number(row.active_chat_target_offset ?? 0) || 0),
        activeChatLastReplyAt: Number(row.active_chat_last_reply_at ?? 0),
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
    activeChatEnabled = null,
    activeChatMessageCount = null,
    activeChatInterval = null,
    activeChatTargetOffset = null,
    activeChatLastReplyAt = null,
    updatedBy = 0,
    updatedAt = Math.floor(Date.now() / 1000),
}) {
    const safeWarmth = Math.min(10, Math.max(1, Math.round(Number(warmth) || 5)));
    const existing = getCommunicationSettings(peerId);
    const resolvedActiveChatEnabled = activeChatEnabled === null
        ? existing.activeChatEnabled
        : Boolean(activeChatEnabled);
    const resolvedActiveChatMessageCount = activeChatMessageCount === null
        ? existing.activeChatMessageCount
        : Math.max(0, Number(activeChatMessageCount) || 0);
    const resolvedActiveChatInterval = activeChatInterval === null
        ? existing.activeChatInterval
        : Math.min(1000, Math.max(1, Math.round(Number(activeChatInterval) || 10)));
    const rawTargetOffset = activeChatTargetOffset === null
        ? existing.activeChatTargetOffset
        : Math.max(0, Math.round(Number(activeChatTargetOffset) || 0));
    const resolvedActiveChatTargetOffset = rawTargetOffset > resolvedActiveChatInterval
        ? 0
        : rawTargetOffset;
    const resolvedActiveChatLastReplyAt = activeChatLastReplyAt === null
        ? existing.activeChatLastReplyAt
        : Math.max(0, Number(activeChatLastReplyAt) || 0);

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
        resolvedActiveChatEnabled ? 1 : 0,
        resolvedActiveChatMessageCount,
        resolvedActiveChatInterval,
        resolvedActiveChatTargetOffset,
        resolvedActiveChatLastReplyAt,
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

export function cleanupDisabledCommunicationAutonomy({
    updatedAt = Math.floor(Date.now() / 1000),
} = {}) {
    const safeUpdatedAt = Number(updatedAt) || Math.floor(Date.now() / 1000);
    const settingsResult = clearDisabledCommunicationSchedulesStatement.run(
        safeUpdatedAt,
    );
    const banterResult = clearDisabledCommunicationBanterStatement.run();

    return {
        settings: Number(settingsResult.changes ?? 0),
        banter: Number(banterResult.changes ?? 0),
    };
}

export function disableLegacyCommunicationOutburstAutomation({
    updatedAt = Math.floor(Date.now() / 1000),
} = {}) {
    const safeUpdatedAt = Number(updatedAt) || Math.floor(Date.now() / 1000);
    const settingsResult = clearLegacyCommunicationOutburstSchedulesStatement.run(
        safeUpdatedAt,
    );
    const banterResult = clearAllCommunicationBanterStatement.run();

    return {
        settings: Number(settingsResult.changes ?? 0),
        banter: Number(banterResult.changes ?? 0),
    };
}

export function rescheduleCommunicationOutburstsWithinWindow({
    now = Math.floor(Date.now() / 1000),
    minDelaySeconds = 60,
    maxDelaySeconds = 60 * 60,
} = {}) {
    const safeNow = Math.max(0, Number(now) || Math.floor(Date.now() / 1000));
    const safeMin = Math.max(1, Math.round(Number(minDelaySeconds) || 60));
    const safeMax = Math.max(
        safeMin,
        Math.round(Number(maxDelaySeconds) || 60 * 60),
    );
    const span = safeMax - safeMin + 1;
    const result = rescheduleLongCommunicationOutburstsStatement.run(
        safeNow,
        safeMin,
        span,
        safeNow,
        safeNow,
        safeMax,
    );

    return Number(result.changes ?? 0);
}


export function updateActiveCommunicationState({
    peerId,
    enabled,
    messageCount = 0,
    interval = null,
    targetOffset = null,
    lastReplyAt = 0,
    updatedBy = 0,
    updatedAt = Math.floor(Date.now() / 1000),
}) {
    const current = getCommunicationSettings(peerId);

    if (!current.updatedAt) {
        return saveCommunicationSettings({
            peerId,
            platform: current.platform,
            externalPeerId: current.externalPeerId,
            isGroup: current.isGroup,
            warmth: current.warmth,
            persona: current.persona,
            nextOutburstAt: current.nextOutburstAt,
            lastOutburstAt: current.lastOutburstAt,
            lastTargetUserId: current.lastTargetUserId,
            activeChatEnabled: Boolean(enabled),
            activeChatMessageCount: Math.max(0, Number(messageCount) || 0),
            activeChatInterval: interval === null ? current.activeChatInterval : interval,
            activeChatTargetOffset: targetOffset === null ? current.activeChatTargetOffset : targetOffset,
            activeChatLastReplyAt: Math.max(0, Number(lastReplyAt) || 0),
            updatedBy,
            updatedAt,
        });
    }

    const safeInterval = interval === null
        ? current.activeChatInterval
        : Math.min(1000, Math.max(1, Math.round(Number(interval) || 10)));
    const rawTarget = targetOffset === null
        ? current.activeChatTargetOffset
        : Math.max(0, Math.round(Number(targetOffset) || 0));
    const safeTarget = rawTarget > safeInterval ? 0 : rawTarget;

    updateActiveCommunicationStateStatement.run(
        enabled ? 1 : 0,
        Math.max(0, Number(messageCount) || 0),
        safeInterval,
        safeTarget,
        Math.max(0, Number(lastReplyAt) || 0),
        Number(updatedBy) || 0,
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

function mapCommunicationBanterState(row, peerId = 0, targetUserId = 0) {
    if (!row) {
        return {
            peerId: Number(peerId),
            targetUserId: Number(targetUserId),
            platform: 'vk',
            externalPeerId: '',
            targetExternalUserId: '',
            targetDisplayName: '',
            activeUntil: 0,
            lastAttackAt: 0,
            lastReplyAt: 0,
            replyCount: 0,
            lastBotText: '',
            updatedAt: 0,
        };
    }

    return {
        peerId: Number(row.peer_id),
        targetUserId: Number(row.target_user_id),
        platform: String(row.platform ?? 'vk'),
        externalPeerId: String(row.external_peer_id ?? ''),
        targetExternalUserId: String(row.target_external_user_id ?? ''),
        targetDisplayName: String(row.target_display_name ?? ''),
        activeUntil: Number(row.active_until ?? 0),
        lastAttackAt: Number(row.last_attack_at ?? 0),
        lastReplyAt: Number(row.last_reply_at ?? 0),
        replyCount: Number(row.reply_count ?? 0),
        lastBotText: String(row.last_bot_text ?? ''),
        updatedAt: Number(row.updated_at ?? 0),
    };
}

export function getCommunicationBanterState(peerId, targetUserId) {
    return mapCommunicationBanterState(
        selectCommunicationBanterStateStatement.get(
            Number(peerId),
            Number(targetUserId),
        ),
        peerId,
        targetUserId,
    );
}

export function saveCommunicationBanterState({
    peerId,
    targetUserId,
    platform = 'vk',
    externalPeerId = '',
    targetExternalUserId = '',
    targetDisplayName = '',
    activeUntil = 0,
    lastAttackAt = 0,
    lastReplyAt = 0,
    replyCount = 0,
    lastBotText = '',
    updatedAt = Math.floor(Date.now() / 1000),
}) {
    upsertCommunicationBanterStateStatement.run(
        Number(peerId),
        Number(targetUserId),
        String(platform ?? 'vk'),
        String(externalPeerId ?? ''),
        String(targetExternalUserId ?? ''),
        String(targetDisplayName ?? '').replace(/\s+/gu, ' ').trim().slice(0, 120),
        Math.max(0, Number(activeUntil) || 0),
        Math.max(0, Number(lastAttackAt) || 0),
        Math.max(0, Number(lastReplyAt) || 0),
        Math.max(0, Number(replyCount) || 0),
        String(lastBotText ?? '').trim().slice(0, 1000),
        Number(updatedAt) || Math.floor(Date.now() / 1000),
    );

    return getCommunicationBanterState(peerId, targetUserId);
}

export function clearCommunicationBanterState(peerId, targetUserId) {
    return Number(deleteCommunicationBanterStateStatement.run(
        Number(peerId),
        Number(targetUserId),
    ).changes ?? 0);
}

export function clearCommunicationBanterStatesForPeer(peerId) {
    return Number(deleteCommunicationBanterStatesByPeerStatement.run(
        Number(peerId),
    ).changes ?? 0);
}

export function saveManualEvent({
    title,
    eventDate,
    eventTime = null,
    venue,
    participants = '',
    price = '',
    description = '',
    evidence = '',
    sourceUrl = '',
    sourceText = '',
    imagePaths = [],
    status = 'approved',
    createdByPlatform = 'vk',
    createdBy = 0,
    createdAt = Math.floor(Date.now() / 1000),
    updatedAt = Math.floor(Date.now() / 1000),
    canonicalPostUrl = '',
    provenanceSourceType = 'manual',
    sourceChatId = 0,
    sourceChatName = '',
    sourceMessageId = 0,
    sourceItemId = '',
    sourceOriginalUrl = '',
    canonicalOrigin = '',
    posterMatchStatus = '',
    posterMatchReason = '',
    posterImageIndex = 0,
    posterVisionFacts = [],
    eventTags = [],
    venueSource = '',
    ownerManual = false,
}) {
    const permanentCheck = filterPermanentlyBlockedIncomingEvents([{
        title, eventDate, eventTime, venue, participants, price, description, evidence,
        sourceUrl, sourceText, imagePaths, canonicalPostUrl, provenanceSourceType,
        sourceItemId, sourceOriginalUrl, posterVisionFacts, eventTags,
    }], {
        sourceType: 'manual',
        sourceUrl,
        canonicalPostUrl,
        sourceItemId,
        sourceOriginalUrl,
        sourceText,
        posterVisionFacts,
    });
    if (!permanentCheck.events.length) return 0;

    const result = insertManualEventStatement.run(
        String(title ?? '').trim(),
        String(eventDate ?? '').trim(),
        eventTime ? String(eventTime).trim() : null,
        normalizedPersistedVenue(venue),
        String(participants ?? '').trim(),
        String(price ?? '').trim(),
        String(description ?? '').trim(),
        String(evidence ?? '').trim(),
        String(sourceUrl ?? '').trim(),
        String(sourceText ?? '').trim(),
        JSON.stringify(Array.isArray(imagePaths) ? imagePaths : []),
        ['approved', 'pending', 'ignored'].includes(status) ? status : 'approved',
        String(createdByPlatform ?? 'vk'),
        Number(createdBy) || 0,
        Number(createdAt) || Math.floor(Date.now() / 1000),
        Number(updatedAt) || Math.floor(Date.now() / 1000),
    );

    const id = Number(result.lastInsertRowid ?? 0);
    if (id > 0) {
        database.prepare('UPDATE manual_events SET owner_manual = ? WHERE id = ?').run(ownerManual ? 1 : 0, id);
    }
    const resolvedCanonicalPostUrl = String(canonicalPostUrl || '').trim() ||
        canonicalVkWallUrlForDb(sourceUrl) || canonicalTelegramUrlForDb(sourceUrl);
    writeEventV18867Metadata('manual_events', id, {
        venue: normalizedPersistedVenue(venue),
        canonicalPostUrl: resolvedCanonicalPostUrl,
        provenanceSourceType,
        sourceChatId,
        sourceChatName,
        sourceMessageId,
        sourceItemId: sourceItemId || `manual:${id}`,
        sourceOriginalUrl: sourceOriginalUrl || sourceUrl,
        canonicalOrigin: canonicalOrigin || (resolvedCanonicalPostUrl ? 'manual-linked-post' : 'manual'),
        posterMatchStatus,
        posterMatchReason,
        posterImageIndex,
        posterVisionFacts,
        eventTags,
        venueSource,
    }, { sourceType: 'manual' });
    return id;
}

function parseQticketsJsonArray(value) {
    try {
        const parsed = JSON.parse(String(value ?? '[]'));
        return Array.isArray(parsed)
            ? parsed.map((item) => String(item ?? '').trim()).filter(Boolean)
            : [];
    } catch {
        return [];
    }
}

const QTICKETS_DISPLAY_MONTHS = [
    'января', 'февраля', 'марта', 'апреля', 'мая', 'июня',
    'июля', 'августа', 'сентября', 'октября', 'ноября', 'декабря',
];

function formatQticketsDisplayDate(dateLabel, eventDate) {
    const label = String(dateLabel ?? '').trim();
    if (label && !/^\d{4}-\d{2}-\d{2}(?:T|$)/u.test(label)) return label;

    const match = String(eventDate ?? '').trim().match(/^(\d{4})-(\d{2})-(\d{2})$/u);
    if (!match) return label || String(eventDate ?? '').trim();

    const month = QTICKETS_DISPLAY_MONTHS[Number(match[2]) - 1];
    return month
        ? `${Number(match[3])} ${month} ${match[1]}`
        : label || String(eventDate ?? '').trim();
}

function mapQticketsEventRow(row) {
    const detailUrl = String(row?.detail_url ?? '').trim();
    const eventDate = String(row?.event_date ?? '').trim();
    const eventEndDate = String(row?.event_end_date ?? '').trim() || eventDate;
    const dateLabel = String(row?.date_label ?? '').trim() || eventDate;
    const displayDate = formatQticketsDisplayDate(dateLabel, eventDate);
    const imagePaths = parseQticketsJsonArray(row?.image_paths_json);
    return {
        id: Number(row?.id ?? 0),
        sourceType: 'qtickets',
        provenanceSourceType: 'qtickets',
        sourceName: 'QTickets — Воронеж',
        sourceItemId: String(row?.external_id ?? '').trim() || detailUrl,
        sourceOriginalUrl: detailUrl,
        canonicalPostUrl: detailUrl,
        canonicalOrigin: 'qtickets-detail-page',
        venueSource: 'qtickets-detail-page',
        detailUrl,
        externalId: String(row?.external_id ?? '').trim(),
        listingUrl: String(row?.listing_url ?? '').trim(),
        title: String(row?.title ?? '').trim(),
        eventDate,
        eventEndDate,
        eventTime: row?.event_time ? String(row.event_time) : null,
        dateLabel,
        displayDate,
        rawDate: dateLabel,
        venue: String(row?.venue ?? '').trim() || 'место не указано',
        participants: String(row?.participants ?? '').trim(),
        price: String(row?.price ?? '').trim(),
        eventType: String(row?.event_type ?? '').trim(),
        ageRestriction: String(row?.age_restriction ?? '').trim(),
        description: String(row?.description ?? '').trim(),
        evidence: String(row?.evidence ?? '').trim(),
        sourceText: String(row?.source_text ?? '').trim(),
        sourceUrl: detailUrl,
        ticketUrl: String(row?.ticket_url ?? '').trim(),
        imageUrls: parseQticketsJsonArray(row?.image_urls_json),
        imagePaths,
        posterMatchStatus: imagePaths.length
            ? 'legacy_manual_poster'
            : '',
        posterMatchReason: imagePaths.length
            ? 'qtickets-detail-image'
            : '',
        posterImageIndex: imagePaths.length ? 1 : 0,
        parseMethod: String(row?.parse_method ?? '').trim(),
        status: String(row?.status ?? 'approved').trim(),
        updatedAt: Number(row?.updated_at ?? 0),
    };
}

export function repairQticketsSinglePosterV18885() {
    const rows = qticketsDatabase.prepare(`SELECT id, image_paths_json FROM qtickets_events WHERE status IN ('approved', 'pending')`).all();
    const update = qticketsDatabase.prepare(`UPDATE qtickets_events SET image_paths_json = ?, updated_at = ? WHERE id = ?`);
    let repaired = 0; const now = Math.floor(Date.now() / 1000);
    qticketsDatabase.exec('BEGIN IMMEDIATE');
    try {
        for (const row of rows) {
            const paths = parseQticketsJsonArray(row.image_paths_json);
            if (paths.length <= 1) continue;
            // Keep the first already-working poster untouched; remove only the
            // trailing page-gallery/banner bindings. Source URL evidence stays.
            update.run(JSON.stringify(paths.slice(0, 1)), now, Number(row.id));
            repaired += 1;
        }
        qticketsDatabase.exec('COMMIT');
    } catch (error) { qticketsDatabase.exec('ROLLBACK'); throw error; }
    return { scanned: rows.length, repaired };
}

/**
 * Атомарно обновляет отдельный контур QTickets. Пустой снимок ничего не
 * скрывает: временная ошибка сайта не должна удалять всю локальную афишу.
 */
export function replaceQticketsEvents(events = [], {
    listingUrl = '',
    updatedAt = Math.floor(Date.now() / 1000),
} = {}) {
    const source = Array.isArray(events) ? events : [];
    const uniqueEvents = [];
    const seenUrls = new Set();
    for (const event of source) {
        const detailUrl = String(event?.detailUrl || event?.sourceUrl || '').trim();
        if (!detailUrl || seenUrls.has(detailUrl)) continue;
        seenUrls.add(detailUrl);
        uniqueEvents.push({ ...event, detailUrl });
    }
    if (!uniqueEvents.length) {
        return { seen: 0, inserted: 0, updated: 0, ignored: 0 };
    }

    const now = Number(updatedAt) || Math.floor(Date.now() / 1000);
    let inserted = 0;
    let updated = 0;
    let ignored = 0;
    qticketsDatabase.exec('BEGIN IMMEDIATE');
    try {
        for (const event of uniqueEvents) {
            const detailUrl = String(event.detailUrl).trim();
            const permanent = filterPermanentlyBlockedIncomingEvents([{
                ...event,
                sourceType: 'qtickets',
                sourceUrl: detailUrl,
                canonicalPostUrl: detailUrl,
                sourceItemId: String(event?.externalId || detailUrl),
            }], { sourceType: 'qtickets', sourceUrl: detailUrl, canonicalPostUrl: detailUrl }).blocked[0];
            if (permanent) {
                const existingBlocked = selectQticketsEventIdStatement.get(detailUrl);
                if (existingBlocked?.id) {
                    qticketsDatabase.prepare(`UPDATE qtickets_events SET status = 'ignored', updated_at = ? WHERE id = ?`).run(now, Number(existingBlocked.id));
                }
                ignored += 1;
                continue;
            }
            const existing = selectQticketsEventIdStatement.get(detailUrl);
            const imagePaths = Array.isArray(event?.imagePaths)
                ? event.imagePaths.map((item) => String(item ?? '').trim()).filter(Boolean)
                : [];
            const imageUrls = Array.isArray(event?.imageUrls)
                ? event.imageUrls.map((item) => String(item ?? '').trim()).filter(Boolean)
                : [];
            upsertQticketsEventStatement.run(
                String(event?.externalId ?? detailUrl).trim(),
                detailUrl,
                String(event?.listingUrl || listingUrl || '').trim(),
                String(event?.title ?? '').trim() || 'Мероприятие',
                String(event?.eventDate ?? '').trim(),
                String(event?.eventTime ?? '').trim() || null,
                String(event?.eventEndDate ?? event?.eventDate ?? '').trim(),
                String(event?.dateLabel ?? event?.displayDate ?? event?.eventDate ?? '').trim(),
                String(event?.venue ?? '').trim() || 'место не указано',
                String(event?.participants ?? '').trim(),
                String(event?.price ?? '').trim(),
                String(event?.eventType ?? '').trim(),
                String(event?.ageRestriction ?? '').trim(),
                String(event?.description ?? '').trim(),
                String(event?.evidence ?? '').trim(),
                String(event?.sourceText ?? '').trim(),
                String(event?.ticketUrl ?? '').trim(),
                JSON.stringify(imageUrls),
                JSON.stringify(imagePaths),
                String(event?.parseMethod ?? 'qtickets-detail-page-v1').trim(),
                now,
                now,
            );
            if (existing) updated += 1;
            else inserted += 1;
        }

        const activeListingUrls = [...new Set([
            String(listingUrl ?? '').trim(),
            ...uniqueEvents.map((event) => String(event?.listingUrl ?? '').trim()),
        ].filter(Boolean))];
        const activeDetailUrls = [...seenUrls];
        if (activeListingUrls.length && activeDetailUrls.length) {
            const placeholders = activeDetailUrls.map(() => '?').join(', ');
            const statement = qticketsDatabase.prepare(`
                UPDATE qtickets_events
                SET status = 'ignored', updated_at = ?
                WHERE listing_url IN (${activeListingUrls.map(() => '?').join(', ')})
                  AND status = 'approved'
                  AND detail_url NOT IN (${placeholders})
            `);
            const result = statement.run(
                now,
                ...activeListingUrls,
                ...activeDetailUrls,
            );
            ignored = Number(result.changes ?? 0);
        }
        qticketsDatabase.exec('COMMIT');
    } catch (error) {
        qticketsDatabase.exec('ROLLBACK');
        throw error;
    }

    return {
        seen: uniqueEvents.length,
        inserted,
        updated,
        ignored,
    };
}

export function getQticketsUpcomingEvents({
    fromDate = '0000-00-00',
    limit = 500,
} = {}) {
    const rows = qticketsDatabase.prepare(`
        SELECT id, external_id, detail_url, listing_url, title, event_date,
               event_time, event_end_date, date_label, venue, participants,
               price, event_type, age_restriction, description, evidence,
               source_text, ticket_url, image_urls_json, image_paths_json,
               status, parse_method, updated_at
        FROM qtickets_events
        WHERE status = 'approved'
          AND event_date >= ?
        ORDER BY event_date ASC,
                 COALESCE(event_time, '23:59') ASC,
                 id ASC
        LIMIT ?
    `).all(
        String(fromDate ?? '0000-00-00').trim() || '0000-00-00',
        Math.min(2000, Math.max(1, Number(limit) || 500)),
    );
    return rows.map(mapQticketsEventRow);
}

export function createEventProposal({
    submitterPlatform = 'vk',
    submitterExternalId = '',
    submitterInternalId = 0,
    rawSubmission = '',
    sourceUrl = '',
    parsedEvents = [],
    submittedAt = Math.floor(Date.now() / 1000),
    expiresAt = Math.floor(Date.now() / 1000) + 24 * 60 * 60,
}) {
    const result = database.prepare(`
        INSERT INTO event_proposals (
            submitter_platform, submitter_external_id, submitter_internal_id,
            raw_submission, source_url, parsed_events_json, status,
            submitted_at, expires_at, resolved_at, reviewed_by_platform, reviewed_by
        ) VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, ?, 0, '', 0)
    `).run(
        String(submitterPlatform ?? 'vk'),
        String(submitterExternalId ?? ''),
        Number(submitterInternalId) || 0,
        String(rawSubmission ?? '').trim(),
        String(sourceUrl ?? '').trim(),
        JSON.stringify(Array.isArray(parsedEvents) ? parsedEvents : []),
        Number(submittedAt) || Math.floor(Date.now() / 1000),
        Number(expiresAt) || (Math.floor(Date.now() / 1000) + 24 * 60 * 60),
    );
    return Number(result.lastInsertRowid ?? 0);
}

function mapEventProposalRow(row) {
    if (!row) return null;
    let parsedEvents = [];
    try {
        const parsed = JSON.parse(row.parsed_events_json ?? '[]');
        parsedEvents = Array.isArray(parsed) ? parsed : [];
    } catch {
        parsedEvents = [];
    }
    return {
        id: Number(row.id),
        submitterPlatform: String(row.submitter_platform ?? ''),
        submitterExternalId: String(row.submitter_external_id ?? ''),
        submitterInternalId: Number(row.submitter_internal_id ?? 0),
        rawSubmission: String(row.raw_submission ?? ''),
        sourceUrl: String(row.source_url ?? ''),
        parsedEvents,
        status: String(row.status ?? 'pending'),
        submittedAt: Number(row.submitted_at ?? 0),
        expiresAt: Number(row.expires_at ?? 0),
        resolvedAt: Number(row.resolved_at ?? 0),
        reviewedByPlatform: String(row.reviewed_by_platform ?? ''),
        reviewedBy: Number(row.reviewed_by ?? 0),
    };
}

export function getEventProposal(id) {
    return mapEventProposalRow(database.prepare(`
        SELECT * FROM event_proposals WHERE id = ? LIMIT 1
    `).get(Number(id)));
}

export function getLatestPendingEventProposal() {
    return mapEventProposalRow(database.prepare(`
        SELECT * FROM event_proposals
        WHERE status = 'pending'
        ORDER BY id DESC
        LIMIT 1
    `).get());
}

export function getDueEventProposals(now = Math.floor(Date.now() / 1000), limit = 50) {
    return database.prepare(`
        SELECT * FROM event_proposals
        WHERE status = 'pending' AND expires_at <= ?
        ORDER BY expires_at ASC, id ASC
        LIMIT ?
    `).all(
        Number(now) || Math.floor(Date.now() / 1000),
        Math.min(500, Math.max(1, Number(limit) || 50)),
    ).map(mapEventProposalRow);
}

export function resolveEventProposal({
    id,
    status,
    reviewedByPlatform = '',
    reviewedBy = 0,
    resolvedAt = Math.floor(Date.now() / 1000),
}) {
    const safeStatus = ['approved', 'rejected', 'auto_approved'].includes(status)
        ? status
        : 'rejected';
    database.prepare(`
        UPDATE event_proposals
        SET status = ?, resolved_at = ?, reviewed_by_platform = ?, reviewed_by = ?
        WHERE id = ? AND status = 'pending'
    `).run(
        safeStatus,
        Number(resolvedAt) || Math.floor(Date.now() / 1000),
        String(reviewedByPlatform ?? ''),
        Number(reviewedBy) || 0,
        Number(id),
    );
    return getEventProposal(id);
}

export function getManualEventsBySourceUrl(sourceUrl) {
    const url = String(sourceUrl ?? '').trim();
    if (!url) return [];
    return database.prepare(`
        SELECT id, title, event_date, event_time, venue, participants, price,
               description, evidence, source_url, source_text, image_paths_json,
               status, created_by_platform, created_by, created_at, updated_at, owner_manual
        FROM manual_events
        WHERE source_url = ? AND status IN ('approved', 'pending')
        ORDER BY id ASC
    `).all(url).map((row) => {
        let imagePaths = [];
        try {
            const parsed = JSON.parse(row.image_paths_json ?? '[]');
            imagePaths = Array.isArray(parsed) ? parsed : [];
        } catch {
            imagePaths = [];
        }
        return {
            id: Number(row.id),
            title: String(row.title ?? ''),
            eventDate: String(row.event_date ?? ''),
            eventTime: row.event_time ? String(row.event_time) : null,
            venue: String(row.venue ?? ''),
            participants: String(row.participants ?? ''),
            price: String(row.price ?? ''),
            description: String(row.description ?? ''),
            evidence: String(row.evidence ?? ''),
            sourceUrl: String(row.source_url ?? ''),
            sourceText: String(row.source_text ?? ''),
            imagePaths,
            status: String(row.status ?? ''),
            ownerManual: Boolean(row.owner_manual),
            createdByPlatform: String(row.created_by_platform ?? ''),
            createdBy: Number(row.created_by ?? 0),
            createdAt: Number(row.created_at ?? 0),
            updatedAt: Number(row.updated_at ?? 0),
        };
    });
}

export function ignoreManualEventsBySourceUrl(sourceUrl, updatedAt = Math.floor(Date.now() / 1000)) {
    const url = String(sourceUrl ?? '').trim();
    if (!url) return 0;
    const result = database.prepare(`
        UPDATE manual_events
        SET status = 'ignored', updated_at = ?
        WHERE source_url = ? AND status IN ('approved', 'pending')
    `).run(Number(updatedAt) || Math.floor(Date.now() / 1000), url);
    return Number(result.changes ?? 0);
}

export function getManualUpcomingEvents(
    fromDate = new Date().toISOString().slice(0, 10),
    limit = 100,
) {
    return selectManualUpcomingEventsStatement
        .all(
            String(fromDate ?? '').trim(),
            Math.min(500, Math.max(1, Number(limit) || 100)),
        )
        .map((row) => {
            let imagePaths = [];
            try {
                imagePaths = JSON.parse(row.image_paths_json ?? '[]');
            } catch {
                imagePaths = [];
            }
            return {
                id: Number(row.id),
                title: String(row.title ?? ''),
                eventDate: String(row.event_date ?? ''),
                eventTime: row.event_time ? String(row.event_time) : null,
                venue: String(row.venue ?? ''),
                participants: String(row.participants ?? ''),
                price: String(row.price ?? ''),
                description: String(row.description ?? ''),
                evidence: String(row.evidence ?? ''),
                sourceUrl: String(row.source_url ?? ''),
                imagePaths,
                parseMethod: 'manual_owner_strict',
                status: String(row.status ?? 'approved'),
                sourceType: 'manual',
                ...readEventV18867MetadataForType('manual', row.id),
                sourceName: 'добавлено владельцем',
            };
        });
}


export function replaceAllPartyMetadata(records = [], {
    updatedAt = Math.floor(Date.now() / 1000),
} = {}) {
    const source = Array.isArray(records) ? records : [];
    const upsert = database.prepare(`
        INSERT INTO all_party_metadata (
            source_type, event_id, party_pool, title, event_date, venue,
            source_url, title_tokens_json, venue_key, tags_json, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(source_type, event_id) DO UPDATE SET
            party_pool = excluded.party_pool,
            title = excluded.title,
            event_date = excluded.event_date,
            venue = excluded.venue,
            source_url = excluded.source_url,
            title_tokens_json = excluded.title_tokens_json,
            venue_key = excluded.venue_key,
            tags_json = excluded.tags_json,
            updated_at = excluded.updated_at
    `);
    const seen = [];
    database.exec('BEGIN IMMEDIATE');
    try {
        for (const record of source) {
            const sourceType = String(record?.sourceType ?? '').trim().toLowerCase();
            const eventId = Number(record?.eventId ?? 0);
            if (!sourceType || !Number.isInteger(eventId) || eventId <= 0) continue;
            upsert.run(
                sourceType,
                eventId,
                String(record?.partyPool ?? '').trim().toLowerCase(),
                String(record?.title ?? '').trim(),
                String(record?.eventDate ?? '').trim(),
                String(record?.venue ?? '').trim(),
                String(record?.sourceUrl ?? '').trim(),
                JSON.stringify(Array.isArray(record?.titleTokens) ? record.titleTokens : []),
                String(record?.venueKey ?? '').trim(),
                JSON.stringify(Array.isArray(record?.tags) ? record.tags : []),
                Number(updatedAt) || Math.floor(Date.now() / 1000),
            );
            seen.push(`${sourceType}:${eventId}`);
        }
        // Удаляем только устаревшие будущие metadata rows. Источники событий
        // остаются нетронутыми; таблица — производный индекс.
        if (seen.length) {
            const placeholders = seen.map(() => '?').join(',');
            database.prepare(`
                DELETE FROM all_party_metadata
                WHERE (source_type || ':' || event_id) NOT IN (${placeholders})
            `).run(...seen);
        } else {
            database.prepare('DELETE FROM all_party_metadata').run();
        }
        database.exec('COMMIT');
    } catch (error) {
        database.exec('ROLLBACK');
        throw error;
    }
    return { stored: seen.length };
}

export function getAllPartyMetadata({ fromDate = '0000-00-00', toDate = '9999-12-31' } = {}) {
    const rows = database.prepare(`
        SELECT source_type, event_id, party_pool, title, event_date, venue,
               source_url, title_tokens_json, venue_key, tags_json, updated_at
        FROM all_party_metadata
        WHERE event_date >= ? AND event_date <= ?
        ORDER BY event_date ASC, source_type ASC, event_id ASC
    `).all(
        String(fromDate ?? '0000-00-00').trim() || '0000-00-00',
        String(toDate ?? '9999-12-31').trim() || '9999-12-31',
    );
    return rows.map((row) => {
        let titleTokens = [];
        try {
            const parsed = JSON.parse(String(row.title_tokens_json ?? '[]'));
            if (Array.isArray(parsed)) titleTokens = parsed.map((item) => String(item ?? '').trim()).filter(Boolean);
        } catch {}
        let tags = [];
        try {
            const parsedTags = JSON.parse(String(row.tags_json ?? '[]'));
            if (Array.isArray(parsedTags)) tags = parsedTags.map((item) => String(item ?? '').trim()).filter(Boolean);
        } catch {}
        return {
            sourceType: String(row.source_type ?? ''),
            eventId: Number(row.event_id ?? 0),
            partyPool: String(row.party_pool ?? ''),
            title: String(row.title ?? ''),
            eventDate: String(row.event_date ?? ''),
            venue: String(row.venue ?? ''),
            sourceUrl: String(row.source_url ?? ''),
            titleTokens,
            venueKey: String(row.venue_key ?? ''),
            tags,
            updatedAt: Number(row.updated_at ?? 0),
        };
    });
}

export function getAllUpcomingEventRecordsForDedupe({
    fromDate = currentIsoDate(),
    limitPerTable = 5000,
} = {}) {
    const safeDate = String(fromDate ?? currentIsoDate()).trim();
    const safeLimit = Math.min(20_000, Math.max(1, Number(limitPerTable) || 5000));
    const parseImages = (value) => {
        try {
            const parsed = JSON.parse(value ?? '[]');
            return Array.isArray(parsed)
                ? parsed.map((item) => String(item ?? '').trim()).filter(Boolean)
                : [];
        } catch {
            return [];
        }
    };

    const telegram = database.prepare(`
        SELECT id, channel, message_id, event_index, title, event_date, event_time,
               venue, participants, price, description, source_url,
               image_paths_json, parse_method, status
        FROM telegram_events
        WHERE status IN ('approved', 'pending')
          AND event_date >= ?
        ORDER BY event_date ASC, COALESCE(event_time, '23:59') ASC, id ASC
        LIMIT ?
    `).all(safeDate, safeLimit).map((row) => ({
        id: Number(row.id),
        sourceType: 'telegram',
        ...readEventV18867MetadataForType('telegram', row.id),
        sourceName: `@${String(row.channel ?? '')}`,
        channel: String(row.channel ?? ''),
        messageId: Number(row.message_id ?? 0),
        eventIndex: Number(row.event_index ?? 0),
        title: String(row.title ?? ''),
        eventDate: String(row.event_date ?? ''),
        eventTime: row.event_time ? String(row.event_time) : null,
        venue: String(row.venue ?? ''),
        participants: String(row.participants ?? ''),
        price: String(row.price ?? ''),
        description: String(row.description ?? ''),
        sourceUrl: String(row.source_url ?? ''),
        imagePaths: parseImages(row.image_paths_json),
        parseMethod: String(row.parse_method ?? ''),
        status: String(row.status ?? ''),
    }));

    const vk = database.prepare(`
        SELECT id, screen_name, post_id, event_index, title, event_date, event_time,
               venue, participants, price, description, source_url,
               image_paths_json, parse_method, status
        FROM vk_events
        WHERE status IN ('approved', 'pending')
          AND event_date >= ?
        ORDER BY event_date ASC, COALESCE(event_time, '23:59') ASC, id ASC
        LIMIT ?
    `).all(safeDate, safeLimit).map((row) => ({
        id: Number(row.id),
        sourceType: 'vk',
        ...readEventV18867MetadataForType('vk', row.id),
        sourceName: String(row.screen_name ?? ''),
        screenName: String(row.screen_name ?? ''),
        postId: Number(row.post_id ?? 0),
        eventIndex: Number(row.event_index ?? 0),
        title: String(row.title ?? ''),
        eventDate: String(row.event_date ?? ''),
        eventTime: row.event_time ? String(row.event_time) : null,
        venue: String(row.venue ?? ''),
        participants: String(row.participants ?? ''),
        price: String(row.price ?? ''),
        description: String(row.description ?? ''),
        sourceUrl: String(row.source_url ?? ''),
        imagePaths: parseImages(row.image_paths_json),
        parseMethod: String(row.parse_method ?? ''),
        status: String(row.status ?? ''),
    }));

    const vkChat = database.prepare(`
        SELECT events.id, events.peer_id, events.conversation_message_id,
               events.event_index, source.conversation_name,
               events.title, events.event_date, events.event_time,
               events.venue, events.participants, events.price,
               events.description, events.source_url, events.image_paths_json,
               events.parse_method, events.status
        FROM vk_chat_events AS events
        LEFT JOIN vk_chat_source_messages AS source
          ON source.peer_id = events.peer_id
         AND source.conversation_message_id = events.conversation_message_id
        WHERE events.status IN ('approved', 'pending')
          AND events.event_date >= ?
        ORDER BY events.event_date ASC, COALESCE(events.event_time, '23:59') ASC, events.id ASC
        LIMIT ?
    `).all(safeDate, safeLimit).map((row) => ({
        id: Number(row.id),
        sourceType: 'vk_chat',
        ...readEventV18867MetadataForType('vk_chat', row.id),
        sourceName: String(row.conversation_name ?? `Беседа ${row.peer_id}`),
        peerId: Number(row.peer_id ?? 0),
        conversationMessageId: Number(row.conversation_message_id ?? 0),
        eventIndex: Number(row.event_index ?? 0),
        title: String(row.title ?? ''),
        eventDate: String(row.event_date ?? ''),
        eventTime: row.event_time ? String(row.event_time) : null,
        venue: String(row.venue ?? ''),
        participants: String(row.participants ?? ''),
        price: String(row.price ?? ''),
        description: String(row.description ?? ''),
        sourceUrl: String(row.source_url ?? ''),
        imagePaths: parseImages(row.image_paths_json),
        parseMethod: String(row.parse_method ?? ''),
        status: String(row.status ?? ''),
    }));

    const manual = database.prepare(`
        SELECT id, title, event_date, event_time, venue, participants, price,
               description, evidence, source_url, image_paths_json, status, owner_manual
        FROM manual_events
        WHERE status IN ('approved', 'pending')
          AND event_date >= ?
        ORDER BY event_date ASC, COALESCE(event_time, '23:59') ASC, id ASC
        LIMIT ?
    `).all(safeDate, safeLimit).map((row) => ({
        id: Number(row.id),
        sourceType: 'manual',
        ...readEventV18867MetadataForType('manual', row.id),
        sourceName: 'добавлено владельцем',
        title: String(row.title ?? ''),
        eventDate: String(row.event_date ?? ''),
        eventTime: row.event_time ? String(row.event_time) : null,
        venue: String(row.venue ?? ''),
        participants: String(row.participants ?? ''),
        price: String(row.price ?? ''),
        description: String(row.description ?? ''),
        evidence: String(row.evidence ?? ''),
        sourceUrl: String(row.source_url ?? ''),
        imagePaths: parseImages(row.image_paths_json),
        parseMethod: 'manual_owner_strict',
        ownerManual: Boolean(row.owner_manual),
        status: String(row.status ?? ''),
    }));

    return [...telegram, ...vk, ...vkChat, ...manual];
}


const V18877_STARTUP_POSTER_REPAIR_MIGRATION_KEY = 'events-v18877-startup-poster-vision-repair-v1';

export function isStartupPosterRepairV18877Complete() {
    return Boolean(database.prepare(
        'SELECT 1 FROM bot_code_migrations WHERE migration_key = ? LIMIT 1',
    ).get(V18877_STARTUP_POSTER_REPAIR_MIGRATION_KEY));
}

export function markStartupPosterRepairV18877Complete() {
    database.prepare(`
        INSERT OR IGNORE INTO bot_code_migrations (migration_key, applied_at)
        VALUES (?, ?)
    `).run(V18877_STARTUP_POSTER_REPAIR_MIGRATION_KEY, Math.floor(Date.now() / 1000));
    return true;
}

const V18883_STARTUP_MEDIA_REPAIR_MIGRATION_KEY = 'events-v18886-source-only-media-repair-v3';

export function isStartupMediaRepairV18883Complete() {
    return Boolean(database.prepare(
        'SELECT 1 FROM bot_code_migrations WHERE migration_key = ? LIMIT 1',
    ).get(V18883_STARTUP_MEDIA_REPAIR_MIGRATION_KEY));
}

export function markStartupMediaRepairV18883Complete() {
    database.prepare(`
        INSERT OR IGNORE INTO bot_code_migrations (migration_key, applied_at)
        VALUES (?, ?)
    `).run(V18883_STARTUP_MEDIA_REPAIR_MIGRATION_KEY, Math.floor(Date.now() / 1000));
    return true;
}

function parseStoredPosterFacts(value) {
    try {
        const parsed = JSON.parse(value ?? '[]');
        return Array.isArray(parsed) ? parsed : [];
    } catch {
        return [];
    }
}

/**
 * V188.77 one-time startup poster repair input.
 *
 * Source media stays lossless in the source tables even when V188.73 cleared an
 * unsafe event-level image binding. Return whole source groups so the runtime
 * can run one vision pass per source and do a global one-to-one image↔event
 * assignment for multi-announcement posts.
 */
export function getStartupPosterRepairGroupsV18877({
    fromDate = currentIsoDate(),
    limitPerTable = 5000,
} = {}) {
    const safeDate = String(fromDate ?? currentIsoDate()).trim();
    const safeLimit = Math.min(20_000, Math.max(1, Number(limitPerTable) || 5000));
    const groups = [];

    const buildEvent = (row, sourceType) => ({
        id: Number(row.id),
        sourceType,
        title: String(row.title ?? ''),
        eventDate: String(row.event_date ?? ''),
        eventTime: row.event_time ? String(row.event_time) : null,
        venue: String(row.venue ?? ''),
        participants: String(row.participants ?? ''),
        description: String(row.description ?? ''),
        sourceUrl: String(row.source_url ?? ''),
        imagePaths: parseStoredImagePaths(row.event_image_paths_json),
        posterMatchStatus: String(row.poster_match_status ?? ''),
        posterMatchReason: String(row.poster_match_reason ?? ''),
        posterImageIndex: Number(row.poster_image_index ?? 0),
        posterVisionFacts: parseStoredPosterFacts(row.poster_vision_facts_json),
        parseMethod: String(row.parse_method ?? ''),
    });

    const vkRows = database.prepare(`
        SELECT e.id, e.screen_name, e.post_id, e.event_index, e.title, e.event_date,
               e.event_time, e.venue, e.participants, e.description, e.source_url,
               e.image_paths_json AS event_image_paths_json, e.parse_method,
               e.poster_match_status, e.poster_match_reason, e.poster_image_index,
               e.poster_vision_facts_json,
               s.raw_text, s.image_urls_json, s.image_paths_json AS source_image_paths_json,
               s.image_vision_facts_json, s.image_vision_status_json, s.image_media_json
        FROM vk_events e
        JOIN vk_source_posts s
          ON s.screen_name = e.screen_name AND s.post_id = e.post_id
        WHERE e.status IN ('approved', 'pending') AND e.event_date >= ?
        ORDER BY e.screen_name, e.post_id, e.event_index, e.id
        LIMIT ?
    `).all(safeDate, safeLimit);
    const vkByKey = new Map();
    for (const row of vkRows) {
        const key = `${row.screen_name}:${row.post_id}`;
        let group = vkByKey.get(key);
        if (!group) {
            const urls = safeStoredJsonArray(row.image_urls_json).map(String).filter(Boolean);
            const storedPaths = parseStoredImagePaths(row.source_image_paths_json);
            const paths = recoverIndexedLegacyMediaPaths(storedPaths, urls, {
                relativeDirectory: `vk_announcements/${String(row.screen_name || '').trim()}`,
                itemId: String(row.post_id || ''),
            });
            group = {
                sourceType: 'vk', sourceKey: key,
                screenName: String(row.screen_name ?? ''), postId: Number(row.post_id ?? 0),
                rawText: String(row.raw_text ?? ''), imageUrls: urls, imagePaths: paths,
                imageVisionFacts: parseStoredPosterFacts(row.image_vision_facts_json),
                imageVisionStatuses: parseStoredPosterFacts(row.image_vision_status_json),
                imageMedia: parseStoredPosterFacts(row.image_media_json), events: [],
            };
            vkByKey.set(key, group);
        }
        group.events.push(buildEvent(row, 'vk'));
    }
    groups.push(...vkByKey.values());

    const tgRows = database.prepare(`
        SELECT e.id, e.channel, e.message_id, e.event_index, e.title, e.event_date,
               e.event_time, e.venue, e.participants, e.description, e.source_url,
               e.image_paths_json AS event_image_paths_json, e.parse_method,
               e.poster_match_status, e.poster_match_reason, e.poster_image_index,
               e.poster_vision_facts_json,
               s.raw_text, s.image_urls_json, s.image_paths_json AS source_image_paths_json,
               s.image_vision_facts_json, s.image_vision_status_json
        FROM telegram_events e
        JOIN telegram_source_posts s
          ON s.channel = e.channel AND s.message_id = e.message_id
        WHERE e.status IN ('approved', 'pending') AND e.event_date >= ?
        ORDER BY e.channel, e.message_id, e.event_index, e.id
        LIMIT ?
    `).all(safeDate, safeLimit);
    const tgByKey = new Map();
    for (const row of tgRows) {
        const key = `${row.channel}:${row.message_id}`;
        let group = tgByKey.get(key);
        if (!group) {
            group = {
                sourceType: 'telegram', sourceKey: key,
                channel: String(row.channel ?? ''), messageId: Number(row.message_id ?? 0),
                rawText: String(row.raw_text ?? ''),
                imageUrls: safeStoredJsonArray(row.image_urls_json).map(String).filter(Boolean),
                imagePaths: parseStoredImagePaths(row.source_image_paths_json),
                imageVisionFacts: parseStoredPosterFacts(row.image_vision_facts_json),
                imageVisionStatuses: parseStoredPosterFacts(row.image_vision_status_json),
                imageMedia: [], events: [],
            };
            tgByKey.set(key, group);
        }
        group.events.push(buildEvent(row, 'telegram'));
    }
    groups.push(...tgByKey.values());

    const chatRows = database.prepare(`
        SELECT e.id, e.peer_id, e.conversation_message_id, e.event_index, e.title,
               e.event_date, e.event_time, e.venue, e.participants, e.description,
               e.source_url, e.image_paths_json AS event_image_paths_json, e.parse_method,
               e.poster_match_status, e.poster_match_reason, e.poster_image_index,
               e.poster_vision_facts_json,
               s.raw_text, s.image_urls_json, s.image_paths_json AS source_image_paths_json,
               s.image_vision_facts_json, s.image_vision_status_json, s.image_media_json
        FROM vk_chat_events e
        JOIN vk_chat_source_messages s
          ON s.peer_id = e.peer_id
         AND s.conversation_message_id = e.conversation_message_id
        WHERE e.status IN ('approved', 'pending') AND e.event_date >= ?
        ORDER BY e.peer_id, e.conversation_message_id, e.event_index, e.id
        LIMIT ?
    `).all(safeDate, safeLimit);
    const chatByKey = new Map();
    for (const row of chatRows) {
        const key = `${row.peer_id}:${row.conversation_message_id}`;
        let group = chatByKey.get(key);
        if (!group) {
            const urls = safeStoredJsonArray(row.image_urls_json).map(String).filter(Boolean);
            const storedPaths = parseStoredImagePaths(row.source_image_paths_json);
            const paths = recoverIndexedLegacyMediaPaths(storedPaths, urls, {
                relativeDirectory: `vk_chat_announcements/vk-chat-${Number(row.peer_id || 0)}`,
                itemId: String(row.conversation_message_id || ''),
            });
            group = {
                sourceType: 'vk_chat', sourceKey: key,
                peerId: Number(row.peer_id ?? 0),
                conversationMessageId: Number(row.conversation_message_id ?? 0),
                rawText: String(row.raw_text ?? ''), imageUrls: urls, imagePaths: paths,
                imageVisionFacts: parseStoredPosterFacts(row.image_vision_facts_json),
                imageVisionStatuses: parseStoredPosterFacts(row.image_vision_status_json),
                imageMedia: parseStoredPosterFacts(row.image_media_json), events: [],
            };
            chatByKey.set(key, group);
        }
        group.events.push(buildEvent(row, 'vk_chat'));
    }
    groups.push(...chatByKey.values());

    return groups;
}

// Owner-initiated full image audit also includes raw source records that have
// no accepted event yet (e.g. an image-only announcement needing reparse).
// Reuses the existing source tables; never turns image metadata into an Event.
export function getAllStoredSourceImageAuditGroupsV188100() {
    const groups = getStartupPosterRepairGroupsV18877({ fromDate: '0001-01-01', limitPerTable: 20_000 });
    const existing = new Set(groups.map((group) => `${group.sourceType}:${group.sourceKey}`));
    const add = (type, sourceKey, row, extra = {}, options = {}) => {
        const key = `${type}:${sourceKey}`;
        if (existing.has(key)) return;
        const urls = safeStoredJsonArray(row.image_urls_json).map(String).filter(Boolean);
        const storedPaths = parseStoredImagePaths(row.image_paths_json);
        const paths = options.recoverDirectory
            ? recoverIndexedLegacyMediaPaths(storedPaths, urls, {
                relativeDirectory: options.recoverDirectory,
                itemId: options.itemId,
            }) : storedPaths;
        if (!urls.length && !paths.length) return;
        existing.add(key);
        groups.push({ sourceType: type, sourceKey, ...extra,
            rawText: String(row.raw_text || ''), imageUrls: urls, imagePaths: paths,
            imageVisionFacts: parseStoredPosterFacts(row.image_vision_facts_json),
            imageVisionStatuses: parseStoredPosterFacts(row.image_vision_status_json),
            imageMedia: parseStoredPosterFacts(row.image_media_json), events: [],
        });
    };
    for (const row of database.prepare(`
        SELECT screen_name,post_id,raw_text,image_urls_json,image_paths_json,image_vision_facts_json,image_vision_status_json,image_media_json
        FROM vk_source_posts
    `).iterate()) {
        add('vk', `${row.screen_name}:${row.post_id}`, row,
            {screenName: String(row.screen_name || ''), postId: Number(row.post_id || 0)},
            { recoverDirectory: `vk_announcements/${String(row.screen_name || '').trim()}`,
              itemId: String(row.post_id || '') });
    }
    for (const row of database.prepare(`
        SELECT channel,message_id,raw_text,image_urls_json,image_paths_json,image_vision_facts_json,image_vision_status_json
        FROM telegram_source_posts
    `).iterate()) {
        add('telegram', `${row.channel}:${row.message_id}`, row,
            {channel: String(row.channel || ''),messageId: Number(row.message_id || 0)});
    }
    for (const row of database.prepare(`
        SELECT peer_id,conversation_message_id,raw_text,image_urls_json,image_paths_json,image_vision_facts_json,image_vision_status_json,image_media_json
        FROM vk_chat_source_messages
    `).iterate()) {
        add('vk_chat', `${row.peer_id}:${row.conversation_message_id}`, row,
            {peerId: Number(row.peer_id || 0),conversationMessageId: Number(row.conversation_message_id || 0)},
            {recoverDirectory: `vk_chat_announcements/vk-chat-${Number(row.peer_id || 0)}`,
             itemId: String(row.conversation_message_id || '')});
    }
    return groups;
}

export function saveStartupPosterRepairVisionFactsV18877(group, facts = []) {
    const sourceType = String(group?.sourceType ?? '').trim();
    const payload = JSON.stringify(Array.isArray(facts) ? facts : []);
    const statuses = JSON.stringify(deriveImageVisionStatuses(facts, group?.imageUrls));
    if (sourceType === 'vk') {
        return Number(database.prepare(`
            UPDATE vk_source_posts SET image_vision_facts_json = ?, image_vision_status_json = ?
            WHERE screen_name = ? AND post_id = ?
        `).run(payload, statuses, String(group?.screenName ?? ''), Number(group?.postId ?? 0)).changes || 0);
    }
    if (sourceType === 'telegram') {
        return Number(database.prepare(`
            UPDATE telegram_source_posts SET image_vision_facts_json = ?, image_vision_status_json = ?
            WHERE channel = ? AND message_id = ?
        `).run(payload, statuses, String(group?.channel ?? ''), Number(group?.messageId ?? 0)).changes || 0);
    }
    if (sourceType === 'vk_chat') {
        return Number(database.prepare(`
            UPDATE vk_chat_source_messages SET image_vision_facts_json = ?, image_vision_status_json = ?
            WHERE peer_id = ? AND conversation_message_id = ?
        `).run(payload, statuses, Number(group?.peerId ?? 0), Number(group?.conversationMessageId ?? 0)).changes || 0);
    }
    return 0;
}

function resolveSafeReparsePosterPath(table, previous, event) {
    const requestedIndex = Number(event?.posterImageIndex || 0);
    if (!Number.isSafeInteger(requestedIndex) || requestedIndex <= 0) return '';
    const facts = Array.isArray(event?.posterVisionFacts) ? event.posterVisionFacts : [];
    if (!storedPosterStatusIsSafe(event?.posterMatchStatus, facts)) return '';

    let paths = [];
    try {
        if (table === 'vk_events') {
            const source = database.prepare(`
                SELECT image_paths_json FROM vk_source_posts
                WHERE screen_name = ? AND post_id = ? LIMIT 1
            `).get(String(previous?.screen_name ?? ''), Number(previous?.post_id ?? 0));
            paths = parseStoredImagePaths(source?.image_paths_json);
        } else if (table === 'telegram_events') {
            const source = database.prepare(`
                SELECT image_paths_json FROM telegram_source_posts
                WHERE channel = ? AND message_id = ? LIMIT 1
            `).get(String(previous?.channel ?? ''), Number(previous?.message_id ?? 0));
            paths = parseStoredImagePaths(source?.image_paths_json);
        } else if (table === 'vk_chat_events') {
            const source = database.prepare(`
                SELECT image_paths_json FROM vk_chat_source_messages
                WHERE peer_id = ? AND conversation_message_id = ? LIMIT 1
            `).get(Number(previous?.peer_id ?? 0), Number(previous?.conversation_message_id ?? 0));
            paths = parseStoredImagePaths(source?.image_paths_json);
        }
    } catch {}
    return paths.find((path) => legacyCapturedMediaIndex(path) === requestedIndex) || paths[requestedIndex - 1] || '';
}

export function saveManualPosterMetadataV18892({ id, posterVisionFacts = [], posterImageIndex = 0, updatedAt = Math.floor(Date.now() / 1000) } = {}) {
    const eventId = Number(id);
    if (!Number.isSafeInteger(eventId) || eventId <= 0) return 0;
    const row = database.prepare('SELECT id FROM manual_events WHERE id = ? LIMIT 1').get(eventId);
    if (!row) return 0;
    const facts = Array.isArray(posterVisionFacts) ? posterVisionFacts : [];
    return Number(database.prepare(`
        UPDATE manual_events
        SET poster_vision_facts_json = ?, poster_image_index = CASE WHEN ? > 0 THEN ? ELSE poster_image_index END,
            poster_match_reason = CASE WHEN poster_match_reason = '' THEN 'owner-manual-metadata-reviewed-v18892' ELSE poster_match_reason END,
            updated_at = ?
        WHERE id = ?
    `).run(JSON.stringify(facts), Number(posterImageIndex || 0), Number(posterImageIndex || 0), Number(updatedAt), eventId).changes || 0);
}

export function setStoredEventPosterChoiceV18893({
    sourceType,
    id,
    imageIndex,
    imagePath,
    posterVisionFacts = [],
    posterMatchReason = 'owner-selected-after-metadata-review-v18893',
    updatedAt = Math.floor(Date.now() / 1000),
} = {}) {
    const table = {
        manual: 'manual_events', telegram: 'telegram_events', vk: 'vk_events', vk_chat: 'vk_chat_events',
    }[String(sourceType ?? '').trim()];
    const eventId = Number(id);
    const index = Number(imageIndex);
    const path = String(imagePath ?? '').trim();
    if (!table || !Number.isSafeInteger(eventId) || eventId <= 0 || !Number.isSafeInteger(index) || index <= 0 || !path) return 0;
    const facts = Array.isArray(posterVisionFacts) ? posterVisionFacts : [];
    const selected = posterFactForIndex(facts, index);
    // Explicit choice is tied to a real inspected image, never a bare index.
    if (!selected) return 0;
    const current = database.prepare(`SELECT title, event_date FROM ${table} WHERE id = ? LIMIT 1`).get(eventId);
    if (!current) return 0;
    const selectedFacts = enrichPosterFactsWithStoredMediaV18886([selected], path, index)
        .map((fact) => String(posterMatchReason || '').startsWith('owner-confirmed-poster-for-this-event-')
            ? { ...fact, ownerConfirmedBinding: {
                eventId, eventDate: String(current.event_date || ''), eventTitle: String(current.title || ''),
                imageIndex: index, imagePath: path, decision: 'yes', at: Number(updatedAt),
            } }
            : fact);
    return Number(database.prepare(`
        UPDATE ${table}
        SET image_paths_json = ?, poster_match_status = 'exact_poster_match',
            poster_match_reason = ?,
            poster_image_index = ?, poster_vision_facts_json = ?,
            poster_review_candidates_json = '[]', updated_at = ?
        WHERE id = ?
    `).run(
        JSON.stringify([path]),
        String(posterMatchReason || 'owner-selected-after-metadata-review-v18893'),
        index,
        JSON.stringify(selectedFacts),
        Number(updatedAt),
        eventId,
    ).changes || 0);
}

// Explicit owner decision: none of the proposed photos belongs to this event.
// Keep source media, raw evidence, other events and owner edits untouched.
export function setStoredEventPosterReviewDeclinedV188100({ sourceType, id, updatedAt = Math.floor(Date.now() / 1000) } = {}) {
    const table = {
        manual: 'manual_events', telegram: 'telegram_events', vk: 'vk_events', vk_chat: 'vk_chat_events',
    }[String(sourceType || '').trim()];
    const eventId = Number(id);
    if (!table || !Number.isSafeInteger(eventId) || eventId <= 0) return 0;
    return Number(database.prepare(`
        UPDATE ${table}
        SET poster_match_status = 'no_safe_poster', poster_match_reason = 'owner-rejected-all-proposals-v188100',
            poster_image_index = 0, poster_review_candidates_json = '[]', updated_at = ?
        WHERE id = ? AND poster_match_status = 'poster_review_required'
    `).run(Number(updatedAt), eventId).changes || 0);
}

export function replaceStoredImagePathEverywhereV18893(fromPath, toPath, { updatedAt = Math.floor(Date.now() / 1000) } = {}) {
    const from = String(fromPath ?? '').trim();
    const to = String(toPath ?? '').trim();
    if (!from || !to || from === to) return { rows: 0, replacements: 0 };
    const targets = [
        ['manual_events', 'image_paths_json'], ['telegram_events', 'image_paths_json'], ['vk_events', 'image_paths_json'], ['vk_chat_events', 'image_paths_json'],
        ['telegram_source_posts', 'image_paths_json'], ['vk_source_posts', 'image_paths_json'], ['vk_chat_source_messages', 'image_paths_json'],
    ];
    let rowsChanged = 0;
    let replacements = 0;
    database.exec('BEGIN IMMEDIATE');
    try {
        for (const [table, column] of targets) {
            const rows = database.prepare(`SELECT rowid AS _rowid, ${column} AS paths FROM ${table} WHERE ${column} LIKE ?`).all(`%${from}%`);
            const update = database.prepare(`UPDATE ${table} SET ${column} = ?${table.endsWith('_events') ? ', updated_at = ?' : ''} WHERE rowid = ?`);
            for (const row of rows) {
                let paths = [];
                try { paths = JSON.parse(row.paths || '[]'); } catch { paths = []; }
                if (!Array.isArray(paths) || !paths.some((item) => String(item ?? '').trim() === from)) continue;
                let localCount = 0;
                const next = paths.map((item) => {
                    if (String(item ?? '').trim() === from) { localCount += 1; return to; }
                    return item;
                });
                if (table.endsWith('_events')) update.run(JSON.stringify(next), Number(updatedAt), row._rowid);
                else update.run(JSON.stringify(next), row._rowid);
                rowsChanged += 1;
                replacements += localCount;
            }
        }
        database.exec('COMMIT');
    } catch (error) {
        database.exec('ROLLBACK');
        throw error;
    }
    return { rows: rowsChanged, replacements };
}

export function getStoredPosterReviewEventsV18893({ fromDate = '0000-00-00', limit = 200 } = {}) {
    const safeLimit = Math.max(1, Math.min(1000, Number(limit) || 200));
    const out = [];
    for (const [sourceType, table] of Object.entries({ manual: 'manual_events', telegram: 'telegram_events', vk: 'vk_events', vk_chat: 'vk_chat_events' })) {
        const rows = database.prepare(`
            SELECT id, title, event_date, event_time, venue, participants, description, source_url,
                   image_paths_json, poster_image_index, poster_vision_facts_json, poster_review_candidates_json,
                   poster_match_status, poster_match_reason
            FROM ${table}
            WHERE event_date >= ? AND poster_match_status = 'poster_review_required'
            ORDER BY event_date ASC, id ASC LIMIT ?
        `).all(String(fromDate ?? '0000-00-00'), safeLimit);
        for (const row of rows) {
            let facts = [], candidates = [];
            try { facts = JSON.parse(row.poster_vision_facts_json || '[]'); } catch {}
            try { candidates = JSON.parse(row.poster_review_candidates_json || '[]'); } catch {}
            out.push({
                sourceType, id: Number(row.id), title: String(row.title || ''), eventDate: String(row.event_date || ''),
                eventTime: row.event_time ? String(row.event_time) : null, venue: String(row.venue || ''), participants: String(row.participants || ''),
                description: String(row.description || ''), sourceUrl: String(row.source_url || ''), imagePaths: parseStoredImagePaths(row.image_paths_json),
                posterImageIndex: Number(row.poster_image_index || 0), posterVisionFacts: Array.isArray(facts) ? facts : [],
                posterReviewCandidates: Array.isArray(candidates) ? candidates : [], posterMatchReason: String(row.poster_match_reason || ''),
            });
        }
    }
    return out.sort((a, b) => a.eventDate.localeCompare(b.eventDate) || a.sourceType.localeCompare(b.sourceType) || a.id - b.id).slice(0, safeLimit);
}

export function reconcileStoredEventPosterFromMetadataV18892({
    sourceType,
    id,
    sourceImagePaths = [],
    sourceVisionFacts = [],
    updatedAt = Math.floor(Date.now() / 1000),
}) {
    const safeType = String(sourceType ?? '').trim();
    const eventId = Number(id);
    const tables = {
        manual: 'manual_events',
        telegram: 'telegram_events',
        vk: 'vk_events',
        vk_chat: 'vk_chat_events',
    };
    const table = tables[safeType];
    if (!table || !Number.isSafeInteger(eventId) || eventId <= 0) {
        return { changed: 0, action: 'invalid-target', accepted: false };
    }
    const previous = database.prepare(`SELECT * FROM ${table} WHERE id = ? LIMIT 1`).get(eventId);
    if (!previous) return { changed: 0, action: 'missing-event', accepted: false };
    if (safeType === 'manual' && Number(previous?.owner_manual || 0) === 1) {
        return { changed: 0, action: 'owner-manual-locked', accepted: false };
    }
    // Owner decisions are durable; automated rechecks may not undo them.
    if (/^owner-(?:confirmed-poster-for-this-event|rejected-all-proposals)-/u.test(String(previous.poster_match_reason || ''))) {
        return { changed: 0, action: 'owner-poster-decision-locked', accepted: false };
    }

    const facts = Array.isArray(sourceVisionFacts) ? sourceVisionFacts : [];
    const paths = safeJsonArray(sourceImagePaths);
    const event = {
        title: String(previous?.title ?? ''),
        eventDate: String(previous?.event_date ?? ''),
        eventTime: previous?.event_time ? String(previous.event_time) : null,
        venue: String(previous?.venue ?? ''),
        participants: String(previous?.participants ?? ''),
    };
    const oldPaths = parseStoredImagePaths(previous?.image_paths_json);
    const currentIndex = Number(previous?.poster_image_index || sourceMediaIndexFromPathV18886(oldPaths[0]) || 0);
    const currentFact = posterFactForIndex(facts, currentIndex);
    const currentAudit = currentFact
        ? evaluatePosterFactForEvent(event, currentFact)
        : { accepted: false, score: -1000, reason: 'missing-image-metadata' };
    const pathForIndex = (index) => paths.find((path) => sourceMediaIndexFromPathV18886(path) === Number(index || 0)) || paths[Number(index || 0) - 1] || '';

    if (currentFact && currentAudit.accepted && oldPaths.length) {
        const keepPath = oldPaths.find((path) => sourceMediaIndexFromPathV18886(path) === currentIndex) || pathForIndex(currentIndex) || oldPaths[0];
        const selectedFacts = enrichPosterFactsWithStoredMediaV18886([currentFact], keepPath, currentIndex);
        const changed = Number(database.prepare(`
            UPDATE ${table}
            SET image_paths_json = ?, poster_match_status = ?, poster_match_reason = ?,
                poster_image_index = ?, poster_vision_facts_json = ?, updated_at = ?
            WHERE id = ?
        `).run(
            JSON.stringify([keepPath]),
            String(previous?.poster_match_status || 'exact_poster_match'),
            `metadata-reviewed-v18892:${currentAudit.reason}`,
            currentIndex,
            JSON.stringify(selectedFacts),
            Number(updatedAt),
            eventId,
        ).changes || 0);
        return { changed, action: 'kept-compatible', accepted: true, imageIndex: currentIndex, imagePath: keepPath, reason: currentAudit.reason };
    }

    const best = selectBestCompatiblePosterFact(event, facts, { preferredIndex: currentIndex });
    const bestIndex = Number(best?.fact?.index || 0);
    const bestPath = bestIndex ? pathForIndex(bestIndex) : '';
    if (best?.ambiguous) {
        const candidates = Array.isArray(best?.candidates) ? best.candidates.map((item) => ({
            index: Number(item?.fact?.index || 0),
            score: Number(item?.match?.score || 0),
            reason: String(item?.match?.reason || ''),
            title: String(item?.fact?.title || ''),
            date: String(item?.fact?.date || ''),
        })).filter((item) => item.index > 0) : [];
        const changed = Number(database.prepare(`
            UPDATE ${table}
            SET poster_match_status = 'poster_review_required', poster_match_reason = ?,
                poster_review_candidates_json = ?, poster_vision_facts_json = ?, updated_at = ?
            WHERE id = ?
        `).run('multiple-date-compatible-posters', JSON.stringify(candidates), JSON.stringify(facts), Number(updatedAt), eventId).changes || 0);
        return { changed, action: 'review-required', accepted: false, candidates, imageIndex: currentIndex, imagePath: oldPaths[0] || '', reason: 'multiple-date-compatible-posters' };
    }
    if (best && bestPath) {
        const selectedFacts = enrichPosterFactsWithStoredMediaV18886([best.fact], bestPath, bestIndex);
        const changed = Number(database.prepare(`
            UPDATE ${table}
            SET image_paths_json = ?, poster_match_status = ?, poster_match_reason = ?,
                poster_image_index = ?, poster_vision_facts_json = ?, updated_at = ?
            WHERE id = ?
        `).run(
            JSON.stringify([bestPath]),
            'exact_poster_match',
            `metadata-reviewed-v18892:${best.match.reason}`,
            bestIndex,
            JSON.stringify(selectedFacts),
            Number(updatedAt),
            eventId,
        ).changes || 0);
        return { changed, action: currentIndex === bestIndex ? 'confirmed' : 'rebound-compatible', accepted: true, imageIndex: bestIndex, imagePath: bestPath, reason: best.match.reason };
    }

    // Missing metadata is not permission to destroy an old image. Explicit
    // backfill will retry it later. But once metadata exists and proves the
    // current image is unrelated, clear only the event-level binding; source
    // media and its metadata stay intact for review/recovery.
    if (!currentFact && oldPaths.length) {
        const changed = Number(database.prepare(`
            UPDATE ${table}
            SET poster_match_status = ?, poster_match_reason = ?, updated_at = ?
            WHERE id = ?
        `).run('metadata_pending_existing_poster', 'v18892-metadata-backfill-required', Number(updatedAt), eventId).changes || 0);
        return { changed, action: 'preserved-metadata-missing', accepted: false, imageIndex: currentIndex, imagePath: oldPaths[0], reason: 'missing-image-metadata' };
    }

    // Metadata mismatch is a review signal, never permission to destroy a
    // previously persisted source image. Keep the bytes and mark the binding
    // for owner review. This is the hard image-durability invariant.
    const keepPath = oldPaths[0] || '';
    const reviewCandidates = facts
        .map((fact) => ({ fact, match: evaluatePosterFactForEvent(event, fact) }))
        // Date conflict or missing OCR is not an automatic rejection of raw
        // media: the owner may verify a difficult poster in Telegram. Exclude
        // explicit non-posters from this candidate list, keep them in the audit.
        .filter((item) => item?.fact?.poster !== false &&
            Number(item?.fact?.index || 0) > 0 && pathForIndex(item.fact.index))
        .sort((a, b) => Number(b.match.score || 0) - Number(a.match.score || 0))
        .map((item) => ({
            index: Number(item.fact?.index || 0),
            score: Number(item.match?.score || 0),
            reason: String(item.match?.reason || ''),
            title: String(item.fact?.title || ''),
            date: String(item.fact?.date || ''),
        }))
        .filter((item) => item.index > 0);
    const changed = Number(database.prepare(`
        UPDATE ${table}
        SET poster_match_status = ?, poster_match_reason = ?, poster_review_candidates_json = ?,
            poster_vision_facts_json = ?, updated_at = ?
        WHERE id = ?
    `).run(
        reviewCandidates.length ? 'poster_review_required' : 'no_safe_poster',
        currentFact ? `metadata-mismatch-preserved:${currentAudit.reason}` : 'v188100-no-compatible-poster',
        JSON.stringify(reviewCandidates),
        JSON.stringify(facts),
        Number(updatedAt),
        eventId,
    ).changes || 0);
    return { changed, action: reviewCandidates.length ? 'preserved-review-required' : 'no-compatible-poster', accepted: false, imageIndex: currentIndex, imagePath: keepPath, candidates: reviewCandidates, reason: currentAudit.reason || 'no-compatible-poster' };
}

export function updateStoredEventRecordFromReparse({
    sourceType,
    id,
    event,
    // Only the explicit future-refresh command uses this guard.
    onlyIfMissingPoster = false,
    updatedAt = Math.floor(Date.now() / 1000),
}) {
    const safeType = String(sourceType ?? '').trim();
    const eventId = Number(id);
    if (!Number.isSafeInteger(eventId) || eventId <= 0 || !event || typeof event !== 'object') {
        return 0;
    }
    const tables = {
        manual: 'manual_events',
        telegram: 'telegram_events',
        vk: 'vk_events',
        vk_chat: 'vk_chat_events',
    };
    const table = tables[safeType];
    if (!table) return 0;
    const previous = database.prepare(`SELECT * FROM ${table} WHERE id = ? LIMIT 1`).get(eventId);
    if (!previous) return 0;
    if (onlyIfMissingPoster) {
        let currentPaths = [];
        let currentFacts = [];
        try {
            const paths = JSON.parse(previous.image_paths_json || '[]');
            if (Array.isArray(paths)) currentPaths = paths;
        } catch {}
        try {
            const facts = JSON.parse(previous.poster_vision_facts_json || '[]');
            if (Array.isArray(facts)) currentFacts = facts;
        } catch {}
        const selectedIndex = Number(previous.poster_image_index || 0);
        const selectedPath = currentPaths.find((path) =>
            sourceMediaIndexFromPathV18886(path) === selectedIndex
        ) || (currentPaths.length === 1 ? currentPaths[0] : '');
        // Protect a REAL, readable poster already bound to THIS event, not a
        // stale path, generated card, or a gallery image with a different index.
        // The owner-confirmed legacy path remains protected independently of
        // automated Vision confidence.
        const validatedBinding = previous.poster_match_status === 'legacy_manual_poster' ||
            storedRowPosterBindingAudit(previous, previous, currentFacts).accepted;
        if (Number.isInteger(selectedIndex) && selectedIndex > 0 && selectedPath &&
            storedPosterStatusIsSafe(previous.poster_match_status, currentFacts) &&
            validatedBinding && legacyPosterPathLooksClean(selectedPath)) {
            return 0;
        }
    }
    const previousMeta = parseEventV18867Metadata(previous);
    const permanentCandidate = {
        title: String(event?.title ?? previous?.title ?? '').trim(),
        eventDate: String(event?.eventDate ?? previous?.event_date ?? '').trim(),
        eventTime: event?.eventTime ?? previous?.event_time ?? null,
        venue: String(event?.venue ?? previous?.venue ?? '').trim(),
        participants: String(event?.participants ?? previous?.participants ?? '').trim(),
        description: String(event?.description ?? previous?.description ?? '').trim(),
        evidence: String(event?.evidence ?? previous?.evidence ?? '').trim(),
        sourceUrl: String(event?.sourceUrl ?? previous?.source_url ?? '').trim(),
        sourceType: safeType,
        sourceItemId: String(event?.sourceItemId ?? previousMeta.sourceItemId ?? '').trim(),
        canonicalPostUrl: String(event?.canonicalPostUrl ?? previousMeta.canonicalPostUrl ?? '').trim(),
        sourceOriginalUrl: String(event?.sourceOriginalUrl ?? previousMeta.sourceOriginalUrl ?? '').trim(),
        posterVisionFacts: Array.isArray(event?.posterVisionFacts) ? event.posterVisionFacts : previousMeta.posterVisionFacts,
        eventTags: Array.isArray(event?.eventTags) ? event.eventTags : previousMeta.eventTags,
    };
    const permanentBlock = findPermanentEventBlockMatch(permanentCandidate);
    if (permanentBlock) {
        database.prepare(`UPDATE ${table} SET status = 'ignored', updated_at = ? WHERE id = ?`).run(
            Number(updatedAt) || Math.floor(Date.now() / 1000), eventId,
        );
        console.log('[PERMANENT EVENT BLOCK REPARSE]', `event=${safeType}:${eventId}`, `block=#${permanentBlock.block?.id || 0}`, `score=${permanentBlock.score}`);
        return 0;
    }
    // Owner-authored cards are immutable for automatic reparse. Dedupe may
    // still record lineage separately, but content/media/vision stay owner-owned.
    if (safeType === 'manual' && Number(previous?.owner_manual || 0) === 1) return 0;

    const pick = (incoming, stored) => {
        const next = String(incoming ?? '').trim();
        return next || String(stored ?? '').trim();
    };
    const incomingVenue = String(event?.venue ?? '').trim();
    const storedVenue = String(previous?.venue ?? '').trim();
    const venue = incomingVenue && incomingVenue.toLowerCase() !== 'место не указано'
        ? incomingVenue
        : storedVenue && storedVenue.toLowerCase() !== 'место не указано'
            ? storedVenue
            : normalizedPersistedVenue(incomingVenue || storedVenue);
    let oldImagePaths = [];
    try {
        const parsed = JSON.parse(previous?.image_paths_json ?? '[]');
        oldImagePaths = Array.isArray(parsed) ? parsed : [];
    } catch {}
    const incomingImagePaths = Array.isArray(event?.imagePaths)
        ? event.imagePaths.map((value) => String(value ?? '').trim()).filter(Boolean)
        : [];
    let incomingFacts = Array.isArray(event?.posterVisionFacts) ? event.posterVisionFacts : [];
    let storedFacts = [];
    try {
        const parsed = JSON.parse(previous?.poster_vision_facts_json ?? '[]');
        storedFacts = Array.isArray(parsed) ? parsed : [];
    } catch {}
    let storedTags = [];
    let storedReviewCandidates = [];
    try { storedTags = JSON.parse(previous?.event_tags_json ?? '[]'); } catch { storedTags = []; }
    try { storedReviewCandidates = JSON.parse(previous?.poster_review_candidates_json ?? '[]'); } catch { storedReviewCandidates = []; }
    if (!Array.isArray(storedTags)) storedTags = [];
    if (!Array.isArray(storedReviewCandidates)) storedReviewCandidates = [];
    const comparisonEvent = {
        ...event,
        title: pick(event?.title, previous?.title),
        eventDate: pick(event?.eventDate, previous?.event_date),
        eventTime: pick(event?.eventTime, previous?.event_time) || null,
        venue,
        participants: pick(event?.participants, previous?.participants),
    };
    const incomingIndex = Number(event?.posterImageIndex || sourceMediaIndexFromPathV18886(incomingImagePaths[0]) || 0);
    const storedIndex = Number(previous?.poster_image_index || sourceMediaIndexFromPathV18886(oldImagePaths[0]) || 0);
    const incomingAudit = eventPosterBindingAudit(comparisonEvent, incomingFacts, incomingIndex);
    const storedAudit = storedRowPosterBindingAudit(comparisonEvent, previous, storedFacts);
    const incomingSafe = storedPosterStatusIsSafe(event?.posterMatchStatus, incomingFacts) && incomingAudit.accepted;
    const storedSafe = storedPosterStatusIsSafe(previous?.poster_match_status, storedFacts) && storedAudit.accepted;
    const storedMetadataPending = oldImagePaths.length > 0 && !posterPathIsGeneratedV18892(oldImagePaths[0]) && !posterFactForIndex(storedFacts, storedIndex);
    const resolvedPosterPath = incomingSafe ? resolveSafeReparsePosterPath(table, previous, event) : '';
    // Hard durability rule: compatible stored poster > unknown stored poster >
    // compatible fresh poster > no poster. An incompatible Vision-positive image
    // can never replace a known-good image.
    const imagePaths = (storedSafe || storedMetadataPending) && oldImagePaths.length
        ? oldImagePaths.slice(0, 1)
        : incomingSafe
            ? ([resolvedPosterPath || incomingImagePaths[0]].filter(Boolean).slice(0, 1))
            : [];
    const merged = {
        ...event,
        title: pick(event?.title, previous?.title),
        eventDate: pick(event?.eventDate, previous?.event_date),
        eventTime: pick(event?.eventTime, previous?.event_time) || null,
        venue,
        participants: pick(event?.participants, previous?.participants),
        price: pick(event?.price, previous?.price),
        description: pick(event?.description, previous?.description),
        evidence: pick(event?.evidence, previous?.evidence),
        sourceUrl: pick(event?.sourceUrl, previous?.source_url),
        imagePaths,
        canonicalPostUrl: pick(event?.canonicalPostUrl, previous?.canonical_post_url),
        provenanceSourceType: pick(event?.provenanceSourceType, previous?.source_type),
        sourceChatId: Number(event?.sourceChatId || previous?.source_chat_id || 0),
        sourceChatName: pick(event?.sourceChatName, previous?.source_chat_name),
        sourceMessageId: Number(event?.sourceMessageId || previous?.source_message_id || 0),
        sourceItemId: pick(event?.sourceItemId, previous?.source_item_id),
        sourceOriginalUrl: pick(event?.sourceOriginalUrl, previous?.source_original_url),
        canonicalOrigin: pick(event?.canonicalOrigin, previous?.canonical_origin),
        posterMatchStatus: storedSafe
            ? String(previous?.poster_match_status || '')
            : storedMetadataPending
                ? String(previous?.poster_match_status || 'metadata_pending_existing_poster')
                : incomingSafe
                    ? String(event?.posterMatchStatus || 'exact_poster_match')
                    : 'no_safe_poster',
        posterMatchReason: storedSafe
            ? String(previous?.poster_match_reason || '')
            : storedMetadataPending
                ? 'metadata-pending-existing-poster-preserved'
                : incomingSafe
                    ? `metadata-validated:${String(event?.posterMatchReason || incomingAudit.reason)}`
                    : 'metadata-mismatch-no-safe-poster',
        posterImageIndex: storedSafe || storedMetadataPending
            ? storedIndex
            : incomingSafe
                ? incomingIndex
                : 0,
        posterVisionFacts: storedSafe || storedMetadataPending
            ? storedFacts
            : incomingSafe
                ? incomingFacts
                : (incomingFacts.length ? incomingFacts : storedFacts),
        posterReviewCandidates: Array.isArray(event?.posterReviewCandidates) && event.posterReviewCandidates.length ? event.posterReviewCandidates : storedReviewCandidates,
        eventTags: [...new Set([...(Array.isArray(event?.eventTags) ? event.eventTags : []), ...storedTags].map((item) => String(item ?? '').trim()).filter(Boolean))],
        venueSource: pick(event?.venueSource, previous?.venue_source),
    };

    const values = [
        merged.title,
        merged.eventDate,
        merged.eventTime,
        merged.venue,
        merged.participants,
        merged.price,
        merged.description,
        merged.evidence,
        merged.sourceUrl,
        JSON.stringify(merged.imagePaths),
    ];
    let result;
    if (safeType === 'manual') {
        result = database.prepare(`
            UPDATE manual_events
            SET title = ?, event_date = ?, event_time = ?, venue = ?, participants = ?,
                price = ?, description = ?, evidence = ?, source_url = ?, image_paths_json = ?,
                status = 'approved', updated_at = ?
            WHERE id = ?
        `).run(...values, Number(updatedAt) || Math.floor(Date.now() / 1000), eventId);
    } else {
        const parseMethod = pick(event?.parseMethod, previous?.parse_method) || 'reparsed_source_link_v18867';
        result = database.prepare(`
            UPDATE ${table}
            SET title = ?, event_date = ?, event_time = ?, venue = ?, participants = ?,
                price = ?, description = ?, evidence = ?, source_url = ?, image_paths_json = ?,
                parse_method = ?, status = 'approved', updated_at = ?
            WHERE id = ?
        `).run(...values, parseMethod, Number(updatedAt) || Math.floor(Date.now() / 1000), eventId);
    }
    writeEventV18867Metadata(table, eventId, merged, { venue: merged.venue });
    return Number(result.changes ?? 0);
}

export function updateStoredEventSemanticFieldsByOwner({
    sourceType,
    id,
    event,
    sourceText = '',
    updatedAt = Math.floor(Date.now() / 1000),
}) {
    const safeType = String(sourceType ?? '').trim();
    const eventId = Number(id);
    if (!Number.isSafeInteger(eventId) || eventId <= 0 || !event || typeof event !== 'object') return 0;
    const table = {
        manual: 'manual_events',
        telegram: 'telegram_events',
        vk: 'vk_events',
        vk_chat: 'vk_chat_events',
    }[safeType];
    if (!table) return 0;

    const previous = database.prepare(`SELECT * FROM ${table} WHERE id = ? LIMIT 1`).get(eventId);
    if (!previous) return 0;
    const previousMeta = parseEventV18867Metadata(previous);
    const pick = (incoming, stored) => {
        const value = String(incoming ?? '').trim();
        return value || String(stored ?? '').trim();
    };
    const title = pick(event.title, previous.title);
    const eventDate = pick(event.eventDate, previous.event_date);
    const eventTime = String(event.eventTime ?? '').trim() || (previous.event_time ? String(previous.event_time) : null);
    const venue = pick(event.venue, previous.venue);
    const participants = pick(event.participants, previous.participants);
    const price = pick(event.price, previous.price);
    const description = pick(event.description, previous.description);
    const evidence = pick(event.evidence, previous.evidence);
    const timestamp = Number(updatedAt) || Math.floor(Date.now() / 1000);

    let result;
    if (safeType === 'manual') {
        const replacementSourceText = String(sourceText ?? '').trim();
        result = database.prepare(`
            UPDATE manual_events
            SET title = ?, event_date = ?, event_time = ?, venue = ?, participants = ?,
                price = ?, description = ?, evidence = ?,
                source_text = CASE WHEN ? <> '' THEN ? ELSE source_text END,
                status = 'approved', updated_at = ?
            WHERE id = ?
        `).run(
            title, eventDate, eventTime, venue, participants,
            price, description, evidence,
            replacementSourceText, replacementSourceText,
            timestamp, eventId,
        );
    } else {
        result = database.prepare(`
            UPDATE ${table}
            SET title = ?, event_date = ?, event_time = ?, venue = ?, participants = ?,
                price = ?, description = ?, evidence = ?,
                parse_method = ?, status = 'approved', updated_at = ?
            WHERE id = ?
        `).run(
            title, eventDate, eventTime, venue, participants,
            price, description, evidence,
            'owner_text_correction_v18898', timestamp, eventId,
        );
    }

    const incomingTags = Array.isArray(event.eventTags)
        ? event.eventTags
        : Array.isArray(event.tags)
            ? event.tags
            : [];
    const mergedTags = incomingTags.length
        ? [...new Set(incomingTags.map((value) => String(value ?? '').trim()).filter(Boolean))].slice(0, 32)
        : (Array.isArray(previousMeta.eventTags) ? previousMeta.eventTags : []);

    // V188.98: text correction is allowed to change the event identity. A poster
    // that was valid for the OLD date/title must not keep riding on a corrected
    // card just because its historical status said "exact_poster_match". Keep
    // the source bytes and Vision facts for audit/recovery, but invalidate the
    // event-level binding when the selected image no longer matches the corrected
    // semantic identity. Price/description-only edits do not touch poster state.
    const identityChanged = (
        String(previous?.title ?? '').trim() !== title ||
        String(previous?.event_date ?? '').trim() !== eventDate ||
        String(previous?.venue ?? '').trim() !== venue ||
        String(previous?.participants ?? '').trim() !== participants
    );
    let posterMatchStatus = String(previousMeta.posterMatchStatus || '');
    let posterMatchReason = String(previousMeta.posterMatchReason || '');
    if (identityChanged && storedPosterStatusIsSafe(posterMatchStatus, previousMeta.posterVisionFacts)) {
        const posterAudit = eventPosterBindingAudit({
            title,
            eventDate,
            eventTime,
            venue,
            participants,
        }, previousMeta.posterVisionFacts, previousMeta.posterImageIndex);
        if (!posterAudit.accepted) {
            const oldPaths = parseStoredImagePaths(previous?.image_paths_json);
            posterMatchStatus = oldPaths.length ? 'poster_review_required' : 'no_safe_poster';
            posterMatchReason = `owner-semantic-correction-invalidated-v18898:${String(posterAudit.reason || 'poster-mismatch')}`;
            database.prepare(`
                UPDATE ${table}
                SET poster_match_status = ?, poster_match_reason = ?, updated_at = ?
                WHERE id = ?
            `).run(posterMatchStatus, posterMatchReason, timestamp, eventId);
        }
    }

    writeEventV18867Metadata(table, eventId, {
        ...previousMeta,
        posterMatchStatus,
        posterMatchReason,
        eventTags: mergedTags,
        venueSource: String(event?.venue ? 'owner-text-correction-v18898' : previousMeta.venueSource || ''),
    }, {
        ...previousMeta,
        venue,
    });
    return Number(result.changes ?? 0);
}

export function replaceEventDedupeRegistry(groups, {
    scope = 'configured',
    now = Math.floor(Date.now() / 1000),
} = {}) {
    const safeScope = String(scope ?? 'configured').trim().slice(0, 64) || 'configured';
    const safeGroups = Array.isArray(groups) ? groups : [];
    const deleteMembers = database.prepare(`
        DELETE FROM event_dedupe_members WHERE scope = ?
    `);
    const deleteGroups = database.prepare(`
        DELETE FROM event_dedupe_groups WHERE scope = ?
    `);
    const insertGroup = database.prepare(`
        INSERT INTO event_dedupe_groups (
            scope, group_key, canonical_json, member_count, updated_at
        ) VALUES (?, ?, ?, ?, ?)
    `);
    const insertMember = database.prepare(`
        INSERT INTO event_dedupe_members (
            scope, source_type, event_id, group_key, role, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?)
    `);

    let memberCount = 0;
    database.exec('BEGIN IMMEDIATE');
    try {
        deleteMembers.run(safeScope);
        deleteGroups.run(safeScope);

        for (const group of safeGroups) {
            const groupKey = String(group?.groupKey ?? '').trim();
            const canonical = group?.canonical && typeof group.canonical === 'object'
                ? group.canonical
                : {};
            const members = Array.isArray(group?.members) ? group.members : [];
            if (!groupKey || members.length < 2) continue;

            insertGroup.run(
                safeScope,
                groupKey,
                JSON.stringify(canonical),
                members.length,
                Number(now),
            );

            const keepKey = String(group?.keepKey ?? '').trim();
            for (const member of members) {
                const sourceType = String(member?.ref?.sourceType ?? '').trim();
                const eventId = Number(member?.ref?.id ?? 0);
                const refKey = `${sourceType}:${eventId}`;
                if (!sourceType || !Number.isInteger(eventId) || eventId <= 0) continue;
                insertMember.run(
                    safeScope,
                    sourceType,
                    eventId,
                    groupKey,
                    refKey === keepKey ? 'canonical' : 'duplicate',
                    Number(now),
                );
                memberCount += 1;
            }
        }

        upsertMaintenanceStateStatement.run(
            `event_dedupe_registry_v103:${safeScope}`,
            Number(now),
            JSON.stringify({ groups: safeGroups.length, members: memberCount }),
        );
        database.exec('COMMIT');
    } catch (error) {
        database.exec('ROLLBACK');
        throw error;
    }

    return {
        scope: safeScope,
        groups: safeGroups.length,
        members: memberCount,
        duplicateMembers: Math.max(0, memberCount - safeGroups.length),
    };
}

export function getEventDedupeRegistryStats(scope = 'configured') {
    const safeScope = String(scope ?? 'configured').trim().slice(0, 64) || 'configured';
    const groupRow = database.prepare(`
        SELECT COUNT(*) AS count FROM event_dedupe_groups WHERE scope = ?
    `).get(safeScope);
    const memberRow = database.prepare(`
        SELECT COUNT(*) AS count,
               SUM(CASE WHEN role = 'duplicate' THEN 1 ELSE 0 END) AS duplicates
        FROM event_dedupe_members
        WHERE scope = ?
    `).get(safeScope);
    return {
        scope: safeScope,
        groups: Number(groupRow?.count ?? 0),
        members: Number(memberRow?.count ?? 0),
        duplicateMembers: Number(memberRow?.duplicates ?? 0),
    };
}

export function auditInvalidEventRecords({
    requireVenue = true,
} = {}) {
    const result = {
        telegramEvents: 0,
        vkEvents: 0,
        vkChatEvents: 0,
        manualEvents: 0,
        sourceRows: 0,
    };
    const invalidPredicate = requireVenue
        ? `TRIM(COALESCE(venue, '')) = '' OR LOWER(TRIM(venue)) IN ('уточняется', 'неизвестно', 'нет')`
        : '0';
    const eventPredicate = `(${invalidPredicate})
       OR LENGTH(TRIM(COALESCE(title, ''))) < 3
       OR LOWER(TRIM(COALESCE(title, ''))) IN ('t', 'мероприятие', 'музыкальное мероприятие')
       OR LOWER(COALESCE(description, '')) LIKE '%не может быть надежно классифицировано%'
       OR LOWER(COALESCE(description, '')) LIKE '%не содержит явного анонса%'
       OR LOWER(COALESCE(description, '')) LIKE '%нельзя однозначно определить%'`;

    for (const [key, table] of [
        ['telegramEvents', 'telegram_events'],
        ['vkEvents', 'vk_events'],
        ['vkChatEvents', 'vk_chat_events'],
        ['manualEvents', 'manual_events'],
    ]) {
        const row = database.prepare(`SELECT COUNT(*) AS count FROM ${table} WHERE ${eventPredicate}`).get();
        result[key] = Number(row?.count ?? 0);
    }

    result.sourceRows += Number(database.prepare(`
        SELECT COUNT(*) AS count
        FROM telegram_source_posts
        WHERE parse_status = 'event'
          AND NOT EXISTS (
              SELECT 1 FROM telegram_events
              WHERE telegram_events.channel = telegram_source_posts.channel
                AND telegram_events.message_id = telegram_source_posts.message_id
          )
    `).get()?.count ?? 0);
    result.sourceRows += Number(database.prepare(`
        SELECT COUNT(*) AS count
        FROM vk_source_posts
        WHERE parse_status = 'event'
          AND NOT EXISTS (
              SELECT 1 FROM vk_events
              WHERE vk_events.screen_name = vk_source_posts.screen_name
                AND vk_events.post_id = vk_source_posts.post_id
          )
    `).get()?.count ?? 0);
    result.sourceRows += Number(database.prepare(`
        SELECT COUNT(*) AS count
        FROM vk_chat_source_messages
        WHERE parse_status = 'event'
          AND NOT EXISTS (
              SELECT 1 FROM vk_chat_events
              WHERE vk_chat_events.peer_id = vk_chat_source_messages.peer_id
                AND vk_chat_events.conversation_message_id = vk_chat_source_messages.conversation_message_id
          )
    `).get()?.count ?? 0);
    return result;
}

export function purgeInvalidEventRecords({
    requireVenue = true,
    now = Math.floor(Date.now() / 1000),
} = {}) {
    const result = {
        telegramEvents: 0,
        vkEvents: 0,
        vkChatEvents: 0,
        manualEvents: 0,
        sourceRows: 0,
    };
    const invalidPredicate = requireVenue
        ? `TRIM(COALESCE(venue, '')) = '' OR LOWER(TRIM(venue)) IN ('уточняется', 'неизвестно', 'нет')`
        : '0';

    database.exec('BEGIN IMMEDIATE');
    try {
        for (const [key, table] of [
            ['telegramEvents', 'telegram_events'],
            ['vkEvents', 'vk_events'],
            ['vkChatEvents', 'vk_chat_events'],
            ['manualEvents', 'manual_events'],
        ]) {
            const statement = database.prepare(`
                DELETE FROM ${table}
                WHERE ${invalidPredicate}
                   OR LENGTH(TRIM(COALESCE(title, ''))) < 3
                   OR LOWER(TRIM(COALESCE(title, ''))) IN ('t', 'мероприятие', 'музыкальное мероприятие')
                   OR LOWER(COALESCE(description, '')) LIKE '%не может быть надежно классифицировано%'
                   OR LOWER(COALESCE(description, '')) LIKE '%не содержит явного анонса%'
                   OR LOWER(COALESCE(description, '')) LIKE '%нельзя однозначно определить%'
            `);
            result[key] = Number(statement.run().changes ?? 0);
        }

        result.sourceRows += Number(database.prepare(`
            DELETE FROM telegram_source_posts
            WHERE parse_status = 'event'
              AND NOT EXISTS (
                  SELECT 1 FROM telegram_events
                  WHERE telegram_events.channel = telegram_source_posts.channel
                    AND telegram_events.message_id = telegram_source_posts.message_id
              )
        `).run().changes ?? 0);
        result.sourceRows += Number(database.prepare(`
            DELETE FROM vk_source_posts
            WHERE parse_status = 'event'
              AND NOT EXISTS (
                  SELECT 1 FROM vk_events
                  WHERE vk_events.screen_name = vk_source_posts.screen_name
                    AND vk_events.post_id = vk_source_posts.post_id
              )
        `).run().changes ?? 0);
        result.sourceRows += Number(database.prepare(`
            DELETE FROM vk_chat_source_messages
            WHERE parse_status = 'event'
              AND NOT EXISTS (
                  SELECT 1 FROM vk_chat_events
                  WHERE vk_chat_events.peer_id = vk_chat_source_messages.peer_id
                    AND vk_chat_events.conversation_message_id = vk_chat_source_messages.conversation_message_id
              )
        `).run().changes ?? 0);

        upsertMaintenanceStateStatement.run(
            'v39_strict_event_cleanup',
            Number(now),
            JSON.stringify(result),
        );
        database.exec('COMMIT');
        return result;
    } catch (error) {
        database.exec('ROLLBACK');
        throw error;
    }
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
 * Показывает AI/privacy notice в ЛС не более одного раза на пользователя.
 * Раньше уведомление повторялось через случайные 1–7 дней; V100 убирает
 * повторные показы, чтобы обычный вопрос не сопровождался периодическим
 * лишним сообщением.
 *
 * В базе сохраняются только user_id и технические Unix-времена.
 */
export function consumeDmAiNotice({
    userId,
    now = Math.floor(Date.now() / 1000),
}) {
    const safeUserId = Number(userId);
    const safeNow = Number(now);

    if (!Number.isSafeInteger(safeUserId) || safeUserId <= 0) {
        throw new TypeError('userId должен быть положительным целым числом');
    }

    if (!Number.isSafeInteger(safeNow) || safeNow <= 0) {
        throw new TypeError('now должен быть положительным Unix-временем');
    }

    database.exec('BEGIN IMMEDIATE');

    try {
        const row = dmAiNoticeStateStatement.get(safeUserId);

        if (row) {
            database.exec('COMMIT');

            return {
                shouldSend: false,
                nextNoticeAt: Number(row.next_notice_at ?? 0),
                intervalDays: null,
            };
        }

        // Далёкая техническая дата означает «уже показывали, больше не повторять».
        const neverRepeatAt = 253402300799;
        upsertDmAiNoticeStateStatement.run(
            safeUserId,
            neverRepeatAt,
            safeNow,
        );

        database.exec('COMMIT');

        return {
            shouldSend: true,
            nextNoticeAt: neverRepeatAt,
            intervalDays: null,
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

ensureTableColumn(
    'vk_source_posts',
    'text_fingerprint',
    "TEXT NOT NULL DEFAULT ''",
);
ensureTableColumn(
    'vk_source_posts',
    'image_fingerprints_json',
    "TEXT NOT NULL DEFAULT '[]'",
);
ensureTableColumn(
    'vk_source_posts',
    'image_media_json',
    "TEXT NOT NULL DEFAULT '[]'",
);

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

/*
 * V130: исправление источника года и повторный проход публичных постов.
 * Старые версии при published_at=0 подставляли текущий год процесса, поэтому
 * посты 2024/2025 могли превращаться в «будущие» 2026/2027. Производные строки
 * без подтверждения даты удаляем, сырые source_posts сохраняем полностью.
 */
const scraperV130MigrationKey = 'public-events-v130-source-date-evidence';
const scraperV130Migration = database.prepare(`
    SELECT migration_key
    FROM scraper_code_migrations
    WHERE migration_key = ?
    LIMIT 1
`).get(scraperV130MigrationKey);

if (!scraperV130Migration) {
    const staleTelegramRows = database.prepare(`
        SELECT
            e.id,
            e.event_date,
            p.raw_text,
            p.published_at
        FROM telegram_events AS e
        INNER JOIN telegram_source_posts AS p
            ON p.channel = e.channel
           AND p.message_id = e.message_id
        WHERE e.status IN ('approved', 'pending')
    `).all();
    const staleVkRows = database.prepare(`
        SELECT
            e.id,
            e.event_date,
            p.raw_text,
            p.published_at
        FROM vk_events AS e
        INNER JOIN vk_source_posts AS p
            ON p.screen_name = e.screen_name
           AND p.post_id = e.post_id
        WHERE e.status IN ('approved', 'pending')
    `).all();
    const invalidTelegramIds = staleTelegramRows
        .filter((row) => !isEventDateConsistentWithSource({
            eventDate: row.event_date,
            sourceText: row.raw_text,
            publishedAt: row.published_at,
        }))
        .map((row) => Number(row.id));
    const invalidVkIds = staleVkRows
        .filter((row) => !isEventDateConsistentWithSource({
            eventDate: row.event_date,
            sourceText: row.raw_text,
            publishedAt: row.published_at,
        }))
        .map((row) => Number(row.id));
    const deleteTelegram = database.prepare('DELETE FROM telegram_events WHERE id = ?');
    const deleteVk = database.prepare('DELETE FROM vk_events WHERE id = ?');

    database.exec('BEGIN IMMEDIATE');
    try {
        for (const id of invalidTelegramIds) deleteTelegram.run(id);
        for (const id of invalidVkIds) deleteVk.run(id);

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
        `).run(scraperV130MigrationKey, Math.floor(Date.now() / 1000));
        database.exec('COMMIT');
    } catch (error) {
        database.exec('ROLLBACK');
        throw error;
    }

    console.log(
        '[SCRAPER V130 DATE CLEANUP]',
        `telegramRemoved=${invalidTelegramIds.length}`,
        `vkRemoved=${invalidVkIds.length}`,
    );
}

const selectVkPostMetaStatement = database.prepare(`
    SELECT
        content_hash,
        published_at,
        raw_text,
        text_fingerprint,
        image_fingerprints_json,
        image_urls_json,
        image_paths_json,
        image_media_json,
        (
            SELECT COUNT(*)
            FROM vk_events
            WHERE vk_events.screen_name = vk_source_posts.screen_name
              AND vk_events.post_id = vk_source_posts.post_id
        ) AS event_count,
        (
            SELECT COUNT(*)
            FROM vk_events
            WHERE vk_events.screen_name = vk_source_posts.screen_name
              AND vk_events.post_id = vk_source_posts.post_id
              AND COALESCE(NULLIF(TRIM(vk_events.image_paths_json), ''), '[]') = '[]'
        ) AS events_without_images
    FROM vk_source_posts
    WHERE screen_name = ?
      AND post_id = ?
    LIMIT 1
`);

const selectVkEventsForPostRefreshStatement = database.prepare(`
    SELECT
        id,
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
        status
    FROM vk_events
    WHERE screen_name = ?
      AND post_id = ?
      AND status IN ('approved', 'pending')
    ORDER BY event_index ASC, id ASC
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
        text_fingerprint,
        image_fingerprints_json,
        parse_status,
        fetched_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT (screen_name, post_id) DO UPDATE SET
        owner_id = excluded.owner_id,
        source_url = excluded.source_url,
        published_at = excluded.published_at,
        raw_text = excluded.raw_text,
        image_urls_json = excluded.image_urls_json,
        image_paths_json = excluded.image_paths_json,
        content_hash = excluded.content_hash,
        text_fingerprint = excluded.text_fingerprint,
        image_fingerprints_json = excluded.image_fingerprints_json,
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
        e.id,
        e.screen_name,
        e.post_id,
        e.title,
        e.event_date,
        e.event_time,
        e.venue,
        e.participants,
        e.price,
        e.description,
        e.source_url,
        e.image_paths_json,
        e.parse_method,
        e.status,
        p.published_at,
        p.raw_text
    FROM vk_events AS e
    INNER JOIN vk_source_posts AS p
        ON p.screen_name = e.screen_name
       AND p.post_id = e.post_id
    WHERE e.screen_name = ?
      AND e.status IN ('approved', 'pending')
      AND e.event_date >= ?
      AND NOT EXISTS (
          SELECT 1
          FROM event_dedupe_members AS dm
          WHERE dm.scope = 'configured'
            AND dm.source_type = 'vk'
            AND dm.event_id = e.id
            AND dm.role = 'duplicate'
      )
    ORDER BY e.event_date ASC,
             COALESCE(e.event_time, '23:59') ASC,
             e.id ASC
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
        publishedAt: Number(row.published_at ?? 0),
        rawText: String(row.raw_text ?? ''),
        textFingerprint: String(row.text_fingerprint ?? ''),
        imageFingerprintsJson: String(row.image_fingerprints_json ?? '[]'),
        imageUrlsJson: String(row.image_urls_json ?? '[]'),
        imagePathsJson: String(row.image_paths_json ?? '[]'),
        imageMediaJson: String(row.image_media_json ?? '[]'),
        eventCount: Number(row.event_count ?? 0),
        eventsWithoutImages: Number(row.events_without_images ?? 0),
    };
}

export function getVkEventsForPostRefresh({ screenName, postId } = {}) {
    const rows = selectVkEventsForPostRefreshStatement.all(
        String(screenName ?? '').trim(),
        Number(postId),
    );
    return rows.map((row) => {
        let imagePaths = [];
        try {
            const parsed = JSON.parse(String(row.image_paths_json ?? '[]'));
            imagePaths = Array.isArray(parsed)
                ? parsed.map((value) => String(value ?? '').trim()).filter(Boolean)
                : [];
        } catch {}

        return {
            id: Number(row.id ?? 0),
            sourceType: 'vk',
            ...readEventV18867MetadataForType('vk', row.id),
            eventIndex: Number(row.event_index ?? 0),
            title: String(row.title ?? ''),
            eventDate: String(row.event_date ?? ''),
            eventTime: row.event_time ? String(row.event_time) : null,
            venue: String(row.venue ?? ''),
            participants: String(row.participants ?? ''),
            price: String(row.price ?? ''),
            description: String(row.description ?? ''),
            evidence: String(row.evidence ?? ''),
            sourceUrl: String(row.source_url ?? ''),
            imagePaths,
            parseMethod: String(row.parse_method ?? ''),
            status: String(row.status ?? ''),
        };
    });
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
    imageMedia = [],
    contentHash,
    textFingerprint = '',
    imageFingerprints = [],
    imageVisionFacts = [],
    imageVisionStatuses = [],
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
        String(textFingerprint ?? '').trim(),
        JSON.stringify(Array.isArray(imageFingerprints) ? imageFingerprints.slice(0, 16) : []),
        String(parseStatus ?? 'pending').trim(),
        Number(fetchedAt),
    );
    database.prepare(`
        UPDATE vk_source_posts SET image_vision_facts_json = ?, image_vision_status_json = ?, image_media_json = ?
        WHERE screen_name = ? AND post_id = ?
    `).run(
        JSON.stringify(Array.isArray(imageVisionFacts) ? imageVisionFacts : []),
        JSON.stringify(Array.isArray(imageVisionStatuses) && imageVisionStatuses.length ? imageVisionStatuses : deriveImageVisionStatuses(imageVisionFacts, imageUrls)),
        JSON.stringify(Array.isArray(imageMedia) ? imageMedia.slice(0, 24) : []),
        String(screenName ?? '').trim(),
        Number(postId),
    );
}

function sourceMediaIndexFromPathV18886(value) {
    const clean = String(value ?? '').trim().replace(/\\+/gu, '/');
    const match = clean.match(/-(\d+)(?:-[a-f0-9]{8,64})?\.(?:png|jpe?g|webp|gif)$/iu);
    const parsed = Number(match?.[1] || 0);
    return Number.isInteger(parsed) && parsed > 0 ? parsed : 0;
}

function enrichPosterFactsWithStoredMediaV18886(facts, relativePath, sourceIndex) {
    const source = Array.isArray(facts) ? facts : [];
    const cleanPath = String(relativePath ?? '').trim().replace(/\\+/gu, '/');
    const index = Number(sourceIndex || 0);
    if (!cleanPath || !index) return source;
    try {
        const root = resolve(dataDirectory);
        const absolute = resolve(root, cleanPath);
        if (absolute !== root && !absolute.startsWith(`${root}${sep}`)) return source;
        if (!existsSync(absolute)) return source;
        const imageSha256 = createHash('sha256').update(readFileSync(absolute)).digest('hex');
        return source.map((fact) => (
            Number(fact?.index || 0) === index
                ? {
                    ...fact,
                    imagePath: cleanPath,
                    imageFilename: basename(cleanPath),
                    imageSha256,
                }
                : fact
        ));
    } catch {
        return source;
    }
}

function posterFactForIndex(facts, index) {
    const target = Number(index || 0);
    if (!Number.isInteger(target) || target <= 0) return null;
    return (Array.isArray(facts) ? facts : []).find((fact) => Number(fact?.index || 0) === target) || null;
}

function eventPosterBindingAudit(event, facts, imageIndex) {
    const index = Number(imageIndex || 0);
    const fact = posterFactForIndex(facts, index);
    const fallbackReason = String(event?.posterMatchReason || '').trim().toLowerCase();
    if (fallbackReason === 'single-event-single-source-image-fallback' && index === 1) {
        const paths = safeJsonArray(event?.imagePaths).map((value) => String(value ?? '').trim()).filter(Boolean);
        const factPath = String(fact?.imagePath || '').trim().replace(/\\+/gu, '/');
        const generated = /(?:^|\/)event_message_cards\/|(?:^|\/)event_generated_fallbacks\/|-event-\d+\.png$/iu.test(factPath);
        if (paths.length === 1 && fact?.poster === true && fact?.imageType === 'source-image-fallback' &&
            factPath && paths[0].replace(/\\+/gu, '/') === factPath && !generated) {
            return { index, fact, accepted: true, score: 0, reason: 'single-event-single-source-image-fallback', dateMatched: false };
        }
    }
    const match = fact ? evaluatePosterFactForEvent(event, fact) : { accepted: false, score: -1000, reason: 'missing-image-metadata' };
    return { index, fact, ...match };
}

function storedRowPosterBindingAudit(event, storedRow, storedFacts) {
    return eventPosterBindingAudit({
        ...event,
        title: String(storedRow?.title ?? event?.title ?? ''),
        eventDate: String(storedRow?.event_date ?? event?.eventDate ?? ''),
        eventTime: storedRow?.event_time ?? event?.eventTime ?? null,
        venue: String(storedRow?.venue ?? event?.venue ?? ''),
        participants: String(storedRow?.participants ?? event?.participants ?? ''),
    }, storedFacts, Number(storedRow?.poster_image_index || 0));
}

function applyCurrentSourceSafePosterBindings(events, sourcePaths, sourceUrls = [], {
    sourceKind = 'vk',
    canonicalPostUrl = '',
    sourceVisionFacts = [],
} = {}) {
    const rows = Array.isArray(events) ? events : [];
    if (!rows.length) return rows;
    const cleanSourcePaths = safeJsonArray(sourcePaths);
    const sourceFacts = Array.isArray(sourceVisionFacts) ? sourceVisionFacts : [];
    const pathForIndex = (index) => cleanSourcePaths.find((path) => sourceMediaIndexFromPathV18886(path) === Number(index || 0)) || '';

    return rows.map((event) => {
        const eventFacts = Array.isArray(event?.posterVisionFacts) ? event.posterVisionFacts : [];
        const byFactIndex = new Map();
        for (const fact of [...eventFacts, ...sourceFacts]) {
            const factIndex = Number(fact?.index || 0);
            if (!Number.isInteger(factIndex) || factIndex <= 0 || byFactIndex.has(factIndex)) continue;
            byFactIndex.set(factIndex, fact);
        }
        const facts = [...byFactIndex.values()];
        const existingPaths = safeJsonArray(event?.imagePaths);
        const existingIndex = Number(event?.posterImageIndex || sourceMediaIndexFromPathV18886(existingPaths[0]) || 0);
        const existingAudit = eventPosterBindingAudit(event, facts, existingIndex);
        const existingSafe = storedPosterStatusIsSafe(event?.posterMatchStatus, facts) && existingAudit.accepted;

        // Hard invariant: once the currently persisted source image is metadata-
        // compatible with the event, automatic source refresh cannot replace it
        // with another gallery image. A later explicit owner repair can still
        // change it after a fresh Vision comparison.
        if (existingSafe && existingPaths.length) {
            const existingPath = existingPaths.find((path) => sourceMediaIndexFromPathV18886(path) === existingIndex) || existingPaths[0];
            return {
                ...event,
                imagePaths: [existingPath],
                posterImageIndex: existingIndex,
                posterVisionFacts: enrichPosterFactsWithStoredMediaV18886(facts, existingPath, existingIndex),
            };
        }
        const existingFact = posterFactForIndex(facts, existingIndex);
        if (existingPaths.length && !posterPathIsGeneratedV18892(existingPaths[0]) && !existingFact) {
            return {
                ...event,
                imagePaths: existingPaths.slice(0, 1),
                posterMatchStatus: String(event?.posterMatchStatus || 'metadata_pending_existing_poster'),
                // Keep the real source file for later Vision repair, but retain
                // an explicit no-safe-poster marker in the reason so every
                // audit/render path remains fail-closed until metadata proves it.
                posterMatchReason: 'no-safe-poster:metadata-pending-existing-poster-preserved',
                // The retained source path is repair evidence only; without a
                // matching Vision fact there is no selected poster index.
                posterImageIndex: 0,
                posterVisionFacts: facts,
            };
        }

        const best = selectBestCompatiblePosterFact(event, facts, { preferredIndex: existingIndex });
        if (best?.ambiguous) {
            const candidates = Array.isArray(best?.candidates) ? best.candidates.map((item) => ({
                index: Number(item?.fact?.index || 0), score: Number(item?.match?.score || 0),
                reason: String(item?.match?.reason || ''), title: String(item?.fact?.title || ''), date: String(item?.fact?.date || ''),
            })).filter((item) => item.index > 0) : [];
            return {
                ...event,
                imagePaths: existingPaths.length ? existingPaths.slice(0, 1) : [],
                posterMatchStatus: 'poster_review_required',
                posterMatchReason: 'multiple-date-compatible-posters',
                posterReviewCandidates: candidates,
                posterImageIndex: existingIndex,
                posterVisionFacts: facts,
            };
        }
        const chosenIndex = Number(best?.fact?.index || 0);
        const selectedPath = chosenIndex ? pathForIndex(chosenIndex) : '';
        if (best && selectedPath) {
            return {
                ...event,
                imagePaths: [selectedPath],
                posterMatchStatus: rows.length > 1 ? 'verified_multi_event_poster' : 'verified_single_event_source_media',
                posterMatchReason: `metadata-validated:${best.match.reason}`,
                posterImageIndex: chosenIndex,
                posterVisionFacts: enrichPosterFactsWithStoredMediaV18886(facts, selectedPath, chosenIndex),
            };
        }

        // A metadata mismatch is not a deletion instruction. Preserve an
        // existing real source image and ask for review; only events that never
        // had a persisted source poster remain image-less.
        if (existingPaths.length && !posterPathIsGeneratedV18892(existingPaths[0])) {
            return {
                ...event,
                imagePaths: existingPaths.slice(0, 1),
                posterImageIndex: existingIndex,
                posterMatchStatus: 'poster_review_required',
                posterMatchReason: rows.length > 1 ? 'multi-event-source-metadata-mismatch-preserved' : 'single-event-source-metadata-mismatch-preserved',
                posterVisionFacts: facts,
            };
        }
        return {
            ...event, imagePaths: [], imageIndexes: [], posterImageIndex: 0,
            posterMatchStatus: 'no_safe_poster',
            posterMatchReason: rows.length > 1 ? 'multi-event-source-no-compatible-poster' : 'single-event-source-no-compatible-poster',
            posterVisionFacts: facts,
        };
    });
}

export function replaceVkEventsForPost({
    screenName,
    postId,
    sourceUrl,
    imagePaths,
    events,
    updatedAt,
    mergeStoredEvents = true,
}) {
    const safeScreenName = String(screenName ?? '').trim();
    const safePostId = Number(postId);
    const incomingEvents = Array.isArray(events) ? events : [];
    const storedRows = mergeStoredEvents ? database.prepare(`
        SELECT * FROM vk_events WHERE screen_name = ? AND post_id = ? ORDER BY event_index ASC, id ASC
    `).all(safeScreenName, safePostId) : [];
    let safeEvents = incomingEvents.map((event, index) => mergeIncomingEventWithStoredRow(
        event,
        selectStoredEventForIncoming(storedRows, event, index),
    ));
    const sourceMeta = database.prepare(`
        SELECT image_urls_json, source_url, image_vision_facts_json, raw_text FROM vk_source_posts
        WHERE screen_name = ? AND post_id = ? LIMIT 1
    `).get(safeScreenName, safePostId);
    const sourceUrls = safeStoredJsonArray(sourceMeta?.image_urls_json);
    safeEvents = applyCurrentSourceSafePosterBindings(safeEvents, imagePaths, sourceUrls, {
        sourceKind: 'vk',
        canonicalPostUrl: String(sourceMeta?.source_url || sourceUrl || ''),
        sourceVisionFacts: parseStoredPosterFacts(sourceMeta?.image_vision_facts_json),
    });
    safeEvents = filterPermanentlyBlockedIncomingEvents(safeEvents, {
        sourceType: 'vk',
        sourceUrl: String(sourceMeta?.source_url || sourceUrl || ''),
        canonicalPostUrl: String(sourceMeta?.source_url || sourceUrl || ''),
        sourceItemId: `${safeScreenName}:${safePostId}`,
        sourceText: String(sourceMeta?.raw_text || ''),
        posterVisionFacts: parseStoredPosterFacts(sourceMeta?.image_vision_facts_json),
    }).events;
    const imagePathsJson = JSON.stringify(safeJsonArray(imagePaths));

    const ownsTransaction = !database.isTransaction;
    if (ownsTransaction) database.exec('BEGIN IMMEDIATE');

    try {
        deleteVkEventsForPostStatement.run(safeScreenName, safePostId);

        safeEvents.forEach((event, index) => {
            const eventImagePathsJson = JSON.stringify(
                safeJsonArray(event?.imagePaths ?? imagePaths),
            );
            const insertResult = insertVkEventStatement.run(
                safeScreenName,
                safePostId,
                index,
                String(event?.title ?? '').trim(),
                String(event?.eventDate ?? '').trim(),
                event?.eventTime ? String(event.eventTime).trim() : null,
                normalizedPersistedVenue(event?.venue),
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
            writeEventV18867Metadata('vk_events', Number(insertResult.lastInsertRowid || 0), event, {
                canonicalPostUrl: String(event?.canonicalPostUrl || sourceUrl || '').trim(),
                sourceType: 'vk_wall',
                sourceItemId: `${safeScreenName}:${safePostId}`,
                sourceOriginalUrl: String(sourceUrl || '').trim(),
                canonicalOrigin: 'direct-wall',
                venue: event?.venue,
            });
        });

        if (ownsTransaction) database.exec('COMMIT');
    } catch (error) {
        if (ownsTransaction) database.exec('ROLLBACK');
        throw error;
    }
}

// Sync-only callback: no AI/network work is allowed while holding SQLite lock.
export function persistVkSourceAndEvents({ source, replacement = null, updateEvents = null, ledger = null }) {
    const ownsTransaction = !database.isTransaction;
    if (ownsTransaction) database.exec('BEGIN IMMEDIATE');
    try {
        upsertVkSourcePost(source);
        if (replacement) replaceVkEventsForPost(replacement);
        if (updateEvents) updateEvents();
        if (ledger) {
            const count = finalizeManualParserSeenItem(ledger);
            if (count !== 1) throw new Error('VK ledger row missing during source/event commit');
        }
        if (ownsTransaction) database.exec('COMMIT');
    } catch (error) {
        if (ownsTransaction) database.exec('ROLLBACK');
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
    const safeLimit = Math.min(2000, Math.max(1, Number(limit) || 10));
    const scanLimit = Math.min(5000, Math.max(200, safeLimit * 4));

    return selectVkUpcomingEventsStatement
        .all(
            String(screenName ?? '').trim(),
            String(fromDate ?? currentIsoDate()),
            scanLimit,
        )
        .filter((row) => isEventDateConsistentWithSource({
            eventDate: row.event_date,
            sourceText: row.raw_text,
            publishedAt: row.published_at,
        }))
        .slice(0, safeLimit)
        .map((row) => ({
            id: Number(row.id),
            sourceType: 'vk',
            ...readEventV18867MetadataForType('vk', row.id),
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


/* V188.94: durable permanent-deletion registry.
 * A permanent delete is NOT a title-only blacklist. It stores the event date,
 * lineage and rich event/poster metadata so reparsing cannot resurrect the
 * same event while another event with a similar generic title remains safe.
 */
database.exec(`
    CREATE TABLE IF NOT EXISTS event_permanent_blocks (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        event_date TEXT NOT NULL,
        title TEXT NOT NULL DEFAULT '',
        venue TEXT NOT NULL DEFAULT '',
        participants TEXT NOT NULL DEFAULT '',
        source_type TEXT NOT NULL DEFAULT '',
        source_item_id TEXT NOT NULL DEFAULT '',
        source_url TEXT NOT NULL DEFAULT '',
        canonical_post_url TEXT NOT NULL DEFAULT '',
        fingerprint_json TEXT NOT NULL DEFAULT '{}',
        reason TEXT NOT NULL DEFAULT 'owner-permanent-delete',
        created_by_platform TEXT NOT NULL DEFAULT '',
        created_by INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL,
        active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1))
    );

    CREATE INDEX IF NOT EXISTS event_permanent_blocks_date_idx
    ON event_permanent_blocks (event_date, active, id);
`);

/* V188.67: persistent event provenance and provable poster binding. */
ensureTableColumn('manual_events', 'owner_manual', 'INTEGER NOT NULL DEFAULT 0');
for (const tableName of ['manual_events', 'telegram_events', 'vk_events', 'vk_chat_events']) {
    ensureTableColumn(tableName, 'canonical_post_url', "TEXT NOT NULL DEFAULT ''");
    ensureTableColumn(tableName, 'source_type', "TEXT NOT NULL DEFAULT ''");
    ensureTableColumn(tableName, 'source_chat_id', 'INTEGER NOT NULL DEFAULT 0');
    ensureTableColumn(tableName, 'source_chat_name', "TEXT NOT NULL DEFAULT ''");
    ensureTableColumn(tableName, 'source_message_id', 'INTEGER NOT NULL DEFAULT 0');
    ensureTableColumn(tableName, 'source_item_id', "TEXT NOT NULL DEFAULT ''");
    ensureTableColumn(tableName, 'source_original_url', "TEXT NOT NULL DEFAULT ''");
    ensureTableColumn(tableName, 'canonical_origin', "TEXT NOT NULL DEFAULT ''");
    ensureTableColumn(tableName, 'poster_match_status', "TEXT NOT NULL DEFAULT ''");
    ensureTableColumn(tableName, 'poster_match_reason', "TEXT NOT NULL DEFAULT ''");
    ensureTableColumn(tableName, 'poster_image_index', 'INTEGER NOT NULL DEFAULT 0');
    ensureTableColumn(tableName, 'poster_vision_facts_json', "TEXT NOT NULL DEFAULT '[]'");
    ensureTableColumn(tableName, 'poster_review_candidates_json', "TEXT NOT NULL DEFAULT '[]'");
    ensureTableColumn(tableName, 'event_tags_json', "TEXT NOT NULL DEFAULT '[]'");
    ensureTableColumn(tableName, 'venue_source', "TEXT NOT NULL DEFAULT ''");
    // Durable AI cardinality/provenance for multi-announcement repair. The
    // complete source post remains in the source table; these fields retain
    // the child event's own segment and the AI structure decision.
    ensureTableColumn(tableName, 'structure_decision', "TEXT NOT NULL DEFAULT ''");
    ensureTableColumn(tableName, 'structure_reason', "TEXT NOT NULL DEFAULT ''");
    ensureTableColumn(tableName, 'source_segment_text', "TEXT NOT NULL DEFAULT ''");
    ensureTableColumn(tableName, 'program_items_json', "TEXT NOT NULL DEFAULT '[]'");
    ensureTableColumn(tableName, 'is_multi_announcement', 'INTEGER NOT NULL DEFAULT 0');
}
for (const tableName of ['telegram_source_posts', 'vk_source_posts', 'vk_chat_source_messages']) {
    ensureTableColumn(tableName, 'image_vision_facts_json', "TEXT NOT NULL DEFAULT '[]'");
    // Per-image durable Vision lifecycle. Each item is keyed by image index
    // and records whether inspection happened, found metadata, or failed.
    ensureTableColumn(tableName, 'image_vision_status_json', "TEXT NOT NULL DEFAULT '[]'");
}
ensureTableColumn('vk_source_posts', 'image_media_json', "TEXT NOT NULL DEFAULT '[]'");
ensureTableColumn('vk_chat_source_messages', 'image_media_json', "TEXT NOT NULL DEFAULT '[]'");
ensureTableColumn('vk_chat_source_messages', 'repost_urls_json', "TEXT NOT NULL DEFAULT '[]'");
ensureTableColumn('vk_chat_source_messages', 'attachment_links_json', "TEXT NOT NULL DEFAULT '[]'");
ensureTableColumn('vk_chat_source_messages', 'canonical_post_url', "TEXT NOT NULL DEFAULT ''");
ensureTableColumn('vk_chat_source_messages', 'canonical_origin', "TEXT NOT NULL DEFAULT ''");

function normalizedPersistedVenue(value) {
    const venue = String(value ?? '').trim();
    return venue || 'место не указано';
}

function deriveImageVisionStatuses(imageVisionFacts, imageUrls = []) {
    const facts = Array.isArray(imageVisionFacts) ? imageVisionFacts : [];
    const urls = Array.isArray(imageUrls) ? imageUrls : [];
    const max = Math.max(facts.reduce((m, f) => Math.max(m, Number(f?.index || 0)), 0), urls.length);
    const result = [];
    for (let i = 1; i <= max; i += 1) {
        const fact = facts.find((item) => Number(item?.index || 0) === i);
        const hasImage = Boolean(String(urls[i - 1] ?? '').trim()) || Boolean(fact);
        if (!hasImage) continue;
        const status = String(fact?.visionStatus || '').trim() || (fact?.visionInspected
            ? (fact?.poster || fact?.title || fact?.dates || fact?.time || fact?.venue || fact?.participants || fact?.price
                ? 'metadata_found' : 'metadata_not_found')
            : 'not_run');
        result.push({ index: i, status, inspected: status !== 'not_run', attempts: Number(fact?.visionAttempts || (status === 'not_run' ? 0 : 1)), updatedAt: Math.floor(Date.now() / 1000) });
    }
    return result;
}

function writeEventV18867Metadata(tableName, id, event = {}, defaults = {}) {
    const eventId = Number(id);
    if (!Number.isSafeInteger(eventId) || eventId <= 0) return;
    const facts = Array.isArray(event?.posterVisionFacts)
        ? event.posterVisionFacts
        : Array.isArray(defaults?.posterVisionFacts)
            ? defaults.posterVisionFacts
            : [];
    const structureDecision = String(event?.structureDecision ?? event?.structure_decision ?? defaults?.structureDecision ?? '').trim();
    const values = {
        canonicalPostUrl: String(event?.canonicalPostUrl ?? defaults?.canonicalPostUrl ?? '').trim(),
        sourceType: String(event?.provenanceSourceType ?? defaults?.sourceType ?? '').trim(),
        sourceChatId: Number(event?.sourceChatId ?? defaults?.sourceChatId ?? 0) || 0,
        sourceChatName: String(event?.sourceChatName ?? defaults?.sourceChatName ?? '').trim(),
        sourceMessageId: Number(event?.sourceMessageId ?? defaults?.sourceMessageId ?? 0) || 0,
        sourceItemId: String(event?.sourceItemId ?? defaults?.sourceItemId ?? '').trim(),
        sourceOriginalUrl: String(event?.sourceOriginalUrl ?? defaults?.sourceOriginalUrl ?? '').trim(),
        canonicalOrigin: String(event?.canonicalOrigin ?? defaults?.canonicalOrigin ?? '').trim(),
        posterMatchStatus: String(event?.posterMatchStatus ?? defaults?.posterMatchStatus ?? '').trim(),
        posterMatchReason: String(event?.posterMatchReason ?? defaults?.posterMatchReason ?? '').trim(),
        posterImageIndex: Number(event?.posterImageIndex ?? defaults?.posterImageIndex ?? 0) || 0,
        posterVisionFactsJson: JSON.stringify(facts),
        posterReviewCandidatesJson: JSON.stringify(Array.isArray(event?.posterReviewCandidates) ? event.posterReviewCandidates : (Array.isArray(defaults?.posterReviewCandidates) ? defaults.posterReviewCandidates : [])),
        eventTagsJson: JSON.stringify(Array.isArray(event?.eventTags) ? event.eventTags : (Array.isArray(defaults?.eventTags) ? defaults.eventTags : [])),
        venueSource: String(event?.venueSource ?? defaults?.venueSource ?? '').trim(),
        structureDecision,
        structureReason: String(event?.structureReason ?? event?.structure_reason ?? defaults?.structureReason ?? '').trim(),
        sourceSegmentText: String(event?.sourceSegment ?? event?.source_segment ?? defaults?.sourceSegment ?? '').trim(),
        programItemsJson: JSON.stringify(Array.isArray(event?.programItems ?? event?.program_items)
            ? (event?.programItems ?? event?.program_items).slice(0, 64)
            : []),
        isMultiAnnouncement: Number(event?.isMultiAnnouncement ?? event?.is_multi_announcement ??
            (structureDecision === 'multiple_events' ? 1 : 0)) ? 1 : 0,
    };
    database.prepare(`
        UPDATE ${tableName}
        SET canonical_post_url = CASE WHEN ? <> '' THEN ? ELSE canonical_post_url END,
            source_type = CASE WHEN ? <> '' THEN ? ELSE source_type END,
            source_chat_id = CASE WHEN ? <> 0 THEN ? ELSE source_chat_id END,
            source_chat_name = CASE WHEN ? <> '' THEN ? ELSE source_chat_name END,
            source_message_id = CASE WHEN ? <> 0 THEN ? ELSE source_message_id END,
            source_item_id = CASE WHEN ? <> '' THEN ? ELSE source_item_id END,
            source_original_url = CASE WHEN ? <> '' THEN ? ELSE source_original_url END,
            canonical_origin = CASE WHEN ? <> '' THEN ? ELSE canonical_origin END,
            poster_match_status = CASE WHEN ? <> '' THEN ? ELSE poster_match_status END,
            poster_match_reason = CASE WHEN ? <> '' THEN ? ELSE poster_match_reason END,
            poster_image_index = CASE WHEN ? <> 0 THEN ? ELSE poster_image_index END,
            poster_vision_facts_json = CASE WHEN ? <> '[]' THEN ? ELSE poster_vision_facts_json END,
            poster_review_candidates_json = CASE WHEN ? <> '[]' THEN ? ELSE poster_review_candidates_json END,
            event_tags_json = CASE WHEN ? <> '[]' THEN ? ELSE event_tags_json END,
            venue_source = CASE WHEN ? <> '' THEN ? ELSE venue_source END,
            structure_decision = CASE WHEN ? <> '' THEN ? ELSE structure_decision END,
            structure_reason = CASE WHEN ? <> '' THEN ? ELSE structure_reason END,
            source_segment_text = CASE WHEN ? <> '' THEN ? ELSE source_segment_text END,
            program_items_json = CASE WHEN ? <> '[]' THEN ? ELSE program_items_json END,
            is_multi_announcement = CASE WHEN ? <> 0 THEN ? ELSE is_multi_announcement END,
            venue = CASE WHEN TRIM(venue) = '' THEN ? ELSE venue END
        WHERE id = ?
    `).run(
        values.canonicalPostUrl, values.canonicalPostUrl,
        values.sourceType, values.sourceType,
        values.sourceChatId, values.sourceChatId,
        values.sourceChatName, values.sourceChatName,
        values.sourceMessageId, values.sourceMessageId,
        values.sourceItemId, values.sourceItemId,
        values.sourceOriginalUrl, values.sourceOriginalUrl,
        values.canonicalOrigin, values.canonicalOrigin,
        values.posterMatchStatus, values.posterMatchStatus,
        values.posterMatchReason, values.posterMatchReason,
        values.posterImageIndex, values.posterImageIndex,
        values.posterVisionFactsJson, values.posterVisionFactsJson,
        values.posterReviewCandidatesJson, values.posterReviewCandidatesJson,
        values.eventTagsJson, values.eventTagsJson,
        values.venueSource, values.venueSource,
        values.structureDecision, values.structureDecision,
        values.structureReason, values.structureReason,
        values.sourceSegmentText, values.sourceSegmentText,
        values.programItemsJson, values.programItemsJson,
        values.isMultiAnnouncement, values.isMultiAnnouncement,
        normalizedPersistedVenue(event?.venue ?? defaults?.venue),
        eventId,
    );
    const acceptedPoster = storedPosterStatusIsSafe(values.posterMatchStatus, values.posterVisionFactsJson) && values.posterImageIndex > 0;
    console.log(
        '[EVENT POSTER BINDING]',
        `event=${tableName}:${eventId}`,
        acceptedPoster ? `image=${values.posterImageIndex}` : 'image=none',
        acceptedPoster ? `accepted:${values.posterMatchReason || values.posterMatchStatus}` : 'rejected:no-safe-poster',
    );
    console.log(
        '[EVENT PROVENANCE STORED]',
        `event=${tableName}:${eventId}`,
        `origin=${values.canonicalOrigin || 'unknown'}`,
        `url=${values.canonicalPostUrl || 'none'}`,
    );
}


function parseStoredImagePaths(value) {
    try {
        const parsed = JSON.parse(value ?? '[]');
        return Array.isArray(parsed) ? parsed.map((item) => String(item ?? '').trim()).filter(Boolean) : [];
    } catch { return []; }
}

function posterPathIsGeneratedV18892(value) {
    const clean = String(value ?? '').trim().replace(/\\+/gu, '/');
    return /(?:^|\/)event_message_cards\//iu.test(clean) || /-event-\d+\.png$/iu.test(clean);
}

function legacyPosterPathLooksClean(relativePath) {
    const clean = String(relativePath ?? '').trim().replace(/\\+/gu, '/').replace(/^\.\//u, '');
    if (!clean || /^https?:\/\//iu.test(clean)) return false;
    if (/(?:^|\/)event_message_cards\//iu.test(clean) || /-event-\d+\.png$/iu.test(clean)) return false;
    const root = resolve(dataDirectory);
    const absolute = resolve(root, clean);
    if (absolute !== root && !absolute.startsWith(`${root}${sep}`)) return false;
    if (!existsSync(absolute)) return false;
    try {
        const buffer = readFileSync(absolute);
        const byteLength = buffer.length;
        const { width, height } = detectRasterImageDimensions(buffer);
        if (!width || !height) return byteLength >= 45_000;
        const area = width * height;
        const ratio = width / height;
        return byteLength >= 1_024 && Math.max(width, height) >= 48 && Math.min(width, height) >= 32 && area >= 2_048 && ratio >= 0.12 && ratio <= 8.0;
    } catch {
        return false;
    }
}

function cleanLegacyPosterPaths(paths) {
    return [...new Set((Array.isArray(paths) ? paths : [])
        .map((value) => String(value ?? '').trim())
        .filter((value) => value && legacyPosterPathLooksClean(value)))];
}

function legacyCapturedMediaIndex(relativePath) {
    const clean = String(relativePath ?? '').trim().replace(/\\+/gu, '/');
    if (!clean || /-event-\d+\.(?:png|jpe?g|webp)$/iu.test(clean)) return 0;
    const match = clean.match(/-(\d+)(?:-[a-f0-9]{8,64})?\.(?:png|jpe?g|webp)$/iu);
    return match ? Number(match[1]) || 0 : 0;
}

function legacySourceUrlLooksNonPoster(value) {
    const text = String(value ?? '').trim();
    if (!text) return false;
    if (/[?&]ava=1(?:&|$)/iu.test(text)) return true;
    if (/[?&]type=(?:audio|avatar|emoji|icon)(?:&|$)/iu.test(text)) return true;
    if (/\/(?:emoji|stickers?|icons?)\//iu.test(text)) return true;
    return false;
}

function cleanLegacySourcePosterPaths(paths, sourceUrls = []) {
    const urls = Array.isArray(sourceUrls) ? sourceUrls.map((value) => String(value ?? '').trim()) : [];
    return [...new Set((Array.isArray(paths) ? paths : [])
        .map((value) => String(value ?? '').trim())
        .filter((path) => {
            if (!path || !legacyPosterPathLooksClean(path)) return false;
            const index = legacyCapturedMediaIndex(path);
            const sourceUrl = index > 0 ? urls[index - 1] : '';
            return !legacySourceUrlLooksNonPoster(sourceUrl);
        }))];
}

function recoverIndexedLegacyMediaPaths(paths, sourceUrls = [], { relativeDirectory = '', itemId = '' } = {}) {
    const existing = [...new Set((Array.isArray(paths) ? paths : [])
        .map((value) => String(value ?? '').trim().replace(/\\+/gu, '/'))
        .filter(Boolean))];
    const urls = Array.isArray(sourceUrls) ? sourceUrls : [];
    const directory = String(relativeDirectory ?? '').trim().replace(/\\+/gu, '/').replace(/^\/+|\/+$/gu, '');
    const baseId = String(itemId ?? '').trim();
    if (!directory || !baseId || !urls.length) return existing;

    const byIndex = new Map();
    const unindexed = [];
    for (const path of existing) {
        const index = legacyCapturedMediaIndex(path);
        if (index > 0 && !byIndex.has(index)) byIndex.set(index, path);
        else unindexed.push(path);
    }
    const extensions = ['jpg', 'jpeg', 'png', 'webp'];
    const maximum = Math.min(24, urls.length);
    for (let index = 1; index <= maximum; index += 1) {
        if (byIndex.has(index)) continue;
        for (const extension of extensions) {
            const relativePath = `${directory}/${baseId}-${index}.${extension}`;
            const absolutePath = resolve(dataDirectory, relativePath);
            const root = resolve(dataDirectory);
            if (absolutePath !== root && absolutePath.startsWith(`${root}${sep}`) && existsSync(absolutePath)) {
                byIndex.set(index, relativePath);
                break;
            }
        }
    }
    return [
        ...[...byIndex.entries()].sort((left, right) => left[0] - right[0]).map((entry) => entry[1]),
        ...unindexed,
    ];
}

function normalizedEventIdentityText(value) {
    return String(value ?? '').normalize('NFKC').toLowerCase().replace(/ё/gu, 'е').replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
}

function posterVisionFactsExplicitlyConfirmPoster(value) {
    let facts = value;
    if (typeof facts === 'string') {
        try { facts = JSON.parse(facts || '[]'); } catch { facts = []; }
    }
    if (!Array.isArray(facts)) return false;
    return facts.some((fact) => {
        if (!fact || typeof fact !== 'object') return false;
        if (fact.sourceMediaBinding === true && String(fact.imagePath || '').trim()) return true;
        if (fact.poster === true) return Number(fact.posterConfidence ?? 100) >= 55;
        const text = String(fact.text ?? '').toLowerCase().replace(/ё/gu, 'е');
        return /(?:это\s+)?афиша\s+события\s*:\s*да(?:\b|[.!;,])/iu.test(text) ||
            /это\s+афиша\s+события\s*[-—–]\s*да(?:\b|[.!;,])/iu.test(text);
    });
}

function storedPosterStatusIsSafe(value, posterVisionFacts = []) {
    const status = String(value ?? '').trim();
    if (status === 'verified_single_event_source_media') {
        return posterVisionFactsExplicitlyConfirmPoster(posterVisionFacts);
    }
    // Generated cards are intentionally NOT safe source posters.  V188.86
    // never emits or persists AI/deterministic announcement artwork as media.
    return [
        'exact_poster_match',
        'verified_multi_event_poster',
        'verified_title_date_poster',
        'legacy_manual_poster',
    ].includes(status);
}

function selectStoredEventForIncoming(rows, event, index) {
    const list = Array.isArray(rows) ? rows : [];
    const date = String(event?.eventDate ?? '').trim();
    const title = normalizedEventIdentityText(event?.title || event?.participants || '');
    if (date && title) {
        const exact = list.find((row) => (
            String(row?.event_date ?? '').trim() === date &&
            normalizedEventIdentityText(row?.title || row?.participants || '') === title
        ));
        if (exact) return exact;
    }
    if (date) {
        const sameDate = list.filter((row) => String(row?.event_date ?? '').trim() === date);
        if (sameDate.length === 1) return sameDate[0];
    }
    return list.find((row) => Number(row?.event_index ?? -1) === Number(index)) || null;
}

function mergeIncomingEventWithStoredRow(event, storedRow) {
    if (!storedRow) return {
        ...event,
        venue: normalizedPersistedVenue(event?.venue),
    };
    const pick = (incoming, stored) => String(incoming ?? '').trim() || String(stored ?? '').trim();
    const incomingVenue = String(event?.venue ?? '').trim();
    const storedVenue = String(storedRow?.venue ?? '').trim();
    const venue = incomingVenue && incomingVenue.toLowerCase() !== 'место не указано'
        ? incomingVenue
        : storedVenue && storedVenue.toLowerCase() !== 'место не указано'
            ? storedVenue
            : normalizedPersistedVenue(incomingVenue || storedVenue);
    const incomingImages = Array.isArray(event?.imagePaths)
        ? event.imagePaths.map((value) => String(value ?? '').trim()).filter(Boolean)
        : [];
    const storedImages = parseStoredImagePaths(storedRow?.image_paths_json);
    let storedFacts = [];
    try {
        const parsed = JSON.parse(storedRow?.poster_vision_facts_json ?? '[]');
        storedFacts = Array.isArray(parsed) ? parsed : [];
    } catch {}
    const incomingFacts = Array.isArray(event?.posterVisionFacts) ? event.posterVisionFacts : [];
    let storedTags = [];
    let storedReviewCandidates = [];
    try { storedTags = JSON.parse(storedRow?.event_tags_json ?? '[]'); } catch { storedTags = []; }
    try { storedReviewCandidates = JSON.parse(storedRow?.poster_review_candidates_json ?? '[]'); } catch { storedReviewCandidates = []; }
    if (!Array.isArray(storedTags)) storedTags = [];
    if (!Array.isArray(storedReviewCandidates)) storedReviewCandidates = [];
    const incomingIndex = Number(event?.posterImageIndex || sourceMediaIndexFromPathV18886(incomingImages[0]) || 0);
    const storedIndex = Number(storedRow?.poster_image_index || sourceMediaIndexFromPathV18886(storedImages[0]) || 0);
    const incomingAudit = eventPosterBindingAudit(event, incomingFacts, incomingIndex);
    const storedAudit = storedRowPosterBindingAudit(event, storedRow, storedFacts);
    const incomingSafe = storedPosterStatusIsSafe(event?.posterMatchStatus, incomingFacts) && incomingAudit.accepted;
    const storedSafe = storedPosterStatusIsSafe(storedRow?.poster_match_status, storedFacts) && storedAudit.accepted;
    const storedFact = posterFactForIndex(storedFacts, storedIndex);
    const storedMetadataPending = storedImages.length > 0 && !posterPathIsGeneratedV18892(storedImages[0]) && !storedFact;
    // A metadata-compatible stored poster is sticky. If metadata is missing,
    // preserve the existing bytes and queue them for explicit owner backfill;
    // automatic parse/merge is not allowed to replace an unknown old image.
    const imagePaths = (storedSafe || storedMetadataPending) && storedImages.length
        ? storedImages.slice(0, 1)
        : incomingSafe && incomingImages.length
            ? incomingImages.slice(0, 1)
            : [];
    return {
        ...event,
        title: pick(event?.title, storedRow?.title),
        eventDate: pick(event?.eventDate, storedRow?.event_date),
        eventTime: pick(event?.eventTime, storedRow?.event_time) || null,
        venue,
        participants: pick(event?.participants, storedRow?.participants),
        price: pick(event?.price, storedRow?.price),
        description: pick(event?.description, storedRow?.description),
        evidence: pick(event?.evidence, storedRow?.evidence),
        announcement: pick(event?.announcement, storedRow?.announcement),
        sourceSegment: pick(event?.sourceSegment ?? event?.source_segment, storedRow?.source_segment_text),
        structureDecision: pick(event?.structureDecision ?? event?.structure_decision, storedRow?.structure_decision),
        structureReason: pick(event?.structureReason ?? event?.structure_reason, storedRow?.structure_reason),
        programItems: Array.isArray(event?.programItems ?? event?.program_items)
            ? (event?.programItems ?? event?.program_items)
            : (() => { try { const parsed = JSON.parse(storedRow?.program_items_json ?? '[]'); return Array.isArray(parsed) ? parsed : []; } catch { return []; } })(),
        isMultiAnnouncement: Number(event?.isMultiAnnouncement ?? event?.is_multi_announcement ?? storedRow?.is_multi_announcement ?? 0) ? 1 : 0,
        imagePaths,
        canonicalPostUrl: pick(event?.canonicalPostUrl, storedRow?.canonical_post_url),
        provenanceSourceType: pick(event?.provenanceSourceType, storedRow?.source_type),
        sourceChatId: Number(event?.sourceChatId || storedRow?.source_chat_id || 0),
        sourceChatName: pick(event?.sourceChatName, storedRow?.source_chat_name),
        sourceMessageId: Number(event?.sourceMessageId || storedRow?.source_message_id || 0),
        sourceItemId: pick(event?.sourceItemId, storedRow?.source_item_id),
        sourceOriginalUrl: pick(event?.sourceOriginalUrl, storedRow?.source_original_url),
        canonicalOrigin: pick(event?.canonicalOrigin, storedRow?.canonical_origin),
        posterMatchStatus: storedSafe
            ? String(storedRow?.poster_match_status ?? '')
            : storedMetadataPending
                ? String(storedRow?.poster_match_status || 'metadata_pending_existing_poster')
                : incomingSafe
                    ? String(event?.posterMatchStatus ?? '')
                    : 'no_safe_poster',
        posterMatchReason: storedSafe
            ? String(storedRow?.poster_match_reason ?? '')
            : storedMetadataPending
                ? 'metadata-pending-existing-poster-preserved'
                : incomingSafe
                    ? `metadata-validated:${String(event?.posterMatchReason ?? incomingAudit.reason)}`
                    : 'metadata-mismatch-no-safe-poster',
        posterImageIndex: storedSafe || storedMetadataPending
            ? storedIndex
            : incomingSafe
                ? incomingIndex
                : 0,
        posterVisionFacts: storedSafe || storedMetadataPending
            ? storedFacts
            : incomingSafe
                ? incomingFacts
                : (incomingFacts.length ? incomingFacts : storedFacts),
        venueSource: incomingVenue && incomingVenue.toLowerCase() !== 'место не указано'
            ? pick(event?.venueSource, 'structured-or-text')
            : pick('', storedRow?.venue_source),
    };
}

function parseEventV18867Metadata(row) {
    let posterVisionFacts = [];
    let posterReviewCandidates = [];
    let eventTags = [];
    let programItems = [];
    try {
        const parsed = JSON.parse(row?.poster_vision_facts_json ?? '[]');
        posterVisionFacts = Array.isArray(parsed) ? parsed : [];
    } catch { posterVisionFacts = []; }
    try {
        const parsed = JSON.parse(row?.poster_review_candidates_json ?? '[]');
        posterReviewCandidates = Array.isArray(parsed) ? parsed : [];
    } catch { posterReviewCandidates = []; }
    try {
        const parsed = JSON.parse(row?.event_tags_json ?? '[]');
        eventTags = Array.isArray(parsed) ? parsed.map((item) => String(item ?? '').trim()).filter(Boolean) : [];
    } catch { eventTags = []; }
    try {
        const parsed = JSON.parse(row?.program_items_json ?? '[]');
        programItems = Array.isArray(parsed) ? parsed : [];
    } catch { programItems = []; }
    return {
        canonicalPostUrl: String(row?.canonical_post_url ?? ''),
        provenanceSourceType: String(row?.source_type ?? ''),
        sourceChatId: Number(row?.source_chat_id ?? 0),
        sourceChatName: String(row?.source_chat_name ?? ''),
        sourceMessageId: Number(row?.source_message_id ?? 0),
        sourceItemId: String(row?.source_item_id ?? ''),
        sourceOriginalUrl: String(row?.source_original_url ?? ''),
        canonicalOrigin: String(row?.canonical_origin ?? ''),
        posterMatchStatus: String(row?.poster_match_status ?? ''),
        posterMatchReason: String(row?.poster_match_reason ?? ''),
        posterImageIndex: Number(row?.poster_image_index ?? 0),
        posterVisionFacts,
        posterReviewCandidates,
        eventTags,
        venueSource: String(row?.venue_source ?? ''),
        structureDecision: String(row?.structure_decision ?? ''),
        structureReason: String(row?.structure_reason ?? ''),
        sourceSegment: String(row?.source_segment_text ?? ''),
        programItems,
        isMultiAnnouncement: Boolean(Number(row?.is_multi_announcement ?? 0)),
    };
}

const eventV18867MetadataStatements = new Map();
function readEventV18867Metadata(tableName, id) {
    const allowed = new Set(['manual_events', 'telegram_events', 'vk_events', 'vk_chat_events']);
    if (!allowed.has(tableName)) return parseEventV18867Metadata(null);
    let statement = eventV18867MetadataStatements.get(tableName);
    if (!statement) {
        statement = database.prepare(`
            SELECT canonical_post_url, source_type, source_chat_id, source_chat_name,
                   source_message_id, source_item_id, source_original_url, canonical_origin,
                   poster_match_status, poster_match_reason, poster_image_index,
                   poster_vision_facts_json, poster_review_candidates_json, event_tags_json, venue_source,
                   structure_decision, structure_reason, source_segment_text, program_items_json,
                   is_multi_announcement
            FROM ${tableName} WHERE id = ? LIMIT 1
        `);
        eventV18867MetadataStatements.set(tableName, statement);
    }
    return parseEventV18867Metadata(statement.get(Number(id)));
}

function readEventV18867MetadataForType(sourceType, id) {
    const table = {
        manual: 'manual_events',
        telegram: 'telegram_events',
        vk: 'vk_events',
        vk_chat: 'vk_chat_events',
    }[String(sourceType ?? '').trim()];
    return table ? readEventV18867Metadata(table, id) : parseEventV18867Metadata(null);
}

function parsePermanentEventBlockRow(row) {
    if (!row) return null;
    let fingerprint = {};
    try {
        const parsed = JSON.parse(String(row.fingerprint_json || '{}'));
        fingerprint = parsed && typeof parsed === 'object' ? parsed : {};
    } catch { fingerprint = {}; }
    return {
        id: Number(row.id || 0),
        eventDate: String(row.event_date || fingerprint.eventDate || ''),
        title: String(row.title || fingerprint.title || ''),
        venue: String(row.venue || fingerprint.venue || ''),
        participants: String(row.participants || fingerprint.participants || ''),
        sourceType: String(row.source_type || fingerprint.sourceType || ''),
        sourceItemId: String(row.source_item_id || fingerprint.sourceItemId || ''),
        sourceUrl: String(row.source_url || fingerprint.sourceUrl || ''),
        canonicalPostUrl: String(row.canonical_post_url || fingerprint.canonicalPostUrl || ''),
        fingerprint,
        reason: String(row.reason || ''),
        createdByPlatform: String(row.created_by_platform || ''),
        createdBy: Number(row.created_by || 0),
        createdAt: Number(row.created_at || 0),
        active: Boolean(row.active),
    };
}

export function getPermanentEventBlocks({ activeOnly = true, limit = 5000 } = {}) {
    const rows = database.prepare(`
        SELECT * FROM event_permanent_blocks
        ${activeOnly ? 'WHERE active = 1' : ''}
        ORDER BY created_at DESC, id DESC
        LIMIT ?
    `).all(Math.min(20_000, Math.max(1, Number(limit) || 5000)));
    return rows.map(parsePermanentEventBlockRow).filter(Boolean);
}

export function findPermanentEventBlockMatch(event, blocks = null) {
    const eventDate = String(event?.eventDate || event?.date || '').trim();
    if (!eventDate) return null;
    const source = Array.isArray(blocks)
        ? blocks
        : database.prepare(`
            SELECT * FROM event_permanent_blocks
            WHERE active = 1 AND event_date = ?
            ORDER BY id DESC
        `).all(eventDate).map(parsePermanentEventBlockRow).filter(Boolean);
    let best = null;
    for (const block of source) {
        const comparison = compareEventToPermanentFingerprint(event, block);
        if (!comparison.matched) continue;
        if (!best || comparison.score > best.score) best = { block, ...comparison };
    }
    return best;
}

export function createPermanentEventBlock(event, {
    reason = 'owner-permanent-delete',
    createdByPlatform = '',
    createdBy = 0,
    createdAt = Math.floor(Date.now() / 1000),
} = {}) {
    const fingerprint = buildPermanentEventFingerprint(event);
    if (!fingerprint.eventDate) throw new Error('Permanent event deletion requires an event date.');
    if (!fingerprint.title && !fingerprint.participants) throw new Error('Permanent event deletion requires an event title or participants.');
    const existing = findPermanentEventBlockMatch(fingerprint);
    if (existing?.block) return { added: false, block: existing.block, comparison: existing };
    const result = database.prepare(`
        INSERT INTO event_permanent_blocks (
            event_date, title, venue, participants, source_type, source_item_id,
            source_url, canonical_post_url, fingerprint_json, reason,
            created_by_platform, created_by, created_at, active
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)
    `).run(
        fingerprint.eventDate,
        fingerprint.title,
        fingerprint.venue,
        fingerprint.participants,
        fingerprint.sourceType,
        fingerprint.sourceItemId,
        fingerprint.sourceUrl,
        fingerprint.canonicalPostUrl,
        JSON.stringify(fingerprint),
        String(reason || 'owner-permanent-delete'),
        String(createdByPlatform || ''),
        Number(createdBy) || 0,
        Number(createdAt) || Math.floor(Date.now() / 1000),
    );
    const block = parsePermanentEventBlockRow(database.prepare('SELECT * FROM event_permanent_blocks WHERE id = ?').get(Number(result.lastInsertRowid || 0)));
    return { added: true, block, comparison: null };
}

function storedEventsForDeletionV18894() {
    const out = [];
    const mainSources = [
        {
            type: 'telegram',
            table: 'telegram_events',
            join: 'LEFT JOIN telegram_source_posts AS p ON p.channel = e.channel AND p.message_id = e.message_id',
            sourceText: 'p.raw_text',
        },
        {
            type: 'vk',
            table: 'vk_events',
            join: 'LEFT JOIN vk_source_posts AS p ON p.screen_name = e.screen_name AND p.post_id = e.post_id',
            sourceText: 'p.raw_text',
        },
        {
            type: 'vk_chat',
            table: 'vk_chat_events',
            join: 'LEFT JOIN vk_chat_source_messages AS p ON p.peer_id = e.peer_id AND p.conversation_message_id = e.conversation_message_id',
            sourceText: 'p.raw_text',
        },
        {
            type: 'manual',
            table: 'manual_events',
            join: '',
            sourceText: 'e.source_text',
        },
    ];
    for (const spec of mainSources) {
        const rows = database.prepare(`
            SELECT e.*, ${spec.sourceText} AS deletion_source_text
            FROM ${spec.table} AS e
            ${spec.join}
            WHERE e.status IN ('approved', 'pending', 'ignored')
        `).all();
        for (const row of rows) {
            const meta = parseEventV18867Metadata(row);
            out.push({
                id: Number(row.id),
                sourceType: spec.type,
                title: String(row.title || ''),
                eventDate: String(row.event_date || ''),
                eventTime: row.event_time ? String(row.event_time) : null,
                venue: String(row.venue || ''),
                participants: String(row.participants || ''),
                description: String(row.description || ''),
                evidence: String(row.evidence || ''),
                sourceUrl: String(row.source_url || ''),
                sourceText: String(row.deletion_source_text || ''),
                ...meta,
                ownerManual: Boolean(row.owner_manual),
            });
        }
    }
    const qRows = qticketsDatabase.prepare(`
        SELECT * FROM qtickets_events
        WHERE status IN ('approved', 'pending', 'ignored')
    `).all();
    for (const row of qRows) out.push(mapQticketsEventRow(row));
    return out;
}

function markStoredEventIgnoredV18894(event, updatedAt) {
    const sourceType = String(event?.sourceType || '').trim();
    const id = Number(event?.id || 0);
    if (!Number.isSafeInteger(id) || id <= 0) return 0;
    if (sourceType === 'qtickets') {
        return Number(qticketsDatabase.prepare(`UPDATE qtickets_events SET status = 'ignored', updated_at = ? WHERE id = ?`).run(updatedAt, id).changes || 0);
    }
    const table = {
        manual: 'manual_events',
        telegram: 'telegram_events',
        vk: 'vk_events',
        vk_chat: 'vk_chat_events',
    }[sourceType];
    if (!table) return 0;
    database.prepare(`DELETE FROM event_dedupe_members WHERE source_type = ? AND event_id = ?`).run(sourceType, id);
    return Number(database.prepare(`UPDATE ${table} SET status = 'ignored', updated_at = ? WHERE id = ?`).run(updatedAt, id).changes || 0);
}

export function softDeleteMatchingStoredEvents(event, {
    updatedAt = Math.floor(Date.now() / 1000),
} = {}) {
    const fingerprint = buildPermanentEventFingerprint(event);
    const changed = [];
    for (const candidate of storedEventsForDeletionV18894()) {
        const comparison = compareEventToPermanentFingerprint(candidate, fingerprint);
        if (!comparison.matched) continue;
        if (markStoredEventIgnoredV18894(candidate, Number(updatedAt) || Math.floor(Date.now() / 1000))) {
            changed.push({ sourceType: candidate.sourceType, id: candidate.id, title: candidate.title, score: comparison.score, reasons: comparison.reasons });
        }
    }
    return { changed: changed.length, rows: changed, fingerprint };
}

export function permanentlyDeleteStoredEvent(event, options = {}) {
    const created = createPermanentEventBlock(event, options);
    const deleted = softDeleteMatchingStoredEvents(event, { updatedAt: options.createdAt || Math.floor(Date.now() / 1000) });
    return { ...created, deleted };
}

export function restorePermanentEventBlocks(query) {
    const clean = String(query || '').trim();
    if (!clean) return { restored: [], blocks: getPermanentEventBlocks() };
    const normalized = clean.normalize('NFKC').toLowerCase().replace(/ё/gu, 'е').replace(/[^a-zа-я0-9]+/giu, ' ').trim();
    const numericId = Number(clean.replace(/^#/, ''));
    const blocks = getPermanentEventBlocks({ activeOnly: true, limit: 20_000 });
    const matches = blocks.filter((block) => {
        if (Number.isSafeInteger(numericId) && numericId > 0 && block.id === numericId) return true;
        const hay = permanentEventFingerprintLabel(block).normalize('NFKC').toLowerCase().replace(/ё/gu, 'е').replace(/[^a-zа-я0-9]+/giu, ' ').trim();
        return normalized.length >= 3 && (hay.includes(normalized) || normalized.includes(hay));
    });
    const update = database.prepare('UPDATE event_permanent_blocks SET active = 0 WHERE id = ?');
    for (const block of matches) update.run(block.id);
    return { restored: matches, blocks: getPermanentEventBlocks() };
}


function filterPermanentlyBlockedIncomingEvents(events, defaults = {}) {
    const kept = [];
    const blocked = [];
    for (const event of Array.isArray(events) ? events : []) {
        const candidate = {
            ...event,
            sourceType: event?.sourceType || event?.provenanceSourceType || defaults.sourceType || '',
            provenanceSourceType: event?.provenanceSourceType || defaults.sourceType || '',
            sourceUrl: event?.sourceUrl || defaults.sourceUrl || '',
            sourceOriginalUrl: event?.sourceOriginalUrl || defaults.sourceOriginalUrl || defaults.sourceUrl || '',
            canonicalPostUrl: event?.canonicalPostUrl || defaults.canonicalPostUrl || defaults.sourceUrl || '',
            sourceItemId: event?.sourceItemId || defaults.sourceItemId || '',
            sourceText: event?.sourceText || defaults.sourceText || '',
            posterVisionFacts: Array.isArray(event?.posterVisionFacts) ? event.posterVisionFacts : (Array.isArray(defaults.posterVisionFacts) ? defaults.posterVisionFacts : []),
        };
        const match = findPermanentEventBlockMatch(candidate);
        if (match) {
            blocked.push({ event: candidate, block: match.block, score: match.score, reasons: match.reasons });
            continue;
        }
        kept.push(event);
    }
    if (blocked.length) {
        for (const item of blocked) {
            console.log(
                '[PERMANENT EVENT BLOCK]',
                `event=${JSON.stringify(String(item.event?.title || item.event?.participants || ''))}`,
                `date=${String(item.event?.eventDate || '')}`,
                `block=#${item.block?.id || 0}`,
                `score=${item.score}`,
                `reasons=${item.reasons.join(',')}`,
            );
        }
    }
    return { events: kept, blocked };
}

function canonicalVkWallUrlForDb(value) {
    const text = String(value ?? '').trim();
    if (!text) return '';
    let decoded = text;
    try { decoded = decodeURIComponent(text); } catch {}
    const match = decoded.match(/(?:[?&]w=|\/?)(wall-?\d+_\d+)/iu);
    return match ? `https://vk.ru/${String(match[1]).toLowerCase()}` : '';
}

function canonicalTelegramUrlForDb(value) {
    const text = String(value ?? '').trim();
    const match = text.match(/https?:\/\/(?:www\.)?(?:t\.me|telegram\.me)\/(?:s\/)?([^/?#\s]+)\/(\d+)/iu);
    return match ? `https://t.me/${match[1]}/${Number(match[2])}` : '';
}

function firstStoredWallUrl(...values) {
    for (const value of values) {
        if (Array.isArray(value)) {
            for (const item of value) {
                const found = canonicalVkWallUrlForDb(item);
                if (found) return found;
            }
            continue;
        }
        const direct = canonicalVkWallUrlForDb(value);
        if (direct) return direct;
        for (const match of String(value ?? '').match(/https?:\/\/[^\s<>'"«»]+/giu) ?? []) {
            const found = canonicalVkWallUrlForDb(match);
            if (found) return found;
        }
    }
    return '';
}

function safeStoredJsonArray(value) {
    try {
        const parsed = JSON.parse(String(value ?? '[]'));
        return Array.isArray(parsed) ? parsed : [];
    } catch { return []; }
}

function inferConservativeVenueFromStoredText(value) {
    const text = String(value ?? '');
    const patterns = [
        /(?:^|\n)\s*📍\s*([^\n]{3,160})/iu,
        /(?:^|\n)\s*(?:место|площадка|venue|локация)\s*[:—-]\s*([^\n]{3,160})/iu,
    ];
    for (const pattern of patterns) {
        const candidate = String(text.match(pattern)?.[1] ?? '').replace(/\s+/gu, ' ').trim();
        if (candidate) return candidate;
    }
    return '';
}

function backfillEventProvenanceV18867() {
    const migrationKey = 'events-v18867-provenance-location-backfill';
    if (database.prepare('SELECT 1 FROM bot_code_migrations WHERE migration_key = ? LIMIT 1').get(migrationKey)) return;

    database.exec('BEGIN IMMEDIATE');
    try {
        for (const row of database.prepare('SELECT * FROM vk_events').all()) {
            const canonical = canonicalVkWallUrlForDb(row.source_url);
            const venue = String(row.venue ?? '').trim() || 'место не указано';
            database.prepare(`
                UPDATE vk_events SET
                    canonical_post_url = CASE WHEN canonical_post_url = '' THEN ? ELSE canonical_post_url END,
                    source_type = CASE WHEN source_type = '' THEN 'vk_wall' ELSE source_type END,
                    source_item_id = CASE WHEN source_item_id = '' THEN ? ELSE source_item_id END,
                    source_original_url = CASE WHEN source_original_url = '' THEN ? ELSE source_original_url END,
                    canonical_origin = CASE WHEN canonical_origin = '' THEN 'direct-wall' ELSE canonical_origin END,
                    venue = CASE WHEN TRIM(venue) = '' THEN ? ELSE venue END
                WHERE id = ?
            `).run(canonical, `${row.screen_name}:${row.post_id}`, String(row.source_url ?? ''), venue, row.id);
        }
        for (const row of database.prepare('SELECT * FROM telegram_events').all()) {
            const canonical = canonicalTelegramUrlForDb(row.source_url);
            const venue = String(row.venue ?? '').trim() || 'место не указано';
            database.prepare(`
                UPDATE telegram_events SET
                    canonical_post_url = CASE WHEN canonical_post_url = '' THEN ? ELSE canonical_post_url END,
                    source_type = CASE WHEN source_type = '' THEN 'telegram' ELSE source_type END,
                    source_message_id = CASE WHEN source_message_id = 0 THEN ? ELSE source_message_id END,
                    source_item_id = CASE WHEN source_item_id = '' THEN ? ELSE source_item_id END,
                    source_original_url = CASE WHEN source_original_url = '' THEN ? ELSE source_original_url END,
                    canonical_origin = CASE WHEN canonical_origin = '' THEN 'telegram-post' ELSE canonical_origin END,
                    venue = CASE WHEN TRIM(venue) = '' THEN ? ELSE venue END
                WHERE id = ?
            `).run(canonical, Number(row.message_id || 0), `${row.channel}:${row.message_id}`, String(row.source_url ?? ''), venue, row.id);
        }
        for (const row of database.prepare(`
            SELECT e.*, s.conversation_url, s.conversation_name, s.raw_text,
                   s.links_json, s.repost_urls_json, s.attachment_links_json,
                   s.canonical_post_url AS source_canonical_post_url,
                   s.canonical_origin AS source_canonical_origin
            FROM vk_chat_events e
            LEFT JOIN vk_chat_source_messages s
              ON s.peer_id = e.peer_id AND s.conversation_message_id = e.conversation_message_id
        `).all()) {
            const reposts = safeStoredJsonArray(row.repost_urls_json);
            const attachments = safeStoredJsonArray(row.attachment_links_json);
            const links = safeStoredJsonArray(row.links_json);
            const canonical = canonicalVkWallUrlForDb(row.source_canonical_post_url) ||
                firstStoredWallUrl(reposts, row.raw_text, attachments, links, row.source_url);
            const origin = String(row.source_canonical_origin ?? '').trim() || (
                firstStoredWallUrl(reposts) ? 'chat-repost' :
                firstStoredWallUrl(row.raw_text) ? 'chat-link' :
                firstStoredWallUrl(attachments, links, row.source_url) ? 'chat-attachment' :
                'chat-message-only'
            );
            const inferredVenue = inferConservativeVenueFromStoredText(row.raw_text);
            const currentVenue = String(row.venue ?? '').trim();
            const venue = currentVenue && currentVenue !== 'место не указано'
                ? currentVenue
                : (inferredVenue || currentVenue || 'место не указано');
            database.prepare(`
                UPDATE vk_chat_events SET
                    canonical_post_url = CASE WHEN canonical_post_url = '' THEN ? ELSE canonical_post_url END,
                    source_type = CASE WHEN source_type = '' THEN 'vk_chat' ELSE source_type END,
                    source_chat_id = CASE WHEN source_chat_id = 0 THEN ? ELSE source_chat_id END,
                    source_chat_name = CASE WHEN source_chat_name = '' THEN ? ELSE source_chat_name END,
                    source_message_id = CASE WHEN source_message_id = 0 THEN ? ELSE source_message_id END,
                    source_item_id = CASE WHEN source_item_id = '' THEN ? ELSE source_item_id END,
                    source_original_url = CASE WHEN source_original_url = '' THEN ? ELSE source_original_url END,
                    canonical_origin = CASE WHEN canonical_origin = '' THEN ? ELSE canonical_origin END,
                    venue = CASE WHEN TRIM(venue) = '' OR venue = 'место не указано' THEN ? ELSE venue END,
                    venue_source = CASE WHEN venue_source = '' AND ? <> '' THEN 'stored-source-text' ELSE venue_source END
                WHERE id = ?
            `).run(
                canonical, Number(row.peer_id || 0), String(row.conversation_name ?? ''), Number(row.conversation_message_id || 0),
                `${row.peer_id}:${row.conversation_message_id}`, String(row.conversation_url || row.source_url || ''), origin,
                venue, inferredVenue, row.id,
            );
        }
        for (const row of database.prepare('SELECT * FROM manual_events').all()) {
            const canonical = canonicalVkWallUrlForDb(row.source_url) || canonicalTelegramUrlForDb(row.source_url);
            const inferredVenue = inferConservativeVenueFromStoredText([row.description, row.evidence].filter(Boolean).join('\n'));
            const currentVenue = String(row.venue ?? '').trim();
            const venue = currentVenue && currentVenue !== 'место не указано' ? currentVenue : (inferredVenue || currentVenue || 'место не указано');
            database.prepare(`
                UPDATE manual_events SET
                    canonical_post_url = CASE WHEN canonical_post_url = '' THEN ? ELSE canonical_post_url END,
                    source_type = CASE WHEN source_type = '' THEN 'manual' ELSE source_type END,
                    source_item_id = CASE WHEN source_item_id = '' THEN CAST(id AS TEXT) ELSE source_item_id END,
                    source_original_url = CASE WHEN source_original_url = '' THEN source_url ELSE source_original_url END,
                    canonical_origin = CASE WHEN canonical_origin = '' THEN ? ELSE canonical_origin END,
                    venue = CASE WHEN TRIM(venue) = '' OR venue = 'место не указано' THEN ? ELSE venue END,
                    venue_source = CASE WHEN venue_source = '' AND ? <> '' THEN 'stored-source-text' ELSE venue_source END
                WHERE id = ?
            `).run(canonical, canonical ? 'manual-linked-post' : 'manual', venue, inferredVenue, row.id);
        }
        database.prepare('INSERT INTO bot_code_migrations (migration_key, applied_at) VALUES (?, ?)').run(
            migrationKey,
            Math.floor(Date.now() / 1000),
        );
        database.exec('COMMIT');
    } catch (error) {
        database.exec('ROLLBACK');
        throw error;
    }
}

// V188.94: legacy event migration no longer auto-runs at import: backfillEventProvenanceV18867();

/*
 * V188.83 production cleanup. Several historical parser-regression tests were
 * run against the production SQLite and left unmistakable fixture rows in the
 * manual event table. Preserve them for audit, but quarantine them from public
 * output. This migration is deliberately narrow: it does not use a broad year
 * cutoff and therefore cannot hide a legitimate far-future event.
 */
function quarantineKnownParserTestFixturesV18883() {
    const migrationKey = 'events-v18883-quarantine-known-parser-test-fixtures-v1';
    if (database.prepare('SELECT 1 FROM bot_code_migrations WHERE migration_key = ? LIMIT 1').get(migrationKey)) {
        return { updated: 0, skipped: true };
    }
    database.exec('BEGIN IMMEDIATE');
    try {
        const result = database.prepare(`
            UPDATE manual_events
            SET status = 'ignored', updated_at = ?
            WHERE status <> 'ignored'
              AND event_date = '2099-08-22'
              AND TRIM(source_url) = ''
              AND (
                    (title LIKE 'V103 REGISTRY %' AND venue = 'Тестовая площадка')
                 OR title LIKE 'Концерт строгий 1788686%'
              )
        `).run(Math.floor(Date.now() / 1000));
        database.prepare('INSERT INTO bot_code_migrations (migration_key, applied_at) VALUES (?, ?)').run(
            migrationKey,
            Math.floor(Date.now() / 1000),
        );
        database.exec('COMMIT');
        const updated = Number(result?.changes || 0);
        if (updated) console.log('[V18883 TEST FIXTURE QUARANTINE]', `ignored=${updated}`);
        return { updated, skipped: false };
    } catch (error) {
        database.exec('ROLLBACK');
        throw error;
    }
}

// V188.94: legacy event migration no longer auto-runs at import: quarantineKnownParserTestFixturesV18883();

/*
 * V188.67 media compatibility repair.
 *
 * The first V188.67 build intentionally made public delivery fail closed when
 * poster_match_status was empty. Existing V188.66 rows, however, already had
 * durable poster paths but naturally had no new status column yet. Treating
 * every empty status as unsafe made normal posters disappear from ALL old
 * cards after migration.
 *
 * Do not blanket-trust legacy paths. We only grandfather bindings that are
 * structurally unambiguous without another AI/browser pass:
 *   1) one source item -> one event -> one stored source image; or
 *   2) multi-event source -> this image path is present in source media and is
 *      used by exactly one sibling event; or
 *   3) a manually approved event already materialized under the permanent
 *      manual_event_announcements/ directory.
 *
 * VK-chat legacy images are deliberately NOT grandfathered here. That is the
 * exact historical path that could attach an ordinary people photo to the
 * "Юбилейная 5-я вылазка" event; chat media still requires a real vision match.
 */
function backfillLegacyPosterBindingsV18867Compat() {
    const migrationKey = 'events-v18867-legacy-poster-compat-v3';
    if (database.prepare('SELECT 1 FROM bot_code_migrations WHERE migration_key = ? LIMIT 1').get(migrationKey)) return;

    const update = (table, id, status, reason, imageIndex) => {
        database.prepare(`
            UPDATE ${table}
            SET poster_match_status = CASE WHEN poster_match_status = '' THEN ? ELSE poster_match_status END,
                poster_match_reason = CASE WHEN poster_match_reason = '' THEN ? ELSE poster_match_reason END,
                poster_image_index = CASE WHEN poster_image_index = 0 THEN ? ELSE poster_image_index END
            WHERE id = ? AND poster_match_status = ''
        `).run(status, reason, Number(imageIndex || 1), Number(id));
    };

    const intersect = (left, right) => {
        const rightSet = new Set((Array.isArray(right) ? right : []).map((value) => String(value ?? '').trim()).filter(Boolean));
        return (Array.isArray(left) ? left : []).map((value) => String(value ?? '').trim()).filter((value) => value && rightSet.has(value));
    };

    database.exec('BEGIN IMMEDIATE');
    try {
        const vkSources = database.prepare(`
            SELECT screen_name, post_id, image_paths_json
            FROM vk_source_posts
        `).all();
        const vkEventsForSource = database.prepare(`
            SELECT id, image_paths_json, poster_match_status
            FROM vk_events WHERE screen_name = ? AND post_id = ?
            ORDER BY event_index ASC, id ASC
        `);
        for (const source of vkSources) {
            const sourcePaths = parseStoredImagePaths(source.image_paths_json);
            if (!sourcePaths.length) continue;
            const rows = vkEventsForSource.all(source.screen_name, source.post_id);
            if (!rows.length) continue;
            const usage = new Map();
            for (const row of rows) {
                for (const path of new Set(parseStoredImagePaths(row.image_paths_json))) {
                    usage.set(path, Number(usage.get(path) || 0) + 1);
                }
            }
            for (const row of rows) {
                if (String(row.poster_match_status ?? '').trim()) continue;
                const candidates = intersect(parseStoredImagePaths(row.image_paths_json), sourcePaths);
                if (!candidates.length) continue;
                if (rows.length === 1 && sourcePaths.length === 1 && candidates.includes(sourcePaths[0])) {
                    update('vk_events', row.id, 'legacy_single_source_poster', 'legacy-single-event+single-source-image', 1);
                    continue;
                }
                if (rows.length > 1) {
                    const unique = candidates.find((path) => Number(usage.get(path) || 0) === 1);
                    if (unique) {
                        update('vk_events', row.id, 'legacy_unique_source_poster', 'legacy-multi-event+unique-source-image', sourcePaths.indexOf(unique) + 1);
                    }
                }
            }
        }

        const tgSources = database.prepare(`
            SELECT channel, message_id, image_paths_json
            FROM telegram_source_posts
        `).all();
        const tgEventsForSource = database.prepare(`
            SELECT id, image_paths_json, poster_match_status
            FROM telegram_events WHERE channel = ? AND message_id = ?
            ORDER BY event_index ASC, id ASC
        `);
        for (const source of tgSources) {
            const sourcePaths = parseStoredImagePaths(source.image_paths_json);
            if (!sourcePaths.length) continue;
            const rows = tgEventsForSource.all(source.channel, source.message_id);
            if (!rows.length) continue;
            const usage = new Map();
            for (const row of rows) {
                for (const path of new Set(parseStoredImagePaths(row.image_paths_json))) {
                    usage.set(path, Number(usage.get(path) || 0) + 1);
                }
            }
            for (const row of rows) {
                if (String(row.poster_match_status ?? '').trim()) continue;
                const candidates = intersect(parseStoredImagePaths(row.image_paths_json), sourcePaths);
                if (!candidates.length) continue;
                if (rows.length === 1 && sourcePaths.length === 1 && candidates.includes(sourcePaths[0])) {
                    update('telegram_events', row.id, 'legacy_single_source_poster', 'legacy-single-event+single-source-image', 1);
                    continue;
                }
                if (rows.length > 1) {
                    const unique = candidates.find((path) => Number(usage.get(path) || 0) === 1);
                    if (unique) {
                        update('telegram_events', row.id, 'legacy_unique_source_poster', 'legacy-multi-event+unique-source-image', sourcePaths.indexOf(unique) + 1);
                    }
                }
            }
        }

        // Legacy chat media is the riskiest class: old code could attach the
        // first arbitrary chat/repost photo. Grandfather only the narrow case
        // where the stored message resolves to an actual wall post, there is
        // exactly one source image URL, exactly one child event, and the event
        // already points at that one captured local image. The known bad
        // "Юбилейная 5-я вылазка" message has two source photos, so it remains
        // untrusted and is still withheld until Poster Vision verifies a match.
        const chatRows = database.prepare(`
            SELECT e.id, e.peer_id, e.conversation_message_id, e.image_paths_json,
                   e.poster_match_status, e.poster_vision_facts_json, e.canonical_post_url,
                   s.image_urls_json, s.image_paths_json AS source_image_paths_json
            FROM vk_chat_events e
            LEFT JOIN vk_chat_source_messages s
              ON s.peer_id = e.peer_id AND s.conversation_message_id = e.conversation_message_id
            ORDER BY e.peer_id, e.conversation_message_id, e.id
        `).all();
        const chatSiblingCount = new Map();
        for (const row of chatRows) {
            const key = `${row.peer_id}:${row.conversation_message_id}`;
            chatSiblingCount.set(key, Number(chatSiblingCount.get(key) || 0) + 1);
        }
        for (const row of chatRows) {
            if (String(row.poster_match_status ?? '').trim()) continue;
            const key = `${row.peer_id}:${row.conversation_message_id}`;
            if (Number(chatSiblingCount.get(key) || 0) !== 1) continue;
            const sourceUrls = safeStoredJsonArray(row.image_urls_json)
                .map((value) => String(value ?? '').trim()).filter(Boolean);
            if (sourceUrls.length !== 1) continue;
            const eventPaths = parseStoredImagePaths(row.image_paths_json);
            if (eventPaths.length !== 1) continue;
            const sourcePaths = parseStoredImagePaths(row.source_image_paths_json);
            if (sourcePaths.length && !sourcePaths.includes(eventPaths[0])) continue;
            update('vk_chat_events', row.id, 'legacy_single_repost_poster', 'legacy-single-wall-repost+single-source-image', 1);
        }

        for (const row of database.prepare(`
            SELECT id, image_paths_json, poster_match_status FROM manual_events
        `).all()) {
            if (String(row.poster_match_status ?? '').trim()) continue;
            const paths = parseStoredImagePaths(row.image_paths_json);
            const index = paths.findIndex((path) => String(path).replace(/\\+/gu, '/').toLowerCase().startsWith('manual_event_announcements/'));
            if (index >= 0) {
                update('manual_events', row.id, 'legacy_manual_poster', 'legacy-durable-manual-announcement', index + 1);
            }
        }

        database.prepare('INSERT INTO bot_code_migrations (migration_key, applied_at) VALUES (?, ?)').run(
            migrationKey,
            Math.floor(Date.now() / 1000),
        );
        database.exec('COMMIT');
    } catch (error) {
        database.exec('ROLLBACK');
        throw error;
    }
}

// V188.94: legacy event migration no longer auto-runs at import: backfillLegacyPosterBindingsV18867Compat();

/*
 * V188.68 clean-media compatibility repair.
 *
 * V188.67 counted every captured source image before deciding whether an old
 * poster binding was unambiguous. VK source rows may legitimately contain one
 * 640x960 poster plus several 34..108px avatar/audio/UI thumbnails. Those tiny
 * assets must be removed first; otherwise the real poster disappears merely
 * because sourcePaths.length > 1.
 *
 * This pass is local-only and deterministic. For a source that produced exactly
 * one event, all strong UI-filtered media may be preserved as source media; for
 * multi-event sources a per-event poster binding is still required.
 */
export function backfillCleanLegacyPosterBindingsV18868({ force = false } = {}) {
    const migrationKey = 'events-v18886-real-poster-only-compat-v5';
    if (!force && database.prepare('SELECT 1 FROM bot_code_migrations WHERE migration_key = ? LIMIT 1').get(migrationKey)) return;

    const update = (table, id, status, reason, imageIndex) => {
        database.prepare(`
            UPDATE ${table}
            SET poster_match_status = ?,
                poster_match_reason = ?,
                poster_image_index = ?
            WHERE id = ? AND poster_match_status IN (
                '', 'no_safe_poster',
                'verified_single_event_source_media',
                'legacy_clean_single_source_poster',
                'legacy_clean_unique_source_poster',
                'legacy_clean_single_repost_poster'
            )
        `).run(status, reason, Number(imageIndex || 1), Number(id));
    };
    const updateSourceMedia = (table, id, imagePaths, status, reason, imageIndex = 0) => {
        database.prepare(`
            UPDATE ${table}
            SET image_paths_json = ?,
                poster_match_status = ?,
                poster_match_reason = ?,
                poster_image_index = ?
            WHERE id = ? AND poster_match_status IN (
                '', 'no_safe_poster',
                'verified_single_event_source_media',
                'legacy_clean_single_source_poster',
                'legacy_clean_unique_source_poster',
                'legacy_clean_single_repost_poster'
            )
        `).run(
            JSON.stringify(safeJsonArray(imagePaths)),
            String(status || 'verified_single_event_source_media'),
            String(reason || 'single-event-source-media+ui-filtered'),
            Number(imageIndex || 0),
            Number(id),
        );
    };
    const reject = (table, id, reason) => {
        database.prepare(`
            UPDATE ${table}
            SET image_paths_json = '[]',
                poster_match_status = 'no_safe_poster',
                poster_match_reason = ?,
                poster_image_index = 0
            WHERE id = ? AND poster_match_status IN (
                '', 'no_safe_poster',
                'verified_single_event_source_media',
                'legacy_clean_single_source_poster',
                'legacy_clean_unique_source_poster',
                'legacy_clean_single_repost_poster'
            )
        `).run(String(reason || 'legacy-clean-media-ambiguous'), Number(id));
    };
    const intersect = (left, right) => {
        const rightSet = new Set((Array.isArray(right) ? right : []).map((value) => String(value ?? '').trim()).filter(Boolean));
        return (Array.isArray(left) ? left : []).map((value) => String(value ?? '').trim()).filter((value) => value && rightSet.has(value));
    };

    database.exec('BEGIN IMMEDIATE');
    try {
        for (const spec of [
            {
                sourceTable: 'vk_source_posts', eventTable: 'vk_events',
                sourceKeys: ['screen_name', 'post_id'], eventKeys: ['screen_name', 'post_id'],
                recoveryDirectory: (source) => `vk_announcements/${String(source.screen_name || '').trim()}`,
                recoveryItemId: (source) => String(source.post_id || ''),
            },
            {
                sourceTable: 'telegram_source_posts', eventTable: 'telegram_events',
                sourceKeys: ['channel', 'message_id'], eventKeys: ['channel', 'message_id'],
                recoveryDirectory: null,
                recoveryItemId: null,
            },
        ]) {
            const sources = database.prepare(`SELECT ${spec.sourceKeys.join(', ')}, image_urls_json, image_paths_json FROM ${spec.sourceTable}`).all();
            const eventQuery = database.prepare(`
                SELECT id, image_paths_json, poster_match_status, poster_vision_facts_json
                FROM ${spec.eventTable}
                WHERE ${spec.eventKeys[0]} = ? AND ${spec.eventKeys[1]} = ?
                ORDER BY id ASC
            `);
            for (const source of sources) {
                const sourceUrls = safeStoredJsonArray(source.image_urls_json)
                    .map((value) => String(value ?? '').trim()).filter(Boolean);
                const storedSourcePaths = parseStoredImagePaths(source.image_paths_json);
                const sourcePaths = typeof spec.recoveryDirectory === 'function'
                    ? recoverIndexedLegacyMediaPaths(storedSourcePaths, sourceUrls, {
                        relativeDirectory: spec.recoveryDirectory(source),
                        itemId: spec.recoveryItemId(source),
                    })
                    : storedSourcePaths;
                if (JSON.stringify(sourcePaths) !== JSON.stringify(storedSourcePaths)) {
                    database.prepare(`
                        UPDATE ${spec.sourceTable} SET image_paths_json = ?
                        WHERE ${spec.sourceKeys[0]} = ? AND ${spec.sourceKeys[1]} = ?
                    `).run(JSON.stringify(sourcePaths), source[spec.sourceKeys[0]], source[spec.sourceKeys[1]]);
                }
                const cleanSourcePaths = cleanLegacySourcePosterPaths(sourcePaths, sourceUrls);
                if (!cleanSourcePaths.length) continue;
                const rows = eventQuery.all(source[spec.sourceKeys[0]], source[spec.sourceKeys[1]]);
                if (!rows.length) continue;
                const usage = new Map();
                for (const row of rows) {
                    for (const path of new Set(intersect(cleanLegacyPosterPaths(parseStoredImagePaths(row.image_paths_json)), cleanSourcePaths))) {
                        usage.set(path, Number(usage.get(path) || 0) + 1);
                    }
                }
                for (const row of rows) {
                    const currentStatus = String(row.poster_match_status ?? '').trim();
                    if (![
                        '', 'no_safe_poster',
                        'verified_single_event_source_media',
                        'legacy_clean_single_source_poster',
                        'legacy_clean_unique_source_poster',
                    ].includes(currentStatus)) continue;
                    // V188.86: never infer an event poster merely because the source
                    // produced one event. Preserve only a verified-single binding that
                    // also carries persisted positive Vision proof; all source-only
                    // legacy bindings are reopened for the normal Vision repair path.
                    if (currentStatus === 'verified_single_event_source_media' &&
                        storedPosterStatusIsSafe(currentStatus, row.poster_vision_facts_json)) {
                        continue;
                    }
                    const eventClean = cleanLegacyPosterPaths(parseStoredImagePaths(row.image_paths_json));
                    const candidates = intersect(eventClean, cleanSourcePaths);
                    if (rows.length === 1 && cleanSourcePaths.length >= 1) {
                        reject(spec.eventTable, row.id, 'single-event-source-media-not-confirmed-as-poster');
                        continue;
                    }
                    if (rows.length > 1) {
                        const unique = candidates.find((path) => Number(usage.get(path) || 0) === 1);
                        if (unique) {
                            update(spec.eventTable, row.id, 'legacy_clean_unique_source_poster', 'legacy-clean-media+unique-event-poster+url-role-filter', sourcePaths.indexOf(unique) + 1);
                            continue;
                        }
                    }
                    if (currentStatus.startsWith('legacy_clean_')) {
                        reject(spec.eventTable, row.id, 'legacy-clean-media-recheck-ambiguous');
                    }
                }
            }
        }

        // V188.71: a chat source that produced exactly one event keeps every
        // strong UI-filtered source image. We no longer guess "photo #1" as a
        // poster; the media set itself is verified as belonging to that one
        // announcement. Multi-event chat messages remain poster-matched per child.
        const chatRows = database.prepare(`
            SELECT e.id, e.peer_id, e.conversation_message_id, e.image_paths_json,
                   e.poster_match_status, e.canonical_post_url,
                   s.image_urls_json AS source_image_urls_json,
                   s.image_paths_json AS source_image_paths_json
            FROM vk_chat_events e
            LEFT JOIN vk_chat_source_messages s
              ON s.peer_id = e.peer_id AND s.conversation_message_id = e.conversation_message_id
            ORDER BY e.peer_id, e.conversation_message_id, e.id
        `).all();
        const siblingCount = new Map();
        for (const row of chatRows) {
            const key = `${row.peer_id}:${row.conversation_message_id}`;
            siblingCount.set(key, Number(siblingCount.get(key) || 0) + 1);
        }
        for (const row of chatRows) {
            const currentStatus = String(row.poster_match_status ?? '').trim();
            if (!['', 'no_safe_poster', 'verified_single_event_source_media', 'legacy_clean_single_repost_poster'].includes(currentStatus)) continue;
            if (currentStatus === 'verified_single_event_source_media' &&
                storedPosterStatusIsSafe(currentStatus, row.poster_vision_facts_json)) {
                continue;
            }
            const key = `${row.peer_id}:${row.conversation_message_id}`;
            if (Number(siblingCount.get(key) || 0) !== 1) continue;
            const sourceUrls = safeStoredJsonArray(row.source_image_urls_json)
                .map((value) => String(value ?? '').trim()).filter(Boolean);
            const storedSourcePaths = parseStoredImagePaths(row.source_image_paths_json);
            const sourcePaths = recoverIndexedLegacyMediaPaths(storedSourcePaths, sourceUrls, {
                relativeDirectory: `vk_chat_announcements/vk-chat-${Number(row.peer_id || 0)}`,
                itemId: String(row.conversation_message_id || ''),
            });
            if (JSON.stringify(sourcePaths) !== JSON.stringify(storedSourcePaths)) {
                database.prepare(`
                    UPDATE vk_chat_source_messages SET image_paths_json = ?
                    WHERE peer_id = ? AND conversation_message_id = ?
                `).run(JSON.stringify(sourcePaths), Number(row.peer_id), Number(row.conversation_message_id));
            }
            const cleanSourcePaths = cleanLegacySourcePosterPaths(sourcePaths, sourceUrls);
            if (cleanSourcePaths.length >= 1) {
                reject('vk_chat_events', row.id, 'single-event-chat-source-media-not-confirmed-as-poster');
                continue;
            }
            if (currentStatus === 'legacy_clean_single_repost_poster' || currentStatus === 'verified_single_event_source_media') {
                reject('vk_chat_events', row.id, 'single-event-chat-source-media+recheck-no-safe-media');
            }
        }

        if (!force) {
            database.prepare('INSERT INTO bot_code_migrations (migration_key, applied_at) VALUES (?, ?)').run(
                migrationKey,
                Math.floor(Date.now() / 1000),
            );
        }
        database.exec('COMMIT');
    } catch (error) {
        database.exec('ROLLBACK');
        throw error;
    }

    // V188.73 safety contract: this legacy recovery pass may recover source
    // filenames/media inventory, but it must never leave source-membership
    // heuristics promoted as event-level posters. A forced repair is used by
    // parser-all as well as tests, so apply the vision-only invalidation in the
    // same call instead of relying on one-time startup ordering.
    if (force) {
        invalidateUnverifiedSingleEventSourceMediaV18873({ force: true });
    }
}

// V188.92: legacy media migrations are no longer executed as import-time side
// effects. Explicit parser/owner maintenance may call the function when needed.


/**
 * V188.73 cleanup: V188.71 briefly treated every UI-filtered image of a
 * single-event source as event media. That can attach portraits/covers. Keep
 * the source media, but clear only that unsafe event-level binding so the next
 * parser pass can re-bind a vision-confirmed poster.
 */
export function invalidateUnverifiedSingleEventSourceMediaV18873({ force = false } = {}) {
    const migrationKey = 'events-v18873-vision-poster-only-v2';
    if (!force && database.prepare('SELECT 1 FROM bot_code_migrations WHERE migration_key = ? LIMIT 1').get(migrationKey)) {
        return { updated: 0, skipped: true };
    }
    let updated = 0;
    database.exec('BEGIN IMMEDIATE');
    try {
        for (const table of ['vk_events', 'telegram_events', 'vk_chat_events']) {
            const result = database.prepare(`
                UPDATE ${table}
                SET image_paths_json = '[]', poster_match_status = 'no_safe_poster',
                    poster_match_reason = 'v18873-requires-vision-poster-binding', poster_image_index = 0
                WHERE poster_match_status IN (
                    'legacy_single_source_poster',
                    'legacy_unique_source_poster',
                    'legacy_single_repost_poster',
                    'legacy_clean_single_source_poster',
                    'legacy_clean_unique_source_poster',
                    'legacy_clean_single_repost_poster'
                )
            `).run();
            updated += Number(result?.changes || 0);
        }
        if (!force) {
            database.prepare('INSERT INTO bot_code_migrations (migration_key, applied_at) VALUES (?, ?)').run(
                migrationKey,
                Math.floor(Date.now() / 1000),
            );
        }
        database.exec('COMMIT');
    } catch (error) {
        database.exec('ROLLBACK');
        throw error;
    }
    if (updated) console.log('[V18873 POSTER SAFETY MIGRATION]', `clearedUnsafeBindings=${updated}`);
    return { updated, skipped: false };
}

// V188.94: legacy event migration no longer auto-runs at import: invalidateUnverifiedSingleEventSourceMediaV18873();

function currentDateIsoForZone(timeZone = 'Europe/Moscow', now = new Date()) {
    const parts = new Intl.DateTimeFormat('en-CA', {
        timeZone,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
    }).formatToParts(now);
    const map = Object.fromEntries(parts.map((part) => [part.type, part.value]));
    return `${map.year}-${map.month}-${map.day}`;
}

/*
 * V188.68 retrospective false-positive repair.
 *
 * Older VK rows could turn the carousel counter `1/10` into 1 October before
 * AI admission. The new sanitizer prevents that prospectively; this one-time
 * repair removes already persisted photo reports when retrospective wording is
 * present and the sanitized body has no unresolved date plus no today/future
 * resolved date. Posts that genuinely announce a later event remain untouched.
 */
export function backfillRetrospectiveFalsePositivesV18868({ force = false, now = new Date() } = {}) {
    const migrationKey = 'events-v18868-retrospective-gallery-counter-repair-v1';
    if (!force && database.prepare('SELECT 1 FROM bot_code_migrations WHERE migration_key = ? LIMIT 1').get(migrationKey)) return;
    const today = currentDateIsoForZone('Europe/Moscow', now);
    const rows = database.prepare(`
        SELECT e.id, e.screen_name, e.post_id, e.status,
               s.raw_text, s.published_at
        FROM vk_events e
        JOIN vk_source_posts s
          ON s.screen_name = e.screen_name AND s.post_id = e.post_id
    `).all();
    const repairedSources = new Set();

    database.exec('BEGIN IMMEDIATE');
    try {
        for (const row of rows) {
            const sourceText = String(row.raw_text ?? '');
            const retrospective = explainRetrospectivePost(sourceText);
            if (!retrospective.retrospective) continue;
            const rawMentions = extractRawDateMentions(sourceText);
            const resolvedMentions = extractExplicitDateMentions(sourceText, Number(row.published_at || 0), {
                timeZone: 'Europe/Moscow',
            });
            // A yearless date with no trustworthy publication timestamp cannot
            // be safely classified as past during a DB-only repair.
            const hasUnresolvedDate = resolvedMentions.length < rawMentions.length;
            const hasNonPastDate = resolvedMentions.some((mention) => String(mention?.date || '') >= today);
            if (hasUnresolvedDate || hasNonPastDate) continue;

            database.prepare(`
                UPDATE vk_events
                SET status = 'ignored', updated_at = ?
                WHERE id = ?
            `).run(Math.floor(Date.now() / 1000), Number(row.id));
            repairedSources.add(`${row.screen_name}:${row.post_id}`);
        }

        for (const key of repairedSources) {
            const split = key.lastIndexOf(':');
            const screenName = key.slice(0, split);
            const postId = Number(key.slice(split + 1));
            const active = database.prepare(`
                SELECT 1 FROM vk_events
                WHERE screen_name = ? AND post_id = ? AND status <> 'ignored'
                LIMIT 1
            `).get(screenName, postId);
            if (!active) {
                database.prepare(`
                    UPDATE vk_source_posts
                    SET parse_status = 'not_event_retrospective'
                    WHERE screen_name = ? AND post_id = ?
                `).run(screenName, postId);
            }
        }

        if (!force) {
            database.prepare('INSERT INTO bot_code_migrations (migration_key, applied_at) VALUES (?, ?)').run(
                migrationKey,
                Math.floor(Date.now() / 1000),
            );
        }
        database.exec('COMMIT');
    } catch (error) {
        database.exec('ROLLBACK');
        throw error;
    }
}

// V188.94: legacy event migration no longer auto-runs at import: backfillRetrospectiveFalsePositivesV18868();

function syntheticPublishedAtFromStoredEventDates(rows) {
    for (const row of Array.isArray(rows) ? rows : []) {
        const match = String(row?.event_date ?? '').match(/^(\d{4})-(\d{2})-(\d{2})$/u);
        if (!match) continue;
        const year = Number(match[1]);
        const month = Number(match[2]);
        const day = Number(match[3]);
        const value = Date.UTC(year, month - 1, day, 12, 0, 0);
        if (Number.isFinite(value)) return Math.floor(value / 1000);
    }
    return 0;
}

function posterFactTextFromStoredEvents(rows) {
    for (const row of Array.isArray(rows) ? rows : []) {
        const description = String(row?.description ?? '');
        const marker = description.indexOf('[IMAGE ');
        if (marker >= 0) return description.slice(marker);
    }
    return '';
}

/*
 * V188.68 deterministic repair for collapsed labeled schedule posts.
 *
 * The known Diesel parent post stored ten source images but one bogus event.
 * Re-running the pure local `HALL:/BAR:` parser against the durable source text
 * can restore cardinality without browser/network work. Existing poster-fact
 * blocks are reused only for date+title/participant/venue-safe bindings.
 */
export function backfillCollapsedLabeledSchedulesV18868({ force = false } = {}) {
    const migrationKey = 'events-v18868-collapsed-labeled-schedule-repair-v1';
    if (!force && database.prepare('SELECT 1 FROM bot_code_migrations WHERE migration_key = ? LIMIT 1').get(migrationKey)) return;

    const sources = database.prepare(`
        SELECT screen_name, post_id, source_url, published_at, raw_text,
               image_urls_json, image_paths_json
        FROM vk_source_posts
        WHERE raw_text LIKE '%HALL:%' OR raw_text LIKE '%BAR:%'
    `).all();

    for (const source of sources) {
        const storedRows = database.prepare(`
            SELECT * FROM vk_events
            WHERE screen_name = ? AND post_id = ?
            ORDER BY event_index ASC, id ASC
        `).all(source.screen_name, source.post_id);
        if (!storedRows.length) continue;
        const publishedAt = Number(source.published_at || 0) || syntheticPublishedAtFromStoredEventDates(storedRows);
        if (!publishedAt) continue;
        const parsed = parsePublicPostLocally({
            text: String(source.raw_text || ''),
            publishedAt,
            screenName: String(source.screen_name || ''),
        });
        if (parsed.length <= storedRows.length || parsed.length < 2) continue;
        if (!parsed.every((event) => String(event?.parseMethod || '') === 'local_labeled_schedule_v18861')) continue;

        const sourceUrls = safeStoredJsonArray(source.image_urls_json)
            .map((value) => String(value ?? '').trim()).filter(Boolean);
        const storedPaths = parseStoredImagePaths(source.image_paths_json);
        const sourcePaths = recoverIndexedLegacyMediaPaths(storedPaths, sourceUrls, {
            relativeDirectory: `vk_announcements/${String(source.screen_name || '').trim()}`,
            itemId: String(source.post_id || ''),
        });
        if (JSON.stringify(sourcePaths) !== JSON.stringify(storedPaths)) {
            database.prepare(`
                UPDATE vk_source_posts SET image_paths_json = ?
                WHERE screen_name = ? AND post_id = ?
            `).run(JSON.stringify(sourcePaths), source.screen_name, Number(source.post_id));
        }

        const factText = posterFactTextFromStoredEvents(storedRows);
        const matched = assignEventImageIndexesFromFacts(parsed, factText);
        const repairedEvents = matched.map((event) => {
            const requestedIndex = Number(event?.posterImageIndex || 0);
            const imagePath = requestedIndex > 0
                ? sourcePaths.find((path) => legacyCapturedMediaIndex(path) === requestedIndex) || ''
                : '';
            const imageUrl = requestedIndex > 0 ? String(sourceUrls[requestedIndex - 1] || '') : '';
            const safePoster = Boolean(
                requestedIndex > 0 && imagePath && legacyPosterPathLooksClean(imagePath) && !legacySourceUrlLooksNonPoster(imageUrl)
            );
            return {
                ...event,
                imagePaths: safePoster ? [imagePath] : [],
                posterImageIndex: safePoster ? requestedIndex : 0,
                posterMatchStatus: safePoster ? String(event.posterMatchStatus || 'exact_poster_match') : 'no_safe_poster',
                posterMatchReason: safePoster ? String(event.posterMatchReason || 'schedule-child-safe-poster') : 'schedule-child-no-safe-poster',
                canonicalPostUrl: String(source.source_url || ''),
                provenanceSourceType: 'vk_wall',
                sourceItemId: `${source.screen_name}:${source.post_id}`,
                sourceOriginalUrl: String(source.source_url || ''),
                canonicalOrigin: 'direct-wall',
            };
        });

        replaceVkEventsForPost({
            screenName: String(source.screen_name || ''),
            postId: Number(source.post_id),
            sourceUrl: String(source.source_url || ''),
            imagePaths: sourcePaths,
            events: repairedEvents,
            updatedAt: Math.floor(Date.now() / 1000),
            // This is a deterministic cardinality repair. The previous row is the
            // collapsed/bogus representation we are replacing, so inheriting its
            // time/media/title into any child event would reintroduce corruption.
            mergeStoredEvents: false,
        });
        database.prepare(`
            UPDATE vk_source_posts SET parse_status = 'event'
            WHERE screen_name = ? AND post_id = ?
        `).run(source.screen_name, Number(source.post_id));
    }

    if (!force) {
        database.prepare('INSERT INTO bot_code_migrations (migration_key, applied_at) VALUES (?, ?)').run(
            migrationKey,
            Math.floor(Date.now() / 1000),
        );
    }
}

// V188.94: legacy event migration no longer auto-runs at import: backfillCollapsedLabeledSchedulesV18868();


/*
 * V188.65: independent raw-source ledger for `парсер все чисто`.
 * Unlike *_source_posts/messages this table records EVERY captured item,
 * including obvious trash and strict-gate rejects. This makes the incremental
 * command able to skip a previously seen message before local heuristics,
 * poster vision or main AI are invoked.
 */
database.exec(`
    CREATE TABLE IF NOT EXISTS manual_parser_seen_items (
        source_id TEXT NOT NULL,
        source_kind TEXT NOT NULL DEFAULT '',
        item_id TEXT NOT NULL,
        source_url TEXT NOT NULL DEFAULT '',
        observed_at INTEGER NOT NULL DEFAULT 0,
        raw_text TEXT NOT NULL DEFAULT '',
        attachments_json TEXT NOT NULL DEFAULT '[]',
        content_hash TEXT NOT NULL DEFAULT '',
        parse_status TEXT NOT NULL DEFAULT 'seen',
        attempt_count INTEGER NOT NULL DEFAULT 0,
        processed_at INTEGER NOT NULL DEFAULT 0,
        last_error TEXT NOT NULL DEFAULT '',
        last_run_id TEXT NOT NULL DEFAULT '',
        first_seen_at INTEGER NOT NULL DEFAULT 0,
        last_seen_at INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (source_id, item_id)
    );

    CREATE INDEX IF NOT EXISTS manual_parser_seen_items_last_seen_idx
    ON manual_parser_seen_items (source_id, last_seen_at DESC);
`);

const manualParserSeenColumns = new Set(
    database.prepare('PRAGMA table_info(manual_parser_seen_items)').all().map((row) => String(row.name)),
);
for (const [column, sql] of [
    ['attempt_count', 'ALTER TABLE manual_parser_seen_items ADD COLUMN attempt_count INTEGER NOT NULL DEFAULT 0'],
    ['processed_at', 'ALTER TABLE manual_parser_seen_items ADD COLUMN processed_at INTEGER NOT NULL DEFAULT 0'],
    ['last_error', "ALTER TABLE manual_parser_seen_items ADD COLUMN last_error TEXT NOT NULL DEFAULT ''"],
    ['last_run_id', "ALTER TABLE manual_parser_seen_items ADD COLUMN last_run_id TEXT NOT NULL DEFAULT ''"],
]) {
    if (!manualParserSeenColumns.has(column)) database.exec(sql);
}

const manualParserSeenLedgerMigrationKey = 'manual-parser-v18865-seen-ledger';
const manualParserSeenLedgerMigration = database.prepare(`
    SELECT migration_key
    FROM scraper_code_migrations
    WHERE migration_key = ?
    LIMIT 1
`).get(manualParserSeenLedgerMigrationKey);

if (!manualParserSeenLedgerMigration) {
    const now = Math.floor(Date.now() / 1000);
    database.exec('BEGIN IMMEDIATE');
    try {
        database.exec(`
            INSERT OR IGNORE INTO manual_parser_seen_items (
                source_id, source_kind, item_id, source_url, observed_at, raw_text,
                attachments_json, content_hash, parse_status, first_seen_at, last_seen_at
            )
            SELECT
                'tg:' || channel, 'telegram', CAST(message_id AS TEXT), source_url, published_at, raw_text,
                image_urls_json, content_hash, parse_status, fetched_at, fetched_at
            FROM telegram_source_posts;

            INSERT OR IGNORE INTO manual_parser_seen_items (
                source_id, source_kind, item_id, source_url, observed_at, raw_text,
                attachments_json, content_hash, parse_status, first_seen_at, last_seen_at
            )
            SELECT
                'vk:' || screen_name, 'vk-public', CAST(post_id AS TEXT), source_url, published_at, raw_text,
                image_urls_json, content_hash, parse_status, fetched_at, fetched_at
            FROM vk_source_posts;

            INSERT OR IGNORE INTO manual_parser_seen_items (
                source_id, source_kind, item_id, source_url, observed_at, raw_text,
                attachments_json, content_hash, parse_status, first_seen_at, last_seen_at
            )
            SELECT
                'chat:' || CAST(peer_id AS TEXT), 'vk-chat', CAST(conversation_message_id AS TEXT), conversation_url, created_at, raw_text,
                image_urls_json, content_hash, parse_status, fetched_at, fetched_at
            FROM vk_chat_source_messages;
        `);
        database.prepare(`
            INSERT INTO scraper_code_migrations (migration_key, applied_at)
            VALUES (?, ?)
        `).run(manualParserSeenLedgerMigrationKey, now);
        database.exec('COMMIT');
    } catch (error) {
        database.exec('ROLLBACK');
        throw error;
    }
}

const selectManualParserSeenItemStatement = database.prepare(`
    SELECT source_id, source_kind, item_id, source_url, observed_at, raw_text,
           attachments_json, content_hash, parse_status, attempt_count, processed_at,
           last_error, last_run_id, first_seen_at, last_seen_at
    FROM manual_parser_seen_items
    WHERE source_id = ? AND item_id = ?
    LIMIT 1
`);

const selectManualParserSeenItemsForSourceStatement = database.prepare(`
    SELECT source_id, source_kind, item_id, source_url, observed_at, raw_text,
           attachments_json, content_hash, parse_status, attempt_count, processed_at,
           last_error, last_run_id, first_seen_at, last_seen_at
    FROM manual_parser_seen_items
    WHERE source_id = ?
    ORDER BY last_seen_at DESC, first_seen_at DESC
    LIMIT ?
`);

const upsertManualParserSeenItemStatement = database.prepare(`
    INSERT INTO manual_parser_seen_items (
        source_id, source_kind, item_id, source_url, observed_at, raw_text,
        attachments_json, content_hash, parse_status, first_seen_at, last_seen_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT (source_id, item_id) DO UPDATE SET
        source_kind = excluded.source_kind,
        source_url = excluded.source_url,
        observed_at = excluded.observed_at,
        raw_text = excluded.raw_text,
        attachments_json = excluded.attachments_json,
        content_hash = excluded.content_hash,
        parse_status = excluded.parse_status,
        last_seen_at = excluded.last_seen_at
`);

const markManualParserSeenItemProcessingStatement = database.prepare(`
    UPDATE manual_parser_seen_items
    SET parse_status = 'processing',
        attempt_count = attempt_count + 1,
        processed_at = 0,
        last_error = '',
        last_run_id = ?,
        last_seen_at = ?
    WHERE source_id = ? AND item_id = ?
`);

const finalizeManualParserSeenItemStatement = database.prepare(`
    UPDATE manual_parser_seen_items
    SET parse_status = ?,
        processed_at = ?,
        last_error = ?,
        last_run_id = ?,
        last_seen_at = ?
    WHERE source_id = ? AND item_id = ?
`);

export function getManualParserSeenItem({ sourceId, itemId }) {
    const row = selectManualParserSeenItemStatement.get(
        String(sourceId ?? '').trim(),
        String(itemId ?? '').trim(),
    );
    if (!row) return null;
    return {
        sourceId: String(row.source_id ?? ''),
        sourceKind: String(row.source_kind ?? ''),
        itemId: String(row.item_id ?? ''),
        sourceUrl: String(row.source_url ?? ''),
        observedAt: Number(row.observed_at ?? 0),
        rawText: String(row.raw_text ?? ''),
        attachmentsJson: String(row.attachments_json ?? '[]'),
        contentHash: String(row.content_hash ?? ''),
        parseStatus: String(row.parse_status ?? ''),
        attemptCount: Number(row.attempt_count ?? 0),
        processedAt: Number(row.processed_at ?? 0),
        lastError: String(row.last_error ?? ''),
        lastRunId: String(row.last_run_id ?? ''),
        firstSeenAt: Number(row.first_seen_at ?? 0),
        lastSeenAt: Number(row.last_seen_at ?? 0),
    };
}

function mapManualParserSeenItemRow(row) {
    if (!row) return null;
    return {
        sourceId: String(row.source_id ?? ''),
        sourceKind: String(row.source_kind ?? ''),
        itemId: String(row.item_id ?? ''),
        sourceUrl: String(row.source_url ?? ''),
        observedAt: Number(row.observed_at ?? 0),
        rawText: String(row.raw_text ?? ''),
        attachmentsJson: String(row.attachments_json ?? '[]'),
        contentHash: String(row.content_hash ?? ''),
        parseStatus: String(row.parse_status ?? ''),
        attemptCount: Number(row.attempt_count ?? 0),
        processedAt: Number(row.processed_at ?? 0),
        lastError: String(row.last_error ?? ''),
        lastRunId: String(row.last_run_id ?? ''),
        firstSeenAt: Number(row.first_seen_at ?? 0),
        lastSeenAt: Number(row.last_seen_at ?? 0),
    };
}

export function getManualParserSeenItemsForSource(sourceId, { limit = 1000, finalOnly = false } = {}) {
    const safeLimit = Math.max(1, Math.min(5000, Math.trunc(Number(limit) || 1000)));
    const rows = selectManualParserSeenItemsForSourceStatement.all(String(sourceId ?? '').trim(), safeLimit)
        .map(mapManualParserSeenItemRow)
        .filter(Boolean);
    return finalOnly ? rows.filter((row) => isManualParserSeenItemFinalStatus(row.parseStatus)) : rows;
}

export function upsertManualParserSeenItem({
    sourceId, sourceKind = '', itemId, sourceUrl = '', observedAt = 0, rawText = '',
    attachments = [], contentHash = '', parseStatus = 'seen', seenAt = Math.floor(Date.now() / 1000),
}) {
    const safeAttachments = Array.isArray(attachments)
        ? attachments.slice(0, 100)
        : attachments && typeof attachments === 'object'
            ? attachments
            : [];
    upsertManualParserSeenItemStatement.run(
        String(sourceId ?? '').trim(),
        String(sourceKind ?? '').trim(),
        String(itemId ?? '').trim(),
        String(sourceUrl ?? '').trim(),
        Number(observedAt ?? 0),
        String(rawText ?? ''),
        JSON.stringify(safeAttachments),
        String(contentHash ?? '').trim(),
        String(parseStatus ?? 'seen').trim() || 'seen',
        Number(seenAt ?? Math.floor(Date.now() / 1000)),
        Number(seenAt ?? Math.floor(Date.now() / 1000)),
    );
}


const MANUAL_PARSER_FINAL_STATUSES = new Set([
    'processed_event',
    'processed_not_event',
    'processed_rejected',
    'processed_existing',
    // Legacy source tables migrated in V188.65 already represent completed work.
    'event',
    'not_event',
]);

export function isManualParserSeenItemFinalStatus(value) {
    return MANUAL_PARSER_FINAL_STATUSES.has(String(value ?? '').trim());
}

export function markManualParserSeenItemProcessing({
    sourceId,
    itemId,
    runId = '',
    seenAt = Math.floor(Date.now() / 1000),
}) {
    return Number(markManualParserSeenItemProcessingStatement.run(
        String(runId ?? '').trim(),
        Number(seenAt ?? Math.floor(Date.now() / 1000)),
        String(sourceId ?? '').trim(),
        String(itemId ?? '').trim(),
    ).changes || 0);
}

export function finalizeManualParserSeenItem({
    sourceId,
    itemId,
    parseStatus,
    runId = '',
    error = '',
    processedAt = Math.floor(Date.now() / 1000),
}) {
    const status = String(parseStatus ?? '').trim();
    if (!status) throw new Error('finalizeManualParserSeenItem requires parseStatus');
    return Number(finalizeManualParserSeenItemStatement.run(
        status,
        Number(processedAt ?? Math.floor(Date.now() / 1000)),
        String(error ?? '').slice(0, 2000),
        String(runId ?? '').trim(),
        Number(processedAt ?? Math.floor(Date.now() / 1000)),
        String(sourceId ?? '').trim(),
        String(itemId ?? '').trim(),
    ).changes || 0);
}

export function markManualParserSeenItemFailed({ sourceId, itemId, runId = '', error = '' }) {
    return finalizeManualParserSeenItem({
        sourceId,
        itemId,
        parseStatus: 'failed_retryable',
        runId,
        error,
    });
}

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
        raw_text,
        image_urls_json,
        image_paths_json,
        image_media_json,
        (
            SELECT COUNT(*)
            FROM vk_chat_events
            WHERE vk_chat_events.peer_id = vk_chat_source_messages.peer_id
              AND vk_chat_events.conversation_message_id = vk_chat_source_messages.conversation_message_id
        ) AS event_count,
        (
            SELECT COUNT(*)
            FROM vk_chat_events
            WHERE vk_chat_events.peer_id = vk_chat_source_messages.peer_id
              AND vk_chat_events.conversation_message_id = vk_chat_source_messages.conversation_message_id
              AND COALESCE(NULLIF(TRIM(vk_chat_events.image_paths_json), ''), '[]') = '[]'
        ) AS events_without_images
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
      AND NOT EXISTS (
          SELECT 1
          FROM event_dedupe_members AS dm
          WHERE dm.scope = 'configured'
            AND dm.source_type = 'vk_chat'
            AND dm.event_id = events.id
            AND dm.role = 'duplicate'
      )
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

const selectExistingAnnouncementBySourceUrlStatement = database.prepare(`
    SELECT source_type, source_key, item_id, source_url
    FROM (
        SELECT 'telegram' AS source_type,
               channel AS source_key,
               CAST(message_id AS TEXT) AS item_id,
               source_url
        FROM telegram_events
        WHERE status IN ('approved', 'pending')
          AND source_url IN (?, ?)
        UNION ALL
        SELECT 'vk-public' AS source_type,
               screen_name AS source_key,
               CAST(post_id AS TEXT) AS item_id,
               source_url
        FROM vk_events
        WHERE status IN ('approved', 'pending')
          AND source_url IN (?, ?)
        UNION ALL
        SELECT 'vk-chat' AS source_type,
               CAST(peer_id AS TEXT) AS source_key,
               CAST(conversation_message_id AS TEXT) AS item_id,
               source_url
        FROM vk_chat_events
        WHERE status IN ('approved', 'pending')
          AND source_url IN (?, ?)
    )
    LIMIT 1
`);

const selectExistingAnnouncementByExactTextStatement = database.prepare(`
    SELECT source_type, source_key, item_id, source_url
    FROM (
        SELECT 'telegram' AS source_type,
               p.channel AS source_key,
               CAST(p.message_id AS TEXT) AS item_id,
               p.source_url AS source_url
        FROM telegram_source_posts p
        WHERE p.raw_text = ?
          AND EXISTS (
              SELECT 1 FROM telegram_events e
              WHERE e.channel = p.channel
                AND e.message_id = p.message_id
                AND e.status IN ('approved', 'pending')
          )
        UNION ALL
        SELECT 'vk-public' AS source_type,
               p.screen_name AS source_key,
               CAST(p.post_id AS TEXT) AS item_id,
               p.source_url AS source_url
        FROM vk_source_posts p
        WHERE p.raw_text = ?
          AND EXISTS (
              SELECT 1 FROM vk_events e
              WHERE e.screen_name = p.screen_name
                AND e.post_id = p.post_id
                AND e.status IN ('approved', 'pending')
          )
        UNION ALL
        SELECT 'vk-chat' AS source_type,
               CAST(p.peer_id AS TEXT) AS source_key,
               CAST(p.conversation_message_id AS TEXT) AS item_id,
               p.conversation_url AS source_url
        FROM vk_chat_source_messages p
        WHERE p.raw_text = ?
          AND EXISTS (
              SELECT 1 FROM vk_chat_events e
              WHERE e.peer_id = p.peer_id
                AND e.conversation_message_id = p.conversation_message_id
                AND e.status IN ('approved', 'pending')
          )
    )
    LIMIT 1
`);

function announcementUrlVariants(value) {
    const raw = String(value ?? '').trim();
    if (!raw) return ['', ''];
    let canonical = raw;
    const wall = raw.match(/(?:[?&]w=|\/)(wall-?\d+_\d+)/iu);
    if (wall) canonical = `https://vk.ru/${wall[1]}`;
    canonical = canonical
        .replace(/^http:\/\//iu, 'https://')
        .replace(/^https:\/\/(?:www\.)?vk\.com\//iu, 'https://vk.ru/')
        .replace(/\/$/u, '');
    const alternate = canonical.replace(/^https:\/\/vk\.ru\//iu, 'https://vk.com/');
    return [canonical, alternate];
}

/**
 * Cheap, synchronous pre-AI lookup. It only returns a match when an actual
 * approved/pending event already exists for the exact canonical source URL or
 * for the exact raw source text. A source row that was merely checked and
 * produced no event is intentionally NOT treated as known.
 */
export function findExistingAnnouncementEvidence({ rawText = '', sourceUrl = '' } = {}) {
    const [urlA, urlB] = announcementUrlVariants(sourceUrl);
    if (urlA) {
        const row = selectExistingAnnouncementBySourceUrlStatement.get(
            urlA, urlB,
            urlA, urlB,
            urlA, urlB,
        );
        if (row) {
            return {
                matchType: 'source-url',
                sourceType: String(row.source_type ?? ''),
                sourceKey: String(row.source_key ?? ''),
                itemId: String(row.item_id ?? ''),
                sourceUrl: String(row.source_url ?? ''),
            };
        }
    }

    const text = String(rawText ?? '').trim();
    if (text) {
        const row = selectExistingAnnouncementByExactTextStatement.get(text, text, text);
        if (row) {
            return {
                matchType: 'exact-raw-text',
                sourceType: String(row.source_type ?? ''),
                sourceKey: String(row.source_key ?? ''),
                itemId: String(row.item_id ?? ''),
                sourceUrl: String(row.source_url ?? ''),
            };
        }
    }

    return null;
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
        rawText: String(row.raw_text ?? ''),
        imageUrlsJson: String(row.image_urls_json ?? '[]'),
        imagePathsJson: String(row.image_paths_json ?? '[]'),
        imageMediaJson: String(row.image_media_json ?? '[]'),
        eventCount: Number(row.event_count ?? 0),
        eventsWithoutImages: Number(row.events_without_images ?? 0),
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
    repostUrls = [],
    attachmentLinks = [],
    imageUrls,
    imagePaths,
    imageMedia = [],
    imageVisionFacts = [],
    imageVisionStatuses = [],
    provenance = {},
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
    database.prepare(`
        UPDATE vk_chat_source_messages
        SET repost_urls_json = ?, attachment_links_json = ?, image_vision_facts_json = ?, image_vision_status_json = ?, image_media_json = ?,
            canonical_post_url = CASE WHEN ? <> '' THEN ? ELSE canonical_post_url END,
            canonical_origin = CASE WHEN ? <> '' THEN ? ELSE canonical_origin END
        WHERE peer_id = ? AND conversation_message_id = ?
    `).run(
        JSON.stringify(safeJsonArray(repostUrls)),
        JSON.stringify(safeJsonArray(attachmentLinks)),
        JSON.stringify(Array.isArray(imageVisionFacts) ? imageVisionFacts : []),
        JSON.stringify(Array.isArray(imageVisionStatuses) && imageVisionStatuses.length ? imageVisionStatuses : deriveImageVisionStatuses(imageVisionFacts, imageUrls)),
        JSON.stringify(Array.isArray(imageMedia) ? imageMedia.slice(0, 24) : []),
        String(provenance?.canonicalPostUrl || '').trim(),
        String(provenance?.canonicalPostUrl || '').trim(),
        String(provenance?.canonicalOrigin || '').trim(),
        String(provenance?.canonicalOrigin || '').trim(),
        Number(peerId),
        Number(conversationMessageId),
    );
}

export function replaceVkChatEventsForMessage({
    peerId,
    conversationMessageId,
    sourceUrl,
    imagePaths,
    events,
    updatedAt,
    provenance = {},
}) {
    const safePeerId = Number(peerId);
    const safeMessageId = Number(conversationMessageId);
    const incomingEvents = Array.isArray(events) ? events : [];
    const storedRows = database.prepare(`
        SELECT * FROM vk_chat_events WHERE peer_id = ? AND conversation_message_id = ? ORDER BY event_index ASC, id ASC
    `).all(safePeerId, safeMessageId);
    let safeEvents = incomingEvents.map((event, index) => mergeIncomingEventWithStoredRow(
        event,
        selectStoredEventForIncoming(storedRows, event, index),
    ));
    const sourceMeta = database.prepare(`
        SELECT image_urls_json, image_paths_json, canonical_post_url, image_vision_facts_json, raw_text
        FROM vk_chat_source_messages
        WHERE peer_id = ? AND conversation_message_id = ? LIMIT 1
    `).get(safePeerId, safeMessageId);
    const sourcePaths = parseStoredImagePaths(sourceMeta?.image_paths_json);
    const sourceUrls = safeStoredJsonArray(sourceMeta?.image_urls_json);
    safeEvents = applyCurrentSourceSafePosterBindings(
        safeEvents,
        sourcePaths.length ? sourcePaths : imagePaths,
        sourceUrls,
        {
            sourceKind: 'vk_chat',
            canonicalPostUrl: String(provenance?.canonicalPostUrl || sourceMeta?.canonical_post_url || sourceUrl || ''),
            sourceVisionFacts: parseStoredPosterFacts(sourceMeta?.image_vision_facts_json),
        },
    );
    safeEvents = filterPermanentlyBlockedIncomingEvents(safeEvents, {
        sourceType: 'vk_chat',
        sourceUrl: String(sourceUrl || ''),
        canonicalPostUrl: String(provenance?.canonicalPostUrl || sourceMeta?.canonical_post_url || sourceUrl || ''),
        sourceItemId: String(provenance?.sourceItemId || `${safePeerId}:${safeMessageId}`),
        sourceText: String(sourceMeta?.raw_text || ''),
        posterVisionFacts: parseStoredPosterFacts(sourceMeta?.image_vision_facts_json),
    }).events;

    const ownsTransaction = !database.isTransaction;
    if (ownsTransaction) database.exec('BEGIN IMMEDIATE');

    try {
        deleteVkChatEventsForMessageStatement.run(
            safePeerId,
            safeMessageId,
        );

        safeEvents.forEach((event, index) => {
            const insertResult = insertVkChatEventStatement.run(
                safePeerId,
                safeMessageId,
                index,
                String(event?.title ?? '').trim(),
                String(event?.eventDate ?? '').trim(),
                event?.eventTime ? String(event.eventTime).trim() : null,
                normalizedPersistedVenue(event?.venue),
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
            writeEventV18867Metadata('vk_chat_events', Number(insertResult.lastInsertRowid || 0), event, {
                canonicalPostUrl: String(provenance?.canonicalPostUrl || sourceUrl || '').trim(),
                sourceType: 'vk_chat',
                sourceChatId: safePeerId,
                sourceChatName: String(provenance?.sourceChatName || '').trim(),
                sourceMessageId: safeMessageId,
                sourceItemId: String(provenance?.sourceItemId || `${safePeerId}:${safeMessageId}`),
                sourceOriginalUrl: String(provenance?.sourceOriginalUrl || '').trim(),
                canonicalOrigin: String(provenance?.canonicalOrigin || (sourceUrl ? 'chat-link' : 'chat-message-only')),
                venue: event?.venue,
            });
        });

        if (ownsTransaction) database.exec('COMMIT');
    } catch (error) {
        if (ownsTransaction) database.exec('ROLLBACK');
        throw error;
    }
}

/**
 * Atomically persist the hydrated source and its replacement events. The ledger
 * is finalized later by the owning processing pool and has retryable recovery
 * status if its completion fails. This wrapper does not create/remove any rows
 * on its own and does not change the existing schema.
 */
export function persistVkChatSourceAndEvents({ source, replacement = null }) {
    // node:sqlite DatabaseSync has no .transaction() helper. The inner event
    // replacement joins this transaction via database.isTransaction.
    if (database.isTransaction) {
        throw new Error('VK Chat source write expects a top-level transaction');
    }
    database.exec('BEGIN IMMEDIATE');
    try {
        upsertVkChatSourceMessage(source);
        if (replacement) replaceVkChatEventsForMessage(replacement);
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
            ...readEventV18867MetadataForType('vk_chat', row.id),
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

export function setMaintenanceState(taskKey, {
    lastRunAt = Math.floor(Date.now() / 1000),
    details = {},
} = {}) {
    const safeTaskKey = String(taskKey ?? '').trim();
    if (!safeTaskKey) {
        throw new Error('maintenance task key is required');
    }
    const safeDetails = details && typeof details === 'object' ? details : {};
    upsertMaintenanceStateStatement.run(
        safeTaskKey,
        Number(lastRunAt) || 0,
        JSON.stringify(safeDetails),
    );
    return getMaintenanceState(safeTaskKey);
}


/*
 * V147: one-time repair of already stored event media and dedupe registry.
 *
 * Old parser versions copied one post-level image to every child event created
 * from a pinned schedule/digest. That is not event-level evidence. Clear only
 * groups where 2+ child rows from the same source post all carry exactly the
 * same non-empty image list. Source-post media itself is preserved, so the
 * browser can still use it as evidence while searching for a specific event.
 *
 * The configured dedupe registry is rebuilt by V147 because its algorithm
 * version changed. Normal upcoming queries now honor duplicate members stored
 * in this registry, so duplicate suppression persists in SQLite instead of
 * living only inside one generated snapshot.
 */
const scraperV147MigrationKey = 'public-events-v147-event-level-media-persistent-dedupe';
const scraperV147Migration = database.prepare(`
    SELECT migration_key
    FROM scraper_code_migrations
    WHERE migration_key = ?
    LIMIT 1
`).get(scraperV147MigrationKey);

if (!scraperV147Migration) {
    const now = Math.floor(Date.now() / 1000);
    database.exec('BEGIN IMMEDIATE');
    try {
        const vkShared = database.prepare(`
            UPDATE vk_events AS e
            SET image_paths_json = '[]',
                updated_at = ?
            WHERE e.status IN ('approved', 'pending')
              AND TRIM(COALESCE(e.image_paths_json, '[]')) NOT IN ('', '[]')
              AND (
                  SELECT COUNT(*)
                  FROM vk_events AS x
                  WHERE x.screen_name = e.screen_name
                    AND x.post_id = e.post_id
                    AND x.status IN ('approved', 'pending')
              ) > 1
              AND NOT EXISTS (
                  SELECT 1
                  FROM vk_events AS x
                  WHERE x.screen_name = e.screen_name
                    AND x.post_id = e.post_id
                    AND x.status IN ('approved', 'pending')
                    AND COALESCE(x.image_paths_json, '[]') <> COALESCE(e.image_paths_json, '[]')
              )
        `).run(now);

        const telegramShared = database.prepare(`
            UPDATE telegram_events AS e
            SET image_paths_json = '[]',
                updated_at = ?
            WHERE e.status IN ('approved', 'pending')
              AND TRIM(COALESCE(e.image_paths_json, '[]')) NOT IN ('', '[]')
              AND (
                  SELECT COUNT(*)
                  FROM telegram_events AS x
                  WHERE x.channel = e.channel
                    AND x.message_id = e.message_id
                    AND x.status IN ('approved', 'pending')
              ) > 1
              AND NOT EXISTS (
                  SELECT 1
                  FROM telegram_events AS x
                  WHERE x.channel = e.channel
                    AND x.message_id = e.message_id
                    AND x.status IN ('approved', 'pending')
                    AND COALESCE(x.image_paths_json, '[]') <> COALESCE(e.image_paths_json, '[]')
              )
        `).run(now);

        const generatedTelegram = database.prepare(`
            UPDATE telegram_events
            SET image_paths_json = '[]', updated_at = ?
            WHERE LOWER(image_paths_json) LIKE '%event_message_cards%'
               OR LOWER(image_paths_json) LIKE '%-event-%'
        `).run(now);
        const generatedVk = database.prepare(`
            UPDATE vk_events
            SET image_paths_json = '[]', updated_at = ?
            WHERE LOWER(image_paths_json) LIKE '%event_message_cards%'
               OR LOWER(image_paths_json) LIKE '%-event-%'
        `).run(now);
        const generatedVkChat = database.prepare(`
            UPDATE vk_chat_events
            SET image_paths_json = '[]', updated_at = ?
            WHERE LOWER(image_paths_json) LIKE '%event_message_cards%'
               OR LOWER(image_paths_json) LIKE '%-event-%'
        `).run(now);
        const generatedManual = database.prepare(`
            UPDATE manual_events
            SET image_paths_json = '[]', updated_at = ?
            WHERE LOWER(image_paths_json) LIKE '%event_message_cards%'
               OR LOWER(image_paths_json) LIKE '%-event-%'
        `).run(now);

        database.prepare(`
            DELETE FROM event_dedupe_members
            WHERE scope = 'configured'
        `).run();
        database.prepare(`
            DELETE FROM event_dedupe_groups
            WHERE scope = 'configured'
        `).run();

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
        `).run(scraperV147MigrationKey, now);

        database.exec('COMMIT');
        console.log(
            '[SCRAPER V147 DB REPAIR]',
            `vkSharedMediaCleared=${Number(vkShared.changes ?? 0)}`,
            `telegramSharedMediaCleared=${Number(telegramShared.changes ?? 0)}`,
            `generatedCleared=${[
                generatedTelegram,
                generatedVk,
                generatedVkChat,
                generatedManual,
            ].reduce((sum, item) => sum + Number(item.changes ?? 0), 0)}`,
        );
    } catch (error) {
        database.exec('ROLLBACK');
        throw error;
    }
}

export function cleanupExpiredEventData({
    beforeDate = currentIsoDate(),
    now = Math.floor(Date.now() / 1000),
} = {}) {
    // V188.94 compatibility shim only. Past events/source evidence are retained
    // indefinitely for historical search and metadata review. Older builds
    // physically deleted these rows here; that destructive behavior is disabled
    // even if a stale caller invokes this exported helper.
    const details = {
        disabled: true,
        reason: 'historical-events-retained-v18894',
        beforeDate: String(beforeDate ?? currentIsoDate()).trim(),
        telegramEvents: 0,
        vkEvents: 0,
        vkChatEvents: 0,
        manualEvents: 0,
        telegramPosts: 0,
        vkPosts: 0,
        vkChatMessages: 0,
    };
    upsertMaintenanceStateStatement.run(
        'weekly_event_cleanup',
        Number(now),
        JSON.stringify(details),
    );
    return details;
}



/* V123: Telegram Mini App pinball leaderboard. */
database.exec(`
    CREATE TABLE IF NOT EXISTS pinball_scores (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT NOT NULL UNIQUE,
        telegram_user_id TEXT NOT NULL,
        username TEXT NOT NULL DEFAULT '',
        display_name TEXT NOT NULL DEFAULT '',
        score INTEGER NOT NULL DEFAULT 0 CHECK (score >= 0),
        duration_ms INTEGER NOT NULL DEFAULT 0 CHECK (duration_ms >= 0),
        max_combo INTEGER NOT NULL DEFAULT 0,
        max_multiplier INTEGER NOT NULL DEFAULT 1,
        bumpers INTEGER NOT NULL DEFAULT 0,
        ramps INTEGER NOT NULL DEFAULT 0,
        jackpots INTEGER NOT NULL DEFAULT 0,
        multiballs INTEGER NOT NULL DEFAULT 0,
        nudges INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS pinball_scores_leaderboard_idx
    ON pinball_scores (score DESC, created_at ASC);

    CREATE INDEX IF NOT EXISTS pinball_scores_user_idx
    ON pinball_scores (telegram_user_id, score DESC);
`);

const insertPinballScoreStatement = database.prepare(`
    INSERT OR IGNORE INTO pinball_scores (
        session_id, telegram_user_id, username, display_name, score, duration_ms,
        max_combo, max_multiplier, bumpers, ramps, jackpots, multiballs, nudges, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`);

export function savePinballScore({
    sessionId = '', telegramUserId = '', username = '', displayName = '', score = 0,
    durationMs = 0, maxCombo = 0, maxMultiplier = 1, bumpers = 0, ramps = 0,
    jackpots = 0, multiballs = 0, nudges = 0, createdAt = Math.floor(Date.now() / 1000),
} = {}) {
    const safeSessionId = String(sessionId ?? '').trim();
    const safeUserId = String(telegramUserId ?? '').trim();
    if (!safeSessionId || !safeUserId) return { saved: false, changes: 0 };
    const result = insertPinballScoreStatement.run(
        safeSessionId,
        safeUserId,
        String(username ?? '').trim().slice(0, 128),
        String(displayName ?? '').trim().slice(0, 256),
        Math.max(0, Math.trunc(Number(score) || 0)),
        Math.max(0, Math.trunc(Number(durationMs) || 0)),
        Math.max(0, Math.trunc(Number(maxCombo) || 0)),
        Math.max(1, Math.trunc(Number(maxMultiplier) || 1)),
        Math.max(0, Math.trunc(Number(bumpers) || 0)),
        Math.max(0, Math.trunc(Number(ramps) || 0)),
        Math.max(0, Math.trunc(Number(jackpots) || 0)),
        Math.max(0, Math.trunc(Number(multiballs) || 0)),
        Math.max(0, Math.trunc(Number(nudges) || 0)),
        Math.max(0, Math.trunc(Number(createdAt) || Math.floor(Date.now() / 1000))),
    );
    return { saved: Number(result.changes || 0) > 0, changes: Number(result.changes || 0) };
}

export function getPinballLeaderboard(limit = 15) {
    const safeLimit = Math.max(1, Math.min(100, Math.trunc(Number(limit) || 15)));
    const rows = database.prepare(`
        SELECT p.session_id, p.telegram_user_id, p.username, p.display_name, p.score,
               p.duration_ms, p.max_combo, p.max_multiplier, p.bumpers, p.ramps,
               p.jackpots, p.multiballs, p.nudges, p.created_at
        FROM pinball_scores p
        WHERE p.id = (
            SELECT p2.id
            FROM pinball_scores p2
            WHERE p2.telegram_user_id = p.telegram_user_id
            ORDER BY p2.score DESC, p2.created_at ASC, p2.id ASC
            LIMIT 1
        )
        ORDER BY p.score DESC, p.created_at ASC, p.id ASC
        LIMIT ?
    `).all(safeLimit);
    return rows.map((row) => ({
        sessionId: String(row.session_id ?? ''),
        telegramUserId: String(row.telegram_user_id ?? ''),
        username: String(row.username ?? ''),
        displayName: String(row.display_name ?? ''),
        score: Number(row.score ?? 0),
        durationMs: Number(row.duration_ms ?? 0),
        maxCombo: Number(row.max_combo ?? 0),
        maxMultiplier: Number(row.max_multiplier ?? 1),
        bumpers: Number(row.bumpers ?? 0),
        ramps: Number(row.ramps ?? 0),
        jackpots: Number(row.jackpots ?? 0),
        multiballs: Number(row.multiballs ?? 0),
        nudges: Number(row.nudges ?? 0),
        createdAt: Number(row.created_at ?? 0),
    }));
}

export function getPinballPersonalBest(telegramUserId = '') {
    const userId = String(telegramUserId ?? '').trim();
    if (!userId) return 0;
    const row = database.prepare(`
        SELECT MAX(score) AS best
        FROM pinball_scores
        WHERE telegram_user_id = ?
    `).get(userId);
    return Math.max(0, Number(row?.best ?? 0));
}

/* V118: atomic replacement of the working AI runtime registry. */
export function replaceAiRuntimeModes(rows = [], testedAt = Math.floor(Date.now() / 1000)) {
    const safeRows = Array.isArray(rows) ? rows : [];
    const insert = database.prepare(`
        INSERT INTO ai_runtime_modes (
            provider, env_name, masked_key, model, capability, endpoint,
            preferred_transport, fallback_transport, fallback_endpoint,
            non_stream_ok, stream_ok, reasoning_modes_json, reasoning_policy_json, tested_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    database.exec('BEGIN IMMEDIATE');
    try {
        database.exec('DELETE FROM ai_runtime_modes');
        for (const row of safeRows) {
            const provider = String(row?.provider ?? '').trim();
            const envName = String(row?.envName ?? '').trim();
            const model = String(row?.model ?? '').trim();
            const capability = String(row?.capability ?? '').trim();
            if (!provider || !envName || !model || !['text', 'image'].includes(capability)) continue;
            insert.run(
                provider,
                envName,
                String(row?.masked ?? '').trim(),
                model,
                capability,
                String(row?.endpoint ?? '').trim(),
                String(row?.preferredTransport ?? '').trim(),
                String(row?.fallbackTransport ?? '').trim(),
                String(row?.fallbackEndpoint ?? '').trim(),
                row?.nonStreamOk ? 1 : 0,
                row?.streamOk ? 1 : 0,
                JSON.stringify(Array.isArray(row?.reasoningModes) ? row.reasoningModes : []),
                JSON.stringify(row?.reasoningPolicies && typeof row.reasoningPolicies === 'object' ? row.reasoningPolicies : {}),
                Number(row?.testedAt ?? testedAt),
            );
        }
        database.exec('COMMIT');
    } catch (error) {
        database.exec('ROLLBACK');
        throw error;
    }
    return safeRows.length;
}



/* V188.4: atomic replacement of the latest compact key/model health snapshot. */
export function replaceAiHealthRegistry({ keys = [], models = [] } = {}, checkedAt = Math.floor(Date.now() / 1000)) {
    const keyRows = Array.isArray(keys) ? keys : [];
    const modelRows = Array.isArray(models) ? models : [];
    const insertKey = database.prepare(`
        INSERT INTO ai_key_health (
            provider, env_name, masked_key, status, catalog_status,
            catalog_latency_ms, models_seen, working_models, last_error, checked_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const insertModel = database.prepare(`
        INSERT INTO ai_model_health (
            provider, env_name, masked_key, model, capability, status,
            non_stream_ok, stream_ok, non_stream_status, stream_status,
            non_stream_latency_ms, stream_latency_ms, preferred_transport,
            last_error, checked_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    database.exec('BEGIN IMMEDIATE');
    try {
        database.exec('DELETE FROM ai_key_health');
        database.exec('DELETE FROM ai_model_health');
        for (const row of keyRows) {
            const provider = String(row?.provider ?? '').trim();
            const envName = String(row?.envName ?? '').trim();
            if (!provider || !envName) continue;
            insertKey.run(
                provider,
                envName,
                String(row?.masked ?? '').trim(),
                String(row?.status ?? 'unknown').trim() || 'unknown',
                Number(row?.catalogStatus ?? 0),
                Number(row?.catalogLatencyMs ?? 0),
                Number(row?.modelsSeen ?? 0),
                Number(row?.workingModels ?? 0),
                String(row?.lastError ?? '').trim().slice(0, 1000),
                Number(row?.checkedAt ?? checkedAt),
            );
        }
        for (const row of modelRows) {
            const provider = String(row?.provider ?? '').trim();
            const envName = String(row?.envName ?? '').trim();
            const model = String(row?.model ?? '').trim();
            const capability = String(row?.capability ?? '').trim();
            if (!provider || !envName || !model || !capability) continue;
            insertModel.run(
                provider,
                envName,
                String(row?.masked ?? '').trim(),
                model,
                capability,
                String(row?.status ?? 'unknown').trim() || 'unknown',
                row?.nonStreamOk ? 1 : 0,
                row?.streamOk ? 1 : 0,
                Number(row?.nonStreamStatus ?? 0),
                Number(row?.streamStatus ?? 0),
                Number(row?.nonStreamLatencyMs ?? 0),
                Number(row?.streamLatencyMs ?? 0),
                String(row?.preferredTransport ?? '').trim(),
                String(row?.lastError ?? '').trim().slice(0, 1500),
                Number(row?.checkedAt ?? checkedAt),
            );
        }
        database.exec('COMMIT');
    } catch (error) {
        database.exec('ROLLBACK');
        throw error;
    }

    return { keys: keyRows.length, models: modelRows.length };
}

export function getAiKeyHealthRows() {
    return database.prepare(`
        SELECT provider, env_name, masked_key, status, catalog_status,
               catalog_latency_ms, models_seen, working_models, last_error, checked_at
        FROM ai_key_health
        ORDER BY provider, env_name
    `).all().map((row) => ({
        provider: String(row.provider ?? ''),
        envName: String(row.env_name ?? ''),
        masked: String(row.masked_key ?? ''),
        status: String(row.status ?? 'unknown'),
        catalogStatus: Number(row.catalog_status ?? 0),
        catalogLatencyMs: Number(row.catalog_latency_ms ?? 0),
        modelsSeen: Number(row.models_seen ?? 0),
        workingModels: Number(row.working_models ?? 0),
        lastError: String(row.last_error ?? ''),
        checkedAt: Number(row.checked_at ?? 0),
    }));
}

export function getAiModelHealthRows({ provider = '', envName = '', model = '', capability = '' } = {}) {
    const filters = [];
    const params = [];
    const add = (column, value) => {
        const cleaned = String(value ?? '').trim();
        if (!cleaned) return;
        filters.push(`${column} = ?`);
        params.push(cleaned);
    };
    add('provider', provider);
    add('env_name', envName);
    add('model', model);
    add('capability', capability);
    const where = filters.length ? `WHERE ${filters.join(' AND ')}` : '';
    return database.prepare(`
        SELECT provider, env_name, masked_key, model, capability, status,
               non_stream_ok, stream_ok, non_stream_status, stream_status,
               non_stream_latency_ms, stream_latency_ms, preferred_transport,
               last_error, checked_at
        FROM ai_model_health
        ${where}
        ORDER BY capability, provider, env_name, model
    `).all(...params).map((row) => ({
        provider: String(row.provider ?? ''),
        envName: String(row.env_name ?? ''),
        masked: String(row.masked_key ?? ''),
        model: String(row.model ?? ''),
        capability: String(row.capability ?? ''),
        status: String(row.status ?? 'unknown'),
        nonStreamOk: Boolean(Number(row.non_stream_ok ?? 0)),
        streamOk: Boolean(Number(row.stream_ok ?? 0)),
        nonStreamStatus: Number(row.non_stream_status ?? 0),
        streamStatus: Number(row.stream_status ?? 0),
        nonStreamLatencyMs: Number(row.non_stream_latency_ms ?? 0),
        streamLatencyMs: Number(row.stream_latency_ms ?? 0),
        preferredTransport: String(row.preferred_transport ?? ''),
        lastError: String(row.last_error ?? ''),
        checkedAt: Number(row.checked_at ?? 0),
    }));
}

export function getAiModelHealthStatus({ provider = '', envName = '', model = '', capability = 'text' } = {}) {
    const row = database.prepare(`
        SELECT status, non_stream_ok, stream_ok, preferred_transport, checked_at
        FROM ai_model_health
        WHERE provider = ? AND env_name = ? AND model = ? AND capability = ?
        LIMIT 1
    `).get(
        String(provider ?? '').trim(),
        String(envName ?? '').trim(),
        String(model ?? '').trim(),
        String(capability ?? '').trim(),
    );
    if (!row) return null;
    return {
        status: String(row.status ?? 'unknown'),
        nonStreamOk: Boolean(Number(row.non_stream_ok ?? 0)),
        streamOk: Boolean(Number(row.stream_ok ?? 0)),
        preferredTransport: String(row.preferred_transport ?? ''),
        checkedAt: Number(row.checked_at ?? 0),
    };
}

export function getAiRuntimeModes({ capability = '' } = {}) {
    const cleanCapability = String(capability ?? '').trim();
    const rows = cleanCapability
        ? database.prepare(`
            SELECT provider, env_name, masked_key, model, capability, endpoint,
                   preferred_transport, fallback_transport, fallback_endpoint,
                   non_stream_ok, stream_ok, reasoning_modes_json, reasoning_policy_json, tested_at
            FROM ai_runtime_modes
            WHERE capability = ?
            ORDER BY provider, env_name, model
        `).all(cleanCapability)
        : database.prepare(`
            SELECT provider, env_name, masked_key, model, capability, endpoint,
                   preferred_transport, fallback_transport, fallback_endpoint,
                   non_stream_ok, stream_ok, reasoning_modes_json, reasoning_policy_json, tested_at
            FROM ai_runtime_modes
            ORDER BY capability, provider, env_name, model
        `).all();
    return rows.map((row) => ({
        provider: String(row.provider ?? ''),
        envName: String(row.env_name ?? ''),
        masked: String(row.masked_key ?? ''),
        model: String(row.model ?? ''),
        capability: String(row.capability ?? ''),
        endpoint: String(row.endpoint ?? ''),
        preferredTransport: String(row.preferred_transport ?? ''),
        fallbackTransport: String(row.fallback_transport ?? ''),
        fallbackEndpoint: String(row.fallback_endpoint ?? ''),
        nonStreamOk: Boolean(Number(row.non_stream_ok ?? 0)),
        streamOk: Boolean(Number(row.stream_ok ?? 0)),
        reasoningModes: (() => {
            try {
                const parsed = JSON.parse(String(row.reasoning_modes_json ?? '[]'));
                return Array.isArray(parsed) ? parsed.map((item) => String(item)) : [];
            } catch {
                return [];
            }
        })(),
        reasoningPolicies: (() => {
            try {
                const parsed = JSON.parse(String(row.reasoning_policy_json ?? '{}'));
                return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
            } catch {
                return {};
            }
        })(),
        testedAt: Number(row.tested_at ?? 0),
    }));
}


/* V188.49: catalog discovery is append/update only; historical first_seen survives. */
export function recordAiModelDiscoveries(rows = [], seenAt = Math.floor(Date.now() / 1000)) {
    const select = database.prepare(`
        SELECT provider, env_name, model, first_seen_at, qualification_status
        FROM ai_model_discovery WHERE provider = ? AND env_name = ? AND model = ? LIMIT 1
    `);
    const insert = database.prepare(`
        INSERT INTO ai_model_discovery (
            provider, env_name, masked_key, model, capabilities_json, first_seen_at, last_seen_at,
            qualification_status, qualification_json, qualified_at, promoted
        ) VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', '{}', 0, 0)
    `);
    const update = database.prepare(`
        UPDATE ai_model_discovery
        SET masked_key = ?, capabilities_json = ?, last_seen_at = ?
        WHERE provider = ? AND env_name = ? AND model = ?
    `);
    const discovered = [];
    database.exec('BEGIN IMMEDIATE');
    try {
        for (const row of Array.isArray(rows) ? rows : []) {
            const provider = String(row?.provider ?? '').trim();
            const envName = String(row?.envName ?? '').trim();
            const model = String(row?.model ?? '').trim();
            if (!provider || !envName || !model) continue;
            const capabilities = JSON.stringify(Array.isArray(row?.capabilities) ? [...new Set(row.capabilities.map(String))] : []);
            const existing = select.get(provider, envName, model);
            if (!existing) {
                insert.run(provider, envName, String(row?.masked ?? ''), model, capabilities, Number(seenAt), Number(seenAt));
                discovered.push({ provider, envName, model, capabilities: JSON.parse(capabilities), firstSeenAt: Number(seenAt) });
            } else {
                update.run(String(row?.masked ?? ''), capabilities, Number(seenAt), provider, envName, model);
            }
        }
        database.exec('COMMIT');
    } catch (error) {
        database.exec('ROLLBACK');
        throw error;
    }
    return discovered;
}

export function saveAiModelQualification({ provider = '', envName = '', model = '', status = 'failed', details = {}, promoted = false, qualifiedAt = Math.floor(Date.now() / 1000) } = {}) {
    const safeProvider = String(provider ?? '').trim();
    const safeEnvName = String(envName ?? '').trim();
    const safeModel = String(model ?? '').trim();
    if (!safeProvider || !safeEnvName || !safeModel) return null;
    database.prepare(`
        UPDATE ai_model_discovery
        SET qualification_status = ?, qualification_json = ?, qualified_at = ?, promoted = ?
        WHERE provider = ? AND env_name = ? AND model = ?
    `).run(
        String(status || 'failed'),
        JSON.stringify(details && typeof details === 'object' ? details : {}),
        Number(qualifiedAt || 0),
        promoted ? 1 : 0,
        safeProvider, safeEnvName, safeModel,
    );
    return getAiModelDiscoveryRows({ provider: safeProvider, envName: safeEnvName, model: safeModel })[0] || null;
}

export function getAiModelDiscoveryRows({ provider = '', envName = '', model = '', status = '' } = {}) {
    const clauses = [];
    const values = [];
    if (String(provider).trim()) { clauses.push('provider = ?'); values.push(String(provider).trim()); }
    if (String(envName).trim()) { clauses.push('env_name = ?'); values.push(String(envName).trim()); }
    if (String(model).trim()) { clauses.push('model = ?'); values.push(String(model).trim()); }
    if (String(status).trim()) { clauses.push('qualification_status = ?'); values.push(String(status).trim()); }
    const rows = database.prepare(`
        SELECT provider, env_name, masked_key, model, capabilities_json, first_seen_at, last_seen_at,
               qualification_status, qualification_json, qualified_at, promoted
        FROM ai_model_discovery
        ${clauses.length ? `WHERE ${clauses.join(' AND ')}` : ''}
        ORDER BY first_seen_at DESC, provider, env_name, model
    `).all(...values);
    return rows.map((row) => {
        let capabilities = []; let qualification = {};
        try { capabilities = JSON.parse(String(row.capabilities_json || '[]')); } catch {}
        try { qualification = JSON.parse(String(row.qualification_json || '{}')); } catch {}
        return {
            provider: String(row.provider || ''), envName: String(row.env_name || ''), masked: String(row.masked_key || ''),
            model: String(row.model || ''), capabilities: Array.isArray(capabilities) ? capabilities : [],
            firstSeenAt: Number(row.first_seen_at || 0), lastSeenAt: Number(row.last_seen_at || 0),
            qualificationStatus: String(row.qualification_status || 'pending'), qualification, qualifiedAt: Number(row.qualified_at || 0),
            promoted: Boolean(Number(row.promoted || 0)),
        };
    });
}

export function getQualifiedDiscoveredAiModels(capability = 'text') {
    const required = String(capability || 'text').trim();
    return getAiModelDiscoveryRows({ status: 'qualified' })
        .filter((row) => row.promoted && (!required || row.capabilities.includes(required)))
        .sort((a, b) => b.qualifiedAt - a.qualifiedAt || b.model.localeCompare(a.model, 'en', { numeric: true }));
}


/* V119: resolve the preferred audited transport for one exact runtime key+model. */
export function getAiRuntimeModePolicy({ provider = '', envName = '', model = '', capability = 'text' } = {}) {
    const row = database.prepare(`
        SELECT provider, env_name, masked_key, model, capability, endpoint,
               preferred_transport, fallback_transport, fallback_endpoint,
               non_stream_ok, stream_ok, reasoning_modes_json, reasoning_policy_json, tested_at
        FROM ai_runtime_modes
        WHERE provider = ? AND env_name = ? AND model = ? AND capability = ?
        LIMIT 1
    `).get(
        String(provider ?? '').trim(),
        String(envName ?? '').trim(),
        String(model ?? '').trim(),
        String(capability ?? '').trim(),
    );
    if (!row) return null;
    let reasoningModes = [];
    let reasoningPolicies = {};
    try {
        const parsed = JSON.parse(String(row.reasoning_modes_json ?? '[]'));
        if (Array.isArray(parsed)) reasoningModes = parsed.map((item) => String(item));
    } catch {
        reasoningModes = [];
    }
    try {
        const parsed = JSON.parse(String(row.reasoning_policy_json ?? '{}'));
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) reasoningPolicies = parsed;
    } catch {
        reasoningPolicies = {};
    }
    return {
        provider: String(row.provider ?? ''),
        envName: String(row.env_name ?? ''),
        masked: String(row.masked_key ?? ''),
        model: String(row.model ?? ''),
        capability: String(row.capability ?? ''),
        endpoint: String(row.endpoint ?? ''),
        preferredTransport: String(row.preferred_transport ?? ''),
        fallbackTransport: String(row.fallback_transport ?? ''),
        fallbackEndpoint: String(row.fallback_endpoint ?? ''),
        nonStreamOk: Boolean(Number(row.non_stream_ok ?? 0)),
        streamOk: Boolean(Number(row.stream_ok ?? 0)),
        reasoningModes,
        reasoningPolicies,
        testedAt: Number(row.tested_at ?? 0),
    };
}
