import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,readFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {createPatrolReadOnlyTools,runPatrolAdaptiveModule} from '../../src/features/ai/vkPatrolAdaptiveModules.js';
import {PATROL_PEER_ID,isPatrolPeer} from '../../src/features/ai/vkPatrolAdaptive.js';
import {createVkIncomingReplyContext} from '../../src/shared/incomingReplyTransport.js';
test('real target: event-rich VK chat 2000000011, not unrelated chats 2000000006/38',()=>{
 assert.equal(PATROL_PEER_ID,2000000011);
 assert.equal(isPatrolPeer(2000000011),true);
 assert.equal(isPatrolPeer(2000000038),false);
 assert.equal(isPatrolPeer(2000000006),false);
});
test('bounded OR history search does not read another chat',()=>{
 const temp=mkdtempSync(join(tmpdir(),'patrol-lookup-'));
 try{
  const path=join(temp,'test.sqlite');
  const db=new DatabaseSync(path);
  db.exec('CREATE TABLE vk_message_archive (peer_id INTEGER,sender_id INTEGER,conversation_message_id INTEGER,text TEXT,created_at INTEGER);');
  const put=db.prepare('INSERT INTO vk_message_archive VALUES(?,?,?,?,?)');
  put.run(2000000011,123,2,'\u0412\u043b\u0430\u0434\u0438\u0441\u043b\u0430\u0432 \u0431\u044b\u043b \u0432 \u0447\u0430\u0442\u0435',10);
  put.run(2000000011,124,3,'\u0412\u043b\u0430\u0434\u0438\u0441\u043b\u044d\u0439\u0432 \u043f\u0440\u0438\u0448\u0451\u043b',11);
  put.run(2000000011,125,4,'\u041a\u043e\u0448\u043a\u0430 \u043d\u0430 \u0434\u0438\u0432\u0430\u043d\u0435',12);
  put.run(2000000038,126,5,'\u0412\u043b\u0430\u0434\u0438\u0441\u043b\u0430\u0432 \u043d\u0435 \u043e\u0442\u0441\u044e\u0434\u0430',13);
  db.close();
  const tools=createPatrolReadOnlyTools({databasePath:path});
  const r=runPatrolAdaptiveModule('search_history',
   {terms:['\u0412\u043b\u0430\u0434\u0438\u0441\u043b\u0430\u0432','\u0412\u043b\u0430\u0434\u0438\u0441\u043b\u044d\u0439\u0432'],limit:20},tools);
  assert.equal(r.matches,2);
  assert.deepEqual(r.messages.map(x=>x.cmid),[3,2]);
  assert.equal(r.messages.some(x=>x.cmid===5),false);
  assert.equal(tools.searchMessages({terms:[]}).matches,0);
  const h=readFileSync(new URL('../../src/app/botApplication.js',import.meta.url),'utf8');
  assert.ok(h.indexOf('await handlePatrolAdaptive(context,directText,incomingContext)')<
      h.indexOf('if (await handleChatFunctionToggle(context,directText)) return;'));
 }finally{rmSync(temp,{force:true,recursive:true})}
});
test('VK reply delivery observer records a successful native command reply',async()=>{
 let received=0;
 const raw={
  peerId:2000000011,
  reply:async()=>({id:50}),
  send:async()=>({id:51})
 };
 const ctx=createVkIncomingReplyContext(raw,()=>{received++});
 await ctx.send('hello');
 assert.equal(received,1);
});
