import { DatabaseSync } from 'node:sqlite';
import { existsSync, renameSync, writeFileSync } from 'node:fs';

const db = new DatabaseSync('./data/bot.sqlite');
const backup = './data/bot.sqlite.before-no-poster-force-reparse-20261016.sqlite';
db.exec("VACUUM INTO '" + backup.replaceAll("'", "''") + "'");
const now = Math.floor(Date.now() / 1000);
const tables = [['vk_events', 'vk'], ['telegram_events', 'telegram'], ['vk_chat_events', 'vk_chat'], ['manual_events', 'manual']];
const report = [];
const hasRealConfirmedImage = (paths, status) => (Array.isArray(paths) ? paths : []).some((value) => {
  const path = String(value || '');
  return path && !path.includes('event_message_cards/') && !path.includes('event_generated_fallbacks/') && !/-event-\d+\.png$/u.test(path) && /(?:exact|verified|legacy)/iu.test(String(status || ''));
});
db.exec('BEGIN IMMEDIATE');
try {
  for (const [table, sourceType] of tables) {
    const rows = db.prepare('SELECT id, source_url, event_date, image_paths_json, poster_match_status FROM ' + table + " WHERE event_date >= '2026-10-16' AND status IN ('approved','pending') AND TRIM(source_url) <> ''").all();
    for (const row of rows) {
      let paths = []; try { paths = JSON.parse(row.image_paths_json || '[]'); } catch {}
      if (hasRealConfirmedImage(paths, row.poster_match_status)) continue;
      const sql = table === 'manual_events'
        ? "UPDATE manual_events SET title='', event_time=NULL, venue='', participants='', price='', description='', evidence='', image_paths_json='[]', updated_at=? WHERE id=?"
        : "UPDATE " + table + " SET title='', event_time=NULL, venue='', participants='', price='', description='', evidence='', image_paths_json='[]', poster_image_index=0, poster_match_status='no_safe_poster', poster_match_reason='force-reparse-cleared-v18910', poster_vision_facts_json='[]', poster_review_candidates_json='[]', updated_at=? WHERE id=?";
      const changed = Number(db.prepare(sql).run(now, Number(row.id)).changes || 0);
      if (!changed) continue;
      report.push({ sourceType, id: Number(row.id), sourceUrl: row.source_url, eventDate: row.event_date, previousStatus: row.poster_match_status });
      db.prepare('DELETE FROM all_party_metadata WHERE source_type=? AND event_id=?').run(sourceType, Number(row.id));
      db.prepare('DELETE FROM event_dedupe_members WHERE source_type=? AND event_id=?').run(sourceType, Number(row.id));
    }
  }
  db.prepare("DELETE FROM event_dedupe_members WHERE scope='configured'").run();
  db.prepare("DELETE FROM event_dedupe_groups WHERE scope='configured'").run();
  db.exec('COMMIT');
} catch (error) { db.exec('ROLLBACK'); throw error; }
const snapshot = './data/event-verified-snapshot.json';
if (existsSync(snapshot)) renameSync(snapshot, snapshot + '.before-no-poster-force-reparse-20261016');
writeFileSync('./data/no-poster-force-reparse-targets-20261016.json', JSON.stringify({ createdAt: new Date().toISOString(), backup, targets: report }, null, 2) + '\n');
console.log(JSON.stringify({ backup, targets: report.length, report }, null, 2));
