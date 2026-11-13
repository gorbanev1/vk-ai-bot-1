import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {isBotSelfTarget,evidenceKind,collectSelfEvidence} from '../../src/features/personality/botSelfEvidenceWorker.js';
import {validateSelfResult} from '../../src/features/personality/botSelfDossier.js';
import {parseRoastCommand} from '../../src/features/personality/roastCommandRouting.js';
test('self roast routes to bot, while first-person user requests stay human',()=>{
 for(const text of ['Гигорейв доебаться сам до себя','доебись до самого себя','доебаться до Гигорейва']) {
  const command=parseRoastCommand(text);assert.equal(command.matched,true);assert.equal(isBotSelfTarget(command.targetQuery),true);
 }
 for(const text of ['меня','Михаил','сам Михаил','на меня'])assert.equal(isBotSelfTarget(text),false);
});
test('own evidence is bounded independently and generic bot mentions remain candidates with context',()=>{
 const db=new DatabaseSync(':memory:');try{
  db.exec('CREATE TABLE vk_message_archive(peer_id,sender_id,conversation_message_id,text,created_at,raw_message_json,is_outbox)');
  const put=db.prepare('INSERT INTO vk_message_archive VALUES(1,?,?,?,?,?,?)');
  let id=0;function add(sender,text,raw='{}'){put.run(sender,++id,text,id,raw,sender===-10?1:0);}
  for(let i=0;i<1000;i++)add(-10,'Короткая реплика '+i);
  for(let i=0;i<50;i++)add(-10,'Досье на участника '+i);
  add(-10,'«Книга»\nГлава\nЧасть 1\n\nРассказ');
  add(5,'Это про музыкального бота');add(6,'бот завис');add(5,'Музыка не играет');
  add(6,'Гигорейв, ты опять написал роман');
  add(5,'Ответ тебе',JSON.stringify({reply_message:{from_id:-10,text:'Мой ответ'}}));
  const result=collectSelfEvidence(db,{peerId:1,botId:-10});
  assert.equal(result.ordinary.length,400);assert.equal(result.artifacts.length,10);
  assert.equal(result.counts.ordinary,1000);assert.equal(new Set(result.ordinary.map(x=>x.id)).size,400);
  const ambiguous=result.mentions.find(x=>x.text==='бот завис');
  assert.equal(ambiguous.direct,false);assert.ok(ambiguous.before.some(x=>x.text.includes('музыкального')));
  assert.ok(ambiguous.after.some(x=>x.text==='Музыка не играет'));
  assert.equal(result.mentions.find(x=>x.text==='Ответ тебе').direct,true);
 }finally{db.close();}
});
test('result validation does not publish malformed AI answers',()=>{
 assert.throws(()=>validateSelfResult({dossier:'x'}));
 const value={dossier:'Наблюдение о боте. '.repeat(8),roast:'Я опять сочинил роман вместо ответа.'};
 assert.deepEqual(validateSelfResult(value),{...value,dossier:value.dossier.trim()});
});
test('book chapters are not treated as ordinary bot speech',()=>{
 assert.equal(evidenceKind('«Книга»\nГлава\nЧасть 1\n\nТекст'),'service');
 assert.equal(evidenceKind('Досье на человека\nФакты'),'artifact');
 assert.equal(evidenceKind('Я опять ответил слишком длинно.'),'ordinary');
});

test('AI only sees confirmed mentions in the portrait pass, and a cached portrait avoids reanalysis',async()=>{
 const {mkdtemp,mkdir,rm}=await import('node:fs/promises');
 const {tmpdir}=await import('node:os');const {join}=await import('node:path');
 const {buildBotSelfDossier}=await import('../../src/features/personality/botSelfDossier.js');
 const dir=await mkdtemp(join(tmpdir(),'gigorave-self-'));
 const oldPath=process.env.GIGORAVE_DB_PATH,oldData=process.env.GIGORAVE_DATA_DIR;
 process.env.GIGORAVE_DB_PATH=join(dir,'bot.sqlite');process.env.GIGORAVE_DATA_DIR=dir;
 try{
  const db=new DatabaseSync(process.env.GIGORAVE_DB_PATH);
  db.exec("CREATE TABLE messages(peer_id,sender_id,conversation_message_id,text,created_at); INSERT INTO messages VALUES(1,-10,1,'Я отвечаю коротко',1),(1,20,2,'Гигорейв опять ошибся',2),(1,21,3,'бот музыкальный завис',3)");
  db.close();let calls=0;
  const generate=async request=>{
   calls++;
   if(calls===1)return JSON.stringify({decisions:[{id:2,about:'yes',reason:'Имя'},{id:3,about:'no',reason:'Музыкальный бот'}]});
   const packet=JSON.parse(request.userPrompt);
   assert.deepEqual(packet.mentions.map(x=>x.id),[2]);
   return JSON.stringify({dossier:'Бот Гигорейв отвечает на вопросы участников, иногда ошибается и получает замечания о своих ответах.',roast:'Я умудряюсь отвечать уверенно даже когда ошибаюсь.'});
  };
  const a=await buildBotSelfDossier({peerId:1,botId:-10,generate});
  const b=await buildBotSelfDossier({peerId:1,botId:-10,generate});
  assert.equal(calls,2);assert.equal(a.dossier,b.dossier);assert.equal(a.sampleCounts.confirmedMentions,1);
 }finally{
  if(oldPath===undefined)delete process.env.GIGORAVE_DB_PATH;else process.env.GIGORAVE_DB_PATH=oldPath;
  if(oldData===undefined)delete process.env.GIGORAVE_DATA_DIR;else process.env.GIGORAVE_DATA_DIR=oldData;
  await rm(dir,{recursive:true,force:true});
 }
});

test('long unlabelled reports cannot inflate ordinary speech beyond the report cap',()=>{
 assert.equal(evidenceKind('Текст без заголовка. '.repeat(100)),'artifact');
});
