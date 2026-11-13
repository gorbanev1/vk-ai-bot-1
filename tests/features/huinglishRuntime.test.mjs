import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {spawnSync} from 'node:child_process';
import {createHuinglishMultiPlatform,scheduleHuinglishRelease} from '../../src/features/english/huinglishMultiPlatform.js';
import {ensureHuinglishSchema,scheduleHuinglishDrop,validateHuinglishParts} from '../../src/features/english/huinglishStore.js';
import {parseHuinglishCommand} from '../../src/features/english/huinglishVkLesson.js';

function fixture(t,{rawTelegram=false,sendHook=null,sitePromosEnabled=false}={}) {
 const root=mkdtempSync(join(tmpdir(),'huinglish-audit-')),dbPath=join(root,'test.sqlite');
 mkdirSync(join(root,'english-huinglish'));
 for(let i=1;i<=4;i++)writeFileSync(join(root,'english-huinglish','lesson1_part'+i+'.txt'),'LESSON 1 PART '+i);
 writeFileSync(join(root,'english-huinglish','intro_vk.jpg'),'FAKE');
 let clock=Date.parse('2026-10-31T08:00:00Z'),sequence=100,app,hook=sendHook;
 const sent=[],errors=[];
 const send=async(platform,args)=>{
  if(hook){const response=await hook(platform,args);if(response!==undefined)return response;}
  const id=++sequence;sent.push({platform,id,...args});
  return platform==='vk'?{id}:{message_id:id};
 };
 const vk={api:{messages:{send:args=>send('vk',args),getById:async({message_ids})=>({items:[{id:message_ids,conversation_message_id:message_ids+1000}]})}},upload:{messagePhoto:async()=> 'photo1_1'}};
 const telegramBot={api:{sendMessage:args=>send('telegram',args),sendPhoto:args=>send('telegram',args)}};
 if(rawTelegram)telegramBot.api.call=(method,args)=>send('telegram',{method,...args});
 const open=()=>app=createHuinglishMultiPlatform({vk,telegramBot,dbPath,dataDir:root,now:()=>clock,random:()=>.5,sitePromosEnabled,logger:{info(){},error(...v){errors.push(v)},warn(){}}});
 open();
 const db=new DatabaseSync(dbPath);
 t.after(async()=>{await app.close();db.close();rmSync(root,{recursive:true,force:true});});
 const context=(platform='telegram',peerId='11',extra={})=>({platform,peerId,isPrivate:true,...extra});
 const command=async(text,c=context())=>{assert.equal(app.handle({...c,text}),true);await app.idle();};
 const callback=async(data,c=context())=>{assert.equal(app.handleCallback({...c,data}),true);await app.idle();};
 return {root,dbPath,db,sent,errors,context,command,callback,
  get app(){return app},now:()=>clock,setTime:value=>clock=value,hook:fn=>hook=fn,
  restart:async()=>{await app.close();open();},finish:async(c)=>{for(let i=0;i<3;i++)await command('хуинглиш далее',c)},
  addLesson:(id,count=4)=>{db.prepare('INSERT INTO huinglish_lessons(id,title,intro_text,intro_image,created_at,published) VALUES(?,?,?,?,?,1)').run(id,'Lesson '+id,'hello','intro_vk.jpg',clock);for(let i=1;i<=count;i++)db.prepare('INSERT INTO huinglish_parts VALUES(?,?,?)').run(id,i,'LESSON '+id+' PART '+i);},
 };
}
test('fresh database initializes lesson and first DM part without photo',async t=>{
 const f=fixture(t);await f.command('хуинглиш вкл');
 assert.equal(f.app.inspect('telegram','11').lessons,1);
 assert.equal(f.sent.length,1);assert.equal(f.sent[0].text,'LESSON 1 PART 1');
 assert.equal(f.app.inspect('telegram','11').run.next_part,2);
});
test('Telegram chain survives restart and replies to immediately previous bot part',async t=>{
 const f=fixture(t,{rawTelegram:true});await f.command('хуинглиш вкл');
 const first=f.sent.at(-1).id;await f.restart();await f.command('хуинглиш далее');
 assert.deepEqual(f.sent.at(-1).reply_parameters,{message_id:first,allow_sending_without_reply:false});
 const second=f.sent.at(-1).id;await f.command('хуинглиш далее');
 assert.equal(f.sent.at(-1).reply_parameters.message_id,second);
});
test('VK uses conversation message ID, not the API global ID, for replies',async t=>{
 const f=fixture(t),c=f.context('vk','42');await f.command('хуинглиш вкл',c);
 const first=f.sent[0].id;await f.restart();await f.command('хуинглиш далее',c);
 const forward=JSON.parse(f.sent.at(-1).forward);
 assert.equal(forward.conversation_message_ids,first+1000);assert.equal(forward.peer_id,42);assert.equal(forward.is_reply,true);
});
test('forum topic stays attached to its run and other topic cannot advance it',async t=>{
 const f=fixture(t,{rawTelegram:true}),c=f.context('telegram','-1001',{isPrivate:false,threadId:7});
 await f.command('хуинглиш вкл',c);
 assert.equal(f.sent.at(-1).message_thread_id,7);
 await f.command('хуинглиш далее',{...c,threadId:8});
 assert.equal(f.app.inspect('telegram','-1001').run.next_part,2);
 assert.equal(f.sent.at(-1).message_thread_id,8);
 assert.match(f.sent.at(-1).text,/другой теме/);
 await f.command('хуинглиш далее',c);assert.equal(f.app.inspect('telegram','-1001').run.next_part,3);
});
test('editing published lesson does not splice new content into an active run',async t=>{
 const f=fixture(t);await f.command('хуинглиш вкл');
 f.db.prepare('UPDATE huinglish_parts SET body=? WHERE lesson_id=1 AND number=2').run('NEW SECOND PART');
 await f.restart();await f.command('хуинглиш далее');
 assert.equal(f.sent.at(-1).text,'LESSON 1 PART 2');
});
test('off during timer send is serialized and cannot be undone by stale completion',async t=>{
 const f=fixture(t);await f.command('хуинглиш вкл');await f.command('хуинглиш далее');await f.command('хуинглиш далее');
 let unblock,entered;const ready=new Promise(r=>entered=r),wait=new Promise(r=>unblock=r);
 f.hook(async(p,args)=>{if(args.text==='LESSON 1 PART 4'){entered();await wait;}});
 const run=f.app.inspect('telegram','11').run;f.setTime(JSON.parse(run.plan)[3]);
 const tick=f.app.tick();await ready;
 f.app.handle({...f.context(),text:'хуинглиш выкл'});unblock();await tick;await f.app.idle();
 assert.equal(f.app.inspect('telegram','11').subscription.enabled,0);
 assert.equal(f.app.inspect('telegram','11').run.status,'finished');
 const count=f.sent.length;f.setTime(f.now()+86400000);await f.app.tick();assert.equal(f.sent.length,count);
});
test('queued command still executes after the previous command rejects',async t=>{
 const f=fixture(t);let fail=true;
 f.hook(async()=>{if(fail){fail=false;throw Error('network')}});
 f.app.handle({...f.context(),text:'хуинглиш статус'});
 f.app.handle({...f.context(),text:'хуинглиш вкл'});
 await f.app.idle();assert.equal(f.app.inspect('telegram','11').run.next_part,2);
});
test('network retry keeps VK random_id and does not advance progress early',async t=>{
 const f=fixture(t),c=f.context('vk','42'),ids=[];let fail=true;
 f.hook(async(platform,args)=>{if(args.message==='LESSON 1 PART 1'){ids.push(args.random_id);if(fail){fail=false;throw Error('timeout')}}});
 await f.command('хуинглиш вкл',c);
 assert.equal(f.app.inspect('vk','42').run.next_part,1);
 f.setTime(f.now()+30000);await f.app.tick();
 assert.equal(f.app.inspect('vk','42').run.next_part,2);assert.equal(ids.length,2);assert.equal(ids[0],ids[1]);
});
test('repeated control replies have different VK deduplication IDs',async t=>{
 const f=fixture(t),c=f.context('vk','42');await f.command('хуинглиш статус',c);await f.command('хуинглиш статус',c);
 assert.notEqual(f.sent[0].random_id,f.sent[1].random_id);
});
test('three failed sends pause; enabling resumes and clears failure streak',async t=>{
 const f=fixture(t);f.hook(async()=>{throw Error('temporary transport error')});
 await f.command('хуинглиш вкл');
 for(let i=0;i<2;i++){f.setTime(f.app.inspect('telegram','11').run.due_at);await f.app.tick();}
 assert.equal(f.app.inspect('telegram','11').run.status,'paused');
 f.hook(null);await f.command('хуинглиш вкл');
 assert.equal(f.app.inspect('telegram','11').run.failures,0);assert.equal(f.app.inspect('telegram','11').run.next_part,2);
});
test('resume after a long pause preserves gaps and does not dump remaining parts at once',async t=>{
 const f=fixture(t);await f.command('хуинглиш вкл');await f.command('хуинглиш выкл');f.setTime(f.now()+86400000);
 await f.command('хуинглиш вкл');const run=f.app.inspect('telegram','11').run;
 assert.equal(run.next_part,3);assert.ok(run.due_at>f.now()+60000);
 const count=f.sent.length;await f.app.tick();assert.equal(f.sent.length,count);
});
test('paused repeat of an already completed lesson can still resume',async t=>{
 const f=fixture(t);await f.command('хуинглиш вкл');await f.finish();f.setTime(f.now()+86400000);
 await f.command('хуинглиш урок 1');await f.command('хуинглиш выкл');await f.command('хуинглиш вкл');
 assert.equal(f.app.inspect('telegram','11').run.next_part,3);
});
test('uncompleted numbered lesson stays locked rather than skipping progression',async t=>{
 const f=fixture(t);await f.command('хуинглиш вкл');await f.finish();f.addLesson(2);f.addLesson(3);
 await f.command('хуинглиш урок 3');
 assert.deepEqual(Object.keys(JSON.parse(f.app.inspect('telegram','11').subscription.completed_lessons_json)),['1']);
 assert.equal(f.app.inspect('telegram','11').run.lesson_id,1);
 assert.match(f.sent.at(-1).text,/недоступен для повтора/);
 await f.app.tick();assert.equal(f.app.inspect('telegram','11').subscription.scheduled_lesson,0);
});
test('explicit November 1 release at 10 Moscow survives restart and runs once',async t=>{
 const f=fixture(t);await f.command('хуинглиш вкл');await f.finish();f.addLesson(2);
 const at=Date.parse('2026-11-01T07:00:00Z');
 scheduleHuinglishDrop(f.db,{platform:'telegram',peerId:'11',lessonId:1,startAt:at,now:f.now()});
 await f.restart();const count=f.sent.length;
 f.setTime(at-1);await f.app.tick();assert.equal(f.sent.length,count);
 assert.equal(f.app.inspect('telegram','11').subscription.scheduled_lesson,1);
 f.setTime(at);await Promise.all([f.app.tick(),f.app.tick()]);
 assert.equal(f.sent.length,count+1);assert.equal(f.sent.at(-1).text,'LESSON 1 PART 1');
 assert.equal(f.sent.at(-1).replyToMessageId,undefined);
 assert.equal(f.app.inspect('telegram','11').subscription.scheduled_at,0);
 await f.restart();await f.app.tick();assert.equal(f.sent.length,count+1);
 await f.command('хуинглиш далее');assert.equal(f.sent.at(-1).replyToMessageId,f.sent.at(-2).id);
});
test('off cancels explicit future drop and future tick stays silent',async t=>{
 const f=fixture(t);await f.command('хуинглиш вкл');await f.finish();const at=f.now()+86400000;
 scheduleHuinglishDrop(f.db,{platform:'telegram',peerId:'11',startAt:at,now:f.now()});
 await f.command('хуинглиш выкл');const count=f.sent.length;f.setTime(at);await f.app.tick();
 assert.equal(f.sent.length,count);assert.equal(f.app.inspect('telegram','11').subscription.scheduled_at,0);
});
test('missing receipt pauses after sent part instead of resending it or breaking chain',async t=>{
 const f=fixture(t);let attempts=0;f.hook(async()=>{attempts++;return {}});
 await f.command('хуинглиш вкл');
 const run=f.app.inspect('telegram','11').run;assert.equal(run.status,'paused');assert.equal(run.next_part,2);
 f.setTime(f.now()+3600000);await f.app.tick();assert.equal(attempts,1);
});
test('corrupt plan pauses before another network request',async t=>{
 const f=fixture(t);await f.command('хуинглиш вкл');f.db.exec("UPDATE huinglish_delivery_runs SET plan='broken'");
 const count=f.sent.length;await f.command('хуинглиш далее');
 assert.equal(f.sent.length,count);assert.equal(f.app.inspect('telegram','11').run.status,'paused');
});
test('source limits and validation reject empty, oversized and missing parts',()=>{
 assert.throws(()=>validateHuinglishParts(['']));
 assert.throws(()=>validateHuinglishParts([{number:2,body:'x'}]));
 assert.throws(()=>validateHuinglishParts(['x'.repeat(4090)+'\n'.repeat(4)+'y']));
 assert.deepEqual(parseHuinglishCommand('гигорейв хуинглиш статус'),{type:'status'});
});
test('real lesson contains four safe messages, all thirteen expressions and twenty-six examples',()=>{
 const parts=[1,2,3,4].map(n=>readFileSync(new URL('../../data/english-huinglish/lesson1_part'+n+'.txt',import.meta.url),'utf8'));
 assert.equal(validateHuinglishParts(parts).length,4);
 for(const part of parts)assert.ok(part.length+(part.match(/\n/g)||[]).length<=4000);
 assert.equal((parts[3].match(/[①②]/gu)||[]).length,26);
 assert.equal((parts.slice(0,3).join('\n').match(/[🇺🇸🇬🇧🇦🇺] (?:\d+)\. /gu)||[]).length,13);
 assert.ok(parts[0].includes("I'M = I AM"));assert.ok(parts[2].includes('юге США'));assert.ok(!parts.join('').includes('Южноамериканское'));
});
test('splitter and atomic importer accept a clean database and reject invalid budget',t=>{
 const root=mkdtempSync(join(tmpdir(),'huinglish-import-'));t.after(()=>rmSync(root,{recursive:true,force:true}));
 const source=join(root,'source.txt'),out=join(root,'out'),dbPath=join(root,'test.sqlite');
 writeFileSync(source,'First complete block\n:::\nSecond complete block');
 const run=args=>spawnSync(process.execPath,args,{encoding:'utf8',windowsHide:true,env:{...process.env,GIGORAVE_DATA_DIR:root,GIGORAVE_DB_PATH:dbPath,NODE_ENV:'test'}});
 let r=run(['scripts/huinglish-split-vk.mjs',source,'--lesson','2','--out',out]);assert.equal(r.status,0,r.stderr);
 const manifest=join(out,'manifest.json');
 r=run(['scripts/huinglish-import-lesson.mjs',manifest,'--title','Lesson two']);assert.equal(r.status,0,r.stderr);
 const db=new DatabaseSync(dbPath);
 assert.equal(db.prepare('SELECT published FROM huinglish_lessons WHERE id=2').get().published,1);db.close();
 const json=JSON.parse(readFileSync(manifest,'utf8'));json.lesson=3;delete json.limit;writeFileSync(manifest,JSON.stringify(json));
 r=run(['scripts/huinglish-import-lesson.mjs',manifest,'--title','Broken']);assert.notEqual(r.status,0);
 const check=new DatabaseSync(dbPath);assert.equal(check.prepare('SELECT id FROM huinglish_lessons WHERE id=3').get(),undefined);check.close();
});

