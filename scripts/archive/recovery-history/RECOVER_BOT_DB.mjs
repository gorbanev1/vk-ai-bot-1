import { DatabaseSync } from 'node:sqlite';
import {
  copyFileSync, existsSync, mkdirSync, readdirSync, rmSync, statSync,
} from 'node:fs';
import { basename, join, resolve } from 'node:path';

const root = resolve(process.argv[2] || process.cwd());
const dataDir = join(root, 'data');
const dbPath = join(dataDir, 'bot.sqlite');
const backupDir = join(dataDir, 'healthy-backups');

function stamp() {
  return new Date().toISOString().replaceAll(':', '-').replaceAll('.', '-');
}

function tableExists(db, table) {
  return Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=? LIMIT 1").get(table));
}

function countRows(db, table) {
  if (!tableExists(db, table)) return 0;
  try { return Number(db.prepare(`SELECT COUNT(*) AS n FROM \"${table.replaceAll('"', '""')}\"`).get()?.n || 0); }
  catch { return 0; }
}

function inspect(file) {
  const result = {
    file,
    name: basename(file),
    mtimeMs: statSync(file).mtimeMs,
    size: statSync(file).size,
    ok: false,
    archive: 0,
    membership: 0,
    messages: 0,
    totalUseful: 0,
    error: '',
  };
  let db;
  try {
    db = new DatabaseSync(file, { readOnly: true });
    const quick = db.prepare('PRAGMA quick_check').all();
    const quickText = quick.flatMap((row) => Object.values(row)).map(String);
    result.ok = quickText.length === 1 && quickText[0].trim().toLowerCase() === 'ok';
    if (!result.ok) {
      result.error = quickText.join('; ') || 'quick_check failed';
      return result;
    }
    result.archive = countRows(db, 'vk_message_archive');
    result.membership = countRows(db, 'chat_membership_events');
    result.messages = countRows(db, 'messages');
    result.totalUseful = result.archive + result.membership + result.messages;
    return result;
  } catch (e) {
    result.error = String(e?.message || e);
    return result;
  } finally {
    try { db?.close(); } catch {}
  }
}

function compare(a, b) {
  // Prefer the database with the most actual VK archive first. This prevents
  // a freshly-created but empty post-overwrite backup from winning by mtime.
  if (a.archive !== b.archive) return b.archive - a.archive;
  if (a.membership !== b.membership) return b.membership - a.membership;
  if (a.messages !== b.messages) return b.messages - a.messages;
  return b.mtimeMs - a.mtimeMs;
}

if (!existsSync(dataDir)) {
  console.error(`ERROR: data directory not found: ${dataDir}`);
  process.exit(2);
}
if (!existsSync(backupDir)) {
  console.error(`ERROR: healthy-backups directory not found: ${backupDir}`);
  process.exit(3);
}

const current = existsSync(dbPath) ? inspect(dbPath) : null;
const candidates = readdirSync(backupDir)
  .filter((name) => /^bot-(?:startup|healthy)-.*\.sqlite$/u.test(name))
  .map((name) => inspect(join(backupDir, name)))
  .filter((x) => x.ok)
  .sort(compare);

console.log('\nCurrent bot.sqlite:');
if (current) {
  console.log(`  ok=${current.ok} archive=${current.archive} membership=${current.membership} messages=${current.messages} size=${current.size} file=${current.file}`);
} else {
  console.log('  MISSING');
}

console.log('\nHealthy backup candidates (best first):');
for (const [i, x] of candidates.entries()) {
  console.log(`  ${i + 1}. archive=${x.archive} membership=${x.membership} messages=${x.messages} mtime=${new Date(x.mtimeMs).toISOString()} size=${x.size} ${x.name}`);
}

if (!candidates.length) {
  console.error('\nERROR: no healthy startup backups found. Nothing was changed.');
  process.exit(4);
}

const best = candidates[0];
if (current?.ok && compare(current, best) <= 0) {
  // compare(current,best)<=0 means current is at least as complete by our ordering.
  console.log('\nSTOP: current bot.sqlite is already at least as complete as the best backup. Nothing was changed.');
  process.exit(0);
}

const emergencyDir = join(dataDir, `emergency-before-db-restore-${stamp()}`);
mkdirSync(emergencyDir, { recursive: true });
for (const name of ['bot.sqlite', 'bot.sqlite-wal', 'bot.sqlite-shm', 'live-message-journal.jsonl', 'vk-message-archive-journal.jsonl']) {
  const src = join(dataDir, name);
  if (existsSync(src)) copyFileSync(src, join(emergencyDir, name));
}

const tempPath = join(dataDir, `bot.sqlite.restore-${Date.now()}.tmp`);
copyFileSync(best.file, tempPath);
const tempCheck = inspect(tempPath);
if (!tempCheck.ok) {
  rmSync(tempPath, { force: true });
  console.error(`\nERROR: copied backup failed quick_check: ${tempCheck.error}. Original current DB is preserved in ${emergencyDir}`);
  process.exit(5);
}

// WAL/SHM belong to the overwritten database and must never be replayed into
// the restored main file.
rmSync(join(dataDir, 'bot.sqlite-wal'), { force: true });
rmSync(join(dataDir, 'bot.sqlite-shm'), { force: true });
copyFileSync(tempPath, dbPath);
rmSync(tempPath, { force: true });

const restored = inspect(dbPath);
if (!restored.ok) {
  console.error(`\nERROR: restored bot.sqlite is not healthy: ${restored.error}`);
  console.error(`Emergency copy of the pre-restore state: ${emergencyDir}`);
  process.exit(6);
}

console.log('\nRESTORED SUCCESSFULLY');
console.log(`  source: ${best.file}`);
console.log(`  bot.sqlite: archive=${restored.archive} membership=${restored.membership} messages=${restored.messages}`);
console.log(`  pre-restore state preserved at: ${emergencyDir}`);
console.log('\nDo NOT delete healthy-backups or the emergency directory yet. You may now start the bot and then use the history catch-up command for the missing recent window.');
