import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { resolveMainDatabasePath, resolveRuntimeDataDirectory, assertTestDatabaseIsolation } from '../../infrastructure/database/runtimePaths.js';
import { parseHuinglishQuizSuffix } from './huinglishQuiz.js';

// Verified from live VK message_new logs: the requested VK web conversation /2000000032
// is delivered to the community bot as API peer_id 2000000008.
export const HUINGLISH_PEER_ID = 2000000008;
export const HUINGLISH_AUTO_ENABLED = false; // Explicitly no automatic lessons while only one is approved.
export const HUINGLISH_SCHEDULE_WINDOWS = Object.freeze([{start:10,end:12,weight:4},{start:12,end:16,weight:3},{start:16,end:20,weight:2}]);

export function parseHuinglishCommand(raw) {
    const s=String(raw||'').toLocaleLowerCase('ru-RU').replace(/ё/g,'е')
        .replace(/^\s*(?:гигорейв|гиго\s*рейв|gigorave)\s*[,.:!?-]?\s*/iu,'')
        .replace(/[-–—]/gu,' ').replace(/\s+/gu,' ').trim().replace(/[.!?]+$/u,'');
    const alias='(?:хуинглиш|хуинглишь|хиунглиш|хиунглишь|инглиш хуинглиш|инглишь хуинглиш|инглиш хуинглишь|инглишь хуинглишь|инглиш хиунглиш|инглишь хиунглиш)';
    const quizMatch = new RegExp('^'+alias+' тесты(?: (.*))?$','u').exec(s);
    if(quizMatch)return parseHuinglishQuizSuffix(quizMatch[1]||'');
    // Control the answer policy per VK chat, without enabling/disabling quizzes.
    if(new RegExp('^'+alias+' (?:сразу )?не раскрывать правильный$','u').test(s))
        return {type:'quizHideCorrect'};
    if(new RegExp('^'+alias+' (?:сразу )?раскрывать правильный$','u').test(s))
        return {type:'quizRevealCorrect'};
    if(new RegExp('^'+alias+'$','u').test(s))return {type:'on'};
    const m=new RegExp('^'+alias+' (вкл|выкл)$','u').exec(s);
    if(m)return {type:m[1]==='вкл'?'on':'off'};
    if(new RegExp('^'+alias+' сбросить$','u').test(s))return {type:'reset'};
    const n=new RegExp('^'+alias+' (?:урок |номер |№\\s*)?(\\d{1,3})$','u').exec(s);
    if(n)return {type:'lesson',id:Number(n[1])};
    if(new RegExp('^'+alias+' (?:следующий урок|следующий)$','u').test(s))return {type:'next'};
    if(new RegExp('^'+alias+' (?:далее|продолжение)$','u').test(s))return {type:'next'};
    if(new RegExp('^'+alias+' (?:статус|прогресс)$','u').test(s))return {type:'status'};
    if(new RegExp('^'+alias+' (?:заново|начать заново)$','u').test(s))return {type:'restart'};
    return null;
}

