import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {parseReminderCommand,createReminderManager} from '../../src/features/telegram/reminderManager.js';
const date=new Date('2026-11-07T06:00:00Z');
test('recipient aliases, daily count, cancellation flag and shared date windows',()=>{
 for(const name of ['Милане','Мелане']) {
  const p=parseReminderCommand(`напоминай ${name} четыре раза в день с 10:00 по 20:00 витамины отменять лично`,{now:date});
  assert.equal(p.type,'create');assert.equal(p.target,'milana');assert.equal(p.personalCancel,true);assert.equal(p.times.length,4);assert.equal(p.content,'витамины');
 }
 const p=parseReminderCommand('напомни мне завтра и 20.12.2026 с 10:00 до 18:00 3 раза проверить задачу',{now:date});
 assert.equal(p.type,'create');assert.equal(p.times.length,6);assert.equal(p.cadence,'once');
 const w=parseReminderCommand('напомни мне через неделю в 18:00 проверить задачу',{now:date});
 assert.equal(new Date(w.times[0]).toISOString(),'2026-11-14T15:00:00.000Z');
});
function setup(t,parseReminderWithAi=null){
 const dir=mkdtempSync(join(tmpdir(),'rem-daily-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));let at=+date;const sent=[];let id=0;
 const api={sendMessage:async p=>{sent.push(p);return {message_id:++id};}};
 const m=createReminderManager({api,storagePath:join(dir,'state.json'),ownerExternalUserId:'1',defaultChatId:'2',defaultUserId:'2',now:()=>at,parseReminderWithAi});
 const ctx=(user,text='',data='',mid=0)=>({platform:'telegram',isDM:true,externalPeerId:user,externalSenderId:user,text,send:async p=>sent.push({response:p}),answerCallbackQuery:async()=>{},callbackQuery:{data,message:{message_id:mid}}});
 return {m,sent,ctx,advance:n=>at=n};
}
test('done skips today, not tomorrow, notifies creator and stays idempotent',async t=>{
 const {m,sent,ctx,advance}=setup(t);
 await m.handleIncoming(ctx('1','напоминай Мелане каждый день 3 раза в день с 10:00 до 20:00 витамины'));
 let r=m.getState().reminders[0];assert.equal(r.chatId,'2');advance(r.nextAt);await m.tick();r=m.getState().reminders[0];
 await m.handleCallback(ctx('2','','remdone:'+r.id,r.lastMessageId));
 r=m.getState().reminders[0];assert.equal(r.active,true);assert.equal(new Date(r.nextAt).toISOString(),'2026-11-08T07:00:00.000Z');
 assert.ok(sent.some(p=>p.chatId==='1' && /отметил/.test(p.text)));
 advance(r.nextAt);await m.tick();assert.equal(sent.filter(p=>p.chatId==='2').length,2);
});
test('personal cancellation requires creator approval, list includes authored reminder',async t=>{
 const {m,sent,ctx}=setup(t);
 await m.handleIncoming(ctx('1','напоминай Милане каждый день в 10:00 витамины личная отмена'));
 let r=m.getState().reminders[0];
 await m.handleCallback(ctx('2','','remstop:'+r.id));r=m.getState().reminders[0];assert.equal(r.active,true);assert.ok(r.cancelRequest);
 await m.handleCallback(ctx('2','','remapprove:'+r.cancelRequest));assert.equal(m.getState().reminders[0].active,true);
 await m.handleIncoming(ctx('1','мои напоминания'));assert.ok(sent.some(p=>/Получатель: Милане/.test(p.response?.message)));
 await m.handleCallback(ctx('1','','remapprove:'+r.cancelRequest));assert.equal(m.getState().reminders[0].active,false);
 for(const p of sent)for(const row of (p.replyMarkup || p.response?.replyMarkup)?.inline_keyboard || [])assert.equal(row.length,1);
});
test('recipient can cancel unprotected recurring reminder',async t=>{
 const {m,ctx}=setup(t);await m.handleIncoming(ctx('1','напоминай Милане каждый день в 10:00 витамины'));
 await m.handleCallback(ctx('2','','remstop:'+m.getState().reminders[0].id));assert.equal(m.getState().reminders[0].active,false);
});

test('named month and ISO date have the same schedule',()=>{
 const opts={now:date};
 const a=parseReminderCommand('напомни мне 20 декабря 2026 в 18:00 задача',opts);
 const b=parseReminderCommand('напомни мне 2026-12-20 в 18:00 задача',opts);
 assert.equal(a.type,'create');assert.deepEqual(a.times,b.times);
});
test('old day button cannot complete the current day',async t=>{
 const {m,ctx,advance}=setup(t);await m.handleIncoming(ctx('1','напоминай мне каждый день в 10:00 задача'));
 let r=m.getState().reminders[0];advance(r.nextAt);await m.tick();r=m.getState().reminders[0];const old=r.lastMessageId;
 advance(r.nextAt);await m.tick();r=m.getState().reminders[0];
 await m.handleCallback(ctx('1','','remdone:'+r.id,old));assert.equal(m.getState().reminders[0].completedDay,undefined);
 await m.handleCallback(ctx('1','','remdone:'+r.id,r.lastMessageId));assert.ok(m.getState().reminders[0].completedDay);
});

test('two separate calendar days keep their respective windows after completion', async t => {
 const {m,sent,ctx,advance}=setup(t);
 await m.handleIncoming(ctx('1','напомни Мелане завтра и 20.12.2026 с 10:00 до 18:00 3 раза проверить задачу'));
 let r=m.getState().reminders[0];
 assert.equal(r.userId,'2');assert.equal(r.times.length,6);
 advance(r.nextAt);await m.tick();r=m.getState().reminders[0];
 await m.handleCallback(ctx('2','','remdone:'+r.id,r.lastMessageId));
 r=m.getState().reminders[0];
 assert.equal(r.active,true);assert.equal(r.times.length,3);
 assert.equal(new Date(r.nextAt).toISOString(),'2026-12-20T08:20:00.000Z');
 advance(r.nextAt);await m.tick();
 assert.ok(sent.filter(p=>p.chatId==='2'&&p.text?.startsWith('🔔 Напоминание:')).length>=2);
});

test('Igor receives Milana-authored reminder and Milana receives completion notice',async t=>{
 const {m,sent,ctx,advance}=setup(t);
 await m.handleIncoming(ctx('2','напоминай Игорю каждый день в 10:00 проверить почту личная отмена'));
 let r=m.getState().reminders[0];
 assert.equal(r.chatId,'1');assert.equal(r.creatorUserId,'2');assert.equal(r.personalCancel,true);
 advance(r.nextAt);await m.tick();r=m.getState().reminders[0];
 const outgoing=sent.find(p=>p.chatId==='1'&&p.text?.startsWith('🔔 Напоминание:'));
 assert.ok(outgoing);
 assert.equal(outgoing.replyMarkup.inline_keyboard[2][0].text,'Запросить отмену');
 await m.handleCallback(ctx('1','','remdone:'+r.id,r.lastMessageId));
 assert.equal(m.getState().reminders[0].active,true);
 assert.ok(sent.some(p=>p.chatId==='2'&&/отметил/.test(p.text)));
});

test('dates without a year refer to their next occurrence',()=>{
 const opt={now:date};
 const a=parseReminderCommand('напомни мне 1 января в 18:00 проверить',opt);
 const b=parseReminderCommand('напомни мне 01.01 в 18:00 проверить',opt);
 assert.equal(a.type,'create');assert.equal(b.type,'create');
 assert.deepEqual(a.times,b.times);
 assert.equal(new Date(a.times[0]).toISOString(),'2027-01-01T15:00:00.000Z');
 assert.equal(parseReminderCommand('напомни мне 01.01.2026 в 18:00 проверить',opt).type,'invalid');
});
test('edit accepts same named Milana and fixes dictated window without AI',async t=>{
 let calls=0;const {m,ctx}=setup(t,async()=>{calls++;return {understood:false};});
 await m.handleIncoming(ctx('1','напоминай Милане каждый день в 10:00 выпей витамины'));
 const original=m.getState().reminders[0];
 await m.handleCallback(ctx('1','','remlist:edit:'+original.id));
 await m.handleIncoming(ctx('1','Напоминай Милане каждый день в с 10:30 до 20:00 3 раза в день Выпей витамины'));
 const edit=m.getState().edits[0];
 assert.equal(calls,0);assert.equal(edit.proposal.type,'create');
 assert.equal(edit.proposal.target,'milana');assert.equal(edit.proposal.schedule.dailyCountPerDay,3);
 assert.deepEqual(m.getState().reminders[0],original);
 await m.handleCallback(ctx('1','','remconfirm:'+edit.token));
 const changed=m.getState().reminders[0];
 assert.equal(changed.userId,'2');assert.equal(changed.chatId,'2');
 assert.equal(changed.text,'Выпей витамины');assert.equal(changed.cadence,'daily');
 assert.equal(changed.schedule.dailyCountPerDay,3);
});

test('invalid edit goes to AI with templates and requires confirmation',async t=>{
 let called=null;
 const ai=async args=>{called=args;return {understood:true,command:'напоминай мне каждый день с 10:30 до 20:00 3 раза в день выпей витамины'};};
 const {m,ctx,sent}=setup(t,ai);
 await m.handleIncoming(ctx('1','напоминай Милане каждый день в 10:00 выпей витамины'));
 const original=m.getState().reminders[0];
 await m.handleCallback(ctx('1','','remlist:edit:'+original.id));
 await m.handleIncoming(ctx('1','напоминай Милане каждый день с утра до вечера 3 раза в день выпей витамины'));
 assert.ok(called);assert.match(called.help,/Шаблоны/);assert.equal(called.edit.recipient,'Милане');
 const edit=m.getState().edits[0];
 assert.equal(edit.proposal.target,'self');assert.equal(edit.proposal.schedule.dailyCountPerDay,3);
 assert.deepEqual(m.getState().reminders[0],original);
 assert.ok(sent.some(p=>/ИИ предложил изменение/.test(p.response?.message||'')));
 await m.handleCallback(ctx('1','','remconfirm:'+edit.token));
 const changed=m.getState().reminders[0];
 assert.equal(changed.userId,'2');assert.equal(changed.text,'выпей витамины');
});

test('changing recipient during edit is refused without any AI request',async t=>{
 let calls=0;const {m,ctx,sent}=setup(t,async()=>{calls++;return {understood:true,command:'напоминай мне каждый день в 12:00 звонить'};});
 await m.handleIncoming(ctx('1','напоминай Милане каждый день в 10:00 выпей витамины'));
 const original=m.getState().reminders[0];
 await m.handleCallback(ctx('1','','remlist:edit:'+original.id));
 await m.handleIncoming(ctx('1','напоминай Игорю каждый день с утра до вечера 3 раза в день позвонить'));
 assert.equal(calls,0);assert.equal(m.getState().edits[0].proposal,null);
 assert.deepEqual(m.getState().reminders[0],original);
 assert.ok(sent.some(p=>/Получателя существующего напоминания менять нельзя/.test(p.response||'')));
});

test('AI cannot switch existing reminder to a different recipient',async t=>{
 const {m,ctx}=setup(t,async()=>({understood:true,command:'напоминай Игорю каждый день в 12:00 звонить'}));
 await m.handleIncoming(ctx('1','напоминай Милане каждый день в 10:00 выпей витамины'));
 const original=m.getState().reminders[0];
 await m.handleCallback(ctx('1','','remlist:edit:'+original.id));
 await m.handleIncoming(ctx('1','напоминай Милане каждый день с утра до вечера 3 раза в день звонить'));
 assert.equal(m.getState().edits[0].proposal,null);
 assert.deepEqual(m.getState().reminders[0],original);
});
