import { createHash, randomBytes } from 'node:crypto';
import { HUINGLISH_QUIZ_BANK } from './huinglishQuizBank.js';
import { HUINGLISH_QUIZ_LEADS } from './huinglishQuizLeads.js';
import { HUINGLISH_QUIZ_PRONUNCIATIONS } from './huinglishQuizPronunciations.js';
import { HUINGLISH_QUIZ_EXAMPLES } from './huinglishQuizExamples.js';
import { HUINGLISH_QUIZ_OTHER_EXAMPLES } from './huinglishQuizOtherExamples.js';
import { HUINGLISH_QUIZ_LEAD_EXPLANATIONS } from './huinglishQuizLeadExplanations.js';
import { HUINGLISH_QUIZ_EXTRA_CHOICES } from './huinglishQuizOtherChoices.js';
import { HUINGLISH_QUIZ_NEAR_CHOICES } from './huinglishQuizNearChoices.js';
import { buildHuinglishQuizOptions } from './huinglishQuizChoices.js';
import { createHuinglishQuizLessonReference } from './huinglishQuizLessonReference.js';
import { addHuinglishActiveMilliseconds, nextHuinglishActiveTime, isHuinglishQuietTime } from './huinglishQuietHours.js';
import { buildHuinglishQuizAnswerExplanation } from './huinglishQuizAnswerExplanation.js';
import { pickHuinglishSitePromo } from './huinglishSitePromos.js';

const MIN_INTERVAL_MS = 60_000;
const MAX_INTERVAL_MS = 72 * 3_600_000;
const DEFAULT_INTERVAL_MS = 6 * 3_600_000;
// A configured hour (or longer) always means at least one hour between
// quiz drops. Shorter configured intervals retain their own cadence but
// never flood a chat more often than once per minute.
const MIN_SEND_GAP_MS = 60_000;
const HOUR_GUARD_MS = 3_600_000;
const QUESTION_TTL_MS = 30 * 24 * 3_600_000;
const CALLBACK_ACTION = 'huinglish_quiz';
const BY_ID = new Map([...HUINGLISH_QUIZ_BANK,...HUINGLISH_QUIZ_EXTRA_CHOICES,...HUINGLISH_QUIZ_NEAR_CHOICES].map(item => [item.id, item]));

const asJson = (value, fallback) => {
    try { return JSON.parse(String(value || '')); } catch { return fallback; }
};
const hashNumber = value => createHash('sha256').update(String(value)).digest().readUInt32BE(0);

function parseHours(value) {
    const text = String(value || '').trim().replace(',', '.');
    if (!/^(?:\d+(?:\.\d+)?|\d+\/\d+)$/u.test(text)) return null;
    let hours;
    if (text.includes('/')) {
        const [numerator, denominator] = text.split('/').map(Number);
        if (!Number.isSafeInteger(numerator) || !Number.isSafeInteger(denominator) || denominator <= 0) return null;
        hours = numerator / denominator;
    } else hours = Number(text);
    const ms = Math.round(hours * 3_600_000);
    return Number.isSafeInteger(ms) && ms >= MIN_INTERVAL_MS && ms <= MAX_INTERVAL_MS ? ms : null;
}

export function parseHuinglishQuizSuffix(suffix) {
    const text = String(suffix || '').toLowerCase().replace(/ё/gu, 'е').replace(/\s+/gu, ' ').trim();
    if (!text) return {type:'quizOn',intervalMs:null,accelerate:null};
    const tokens = text.split(' ');
    if (tokens.some(word => /^(?:выкл|откл|отключить|выключить)$/u.test(word))) return {type:'quizOff'};
    if (tokens.length === 1 && tokens[0] === 'статус') return {type:'quizStatus'};
    if (/^(?:вкл|включить|включи)$/u.test(tokens[0])) tokens.shift();
    const faster = new Set(['ускорять','ускор','ускорение']);
    const normal = new Set(['обычно','обычный']);
    const accelerate = tokens.some(token => faster.has(token)) ? true : tokens.some(token => normal.has(token)) ? false : null;
    const remaining = tokens.filter(token => !faster.has(token) && !normal.has(token));
    if (remaining.length > 1) return {type:'quizInvalid'};
    const intervalMs = remaining.length ? parseHours(remaining[0]) : null;
    if (remaining.length && !intervalMs) return {type:'quizInvalid'};
    return {type:'quizOn',intervalMs,accelerate};
}