test('explicit restart repairs a broken chain with new first message and unique VK IDs',async t=>{
 const f=fixture(t),c=f.context('vk','42');
 await f.command('хуинглиш вкл',c);const id=f.sent.at(-1).random_id;
 f.db.exec("UPDATE huinglish_delivery_runs SET status='paused',plan='broken',last_message_json='{}'");
 await f.command('хуинглиш заново',c);
 assert.equal(f.sent.at(-1).message,'LESSON 1 PART 1');assert.notEqual(f.sent.at(-1).random_id,id);
 assert.equal(f.sent.at(-1).forward,undefined);
 await f.command('хуинглиш далее',c);
 assert.equal(JSON.parse(f.sent.at(-1).forward).conversation_message_ids,f.sent.at(-2).id+1000);
});
test('Huinglish commands escape unrelated UI modes instead of going to GPT',async()=>{
 const {detectExplicitApplicationCommand}=await import('../../src/features/routing/explicitApplicationCommand.js');
 for(const text of ['хуинглиш вкл','хуинглиш далее','хуинглиш статус','хуинглиш заново','гигорейв хуинглиш урок 1']){
  const result=detectExplicitApplicationCommand(text);assert.equal(result.matched,true,text);assert.equal(result.family,'huinglish');
 }
});

test('VK community zero global ID still produces a durable lesson reply chain',async t=>{
 const f=fixture(t),requests=[];let cmid=700;
 f.hook(async(platform,args)=>{
  if(platform!=='vk')return;
  assert.deepEqual(args.peer_ids,[42]);assert.equal(args.peer_id,undefined);
  requests.push(args);return [{peer_id:42,message_id:0,conversation_message_id:++cmid}];
 });
 const c=f.context('vk','42');await f.command('хуинглиш вкл',c);
 assert.equal(f.app.inspect('vk','42').run.status,'running');
 await f.restart();await f.command('хуинглиш далее',c);
 assert.equal(JSON.parse(requests.at(-1).forward).conversation_message_ids,701);
 assert.equal(f.app.inspect('vk','42').run.next_part,3);
});
test('VK per-peer lesson delivery errors retain the unsent part for retry',async t=>{
 const f=fixture(t),c=f.context('vk','42');
 f.hook(async(platform)=>platform==='vk'?[{peer_id:42,error:{error_code:901,error_msg:'Denied'}}]:undefined);
 await f.command('хуинглиш вкл',c);
 const run=f.app.inspect('vk','42').run;
 assert.equal(run.next_part,1);assert.equal(run.failures,1);assert.match(run.last_error,/Denied/);
});

