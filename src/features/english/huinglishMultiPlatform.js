import { DatabaseSync } from 'node:sqlite';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import { resolveRuntimeDataDirectory, resolveMainDatabasePath, assertTestDatabaseIsolation } from '../../infrastructure/database/runtimePaths.js';
import { parseHuinglishCommand, pickHuinglishStartMinute, planHuinglishParts, HUINGLISH_INTRO } from './huinglishVkLesson.js';
import { createHuinglishQuiz } from './huinglishQuiz.js';
import { pickHuinglishSitePromo } from './huinglishSitePromos.js';
import { addHuinglishActiveMilliseconds, nextHuinglishActiveTime, isHuinglishQuietTime } from './huinglishQuietHours.js';

const TEST_GROUP = '2000000008';
const pad = n => String(n).padStart(2,'0');
function localTime(now,tz) {
    const p=new Intl.DateTimeFormat('en-GB',{timeZone:tz,year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hourCycle:'h23'}).formatToParts(new Date(now));
    const v=Object.fromEntries(p.filter(x=>x.type!=='literal').map(x=>[x.type,Number(x.value)]));
    return {day:[v.year,pad(v.month),pad(v.day)].join('-'), minute:v.hour*60+v.minute};
}
function localEpoch(day,minute,tz) {
    const [y,m,d]=day.split('-').map(Number),epoch=Date.UTC(y,m-1,d,Math.floor(minute/60),minute%60);
    const zone=new Intl.DateTimeFormat('en-US',{timeZone:tz,timeZoneName:'shortOffset'}).formatToParts(new Date(epoch)).find(x=>x.type==='timeZoneName')?.value||'GMT';
    const mo=/GMT([+-])(\d{1,2})(?::(\d{2}))?/.exec(zone);
    const offset=mo?(mo[1]==='-'?-1:1)*(Number(mo[2])*60+Number(mo[3]||0)):0;
    return epoch-offset*60000;
}
export function scheduleHuinglishRelease(now,tz='Europe/Moscow',random=Math.random) {
    const loc=localTime(now,tz);
    const weighted=[{a:600,b:720,w:4},{a:720,b:960,w:3},{a:960,b:1080,w:2}];
    if(loc.minute<1080){
        const options=weighted.map(w=>({...w,a:Math.max(w.a,loc.minute)})).filter(w=>w.a<w.b);
        const total=options.reduce((s,w)=>s+w.w,0);
        let draw=random()*total;
        const w=options.find(x=>(draw-=x.w)<0)||options.at(-1);
        const minute=w.a+Math.floor(random()*(w.b-w.a));
        return Math.max(now,localEpoch(loc.day,minute,tz));
    }
    const [y,m,d]=loc.day.split('-').map(Number);
    const tomorrow=new Date(Date.UTC(y,m-1,d+1)).toISOString().slice(0,10);
    return localEpoch(tomorrow,pickHuinglishStartMinute(random),tz);
}
import {ensureHuinglishSchema,validateHuinglishParts} from './huinglishStore.js';
import {buildChtivoReplyForward,resolveChtivoConversationMessageId} from '../chtivo/chtivoReplyTarget.js';
import {buildTelegramMainMenu,buildTelegramHuinglishMenu,buildTelegramHuinglishLessonPickerMenu} from '../../platforms/telegram/telegramBot.js';
// A group lesson is a scheduled broadcast, not a chat command tutorial.
// The original parts stay intact in SQLite for private DMs and audit.
// Suppress on-screen "huinglish далее" prompts for public groups.
export function formatHuinglishPartForAudience(body,{isGroup=false,isFinal=false,lessonId=0,hasNext=false}={}) {
    if(!isGroup)return String(body);
    let text=String(body).split('\n').filter(line=>
        !/хуинглиш\s+(?:далее|следующий\s+урок|урок\s+\d+)/iu.test(line) &&
        !/^\s*(?:✅|🏙)\s*Урок\s*№?\d+\s+завершён/iu.test(line)
    ).join('\n').replace(/\n{3,}/gu,'\n\n').trimEnd();
    if(isFinal) {
        const ending='✅ Урок №'+lessonId+' завершён. '+(hasNext?'Следующий урок придёт завтра.':'Новый урок появится, когда будет готов.');
        if(text.length+(text.match(/\n/g)||[]).length+ending.length+4<=4096)text+='\n\n'+ending;
    }
    return text;
}

