import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { buildVkCrossChatMiniDossier, loadVkCrossChatMiniDossier } from '../../src/features/personality/crossChatMiniDossier.js';

function fixture(){
 const db=new DatabaseSync(':memory:');
 db.exec('CREATE TABLE vk_message_archive(peer_id INTEGER,source_peer_id INTEGER,conversation_message_id INTEGER,sender_id INTEGER,created_at INTEGER,is_outbox INTEGER,action_type TEXT,text TEXT);');
 return db;
}
function add(db,{peer=2000000001,sender=441,date=1700000000,cmid=100,text='',outbox=0,action=''}={}){
 db.prepare('INSERT INTO vk_message_archive VALUES(?,?,?,?,?,?,?,?)').run(peer,peer,cmid,sender,date,outbox,action,text);
}
test('one VK user ID contributes own group messages across different group chats, no DM content',()=>{
 const db=fixture();
 try {
  const a=['Мне нравится живая музыка и концерты','Вчера опять концерт был отличный','Сходим в клуб и на концерт','А какой концерт в субботу','Тусовка снова в субботу'];
  const b=['Встречаемся на вечеринке','Завтра встреча в клубе','У вас музыка играет?','Собираемся на концерт!','Мне нужна гитара'];
  a.forEach((x,i)=>add(db,{text:x,cmid:i+1,date:1700000000+i}));
  b.forEach((x,i)=>add(db,{peer:2000000002,text:x,cmid:i+10,date:1700001000+i}));
  add(db,{peer:441,sender:441,text:'Личное сообщение про концерт',cmid:99,date:1700002000});
  add(db,{sender:777,text:'Третий участник говорит о моих личных делах',cmid:88,date:1700002001});
  add(db,{peer:2000000003,outbox:1,cmid:90,text:'От имени бота про музыку концерт',date:1700002002});
  const result=loadVkCrossChatMiniDossier(db,441,{nowSeconds:1700008000});
  assert.match(result,/музыка и концерты|городские встречи и тусовки/u);
  assert.doesNotMatch(result,/Личное сообщение|Третий участник|200000000|чаты «/u);
  const stored=db.prepare('SELECT * FROM vk_cross_chat_mini_dossiers WHERE user_id=441').get();
  assert.equal(stored.source_chat_count,2);
  assert.equal(stored.message_count,10);
  assert.equal(stored.profile_text,result);
 } finally {db.close()}
});
test('profile is stable and cached in durable SQLite for an hour; new eligible history refreshes',()=>{
 const db=fixture();
 try{
  for(let i=0;i<7;i++)add(db,{cmid:200+i,text:'Идём на концерт и послушаем музыку',date:1700000000+i});
  const p=loadVkCrossChatMiniDossier(db,441,{nowSeconds:1700001000});
  assert.ok(p);
  db.prepare('DELETE FROM vk_message_archive').run();
  assert.equal(loadVkCrossChatMiniDossier(db,441,{nowSeconds:1700001010}),p,'no per-request SQL history rebuild');
  assert.equal(loadVkCrossChatMiniDossier(db,441,{nowSeconds:1700004700}),'','expired profile rebuilt');
 }finally{db.close()}
});
test('an isolated message, bots, service messages and Telegram-style peer IDs never become mini-dossier facts',()=>{
 const db=fixture();
 try{
  add(db,{cmid:1,text:'Одна приватная тема о здоровье'});
  add(db,{cmid:2,peer:5000000001,text:'Концерт из Telegram'});
  add(db,{cmid:3,sender:0,text:'Концерт от бота'});
  add(db,{cmid:4,action:'chat_invite_user',text:'Концерт в служебной записи'});
  assert.equal(loadVkCrossChatMiniDossier(db,441,{nowSeconds:1700009000}),'');
  assert.equal(loadVkCrossChatMiniDossier(db,-2),'');
 }finally{db.close()}
});
test('profile contains no verbatim message quotes, inferred sensitive traits or chat identities',()=>{
 const profile=buildVkCrossChatMiniDossier(Array.from({length:14},(_,i)=>({
  sender_id:551,peer_id:i%2?2000000002:2000000001,
  text:i%3?'Я иду на концерт в субботу':'Ха-ха, послушаем музыку в клубе',
 })));
 assert.ok(profile.length>0&&profile.length<=440);
 assert.doesNotMatch(profile,/Я иду на концерт|Ха-ха, послушаем|200000000[12]|здоровь|психиатр/u);
 assert.match(profile,/Не сообщай названия других чатов/u);
});
