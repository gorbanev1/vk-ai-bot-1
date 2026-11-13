import {parentPort,workerData} from 'node:worker_threads';
import {DatabaseSync} from 'node:sqlite';
import {randomInt} from 'node:crypto';
export function isBotSelfTarget(value) {
 const s=String(value||'').toLowerCase().replace(/ё/g,'е').replace(/[.!?,]/g,'').replace(/\s+/g,' ').trim();
 return /^(?:сам(?:ого|ому)?\s+(?:до\s+|на\s+|о\s+)?себ[яе]|(?:до\s+|на\s+|о\s+)?(?:самого\s+|самом\s+)?себ[яе]|тебя|тебе|о тебе|на тебя|на самого себя|гиго\s?рейв(?:а|е)?|gigorave|бота|боте)$/.test(s);
}
export function evidenceKind(text) {
 const s=String(text||'').trim();
 if(/^(?:«[^\n]+»\n)?[^\n]*\n(?:Гигорейв чтиво[^\n]*\n)?Часть \d+/iu.test(s)||/^(?:🎓|Хуинглиш|Все будущие тусы|Афиша QTickets|⚠️)/iu.test(s))return 'service';
 if(/^(?:[^\n]{0,90}\n)?(?:.*досье|.*авторезюме|.*резюме (?:чата|беседы)|.*дневной .*слой|.*недельный .*слой|.*рабочая неделя|.*сообщений учтено)/iu.test(s.slice(0,250)))return 'artifact';
 // Long unlabelled generated reports must not bypass the ten-report cap.
 if(s.length>1200)return 'artifact';
 return 'ordinary';
}
function reservoir(list,value,seen,cap) {
 if(list.length<cap)list.push(value);
 else {const n=randomInt(seen);if(n<cap)list[n]=value;}
}
export function collectSelfEvidence(db,{peerId,botId}) {
 const ordinary=[],artifacts=[],mentions=[],before=[],pending=[];
 const counts={ordinary:0,artifacts:0,mentions:0};
 const hasArchive=!!db.prepare("SELECT name FROM sqlite_master WHERE name='vk_message_archive'").get();
 const query=hasArchive
  ?'SELECT conversation_message_id id,sender_id,text,created_at,raw_message_json raw,is_outbox FROM vk_message_archive WHERE peer_id=? ORDER BY conversation_message_id'
  :"SELECT conversation_message_id id,sender_id,text,created_at,'' raw,0 is_outbox FROM messages WHERE peer_id=? ORDER BY conversation_message_id";
 for(const row of db.prepare(query).iterate(Number(peerId))) {
  const text=String(row.text||'').trim();if(!text)continue;
  let raw={};try{raw=JSON.parse(row.raw||'{}');}catch{}
  const item={id:row.id,senderId:row.sender_id,at:row.created_at,text:text.slice(0,1600),reactions:raw.reactions||raw.message?.reactions||null};
  for(const p of pending)p.after.push({...item,text:text.slice(0,260)});
  for(let i=pending.length-1;i>=0;i--)if(pending[i].after.length>=2)pending.splice(i,1);
  const own=Number(row.sender_id)===Number(botId)||(row.is_outbox===1&&!row.sender_id);
  if(own) {
   const kind=evidenceKind(text);
   if(kind==='ordinary')reservoir(ordinary,item,++counts.ordinary,400);
   else if(kind==='artifact')reservoir(artifacts,item,++counts.artifacts,10);
  } else {
   const reply=raw.reply_message||raw.message?.reply_message;
   const direct=/(?:гиго\s?рейв|gigorave)/iu.test(text)||text.includes('[club'+Math.abs(botId)+'|')||Number(reply?.from_id)===Number(botId);
   if(direct||/(?<![\p{L}])бот(?:а|у|ом|е|ы|ов)?(?![\p{L}])/iu.test(text)) {
    const candidate={...item,direct,before:before.slice(),after:[],...(reply?{reply:{senderId:reply.from_id,text:String(reply.text||'').slice(0,400)}}:{})};
    reservoir(mentions,candidate,++counts.mentions,80);pending.push(candidate);
   }
  }
  before.push({...item,text:text.slice(0,260)});if(before.length>2)before.shift();
 }
 return {peerId,botId,ordinary,artifacts,mentions,counts};
}
if(parentPort && workerData?.kind==='bot-self-evidence') {
 let db;
 try{db=new DatabaseSync(workerData.databasePath,{readOnly:true});parentPort.postMessage({ok:true,evidence:collectSelfEvidence(db,workerData)});}
 catch(error){parentPort.postMessage({ok:false,error:error.message});}
 finally{db?.close();}
}
