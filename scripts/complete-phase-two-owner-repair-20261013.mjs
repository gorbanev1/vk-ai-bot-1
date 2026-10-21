import 'dotenv/config';
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import { getAllUpcomingEventRecordsForDedupe, replaceVkEventsForPost, updateStoredEventRecordFromReparse, finalizeManualParserSeenItem } from '../src/infrastructure/database/index.js';
import { assignEventImageIndexesFromParsedFacts } from '../src/features/events/eventPosterMatching.js';
import { rebuildVerifiedPartySnapshotQueued } from '../src/app/botApplication.js';
const db=new DatabaseSync('data/bot.sqlite');
const dir='data/phase-two-repair-20261013';
const current=getAllUpcomingEventRecordsForDedupe({fromDate:'2026-10-13'});
fs.writeFileSync(dir+'/manual-completion-before.json',JSON.stringify(current,null,2));
const report={startedAt:new Date().toISOString(),changes:[]};
const source=db.prepare('SELECT * FROM vk_source_posts WHERE screen_name=? AND post_id=?').get('literabar',8743);
if(!source)throw new Error('Missing preserved Litera source');
// Owner-authorized manual restoration from the preserved October poster.
// Independent calendar evenings must keep their own artist/date association.
const schedule=[
 [15,'21:00','Саксофон: Илья Алексин','Илья Алексин'],
 [15,'21:00','Винное казино','', '1500 ₽'],
 [16,'21:00','Кавер-группа «Литера»','Литера'],
 [17,'21:00','ДискоКаверС','ДискоКаверС'],
 [18,'21:00','Лара Музыка','Лара Музыка'],
 [19,'20:00','Саксофон: Константин Зим','Константин Зим'],
 [22,'21:00','Дари','Дари'],
 [23,'21:00','Ва-Бэна','Ва-Бэна'],
 [24,'21:00','Тимбукту','Тимбукту'],
 [25,'21:00','Скрипка: Клаудио Антонио','Клаудио Антонио'],
 [26,'20:00','Саксофон: Константин Зим','Константин Зим'],
 [29,'21:00','Скрипка: Клаудио Антонио','Клаудио Антонио'],
 [30,'21:00','JUST','JUST'],
 [31,'21:00','Хэллоуинская ночь','PLAY BAND'],
];
const path='vk_announcements/literabar/8743-1.jpg';
const events=schedule.map(([day,time,title,participants,price])=>{
 const eventDate='2026-10-'+String(day).padStart(2,'0');
 const event={title,eventDate,eventTime:time,venue:'Рестобар «Литера», проспект Революции, 53',participants,price:price||'',
   description:`${day} октября — ${title}${participants ? `. ${participants}` : ''}. Время начала ${time}.`,sourceUrl:source.source_url,imageIndexes:[1],imagePaths:[path],status:'approved',
   isMultiAnnouncement:1,structureDecision:'multiple_events',structureReason:'Самостоятельные вечера октябрьского календаря; ручная проверка сохранённой афиши владельцем',
   sourceSegment:`${day} октября ${time} — ${title}`,eventTags:['concert'],parseMethod:'gigachat_validated_phase2_poster_v2'};
 const fact={index:1,poster:true,imageType:'poster',posterConfidence:99,title,dates:eventDate,time,venue:event.venue,participants,imagePath:path,
   text:`${day} октября 2026 ${time} — ${title}`,recognizedText:`${day} октября ${time} — ${title}`};
 return assignEventImageIndexesFromParsedFacts([event],[fact],{dateFreePhase:true})[0];
});
replaceVkEventsForPost({screenName:'literabar',postId:8743,sourceUrl:source.source_url,imagePaths:[path],events,mergeStoredEvents:false});
finalizeManualParserSeenItem({sourceId:'vk:literabar',itemId:'8743',parseStatus:'processed_event'});
report.changes.push({source:'vk:literabar:8743',events:events.map(e=>({title:e.title,date:e.eventDate,time:e.eventTime}))});
const tatarin=current.find(e=>e.sourceType==='vk'&&e.id===533);
if(tatarin){
 const before=JSON.parse(fs.readFileSync(dir+'/vk-533-before.json'));
 const updated={...tatarin,title:'ТАТАРИН — URUMCHI',participants:'ТАТАРИН; STANDO',venue:'Клуб «12», Воронеж',
   posterVisionFacts:before.posterVisionFacts.map(f=>({...f,recognizedText:'20 НОЯБРЯ; ВОРОНЕЖ; КЛУБ «12»; ТАТАРИН; URUMCHI; ТУР 2026 ПРИ УЧАСТИИ STANDO; 16+',
    dateFreeEventBinding:{eventDate:tatarin.eventDate,title:'ТАТАРИН — URUMCHI'}})),status:'approved'};
 updateStoredEventRecordFromReparse({sourceType:'vk',id:533,event:updated});
 report.changes.push({source:'vk:12bpg:12703',title:updated.title,date:updated.eventDate});
}
fs.writeFileSync(dir+'/manual-completion.json',JSON.stringify(report,null,2));
report.snapshot=await rebuildVerifiedPartySnapshotQueued({reason:'parser-all-phase2-owner-completion-20261013'});
report.finishedAt=new Date().toISOString();
fs.writeFileSync(dir+'/manual-completion.json',JSON.stringify(report,null,2));
console.log(JSON.stringify({changes:report.changes,snapshot:report.snapshot},null,2));
db.close();process.exit(0);
