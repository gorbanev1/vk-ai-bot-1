import { existsSync, mkdirSync, readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const projectDir = resolve(process.cwd());
const dataDir = join(projectDir, 'data');
const dbPath = join(dataDir, 'bot.sqlite');
const backupDir = join(dataDir, 'healthy-backups');

function ts() {
  return new Date().toISOString().replaceAll(':', '-').replaceAll('.', '-');
}
function sqlString(v) { return `'${String(v).replaceAll("'", "''")}'`; }
function qid(v) { return `"${String(v).replaceAll('"', '""')}"`; }
function quickCheck(path) {
  let db;
  try {
    db = new DatabaseSync(path, { readOnly: true });
    const rows = db.prepare('PRAGMA quick_check').all();
    const vals = rows.flatMap((r) => Object.values(r).map(String));
    return vals.length === 1 && vals[0].toLowerCase() === 'ok';
  } catch { return false; }
  finally { try { db?.close(); } catch {} }
}
function tableExists(db, table) {
  return Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=? LIMIT 1").get(table));
}
function columns(db, table) {
  if (!tableExists(db, table)) return [];
  return db.prepare(`PRAGMA table_info(${qid(table)})`).all().map((r) => String(r.name));
}
function commonColumns(source, target, table, { exclude = [] } = {}) {
  const targetSet = new Set(columns(target, table));
  const excluded = new Set(exclude);
  return columns(source, table).filter((c) => targetSet.has(c) && !excluded.has(c));
}
function insertRow(target, table, cols, row) {
  if (!cols.length) return 0;
  const sql = `INSERT OR IGNORE INTO ${qid(table)} (${cols.map(qid).join(',')}) VALUES (${cols.map(() => '?').join(',')})`;
  return Number(target.prepare(sql).run(...cols.map((c) => row[c])).changes || 0);
}
function moscowToday() {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Moscow', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date());
  const map = Object.fromEntries(parts.map((p) => [p.type, p.value]));
  return `${map.year}-${map.month}-${map.day}`;
}

if (!existsSync(dbPath)) throw new Error(`Не найден ${dbPath}`);
if (!existsSync(backupDir)) throw new Error(`Не найдена папка ${backupDir}`);
if (!quickCheck(dbPath)) throw new Error('Текущая bot.sqlite не проходит PRAGMA quick_check. Сначала восстановите целую БД.');

const backups = readdirSync(backupDir)
  .filter((name) => /^bot-(?:startup|healthy)-.*\.sqlite$/u.test(name))
  .map((name) => join(backupDir, name))
  .filter((path) => { try { return statSync(path).isFile() && quickCheck(path); } catch { return false; } })
  .sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs);

if (!backups.length) throw new Error('Нет здоровых backup-файлов для merge.');

const target = new DatabaseSync(dbPath);
target.exec('PRAGMA busy_timeout=15000; PRAGMA foreign_keys=ON; PRAGMA wal_checkpoint(FULL);');
const emergencyDir = join(dataDir, `emergency-before-event-merge-${ts()}`);
mkdirSync(emergencyDir, { recursive: true });
const emergencyPath = join(emergencyDir, 'bot.sqlite');
target.exec(`VACUUM INTO ${sqlString(emergencyPath)}`);
if (!quickCheck(emergencyPath)) throw new Error('Не удалось создать проверенный emergency snapshot; merge отменён.');

const today = moscowToday();
const mappings = [
  { source: 'telegram_source_posts', events: 'telegram_events', keys: ['channel', 'message_id'], eventKeys: ['channel', 'message_id', 'event_index'] },
  { source: 'vk_source_posts', events: 'vk_events', keys: ['screen_name', 'post_id'], eventKeys: ['screen_name', 'post_id', 'event_index'] },
  { source: 'vk_chat_source_messages', events: 'vk_chat_events', keys: ['peer_id', 'conversation_message_id'], eventKeys: ['peer_id', 'conversation_message_id', 'event_index'] },
];
const totals = { sourceRows: 0, eventRows: 0, manualRows: 0, backupsRead: 0 };

target.exec('BEGIN IMMEDIATE');
try {
  for (const backupPath of backups) {
    const sourceDb = new DatabaseSync(backupPath, { readOnly: true });
    try {
      totals.backupsRead += 1;
      for (const map of mappings) {
        if (!tableExists(sourceDb, map.source) || !tableExists(sourceDb, map.events) || !tableExists(target, map.source) || !tableExists(target, map.events)) continue;
        const sourceCols = commonColumns(sourceDb, target, map.source);
        const eventCols = commonColumns(sourceDb, target, map.events, { exclude: ['id'] });
        const rows = sourceDb.prepare(`SELECT * FROM ${qid(map.events)} WHERE event_date >= ? AND status IN ('approved','pending') ORDER BY event_date, id`).all(today);
        for (const event of rows) {
          const sourceWhere = map.keys.map((k) => `${qid(k)}=?`).join(' AND ');
          const sourceRow = sourceDb.prepare(`SELECT * FROM ${qid(map.source)} WHERE ${sourceWhere} LIMIT 1`).get(...map.keys.map((k) => event[k]));
          if (sourceRow) totals.sourceRows += insertRow(target, map.source, sourceCols, sourceRow);

          const eventWhere = map.eventKeys.map((k) => `${qid(k)}=?`).join(' AND ');
          const exists = target.prepare(`SELECT 1 FROM ${qid(map.events)} WHERE ${eventWhere} LIMIT 1`).get(...map.eventKeys.map((k) => event[k]));
          if (!exists) totals.eventRows += insertRow(target, map.events, eventCols, event);
        }
      }

      if (tableExists(sourceDb, 'manual_events') && tableExists(target, 'manual_events')) {
        const cols = commonColumns(sourceDb, target, 'manual_events', { exclude: ['id'] });
        const rows = sourceDb.prepare("SELECT * FROM manual_events WHERE event_date >= ? AND status IN ('approved','pending') ORDER BY event_date, id").all(today);
        for (const row of rows) {
          const exists = target.prepare(`
            SELECT 1 FROM manual_events
            WHERE title=? AND event_date=? AND COALESCE(event_time,'')=COALESCE(?, '')
              AND venue=? AND COALESCE(source_url,'')=COALESCE(?, '')
            LIMIT 1
          `).get(row.title, row.event_date, row.event_time, row.venue, row.source_url);
          if (!exists) totals.manualRows += insertRow(target, 'manual_events', cols, row);
        }
      }
    } finally {
      sourceDb.close();
    }
  }
  target.exec('COMMIT');
} catch (error) {
  try { target.exec('ROLLBACK'); } catch {}
  target.close();
  throw error;
}

target.exec('PRAGMA wal_checkpoint(FULL)');
target.close();
if (!quickCheck(dbPath)) throw new Error(`После merge bot.sqlite не проходит quick_check. Emergency snapshot: ${emergencyPath}`);

console.log('EVENT DB MERGE SUCCESS');
console.log(`  healthy backups read: ${totals.backupsRead}`);
console.log(`  restored source rows: ${totals.sourceRows}`);
console.log(`  restored event rows: ${totals.eventRows}`);
console.log(`  restored manual rows: ${totals.manualRows}`);
console.log(`  future cutoff: ${today} Europe/Moscow`);
console.log(`  emergency snapshot: ${emergencyPath}`);
console.log('Теперь запустите бота и выполните:');
console.log('  Гигорейв тусы перепарсить ссылки');
console.log('  Гигорейв тусы проверить');
