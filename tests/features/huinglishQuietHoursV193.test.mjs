import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {DatabaseSync} from 'node:sqlite';
import {
 huinglishQuietWindow,isHuinglishQuietTime,nextHuinglishActiveTime,
 addHuinglishActiveMilliseconds,huinglishActiveElapsedMilliseconds,
} from '../../src/features/english/huinglishQuietHours.js';
import {createHuinglishMultiPlatform} from '../../src/features/english/huinglishMultiPlatform.js';
import {createHuinglishQuiz} from '../../src/features/english/huinglishQuiz.js';

const t=local=>Date.parse(local); // Input is offset-aware ISO-8601.
test('01:30..06:30 Moscow is exact and excludes the boundary minutes',()=>{
 const day='2026-11-05';
 for(const hhmm of ['00:00','01:29','06:30','07:00','23:59'])
  assert.equal(isHuinglishQuietTime(t(day+'T'+hhmm+':00+03:00')),false,hhmm);
 for(const hhmm of ['01:30','02:00','04:59','06:29'])
  assert.equal(isHuinglishQuietTime(t(day+'T'+hhmm+':00+03:00')),true,hhmm);
 assert.equal(nextHuinglishActiveTime(t(day+'T01:30:00+03:00')),t(day+'T06:30:00+03:00'));
 assert.equal(nextHuinglishActiveTime(t(day+'T06:30:00+03:00')),t(day+'T06:30:00+03:00'));
});
test('partial intervals exclude paused hours rather than reset at dawn',()=>{
 const day='2026-11-05';
 assert.equal(addHuinglishActiveMilliseconds(t(day+'T01:10:00+03:00'),40*60000),
  t(day+'T06:50:00+03:00'));
 assert.equal(addHuinglishActiveMilliseconds(t(day+'T01:20:00+03:00'),20*60000),
  t(day+'T06:40:00+03:00'));
 assert.equal(addHuinglishActiveMilliseconds(t(day+'T00:55:00+03:00'),60*60000),
  t(day+'T06:55:00+03:00'));
 assert.equal(addHuinglishActiveMilliseconds(t(day+'T01:29:00+03:00'),60*1000),
  t(day+'T06:30:00+03:00'));
 assert.equal(addHuinglishActiveMilliseconds(t(day+'T03:00:00+03:00'),20*60000),
  t(day+'T06:50:00+03:00'));
 assert.equal(huinglishActiveElapsedMilliseconds(t(day+'T01:10:00+03:00'),t(day+'T06:50:00+03:00')),40*60000);
 assert.equal(huinglishActiveElapsedMilliseconds(t(day+'T01:30:00+03:00'),t(day+'T06:30:00+03:00')),0);
});
test('cross-day and DST timezone math is independent of the hosting server timezone',()=>{
 const start=t('2026-11-05T01:25:00+03:00');
 assert.equal(addHuinglishActiveMilliseconds(start,24*3600000),
  t('2026-11-06T11:25:00+03:00'));
 const londonStart=t('2026-11-04T01:20:00+00:00');
 assert.equal(addHuinglishActiveMilliseconds(londonStart,15*60000,'Europe/London'),
  t('2026-11-04T06:35:00+00:00'));
 assert.equal(nextHuinglishActiveTime(t('2026-07-01T03:00:00+01:00'),'Europe/London'),
  t('2026-07-01T06:30:00+01:00'));
});
function createFixture(t, start='2026-11-05T01:20:00+03:00') {
 const root=mkdtempSync(join(tmpdir(),'huinglish-night-'));
 const folder=join(root,'english-huinglish');
 mkdirSync(folder,{recursive:true});
 for(let i=1;i<=4;i++)writeFileSync(join(folder,'lesson1_part'+i+'.txt'),'LESSON 1 PART '+i);
 writeFileSync(join(folder,'intro_vk.jpg'),'photo');
 const dbPath=join(root,'test.sqlite'); let now=t=>{}; let clock=Date.parse(start),id=5000;
 const sent=[];
 const vk={api:{messages:{send:async args=>{sent.push({...args,at:clock});const n=++id;return [{peer_id:args.peer_id||args.peer_ids?.[0],message_id:n,conversation_message_id:n}];},
   getById:async ({message_ids})=>({items:[{id:Number(message_ids),conversation_message_id:Number(message_ids)}]})}},
   upload:{messagePhoto:async()=> 'photo1_2'}};
 const logger={info(){},error(...args){throw Error(args.join(' '))},warn(){}};
 const app=createHuinglishMultiPlatform({vk,dbPath,dataDir:root,now:()=>clock,
  timeZone:'Europe/Moscow',random:()=>0.5,logger,sitePromosEnabled:false});

 const context={platform:'vk',peerId:'2000000009',isPrivate:false,isOwner:true};
 const command=async text=>{assert.equal(app.handle({...context,text}),true);await app.idle()};
 const db=new DatabaseSync(dbPath);
 t.after(async()=>{await app.close();db.close();rmSync(root,{recursive:true,force:true});});
 return {app,vk,db,command,sent,context,now:()=>clock,
  set:date=>{clock=Date.parse(date)},advance:delta=>{clock+=delta}};
}
test('lesson part due during pause is held until remainder after 06:30',async t=>{
 const f=createFixture(t,'2026-11-05T01:20:00+03:00');
 await f.command('хуинглиш вкл');
 assert.equal(f.sent.filter(x=>x.message?.includes('LESSON 1 PART')).length,1);
 const run=f.app.inspect('vk','2000000009').run,plan=JSON.parse(run.plan);
 const nextDelta=plan[1]-plan[0];
 assert.ok(nextDelta>0 && nextDelta<60*60000);
 const nextAt=addHuinglishActiveMilliseconds(f.now(),nextDelta);
 f.set('2026-11-05T02:30:00+03:00');
 await f.app.tick();
 assert.equal(f.sent.filter(x=>x.message?.includes('LESSON 1 PART')).length,1);
 f.set(new Date(nextAt-1000).toISOString());
 await f.app.tick();
 assert.equal(f.sent.filter(x=>x.message?.includes('LESSON 1 PART')).length,1);
 f.set(new Date(nextAt).toISOString());
 await f.app.tick();
 assert.equal(f.sent.filter(x=>x.message?.includes('LESSON 1 PART')).length,2);
});
test('lesson started manually during quiet period waits silently until 06:30',async t=>{
 const f=createFixture(t,'2026-11-05T03:30:00+03:00');
 await f.command('хуинглиш вкл');
 assert.equal(f.sent.filter(x=>x.message?.includes('LESSON 1 PART')).length,0);
 f.set('2026-11-05T06:29:00+03:00');await f.app.tick();
 assert.equal(f.sent.filter(x=>x.message?.includes('LESSON 1 PART')).length,0);
 f.set('2026-11-05T06:30:00+03:00');await f.app.tick();
 assert.equal(f.sent.filter(x=>x.message?.includes('LESSON 1 PART')).length,1);
});
test('quiz deadline waits the exact remaining interval, never dumps on wake',async t=>{
 const f=createFixture(t,'2026-11-05T01:20:00+03:00');
 await f.command('хуинглиш вкл');
 // Mark lesson complete in isolated test DB, without altering production.
 f.db.prepare("UPDATE huinglish_subscriptions SET completed_lesson=1,completed_lessons_json=? WHERE platform='vk' AND peer_id=?")
    .run(JSON.stringify({'1':'2026-11-04'}),'2000000009');
 await f.command('хуинглиш тесты 1/3');
 const questions=()=>f.sent.filter(x=>Boolean(x.keyboard));
 assert.equal(questions().length,1);
 const firstPayload=JSON.parse(JSON.parse(questions()[0].keyboard).buttons[0][0].action.payload);
 f.set('2026-11-05T02:00:00+03:00');
 await f.app.tick();assert.equal(questions().length,1);
 f.set('2026-11-05T06:39:00+03:00');await f.app.tick();
 assert.equal(questions().length,1);
 f.set('2026-11-05T06:40:00+03:00');await f.app.tick();
 assert.equal(questions().length,2);
 const repeated=JSON.parse(JSON.parse(questions()[1].keyboard).buttons[0][0].action.payload);
 assert.equal(repeated.token,firstPayload.token);
});
test('quiz command during quiet waits until dawn, preserves accumulated acceleration mode',async t=>{
 const f=createFixture(t,'2026-11-05T02:30:00+03:00');
 await f.command('хуинглиш вкл');
 f.db.prepare("UPDATE huinglish_subscriptions SET completed_lesson=1,completed_lessons_json=? WHERE platform='vk' AND peer_id=?")
    .run('{"1":"2026-11-04"}','2000000009');
 await f.command('хуинглиш тесты 0.5 ускорение');
 const quiz=f.db.prepare('SELECT * FROM huinglish_quiz_schedules WHERE peer_id=?').get('2000000009');
 assert.equal(quiz.acceleration_enabled,1);
 assert.equal(quiz.interval_ms,30*60000);
 assert.equal(quiz.next_at,Date.parse('2026-11-05T06:30:00+03:00'));
 assert.equal(f.sent.filter(x=>x.keyboard).length,0);
 f.set('2026-11-05T06:30:00+03:00');await f.app.tick();
 assert.equal(f.sent.filter(x=>x.keyboard).length,1);
});