export function createHuinglishMultiPlatform({vk,telegramBot,now=Date.now,random=Math.random,timeZone='Europe/Moscow',logger=console,dataDir=resolveRuntimeDataDirectory(),dbPath=resolveMainDatabasePath(),sitePromosEnabled=true}={}) {
    assertTestDatabaseIsolation({databasePath:dbPath});
    const db=new DatabaseSync(dbPath);
    db.exec('PRAGMA busy_timeout=2000');
    ensureHuinglishSchema(db,{dataDir,intro:HUINGLISH_INTRO,now});
    const quiz=createHuinglishQuiz({vk,db,now,logger,timeZone,sitePromosEnabled});
    const q={
        sub:db.prepare('SELECT * FROM huinglish_subscriptions WHERE platform=? AND peer_id=?'),
        run:db.prepare('SELECT * FROM huinglish_delivery_runs WHERE platform=? AND peer_id=?'),
        lesson:db.prepare('SELECT * FROM huinglish_lessons WHERE id=?'),
        parts:db.prepare('SELECT number,body FROM huinglish_parts WHERE lesson_id=? ORDER BY number'),
        published:db.prepare('SELECT id FROM huinglish_lessons WHERE published=1 ORDER BY id'),
        count:db.prepare('SELECT COUNT(*) n FROM huinglish_lessons WHERE published=1'),
        active:db.prepare('SELECT * FROM huinglish_subscriptions WHERE enabled=1'),
        putSub:db.prepare('INSERT OR REPLACE INTO huinglish_subscriptions(platform,peer_id,chat_kind,thread_id,enabled,completed_lesson,last_launch_day,scheduled_lesson,scheduled_at,updated_at,completed_lessons_json,scheduled_kind) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)'),
        putRun:db.prepare('INSERT OR REPLACE INTO huinglish_delivery_runs(platform,peer_id,lesson_id,status,next_part,due_at,plan,failures,started_at,updated_at,parts_json,last_message_json,last_error) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)'),
    };
    db.exec("CREATE TABLE IF NOT EXISTS huinglish_private_reminders(platform TEXT NOT NULL, peer_id TEXT NOT NULL, next_at INTEGER NOT NULL DEFAULT 0, opted_out INTEGER NOT NULL DEFAULT 0, PRIMARY KEY(platform,peer_id))");
    db.exec("CREATE TABLE IF NOT EXISTS huinglish_menu_prompts(platform TEXT NOT NULL,peer_id TEXT NOT NULL,expires_at INTEGER NOT NULL,PRIMARY KEY(platform,peer_id))");
    for(const [table,cols] of [['huinglish_menu_prompts',{token:'TEXT NOT NULL DEFAULT \'\''}],['huinglish_private_reminders',{pending_token:'TEXT NOT NULL DEFAULT \'\'',pending_until:'INTEGER NOT NULL DEFAULT 0'}]]) {
        const existing=new Set(db.prepare('PRAGMA table_info('+table+')').all().map(c=>c.name));
        for(const [name,type] of Object.entries(cols))if(!existing.has(name))db.exec('ALTER TABLE '+table+' ADD COLUMN '+name+' '+type);
    }
    const menuGet=db.prepare('SELECT expires_at,token FROM huinglish_menu_prompts WHERE platform=? AND peer_id=?');
    const menuPut=db.prepare('INSERT INTO huinglish_menu_prompts(platform,peer_id,expires_at,token) VALUES(?,?,?,?) ON CONFLICT(platform,peer_id) DO UPDATE SET expires_at=excluded.expires_at,token=excluded.token');
    const menuDelete=db.prepare('DELETE FROM huinglish_menu_prompts WHERE platform=? AND peer_id=?');
    const reminderGet=db.prepare('SELECT * FROM huinglish_private_reminders WHERE platform=? AND peer_id=?');
    const reminderPut=db.prepare("INSERT INTO huinglish_private_reminders(platform,peer_id,next_at,opted_out,pending_token,pending_until) VALUES(?,?,?,?, '',0) ON CONFLICT(platform,peer_id) DO UPDATE SET next_at=excluded.next_at,opted_out=excluded.opted_out,pending_token='',pending_until=0");
    const reminderPrompt=db.prepare('UPDATE huinglish_private_reminders SET next_at=?,pending_token=?,pending_until=? WHERE platform=? AND peer_id=?');
    const token=()=>randomBytes(6).toString('hex');
    const DAY=86400000;
    const nextUnfinished=s=>q.published.all().find(row=>!Object.hasOwn(history(s),String(row.id)))?.id;
    const completedToday=s=>Object.values(history(s)).includes(localTime(now(),timeZone).day);
    const reminderState=s=>reminderGet.get(s.platform,s.peer_id);
    const setReminder=(s,at,optedOut=0)=>reminderPut.run(s.platform,s.peer_id,at,optedOut);
    const isPrivate=s=>s.chat_kind==='private';
    const quietAudience=s=>isPrivate(s)?'private':'group';
    const quietNow=s=>isHuinglishQuietTime(now(),timeZone,quietAudience(s));
    const folder=join(dataDir,'english-huinglish'),queues=new Map();
    let timer=null,closing=false,ticking=false,controlSequence=0;
    const key=s=>s.platform+':'+s.peer_id;
    const parse=(value,fallback)=>{try{return JSON.parse(value)}catch{return fallback}};
    const history=s=>parse(s.completed_lessons_json,{});
    const putSub=s=>q.putSub.run(s.platform,s.peer_id,s.chat_kind,s.thread_id,s.enabled,s.completed_lesson,s.last_launch_day,s.scheduled_lesson,s.scheduled_at,now(),s.completed_lessons_json||'{}',s.scheduled_kind||'auto');
    const putRun=r=>q.putRun.run(r.platform,r.peer_id,r.lesson_id,r.status,r.next_part,r.due_at,r.plan,r.failures,r.started_at,now(),r.parts_json||'[]',r.last_message_json||'{}',r.last_error||'');
    const parts=n=>validateHuinglishParts(q.parts.all(n));
    function makeSub(c) {
        return q.sub.get(c.platform,c.peerId)||{platform:c.platform,peer_id:c.peerId,chat_kind:c.isPrivate?'private':'group',thread_id:c.threadId||0,enabled:0,completed_lesson:0,completed_lessons_json:'{}',last_launch_day:'',scheduled_lesson:0,scheduled_at:0,scheduled_kind:'auto'};
    }
    // Old VK-only installations are migrated once, never started as a second sender.
    const hasLegacy=db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='huinglish_settings'").get();
    if(hasLegacy&&!q.sub.get('vk',TEST_GROUP)) {
        const old=db.prepare('SELECT * FROM huinglish_settings WHERE peer_id=?').get(Number(TEST_GROUP));
        if(old) {
            const hasRuns=db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='huinglish_runs'").get();
            const run=hasRuns?db.prepare('SELECT * FROM huinglish_runs WHERE peer_id=?').get(Number(TEST_GROUP)):null;
            const done=run?.status==='finished'?run.lesson_id:0;
            putSub({platform:'vk',peer_id:TEST_GROUP,chat_kind:'group',thread_id:0,enabled:old.enabled,completed_lesson:done,completed_lessons_json:JSON.stringify(Object.fromEntries(q.published.all().filter(x=>x.id<=done).map(x=>[x.id,old.last_day]))),last_launch_day:old.last_day,scheduled_lesson:0,scheduled_at:0});
            if(run)putRun({...run,platform:'vk',peer_id:TEST_GROUP,started_at:parse(run.plan,[])[0]||now()});
            logger.info('[HUINGLISH MIGRATED]','peer='+TEST_GROUP,'part='+(run?.next_part||0));
        }
    }
    function enqueue(s,task) {
        const k=key(s),previous=queues.get(k)||Promise.resolve();
        // A failed command must not poison commands already queued behind it.
        const promise=previous.catch(()=>{}).then(()=>new Promise(resolve=>setImmediate(resolve))).then(task);
        queues.set(k,promise);
        void promise.catch(()=>{}).finally(()=>{if(queues.get(k)===promise)queues.delete(k)});
        return promise;
    }
    async function send(s,text,{photo=false,tag='',reply=null,image='intro_vk.jpg',reminderButtons=false,lessonMenuButtons=false,removeKeyboard=false,buttonToken='',telegramReplyMarkup=null}={}) {
        if(text.length>4096 || (s.platform==='vk'&&text.length+(text.match(/\n/g)||[]).length>4096))throw Error('HuInglish message exceeds platform limit');
        if(s.platform==='vk') {
            // Lesson tags survive retries/restarts; control replies are distinct requests.
            const seed=key(s)+'|'+(tag||'control:'+now()+':'+(++controlSequence))+'|'+text;
            const random_id=(createHash('sha256').update(seed).digest().readUInt32BE(0)&0x7fffffff)||1;
            const args={peer_ids:[Number(s.peer_id)],random_id,message:text};
            if(reminderButtons)args.keyboard=JSON.stringify({inline:true,buttons:[
                [{action:{type:'text',label:'Да'},color:'positive'}],
                [{action:{type:'text',label:'Нет, спросить через неделю'},color:'secondary'}],
                [{action:{type:'text',label:'Больше не предлагать'},color:'negative'}]
            ]});
            if(reply?.conversationMessageId)args.forward=buildChtivoReplyForward(s.peer_id,reply.conversationMessageId);
            else if(reply?.messageId)args.reply_to=reply.messageId;
            if(photo) {
                const file=join(folder,image);
                if(!existsSync(file))throw Error('Missing huinglish intro photo');
                const attachment=String(await vk.upload.messagePhoto({source:{value:readFileSync(file),filename:'huinglish-intro.jpg'}}));
                if(!attachment.startsWith('photo'))throw Error('Invalid VK photo attachment');
                args.attachment=attachment;
            }
            const result=await vk.api.messages.send(args);
            const delivered=Array.isArray(result)?result.find(item=>Number(item.peer_id)===Number(s.peer_id)):result;
            if(delivered?.error||delivered?.error_code) {
                const error=delivered.error||delivered;
                throw Error(error.error_msg||error.message||'VK lesson delivery failed');
            }
            return result;
        }
        const chatId=s.peer_id,messageThreadId=s.thread_id||null;
        const replyParameters=reply?.messageId?{message_id:reply.messageId,allow_sending_without_reply:false}:null;
        if(photo) {
            if(text.length>1024)throw Error('HuInglish intro caption exceeds Telegram limit');
            const file=join(folder,image);
            if(!existsSync(file))throw Error('Missing huinglish intro photo');
            const buffer=readFileSync(file);
            if(typeof telegramBot?.api?.call==='function') {
                const form=new FormData();
                form.set('chat_id',chatId);
                if(messageThreadId)form.set('message_thread_id',String(messageThreadId));
                form.set('caption',text);form.set('photo',new Blob([buffer],{type:'image/jpeg'}),'huinglish-intro.jpg');
                return telegramBot.api.call('sendPhoto',form,{multipart:true,timeoutMs:45_000});
            }
            return telegramBot.api.sendPhoto({chatId,messageThreadId,photo:{buffer,filename:'huinglish-intro.jpg',mimeType:'image/jpeg'},caption:text});
        }
        if(typeof telegramBot?.api?.call==='function')
            return telegramBot.api.call('sendMessage',{chat_id:chatId,text,
                ...(messageThreadId?{message_thread_id:messageThreadId}:{}),
                ...(replyParameters?{reply_parameters:replyParameters}:{}),
                link_preview_options:{is_disabled:true},
                ...(telegramReplyMarkup?{reply_markup:telegramReplyMarkup}:removeKeyboard?{reply_markup:{remove_keyboard:true}}:lessonMenuButtons?{reply_markup:{inline_keyboard:[[
                    {text:'Да',callback_data:'huinglish:menu:yes:'+buttonToken},
                    {text:'Нет',callback_data:'huinglish:menu:no:'+buttonToken}
                ]]}}:reminderButtons?{reply_markup:{inline_keyboard:[
                    [{text:'Да',callback_data:'huinglish:reminder:yes:'+buttonToken}],
                    [{text:'Нет, спросить через неделю',callback_data:'huinglish:reminder:later:'+buttonToken}],
                    [{text:'Больше не предлагать',callback_data:'huinglish:reminder:never:'+buttonToken}]
                ]}}:{}),
            },{timeoutMs:45_000});
        return telegramBot.api.sendMessage({chatId,messageThreadId,text,...(replyParameters?{replyToMessageId:reply.messageId}: {}),...(telegramReplyMarkup?{replyMarkup:telegramReplyMarkup}:removeKeyboard?{replyMarkup:{removeKeyboard:true}}:lessonMenuButtons?{replyMarkup:{inline_keyboard:[[{text:'Да',callback_data:'huinglish:menu:yes:'+buttonToken},{text:'Нет',callback_data:'huinglish:menu:no:'+buttonToken}]]}}:reminderButtons?{replyMarkup:{inline_keyboard:[[{text:'Да',callback_data:'huinglish:reminder:yes:'+buttonToken}],
                    [{text:'Нет, спросить через неделю',callback_data:'huinglish:reminder:later:'+buttonToken}],[{text:'Больше не предлагать',callback_data:'huinglish:reminder:never:'+buttonToken}]]}}:{})});
    }
    async function sendSitePromo(s,deliveryTag) {
        if(!sitePromosEnabled)return;
        try {
            const tag='site-promo:'+deliveryTag;
            await send(s,pickHuinglishSitePromo(key(s)+':'+tag),{tag});
        } catch(error) {
            // A failed optional link must not retry or block the actual lesson.
            logger.warn?.('[HUINGLISH SITE PROMO SEND ERROR]',key(s),String(error?.message||error));
        }
    }
    function receipt(s,sent) {
        const value=Array.isArray(sent)?sent.find(item=>String(item.peer_id)===s.peer_id)||sent[0]:sent;
        const id=Number(value?.message_id??value?.messageId??value?.id??(typeof value==='number'?value:0));
        const cmid=s.platform==='vk'?Number(value?.conversation_message_id??value?.conversationMessageId??0):0;
        return {messageId:Number.isSafeInteger(id)&&id>0?id:0,conversationMessageId:Number.isSafeInteger(cmid)&&cmid>0?cmid:0};
    }
    function runParts(run) {
        const plan=parse(run.plan,[]);
        let body=parse(run.parts_json,[]);
        if(!body.length) {
            body=parts(run.lesson_id);
            if(plan.length!==body.length)throw Error('Урок изменён: невозможно безопасно продолжить старый запуск');
            run.parts_json=JSON.stringify(body);putRun(run);
        }
        validateHuinglishParts(body);
        if(plan.length!==body.length||!plan.every(Number.isFinite)||!Number.isInteger(run.next_part)||run.next_part<1||run.next_part>body.length)
            throw Error('Повреждён план урока');
        return {body,plan};
    }
    async function previousPart(s,run,body) {
        let saved=parse(run.last_message_json,{});
        if(s.platform==='vk'&&!saved.conversationMessageId) {
            if(saved.messageId)saved.conversationMessageId=await resolveChtivoConversationMessageId(vk.api,{id:saved.messageId});
            if(!saved.conversationMessageId&&!saved.messageId&&db.prepare("SELECT name FROM sqlite_master WHERE name='vk_message_archive'").get()) {
                const row=db.prepare('SELECT conversation_message_id FROM vk_message_archive WHERE peer_id=? AND is_outbox=1 AND text=? AND created_at>=? ORDER BY conversation_message_id DESC LIMIT 1')
                    .get(Number(s.peer_id),formatHuinglishPartForAudience(body[run.next_part-2],{isGroup:!isPrivate(s),isFinal:false,lessonId:run.lesson_id}),Math.floor(run.started_at/1000));
                saved.conversationMessageId=Number(row?.conversation_message_id||0);
            }
        }
        if(!saved.messageId&&!saved.conversationMessageId)throw Error('Не найдено предыдущее сообщение бота; отправка без цепочки остановлена');
        return saved;
    }
    function activeLessonDue(run,s) {
        if(!run||!Number.isFinite(Number(run.due_at)))return Infinity;
        const planned=nextHuinglishActiveTime(Number(run.due_at),timeZone,quietAudience(s));
        if(run.next_part<=1)return planned;
        const times=parse(run.plan,[]);
        const previous=Number(times[run.next_part-2]);
        const next=Number(times[run.next_part-1]);
        if(!Number.isFinite(previous)||!Number.isFinite(next)||next<previous)return planned;
        const lastActual=Number(run.updated_at)||Number(run.started_at);
        if(!Number.isFinite(lastActual)||lastActual<=0)return planned;
        // Resume the planned gap from the LAST actual part; 01:30..06:30
        // is excluded, including plans stored before the night-pause update.
        return Math.max(planned,addHuinglishActiveMilliseconds(lastActual,next-previous,timeZone,quietAudience(s)));
    }
    async function deliver(s,{manual=false}={}) {
        const sub=q.sub.get(s.platform,s.peer_id),run=q.run.get(s.platform,s.peer_id);
        if(closing||!sub?.enabled||run?.status!=='running'||quietNow(s)||(!manual&&activeLessonDue(run,s)>now()))return;
        let body,plan;
        try { ({body,plan}=runParts(run)); }
        catch(error) {run.status='paused';run.last_error=String(error.message);putRun(run);logger.error('[HUINGLISH INVALID RUN]',key(s),run.last_error);return;}
        try {
            const reply=run.next_part>1?await previousPart(sub,run,body):null;
            const completed=run.next_part===body.length;
            const remaining=q.published.all().some(row=>row.id>run.lesson_id&&!Object.hasOwn(history(sub),String(row.id)));
            const displayed=formatHuinglishPartForAudience(body[run.next_part-1],{isGroup:!isPrivate(sub),isFinal:completed,lessonId:run.lesson_id,hasNext:remaining});
            const sent=await send(sub,displayed,{tag:'lesson:'+run.lesson_id+':part:'+run.next_part+':'+run.started_at,reply});
            const target=receipt(sub,sent);
            run.last_message_json=JSON.stringify(target);
            run.next_part++;run.status=completed?'finished':'running';run.due_at=completed?0:plan[run.next_part-1];run.failures=0;run.last_error='';
            // Missing receipt must never cause the already-sent part to be sent again.
            if(!completed&&!target.messageId&&!target.conversationMessageId){run.status='paused';run.last_error='Отправлено без ID сообщения; цепочка требует восстановления';}
            db.exec('BEGIN IMMEDIATE');
            try {
                putRun(run);
                if(completed) {
                    const fresh=q.sub.get(s.platform,s.peer_id),done=history(fresh);
                    done[run.lesson_id]=localTime(now(),timeZone).day;
                    fresh.completed_lessons_json=JSON.stringify(done);
                    fresh.completed_lesson=Math.max(fresh.completed_lesson,run.lesson_id);putSub(fresh);
                }
                db.exec('COMMIT');
            } catch(error) {db.exec('ROLLBACK');throw error;}
            // Keep a precise VK message receipt for future quiz explanations.
            // Recording is best-effort and cannot break normal lesson delivery.
            if(s.platform==='vk'&&(target.messageId||target.conversationMessageId)){
                try {
                    quiz.lessonReference.record({platform:'vk',peerId:s.peer_id,
                        lessonId:run.lesson_id,partNumber:run.next_part-1,
                        messageId:target.messageId,conversationMessageId:target.conversationMessageId,
                        sentAt:now()});
                } catch(error) {
                    logger.warn?.('[HUINGLISH QUIZ LESSON RECEIPT ERROR]',String(error?.message||error));
                }
            }
            logger.info('[HUINGLISH PART SENT]',key(s),'lesson='+run.lesson_id,'part='+(run.next_part-1));
            await sendSitePromo(sub,'lesson:'+run.lesson_id+':part:'+(run.next_part-1)+':'+run.started_at);
            if(completed&&isPrivate(s)) {
                const pending=nextUnfinished(q.sub.get(s.platform,s.peer_id));
                if(isPrivate(s)&&pending&&!reminderState(s)?.opted_out)setReminder(s,now()+8*DAY);
                try {await send(s,pending
                    ?'✅ Урок №'+run.lesson_id+' завершён! Следующий урок: «хуинглиш следующий урок» или «хуинглиш далее». Сегодня повторного запуска не будет — следующий доступен с завтрашнего дня.'
                    :'✅ Урок №'+run.lesson_id+' завершён! Новых опубликованных уроков пока нет.');}
                catch(error){logger.error('[HUINGLISH COMPLETION HINT ERROR]',key(s),String(error?.message||error));}
            }
        } catch(error) {
            run.failures++;run.status=run.failures>=3?'paused':'running';run.due_at=now()+30_000*run.failures;run.last_error=String(error?.message||error);putRun(run);
            logger.error('[HUINGLISH SEND ERROR]',key(s),run.last_error);
        }
    }
    async function resume(s,run) {
        if(run.status==='paused') {
            const plan=parse(run.plan,[]),due=plan[run.next_part-1];
            if(Number.isFinite(due))run.plan=JSON.stringify(plan.map(at=>at+now()-due));
        }
        run.status='running';run.failures=0;run.due_at=now();run.last_error='';putRun(run);await deliver(s,{manual:true});
    }
    async function startLesson(s,n,{intro=false,manual=false,scheduled=false,restart=false}={}) {
        if(quietNow(s)){
            s.scheduled_kind='manual';s.scheduled_lesson=n;
            s.scheduled_at=nextHuinglishActiveTime(now(),timeZone,quietAudience(s));
            putSub(s);return;
        }
        const lesson=q.lesson.get(n);
        if(!lesson?.published){await send(s,'📚 Урок №'+n+' пока не готов. В базе '+q.count.get().n+' урок(ов).');return;}
        let bodies;
        try{bodies=parts(n)}catch{await send(s,'📚 Урок №'+n+' ещё не готов к отправке: проверь полноту и длину частей.');return;}
        const previous=q.run.get(s.platform,s.peer_id);
        if(!restart&&previous&&['running','paused'].includes(previous.status)) {
            if(previous.status==='paused'&&previous.lesson_id===n){await resume(s,previous);return;}
            await send(s,'📖 Урок №'+previous.lesson_id+' ещё не завершён. Продолжение: «хуинглиш далее».');return;
        }
        const today=localTime(now(),timeZone).day;
        if(manual&&!restart&&history(s)[n]===today){await send(s,'📚 Сегодня этот урок уже был. Повторить можно завтра.');return;}
        if(intro) {
            await send(s,lesson.intro_text+'\n\nПервая часть урока — следом.',{photo:true,tag:'intro:'+n+':'+today,image:lesson.intro_image});
            await sendSitePromo(s,'intro:'+n+':'+today);
        }
        const startedAt=Math.max(now(),Number(previous?.started_at||0)+1),plan=planHuinglishParts(now(),random,bodies.length);
        s.last_launch_day=today;
        if(scheduled||s.scheduled_kind!=='manual'){s.scheduled_lesson=0;s.scheduled_at=0;s.scheduled_kind='auto';}
        db.exec('BEGIN IMMEDIATE');
        try {
            putSub(s);
            putRun({platform:s.platform,peer_id:s.peer_id,lesson_id:n,status:'running',next_part:1,due_at:now(),plan:JSON.stringify(plan),parts_json:JSON.stringify(bodies),last_message_json:'{}',last_error:'',failures:0,started_at:startedAt});
            db.exec('COMMIT');
        }catch(error){db.exec('ROLLBACK');throw error;}
        await deliver(s);
    }
    async function command(c,cmd) {
        const s=makeSub(c),run=q.run.get(s.platform,s.peer_id);
        const replyAt={...s,thread_id:c.threadId||0};
        if(cmd.type.startsWith('quiz')){
            if(s.platform==='vk')await quiz.command(c,cmd);
            else await send(replyAt,'🌭 Тесты с кнопками сейчас доступны во ВКонтакте. Обычные уроки в Telegram продолжают работать.');
            return;
        }
        if(cmd.type==='exit'){
            if(s.platform!=='telegram'||!c.isPrivate)return;
            menuDelete.run(s.platform,s.peer_id);
            await send(replyAt,'Главное меню. Если урок уже идёт, его части продолжат приходить по расписанию.',{telegramReplyMarkup:buildTelegramMainMenu({isOwner:c.isOwner})});
            return;
        }
        if(cmd.type==='section'){
            if(s.platform==='telegram'&&c.isPrivate)menuDelete.run(s.platform,s.peer_id);
            if(s.platform==='telegram'&&c.isPrivate)await send(replyAt,'🌭 Раздел HuInglish. Продолжить урок, открыть пройденные уроки или вернуться назад.',{telegramReplyMarkup:buildTelegramHuinglishMenu({isOwner:c.isOwner})});
            return;
        }
        if(cmd.type==='list'){
            if(s.platform!=='telegram'||!c.isPrivate)return;
            menuDelete.run(s.platform,s.peer_id);
            const published=q.published.all();
            const done=history(s);
            const topics={
                1:'Приветствия, общение с друзьями, прощания и сленг США, Британии и Австралии',
                2:'Тусовки, бар, планы на вечер, вход, музыка и танцы',
                3:'Реакции, согласие и сомнения, забывчивость и повседневные ответы',
                4:'Отмена планов, переписка, шутки, настроение, музыка и современный сленг',
                5:'Встречи с друзьями, планы, приглашения и переписка',
                6:'Повторение ходовых и сложных выражений из уроков №1–4 — пять контекстных частей',
                7:'Шутки с друзьями, поддержка, угощения, британский и австралийский английский'
            };
            const lines=['📚 HuInglish — темы уроков:',''];
            const completedIds=[];
            for(const r of published){
                const completed=Object.hasOwn(done,String(r.id));
                if(completed)completedIds.push(r.id);
                lines.push((completed?'✅ ':'🔒 ')+'Урок '+r.id+' — '+(topics[r.id]||q.lesson.get(r.id)?.title||'Разговорный английский'));
            }
            lines.push('');
            lines.push(completedIds.length?'Кнопки с номерами ниже — только уже пройденные уроки. Нажми цифру для повтора.':'Заверши первый урок, и здесь появится кнопка «1» для повтора.');
            lines.push('Новый урок: «хуинглиш далее».  ⬅️ Назад — в HuInglish.');
            await send(replyAt,lines.join('\n'),{telegramReplyMarkup:buildTelegramHuinglishLessonPickerMenu({lessonIds:completedIds})});
            return;
        }
        if(cmd.type==='reset'){
            if(!c.isOwner||!c.isPrivate||s.platform!=='telegram'){
                await send(replyAt,'⛔ Сброс HuInglish доступен только владельцу в личных сообщениях Telegram.');return;
            }
            db.exec('BEGIN IMMEDIATE');
            try {
                db.prepare('DELETE FROM huinglish_delivery_runs WHERE platform=? AND peer_id=?').run(s.platform,s.peer_id);
                db.prepare('DELETE FROM huinglish_subscriptions WHERE platform=? AND peer_id=?').run(s.platform,s.peer_id);
                db.prepare('DELETE FROM huinglish_private_reminders WHERE platform=? AND peer_id=?').run(s.platform,s.peer_id);
                db.prepare('DELETE FROM huinglish_menu_prompts WHERE platform=? AND peer_id=?').run(s.platform,s.peer_id);
                db.exec('COMMIT');
            } catch(error){db.exec('ROLLBACK');throw error;}
            await send(replyAt,'🔄 Твой личный прогресс HuInglish сброшен. Все уроки на месте, других пользователей это не затронуло. Нажми «🌭 Хуинглиш», чтобы заново увидеть приглашение к первому уроку.',{telegramReplyMarkup:buildTelegramMainMenu({isOwner:true})});
            return;
        }
        if(cmd.type==='menu'||cmd.type==='menuYes'||cmd.type==='menuNo'){
            if(!c.isPrivate||s.platform!=='telegram')return;
            const next=nextUnfinished(s),previous=Object.keys(history(s)).length>0,activeRun=run&&['running','paused'].includes(run.status);
            if(cmd.type==='menuYes'||cmd.type==='menuNo'){
                const saved=menuGet.get(s.platform,s.peer_id);
                if(!saved||saved.expires_at<=now()||saved.token!==cmd.token){await send(replyAt,'Эта кнопка уже недействительна. Нажми «🌭 Хуинглиш» ещё раз.');return;}
            }
            if(cmd.type==='menuNo'){menuDelete.run(s.platform,s.peer_id);await send(replyAt,'Хорошо, пока не начинаем. Возвращаю главное меню — когда захочешь, нажми «🌭 Хуинглиш» ещё раз.',{telegramReplyMarkup:buildTelegramMainMenu({isOwner:c.isOwner})});return;}
            if(cmd.type==='menuYes'){
                menuDelete.run(s.platform,s.peer_id);
                if(!s.enabled){s.enabled=1;s.chat_kind='private';s.thread_id=0;putSub(s);}
                const fresh=q.sub.get(s.platform,s.peer_id);
                const active=q.run.get(s.platform,s.peer_id);
                if(active&&['running','paused'].includes(active.status)){await resume(fresh,active);return;}
                const id=nextUnfinished(fresh);
                if(!id){const replay=active?.lesson_id||1;await send(fresh,'📚 Новых уроков в базе пока нет. Чтобы повторить предыдущий, напиши «хуинглиш урок '+replay+'» (или другой номер).');return;}
                if(completedToday(fresh)){
                    await send(fresh,'Сегодня урок уже закончен. Следующий можно запросить завтра: «хуинглиш далее».');return;}
                await startLesson(fresh,id,{manual:true});return;
            }
            if(!activeRun&&(completedToday(s)||!next)){
                menuDelete.run(s.platform,s.peer_id);
                const description=next
                    ?'✅ Сегодня урок уже завершён. Следующий урок №'+next+' можно будет запросить завтра командой «хуинглиш далее».'
                    :'📚 Новых уроков в базе пока нет. Уже пройденные можно повторить через «📚 Хуинглиш · уроки» или командой «хуинглиш урок 1» (укажи нужный номер).';
                await send(replyAt,description,{telegramReplyMarkup:buildTelegramHuinglishMenu({isOwner:c.isOwner})});
                return;
            }
            await send(replyAt,'🌭 Раздел «Хуинглиш» открыт. Здесь можно продолжать уроки, повторять пройденное и в любой момент вернуться назад.',{telegramReplyMarkup:buildTelegramHuinglishMenu({isOwner:c.isOwner})});
            const promptToken=token();
            menuPut.run(s.platform,s.peer_id,now()+1800000,promptToken);
            await send(replyAt,activeRun
                ?('🌭 Хуинглиш 🍆 — урок №'+run.lesson_id+' ещё не закончен. Уже отправлено частей: '+(run.next_part-1)+'. Хочешь продолжить его сейчас?')
                :previous
                ?(next?'🌭 Хуинглиш 🍆 — короткие уроки живого разговорного английского: реальные американские выражения, IPA-транскрипция, русское произношение, перевод, примеры, немного британского и австралийского сленга, а также история слов. Ты уже занимался! Хочешь посмотреть следующий урок №'+next+'?':'📚 Ты прошёл все опубликованные уроки HuInglish. Новых уроков в базе пока нет. Повторить можно командой «хуинглиш урок 1» (или другим номером).')
                :'🌭 Хуинглиш 🍆 — английский без скучной зубрёжки! В коротких уроках разбираем живые фразы, которые используют американцы в дружеских разговорах, переписке, на работе и тусовках. У каждой фразы есть IPA-транскрипция, подсказка произношения русскими буквами, перевод, примеры и разбор слов. Иногда добавляем британские и австралийские выражения, а в финале узнаём, откуда слова появились. Один урок приходит частями; «хуинглиш далее» ускоряет следующую часть. Хочешь посмотреть первый урок?',{lessonMenuButtons:activeRun||!previous||!!next,buttonToken:promptToken});
            return;
        }
        if(cmd.type==='reminderYes'||cmd.type==='reminderLater'||cmd.type==='reminderNever') {
            const reminder=reminderState(s);
            if(!isPrivate(s)||!s.enabled||!reminder?.pending_token||reminder.pending_token!==cmd.token||reminder.pending_until<=now()){
                await send(replyAt,'Это напоминание уже неактуально. Чтобы продолжить, напиши «хуинглиш далее».');return;
            }
            if(cmd.type==='reminderNever'){setReminder(s,0,1);await send(replyAt,'Хорошо, больше предлагать уроки не буду. Ты всегда можешь вернуться к ним, написав «хуинглиш далее».');return;}
            if(cmd.type==='reminderLater'){setReminder(s,now()+7*DAY);await send(replyAt,'Хорошо! Спрошу ещё раз через неделю.');return;}
            setReminder(s,now()+8*DAY);
            if(s.platform==='telegram'&&c.isPrivate)await send(replyAt,'🌭 Возвращаемся к урокам HuInglish. Внизу — продолжение и кнопка «Назад».',{telegramReplyMarkup:buildTelegramHuinglishMenu({isOwner:c.isOwner})});
            if(run?.status==='running'||run?.status==='paused'){await resume(s,run);return;}
            const next=nextUnfinished(s);
            if(!next){await send(replyAt,'Пока нет новых уроков.');return;}
            if(completedToday(s)){await send(replyAt,'Сегодня урок уже завершён. Следующий можно получить завтра командой «хуинглиш далее».');return;}
            await startLesson(s,next,{manual:true});return;
        }
        if(cmd.type==='status') {
            const scheduled=s.scheduled_at?'\nЗапланирован урок '+s.scheduled_lesson+': '+new Intl.DateTimeFormat('ru-RU',{timeZone,dateStyle:'short',timeStyle:'short'}).format(s.scheduled_at)+'.':'';
            await send(replyAt,'🍆 Подписка '+(s.enabled?'включена':'выключена')+'. Доставлено уроков: '+Object.keys(history(s)).length+'.'+
                (run?'\nУрок '+run.lesson_id+': '+({running:'идёт',paused:'приостановлен',finished:'завершён'}[run.status]||run.status)+', отправлено частей: '+(run.next_part-1)+'.':'')+
                (run?.last_error?'\nПричина: '+run.last_error:'')+scheduled);return;
        }
        if(s.enabled&&s.platform==='telegram'&&s.thread_id!==c.threadId&&cmd.type!=='off') {
            await send(replyAt,'🍆 Рубрика уже включена в другой теме этого чата. Продолжай там; для переноса выключи рубрику и включи её в нужной теме.');return;
        }
        if(cmd.type==='on') {
            if(s.platform==='telegram'&&c.isPrivate&&!/вкл\s*$/iu.test(c.rawText||''))await send(replyAt,'🌭 Хуинглиш 🍆 — можно продолжать или вернуться назад.',{telegramReplyMarkup:buildTelegramHuinglishMenu({isOwner:c.isOwner})});
            if(s.enabled) {
                if(run?.status==='paused'){await resume(s,run);return;}
                await send(replyAt,'🍆 Рубрика уже включена. Продолжение: «хуинглиш далее». Состояние: «хуинглиш статус».');return;
            }
            // A paused chain belongs to its original topic and must stay there.
            if(run&&['running','paused'].includes(run.status)&&s.thread_id!==c.threadId) {
                await send(replyAt,'🍆 Незавершённый урок находится в другой теме. Включи рубрику в исходной теме, чтобы сохранить цепочку.');return;
            }
            s.enabled=1;s.chat_kind=c.isPrivate?'private':'group';s.thread_id=c.threadId||0;putSub(s);
            if(run?.status==='paused'){await resume(s,run);return;}
            if(run?.status==='running'){await deliver(s);return;}
            if(s.scheduled_kind==='manual'&&s.scheduled_at>now()){await send(s,'🍆 Рубрика включена. Первая часть придёт в назначенное время.');return;}
            if(Object.keys(history(s)).length){await send(s,'🍆 Рубрика снова включена. Следующий ещё не пройденный урок придёт по расписанию, когда будет готов.');return;}
            try{await startLesson(s,1,{intro:!c.isPrivate});}catch(error){s.enabled=0;putSub(s);throw error;}
            return;
        }
        if(cmd.type==='off') {
            s.enabled=0;s.scheduled_lesson=0;s.scheduled_at=0;s.scheduled_kind='auto';putSub(s);
            if(run?.status==='running'){run.status='paused';putRun(run);}
            if(s.platform==='telegram'&&c.isPrivate)menuDelete.run(s.platform,s.peer_id);
            await send(replyAt,'🍆 Рубрика выключена. Автоматическая отправка и запланированный запуск отменены.',s.platform==='telegram'&&c.isPrivate?{telegramReplyMarkup:buildTelegramMainMenu({isOwner:c.isOwner})}:{});return;
        }
        if(!s.enabled){await send(replyAt,'🍆 Сначала включи рубрику: «хуинглиш вкл».');return;}
        if(cmd.type==='lesson'&&s.platform==='telegram'&&c.isPrivate){
            menuDelete.run(s.platform,s.peer_id);
            const lesson=q.lesson.get(cmd.id);
            if(!lesson?.published){await send(replyAt,'📚 Урока №'+cmd.id+' нет в базе опубликованных уроков.');return;}
            if(!Object.hasOwn(history(s),String(cmd.id))){await send(replyAt,'🔒 Урок №'+cmd.id+' ещё не пройден и недоступен для повтора. Для продолжения обучения используй «хуинглиш далее».');return;}
            await send(replyAt,'📖 Повторяем урок №'+cmd.id+'. Вернуться в раздел можно кнопкой «⬅️ Назад».',{telegramReplyMarkup:buildTelegramHuinglishMenu({isOwner:c.isOwner})});
        }
        if(cmd.type==='restart'){await startLesson(s,run?.lesson_id||1,{manual:true,restart:true});return;}
        if(cmd.type==='next') {
            if(s.platform==='telegram'&&c.isPrivate)menuDelete.run(s.platform,s.peer_id);
            if(run&&['running','paused'].includes(run.status)){await resume(s,run);return;}
            const next=nextUnfinished(s);
            if(!next){const replay=run?.lesson_id||Math.max(1,...Object.keys(history(s)).map(Number));await send(replyAt,'📚 Новых уроков в базе пока нет. Чтобы повторить предыдущий, напиши «хуинглиш урок '+replay+'» (или номер нужного урока).');return;}
            if(completedToday(s)){
                await send(replyAt,'✅ Сегодня урок №'+run.lesson_id+' уже завершён. Следующий урок станет доступен завтра.');return;
            }
            setReminder(s,now()+8*DAY,reminderState(s)?.opted_out||0);
            await startLesson(s,next,{manual:true});return;
        }
        if(cmd.type==='lesson')await startLesson(s,cmd.id,{manual:true,restart:run?.status==='finished'&&Object.hasOwn(history(s),String(cmd.id))});
    }
    async function tickOne(s) {
        s=q.sub.get(s.platform,s.peer_id);
        if(closing||!s?.enabled)return;
        const run=q.run.get(s.platform,s.peer_id);
        if(run?.status==='running') {
            // Never count the night pause as elapsed lesson time. The former
            // 55-minute catch-up shortcut would violate this contract.
            if(!quietNow(s)&&activeLessonDue(run,s)<=now())await deliver(s);
            return;
        }
        if(run?.status==='paused')return;
        if(s.scheduled_kind==='manual'&&s.scheduled_lesson) {
            if(!quietNow(s)&&s.scheduled_at<=now()&&(!run||history(s)[run.lesson_id]!==localTime(now(),timeZone).day))await startLesson(s,s.scheduled_lesson,{scheduled:true});
            return;
        }
        const next=nextUnfinished(s);
        if(isPrivate(s)){
            if(!next)return;
            const state=reminderState(s);
            if(!state){const completedAt=Number(run?.updated_at||now());setReminder(s,completedAt+8*DAY);if(completedAt+8*DAY>now())return;}
            if(quietNow(s))return; // private reminders never arrive overnight
            const current=reminderState(s);if(current.opted_out||!current.next_at||current.next_at>now())return;
            const promptToken=token();
            reminderPrompt.run(now()+7*DAY,promptToken,now()+7*DAY,s.platform,s.peer_id);
            try {await send(s,'👋 Привет! Давно не продолжали разговорный английский — Хуинглиш. Хочешь получить следующий урок по Хуинглишу №'+next+'?',{reminderButtons:true,buttonToken:promptToken});}
            catch(error){setReminder(s,now()+15*60000);throw error;}
            return;
        }
        if(!next)return;
        try{parts(next)}catch{return;}
        const loc=localTime(now(),timeZone),dueLocal=s.scheduled_at?localTime(s.scheduled_at,timeZone):null;
        if(run?.status==='finished'&&history(s)[run.lesson_id]===loc.day)return;
        if(s.scheduled_lesson!==next||!s.scheduled_at||(s.scheduled_at<=now()&&(dueLocal?.day!==loc.day||loc.minute<600||loc.minute>=1200))) {
            s.scheduled_lesson=next;s.scheduled_at=scheduleHuinglishRelease(now(),timeZone,random);putSub(s);
            logger.info('[HUINGLISH RELEASE PLANNED]',key(s),'lesson='+next,new Date(s.scheduled_at).toISOString());
        }
        if(!quietNow(s)&&s.scheduled_at<=now())await startLesson(s,next,{scheduled:true});
    }
    async function tick() {
        if(closing||ticking)return;
        ticking=true;
        try {
            const users=q.active.all().filter(s=>!queues.has(key(s)));
            for(let i=0;i<users.length;i+=4) {
                const result=await Promise.allSettled(users.slice(i,i+4).map(s=>enqueue(s,()=>tickOne(s))));
                for(const entry of result)if(entry.status==='rejected')logger.error('[HUINGLISH TICK TARGET ERROR]',String(entry.reason?.message||entry.reason));
            }
            await quiz.tick();
        } finally{ticking=false;}
    }
    function handle(c,onCompletion=null) {
        const incoming=String(c.text||'').trim().toLocaleLowerCase('ru-RU');
        const isButton=c.platform==='vk'&&['да','нет, спросить через неделю','больше не предлагать'].includes(incoming);
        const existing=isButton?q.sub.get(c.platform,String(c.peerId)):null;
        const pending=isButton&&existing?.chat_kind==='private'&&reminderGet.get(c.platform,String(c.peerId))?.next_at>0;
        const cmd=incoming==='хуинглиш раздел'?{type:'section'}:incoming==='хуинглиш выход'?{type:'exit'}:incoming==='хуинглиш список'?{type:'list'}:incoming==='хуинглиш сбросить'?{type:'reset'}:pending?{type:incoming==='да'?'reminderYes':incoming==='нет, спросить через неделю'?'reminderLater':'reminderNever',token:reminderGet.get(c.platform,String(c.peerId))?.pending_token}:incoming==='хуинглиш меню'?{type:'menu'}:parseHuinglishCommand(c.text);
        if(closing||!cmd||!['vk','telegram'].includes(c.platform)||!c.peerId)return false;
        // VK groups are opt-in by explicit HuInglish command; never auto-enable unrelated chats.
        // Previously hardcoded to a single test peer, which made other chats fall through to GPT.
        const meta={platform:c.platform,peerId:String(c.peerId),isPrivate:Boolean(c.isPrivate),threadId:Number(c.threadId)||0,isOwner:Boolean(c.isOwner),rawText:String(c.text||'')};
        const s={platform:meta.platform,peer_id:meta.peerId};
        const completion=enqueue(s,()=>command(meta,cmd));
        onCompletion?.(completion);
        void completion.catch(async error=>{
            logger.error('[HUINGLISH COMMAND ERROR]',key(s),String(error?.message||error));
            try{await send({...makeSub(meta),thread_id:meta.threadId},'🍆 Не удалось выполнить команду. Прогресс сохранён; состояние: «хуинглиш статус».');}catch{}
        });
        return true;
    }
    return {
        handle,
        handleVkQuizAnswer({peerId,userId,payload}) {
            if(closing||!peerId||!userId||payload?.action!=='huinglish_quiz')return Promise.resolve({ok:false,text:'Некорректная кнопка'});
            const state={platform:'vk',peer_id:String(peerId)};
            return enqueue(state,()=>quiz.answer({peerId:String(peerId),userId:String(userId),payload}));
        },
        handleCallback(c) {
            const match=/^huinglish:(menu|reminder):(yes|no|later|never):([a-f0-9]{12})$/.exec(String(c.data||''));
            if(!match||!c.isPrivate||c.platform!=='telegram'||!c.peerId)return false;
            if(match[1]==='menu'&&!['yes','no'].includes(match[2]))return false;
            if(match[1]==='reminder'&&match[2]==='no')return false;
            const cmd={type:match[1]==='menu'?(match[2]==='yes'?'menuYes':'menuNo'):({yes:'reminderYes',later:'reminderLater',never:'reminderNever'}[match[2]]),token:match[3]};
            const meta={platform:c.platform,peerId:String(c.peerId),isPrivate:true,isOwner:Boolean(c.isOwner),threadId:Number(c.threadId)||0};
            void enqueue({platform:meta.platform,peer_id:meta.peerId},()=>command(meta,cmd)).catch(error=>logger.error('[HUINGLISH CALLBACK ERROR]',String(error?.message||error)));
            return true;
        },tick,
        start(){if(timer||closing)return;timer=setInterval(()=>void tick().catch(e=>logger.error('[HUINGLISH TICK ERROR]',String(e?.message||e))),15000);timer.unref?.();logger.info('[HUINGLISH MULTIPLATFORM READY]','lessons='+q.count.get().n,'subscribers='+q.active.all().length);},
        inspect:(platform,id)=>({subscription:q.sub.get(platform,String(id)),run:q.run.get(platform,String(id)),lessons:q.count.get().n,quiz:platform==='vk'?quiz.inspect(String(id)):null}),
        async idle(){while(queues.size)await Promise.allSettled([...queues.values()]);},
        async close(){if(closing)return;closing=true;if(timer)clearInterval(timer);while(queues.size)await Promise.allSettled([...queues.values()]);db.close();},
    };
}
