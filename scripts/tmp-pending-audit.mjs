import { DatabaseSync } from 'node:sqlite';
const db = new DatabaseSync('data/bot.sqlite', { readOnly: true });
const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name LIKE '%event%' ORDER BY name").all();
console.log('TABLES', tables);
for (const name of ['vk_events','vk_source_posts','vk_chat_source_messages','manual_parser_seen_items']) {
  try { console.log(name, db.prepare(`PRAGMA table_info(${name})`).all().map((x) => x.name)); } catch (error) { console.log(name, 'ERR', error.message); }
}
const ids = [['idmamaanarchy','5'],['liverpool_pub_vrn','2732'],['deadway36','8355'],['rb_diesel','13875'],['rb_diesel','13876'],['vavilone_rb','187'],['vavilone_rb','26'],['vavilone_rb','4634'],['idmamaanarchy','1298']];
for (const [screen, post] of ids) {
  const source = db.prepare('SELECT * FROM vk_source_posts WHERE screen_name = ? AND post_id = ?').all(screen, Number(post));
  const events = db.prepare('SELECT * FROM vk_events WHERE screen_name = ? AND post_id = ? ORDER BY id').all(screen, Number(post));
  const ledger = db.prepare('SELECT * FROM manual_parser_seen_items WHERE source_id = ? AND item_id = ?').all(`vk:${screen}`, post);
  console.log(JSON.stringify({key:`vk:${screen}|${post}`, source:source.map((x)=>({id:x.id,parseStatus:x.parse_status,ownerId:x.owner_id,eventCount:x.event_count,eventDate:x.event_date,sourceUrl:x.source_url,rawText:String(x.raw_text||'').slice(0,120)})), events:events.map((x)=>({id:x.id,eventDate:x.event_date,title:x.title,sourceUrl:x.source_url})), ledger:ledger.map((x)=>({parseStatus:x.parse_status,error:x.error,contentHash:x.content_hash}))}));
}
for (const [peer, cmid] of [['2000000014','70882'],['2000000014','70876']]) {
  let rows = []; try { rows = db.prepare('SELECT * FROM vk_chat_source_messages WHERE peer_id = ? AND conversation_message_id = ?').all(Number(peer), Number(cmid)); } catch {}
  console.log(JSON.stringify({key:`chat:${peer}|${cmid}`, rows:rows.map((x)=>({id:x.id,parseStatus:x.parse_status,eventCount:x.event_count,error:x.error,sourceUrl:x.source_url,text:String(x.text||'').slice(0,120)}))}));
}
db.close();
