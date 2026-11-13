import test from 'node:test';
import assert from 'node:assert/strict';
import {isPotentialContextPreference,parseVkHistoryRecord} from '../../src/features/personality/contextAdaptationHistory.js';
test('captures explicit contextual summary request',()=>{
 const row=parseVkHistoryRecord({peer_id:2000000006,conversation_message_id:221382,sender_id:181824119,text:'Гигорейв учитывай при создании авторезюме чистоту стола',is_outbox:0,raw_message_json:'{}'});
 assert.equal(isPotentialContextPreference(row),true);
});
test('ignores ordinary chat, bot messages, direct commands and service rows',()=>{
 for(const text of ['АХАХАХ','Как дела?','У меня не будет','Стол грязный','Гигорейв тусы сегодня','Гигорейв авторезюме вкл','Гигорейв']){
  assert.equal(isPotentialContextPreference({text,senderId:17}),false,text);
 }
 assert.equal(isPotentialContextPreference({text:'Гигорейв отвечай мне короче',senderId:-233007447}),false);
 assert.equal(isPotentialContextPreference({text:'Гигорейв отвечай мне короче',senderId:17,service:true}),false);
});
test('honors explicit opt-outs and replies addressed to bot',()=>{
 assert.equal(isPotentialContextPreference({senderId:17,text:'Гигорейв, перестань меня подкалывать'}),true);
 assert.equal(isPotentialContextPreference({senderId:17,text:'Учитывай, пожалуйста, мои ответы',replySenderId:-233007447}),true);
 assert.equal(isPotentialContextPreference({senderId:17,text:'Учитывай, пожалуйста, мои ответы',replySenderId:120}),false);
});
test('forwarded quoted requests are not treated as original sender wishes',()=>{
 assert.equal(isPotentialContextPreference(parseVkHistoryRecord({peer_id:2000000006,conversation_message_id:1,sender_id:17,is_outbox:0,raw_message_json:JSON.stringify({fwd_messages:[{text:'Гигорейв учитывай стол'}]}),text:''})),false);
});
