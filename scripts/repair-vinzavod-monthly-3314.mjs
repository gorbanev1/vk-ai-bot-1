import { DatabaseSync } from 'node:sqlite';
import { resolve } from 'node:path';

const databasePath = resolve(process.env.GIGORAVE_DB_PATH || 'data/bot.sqlite');
const apply = process.argv.includes('--apply');
const db = new DatabaseSync(databasePath, { readOnly: !apply });
const channel = 'vinzavodproo';
const messageId = 3314;
const source = db.prepare('SELECT raw_text FROM telegram_source_posts WHERE channel = ? AND message_id = ?').get(channel, messageId);
if (!source) throw new Error('telegram source vinzavodproo/3314 not found');

const segments = new Map([
    ['2026-10-09', '9 ОКТЯБРЯ — КЛАБ-ШОУ 9 ГРАММ\nАртист, чьи треки узнают с первых секунд, а атмосферу невозможно спутать ни с чем.\n«Рапапам», «Дэнс», «Ласковый зверь» и другие знакомые хиты — уже 9 октября на Винзаводе.'],
    ['2026-10-16', '16–17 ОКТЯБРЯ — HUNTING FOR LOVE ❤️🧛🏼\nОсенью всем нам хочется больше любви, романтики и того самого человека рядом.\nМы устраиваем вечеринку в стиле «Сумерек», где каждый сможет почувствовать себя немного Беллой или Эдвардом и, возможно, найти свою вторую половинку ❤️'],
    ['2026-10-17', '16–17 ОКТЯБРЯ — HUNTING FOR LOVE ❤️🧛🏼\nОсенью всем нам хочется больше любви, романтики и того самого человека рядом.\nМы устраиваем вечеринку в стиле «Сумерек», где каждый сможет почувствовать себя немного Беллой или Эдвардом и, возможно, найти свою вторую половинку ❤️'],
    ['2026-10-23', '23 ОКТЯБРЯ — NICK VSN TOXI$ OFFICIAL DJ\nКонцертный диджей исполнителя TOXI$ устроит настоящий пожар на танцполе. Такое точно нельзя пропустить 💿🔥'],
    ['2026-10-30', '30–31 ОКТЯБРЯ — ХЭЛЛОУИН 🎃\nСамая страшная и захватывающая ночь осени, где каждый может стать тем, кем захочет 🕸️🩸'],
    ['2026-10-31', '30–31 ОКТЯБРЯ — ХЭЛЛОУИН 🎃\nСамая страшная и захватывающая ночь осени, где каждый может стать тем, кем захочет 🕸️🩸'],
]);

const rows = db.prepare('SELECT rowid AS row_id, event_date, description, source_segment_text FROM telegram_events WHERE channel = ? AND message_id = ? ORDER BY event_index, rowid').all(channel, messageId);
const changes = rows.map((row) => ({
    rowId: Number(row.row_id),
    date: String(row.event_date),
    description: segments.get(String(row.event_date)) || String(row.description || ''),
    sourceSegment: segments.get(String(row.event_date)) || String(row.source_segment_text || ''),
}));
console.log(JSON.stringify({ apply, databasePath, sourceChars: String(source.raw_text || '').length, changes }, null, 2));
if (!apply) process.exit(0);

db.exec('BEGIN IMMEDIATE');
try {
    const update = db.prepare('UPDATE telegram_events SET description = ?, source_segment_text = ? WHERE rowid = ?');
    for (const change of changes) update.run(change.description, change.sourceSegment, change.rowId);
    db.exec('COMMIT');
} catch (error) {
    db.exec('ROLLBACK');
    throw error;
}
console.log('Repaired vinzavodproo/3314 event descriptions transactionally.');
