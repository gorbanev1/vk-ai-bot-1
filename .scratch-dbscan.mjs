import { DatabaseSync } from 'node:sqlite'; import fs from 'node:fs';
const db=new DatabaseSync('data/bot.sqlite',{readOnly:true});
for(const t of ['vk_events','vk_chat_events','telegram_events','manual_events']){const rows=db.prepare(`select status,count(*) c from ${t} group by status`).all(); console.log(t,rows);}
const rows=db.prepare(`select id,screen_name,post_id,event_date,title,venue,participants,status,parse_method,source_segment_text,poster_match_status from vk_events where event_date >= '2026-10-13' order by event_date,id`).all(); console.log('future vk',rows.length); console.log(JSON.stringify(rows,null,2));
const s=JSON.parse(fs.readFileSync('data/event-verified-snapshot.json')); console.log('snapshot statuses',Object.entries(s.items.reduce((a,x)=>(a[x.event.status]=(a[x.event.status]||0)+1,a),{})));
