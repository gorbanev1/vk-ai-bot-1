import fs from 'node:fs';
const a=JSON.parse(fs.readFileSync('.scratch-poster-recovery-audit.json'));
for(const c of a.candidates){ const ev=c.responses?.at(-1)?.data?.parsedEvents||[]; const ex=c.existing||[]; if(ev.length && (!ex.length || ex.every(e=>e.status==='pending'))){ console.log(JSON.stringify({key:c.key, ev:ev.map(x=>({date:x.date,title:x.title,venue:x.venue,participants:x.participants,image_indexes:x.image_indexes})), ex:ex.map(x=>({id:x.id,date:x.event_date,title:x.title,status:x.status})), src:c.source?.[0]?.source_url},null,2)); }}
