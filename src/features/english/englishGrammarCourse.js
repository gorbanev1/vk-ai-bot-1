import {DatabaseSync} from 'node:sqlite';
import {createHash,randomBytes} from 'node:crypto';
import {resolveMainDatabasePath,resolveRuntimeDataDirectory,assertTestDatabaseIsolation} from '../../infrastructure/database/runtimePaths.js';
import {parseHuinglishQuizSuffix} from './huinglishQuiz.js';
import {isHuinglishQuietTime,nextHuinglishActiveTime,addHuinglishActiveMilliseconds} from './huinglishQuietHours.js';
import {buildChtivoReplyForward} from '../chtivo/chtivoReplyTarget.js';
import {ENGLISH_GRAMMAR_LESSONS} from './englishGrammarLessons.js';
import {ENGLISH_GRAMMAR_QUIZ_BANK} from './englishGrammarQuizBank.js';

const LESSONS=new Map(ENGLISH_GRAMMAR_LESSONS.map(item=>[item.id,item]));
const QUESTIONS=new Map(ENGLISH_GRAMMAR_QUIZ_BANK.map(item=>[item.id,item]));
const DAY=86400000, HOUR=3600000, MINUTE=60000, QUIZ_DEFAULT=6*HOUR;
const TTL=30*DAY;
const hash=value=>createHash('sha256').update(String(value)).digest().readUInt32BE(0);
const safeJson=(value,fallback)=>{try{return JSON.parse(String(value||''));}catch{return fallback;}};
const dayInZone=(millis,zone)=>new Intl.DateTimeFormat('en-CA',{timeZone:zone,year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date(millis));
const MAX_QUIZ_INTERVAL=72*HOUR;
const suppressTokens=new Set(['вкл','включить','включи']);

export function parseEnglishGrammarCommand(raw){
    const text=String(raw||'').normalize('NFKC').toLocaleLowerCase('ru-RU').replace(/ё/gu,'е')
        .replace(/^\s*(?:гигорейв|гиго\s*рейв|gigorave)\s*[,.:!?-]?\s*/iu,'')
        .replace(/[–—]/gu,'-').replace(/\s+/gu,' ').trim().replace(/[.!?]+$/gu,'');
    const prefix='(?:english|инглиш|инглишь|англиш|энглиш|английский)';
    const reordered=text.replace(new RegExp('^тесты ('+prefix+')(?: (.*))?$','u'),(_,name,tail)=>name+' тесты'+(tail?' '+tail:''));
    const m=new RegExp('^'+prefix+'(?: (.*))?$','u').exec(reordered);
    if(!m)return null;
    const suffix=String(m[1]||'').trim();
    if(!suffix||suppressTokens.has(suffix))return {type:'on'};
    if(/^(?:выкл|откл|выключи|выключить|отключить)$/u.test(suffix))return {type:'off'};
    if(/^тесты(?: (.*))?$/u.test(suffix))return parseHuinglishQuizSuffix((/^тесты(?: (.*))?$/u.exec(suffix)[1]||'').replace(/^vocal(?= |$)/u,'вкл'));
    if(/^(?:сразу )?не раскрывать правильный$/u.test(suffix))return {type:'quizHideCorrect'};
    if(/^(?:сразу )?раскрывать правильный$/u.test(suffix))return {type:'quizRevealCorrect'};
    if(/^(?:далее|продолжение|следующий|следующий урок)$/u.test(suffix))return {type:'next'};
    if(/^(?:заново|начать заново)$/u.test(suffix))return {type:'restart'};
    if(/^(?:статус|прогресс)$/u.test(suffix))return {type:'status'};
    if(/^(?:уроки|список)$/u.test(suffix))return {type:'list'};
    const lesson=/^(?:урок\s+|номер\s+|№\s*)?(\d{1,2})$/u.exec(suffix);
    if(lesson)return {type:'lesson',id:Number(lesson[1])};
    return null;
}

function keyboard(question){
    const picks=safeJson(question.options_json,[]);
    const item=QUESTIONS.get(question.question_id);
    if(!item||picks.length!==4||new Set(picks).size!==4||picks.some(x=>!Number.isInteger(x)||x<0||x>=4))
        throw Error('English quiz has invalid saved choices');
    return JSON.stringify({inline:true,buttons:picks.map((index,choice)=>[{
        action:{type:'callback',label:item.options[index].answer,
            payload:JSON.stringify({action:'english_quiz',token:question.token,choice})},
        color:'secondary',
    }])});
}
export function formatEnglishGrammarQuestion(item){
    return ['📚 ENGLISH · ТЕСТ · УРОК №'+item.lesson,
        '🧩 ЗАДАНИЕ (прочитай обязательно):',item.task,
        '',
        '🇬🇧 РЕПЛИКА СОБЕСЕДНИКА:',
        'A: '+item.lead,
        'B: «___»',
        '',
        'Выбери ОДНУ кнопку. Важно ответить именно на ЗАДАНИЕ, не только на реплику A.'].join('\n');
}
export function buildEnglishGrammarQuizExplanation({item,picked,correct,revealCorrect=true,short=false}={}){
    if(!item||!picked)throw Error('Missing English quiz explanation input');
    const right=correct&&picked.correct?picked:item.options[0];
    const lines=[correct?'✅ ПРАВИЛЬНО!':'❌ НЕПРАВИЛЬНО','','🧩 ЧТО ТРЕБОВАЛОСЬ ПО ЗАДАНИЮ:',item.task,
        '🇬🇧 A: '+item.lead,''];
    if(!correct){
        lines.push('❌ ТВОЙ ВАРИАНТ:','🇬🇧 '+picked.answer);
        if(picked.valid){
            lines.push('✅ Сама фраза грамматически правильная.',
                '💡 '+picked.why,
                '⚠️ Не выполняет указанное выше задание.');
        }else{
            lines.push('⚠️ Здесь ошибка в грамматике: разбираем выбранную форму:',
                '💡 В чём ошибка: '+picked.why);
            if(/\bdoes\s+you\b/iu.test(picked.answer)||/\bdo\s+(?:he|she|it)\b/iu.test(picked.answer))
                lines.push('📌 В Present Simple: you — 2-е лицо, с ним употребляют do; he/she/it — 3-е лицо единственного числа, с ними употребляют does.');
        }
        lines.push('');
    }
    if(correct||revealCorrect){
        lines.push(correct?'✅ ТВОЙ ПРАВИЛЬНЫЙ ОТВЕТ:':'✅ ПРАВИЛЬНЫЙ ОТВЕТ:',
            '🇬🇧 '+right.answer,
            '💡 Почему именно так: '+right.why,
            '📖 Правило из урока №'+item.lesson+'.');
        if(!short||correct)
            lines.push('🔊 Послушать произношение (US): https://youglish.com/pronounce/'+encodeURIComponent(right.answer)+'/english/us');
    }
    const text=lines.join('\n');
    if(text.length>3500)throw Error('English quiz explanation exceeds safety budget');
    return text;
}

export function createEnglishGrammarCourse({
    vk,telegramBot,dbPath=resolveMainDatabasePath(),dataDir=resolveRuntimeDataDirectory(),
    now=Date.now,random=Math.random,timeZone='Europe/Moscow',logger=console,
}={}){
    assertTestDatabaseIsolation({databasePath:dbPath});
    const db=new DatabaseSync(dbPath);
    db.exec('PRAGMA busy_timeout=2500');
    db.exec(
        'CREATE TABLE IF NOT EXISTS english_grammar_subscriptions ('+
        'platform TEXT NOT NULL,peer_id TEXT NOT NULL,thread_id INTEGER NOT NULL DEFAULT 0,enabled INTEGER NOT NULL DEFAULT 0,'+
        'completed_lesson INTEGER NOT NULL DEFAULT 0,last_lesson_day TEXT NOT NULL DEFAULT \'\','+
        'updated_at INTEGER NOT NULL DEFAULT 0,PRIMARY KEY(platform,peer_id));'+
        'CREATE TABLE IF NOT EXISTS english_grammar_runs ('+
        'platform TEXT NOT NULL,peer_id TEXT NOT NULL,lesson_id INTEGER NOT NULL,'+
        'next_part INTEGER NOT NULL DEFAULT 1,status TEXT NOT NULL DEFAULT \'running\','+
        'due_at INTEGER NOT NULL DEFAULT 0,started_at INTEGER NOT NULL DEFAULT 0,'+
        'last_message_id INTEGER NOT NULL DEFAULT 0,last_conversation_id INTEGER NOT NULL DEFAULT 0,'+
        'updated_at INTEGER NOT NULL DEFAULT 0,PRIMARY KEY(platform,peer_id));'+
        'CREATE TABLE IF NOT EXISTS english_grammar_quiz_schedules ('+
        'peer_id TEXT PRIMARY KEY,enabled INTEGER NOT NULL DEFAULT 0,'+
        'interval_ms INTEGER NOT NULL DEFAULT 21600000,current_interval_ms INTEGER NOT NULL DEFAULT 21600000,'+
        'acceleration_enabled INTEGER NOT NULL DEFAULT 0,next_at INTEGER NOT NULL DEFAULT 0,'+
        'seen_json TEXT NOT NULL DEFAULT \'[]\',pending_token TEXT NOT NULL DEFAULT \'\','+
        'hide_correct INTEGER NOT NULL DEFAULT 0,updated_at INTEGER NOT NULL DEFAULT 0);'+
        'CREATE TABLE IF NOT EXISTS english_grammar_quiz_questions ('+
        'token TEXT PRIMARY KEY,peer_id TEXT NOT NULL,question_id TEXT NOT NULL,'+
        'options_json TEXT NOT NULL,correct_index INTEGER NOT NULL,'+
        'created_at INTEGER NOT NULL,sent_at INTEGER NOT NULL DEFAULT 0,'+
        'delivery_seq INTEGER NOT NULL DEFAULT 0);'+
        'CREATE TABLE IF NOT EXISTS english_grammar_quiz_answers ('+
        'token TEXT NOT NULL,user_id TEXT NOT NULL,choice INTEGER NOT NULL,'+
        'delivered INTEGER NOT NULL DEFAULT 0,corrected INTEGER NOT NULL DEFAULT 0,'+
        'repeat_ack INTEGER NOT NULL DEFAULT 0,created_at INTEGER NOT NULL,'+
        'PRIMARY KEY(token,user_id));'+
        'CREATE INDEX IF NOT EXISTS english_grammar_questions_peer ON english_grammar_quiz_questions(peer_id,created_at);'
    );
    const q={
        subGet:db.prepare('SELECT * FROM english_grammar_subscriptions WHERE platform=? AND peer_id=?'),
        subPut:db.prepare('INSERT INTO english_grammar_subscriptions(platform,peer_id,thread_id,enabled,completed_lesson,last_lesson_day,updated_at) VALUES(?,?,?,?,?,?,?) ON CONFLICT(platform,peer_id) DO UPDATE SET thread_id=excluded.thread_id,enabled=excluded.enabled,completed_lesson=excluded.completed_lesson,last_lesson_day=excluded.last_lesson_day,updated_at=excluded.updated_at'),
        subActive:db.prepare('SELECT * FROM english_grammar_subscriptions WHERE enabled=1'),
        runGet:db.prepare('SELECT * FROM english_grammar_runs WHERE platform=? AND peer_id=?'),
        runPut:db.prepare('INSERT INTO english_grammar_runs(platform,peer_id,lesson_id,next_part,status,due_at,started_at,last_message_id,last_conversation_id,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?) ON CONFLICT(platform,peer_id) DO UPDATE SET lesson_id=excluded.lesson_id,next_part=excluded.next_part,status=excluded.status,due_at=excluded.due_at,started_at=excluded.started_at,last_message_id=excluded.last_message_id,last_conversation_id=excluded.last_conversation_id,updated_at=excluded.updated_at'),
        quizGet:db.prepare('SELECT * FROM english_grammar_quiz_schedules WHERE peer_id=?'),
        quizPut:db.prepare('INSERT INTO english_grammar_quiz_schedules(peer_id,enabled,interval_ms,current_interval_ms,acceleration_enabled,next_at,seen_json,pending_token,hide_correct,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?) ON CONFLICT(peer_id) DO UPDATE SET enabled=excluded.enabled,interval_ms=excluded.interval_ms,current_interval_ms=excluded.current_interval_ms,acceleration_enabled=excluded.acceleration_enabled,next_at=excluded.next_at,seen_json=excluded.seen_json,pending_token=excluded.pending_token,hide_correct=excluded.hide_correct,updated_at=excluded.updated_at'),
        quizDue:db.prepare('SELECT * FROM english_grammar_quiz_schedules WHERE enabled=1 AND next_at<=? ORDER BY next_at LIMIT 80'),
        qGet:db.prepare('SELECT * FROM english_grammar_quiz_questions WHERE token=?'),
        qPut:db.prepare('INSERT INTO english_grammar_quiz_questions(token,peer_id,question_id,options_json,correct_index,created_at,sent_at,delivery_seq) VALUES(?,?,?,?,?,?,0,0)'),
        qSent:db.prepare('UPDATE english_grammar_quiz_questions SET sent_at=?,delivery_seq=delivery_seq+1 WHERE token=?'),
        lastSent:db.prepare('SELECT MAX(sent_at) as sent FROM english_grammar_quiz_questions WHERE peer_id=?'),
        aGet:db.prepare('SELECT * FROM english_grammar_quiz_answers WHERE token=? AND user_id=?'),
        aPut:db.prepare('INSERT OR IGNORE INTO english_grammar_quiz_answers(token,user_id,choice,created_at) VALUES(?,?,?,?)'),
        aMark:db.prepare('UPDATE english_grammar_quiz_answers SET delivered=1 WHERE token=? AND user_id=?'),
        aCorrect:db.prepare('UPDATE english_grammar_quiz_answers SET corrected=1 WHERE token=? AND user_id=?'),
        aAck:db.prepare('UPDATE english_grammar_quiz_answers SET repeat_ack=1 WHERE token=? AND user_id=?'),
        aSolved:db.prepare('SELECT count(*) AS n FROM english_grammar_quiz_answers WHERE token=? AND delivered=1 AND (choice=? OR corrected=1)'),
        aWrong:db.prepare('SELECT count(*) AS n FROM english_grammar_quiz_answers WHERE token=? AND delivered=1 AND choice<>?'),
        cleanAnswers:db.prepare('DELETE FROM english_grammar_quiz_answers WHERE token IN (SELECT token FROM english_grammar_quiz_questions WHERE created_at<? AND token NOT IN (SELECT pending_token FROM english_grammar_quiz_schedules WHERE enabled=1))'),
        cleanQuestions:db.prepare('DELETE FROM english_grammar_quiz_questions WHERE created_at<? AND token NOT IN (SELECT pending_token FROM english_grammar_quiz_schedules WHERE enabled=1)'),
    };
    let stopped=false,timer=null,ticking=false,seq=0,nextCleanup=0;
    const queues=new Map();
    const key=(platform,peer)=>platform+':'+peer;
    const task=(platform,peer,job)=>{
        const id=key(platform,peer),prior=queues.get(id)||Promise.resolve();
        const current=prior.catch(()=>{}).then(()=>new Promise(r=>setImmediate(r))).then(job);
        queues.set(id,current);
        void current.catch(()=>{}).finally(()=>{if(queues.get(id)===current)queues.delete(id);});
        return current;
    };
    const getSub=(platform,peer)=>q.subGet.get(platform,String(peer))||{
        platform,peer_id:String(peer),thread_id:0,enabled:0,completed_lesson:0,last_lesson_day:'',
    };
    const putSub=s=>q.subPut.run(s.platform,s.peer_id,s.thread_id||0,s.enabled,s.completed_lesson,s.last_lesson_day,now());
    const getRun=s=>q.runGet.get(s.platform,s.peer_id);
    const putRun=r=>q.runPut.run(r.platform,r.peer_id,r.lesson_id,r.next_part,r.status,r.due_at,
        r.started_at,r.last_message_id||0,r.last_conversation_id||0,now());
    const getQuiz=peer=>q.quizGet.get(String(peer))||{
        peer_id:String(peer),enabled:0,interval_ms:QUIZ_DEFAULT,current_interval_ms:QUIZ_DEFAULT,
        acceleration_enabled:0,next_at:0,seen_json:'[]',pending_token:'',hide_correct:0,
    };
    const putQuiz=s=>q.quizPut.run(s.peer_id,s.enabled,s.interval_ms,s.current_interval_ms,
        s.acceleration_enabled,s.next_at,s.seen_json,s.pending_token,s.hide_correct,now());

    function checkVkResponse(sent,peer){
        const row=Array.isArray(sent)?(sent.find(x=>String(x.peer_id)===String(peer))||sent[0]):sent;
        const err=row?.error||row?.error_code&&row;
        if(err)throw Error(err.error_msg||err.message||'English VK send error');
        return {messageId:Number(row?.message_id||row?.id||(typeof row==='number'?row:0))||0,
            conversationId:Number(row?.conversation_message_id||row?.conversationMessageId||0)};
    }
    async function send(s,message,{tag='',keyboardMarkup=null,reply=null}={}){
        const text=String(message);
        if(text.length+(text.match(/\n/gu)||[]).length>4096)throw Error('English message exceeds VK size');
        if(s.platform==='vk'){
            const random_id=(hash('english:grammar:'+s.peer_id+':'+(tag||('control:'+now()+':'+(++seq))))&0x7fffffff)||1;
            const params={peer_ids:[Number(s.peer_id)],random_id,message:text};
            if(keyboardMarkup)params.keyboard=keyboardMarkup;
            if(reply?.last_conversation_id)params.forward=buildChtivoReplyForward(s.peer_id,reply.last_conversation_id);
            else if(reply?.last_message_id)params.reply_to=reply.last_message_id;
            const result=await vk.api.messages.send(params);
            return checkVkResponse(result,s.peer_id);
        }
        const chatId=s.peer_id,messageThreadId=s.thread_id||0;
        if(typeof telegramBot?.api?.call==='function'){
            const params={chat_id:chatId,text,link_preview_options:{is_disabled:true}};
            if(messageThreadId)params.message_thread_id=messageThreadId;
            if(reply?.last_message_id)params.reply_parameters={message_id:reply.last_message_id,allow_sending_without_reply:false};
            const result=await telegramBot.api.call('sendMessage',params,{timeoutMs:45000});
            return {messageId:Number(result?.message_id||result?.messageId||result?.id||0),conversationId:0};
        }
        if(!telegramBot?.api?.sendMessage)throw Error('Telegram sender not available');
        const result=await telegramBot.api.sendMessage({chatId,messageThreadId:messageThreadId||null,text,
            ...(reply?.last_message_id?{replyToMessageId:reply.last_message_id}:{})});
        return {messageId:Number(result?.message_id||result?.messageId||result?.id||0),conversationId:0};
    }
    const announce=(platform,peer,text,tag,thread_id=0)=>send({platform,peer_id:String(peer),thread_id},text,{tag});
    const gap=state=>Number(state.interval_ms)>=HOUR?HOUR:0;
    const audience=s=>s?.chat_kind==='private'||
        (s?.platform==='telegram'?Number(s.peer_id)>0:Number(s?.peer_id)<2000000000)
        ?'private':'group';
    const nextInterval=(start,ms,s)=>addHuinglishActiveMilliseconds(start,ms,timeZone,audience(s));

    async function deliverLesson(s,{manual=false}={}){
        const run=getRun(s);
        if(!s.enabled||!run||run.status!=='running')return;
        if(isHuinglishQuietTime(now(),timeZone,audience(s)))return;
        if(!manual&&run.due_at>now())return;
        const lesson=LESSONS.get(run.lesson_id);
        if(!lesson||run.next_part>lesson.parts.length||run.next_part<1){
            logger.error?.('[ENGLISH LESSON STATE INVALID]',s.peer_id,run?.lesson_id,run?.next_part);
            return;
        }
        const part=run.next_part;
        const receipt=await send(s,lesson.parts[part-1],{
            tag:'lesson:'+run.lesson_id+':part:'+part+':'+run.started_at,
            reply:part>1?run:null,
        });
        // Store exactly the LESSON message id, not a link, to retain reply chains.
        run.last_message_id=receipt.messageId||run.last_message_id;
        run.last_conversation_id=receipt.conversationId||run.last_conversation_id;
        run.next_part=part+1;
        const finished=run.next_part>lesson.parts.length;
        run.status=finished?'finished':'running';
        run.due_at=finished?0:nextInterval(now(),(23+Math.floor(Math.min(.999999,Math.max(0,random()))*5))*MINUTE,s);
        putRun(run);
        if(finished){
            s.completed_lesson=Math.max(s.completed_lesson,lesson.id);
            s.last_lesson_day=dayInZone(now(),timeZone);
            putSub(s);
        }
        logger.info?.('[ENGLISH LESSON PART SENT]',key(s.platform,s.peer_id),'lesson='+lesson.id,'part='+part);
    }
    async function startLesson(s,id,{force=false}={}){
        const lesson=LESSONS.get(id);
        if(!lesson){await announce(s.platform,s.peer_id,'📚 English: урока №'+id+' пока нет. Всего '+LESSONS.size+' уроков.','no-lesson:'+now(),s.thread_id);return;}
        if(id>s.completed_lesson+1){await announce(s.platform,s.peer_id,'🔒 Сначала пройди урок №'+(s.completed_lesson+1)+'.','locked:'+now(),s.thread_id);return;}
        const current=getRun(s);
        if(current?.status==='running'&&!force){await deliverLesson(s,{manual:true});return;}
        const run={platform:s.platform,peer_id:s.peer_id,lesson_id:id,next_part:1,
            status:'running',due_at:now(),started_at:now()+seq++,last_message_id:0,last_conversation_id:0};
        putRun(run);
        await deliverLesson(s,{manual:true});
    }
    async function resume(s,run){
        if(!run)return;
        run.status='running';run.due_at=now();putRun(run);
        await deliverLesson(s,{manual:true});
    }
    function chooseQuestion(s){
        const unlocked=ENGLISH_GRAMMAR_QUIZ_BANK.filter(item=>item.lesson<=getSub('vk',s.peer_id).completed_lesson);
        if(unlocked.length===0)return null;
        let seen=new Set(safeJson(s.seen_json,[]));
        let remaining=unlocked.filter(item=>!seen.has(item.id));
        if(!remaining.length){seen.clear();remaining=unlocked;}
        const item=remaining[hash(s.peer_id+':'+now()+':'+s.seen_json)%remaining.length];
        const keys=[0,1,2,3];
        const seed=hash(s.peer_id+':'+now()+':'+item.id);
        keys.sort((a,b)=>hash(seed+':'+a)-hash(seed+':'+b));
        seen.add(item.id);
        s.seen_json=JSON.stringify([...seen]);
        const token=randomBytes(8).toString('hex');
        q.qPut.run(token,s.peer_id,item.id,JSON.stringify(keys),keys.indexOf(0),now());
        s.pending_token=token;
        putQuiz(s);
        return q.qGet.get(token);
    }
    async function sendQuizDue(candidate){
        const s=q.quizGet.get(String(candidate.peer_id));
        if(!s?.enabled||s.next_at>now())return;
        if(isHuinglishQuietTime(now(),timeZone,audience(s))){
            s.next_at=nextHuinglishActiveTime(now(),timeZone,audience(s));putQuiz(s);return;
        }
        const last=Number(q.lastSent.get(s.peer_id)?.sent||0);
        const earliest=last?nextInterval(last,gap(s),s):0;
        if(earliest>now()){s.next_at=earliest;putQuiz(s);return;}
        let question=s.pending_token?q.qGet.get(s.pending_token):null;
        if(!question)question=chooseQuestion(s);
        if(!question){
            s.next_at=nextInterval(now(),s.interval_ms,s);putQuiz(s);
            return;
        }
        const item=QUESTIONS.get(question.question_id);
        if(!item)throw Error('Missing English test question '+question.question_id);
        await send({platform:'vk',peer_id:s.peer_id},formatEnglishGrammarQuestion(item),{
            keyboardMarkup:keyboard(question),tag:'question:'+question.token+':'+question.delivery_seq,
        });
        q.qSent.run(now(),question.token);
        s.current_interval_ms=(question.sent_at&&s.acceleration_enabled)?
            Math.max(MINUTE,Math.floor(s.current_interval_ms/2)):s.current_interval_ms;
        s.next_at=nextInterval(now(),Math.max(gap(s),s.current_interval_ms),s);
        putQuiz(s);
        logger.info?.('[ENGLISH QUIZ SENT]',s.peer_id,item.id);
    }
    async function quizAnswer({peerId,userId,payload}){
        const token=String(payload?.token||''),choice=Number(payload?.choice);
        if(!/^[a-f0-9]{16}$/u.test(token)||!Number.isInteger(choice)||choice<0||choice>3||
            !/^\d{1,15}$/u.test(String(userId)))return {ok:false,text:'Некорректная кнопка'};
        const s=q.quizGet.get(String(peerId));
        const question=q.qGet.get(token);
        if(!s?.enabled||!question||question.peer_id!==String(peerId)||!question.sent_at||
            (now()-question.created_at>TTL&&s.pending_token!==token))
            return {ok:false,text:'Вопрос уже неактуален'};
        const item=QUESTIONS.get(question.question_id);
        const chosenIndex=safeJson(question.options_json,[])[choice];
        if(!item||!Number.isInteger(chosenIndex))return {ok:false,text:'Нет данных вопроса'};
        let record=q.aGet.get(token,String(userId));
        if(!record){q.aPut.run(token,String(userId),choice,now());record=q.aGet.get(token,String(userId));}
        const savedOptions=safeJson(question.options_json,[]);
        const originalCorrect=Boolean(item.options[savedOptions[record.choice]]?.correct);
        const clickedCorrect=Boolean(item.options[chosenIndex]?.correct);
        let mode;
        if(!record.delivered)mode=originalCorrect?'correct':'wrong';
        else if(!clickedCorrect)return {ok:true,text:'Ты уже ответил'};
        else if(record.corrected||originalCorrect){
            if(record.repeat_ack)return {ok:true,text:'Ты уже ответил'};
            mode='repeat';
        }else mode='correction';
        const correct=mode!=='wrong';
        const priorSolved=Number(q.aSolved.get(token,question.correct_index)?.n||0)>0;
        const revealCorrect=!s.hide_correct||priorSolved||correct;
        const picked=item.options[correct?chosenIndex:savedOptions[record.choice]];
        const short=correct&&priorSolved||mode==='repeat'||!correct&&Number(q.aWrong.get(token,question.correct_index)?.n||0)>0;
        const output='[id'+userId+'|Твой ответ]:\n'+buildEnglishGrammarQuizExplanation({item,picked,correct,revealCorrect,short});
        const tag='answer:'+token+':'+userId+':'+mode;
        await send({platform:'vk',peer_id:String(peerId)},output,{tag});
        if(mode==='correction')q.aCorrect.run(token,String(userId));
        else if(mode==='repeat')q.aAck.run(token,String(userId));
        else {
            q.aMark.run(token,String(userId));
            if(originalCorrect&&record.choice!==question.correct_index)q.aCorrect.run(token,String(userId));
        }
        // A reply to an old question must never reset the current quiz.
        const current=q.quizGet.get(String(peerId));
        if(current?.enabled&&current.pending_token===token){
            current.pending_token='';
            if(correct){
                current.current_interval_ms=current.interval_ms;
                current.next_at=nextInterval(now(),current.interval_ms,current);
            }else current.next_at=nextHuinglishActiveTime(now(),timeZone,audience(current));
            putQuiz(current);
            if(!correct)await sendQuizDue(current);
        }
        return {ok:true,text:correct?'Правильно!':'Разбор отправлен'};
    }
    const intervalLabel=ms=>ms<3600000?String(Math.round(ms/60000))+' мин.':String(Number((ms/3600000).toFixed(3)))+' ч.';
    async function quizCommand(c,cmd){
        const peer=String(c.peerId),s=getQuiz(peer);
        if(c.platform!=='vk'){
            await announce(c.platform,peer,'📚 English: тесты с кнопками доступны во ВКонтакте. Уроки работают и в Telegram.','tg-quiz:'+now(),c.threadId);
            return;
        }
        if(cmd.type==='quizHideCorrect'||cmd.type==='quizRevealCorrect'){
            s.hide_correct=cmd.type==='quizHideCorrect'?1:0;
            putQuiz(s);
            await announce('vk',peer,s.hide_correct?
                '📚 English: после ошибки правильный вариант скрывается до первого верного ответа.':
                '📚 English: после ошибки сразу показывается правильный вариант и объяснение.','mode:'+now());
            return;
        }
        if(cmd.type==='quizStatus'){
            await announce('vk',peer,'📚 English · тесты '+(s.enabled?'включены':'выключены')+
                '. Интервал: '+intervalLabel(s.interval_ms)+
                '. Ускорение: '+(s.acceleration_enabled?'да':'нет')+
                '. После ошибки: '+(s.hide_correct?'ответ скрыт':'ответ раскрывается')+'.','status:'+now());
            return;
        }
        if(cmd.type==='quizOff'){
            s.enabled=0;s.pending_token='';s.next_at=0;s.current_interval_ms=s.interval_ms;
            putQuiz(s);
            await announce('vk',peer,'📚 English: тесты выключены. Уроки не затронуты.','off:'+now());
            return;
        }
        if(cmd.type==='quizInvalid'){
            await announce('vk',peer,'⚠️ Примеры: «English тесты», «English тесты 1.5», «English тесты 1/6 ускорение». Интервал: 1 минута – 72 часа.','invalid:'+now());return;
        }
        const sub=getSub('vk',peer);
        if(!sub.completed_lesson){
            await announce('vk',peer,'📚 English: сначала заверши урок №1, затем станут доступны его 8 тестов.','no-lessons:'+now());
            return;
        }
        const interval=cmd.intervalMs||s.interval_ms||QUIZ_DEFAULT;
        if(!Number.isFinite(interval)||interval<MINUTE||interval>MAX_QUIZ_INTERVAL)throw Error('English test interval invalid');
        const accel=cmd.accelerate==null?Boolean(s.acceleration_enabled):Boolean(cmd.accelerate);
        const changed=!s.enabled||s.interval_ms!==interval||Boolean(s.acceleration_enabled)!==accel;
        s.enabled=1;s.interval_ms=interval;s.acceleration_enabled=Number(accel);
        if(changed){s.next_at=nextHuinglishActiveTime(now(),timeZone,audience(s));s.pending_token='';s.current_interval_ms=interval;}
        putQuiz(s);
        await announce('vk',peer,'📚 English · тесты '+(changed?'включены':'уже работают')+
            '. Интервал: '+intervalLabel(interval)+'. Ускорение: '+(accel?'да':'нет')+
            '. Выкл.: «English тесты выкл».','on:'+now());
        if(changed)await sendQuizDue(s);
    }
    async function command(c,cmd){
        const s=getSub(c.platform,c.peerId);
        const incomingThread=Number(c.threadId)||0;
        const priorThread=Number(s.thread_id)||0;
        const run=getRun(s);
        if(s.platform==='telegram'&&run&&['running','paused'].includes(run.status)&&
            ['on','next','lesson','restart'].includes(cmd.type)&&incomingThread!==priorThread){
            await announce(s.platform,s.peer_id,
                '📚 Незавершённый урок English находится в другой теме Telegram. Продолжай там, чтобы не потерять цепочку.',
                'wrong-thread:'+now(),incomingThread);
            return;
        }
        s.thread_id=cmd.type==='off'&&run?priorThread:incomingThread;
        if(cmd.type.startsWith('quiz'))return quizCommand(c,cmd);
        if(cmd.type==='list'){
            await announce(s.platform,s.peer_id,'📚 ENGLISH · 10 УРОКОВ\n'+ENGLISH_GRAMMAR_LESSONS.map(l=>
                l.id+'. '+l.title).join('\n')+'\n\n«English урок 1», «English далее». Тесты: «English тесты».',
            'list:'+now(),s.thread_id);return;
        }
        if(cmd.type==='status'){
            const quiz=c.platform==='vk'?getQuiz(s.peer_id):null;
            await announce(s.platform,s.peer_id,'📚 English: '+(s.enabled?'включён':'выключен')+
                '. Завершено уроков: '+s.completed_lesson+'/'+LESSONS.size+'. '+
                (run?'Текущий урок №'+run.lesson_id+', частей отправлено '+(run.next_part-1)+'. ':'')+
                (quiz?'Тесты: '+(quiz.enabled?'вкл':'выкл')+', интервал '+intervalLabel(quiz.interval_ms)+'.':''),
            'status:'+now(),s.thread_id);return;
        }
        if(cmd.type==='off'){
            s.enabled=0;putSub(s);
            if(run?.status==='running'){run.status='paused';putRun(run);}
            await announce(s.platform,s.peer_id,'📚 English выключен. Тесты управляются отдельно: «English тесты выкл».','off:'+now(),s.thread_id);
            return;
        }
        if(cmd.type==='on'){
            s.enabled=1;putSub(s);
            if(run?.status==='paused')return resume(s,run);
            if(run?.status==='running')return deliverLesson(s,{manual:true});
            if(s.completed_lesson>=LESSONS.size){
                await announce(s.platform,s.peer_id,'📚 Ты прошёл все 10 уроков English. Для повтора: «English урок 1».','completed:'+now(),s.thread_id);return;
            }
            if(s.completed_lesson>0&&s.last_lesson_day===dayInZone(now(),timeZone)){
                await announce(s.platform,s.peer_id,'📚 Сегодня урок уже завершён. Следующий — завтра; для повтора: «English урок 1».','today:'+now(),s.thread_id);return;
            }
            return startLesson(s,s.completed_lesson+1);
        }
        if(!s.enabled){
            await announce(s.platform,s.peer_id,'📚 Сначала включи English: «English вкл».','need-on:'+now(),s.thread_id);return;
        }
        if(cmd.type==='restart')return startLesson(s,run?.lesson_id||s.completed_lesson+1,{force:true});
        if(cmd.type==='lesson'){
            if(run?.status==='running'&&run.lesson_id!==cmd.id){
                await announce(s.platform,s.peer_id,'📖 Сначала заверши урок №'+run.lesson_id+'. Продолжение: «English далее».','running:'+now(),s.thread_id);return;
            }
            return startLesson(s,cmd.id,{force:run?.status==='finished'||run?.lesson_id!==cmd.id});
        }
        if(cmd.type==='next'){
            if(run?.status==='running')return deliverLesson(s,{manual:true});
            if(run?.status==='paused')return resume(s,run);
            if(s.completed_lesson>=LESSONS.size){
                await announce(s.platform,s.peer_id,'📚 Все 10 уроков завершены. Повтор: «English урок 1».','all-done:'+now(),s.thread_id);return;
            }
            if(s.last_lesson_day===dayInZone(now(),timeZone)){
                await announce(s.platform,s.peer_id,'✅ Сегодня урок завершён. Следующий доступен завтра.','tomorrow:'+now(),s.thread_id);return;
            }
            return startLesson(s,s.completed_lesson+1);
        }
    }
    async function tick(){
        if(stopped||ticking)return;
        ticking=true;
        try{
            if(now()>=nextCleanup){
                q.cleanAnswers.run(now()-TTL);q.cleanQuestions.run(now()-TTL);
                nextCleanup=now()+DAY;
            }
            for(const entry of q.subActive.all()){
                const s=getSub(entry.platform,entry.peer_id);
                const run=getRun(s);
                if(run?.status==='running'&&run.due_at<=now()){
                    try{await task(s.platform,s.peer_id,()=>deliverLesson(s));}
                    catch(e){logger.error?.('[ENGLISH LESSON TICK ERROR]',String(e?.message||e));}
                }else if(s.platform==='vk'&&run?.status==='finished'&&
                    s.completed_lesson<LESSONS.size&&s.last_lesson_day!==dayInZone(now(),timeZone)){
                    const hour=Number(new Intl.DateTimeFormat('en-GB',{timeZone,hour:'2-digit',hourCycle:'h23'}).format(new Date(now())));
                    if(hour>=10&&hour<20&&!isHuinglishQuietTime(now(),timeZone,audience(s))){
                        try{await task(s.platform,s.peer_id,()=>startLesson(getSub(s.platform,s.peer_id),s.completed_lesson+1));}
                        catch(e){logger.error?.('[ENGLISH NEXT LESSON ERROR]',String(e?.message||e));}
                    }
                }
            }
            for(const s of q.quizDue.all(now())){
                try{await task('vk',s.peer_id,()=>sendQuizDue(s));}
                catch(e){logger.error?.('[ENGLISH QUIZ TICK ERROR]',String(e?.message||e));}
            }
        }finally{ticking=false;}
    }
    function handle(c,onCompletion=null){
        const parsed=parseEnglishGrammarCommand(c?.text);
        if(!parsed||stopped||!c?.peerId||!['vk','telegram'].includes(c.platform))return false;
        const peer=String(c.peerId),platform=c.platform;
        const completion=task(platform,peer,()=>command({...c,peerId:peer},parsed));
        onCompletion?.(completion);
        void completion.catch(error=>logger.error?.('[ENGLISH COMMAND ERROR]',platform,peer,String(error?.stack||error)));
        return true;
    }
    function handleVkQuizAnswer({peerId,userId,payload}){
        if(stopped||payload?.action!=='english_quiz')return Promise.resolve({ok:false,text:'Некорректная кнопка'});
        return task('vk',String(peerId),()=>quizAnswer({peerId:String(peerId),userId:String(userId),payload}));
    }
    return {
        handle,handleVkQuizAnswer,tick,
        start(){if(timer||stopped)return;timer=setInterval(()=>void tick().catch(e=>
            logger.error?.('[ENGLISH TICK ERROR]',String(e?.message||e))),15000);
            timer.unref?.();logger.info?.('[ENGLISH COURSE READY]','lessons='+LESSONS.size,'tests='+QUESTIONS.size);},
        inspect:(platform,peer)=>({subscription:getSub(platform,String(peer)),run:q.runGet.get(platform,String(peer)),
            quiz:platform==='vk'?getQuiz(String(peer)):null,lessons:LESSONS.size,questions:QUESTIONS.size}),
        async idle(){while(queues.size)await Promise.allSettled([...queues.values()]);},
        async close(){if(stopped)return;stopped=true;if(timer)clearInterval(timer);while(queues.size)await Promise.allSettled([...queues.values()]);db.close();},
    };
}
