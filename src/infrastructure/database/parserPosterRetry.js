import { statSync } from 'node:fs';
import { resolve } from 'node:path';

export const MISSING_POSTER_RETRY = 'MISSING_USABLE_POSTER';
const SOURCES = {
 vk: ['vk_events', 'vk_source_posts', 'screen_name', 'post_id', 'screenName', 'postId'],
 tg: ['telegram_events', 'telegram_source_posts', 'channel', 'message_id', 'channel', 'messageId'],
 chat: ['vk_chat_events', 'vk_chat_source_messages', 'peer_id', 'conversation_message_id', 'peerId', 'conversationMessageId'],
};
const array = value => { try { const a=JSON.parse(value||'[]'); return Array.isArray(a)?a:[]; } catch { return []; } };
function descriptor(sourceId) {
 const pos=String(sourceId).indexOf(':');
 const schema=SOURCES[String(sourceId).slice(0,pos)];
 return schema ? { schema, key:String(sourceId).slice(pos+1) } : null;
}
export function createParserPosterRetryStore(database, dataDirectory, today) {
 const usable = path => {
  if (!path || /event_message_cards|event_generated_fallbacks|-event-\d+\.png$/iu.test(path)) return false;
  try { const s=statSync(resolve(dataDirectory,path)); return s.isFile()&&s.size>=10; } catch { return false; }
 };
 const missing = (sourceId,itemId) => {
  const d=descriptor(sourceId); if(!d)return false;
  const [table,,key,id]=d.schema;
  return database.prepare(`SELECT image_paths_json FROM ${table} WHERE ${key}=? AND ${id}=? AND status IN ('approved','pending') AND COALESCE(NULLIF(event_end_date,''),event_date)>=?`)
   .all(d.key,itemId,today()).some(row=>!array(row.image_paths_json).some(usable));
 };
 return {
  missing,
  reopen(candidates) {
   let changed=0;
   for(const row of candidates) {
    database.prepare("INSERT OR IGNORE INTO manual_parser_seen_items(source_id,item_id,source_url,raw_text,attachments_json,parse_status,last_error) VALUES (?,?,?,?,?,'failed_retryable',?)")
      .run(row.sourceId,String(row.itemId),row.sourceUrl||'',row.item?.text||'',JSON.stringify(row.item?.imageUrls||[]),MISSING_POSTER_RETRY);
    // Do not interrupt a worker that currently owns this item.
    changed+=Number(database.prepare(`UPDATE manual_parser_seen_items SET parse_status='failed_retryable',processed_at=0,last_error=?
     WHERE source_id=? AND item_id=? AND parse_status<>'processing' AND (parse_status<>'failed_retryable' OR last_error<>?)`)
     .run(MISSING_POSTER_RETRY,row.sourceId,String(row.itemId),MISSING_POSTER_RETRY).changes||0);
   }
   return changed;
  },
  settleRestored(candidates) {
   let changed=0;
   for (const row of candidates) {
    if (missing(row.sourceId,String(row.itemId))) continue;
    changed+=Number(database.prepare("UPDATE manual_parser_seen_items SET parse_status='processed_event',processed_at=?,last_error='' WHERE source_id=? AND item_id=? AND parse_status='failed_retryable' AND last_error=?")
     .run(Math.floor(Date.now()/1000),row.sourceId,String(row.itemId),MISSING_POSTER_RETRY).changes||0);
   }
   return changed;
  },
  pending(sourceId) {
   const d=descriptor(sourceId); if(!d)return [];
   const [events,sources,key,id,keyProp,idProp]=d.schema;
   const rows=database.prepare(`SELECT s.* FROM ${sources} s JOIN manual_parser_seen_items l ON l.source_id=? AND l.item_id=CAST(s.${id} AS TEXT)
    WHERE s.${key}=? AND l.last_error LIKE ? AND l.parse_status<>'processing'
    AND EXISTS (SELECT 1 FROM ${events} e WHERE e.${key}=s.${key} AND e.${id}=s.${id}
      AND e.status IN ('approved','pending') AND COALESCE(NULLIF(e.event_end_date,''),e.event_date)>=?)`)
    .all(sourceId,d.key,'%'+MISSING_POSTER_RETRY+'%',today());
   return rows.map(row=>{
    const media=array(row.image_media_json);
    const urls=array(row.image_urls_json);
    return { [keyProp]:row[key], [idProp]:row[id],ownerId:row.owner_id,
     sourceUrl:row.source_url,text:row.raw_text,publishedAt:row.published_at||row.created_at||0,
     createdAt:row.created_at||row.published_at||0,
     imageUrls:urls.length?urls:media.map(x=>x.url).filter(Boolean),imageMedia:media,
     __posterRepairNeeded:true };
   });
  },
 };
}
export function mergePosterRepairItems(captured, pending, idField) {
 const result=new Map(pending.map(item=>[String(item[idField]),item]));
 for(const item of captured) {
  const previous=result.get(String(item[idField]));
  result.set(String(item[idField]),previous ? { ...previous,...item,
   imageUrls:item.imageUrls?.length?item.imageUrls:previous.imageUrls,
   imageMedia:item.imageMedia?.length?item.imageMedia:previous.imageMedia,__posterRepairNeeded:true } : item);
 }
 return [...result.values()];
}