function shortHours(ms) {
    if (ms < 60_000) return String(Number((ms / 1000).toFixed(1))) + ' сек.';
    if (ms === 60_000) return '1 минуту';
    if (ms < 3_600_000) return String(Number((ms / 60_000).toFixed(2))) + ' мин.';
    return String(Number((ms / 3_600_000).toFixed(5))) + ' ч.';
}

export function availableHuinglishQuizItems(db, peerId) {
    const subscription = db.prepare("SELECT completed_lesson,completed_lessons_json FROM huinglish_subscriptions WHERE platform='vk' AND peer_id=?").get(String(peerId));
    if (!subscription) return [];
    const published = new Set(db.prepare('SELECT id FROM huinglish_lessons WHERE published=1').all().map(row => row.id));
    const completed = asJson(subscription.completed_lessons_json, {});
    const ids = new Set(Object.keys(completed).map(Number).filter(Number.isSafeInteger));
    if (!ids.size && Number(subscription.completed_lesson) > 0) {
        for (let id = 1; id <= Number(subscription.completed_lesson); id++) ids.add(id);
    }
    return HUINGLISH_QUIZ_BANK.filter(item => ids.has(item.lesson) && published.has(item.lesson));
}

export function createHuinglishQuiz({vk,db,now=Date.now,logger=console,timeZone='Europe/Moscow',sitePromosEnabled=true}={}) {
    db.exec(
        'CREATE TABLE IF NOT EXISTS huinglish_quiz_schedules (' +
        'peer_id TEXT PRIMARY KEY, enabled INTEGER NOT NULL DEFAULT 0,' +
        'interval_ms INTEGER NOT NULL DEFAULT 21600000, next_at INTEGER NOT NULL DEFAULT 0,' +
        'seen_json TEXT NOT NULL DEFAULT \'[]\', pending_token TEXT NOT NULL DEFAULT \'\',' +
        'updated_at INTEGER NOT NULL DEFAULT 0,' +
        'acceleration_enabled INTEGER NOT NULL DEFAULT 0,' +
        'current_interval_ms INTEGER NOT NULL DEFAULT 21600000);' +
        'CREATE TABLE IF NOT EXISTS huinglish_quiz_questions (' +
        'token TEXT PRIMARY KEY, peer_id TEXT NOT NULL, question_id TEXT NOT NULL,' +
        'options_json TEXT NOT NULL, correct_index INTEGER NOT NULL,' +
        'created_at INTEGER NOT NULL, sent_at INTEGER NOT NULL DEFAULT 0,' +
        'delivery_seq INTEGER NOT NULL DEFAULT 0);' +
        'CREATE TABLE IF NOT EXISTS huinglish_quiz_answers (' +
        'token TEXT NOT NULL, user_id TEXT NOT NULL, choice INTEGER NOT NULL,' +
        'delivered INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL,' +
        'correction_delivered INTEGER NOT NULL DEFAULT 0,' +
        'repeat_correct_ack_delivered INTEGER NOT NULL DEFAULT 0,' +
        'PRIMARY KEY(token,user_id));' +
        'CREATE TABLE IF NOT EXISTS huinglish_quiz_answer_modes (' +
        'peer_id TEXT PRIMARY KEY,hide_correct INTEGER NOT NULL DEFAULT 0,' +
        'updated_at INTEGER NOT NULL DEFAULT 0);' +
        'CREATE INDEX IF NOT EXISTS huinglish_quiz_questions_peer ON huinglish_quiz_questions(peer_id,created_at);'
    );
    const lessonReference=createHuinglishQuizLessonReference(db,logger);
    // Additive schema change. No course content or unrelated bot tables are modified.
    for (const [table,column,definition] of [
        ['huinglish_quiz_schedules','acceleration_enabled','INTEGER NOT NULL DEFAULT 0'],
        ['huinglish_quiz_schedules','current_interval_ms','INTEGER NOT NULL DEFAULT 21600000'],
        ['huinglish_quiz_questions','delivery_seq','INTEGER NOT NULL DEFAULT 0'],
        ['huinglish_quiz_answers','correction_delivered','INTEGER NOT NULL DEFAULT 0'],
        ['huinglish_quiz_answers','repeat_correct_ack_delivered','INTEGER NOT NULL DEFAULT 0'],
    ]) {
        const names = new Set(db.prepare('PRAGMA table_info('+table+')').all().map(row => row.name));
        if (!names.has(column)) db.exec('ALTER TABLE '+table+' ADD COLUMN '+column+' '+definition);
    }
    const q = {
        get: db.prepare('SELECT * FROM huinglish_quiz_schedules WHERE peer_id=?'),
        getAnswerMode: db.prepare('SELECT hide_correct FROM huinglish_quiz_answer_modes WHERE peer_id=?'),
        setAnswerMode: db.prepare('INSERT INTO huinglish_quiz_answer_modes(peer_id,hide_correct,updated_at) VALUES(?,?,?) ON CONFLICT(peer_id) DO UPDATE SET hide_correct=excluded.hide_correct,updated_at=excluded.updated_at'),
        upsert: db.prepare('INSERT INTO huinglish_quiz_schedules(peer_id,enabled,interval_ms,next_at,seen_json,pending_token,updated_at,acceleration_enabled,current_interval_ms) VALUES(?,?,?,?,?,?,?,?,?) ON CONFLICT(peer_id) DO UPDATE SET enabled=excluded.enabled,interval_ms=excluded.interval_ms,next_at=excluded.next_at,seen_json=excluded.seen_json,pending_token=excluded.pending_token,updated_at=excluded.updated_at,acceleration_enabled=excluded.acceleration_enabled,current_interval_ms=excluded.current_interval_ms'),
        active: db.prepare('SELECT * FROM huinglish_quiz_schedules WHERE enabled=1 AND next_at<=? ORDER BY next_at LIMIT 100'),
        putQuestion: db.prepare('INSERT INTO huinglish_quiz_questions(token,peer_id,question_id,options_json,correct_index,created_at,sent_at,delivery_seq) VALUES(?,?,?,?,?,?,0,0)'),
        getQuestion: db.prepare('SELECT * FROM huinglish_quiz_questions WHERE token=?'),
        markSent: db.prepare('UPDATE huinglish_quiz_questions SET sent_at=?,delivery_seq=delivery_seq+1 WHERE token=?'),
        lastSentAt: db.prepare('SELECT MAX(sent_at) AS last_sent_at FROM huinglish_quiz_questions WHERE peer_id=?'),
        getAnswer: db.prepare('SELECT * FROM huinglish_quiz_answers WHERE token=? AND user_id=?'),
        insertAnswer: db.prepare('INSERT OR IGNORE INTO huinglish_quiz_answers(token,user_id,choice,delivered,created_at) VALUES(?,?,?,0,?)'),
        markAnswered: db.prepare('UPDATE huinglish_quiz_answers SET delivered=1 WHERE token=? AND user_id=?'),
        markCorrected: db.prepare('UPDATE huinglish_quiz_answers SET correction_delivered=1 WHERE token=? AND user_id=?'),
        markRepeatedCorrect: db.prepare('UPDATE huinglish_quiz_answers SET repeat_correct_ack_delivered=1 WHERE token=? AND user_id=?'),
        correctCount: db.prepare('SELECT count(*) AS n FROM huinglish_quiz_answers WHERE token=? AND delivered=1 AND (choice=? OR correction_delivered=1)'),
        wrongCount: db.prepare('SELECT count(*) AS n FROM huinglish_quiz_answers WHERE token=? AND delivered=1 AND choice<>?'),
        cleanAnswers: db.prepare('DELETE FROM huinglish_quiz_answers WHERE token IN (SELECT token FROM huinglish_quiz_questions WHERE created_at<? AND token NOT IN (SELECT pending_token FROM huinglish_quiz_schedules WHERE enabled=1))'),
        cleanQuestions: db.prepare('DELETE FROM huinglish_quiz_questions WHERE created_at<? AND token NOT IN (SELECT pending_token FROM huinglish_quiz_schedules WHERE enabled=1)'),
    };
    let ticking = false;
    let nextCleanupAt = 0;

    function save(state) {
        q.upsert.run(state.peer_id,state.enabled,state.interval_ms,state.next_at,
            state.seen_json,state.pending_token,now(),state.acceleration_enabled||0,
            state.current_interval_ms||state.interval_ms||DEFAULT_INTERVAL_MS);
    }
    function stateFor(peerId) {
        return q.get.get(String(peerId)) || {
            peer_id:String(peerId),enabled:0,interval_ms:DEFAULT_INTERVAL_MS,
            next_at:0,seen_json:'[]',pending_token:'',
            acceleration_enabled:0,current_interval_ms:DEFAULT_INTERVAL_MS,
        };
    }
    function selectQuestion(peerId,state,available) {
        const seen=new Set(asJson(state.seen_json,[]));
        let possible=available.filter(item=>!seen.has(item.id));
        if(!possible.length){seen.clear();possible=available;}
        const chosen=possible[hashNumber(peerId+':'+now()+':'+state.seen_json)%possible.length];
        const seed=hashNumber(peerId+':'+now()+':'+chosen.id);
        const options=buildHuinglishQuizOptions(chosen,available,seed);
        const offset=seed%options.length;
        const rotated=options.slice(offset).concat(options.slice(0,offset));
        seen.add(chosen.id);
        return {item:chosen,options:rotated.map(item=>item.id),
            correctIndex:rotated.findIndex(item=>item.id===chosen.id),seen_json:JSON.stringify([...seen])};
    }
    function keyboard(question) {
        const choices=asJson(question.options_json,[]).map(id=>BY_ID.get(id));
        if (choices.length<4 || choices.length>6 || choices.some(item=>!item)) throw Error('Saved quiz answers missing in bank');
        const buttons=choices.map((item,index)=>({
            action:{type:'callback',label:item.answer,payload:JSON.stringify({
                action:CALLBACK_ACTION,token:question.token,choice:index,
            })},
            color:'secondary',
        }));
        return JSON.stringify({inline:true,buttons:buttons.map(button=>[button])});
    }
    function questionText(question) {
        const item=BY_ID.get(question.question_id);
        if (!item) throw Error('Unknown quiz question '+question.question_id);
        const lead=HUINGLISH_QUIZ_LEADS[item.answer];
        if (!lead) throw Error('Missing dialog for '+item.answer);
        return ['🌭 ХУИНГЛИШ 🍆 · ТЕСТ',
            '🧩 Урок №'+item.lesson+' · выбери ОДНУ фразу',
            '',
            '🧩 ЗАДАНИЕ: '+item.scene,
            '',
            '🇬🇧 Закончи короткий диалог:',
            'A: '+lead,
            'B: «___»',
            'Нужна реплика, которая выполняет задание выше.',
            '',
            'Выбери ответ на одной из '+asJson(question.options_json,[]).length+' кнопок.'].join('\n');
    }
    function checkResponse(res,peerId) {
        const result=Array.isArray(res) ? (res.find(x=>Number(x.peer_id)===Number(peerId))||res[0]) : res;
        const error=result?.error|| (result?.error_code ? result:null);
        if (error) throw Error(error.error_msg||error.message||'VK quiz send error');
    }
    async function sendVk(peerId,message,tag,extra={}) {
        const random_id=(hashNumber('huinglish:quiz:'+peerId+':'+tag)&0x7fffffff)||1;
        const result=await vk.api.messages.send({peer_id:Number(peerId),random_id,message,...extra});
        checkResponse(result,peerId);
        return result;
    }
    async function sendSitePromo(peerId,deliveryTag) {
        if(!sitePromosEnabled)return;
        try {
            const tag='site-promo:'+deliveryTag;
            await sendVk(peerId,pickHuinglishSitePromo(peerId+':'+tag),tag);
        } catch(error) {
            logger.warn?.('[HUINGLISH QUIZ SITE PROMO ERROR]','peer='+peerId,String(error?.message||error));
        }
    }
    function minimumGap(state) {
        // A one-hour setting is a strict delivery guarantee, including
        // wrong answers and acceleration. Faster settings may still produce
        // an immediate new question after a wrong answer.
        return Number(state.interval_ms) >= HOUR_GUARD_MS ? HOUR_GUARD_MS : 0;
    }
    const audience=row=>Number(row?.peer_id)>=2000000000?'group':'private';
    async function sendDue(candidate) {
        const state=q.get.get(String(candidate?.peer_id||''));
        if (!state?.enabled || state.next_at>now()) return;
        if(isHuinglishQuietTime(now(),timeZone,audience(state))) {
            state.next_at=nextHuinglishActiveTime(now(),timeZone,audience(state));
            save(state);
            return;
        }
        const lastSent=Number(q.lastSentAt.get(state.peer_id)?.last_sent_at||0);
        const earliest=lastSent?addHuinglishActiveMilliseconds(lastSent,minimumGap(state),timeZone,audience(state)):0;
        // Existing schedules created before the quiet-hours feature may have
        // raw wall-clock deadlines. Restore their outstanding active interval.
        // But do not delay an immediate new question after a wrong answer.
        const rawDue=lastSent+Number(state.current_interval_ms||state.interval_ms);
        const oldAutoSchedule=lastSent>0 && state.next_at>=rawDue-15000;
        const resumedDue=oldAutoSchedule
            ?addHuinglishActiveMilliseconds(lastSent,Number(state.current_interval_ms||state.interval_ms),timeZone,audience(state))
            :0;
        const actualDue=Math.max(earliest,resumedDue);
        if(lastSent>0 && now()<actualDue) {
            if(state.next_at!==actualDue) {state.next_at=actualDue;save(state);}
            return;
        }
        const available=availableHuinglishQuizItems(db,state.peer_id);
        if (available.length<4) {
            state.next_at=addHuinglishActiveMilliseconds(now(),state.interval_ms,timeZone,audience(state)); save(state);return;
        }
        let question=state.pending_token ? q.getQuestion.get(state.pending_token) : null;
        let selection=null;
        if (!question) {
            selection=selectQuestion(state.peer_id,state,available);
            if (!selection) return;
            const token=randomBytes(8).toString('hex');
            q.putQuestion.run(token,state.peer_id,selection.item.id,JSON.stringify(selection.options),selection.correctIndex,now());
            state.pending_token=token;
            save(state);
            question=q.getQuestion.get(token);
        }
        const repeat=Number(question.sent_at)>0;
        try {
            // Different random_id for each reminder, same random_id on retry.
            await sendVk(state.peer_id,questionText(question),
                'question:'+question.token+':'+question.delivery_seq,
                {keyboard:keyboard(question)});
        } catch (error) {
            const latest=q.get.get(state.peer_id);
            if (latest?.enabled&&latest.pending_token===question.token) {
                latest.next_at=addHuinglishActiveMilliseconds(now(),60_000,timeZone,audience(latest)); save(latest);
            }
            logger.error('[HUINGLISH QUIZ SEND ERROR]','peer='+state.peer_id,String(error?.message||error));
            return;
        }
        q.markSent.run(now(),question.token);
        await sendSitePromo(state.peer_id,'question:'+question.token+':'+question.delivery_seq);
        const latest=q.get.get(state.peer_id);
        if (!latest?.enabled || latest.pending_token!==question.token) return;
        if (selection) latest.seen_json=selection.seen_json;
        const oldWait=latest.current_interval_ms||latest.interval_ms;
        // The first repeat is after the original delay. Each unanswered repeat
        // halves the following delay; never zero, at most one drop per tick.
        latest.current_interval_ms=(repeat&&latest.acceleration_enabled)
            ? Math.max(MIN_SEND_GAP_MS,minimumGap(latest),Math.floor(oldWait/2))
            : Math.max(MIN_SEND_GAP_MS,minimumGap(latest),oldWait);
        latest.next_at=addHuinglishActiveMilliseconds(now(),latest.current_interval_ms,timeZone,audience(latest));
        save(latest);
        logger.info('[HUINGLISH QUIZ SENT]','peer='+state.peer_id,'question='+question.question_id,
            'repeat='+repeat,'nextMs='+latest.current_interval_ms);
    }
    async function command(context,cmd) {
        const peerId=String(context.peerId);
        if (context.platform!=='vk') return;
        const state=stateFor(peerId);
        if(cmd.type==='quizHideCorrect'||cmd.type==='quizRevealCorrect') {
            const hide=cmd.type==='quizHideCorrect';
            q.setAnswerMode.run(peerId,Number(hide),now());
            await sendVk(peerId,hide
                ? '🌭 Хуинглиш: правильный ответ после ошибки скрываем до первого верного нажатия.'
                : '🌭 Хуинглиш: после ошибки сразу показываем правильный ответ с разбором.',
                'answer-mode:'+now());
            return;
        }
        if (cmd.type==='quizInvalid') {
            await sendVk(peerId,'⚠️ Примеры: «Хуинглиш тесты» (6 ч.), «Хуинглиш тесты 1.5», «Хуинглиш тесты 1/6 ускорение», «Хуинглиш тесты ускор». Интервал от 1 минуты до 72 часов.','invalid:'+now());
            return;
        }
        if (cmd.type==='quizStatus') {
            await sendVk(peerId,'🌭 Хуинглиш 🍆 · тесты '+(state.enabled?'включены':'выключены')+
                '. Основной интервал: '+shortHours(state.interval_ms)+
                '. Разгадка после ошибки: '+(q.getAnswerMode.get(peerId)?.hide_correct?'скрыта до правильного ответа':'показывается сразу')+
                '. Ускорение: '+(state.acceleration_enabled?'да':'нет')+
                (state.enabled&&state.acceleration_enabled
                    ? '. Следующий интервал: '+shortHours(state.current_interval_ms):'')+
                '.','status:'+now());return;
        }
        if (cmd.type==='quizOff') {
            state.enabled=0;state.pending_token='';state.next_at=0;
            state.current_interval_ms=state.interval_ms||DEFAULT_INTERVAL_MS;save(state);
            await sendVk(peerId,'🌭 Хуинглиш 🍆 · тесты выключены. Обычные уроки не затронуты.','off:'+now());return;
        }
        const available=availableHuinglishQuizItems(db,peerId);
        if (available.length<4) {
            await sendVk(peerId,'📚 Тесты доступны только по завершённым в этой беседе урокам. Сначала закончи хотя бы один урок Хуинглиша.','no-lessons:'+now());return;
        }
        const interval=cmd.intervalMs||(state.enabled?state.interval_ms:DEFAULT_INTERVAL_MS);
        const acceleration=cmd.accelerate==null
            ? (state.enabled?Number(state.acceleration_enabled):0)
            : Number(Boolean(cmd.accelerate));
        const changed=!state.enabled||state.interval_ms!==interval||Number(state.acceleration_enabled)!==acceleration;
        state.interval_ms=interval;state.acceleration_enabled=acceleration;state.enabled=1;
        if (changed) {state.next_at=nextHuinglishActiveTime(now(),timeZone,audience(state));state.pending_token='';state.current_interval_ms=interval;}
        save(state);
        await sendVk(peerId,'🌭 Хуинглиш 🍆 · тесты '+(changed?'включены':'уже работают')+
            '. Исходный интервал: '+shortHours(state.interval_ms)+
            '. Ускорение: '+(acceleration?'включено':'выключено')+
            '. Без ответа повторяем тот же вопрос. Выкл.: «Хуинглиш тесты выкл».','on:'+now());
        if (changed) await sendDue(state);
    }
    function phonetics(item) {
        const pronunciation=HUINGLISH_QUIZ_PRONUNCIATIONS[item.answer] || (item.ipa&&item.ru?item:null);
        if (!pronunciation?.ipa||!pronunciation?.ru) throw Error('Missing quiz pronunciation: '+item.answer);
        return '«'+item.answer+'» '+pronunciation.ipa+
            '\n🗣 «'+pronunciation.ru+'»\n🇷🇺 «'+item.meaning+'»';
    }
    function twoExamples(item) {
        const samples=HUINGLISH_QUIZ_EXAMPLES[item.answer]||HUINGLISH_QUIZ_OTHER_EXAMPLES[item.answer];
        if(!samples||samples.length<2||samples[0].en===samples[1].en)
            throw Error('Incomplete distinct usage examples for '+item.answer);
        return samples.slice(0,2).flatMap((sample,index)=>[
            '   '+(index+1)+'. '+sample.en,
            '      🇷🇺 '+sample.ru,
        ]);
    }
    function firstLineBreakdown(right) {
        const text=HUINGLISH_QUIZ_LEADS[right.answer];
        const details=HUINGLISH_QUIZ_LEAD_EXPLANATIONS[right.answer];
        if(!text||!details?.meaning||!details?.ipa||!details?.russian)
            throw Error('No full quiz context for '+right.answer);
        return ['🗨 ПЕРВАЯ РЕПЛИКА ИЗ ЗАДАНИЯ:',
            '🇬🇧 A: '+text,
            '🔤 '+details.ipa,
            '🗣 «'+details.russian+'»',
            '🇷🇺 '+details.meaning];
    }
    function lessonReferenceLines(peerId,right,{revealCorrect=false}={}) {
        const location=lessonReference.locate(peerId,right);
        if(!location)return {text:[],reply:{}};
        const part=location.total>0?'/'+location.total:'';
        return {text:['📚 Проходили в уроке №'+location.lesson+', часть '+location.part+part+'.',
            revealCorrect?'🔎 Поиск по сообщениям чата: «'+location.search+'».':'🔎 Вернись к этой части урока: нужная фраза пока скрыта.'],
            reply:lessonReference.replyArgs(peerId,location)};
    }
    async function answer({peerId,userId,payload}) {
        const token=String(payload?.token||'');
        const choice=Number(payload?.choice);
        if (!/^[a-f0-9]{16}$/u.test(token)||!Number.isInteger(choice)||choice<0||choice>5||
            !/^\d{1,15}$/u.test(String(userId))) return {ok:false,text:'Некорректная кнопка'};
        const question=q.getQuestion.get(token);
        const state=q.get.get(String(peerId));
        if (!question||question.peer_id!==String(peerId)||!state?.enabled||!question.sent_at||
            (question.created_at<now()-QUESTION_TTL_MS&&state.pending_token!==token))
            return {ok:false,text:'Это задание уже неактуально'};
        const optionIds=asJson(question.options_json,[]);
        const right=BY_ID.get(question.question_id),chosen=BY_ID.get(optionIds[choice]);
        if (!right||!chosen||optionIds.length<4||optionIds.length>6) return {ok:false,text:'Ошибка данных вопроса'};
        let record=q.getAnswer.get(token,String(userId));
        if (!record) {
            q.insertAnswer.run(token,String(userId),choice,now());
            record=q.getAnswer.get(token,String(userId));
        }
        const originalCorrect=record.choice===question.correct_index;
        let kind;
        if (!record.delivered) kind=originalCorrect?'correct':'wrong';
        else if (choice!==question.correct_index)
            return {ok:true,text:'Ты уже ответил на этот вопрос'};
        else if (originalCorrect||record.correction_delivered) {
            // One brief follow-up per participant; repeated button presses
            // must not flood the chat with even short confirmations.
            if (record.repeat_correct_ack_delivered)
                return {ok:true,text:'Ты уже ответил на этот вопрос'};
            kind='repeatCorrect';
        } else kind='correction'; // A learner may fix their earlier mistake.
        const correct=kind!=='wrong';
        const picked=BY_ID.get(optionIds[record.choice]);
        // A repeated VK post of the SAME question has the same token.
        // Count correct answers by token across all users and all copies.
        const alreadyCorrect=Number(q.correctCount.get(token,question.correct_index)?.n||0)>0;
        // Default teaching mode explains the correct answer immediately.
        // The explicit per-chat opt-out keeps the previous hidden-answer behavior.
        const revealCorrect=!Boolean(q.getAnswerMode.get(String(peerId))?.hide_correct)||alreadyCorrect;
        const shortCorrect=correct&&(alreadyCorrect||kind==='repeatCorrect');
        // Every repost of a question has the same token. Only the first
        // delivered wrong answer gets the full explanation; later wrong
        // answers in this chat receive a short contrast of both phrases.
        const shortWrong=!correct&&Number(q.wrongCount.get(token,question.correct_index)?.n||0)>0;
        let reference;
        let message;
        try {
            // Only wrong answers need the lesson-part reply and lookup text.
            // The first correct reply includes two examples; later correct
            // replies contain only the phrase, IPA, Russian reading and meaning.
            reference=!correct?lessonReferenceLines(peerId,right,{revealCorrect}):{text:[],reply:{}};
            const explanation=buildHuinglishQuizAnswerExplanation({right,picked,correct,shortCorrect,shortWrong,revealCorrect});
            message='[id'+userId+'|Твой ответ]:\n'+explanation+
                (!shortWrong&&reference.text.length?'\n\n'+reference.text.join('\n'):'');
            if(message.length>4096)throw Error('VK quiz explanation too long: '+message.length);
        } catch(error) {
            logger.error('[HUINGLISH QUIZ EXPLANATION ERROR]',String(error?.message||error));
            return {ok:false,text:'Не удалось подготовить разбор'};
        }
        try {
            const suffix=kind==='correction'?'correction':kind==='repeatCorrect'?'repeat':record.choice;
            const tag='answer:'+token+':'+userId+':'+suffix;
            if(!correct && Object.keys(reference.reply).length) {
                try {
                    await sendVk(peerId,message,tag,reference.reply);
                } catch(error) {
                    logger.warn?.('[HUINGLISH QUIZ LESSON REPLY FAILED]',String(error?.message||error));
                    await sendVk(peerId,message,tag+':without_quote');
                }
            } else await sendVk(peerId,message,tag);
            if (kind==='correction') q.markCorrected.run(token,String(userId));
            else if (kind==='repeatCorrect') q.markRepeatedCorrect.run(token,String(userId));
            else q.markAnswered.run(token,String(userId));
            await sendSitePromo(peerId,tag);
        } catch (error) {
            logger.error('[HUINGLISH QUIZ ANSWER ERROR]','peer='+peerId,String(error?.message||error));
            return {ok:false,text:'Не удалось отправить разбор'};
        }
        // Any copy of the CURRENT question shares its token. Older questions
        // may still receive feedback, but cannot reset/drop a newer question.
        const current=q.get.get(String(peerId));
        if (current?.enabled&&current.pending_token===token) {
            current.pending_token='';
            if (correct) {
                current.current_interval_ms=current.interval_ms;
                current.next_at=addHuinglishActiveMilliseconds(now(),current.interval_ms,timeZone,audience(current));
            } else {
                // Wrong answer: new question NOW, but keep accumulated speed.
                current.next_at=nextHuinglishActiveTime(now(),timeZone,audience(current));
            }
            save(current);
            if (!correct) await sendDue(current);
        }
        return {ok:true,text:correct?'Правильно!':'Ответ разобран в чате'};
    }
    async function tick() {
        if (ticking) return;
        ticking=true;
        try {
            if (now()>=nextCleanupAt) {
                const cutoff=now()-QUESTION_TTL_MS;
                q.cleanAnswers.run(cutoff); q.cleanQuestions.run(cutoff);
                nextCleanupAt=now()+24*3_600_000;
            }
            for (const state of q.active.all(now())) {
                try { await sendDue(state); }
                catch (error) { logger.error('[HUINGLISH QUIZ TICK ERROR]',String(error?.message||error)); }
            }
        } finally {ticking=false;}
    }
    return {command,answer,tick,inspect:peerId=>stateFor(peerId),lessonReference};
}
