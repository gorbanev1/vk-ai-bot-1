import { DatabaseSync } from 'node:sqlite';

const db = new DatabaseSync('data/bot.sqlite.audit-copy');
console.log(db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name LIKE '%dedupe%'").all());
console.log(db.prepare(`SELECT scope, group_key, source_type, event_id, role FROM event_dedupe_members WHERE scope = 'configured' ORDER BY group_key, role`).all().filter((row) => [175,304,70,339,65,302,69].includes(Number(row.event_id))));

for (const table of ['vk_events','vk_chat_events']) {
  console.log(table, db.prepare(`SELECT * FROM ${table} WHERE id IN (${table === 'vk_events' ? '175,304,339,302' : '70,65,69'})`).all());
}
