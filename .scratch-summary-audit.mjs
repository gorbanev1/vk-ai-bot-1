import { DatabaseSync } from 'node:sqlite';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
const stateDb = join(process.env.LOCALAPPDATA || '', 'Gigorave', 'state', 'auto-summary.sqlite');
const mainDb = 'data/bot.sqlite';
const out = { stateDb, exists: existsSync(stateDb), now: new Date().toISOString() };
if (out.exists) {
  const d = new DatabaseSync(stateDb, { readOnly: true });
  out.schema = d.prepare("SELECT name,sql FROM sqlite_master WHERE type='table'").all();
  for (const table of ['auto_summary_settings','auto_summary_runs','auto_summary_health','auto_summary_state_meta']) {
    try { out[table] = d.prepare('SELECT * FROM ' + table).all(); } catch (e) { out[table+'Error'] = e.message; }
  }
  d.close();
}
const d = new DatabaseSync(mainDb, { readOnly: true });
for (const table of ['auto_summary_settings','auto_summary_runs','auto_summary_health','auto_summary_state_meta']) {
  try { out['legacy_'+table] = d.prepare('SELECT * FROM ' + table).all(); } catch (e) { out['legacy_'+table+'Error'] = e.message; }
}
out.chatTables = d.prepare("SELECT name FROM sqlite_master WHERE type='table' AND (name LIKE '%message%' OR name LIKE '%chat%')").all();
out.userVersion = d.prepare('PRAGMA user_version').get();
console.log(JSON.stringify(out, null, 2));
d.close();