// New HuInglish release policy: DM is request-only; chats release next day.
test('DM does not auto-release lesson 2 and next command respects completed day',async t=>{
 const f=fixture(t);await f.command('хуинглиш вкл');await f.finish();
 f.addLesson(2);
 await f.app.tick();
 assert.equal(f.app.inspect('telegram','11').subscription.scheduled_lesson,0);
 const before=f.sent.length;
 await f.command('хуинглиш далее');
 assert.equal(f.app.inspect('telegram','11').run.lesson_id,1);
 assert.equal(f.sent.length,before+1);
 f.setTime(Date.parse('2026-11-01T08:00:00Z'));
 await f.command('хуинглиш далее');
 assert.equal(f.app.inspect('telegram','11').run.lesson_id,2);
 assert.equal(f.app.inspect('telegram','11').run.next_part,2);
});
test('private reminder after over one week uses buttons and supports opt-out',async t=>{
 const f=fixture(t);await f.command('хуинглиш вкл');await f.finish();f.addLesson(2);
 f.setTime(Date.parse('2026-11-09T09:00:00Z'));
 await f.app.tick();
 const last=f.sent.at(-1);
 assert.match(last.text||last.message||'',/Хочешь получить следующий урок/);
 await f.callback(f.sent.at(-1).replyMarkup.inline_keyboard[2][0].callback_data);
 assert.match(f.sent.at(-1).text||'',/всегда можешь вернуться/);
 f.setTime(Date.parse('2026-12-01T09:00:00Z'));
 const n=f.sent.length;await f.app.tick();
 assert.equal(f.sent.length,n);
 await f.command('хуинглиш далее');
 assert.equal(f.app.inspect('telegram','11').run.lesson_id,2);
});test('owner-only HuInglish reset removes only personal progress and restarts onboarding',async t=>{
 const f=fixture(t);const owner=f.context('telegram','11',{isOwner:true});
 await f.command('хуинглиш вкл',owner);await f.finish(owner);f.addLesson(2);
 const before=f.app.inspect('telegram','11');assert.equal(before.run.status,'finished');
 await f.command('хуинглиш сбросить',f.context('telegram','11',{isOwner:false}));
 assert.equal(f.app.inspect('telegram','11').run.status,'finished');
 await f.command('хуинглиш сбросить',owner);
 assert.equal(f.app.inspect('telegram','11').run,undefined);
 assert.equal(f.app.inspect('telegram','11').subscription,undefined);
 assert.equal(f.app.inspect('telegram','11').lessons,2);
 await f.command('хуинглиш меню',owner);
 assert.match(f.sent.at(-1).text,/Хочешь посмотреть первый урок/);
 await f.callback(f.sent.at(-1).replyMarkup.inline_keyboard[0][0].callback_data,owner);
 assert.equal(f.app.inspect('telegram','11').run.lesson_id,1);
});
test('plain HuInglish command starts first lesson, no auto-next in DM',async t=>{
 const f=fixture(t);await f.command('хуинглиш');
 assert.equal(f.app.inspect('telegram','11').run.lesson_id,1);
 assert.equal(f.app.inspect('telegram','11').run.next_part,2);
});
test('DM menu uses inline buttons; stale clicks and typed Да cannot launch a lesson',async t=>{
 const f=fixture(t);const c=f.context();
 await f.command('хуинглиш меню',c);
 const msg=f.sent.at(-1);
 assert.equal(msg.replyMarkup.inline_keyboard.length,1);
 assert.equal(msg.replyMarkup.keyboard,undefined);
 assert.equal(f.app.handle({...c,text:'Да'}),false);
 const no=msg.replyMarkup.inline_keyboard[0][1].callback_data;
 await f.callback(no,c);
 assert.equal(f.app.inspect('telegram','11').subscription,undefined);
 const n=f.sent.length;
 await f.callback(msg.replyMarkup.inline_keyboard[0][0].callback_data,c);
 assert.equal(f.sent.length,n+1);
 assert.match(f.sent.at(-1).text,/недействительна/);
 await f.command('хуинглиш меню',c);
 const yes=f.sent.at(-1).replyMarkup.inline_keyboard[0][0].callback_data;
 await f.callback(yes,c);
 assert.equal(f.app.inspect('telegram','11').run.lesson_id,1);
});
test('chat next-day automatic release stays blocked on finish day and starts tomorrow',async t=>{
 const f=fixture(t);const c=f.context('vk','2000000042',{isPrivate:false});
 await f.command('хуинглиш вкл',c);f.addLesson(2);await f.finish(c);
 await f.command('хуинглиш далее',c);
 assert.equal(f.app.inspect('vk','2000000042').run.lesson_id,1);
 await f.app.tick();assert.equal(f.app.inspect('vk','2000000042').subscription.scheduled_lesson,0);
 f.setTime(Date.parse('2026-11-01T08:00:00Z'));await f.app.tick();
 const next=f.app.inspect('vk','2000000042').subscription;
 assert.equal(next.scheduled_lesson,2);
 f.setTime(next.scheduled_at+1000);await f.app.tick();
 assert.equal(f.app.inspect('vk','2000000042').run.lesson_id,2);
});
test('no next lesson gives repeat instructions without starting anything',async t=>{
 const f=fixture(t);await f.command('хуинглиш вкл');await f.finish();
 const n=f.sent.length;await f.command('хуинглиш далее');
 assert.equal(f.sent.length,n+1);
 assert.match(f.sent.at(-1).text,/Новых уроков в базе пока нет/);
 assert.match(f.sent.at(-1).text,/хуинглиш урок 1/);
});
test('private reminder has three full-width vertically stacked buttons and snoozes for week',async t=>{
 const f=fixture(t);await f.command('хуинглиш вкл');await f.finish();f.addLesson(2);
 f.setTime(Date.parse('2026-11-09T09:00:00Z'));await f.app.tick();
 const p=f.sent.at(-1);
 assert.equal(p.replyMarkup.inline_keyboard.length,3);
 assert.equal(p.replyMarkup.inline_keyboard[0].length,1);
 assert.equal(p.replyMarkup.inline_keyboard[1].length,1);
 assert.equal(p.replyMarkup.inline_keyboard[2].length,1);
 assert.equal(p.replyMarkup.keyboard,undefined);
 assert.match(p.text,/\u0440\u0430\u0437\u0433\u043e\u0432\u043e\u0440\u043d\u044b\u0439 \u0430\u043d\u0433\u043b\u0438\u0439\u0441\u043a\u0438\u0439/u);
 await f.callback(p.replyMarkup.inline_keyboard[1][0].callback_data);
 assert.match(f.sent.at(-1).text,/через неделю/);
 const n=f.sent.length;await f.app.tick();assert.equal(f.sent.length,n);
});
import {resolveTelegramMenuInput,buildTelegramMainMenu,buildTelegramHuinglishMenu} from '../../src/platforms/telegram/telegramBot.js';
test('Telegram HuInglish menu routes enter, continue, list and back safely',async()=>{
 const enter=resolveTelegramMenuInput('🌭 Хуинглиш 🍆',{},{isOwner:true});
 assert.equal(enter.type,'command');
 assert.equal(enter.text,'хуинглиш меню');
 assert.equal(enter.state.menuPath,'huinglish');
 const next=resolveTelegramMenuInput('📖 Хуинглиш · далее',enter.state,{isOwner:true});
 assert.equal(next.text,'хуинглиш далее');
 assert.equal(next.state.menuPath,'huinglish');
 const list=resolveTelegramMenuInput('📚 Хуинглиш · уроки',enter.state,{isOwner:true});
 assert.equal(list.text,'хуинглиш список');
 const back=resolveTelegramMenuInput('⬅️ Назад',enter.state,{isOwner:true});
 assert.equal(back.type,'command');
 assert.equal(back.text,'хуинглиш выход');
 assert.equal(back.state.menuPath,undefined);
 const home=resolveTelegramMenuInput('🏠 Главное меню',enter.state,{isOwner:true});
 assert.equal(home.type,'command');
 assert.equal(home.text,'хуинглиш выход');
 assert.equal(home.state.menuPath,undefined);
 assert.equal(buildTelegramMainMenu({isOwner:true}).keyboard.flat().some(x=>x.text=== '🌭 Хуинглиш 🍆'),true);
 const owner=buildTelegramHuinglishMenu({isOwner:true}).keyboard.flat().map(x=>x.text);
 const guest=buildTelegramHuinglishMenu({isOwner:false}).keyboard.flat().map(x=>x.text);
 assert.ok(owner.includes('⬅️ Назад'));
 assert.ok(owner.includes('🔄 Хуинглиш · сбросить'));
 assert.equal(guest.includes('🔄 Хуинглиш · сбросить'),false);
});
test('onboarding uses TWO Telegram messages: navigation reply keyboard then inline consent, No restores main',async t=>{
 const f=fixture(t),c=f.context();
 await f.command('хуинглиш меню',c);
 assert.equal(f.sent.length,2);
 const first=f.sent[0],second=f.sent[1];
 assert.ok(first.replyMarkup.keyboard.flat().some(b=>b.text==='⬅️ Назад'));
 assert.equal(first.replyMarkup.inline_keyboard,undefined);
 assert.ok(second.replyMarkup.inline_keyboard[0].some(b=>b.text==='Да'));
 assert.equal(second.replyMarkup.keyboard,undefined);
 await f.callback(second.replyMarkup.inline_keyboard[0][1].callback_data,c);
 assert.ok(f.sent.at(-1).replyMarkup.keyboard.flat().some(b=>b.text=== '🌭 Хуинглиш 🍆'));
 assert.equal(f.app.inspect('telegram','11').subscription,undefined);
});
test('finished lesson can be replayed same day with explicit numbered command but not via next',async t=>{
 const f=fixture(t);await f.command('хуинглиш вкл');await f.finish();
 const before=f.app.inspect('telegram','11').run.started_at;
 await f.command('хуинглиш далее');
 assert.equal(f.app.inspect('telegram','11').run.status,'finished');
 await f.command('хуинглиш урок 1');
 const r=f.app.inspect('telegram','11').run;
 assert.equal(r.lesson_id,1);
 assert.equal(r.next_part,2);
 assert.ok(r.started_at>before);
});
test('personalized lesson picker unlocks only published completed lessons',async t=>{
 const f=fixture(t);f.addLesson(2);f.addLesson(3);f.addLesson(4);
 await f.command('хуинглиш список');
 const first=f.sent.at(-1);
 const labels=m=>m.replyMarkup.keyboard.flat().map(b=>b.text);
 assert.deepEqual(labels(first).filter(x=>/^\d+$/.test(x)),[]);
 assert.match(first.text,/\n🔒 Урок 1/);
 assert.equal(first.text.includes('\\n'),false);
 assert.ok(first.text.includes('Приветствия'));
 assert.ok(first.text.includes('Тусовки'));
 assert.ok(first.text.includes('Реакции'));
 assert.ok(first.text.includes('Отмена планов'));
 await f.command('хуинглиш вкл');await f.finish();
 await f.command('хуинглиш список');
 const one=f.sent.at(-1);
 assert.deepEqual(labels(one).filter(x=>/^\d+$/.test(x)),['1']);
 await f.command('хуинглиш урок 2');
 assert.match(f.sent.at(-1).text,/недоступен для повтора/);
 f.setTime(Date.parse('2026-11-01T08:00:00Z'));
 await f.command('хуинглиш далее');await f.finish();
 await f.command('хуинглиш список');
 assert.deepEqual(labels(f.sent.at(-1)).filter(x=>/^\d+$/.test(x)),['1','2']);
 await f.command('хуинглиш список',f.context('telegram','22'));
 assert.deepEqual(labels(f.sent.at(-1)).filter(x=>/^\d+$/.test(x)),[]);
});
test('telegram lesson picker digit routes to replay; back restores section, home exits',async()=>{
 const st=resolveTelegramMenuInput('📚 Хуинглиш · уроки',{menuPath:'huinglish'},{isOwner:false});
 assert.equal(st.state.menuPath,'huinglish-lessons');
 assert.equal(st.text,'хуинглиш список');
 const one=resolveTelegramMenuInput('1',st.state,{isOwner:false});
 assert.equal(one.text,'хуинглиш урок 1');
 assert.equal(one.state.menuPath,'huinglish');
 const back=resolveTelegramMenuInput('⬅️ Назад',st.state,{isOwner:false});
 assert.equal(back.text,'хуинглиш раздел');
 assert.equal(back.state.menuPath,'huinglish');
 const home=resolveTelegramMenuInput('🏠 Главное меню',st.state,{isOwner:false});
 assert.equal(home.text,'хуинглиш выход');
 assert.equal(home.state.menuPath,undefined);
});

