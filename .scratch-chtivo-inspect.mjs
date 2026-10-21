import { DatabaseSync } from 'node:sqlite';
import { MAIN_DATABASE_PATH } from './src/infrastructure/database/index.js';
const db = new DatabaseSync(MAIN_DATABASE_PATH);
console.log('chapters', db.prepare('SELECT book_id,COUNT(*) chapters,SUM(length(body)) chars FROM chtivo_chapters GROUP BY book_id').all());
console.log('progress', db.prepare('SELECT peer_id,book_id,chapter_order,chapter_offset,part_number,last_text_message_id,active,updated_at FROM chtivo_progress ORDER BY updated_at DESC LIMIT 30').all());
console.log('schedules', db.prepare('SELECT * FROM chtivo_schedule').all());