export function pickHuinglishStartMinute(rng=Math.random) {
    let weight=Math.min(.999999,Math.max(0,rng()))*9;
    const window=HUINGLISH_SCHEDULE_WINDOWS.find(x=>(weight-=x.weight)<0) || HUINGLISH_SCHEDULE_WINDOWS[2];
    return window.start*60+Math.floor(Math.min(.999999,Math.max(0,rng()))*(window.end-window.start)*60);
}
export function planHuinglishParts(start,rng=Math.random,partCount=4) {
    if(!Number.isInteger(partCount)||partCount<1||partCount>25)throw Error('HuInglish: invalid parts count');
    if(partCount===1)return [start];
    // Last part planned for 45–55 minutes from the first; five-minute API safety margin.
    const duration=(45+Math.floor(Math.min(.999999,Math.max(0,rng()))*11))*60000;
    const weights=Array.from({length:partCount-1},()=>.7+.6*rng());
    const sum=weights.reduce((a,b)=>a+b,0);
    let elapsed=0;
    const result=[start];
    for(const weight of weights) {
        elapsed+=weight;
        result.push(start+Math.round(duration*elapsed/sum));
    }
    return result;
}
const INTRO=[
'🧐 Ну что, умники и умницы ёбаные, не ждали вы такого?',
'Мне, например, хоца, пока вы тут окончательно не деградировали, чтобы кто-нибудь из вас уебал в Асашай или куда-нибудь в ту сторону, подальше, и там бы бомжевал.',
'Мне было бы дохуя приятно. Плюсом — годный контент.',
'Мечтать не вредно — вредно не мечтать.',
'Хули пиздеть — погнали нахуй.',
'И в качестве волшебного дилдака 🍆 вам в жопу для ускорения — новая рубрика:',
'🌭 ИНГЛИШ-ХУИНГЛИШ 🍆'].join('\n');
const day=(tz,millis)=>new Intl.DateTimeFormat('en-CA',{timeZone:tz,year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date(millis));

export function createHuinglishVkLessons({vk,peerId=HUINGLISH_PEER_ID,timeZone='Europe/Moscow',dataDir=resolveRuntimeDataDirectory(),dbPath=resolveMainDatabasePath(),now=Date.now,rng=Math.random,logger=console}={}) {
    assertTestDatabaseIsolation({databasePath:dbPath});
    const db=new DatabaseSync(dbPath);
    db.exec('PRAGMA busy_timeout=2000');
    db.exec('CREATE TABLE IF NOT EXISTS huinglish_lessons(id INTEGER PRIMARY KEY,title TEXT NOT NULL,intro_text TEXT NOT NULL,intro_image TEXT NOT NULL,created_at INTEGER NOT NULL);'+
        'CREATE TABLE IF NOT EXISTS huinglish_parts(lesson_id INTEGER NOT NULL,number INTEGER NOT NULL,body TEXT NOT NULL,PRIMARY KEY(lesson_id,number));'+
        'CREATE TABLE IF NOT EXISTS huinglish_settings(peer_id INTEGER PRIMARY KEY,enabled INTEGER NOT NULL,last_day TEXT NOT NULL,updated_at INTEGER NOT NULL);'+
        'CREATE TABLE IF NOT EXISTS huinglish_runs(peer_id INTEGER PRIMARY KEY,lesson_id INTEGER NOT NULL,status TEXT NOT NULL,next_part INTEGER NOT NULL,due_at INTEGER NOT NULL,plan TEXT NOT NULL,failures INTEGER NOT NULL,updated_at INTEGER NOT NULL);'+
        'CREATE TABLE IF NOT EXISTS huinglish_schedule(id INTEGER PRIMARY KEY CHECK(id=1),auto_enabled INTEGER NOT NULL,windows_json TEXT NOT NULL);');
    db.prepare('INSERT OR IGNORE INTO huinglish_schedule VALUES(1,0,?)').run(JSON.stringify(HUINGLISH_SCHEDULE_WINDOWS));
    const folder=join(dataDir,'english-huinglish');
    const lessonStmt=db.prepare('SELECT * FROM huinglish_lessons WHERE id=?');
    const countStmt=db.prepare('SELECT COUNT(*) n FROM huinglish_lessons');
    const partStmt=db.prepare('SELECT * FROM huinglish_parts WHERE lesson_id=? AND number=?');
    const stateStmt=db.prepare('SELECT * FROM huinglish_settings WHERE peer_id=?');
    const runStmt=db.prepare('SELECT * FROM huinglish_runs WHERE peer_id=?');
    const saveState=db.prepare('INSERT INTO huinglish_settings(peer_id,enabled,last_day,updated_at) VALUES(?,?,?,?) ON CONFLICT(peer_id) DO UPDATE SET enabled=excluded.enabled,last_day=excluded.last_day,updated_at=excluded.updated_at');
    const saveRun=db.prepare('INSERT OR REPLACE INTO huinglish_runs(peer_id,lesson_id,status,next_part,due_at,plan,failures,updated_at) VALUES(?,?,?,?,?,?,?,?)');
    const finishPart=db.prepare('UPDATE huinglish_runs SET status=?,next_part=?,due_at=?,failures=?,updated_at=? WHERE peer_id=?');

    if(!lessonStmt.get(1)){
        const paths=[1,2,3,4].map(i=>join(folder,'lesson1_part'+i+'.txt'));
        if(!paths.every(existsSync))throw Error('Missing lesson files');
        const bodies=paths.map(p=>readFileSync(p,'utf8').replace(/\r\n/g,'\n').trim());
        if(bodies.some(b=>b.length>4096))throw Error('VK lesson part too long');
        db.prepare('INSERT INTO huinglish_lessons VALUES(1,?,?,?,?)').run('Чё как, братан?',INTRO,'intro_vk.jpg',now());
        for(let i=0;i<4;i++)db.prepare('INSERT INTO huinglish_parts VALUES(1,?,?)').run(i+1,bodies[i]);
    }
    let stopped=false,timer=null,commandQueue=Promise.resolve();
    const busy=new Set();
    const isEnabled=()=>stateStmt.get(peerId)?.enabled===1;
    const send=async(text,attachment='')=>{
        // Stable VK random_id for the same message/day prevents duplicate delivery after network retries.
        const digest=createHash('sha256').update(String(peerId)+'|'+day(timeZone,now())+'|'+text).digest();
        const stableId=(digest.readUInt32BE(0)&0x7fffffff)||1;
        const args={peer_id:peerId,random_id:stableId,message:text};
        if(attachment)args.attachment=attachment;
        return vk.api.messages.send(args);
    };
    async function intro(){
        const lesson=lessonStmt.get(1);
        const path=join(folder,lesson.intro_image);
        if(!existsSync(path))throw Error('Intro image missing: '+path);
        const photo=await vk.upload.messagePhoto({source:{value:readFileSync(path),filename:'huinglish-intro.jpg'}});
        const att=String(photo);
        if(!att||att==='[object Object]')throw Error('VK image upload returned invalid attachment');
        await send(lesson.intro_text+'\n\nРучной запуск: «хуинглиш урок 1».',att);
    }
    async function deliver(){
        if(stopped||busy.has(peerId)||!isEnabled())return;
        const run=runStmt.get(peerId);
        if(!run||run.status!=='running'||run.due_at>now())return;
        busy.add(peerId);
        try{
            const p=partStmt.get(run.lesson_id,run.next_part);
            if(!p){finishPart.run('finished',run.next_part,0,0,now(),peerId);return;}
            if(!isEnabled())return;
            await send(p.body);
            const times=JSON.parse(run.plan),n=run.next_part+1;
            finishPart.run(n>times.length?'finished':'running',n,n>times.length?0:times[n-1],0,now(),peerId);
            logger.info('[HUINGLISH PART SENT]','peer='+peerId,'lesson='+run.lesson_id,'part='+run.next_part);
        }catch(e){
            const count=run.failures+1;
            finishPart.run(count>=3?'paused':'running',run.next_part,now()+30000*count,count,now(),peerId);
            logger.warn('[HUINGLISH PART FAILED]',String(e?.message||e));
        }finally{busy.delete(peerId);}
    }
    async function execute(cmd){
        const s=stateStmt.get(peerId)||{enabled:0,last_day:''};
        if(cmd.type==='on'){
            if(s.enabled){await send('🍆 Рубрика уже включена. Автоматической рассылки пока нет. Запуск: «хуинглиш урок 1».');return;}
            const today=day(timeZone,now());
            if(s.last_day===today && runStmt.get(peerId)?.status==='finished'){
                await send('📚 Урок №1 сегодня уже прошёл. Повторный запуск — завтра.');return;
            }
            if(s.last_day===today && runStmt.get(peerId)?.status==='paused'){
                const r=runStmt.get(peerId);
                saveState.run(peerId,1,s.last_day,now());
                finishPart.run('running',r.next_part,now(),r.failures,now(),peerId);
                await deliver();return;
            }
            await intro();
            const times=planHuinglishParts(now(),rng);
            saveState.run(peerId,1,today,now());
            saveRun.run(peerId,1,'running',1,times[0],JSON.stringify(times),0,now());
            await deliver();
            logger.info('[HUINGLISH ENABLED]','peer='+peerId,'auto=off','lesson=1');
            return;
        }
        if(cmd.type==='off'){
            saveState.run(peerId,0,s.last_day,now());
            const run=runStmt.get(peerId);
            if(run?.status==='running')finishPart.run('paused',run.next_part,run.due_at,run.failures,now(),peerId);
            await send('🍆 Хуинглиш выключен в беседе. Отправка остановлена.');
            return;
        }
        if(cmd.type==='lesson'){
            if(!lessonStmt.get(cmd.id)){await send('📚 Урок №'+cmd.id+' пока не готов. Сейчас сохранено уроков: '+countStmt.get().n+'.');return;}
            if(!s.enabled){await send('🍆 Сначала включи рубрику: «хуинглиш вкл».');return;}
            if(runStmt.get(peerId)?.status==='running'){await send('📖 Урок уже идёт. Продолжение: «хуинглиш далее».');return;}
            const today=day(timeZone,now());
            if(s.last_day===today){await send('📚 Сегодня урок уже запускали. Новый — завтра.');return;}
            const times=planHuinglishParts(now(),rng);
            saveState.run(peerId,1,today,now());
            saveRun.run(peerId,cmd.id,'running',1,times[0],JSON.stringify(times),0,now());
            await deliver();return;
        }
        if(cmd.type==='next'){
            if(!s.enabled){await send('🍆 Сначала включи рубрику: «хуинглиш вкл».');return;}
            const run=runStmt.get(peerId);
            if(!run||run.status!=='running'){await send('📚 Нет текущего урока. Начни: «хуинглиш урок 1».');return;}
            if(busy.has(peerId)){await send('⏳ Предыдущая часть ещё отправляется.');return;}
            finishPart.run('running',run.next_part,now(),run.failures,now(),peerId);
            await deliver();
        }
    }
    return {
        handle(peer,text){
            if(Number(peer)!==Number(peerId))return false;
            const cmd=parseHuinglishCommand(text);
            if(!cmd)return false;
            commandQueue=commandQueue.then(()=>new Promise(resolve=>setImmediate(resolve))).then(()=>execute(cmd)).catch(e=>logger.error('[HUINGLISH COMMAND ERROR]',String(e?.message||e)));
            return true;
        },
        start(){
            if(timer)return;
            timer=setInterval(()=>{void deliver().catch(e=>logger.error('[HUINGLISH TICK ERROR]',String(e?.message||e)));},15000);
            timer.unref?.();
            logger.info('[HUINGLISH READY]', 'peer='+peerId,'lessons='+countStmt.get().n,'auto=off');
        },
        inspect(){return {lessons:countStmt.get().n,state:stateStmt.get(peerId),run:runStmt.get(peerId),auto:false,windows:HUINGLISH_SCHEDULE_WINDOWS};},
        close(){stopped=true;if(timer)clearInterval(timer);db.close();}
    };
}

export { INTRO as HUINGLISH_INTRO };