test('menu suppresses next-day consent if current lesson finished today; tomorrow offers next',async t=>{
 const f=fixture(t),c=f.context('telegram','11',{isOwner:true});
 await f.command('хуинглиш вкл',c);await f.finish(c);f.addLesson(2);
 const before=f.sent.length;
 await f.command('хуинглиш меню',c);
 assert.equal(f.sent.length,before+1,'today status must be one message');
 const status=f.sent.at(-1);
 assert.match(status.text,/Сегодня урок уже завершён/);
 assert.match(status.text,/завтра/);
 assert.equal(status.replyMarkup.inline_keyboard,undefined,'no Да/Нет when tomorrow-only');
 assert.ok(status.replyMarkup.keyboard.flat().some(b=>b.text==='⬅️ Назад'));
 assert.ok(status.replyMarkup.keyboard.flat().some(b=>b.text==='📚 Хуинглиш · уроки'));
 assert.equal(f.db.prepare('SELECT COUNT(*) n FROM huinglish_menu_prompts').get().n,0);
 f.setTime(Date.parse('2026-11-01T08:00:00Z'));
 const prior=f.sent.length;await f.command('хуинглиш меню',c);
 assert.equal(f.sent.length,prior+2,'tomorrow should send navigation plus consent');
 assert.match(f.sent.at(-1).text,/Хочешь посмотреть следующий урок №2/);
 assert.equal(f.sent.at(-1).replyMarkup.inline_keyboard[0].length,2);
 await f.callback(f.sent.at(-1).replyMarkup.inline_keyboard[0][0].callback_data,c);
 assert.equal(f.app.inspect('telegram','11').run.lesson_id,2);
});
test('menu with no next published lesson never asks for consent',async t=>{
 const f=fixture(t);await f.command('хуинглиш вкл');await f.finish();
 const start=f.sent.length;await f.command('хуинглиш меню');
 assert.equal(f.sent.length,start+1);
 const last=f.sent.at(-1);
 assert.match(last.text,/Новых уроков в базе пока нет/);
 assert.doesNotMatch(last.text,/Хочешь посмотреть/);
 assert.equal(last.replyMarkup.inline_keyboard,undefined);
 assert.ok(last.replyMarkup.keyboard.flat().some(b=>b.text==='⬅️ Назад'));
});
test('menu during unfinished lesson offers continuation and never starts new lesson',async t=>{
 const f=fixture(t);await f.command('хуинглиш вкл');f.addLesson(2);
 const before=f.sent.length;await f.command('хуинглиш меню');
 assert.equal(f.sent.length,before+2);
 const proposal=f.sent.at(-1);
 assert.match(proposal.text,/урок №1 ещё не закончен/);
 assert.ok(proposal.replyMarkup.inline_keyboard);
 await f.callback(proposal.replyMarkup.inline_keyboard[0][0].callback_data);
 assert.equal(f.app.inspect('telegram','11').run.lesson_id,1);
});
test('menu consent becomes stale on back or picker and cannot launch lesson',async t=>{
 const f=fixture(t);await f.command('хуинглиш меню');
 const first=f.sent.at(-1).replyMarkup.inline_keyboard[0][0].callback_data;
 await f.command('хуинглиш список');
 await f.callback(first);
 assert.equal(f.app.inspect('telegram','11').run,undefined);
 await f.command('хуинглиш меню');
 const second=f.sent.at(-1).replyMarkup.inline_keyboard[0][0].callback_data;
 await f.command('хуинглиш выход');
 await f.callback(second);
 assert.equal(f.app.inspect('telegram','11').run,undefined);
 assert.ok(f.sent.at(-1).replyMarkup===undefined || f.sent.at(-1).replyMarkup.inline_keyboard===undefined);
});

