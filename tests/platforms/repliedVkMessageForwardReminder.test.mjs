import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {parseRepliedVkForwardReminder,buildVkForwardReminderParams,parseRepliedEventReminderRequest} from '../../src/features/events/repliedEventReminderRouting.js';
import {createReminderManager,parseReminderCommand} from '../../src/features/telegram/reminderManager.js';
const start=Date.parse('2026-11-07T06:00:00Z');
const ctx={platform:'vk',isDM:false,isChat:true,externalSenderId:'15',externalPeerId:'2000000123',peerId:2000000123,answerCallbackQuery:async()=>{}};
function setup(t){
 const dir=mkdtempSync(join(tmpdir(),'vkforward-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));
 let current=start;const replies=[],sent=[];const settings={storagePath:join(dir,'store.json'),timeZone:'Europe/Moscow',now:()=>current,random:()=>.5,
 ownerVkUserId:'15',api:{sendMessage:async()=>({message_id:1})},sendVkForwardReminder:async x=>{sent.push(x);return {id:sent.length}}};
 const manager=createReminderManager(settings);
 return {manager,settings,replies,sent,setTime:n=>current=n,
  context:{...ctx,send:async r=>replies.push(r)}};
}
test('Only Gigorave-prefixed non-card reminder commands are recognized',()=>{
 for(const s of ['Гигорейв, напоминай это сообщение каждый день в 10:00',
 'Гигорейв напомни это сообщение завтра в 12:00',
 'Гигорейв, напоминай это сообщение каждый день 2 раза с 10:00 до 18:00',
 'Гигорейв напомни это сообщение через неделю в 19:00']){
   const r=parseRepliedVkForwardReminder(s);
   assert.equal(r?.valid,true,s);
   const p=parseReminderCommand(r.command,{now:new Date(start),timeZone:'Europe/Moscow'});
   assert.equal(p.type,'create',s);
 }
 assert.equal(parseRepliedVkForwardReminder('напомни это сообщение каждый день в 10:00'),null);
 assert.equal(parseRepliedVkForwardReminder('напомни'),null);
 assert.equal(parseRepliedVkForwardReminder('Гигорейв, напомни').valid,false);
 assert.ok(parseRepliedEventReminderRequest('напоминай всем каждый день в 10:00'));
});
test('VK forwarding params use forward, original CMID, no reply_to',()=>{
 const data=buildVkForwardReminderParams({peerId:2000000123,sourcePeerId:2000000123,sourceCmid:777,randomId:17});
 assert.deepEqual(JSON.parse(data.forward),{peer_id:2000000123,conversation_message_ids:[777],is_reply:false});
 assert.equal('reply_to' in data,false);
 assert.throws(()=>buildVkForwardReminderParams({peerId:2000000124,sourcePeerId:2000000123,sourceCmid:777,randomId:17}));
});
test('Creator-bound confirmation, daily repetition, restart and cancellation',async t=>{
 const {manager,settings,replies,sent,setTime,context}=setup(t);
 const source={peerId:2000000123,cmid:777,messageId:999,text:'Исходное сообщение с вложениями'};
 const req=parseRepliedVkForwardReminder('Гигорейв, напоминай это сообщение каждый день 2 раза с 10:00 до 18:00');
 await manager.beginVkForwardReminder(context,source,req);
 assert.equal(manager.getState().reminders.length,0);
 assert.match(replies[0].message,/Исходное сообщение/u);
 assert.equal(JSON.parse(replies[0].keyboard).buttons.length,2);
 const session=manager.getState().eventSessions.find(x=>x.kind==='vk-forward-reply');
 const cb='evgrouprem:msgconfirm:'+session.id;
 await manager.handleCallback({...context,externalSenderId:'WRONG',callbackQuery:{data:cb}});
 assert.equal(manager.getState().reminders.length,0);
 await manager.handleCallback({...context,callbackQuery:{data:cb}});
 const first=manager.getState().reminders[0];
 assert.equal(first.nextAt,Date.parse('2026-11-07T07:00:00Z'));
 setTime(first.nextAt);await manager.tick();assert.equal(sent.length,1);
 assert.equal(sent[0].sourceCmid,777);assert.equal(sent[0].peerId,'2000000123');
 const restored=createReminderManager(settings);
 let item=restored.getState().reminders[0];
 assert.equal(item.nextAt,Date.parse('2026-11-07T15:00:00Z'));
 setTime(item.nextAt);await restored.tick();assert.equal(sent.length,2);
 item=restored.getState().reminders[0];
 assert.equal(item.nextAt,Date.parse('2026-11-08T07:00:00Z'));
 const stop='evgrouprem:msgstop:'+item.id.slice('vk-forward-'.length);
 await restored.handleCallback({...context,externalSenderId:'OTHER',callbackQuery:{data:stop}});
 assert.equal(restored.getState().reminders[0].active,true);
 await restored.handleCallback({...context,callbackQuery:{data:stop}});
 assert.equal(restored.getState().reminders[0].active,false);
 setTime(item.nextAt);await restored.tick();assert.equal(sent.length,2);
});
test('One-time forwarding happens once and confirmation is not replayable',async t=>{
 const {manager,context,setTime,sent}=setup(t);
 await manager.beginVkForwardReminder(context,{peerId:2000000123,cmid:444,text:'Важный текст'},
 parseRepliedVkForwardReminder('Гигорейв, напомни это сообщение завтра в 12:00'));
 const session=manager.getState().eventSessions[0];
 const cb={...context,callbackQuery:{data:'evgrouprem:msgconfirm:'+session.id}};
 await manager.handleCallback(cb);await manager.handleCallback(cb);
 assert.equal(manager.getState().reminders.length,1);
 setTime(manager.getState().reminders[0].nextAt);await manager.tick();
 assert.equal(sent.length,1);assert.equal(manager.getState().reminders[0].active,false);
});