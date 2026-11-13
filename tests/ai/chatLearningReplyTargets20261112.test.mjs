import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {sampleChatLearning} from '../../src/features/personality/chatLearningWorker.js';
test('learning uses exact reply target instead of the last nearby speaker',()=>{
 const db=new DatabaseSync(':memory:');try{
 db.exec('CREATE TABLE vk_message_archive(peer_id INTEGER,source_peer_id INTEGER,conversation_message_id INTEGER,sender_id INTEGER,text TEXT,raw_message_json TEXT,created_at INTEGER)');
 const add=db.prepare('INSERT INTO vk_message_archive VALUES(11,11,?,?,?,?,?)');
 add.run(1,7,'Гигорейв, как дела?','{}',100);
 add.run(2,8,'У меня всё хорошо','{}',101);
 add.run(3,-9,'Нормально, а ты?',JSON.stringify({reply_message:{conversation_message_id:1,from_id:7,date:100}}),102);
 add.run(4,-9,'Неизвестно кому отвечал','{}',103);
 add.run(5,-9,'Подмена автора',JSON.stringify({reply_message:{conversation_message_id:1,from_id:8}}),104);
 const result=sampleChatLearning(db,{peerId:11,botId:-9});assert.equal(result.available,1);
 const e=result.holdout[0];assert.equal(e.request.senderId,7);assert.equal(e.request.id,1);assert.equal(e.before.at(-1).senderId,8);
 }finally{db.close();}
});
