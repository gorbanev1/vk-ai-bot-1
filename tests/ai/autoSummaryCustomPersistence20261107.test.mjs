import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {createAutoSummaryStateStore,ensureAutoSummaryCustomModeSchema} from '../../src/infrastructure/database/autoSummaryStateStore.js';
import {parseAutoSummaryCommand,getNextAutoSummaryRunAt} from '../../src/features/ai/autoSummaryRouting.js';
const dir=t=>{const p=mkdtempSync(join(tmpdir(),'autosummary-custom-'));t.after(()=>rmSync(p,{recursive:true,force:true}));return p};
function oldSchema(db,hasSchedule){
 db.exec("CREATE TABLE auto_summary_settings (peer_id INTEGER PRIMARY KEY,platform TEXT NOT NULL DEFAULT 'vk',endpoint_key TEXT NOT NULL DEFAULT 'vk:primary',external_peer_id TEXT NOT NULL DEFAULT '',mode TEXT NOT NULL DEFAULT 'full' CHECK (mode IN ('full','day','evening')), enabled INTEGER NOT NULL DEFAULT 0 CHECK (enabled IN (0,1)),next_run_at INTEGER NOT NULL DEFAULT 0,updated_by INTEGER NOT NULL DEFAULT 0,updated_at INTEGER NOT NULL);CREATE INDEX auto_summary_settings_due_idx ON auto_summary_settings(enabled,next_run_at);");
 if(hasSchedule)db.exec("ALTER TABLE auto_summary_settings ADD COLUMN schedule_json TEXT NOT NULL DEFAULT '[]'");
 const put=db.prepare('INSERT INTO auto_summary_settings(peer_id,platform,endpoint_key,external_peer_id,mode,enabled,next_run_at,updated_by,updated_at) VALUES (?,?,?,?,?,?,?,?,?)');
 put.run(2000000008,'vk','vk:primary','2000000008','full',1,1800000000,1,1770000000);
 put.run(2000000009,'vk','vk:primary','2000000009','day',0,0,1,1770000001);
}
test('screenshot: four time slots with trailing on flag are parsed as custom',()=>{
 const a=parseAutoSummaryCommand('Гигорейв авторезюме 9:00 17:00 21:00 23:59 вкл');
 assert.equal(a.mode,'custom');assert.deepEqual(a.schedule,['09:00','17:00','21:00','23:59']);
 assert.equal(getNextAutoSummaryRunAt({mode:a.mode,schedule:a.schedule,afterTimestamp:Date.parse('2026-11-07T10:00:00Z')/1000,timeZone:'Europe/Moscow'}),Date.parse('2026-11-07T14:00:00Z')/1000);
});
test('old durable DB migrates with all other settings intact, and custom survives restart',t=>{
 const path=join(dir(t),'auto-summary.sqlite');const db=new DatabaseSync(path);oldSchema(db,true);db.close();
 const store=createAutoSummaryStateStore({databasePath:path});
 const a=parseAutoSummaryCommand('Гигорейв авторезюме 9:00 17:00 21:00 23:59 вкл');
 store.saveSettings({peerId:2000000008,mode:a.mode,schedule:a.schedule,platform:'vk',externalPeerId:'2000000008',enabled:true,nextRunAt:1800000010,updatedAt:1770000099});store.close();
 const fresh=createAutoSummaryStateStore({databasePath:path});
 assert.equal(fresh.getSettings(2000000008).mode,'custom');
 assert.deepEqual(fresh.getSettings(2000000008).schedule,['09:00','17:00','21:00','23:59']);
 assert.equal(fresh.getSettings(2000000009).mode,'day');
 assert.equal(fresh.getSettings(2000000009).enabled,false);fresh.close();
});
test('old legacy schema migrates transactionally and idempotently',t=>{
 const db=new DatabaseSync(join(dir(t),'legacy.sqlite'));oldSchema(db,false);
 assert.equal(ensureAutoSummaryCustomModeSchema(db),true);assert.equal(ensureAutoSummaryCustomModeSchema(db),false);
 assert.equal(db.prepare('select count(*) n from auto_summary_settings').get().n,2);
 db.prepare("UPDATE auto_summary_settings SET mode='custom',schedule_json=? WHERE peer_id=2000000008").run(JSON.stringify(['09:00','17:00','21:00','23:59']));
 assert.equal(db.prepare('select mode from auto_summary_settings where peer_id=2000000008').get().mode,'custom');
 assert.ok(db.prepare("SELECT name FROM sqlite_master WHERE name='auto_summary_settings_due_idx'").get());db.close();
});
test('legacy mirror stores the custom schedule and migrates before preparing statements',()=>{
 const text=readFileSync(new URL('../../src/infrastructure/database/index.js',import.meta.url),'utf8');
 assert.ok(text.indexOf('ensureAutoSummaryCustomModeSchema(database);')<text.indexOf('const upsertAutoSummarySettingsStatement'));
 assert.match(text,/schedule_json = excluded.schedule_json/u);
 assert.match(text,/JSON.stringify\(Array.isArray\(schedule\) \? schedule : \[\]\)/u);
});
