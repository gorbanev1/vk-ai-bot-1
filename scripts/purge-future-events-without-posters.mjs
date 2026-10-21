import { copyFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const dataDir = join(root, 'data');
const dbPath = join(dataDir, 'bot.sqlite');
const cutoff = String(process.env.EVENT_PURGE_FROM || '2026-09-25');
const now = new Date().toISOString().replace(/[:.]/gu, '-');
const backupPath = join(dataDir, 'backups', `pre-no-poster-purge-${now}.sqlite`);
const reportPath = join(dataDir, 'audit', `no-poster-purge-${now}.json`);

mkdirSync(dirname(backupPath), { recursive: true });
mkdirSync(dirname(reportPath), { recursive: true });

const db = new DatabaseSync(dbPath);
db.exec('PRAGMA foreign_keys = ON');
db.exec('PRAGMA wal_checkpoint(FULL)');
copyFileSync(dbPath, backupPath);

function parseJson(value, fallback = []) {
    try {
        const parsed = JSON.parse(String(value ?? ''));
        return parsed;
    } catch {
        return fallback;
    }
}

function resolveStoredPath(value) {
    const raw = String(value ?? '').trim();
    if (!raw || /generated-images|event-image-review/iu.test(raw)) return '';
    const candidates = [
        isAbsolute(raw) ? raw : '',
        join(root, raw),
        join(dataDir, raw),
    ].filter(Boolean);
    return candidates.find((candidate) => existsSync(candidate)) || '';
}

function rowColumns(table) {
    return db.prepare(`PRAGMA table_info(${table})`).all().map((row) => String(row.name));
}

function rowObject(table, row) {
    if (row && typeof row === 'object' && !Array.isArray(row)) return row;
    const columns = rowColumns(table);
    return Object.fromEntries(columns.map((column, index) => [column, row[index]]));
}

function sourceEvidenceFor(table, event) {
    if (table === 'vk_events') {
        return db.prepare(`
            SELECT screen_name, post_id, source_url, raw_text, image_urls_json, image_paths_json,
                   image_vision_facts_json, image_vision_status_json, fetched_at, parse_status
            FROM vk_source_posts WHERE screen_name = ? AND post_id = ? LIMIT 1
        `).get(String(event.screen_name || ''), Number(event.post_id || 0)) || null;
    }
    if (table === 'vk_chat_events') {
        return db.prepare(`
            SELECT peer_id, conversation_message_id, conversation_url, raw_text, image_urls_json, image_paths_json,
                   image_vision_facts_json, image_vision_status_json, fetched_at, parse_status
            FROM vk_chat_source_messages WHERE peer_id = ? AND conversation_message_id = ? LIMIT 1
        `).get(Number(event.peer_id || 0), Number(event.conversation_message_id || 0)) || null;
    }
    return null;
}

const candidates = [];
const specs = [
    { table: 'vk_events', sourceType: 'vk' },
    { table: 'vk_chat_events', sourceType: 'vk_chat' },
    {
        table: 'manual_events',
        sourceType: 'manual',
        where: `source_url LIKE 'https://vk.ru/%'
            AND title NOT LIKE 'V103 REGISTRY %'
            AND title NOT LIKE 'Концерт строгий %'`,
    },
];

for (const spec of specs) {
    const where = [`event_date >= ?`, spec.where || '1=1'].join(' AND ');
    for (const raw of db.prepare(`SELECT * FROM ${spec.table} WHERE ${where} ORDER BY event_date, id`).all(cutoff)) {
        const event = rowObject(spec.table, raw);
        const paths = parseJson(event.image_paths_json, []);
        const storedPaths = Array.isArray(paths) ? paths.map((value) => String(value ?? '').trim()).filter(Boolean) : [];
        const realPaths = storedPaths.map(resolveStoredPath).filter(Boolean);
        if (realPaths.length) continue;
        candidates.push({
            table: spec.table,
            sourceType: spec.sourceType,
            id: Number(event.id),
            title: String(event.title || ''),
            eventDate: String(event.event_date || ''),
            sourceUrl: String(event.source_url || ''),
            storedImagePaths: storedPaths,
            sourceEvidence: sourceEvidenceFor(spec.table, event),
            row: event,
        });
    }
}

const report = {
    version: 1,
    createdAt: new Date().toISOString(),
    cutoff,
    backupPath,
    preservedSourceRows: true,
    deleted: candidates.map(({ table, sourceType, id, title, eventDate, sourceUrl, storedImagePaths, sourceEvidence }) => ({
        table, sourceType, id, title, eventDate, sourceUrl, storedImagePaths, sourceEvidence,
    })),
    sqlite: {},
};

db.exec('BEGIN IMMEDIATE');
try {
    for (const item of candidates) {
        for (const sourceType of new Set([item.sourceType, item.table])) {
            db.prepare(`DELETE FROM event_dedupe_members WHERE source_type = ? AND event_id = ?`)
                .run(sourceType, item.id);
            db.prepare(`DELETE FROM all_party_metadata WHERE source_type = ? AND event_id = ?`)
                .run(sourceType, item.id);
        }
        db.prepare(`DELETE FROM ${item.table} WHERE id = ?`).run(item.id);
    }
    db.prepare(`
        DELETE FROM event_dedupe_groups
        WHERE NOT EXISTS (SELECT 1 FROM event_dedupe_members m
                          WHERE m.scope = event_dedupe_groups.scope
                            AND m.group_key = event_dedupe_groups.group_key)
    `).run();
    db.prepare(`
        UPDATE event_dedupe_groups
        SET member_count = (SELECT COUNT(*) FROM event_dedupe_members m
                            WHERE m.scope = event_dedupe_groups.scope
                              AND m.group_key = event_dedupe_groups.group_key)
    `).run();
    db.exec('COMMIT');
} catch (error) {
    db.exec('ROLLBACK');
    throw error;
}

report.sqlite.quickCheck = db.prepare('PRAGMA quick_check').all();
report.sqlite.foreignKeyCheck = db.prepare('PRAGMA foreign_key_check').all();
report.deletedCount = candidates.length;
writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
db.close();
console.log(JSON.stringify({ backupPath, reportPath, deletedCount: candidates.length, deleted: report.deleted, sqlite: report.sqlite }, null, 2));
