import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createReminderManager} from '../../src/features/telegram/reminderManager.js';

test('nonowner cannot begin VK group event or forwarded-message reminders',async t=>{
 const dir=mkdtempSync(join(tmpdir(),'owner-rem-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));
 const out=[],ctx={platform:'vk',isDM:false,isChat:true,externalPeerId:'2000000006',
  peerId:2000000006,externalSenderId:'stranger',send:async x=>out.push(x)};
 const service=createReminderManager({storagePath:join(dir,'state.json'),ownerVkUserId:'600',
  api:{sendMessage:async()=>({})},now:()=>Date.parse('2026-11-07T06:00:00Z')});
 const event={sourceType:'manual',id:1,eventDate:'2026-11-14',eventTime:'19:00'};
 await service.beginRepliedGroupEventReminder(ctx,event,{valid:true,command:'напомни мне завтра в 12:00'},{});
 await service.beginVkForwardReminder(ctx,{peerId:2000000006,cmid:55},{valid:true,command:'напомни мне завтра в 12:00'},{});
 await service.handleGroupEventReminder(ctx,event,{platform:'vk',chatId:'2000000006'});
 assert.equal(service.getState().eventSessions.length,0);
 assert.equal(service.getState().reminders.length,0);
 assert.equal(out.length,3);
 assert.ok(out.every(s=>String(s).includes('только владельцу')));
});
test('older nonowner group jobs are disabled before they can send',async t=>{
 const dir=mkdtempSync(join(tmpdir(),'owner-rem-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));
 const file=join(dir,'state.json'),now=Date.parse('2026-11-07T06:00:00Z');
 writeFileSync(file,JSON.stringify({version:1,reminders:[{id:'old',active:true,
  platform:'vk',groupEventReminder:true,creatorUserId:'stranger',chatId:'2000000006',
  nextAt:now-1000,times:[now-1000]}]}));
 let sent=0;
 const service=createReminderManager({storagePath:file,ownerVkUserId:'600',now:()=>now,
  api:{sendMessage:async()=>{sent++;}},sendEventReminder:async()=>{sent++;}});
 await service.tick();
 assert.equal(sent,0);
 assert.equal(service.getState().reminders[0].active,false);
 assert.equal(service.getState().reminders[0].cancelReason,'owner-only-group');
});
