import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const dataDirectory = resolve('data');
const databasePath = resolve(dataDirectory, 'bot.sqlite');

mkdirSync(dataDirectory, {
    recursive: true,
});

const database = new DatabaseSync(databasePath);

database.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA busy_timeout = 5000;

    CREATE TABLE IF NOT EXISTS messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        peer_id INTEGER NOT NULL,
        sender_id INTEGER NOT NULL,
        conversation_message_id INTEGER,
        text TEXT NOT NULL DEFAULT '',
        created_at INTEGER NOT NULL,

        UNIQUE(peer_id, conversation_message_id)
    ) STRICT;

    CREATE INDEX IF NOT EXISTS idx_messages_peer_id
        ON messages(peer_id);

    CREATE INDEX IF NOT EXISTS idx_messages_peer_sender
        ON messages(peer_id, sender_id);

    CREATE INDEX IF NOT EXISTS idx_messages_created_at
        ON messages(created_at);
`);

const insertMessageStatement = database.prepare(`
    INSERT OR IGNORE INTO messages (
        peer_id,
        sender_id,
        conversation_message_id,
        text,
        created_at
    )
    VALUES (?, ?, ?, ?, ?)
`);

const chatTotalsStatement = database.prepare(`
    SELECT
        COUNT(*) AS message_count,
        COUNT(DISTINCT sender_id) AS participant_count
    FROM messages
    WHERE peer_id = ?
`);

const chatTopStatement = database.prepare(`
    SELECT
        sender_id,
        COUNT(*) AS message_count
    FROM messages
    WHERE peer_id = ?
    GROUP BY sender_id
    ORDER BY message_count DESC, sender_id ASC
        LIMIT 10
`);

export function saveIncomingMessage({
                                        peerId,
                                        senderId,
                                        conversationMessageId,
                                        text,
                                    }) {
    insertMessageStatement.run(
        peerId,
        senderId,
        conversationMessageId ?? null,
        text ?? '',
        Math.floor(Date.now() / 1000),
    );
}

export function getChatStats(peerId) {
    const totals = chatTotalsStatement.get(peerId);
    const topRows = chatTopStatement.all(peerId);

    return {
        messageCount: Number(totals?.message_count ?? 0),
        participantCount: Number(totals?.participant_count ?? 0),

        top: topRows.map((row) => ({
            senderId: Number(row.sender_id),
            messageCount: Number(row.message_count),
        })),
    };
}