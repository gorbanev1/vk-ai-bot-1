import { DatabaseSync } from 'node:sqlite';
const db=new DatabaseSync('data/bot.sqlite',{readOnly:true});
for (const t of ['manual_events','vk_events','vk_chat_events','telegram_events']) {
 try { const cols=db.prepare(`pragma table_info(${t})`).all().map(x=>x.name); console.log('TABLE',t,cols.join(',')); const q=cols.filter(x=>/title|date|time|venue|source|status|dedup|canon|finger|poster|description|participant/i.test(x)); const rows=db.prepare(`select ${q.join(',')} from ${t} where ${q.filter(x=>/source|title|date|venue/i.test(x)).map(x=>`${x} like ?`).join(' or ')}`).all(...q.filter(x=>/source|title|date|venue/i.test(x)).map(()=>'%RammPage%')); console.log(rows); } catch(e) {console.log(t,e.message)}
}
