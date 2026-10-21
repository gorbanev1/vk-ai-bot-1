import { DatabaseSync } from 'node:sqlite';
import { readdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
const db = new DatabaseSync('data/bot.sqlite', { readOnly: true });
const candidates = new Map();
const traces = [];
for (const run of readdirSync('data/parser-forensic-archives').sort()) {
 const path = 'data/parser-forensic-archives/'+run+'/trace.jsonl';
 if (!existsSync(path)) continue;
 for (const line of readFileSync(path,'utf8').split('\n')) {
  let row; try {row=JSON.parse(line);} catch {continue;}
  const d=row.data || {}; const key=d.sourceId+'|'+(d.itemId ?? d.postId ?? d.messageId ?? '');
  if (!d.sourceId) continue;
  if (['item.ai.media.audit','item.ai.text-extraction.response','item.ai.text.selection','item.ai.database.write','item.prefilter','item.ai.vision.response'].includes(row.stage)) traces.push({run,stage:row.stage,data:d,key,seq:row.seq});
  if(row.stage==='item.ai.media.audit') for(const m of d.media||[]) {
   if(m.vision?.poster===true && m.finalVerdict==='poster-not-matched-to-event') candidates.set(key,{key,sourceId:d.sourceId,itemId:String(d.itemId),run});
  }
 }
}
const eventTables=['vk_events','vk_chat_events','telegram_events','manual_events'];
const allEvents=eventTables.flatMap(table=>{try{return db.prepare('SELECT * FROM '+table).all().map(e=>({...e,table}));}catch{return [];}});
for(const c of candidates.values()) {
 const rows=traces.filter(r=>r.key===c.key);
 c.responses=rows.filter(r=>r.stage==='item.ai.text-extraction.response');
 c.audits=rows.filter(r=>r.stage==='item.ai.media.audit');
 c.lastWrite=rows.filter(r=>r.stage==='item.ai.database.write').at(-1);
 c.lastSelection=rows.filter(r=>r.stage==='item.ai.text.selection').at(-1);
 c.prefilter=rows.filter(r=>r.stage==='item.prefilter').at(-1);
 const [type,name]=c.sourceId.split(':');
 c.existing=allEvents.filter(e=>type==='vk'?e.table==='vk_events'&&e.screen_name===name&&String(e.post_id)===c.itemId:type==='chat'?e.table==='vk_chat_events'&&String(e.peer_id)===name&&String(e.conversation_message_id)===c.itemId:e.table==='telegram_events'&&e.channel===name&&String(e.message_id)===c.itemId);
 try {c.source=type==='vk'?db.prepare('SELECT * FROM vk_source_posts WHERE screen_name=? AND post_id=?').all(name,Number(c.itemId)):type==='chat'?db.prepare('SELECT * FROM vk_chat_source_messages WHERE peer_id=? AND conversation_message_id=?').all(Number(name),Number(c.itemId)):db.prepare('SELECT * FROM telegram_source_posts WHERE channel=? AND message_id=?').all(name,Number(c.itemId));}catch(e){c.sourceError=e.message;}
}
writeFileSync('.scratch-poster-recovery-audit.json',JSON.stringify({candidates:[...candidates.values()],events:allEvents,blocks:db.prepare('SELECT * FROM event_permanent_blocks WHERE active=1').all()},null,2));
console.log(JSON.stringify({candidates:candidates.size,tables:eventTables.map(t=>({table:t,columns:db.prepare('PRAGMA table_info('+t+')').all().map(x=>x.name)})),rows:[...candidates.values()].map(c=>({key:c.key,existing:c.existing.map(e=>({id:e.id,date:e.event_date,title:e.title,status:e.status})),events:c.responses.at(-1)?.data.parsedEvents,write:c.lastWrite?.data.effectiveEventCount,source:c.source?.map(s=>({url:s.source_url,status:s.parse_status,text:String(s.raw_text||s.text||'').slice(0,120)}))}))},null,2));
