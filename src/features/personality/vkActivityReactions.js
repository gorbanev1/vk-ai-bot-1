import {DatabaseSync} from 'node:sqlite';
export const VK_ACTIVITY_REACTIONS_SCHEMA =
 'CREATE TABLE IF NOT EXISTS vk_activity_reaction_snapshots ('+
 ' peer_id INTEGER NOT NULL, conversation_message_id INTEGER NOT NULL,'+
 ' message_created_at INTEGER NOT NULL, counters_json TEXT NOT NULL,'+
 ' observed_at INTEGER NOT NULL, PRIMARY KEY(peer_id,conversation_message_id));'+
 'CREATE INDEX IF NOT EXISTS vk_activity_reaction_snapshots_by_time'+
 ' ON vk_activity_reaction_snapshots(peer_id,message_created_at);';

export function normalizeVkReactionCounters(counters){
 if(!Array.isArray(counters))return [];
 return counters.map(item=>{
  const count=Math.max(0,Math.floor(Number(item?.count)||0));
  const ids=[...new Set((Array.isArray(item?.user_ids)?item.user_ids:[])
    .map(Number).filter(id=>Number.isSafeInteger(id)&&id>0))].slice(0,200);
  return {reaction_id:Number(item?.reaction_id)||0,count,user_ids:ids};
 }).filter(item=>item.count>0);
}

