import {DatabaseSync} from 'node:sqlite';
import {readFileSync,writeFileSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
const mode=process.argv[2]||'before';
for(const file of ['src/features/chtivo/chtivo.js','src/features/chtivo/chtivoReplyTarget.js','src/features/chtivo/chtivoVkTransport.js','src/app/botApplication.js']) {
 const check=spawnSync(process.execPath,['--check',file],{windowsHide:true,encoding:'utf8'});
 if(check.status!==0)throw Error(file+' '+check.stderr);
}
const db=new DatabaseSync('data/bot.sqlite',{readOnly:true});
const snapshot={progress:db.prepare('SELECT * FROM chtivo_progress ORDER BY peer_id,book_id').all(),schedule:db.prepare('SELECT * FROM chtivo_schedule ORDER BY peer_id').all(),english:db.prepare('SELECT platform,peer_id,scheduled_lesson,scheduled_at,scheduled_kind FROM huinglish_subscriptions ORDER BY platform,peer_id').all()};
db.close();
const path='backup/chtivo-replies-20261031/state-before.json';
if(mode==='before')writeFileSync(path,JSON.stringify(snapshot,null,2),{flag:'wx'});
else if(JSON.stringify(snapshot)!==JSON.stringify(JSON.parse(readFileSync(path,'utf8'))))throw Error('Reading state changed; inspect before concluding');
console.log(JSON.stringify({syntax:'ok',state:mode==='before'?'saved':'unchanged',readers:snapshot.progress.filter(p=>p.active).length,schedules:snapshot.schedule.length,english:snapshot.english}));
