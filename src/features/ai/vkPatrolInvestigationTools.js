import {DatabaseSync} from 'node:sqlite';
import {resolveMainDatabasePath} from '../../infrastructure/database/runtimePaths.js';
import {PATROL_PEER_ID} from './vkPatrolAdaptive.js';

// A model selects data and filters, never SQL. The actual SQLite connection
// is opened read-only, scoped to the verified Patrol chat where applicable.
const TABLES=Object.freeze([
 'vk_message_archive','vk_chat_source_messages',
 'vk_source_posts','telegram_source_posts',
 'vk_events','telegram_events','vk_chat_events','manual_events',
 'event_dedupe_archive'
]);
const whitelist=new Set(TABLES);
const clamp=(value,min,max)=>Math.max(min,Math.min(max,Math.trunc(Number(value)||min)));
const text=(value,max=1500)=>String(value??'').slice(0,max);
const dbOpen=path=>{
 const db=new DatabaseSync(path,{readOnly:true});
 db.exec('PRAGMA query_only=ON; PRAGMA trusted_schema=OFF;');
 return db;
};
function columns(db,table){
 if(!whitelist.has(table))throw Error('This table is outside the permitted data catalog');
 return db.prepare('PRAGMA table_info("'+table+'")').all().map(x=>String(x.name));
}
function decode(raw){
 try{
  const x=JSON.parse(String(raw||'{}'));
  return x?.object?.message||x||{};
 }catch{return {}}
}
function photosOf(raw,metadata={}){
 const msg=decode(raw);
 const referencePairs=[
  [Number(msg.from_id||0),Number(metadata.senderId||0)],
  [Number(msg.conversation_message_id||0),Number(metadata.cmid||0)],
  [Number(msg.date||0),Number(metadata.date||0)],
  [Number(msg.peer_id||0),PATROL_PEER_ID]
 ];
 if(referencePairs.some(([rawValue,realValue])=>rawValue&&realValue&&rawValue!==realValue))
  return {photos:[],replyToCmid:0,sourceIntegrity:'mismatched-original'};

 const attached=Array.isArray(msg.attachments)?msg.attachments:[];
 const out=[];
 for(const a of attached){
  if(a?.type!=='photo'||!a?.photo)continue;
  const photo=a.photo;
  const sizes=(Array.isArray(photo.sizes)?photo.sizes:[])
   .filter(x=>x.url)
   .sort((a,b)=>Number(b.width||0)*Number(b.height||0)-Number(a.width||0)*Number(a.height||0));
  const url=sizes[0]?.url||photo.orig_photo?.url;
  if(url)out.push({url:text(url,1900),width:Number(sizes[0]?.width||0),
   height:Number(sizes[0]?.height||0),photoId:Number(photo.id||0)});
 }
 return {photos:out.slice(0,7),
  replyToCmid:Number(msg.reply_message?.conversation_message_id||0)};
}
function queryNearby(db,cmid,radius){
 const rows=db.prepare('SELECT conversation_message_id,sender_id,created_at,text,raw_message_json FROM vk_message_archive WHERE peer_id=? AND conversation_message_id BETWEEN ? AND ? ORDER BY conversation_message_id LIMIT 85').all(PATROL_PEER_ID,cmid-radius,cmid+radius);
 return rows.map(row=>{
  const p=photosOf(row.raw_message_json,{senderId:row.sender_id,cmid:row.conversation_message_id,date:row.created_at});
  return {cmid:Number(row.conversation_message_id),senderId:Number(row.sender_id),
   date:Number(row.created_at),text:text(row.text,1300),photos:p.photos,
   replyToCmid:p.replyToCmid};
 });
}
function dbQuery(db,args){
 const table=String(args.table||'');
 const cols=columns(db,table);
 if(!cols.length)throw Error('Table does not exist');
 const fields=Array.isArray(args.fields)?args.fields.slice(0,30):
  cols.filter(x=>x!=='raw_message_json').slice(0,30);
 if(!fields.length||fields.some(x=>!cols.includes(x)))
  throw Error('Requested read-only column is not available');
 const where=[],values=[];
 if(['vk_message_archive','vk_chat_source_messages','vk_chat_events'].includes(table)){
  if(!cols.includes('peer_id'))throw Error('Missing peer_id scope');
  where.push('"peer_id"=?');values.push(PATROL_PEER_ID);
 }
 for(const f of (Array.isArray(args.filters)?args.filters:[]).slice(0,12)){
  const col=String(f?.column||'');
  if(!cols.includes(col))throw Error('Unknown filter field');
  const op=String(f?.op||'eq');
  const allowed={eq:'=',ne:'<>',lt:'<',lte:'<=',gt:'>',gte:'>=',contains:'LIKE'};
  if(!Object.hasOwn(allowed,op))throw Error('Unsupported filter operator');
  where.push('"'+col+'" '+allowed[op]+' ?');
  values.push(op==='contains'?'%'+text(f.value,120)+'%':
   ['string','number'].includes(typeof f.value)?f.value:text(f.value,140));
 }
 const sort=String(args.orderBy||'');
 if(sort&&!cols.includes(sort))throw Error('Unknown sorting column');
 const direction=String(args.direction||'').toUpperCase()==='ASC'?'ASC':'DESC';
 const limit=clamp(args.limit||40,1,100);
 const offset=clamp(args.offset||0,0,100000);
 const sql='SELECT '+fields.map(x=>'"'+x+'"').join(',')+' FROM "'+table+'"'+
  (where.length?' WHERE '+where.join(' AND '):'')+
  (sort?' ORDER BY "'+sort+'" '+direction:'')+' LIMIT ? OFFSET ?';
 const data=db.prepare(sql).all(...values,limit,offset);
 return {table,readOnly:true,offset,limit,count:data.length,
  truncated:data.length===limit,
  rows:data.map(row=>Object.fromEntries(Object.entries(row).map(([k,v])=>
   [k,typeof v==='string'?text(v,k==='raw_message_json'?5000:1800):v])))};
}
export const PATROL_INVESTIGATION_ACTIONS=Object.freeze([
 'db_catalog','db_query','message_context','search_photos'
]);
export function runPatrolInvestigationTool(action,args={},{
 databasePath=resolveMainDatabasePath()
}={}){
 if(!PATROL_INVESTIGATION_ACTIONS.includes(action))
  throw Error('Unknown investigation tool');
 const db=dbOpen(databasePath);
 try{
  if(action==='db_catalog'){
   return {readOnly:true,tables:TABLES.flatMap(name=>{
    const cols=columns(db,name);
    return cols.length?[{name,columns:cols}]:[];
   })};
  }
  if(action==='db_query')return dbQuery(db,args);
  if(action==='message_context'){
   const cmid=Number(args.cmid);
   if(!Number.isSafeInteger(cmid)||cmid<1)throw Error('Valid CMID required');
   const radius=clamp(args.radius||10,1,40);
   const messages=queryNearby(db,cmid,radius);
   return {cmid,radius,found:messages.some(x=>x.cmid===cmid),messages};
  }
  if(action==='search_photos'){
   const senderId=Number(args.senderId||0);
   const limit=clamp(args.limit||20,1,60);
   const conditions=['peer_id=?','raw_message_json LIKE ?'];
   const vals=[PATROL_PEER_ID,'%"type":"photo"%'];
   if(Number.isSafeInteger(senderId)&&senderId!==0){
    conditions.push('sender_id=?');vals.push(senderId);
   }
   const term=text(args.term||'',70).trim();
   if(term){conditions.push('text LIKE ?');vals.push('%'+term+'%')}
   const after=Number(args.afterDate||0);
   if(after>0){conditions.push('created_at>=?');vals.push(after)}
   const before=Number(args.beforeDate||0);
   if(before>0){conditions.push('created_at<=?');vals.push(before)}
   const rows=db.prepare('SELECT conversation_message_id,sender_id,created_at,text,raw_message_json FROM vk_message_archive WHERE '+
    conditions.join(' AND ')+' ORDER BY created_at DESC LIMIT ?').all(...vals,limit);
   return {readOnly:true,count:rows.length,limit,truncated:rows.length===limit,
    photos:rows.flatMap(row=>{
     const p=photosOf(row.raw_message_json,{senderId:row.sender_id,cmid:row.conversation_message_id,date:row.created_at});
     if(!p.photos.length)return [];
     return [{cmid:Number(row.conversation_message_id),
      senderId:Number(row.sender_id),date:Number(row.created_at),
      text:text(row.text,1100),replyToCmid:p.replyToCmid,photos:p.photos,
      nearby:args.includeContext?queryNearby(db,Number(row.conversation_message_id),4)
       .map(x=>({cmid:x.cmid,senderId:x.senderId,text:x.text,
        replyToCmid:x.replyToCmid,photoCount:x.photos.length})):undefined}];
    })};
  }
  throw Error('Unreachable investigation tool');
 }finally{db.close()}
}