/** A successful empty VK reaction response means zero. API failures do not overwrite previous snapshots. */
export async function refreshVkActivityReactionsForPlan({
 dbPath,plan,clientForPeer,isEnabled=()=>true,logger=console,
 batchSize=90,maxMessagesPerPeer=30000,
}={}){
 if(!dbPath||!plan||typeof clientForPeer!=='function')throw Error('VK_ACTIVITY_REACTION_REFRESH_INVALID_INPUT');
 const db=new DatabaseSync(dbPath);
 const summary={peers:0,checked:0,positive:0,batches:0,actorDetailCalls:0,actorDetailFailures:0,failures:[]};
 try{
  db.exec('PRAGMA busy_timeout=3000;'+VK_ACTIVITY_REACTIONS_SCHEMA);
  const peers=db.prepare(
   'SELECT peer_id FROM('+
   ' SELECT DISTINCT peer_id FROM vk_message_archive WHERE created_at>=? AND created_at<?'+
   ' UNION SELECT DISTINCT peer_id FROM messages WHERE created_at>=? AND created_at<?'+
   ') WHERE peer_id BETWEEN 2000000000 AND 2147483647 ORDER BY peer_id'
  ).all(plan.startAt,plan.snapshotAt,plan.startAt,plan.snapshotAt);
  const scan=db.prepare(
    'SELECT conversation_message_id AS cmid,created_at AS createdAt FROM('+
    ' SELECT conversation_message_id,created_at FROM vk_message_archive'+
    ' WHERE peer_id=? AND source_peer_id=peer_id AND created_at>=? AND created_at<?'+
    " AND (action_type IS NULL OR action_type='')"+
    ' UNION SELECT m.conversation_message_id,m.created_at FROM messages m'+
    ' WHERE m.peer_id=? AND m.created_at>=? AND m.created_at<?'+
    ' AND NOT EXISTS(SELECT 1 FROM vk_message_archive a'+
    ' WHERE a.peer_id=m.peer_id AND a.conversation_message_id=m.conversation_message_id)'+
    ') WHERE cmid>0 ORDER BY createdAt DESC,cmid DESC'
  );
  const upsert=db.prepare(
   'INSERT INTO vk_activity_reaction_snapshots'+
   ' (peer_id,conversation_message_id,message_created_at,counters_json,observed_at)'+
   ' VALUES(?,?,?,?,?) ON CONFLICT(peer_id,conversation_message_id) DO UPDATE SET'+
   ' message_created_at=excluded.message_created_at,'+
   ' counters_json=excluded.counters_json,observed_at=excluded.observed_at'+
   ' WHERE excluded.observed_at>=vk_activity_reaction_snapshots.observed_at'
  );
  const endpoint=db.prepare('SELECT endpoint_key FROM auto_summary_settings WHERE peer_id=?');
  for(const {peer_id:peer}of peers){
   if(!isEnabled(peer))continue;
   const client=clientForPeer(peer,endpoint.get(peer)?.endpoint_key||'vk:primary');
   if(!client?.api?.messages?.getMessagesReactions)continue;
   const all=scan.all(peer,plan.startAt,plan.snapshotAt,peer,plan.startAt,plan.snapshotAt);
   if(!all.length)continue;
   summary.peers++;
   if(all.length>maxMessagesPerPeer){
    summary.failures.push({peer,error:'message-limit',count:all.length});
    logger.warn?.('[VK ACTIVITY REACTIONS PARTIAL]','peer='+peer,'messages='+all.length,'cap='+maxMessagesPerPeer);
   }
   const messages=all.slice(0,maxMessagesPerPeer);
   for(let offset=0;offset<messages.length;offset+=Math.min(90,Math.max(1,batchSize))){
    const batch=messages.slice(offset,offset+Math.min(90,Math.max(1,batchSize)));
    let result;
    try{
     result=await client.api.messages.getMessagesReactions({
      peer_id:peer,cmids:batch.map(x=>x.cmid).join(',')
     });
     if(!result||!Array.isArray(result.items))throw Error('VK reaction API did not return items');
    }catch(error){
     summary.failures.push({peer,error:String(error?.message||error).slice(0,140)});
     logger.warn?.('[VK ACTIVITY REACTIONS FETCH FAILED]','peer='+peer,'offset='+offset,
       'error='+String(error?.message||error).slice(0,170));
     break;
    }
    const found=new Map();
    const accepted=new Set(batch.map(item=>item.cmid));
    for(const row of result.items){
     const cmid=Number(row?.cmid??row?.conversation_message_id);
     if(!accepted.has(cmid))continue;
     const counters=normalizeVkReactionCounters(row.counters||row.reactions);
     // Bulk VK responses occasionally hide the actor IDs but not the totals.
     // Fetch precise actors only for these incomplete CMIDs.
     if(counters.some(c=>c.count>c.user_ids.length)&&typeof client.api.messages.getReactedPeers==='function'){
      summary.actorDetailCalls++;
      try{
       const detail=await client.api.messages.getReactedPeers({peer_id:peer,cmid});
       if(Array.isArray(detail?.reactions)){
        const byReaction=new Map();
        for(const actor of detail.reactions){
         const id=Number(actor?.user_id??actor?.userId);
         const reaction=Number(actor?.reaction_id??actor?.reactionId);
         if(!Number.isSafeInteger(id)||id<=0||!Number.isSafeInteger(reaction))continue;
         const set=byReaction.get(reaction)||new Set();set.add(id);byReaction.set(reaction,set);
        }
        for(const counter of counters){
         if(counter.user_ids.length>=counter.count)continue;
         counter.user_ids=[...new Set([...counter.user_ids,...(byReaction.get(counter.reaction_id)||[])])].slice(0,200);
        }
       }
      }catch(error){
       summary.actorDetailFailures++;
       logger.warn?.('[VK REACTION ACTORS UNAVAILABLE]','peer='+peer,'cmid='+cmid,
        'error='+String(error?.message||error).slice(0,140));
      }
     }
     found.set(cmid,counters);
    }
    const stamp=Math.floor(Date.now()/1000);
    db.exec('BEGIN IMMEDIATE');
    try{
     for(const item of batch){
      const counters=found.get(item.cmid)||[];
      upsert.run(peer,item.cmid,item.createdAt,JSON.stringify(counters),stamp);
      if(counters.some(c=>c.count>0))summary.positive++;
     }
     db.exec('COMMIT');
    }catch(error){db.exec('ROLLBACK');throw error}
    summary.checked+=batch.length;summary.batches++;
   }
  }
  logger.info?.('[VK ACTIVITY REACTIONS SNAPSHOT]',
    'peers='+summary.peers,'checked='+summary.checked,
    'positive='+summary.positive,'batches='+summary.batches,'actorDetails='+summary.actorDetailCalls,'detailFailures='+summary.actorDetailFailures,'failures='+summary.failures.length);
  return summary;
 }finally{db.close()}
}