test('each VK and Telegram lesson part is followed by one separate short site message; replies still target lesson',async t=>{
    const {HUINGLISH_SITE_PROMOS}=await import('../../src/features/english/huinglishSitePromos.js');
    for(const platform of ['vk','telegram']) {
        const f=fixture(t,{sitePromosEnabled:true,rawTelegram:platform==='telegram'});
        const c=f.context(platform,platform==='vk'?'42':'11');
        await f.command('хуинглиш вкл',c);
        assert.equal(f.sent.length,2,platform);
        assert.ok((f.sent[0].message||f.sent[0].text).includes('LESSON 1 PART 1'));
        assert.ok(HUINGLISH_SITE_PROMOS.includes(f.sent[1].message||f.sent[1].text));
        await f.command('хуинглиш далее',c);
        assert.equal(f.sent.length,4,platform);
        assert.ok((f.sent[2].message||f.sent[2].text).includes('LESSON 1 PART 2'));
        assert.ok(HUINGLISH_SITE_PROMOS.includes(f.sent[3].message||f.sent[3].text));
        if(platform==='vk')assert.equal(JSON.parse(f.sent[2].forward).conversation_message_ids,f.sent[0].id+1000);
        else assert.equal(f.sent[2].reply_parameters.message_id,f.sent[0].id);
    }
});

test('failed promo cannot make a delivered lesson repeat or stop next lesson part',async t=>{
    const f=fixture(t,{sitePromosEnabled:true});
    const c=f.context('vk','42');
    f.hook(async(_platform,args)=>{
        if((args.message||args.text||'').includes('https://huinglish.tw1.ru/'))
            throw Error('Temporary website promo send error');
    });
    await f.command('хуинглиш вкл',c);
    assert.equal(f.app.inspect('vk','42').run.next_part,2);
    await f.command('хуинглиш далее',c);
    assert.equal(f.app.inspect('vk','42').run.next_part,3);
    assert.equal(f.sent.filter(x=>x.message?.includes('LESSON 1 PART')).length,2);
});
