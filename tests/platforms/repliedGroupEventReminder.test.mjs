import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseRepliedEventReminderRequest, extractSourceUrlsFromRepliedEventCard, eventCardDateAndTitle } from '../../src/features/events/repliedEventReminderRouting.js';
import { createReminderManager } from '../../src/features/telegram/reminderManager.js';
const card=['🎸 ВЕРНИ МНЕ МОЙ','📅 14 ноября 2026','🕒 19:00','','📍 Diesel Hall','','📝 Анонс:','ВЕРНИ МНЕ МОЙ','','Источник:','https://vk.ru/wall-242275190_1','','❗ УТОЧНЯЙТЕ ДЕТАЛИ НА СТРАНИЦЕ МЕРОПРИЯТИЯ! ❗','🔔 «Напомнить всем»'].join('\n');
const event={ sourceType:'manual',id:34,title:'ВЕРНИ МНЕ МОЙ',eventDate:'2026-11-14',eventTime:'19:00',venue:'Diesel Hall',sourceUrl:'https://vk.ru/wall-242275190_1' };
const start=Date.parse('2026-11-07T06:00:00.000Z'); // 09:00 Moscow
const context={ platform:'vk',isDM:false,isChat:true,externalPeerId:'2000000006',peerId:2000000006,externalSenderId:'600',endpointKey:'vk:primary',send:async()=>{},answerCallbackQuery:async()=>{} };
function setup(t) {
 const directory=mkdtempSync(join(tmpdir(),'reply-event-'));t.after(()=>rmSync(directory,{recursive:true,force:true}));
 let current=start;const replies=[],delivered=[];
 const options={storagePath:join(directory,'state.json'),api:{sendMessage:async()=>({message_id:1})},
  now:()=>current,random:()=>0.5,ownerVkUserId:'600',resolveEvent:async()=>event,
  sendEventReminder:async p=>{delivered.push(p);return {message_id:delivered.length}} };
 const manager=createReminderManager(options);
 const ctx={...context,send:async p=>replies.push(p)};
 return {manager,ctx,replies,delivered,options,changeTime:n=>{current=n}};
}
test('parse direct reply templates and exact VK event card source',()=>{
 const phrases=[
  'напоминай всем каждый день 2 раза в день с 10:00 до 18:00 до начала мероприятия',
  'напоминать всем об этом событии каждый день два раза в день с 10:00 до 18:00 до начала',
  'форси это событие каждый день 2 раза с 10 до 18 до начала',
  'напоминай всем каждый день три раза в день с 09:00 до 19:00 до начала тусовки',
 ];
 for(const phrase of phrases) {
  const r=parseRepliedEventReminderRequest(phrase);
  assert.equal(r?.valid,true,phrase);assert.equal(r.personal,false);
  assert.ok(/напоминай мне/.test(r.command),phrase);
 }
 assert.equal(parseRepliedEventReminderRequest('как дела'),null);
 assert.equal(parseRepliedEventReminderRequest('напомни мне каждый день в 12:00').personal,true);
 assert.deepEqual(extractSourceUrlsFromRepliedEventCard(card),[event.sourceUrl]);
 assert.deepEqual(eventCardDateAndTitle(card),{title:event.title,date:event.eventDate});
 assert.deepEqual(extractSourceUrlsFromRepliedEventCard('Сходи на vk.ru/wall-242275190_1'),[]);
});
test('reply confirmation schedules two daily VK group event cards and stops at event start',async t=>{
 const {manager,ctx,replies,delivered,changeTime}=setup(t);
 const request=parseRepliedEventReminderRequest('напоминай всем об этом событии каждый день 2 раза в день с 10:00 до 18:00 до начала');
 assert.equal(await manager.beginRepliedGroupEventReminder(ctx,event,request,{endpointKey:'vk:primary',chatId:ctx.externalPeerId,peerId:ctx.peerId}),true);
 assert.equal(manager.getState().reminders.length,0,'no reminder before explicit confirmation');
 assert.match(replies[0].message,/ВЕРНИ МНЕ МОЙ/u);
 assert.match(replies[0].message,/Каждый день, 2 раза в день/u);
 const buttons=JSON.parse(replies[0].keyboard).buttons;
 assert.equal(buttons.length,2);assert.ok(buttons.every(row=>row.length===1));
 const session=manager.getState().eventSessions.find(x=>x.kind==='group-event-reply');
 assert.ok(session);assert.equal(session.eventKey,'manual:34');
 await manager.handleCallback({...ctx,externalSenderId:'other',callbackQuery:{data:'evgrouprem:replyconfirm:'+session.id}});
 assert.equal(manager.getState().reminders.length,0,'wrong user cannot confirm');
 await manager.handleCallback({...ctx,callbackQuery:{data:'evgrouprem:replyconfirm:'+session.id}});
 let saved=manager.getState().reminders.find(x=>x.active && x.groupEventReminder);
 assert.ok(saved);assert.equal(saved.eventDeadlineAt,Date.parse('2026-11-14T16:00:00Z'));
 assert.equal(saved.remaining,null);assert.equal(saved.schedule.dailyCountPerDay,2);
 assert.equal(saved.nextAt,Date.parse('2026-11-07T07:00:00Z'));
 for(let n=0;n<3;n++){
   saved=manager.getState().reminders.find(x=>x.active && x.groupEventReminder);
   changeTime(saved.nextAt);await manager.tick();
 }
 assert.equal(delivered.length,3);
 assert.ok(delivered.every(x=>x.groupEventReminder && x.chatId==='2000000006'));
 assert.ok(delivered.every(x=>/предстоящем событии/.test(x.text)));
 changeTime(Date.parse('2026-11-14T16:00:00Z'));await manager.tick();
 assert.equal(manager.getState().reminders.find(x=>x.groupEventReminder).active,false,'ends exactly at event start');
 assert.equal(delivered.length,3);
});
test('repeated confirmation cannot create duplicate recurring group reminder',async t=>{
 const {manager,ctx}=setup(t);
 const request=parseRepliedEventReminderRequest('напоминай всем каждый день два раза в день с 10:00 до 18:00 до начала');
 await manager.beginRepliedGroupEventReminder(ctx,event,request,{endpointKey:'vk:primary'});
 const session=manager.getState().eventSessions[0];
 await manager.handleCallback({...ctx,callbackQuery:{data:'evgrouprem:replyconfirm:'+session.id}});
 await manager.handleCallback({...ctx,callbackQuery:{data:'evgrouprem:replyconfirm:'+session.id}});
 assert.equal(manager.getState().reminders.length,1);
 await manager.beginRepliedGroupEventReminder(ctx,event,request,{endpointKey:'vk:primary'});
 const newer=manager.getState().eventSessions[0];
 assert.equal(manager.getState().reminders.filter(x=>x.active&&x.groupEventReminder).length,1);
 await manager.handleCallback({...ctx,callbackQuery:{data:'evgrouprem:replycancel:'+newer.id}});
 assert.equal(manager.getState().reminders.filter(x=>x.active&&x.groupEventReminder).length,1);
});
test('daily event-card reminder survives manager restart without resetting its schedule',async t=>{
 const {manager,ctx,options,delivered,changeTime}=setup(t);
 const request=parseRepliedEventReminderRequest('напоминай всем каждый день 2 раза в день с 10:00 до 18:00 до начала');
 await manager.beginRepliedGroupEventReminder(ctx,event,request,{endpointKey:'vk:primary'});
 const session=manager.getState().eventSessions[0];
 await manager.handleCallback({...ctx,callbackQuery:{data:'evgrouprem:replyconfirm:'+session.id}});
 let item=manager.getState().reminders.find(x=>x.groupEventReminder);
 changeTime(item.nextAt);await manager.tick();
 const saved=manager.getState().reminders.find(x=>x.groupEventReminder);
 const restored=createReminderManager(options);
 item=restored.getState().reminders.find(x=>x.groupEventReminder);
 assert.equal(item.nextAt,saved.nextAt);
 assert.equal(item.eventDeadlineAt,saved.eventDeadlineAt);
 assert.equal(item.schedule.dailyCountPerDay,2);
 changeTime(item.nextAt);await restored.tick();
 assert.equal(delivered.length,2);
 assert.ok(restored.getState().reminders.find(x=>x.groupEventReminder).active);
});