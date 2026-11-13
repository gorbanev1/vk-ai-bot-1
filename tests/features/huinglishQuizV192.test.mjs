import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { HUINGLISH_QUIZ_BANK } from '../../src/features/english/huinglishQuizBank.js';
import { HUINGLISH_QUIZ_LEADS } from '../../src/features/english/huinglishQuizLeads.js';
import { HUINGLISH_QUIZ_PRONUNCIATIONS } from '../../src/features/english/huinglishQuizPronunciations.js';
import { HUINGLISH_QUIZ_EXTRA_CHOICES } from '../../src/features/english/huinglishQuizOtherChoices.js';
import { HUINGLISH_QUIZ_NEAR_CHOICES, HUINGLISH_QUIZ_NEAR_BY_ANSWER } from '../../src/features/english/huinglishQuizNearChoices.js';
import { buildHuinglishQuizOptions } from '../../src/features/english/huinglishQuizChoices.js';
import { huinglishQuizOrigin } from '../../src/features/english/huinglishQuizLessonReference.js';
import { HUINGLISH_QUIZ_EXAMPLES } from '../../src/features/english/huinglishQuizExamples.js';
import { HUINGLISH_QUIZ_OTHER_EXAMPLES } from '../../src/features/english/huinglishQuizOtherExamples.js';
import { HUINGLISH_QUIZ_LEAD_EXPLANATIONS } from '../../src/features/english/huinglishQuizLeadExplanations.js';
import { buildHuinglishQuizAnswerExplanation } from '../../src/features/english/huinglishQuizAnswerExplanation.js';
import { createHuinglishQuiz, availableHuinglishQuizItems } from '../../src/features/english/huinglishQuiz.js';
import { parseHuinglishCommand } from '../../src/features/english/huinglishVkLesson.js';
import { createHuinglishMultiPlatform } from '../../src/features/english/huinglishMultiPlatform.js';
import { detectExplicitApplicationCommand } from '../../src/features/routing/explicitApplicationCommand.js';

function store(t, completed = [1], sitePromosEnabled=false) {
    const db = new DatabaseSync(':memory:');
    db.exec('CREATE TABLE huinglish_lessons(id INTEGER PRIMARY KEY,published INTEGER NOT NULL);' +
        'CREATE TABLE huinglish_subscriptions(platform TEXT,peer_id TEXT,completed_lesson INTEGER,completed_lessons_json TEXT,PRIMARY KEY(platform,peer_id));');
    for (let i = 1; i <= 7; i++) db.prepare('INSERT INTO huinglish_lessons VALUES(?,1)').run(i);
    db.prepare('INSERT INTO huinglish_subscriptions VALUES(?,?,?,?)')
        .run('vk','2000000008',completed.at(-1)||0,JSON.stringify(Object.fromEntries(completed.map(i => [i, '2026-11-04']))));
    let time = Date.parse('2026-11-04T10:30:00Z'), id = 0, failure = false;
    const sends = [], attempted = [];
    const vk = { api: { messages: { send: async args => {
        attempted.push(args);
        if (failure && args.keyboard) { failure = false; throw Error('VK API timeout'); }
        sends.push(args);
        return [{ peer_id: (args.peer_id ?? args.peer_ids?.[0]), message_id: ++id, conversation_message_id: id }];
    } } } };
    const logger = { info() {}, error() {} };
    const quiz = createHuinglishQuiz({vk,db,now:()=>time,logger,sitePromosEnabled});
    t.after(()=>db.close());
    return {db,vk,quiz,sends,attempted,ctx:{platform:'vk',peerId:'2000000008'},
        now:()=>time,advance:ms=>{time+=ms},failQuestion:()=>{failure=true}};
}
function quizMessages(sends) { return sends.filter(x=>Boolean(x.keyboard)); }
function buttons(payload) { return JSON.parse(payload.keyboard).buttons.flat(); }

test('96 questions cover every taught main phrase and 25 review phrases', () => {
    assert.equal(HUINGLISH_QUIZ_BANK.length, 96);
    const count = new Map();
    for (const item of HUINGLISH_QUIZ_BANK) {
        count.set(item.lesson, (count.get(item.lesson)||0)+1);
        assert.ok(HUINGLISH_QUIZ_LEADS[item.answer], 'English context for ' + item.answer);
        assert.ok(item.answer.length <= 40, 'VK label length ' + item.answer);
        assert.ok(item.meaning && item.usage && item.scene);
        assert.ok(HUINGLISH_QUIZ_PRONUNCIATIONS[item.answer]?.ipa);
        assert.ok(HUINGLISH_QUIZ_PRONUNCIATIONS[item.answer]?.ru);
    }
    assert.deepEqual(Object.fromEntries(count), {'1':15,'2':10,'3':14,'4':14,'5':9,'6':25,'7':9});
});

test('every accepted on/off syntax is explicit, interval is hours with one-minute floor', () => {
    const cases = [
        ['хуинглиш тесты', 'quizOn', null], ['хуинглиш тесты вкл', 'quizOn', null],
        ['хуинглиш тесты включить', 'quizOn', null],
        ['хуинглиш тесты 1.5', 'quizOn', 5400000],
        ['хуинглиш тесты 0.2', 'quizOn', 720000],
        ['хуинглиш тесты 0,5', 'quizOn', 1800000],
        ['хуинглиш тесты включить 0.5','quizOn',1800000],
        ['хуинглиш тесты вкл 1/6','quizOn',600000],
        ['гигорейв хуинглиш тесты 1/60','quizOn',60000],
        ['хуинглиш тесты 0.1','quizOn',360000],
        ['хуинглиш тесты ускорение','quizOn',null],
        ['хуинглиш тесты 1/6 ускор','quizOn',600000],
        ['хуинглиш тесты вкл 0.5 ускорять','quizOn',1800000],
        ['хуинглиш тесты выкл ускорение','quizOff',undefined],
        ['хуинглиш тесты выкл','quizOff',undefined],
        ['хуинглиш тесты откл','quizOff',undefined],
        ['хуинглиш тесты отключить','quizOff',undefined],
        ['хуинглиш тесты выключить','quizOff',undefined],
    ];
    for (const [text,type,intervalMs] of cases) {
        const cmd = parseHuinglishCommand(text);
        assert.equal(cmd?.type,type,text);
        assert.equal(cmd?.intervalMs,intervalMs,text);
        assert.equal(detectExplicitApplicationCommand(text).family,'huinglish',text);
    }
    for (const invalid of ['хуинглиш тесты 0','хуинглиш тесты 1/0','хуинглиш тесты 0.001','хуинглиш тесты 1/120','хуинглиш тесты 73','хуинглиш тесты непонятно']) {
        assert.equal(parseHuinglishCommand(invalid)?.type,'quizInvalid',invalid);
    }
});

test('only finished, published lessons are eligible for tests', t => {
    const f = store(t,[1,2,5]);
    assert.equal(availableHuinglishQuizItems(f.db,'2000000008').length,15+10+9);
    assert.equal(availableHuinglishQuizItems(f.db,'unsubscribed').length,0);
    f.db.prepare('UPDATE huinglish_lessons SET published=0 WHERE id=5').run();
    assert.equal(availableHuinglishQuizItems(f.db,'2000000008').length,25);
});

test('VK questions have 4–6 vertical buttons; wrong replies hide the right answer until a correct click', async t => {
    const f=store(t);
    await f.quiz.command(f.ctx,{type:'quizHideCorrect'});
    await f.quiz.command(f.ctx,{type:'quizOn',intervalMs:60000});
    const questions=quizMessages(f.sends);
    assert.equal(questions.length,1);
    assert.match(questions[0].message,/A: .+\nB: «___»/u);
    const layout=JSON.parse(questions[0].keyboard).buttons;
    assert.ok(layout.length>=4&&layout.length<=6);
    assert.ok(layout.every(row=>row.length===1));
    const actions=buttons(questions[0]);
    assert.ok(actions.every(x=>x.action.type==='callback'&&x.action.label.length<=40));
    const token=JSON.parse(actions[0].action.payload).token;
    const row=f.db.prepare('SELECT * FROM huinglish_quiz_questions WHERE token=?').get(token);
    assert.equal(new Set(JSON.parse(row.options_json)).size,layout.length);
    const right=HUINGLISH_QUIZ_BANK.find(x=>x.id===row.question_id);
    const wrong=(row.correct_index+1)%layout.length;
    const r1=await f.quiz.answer({peerId:'2000000008',userId:'12345',payload:{token,choice:wrong}});
    assert.equal(r1.ok,true);
    const explanation=f.sends.find(x=>x.message.includes('❌ НЕПРАВИЛЬНО')).message;
    assert.match(explanation,/ТВОЙ ВАРИАНТ/u);
    assert.match(explanation,/ЧТО ЗНАЧИЛ ВОПРОС/u);
    assert.doesNotMatch(explanation,/Правильный вариант пока|Сравни порядок слов|Вопрос не повторится/u);
    assert.ok(!explanation.includes('🇬🇧 '+right.answer),'wrong reply must not identify correct button');
    assert.ok(!explanation.includes('🔎 Поиск по сообщениям чата: «'+right.answer),'lesson hint must not leak');
    assert.equal(quizMessages(f.sends).length,2,'wrong answer advances to a different question');
    const nextToken=JSON.parse(buttons(quizMessages(f.sends).at(-1))[0].action.payload).token;
    assert.notEqual(nextToken,token);
    const corrected=await f.quiz.answer({peerId:'2000000008',userId:'12345',payload:{token,choice:row.correct_index}});
    assert.equal(corrected.ok,true,'old question remains clickable');
    assert.match(f.sends.at(-1).message,/✅ ПРАВИЛЬНО/u);
    assert.match(f.sends.at(-1).message,/Пример 2:/u);
    const afterCorrect=await f.quiz.answer({peerId:'2000000008',userId:'67890',payload:{token,choice:wrong}});
    assert.equal(afterCorrect.ok,true);
    assert.ok(f.sends.at(-1).message.includes('🇬🇧 '+right.answer),'wrong replies after solve may reveal');
    assert.equal(f.quiz.inspect('2000000008').pending_token,nextToken,'old question cannot replace the current one');
});

test('one-minute schedule survives recreation, rotates all lesson-1 phrases before repeating, and off cancels', async t => {
    const f=store(t);
    await f.quiz.command(f.ctx,{type:'quizOn',intervalMs:60000});
    let previous=quizMessages(f.sends).length;
    for(let i=1;i<15;i++){
        const previousQuestion=quizMessages(f.sends).at(-1);
        const token=JSON.parse(buttons(previousQuestion)[0].action.payload).token;
        const index=f.db.prepare('SELECT correct_index FROM huinglish_quiz_questions WHERE token=?').get(token).correct_index;
        await f.quiz.answer({peerId:'2000000008',userId:'12345',payload:{token,choice:index}});
        f.advance(60_000);
        const recreated=createHuinglishQuiz({vk:f.vk,db:f.db,now:f.now,sitePromosEnabled:false,logger:{info(){},error(){}}});
        await recreated.tick();
        assert.equal(quizMessages(f.sends).length,previous+1);
        previous++;
    }
    const rows=f.db.prepare('SELECT question_id FROM huinglish_quiz_questions ORDER BY created_at').all().map(x=>x.question_id);
    assert.equal(new Set(rows).size,15,'all expressions appear before repeat');
    await f.quiz.command(f.ctx,{type:'quizOff'});
    f.advance(10*60_000);
    await f.quiz.tick();
    assert.equal(quizMessages(f.sends).length,15);
});

test('transport failure holds the same pending question and deduplicates retry random_id', async t => {
    const f=store(t);
    f.failQuestion();
    await f.quiz.command(f.ctx,{type:'quizOn',intervalMs:60000});
    assert.equal(quizMessages(f.sends).length,0);
    assert.ok(f.quiz.inspect('2000000008').pending_token);
    const first=f.attempted.filter(x=>x.keyboard)[0];
    f.advance(60_000);
    await f.quiz.tick();
    const second=f.attempted.filter(x=>x.keyboard)[1];
    assert.equal(second.random_id,first.random_id);
    assert.equal(f.quiz.inspect('2000000008').pending_token,JSON.parse(buttons(second)[0].action.payload).token);
    assert.equal(quizMessages(f.sends).length,1);
});

test('whole HuInglish command handler integrates quiz without changing existing lesson progress', async t => {
    const dir=mkdtempSync(join(tmpdir(),'huinglish-quiz-integrated-'));
    mkdirSync(join(dir,'english-huinglish'),{recursive:true});
    for(let i=1;i<=4;i++)writeFileSync(join(dir,'english-huinglish','lesson1_part'+i+'.txt'),'LESSON PART '+i);
    writeFileSync(join(dir,'english-huinglish','intro_vk.jpg'),'image');
    const dbPath=join(dir,'test.sqlite');
    const events=[];
    let n=100;
    const vk={api:{messages:{send:async args=>{events.push(args);return [{peer_id:(args.peer_id ?? args.peer_ids?.[0]),message_id:++n,conversation_message_id:n}]}}},upload:{messagePhoto:async()=>'photo1_1'}};
    const app=createHuinglishMultiPlatform({vk,dbPath,dataDir:dir,now:()=>Date.parse('2026-11-04T10:00:00Z'),sitePromosEnabled:false,logger:{info(){},error(){},warn(){}}});
    t.after(async()=>{await app.close();rmSync(dir,{recursive:true,force:true})});
    const peerId='2000000055',ctx={platform:'vk',peerId,isPrivate:false,isOwner:true};
    const issue=async text=>{assert.equal(app.handle({...ctx,text}),true);await app.idle()};
    await issue('хуинглиш вкл');
    for(let i=0;i<3;i++)await issue('хуинглиш далее');
    assert.equal(app.inspect('vk',peerId).subscription.completed_lesson,1);
    await issue('хуинглиш тесты 1/60');
    assert.ok(events.some(x=>x.keyboard && [4,5,6].includes(JSON.parse(x.keyboard).buttons.flat().length)));
    assert.equal(app.inspect('vk',peerId).quiz.interval_ms,60000);
    await issue('хуинглиш тесты отключить');
    assert.equal(app.inspect('vk',peerId).quiz.enabled,0);
    assert.equal(app.inspect('vk',peerId).subscription.enabled,1);
});

test('all 96 quiz slots rotate with 4–6 unique choices and 2–4 curated near-misses', async t => {
    const f=store(t,[1,2,3,4,5,6,7]);
    await f.quiz.command(f.ctx,{type:'quizOn',intervalMs:60000});
    for(let i=1;i<96;i++){
        const last=quizMessages(f.sends).at(-1);
        const token=JSON.parse(buttons(last)[0].action.payload).token;
        const index=f.db.prepare('SELECT correct_index FROM huinglish_quiz_questions WHERE token=?').get(token).correct_index;
        await f.quiz.answer({peerId:'2000000008',userId:'12345',payload:{token,choice:index}});
        f.advance(60000);
        await f.quiz.tick();
    }
    const records=f.db.prepare('SELECT question_id,options_json,correct_index FROM huinglish_quiz_questions ORDER BY created_at').all();
    assert.equal(records.length,96);
    assert.equal(new Set(records.map(row=>row.question_id)).size,96);
    const byId=new Map([...HUINGLISH_QUIZ_BANK,...HUINGLISH_QUIZ_EXTRA_CHOICES,...HUINGLISH_QUIZ_NEAR_CHOICES].map(x=>[x.id,x]));
    const counts={4:0,5:0,6:0};
    for(const row of records) {
        const ids=JSON.parse(row.options_json);
        counts[ids.length]=(counts[ids.length]||0)+1;
        assert.ok(ids.length>=4&&ids.length<=6);
        assert.equal(new Set(ids).size,ids.length);
        assert.ok(ids.every(id=>byId.has(id)));
        assert.equal(ids[row.correct_index],row.question_id);
        assert.ok(ids.filter(id=>id.startsWith('near:')).length>=2);
        assert.ok(ids.filter(id=>id.startsWith('extra:')).length<=1);
        assert.ok(ids.filter(id=>!id.startsWith('near:')&&!id.startsWith('extra:')&&id!==row.question_id).length<=1);
        assert.equal(new Set(ids.map(id=>byId.get(id).answer.toLowerCase())).size,ids.length);
    }
    assert.ok(counts[4]>0&&counts[5]>0&&counts[6]>0,JSON.stringify(counts));
});

test('turning tests off during a delayed VK send cannot silently enable them again', async t => {
    const f=store(t);
    let release, entered;
    const block=new Promise(resolve=>{release=resolve});
    const arrived=new Promise(resolve=>{entered=resolve});
    const original=f.vk.api.messages.send;
    f.vk.api.messages.send=async args=>{
        if(args.keyboard){entered();await block;}
        return original(args);
    };
    const on=f.quiz.command(f.ctx,{type:'quizOn',intervalMs:60000});
    await arrived;
    await f.quiz.command(f.ctx,{type:'quizOff'});
    release();
    await on;
    assert.equal(f.quiz.inspect('2000000008').enabled,0);
    f.advance(3600000);await f.quiz.tick();
    assert.equal(f.quiz.inspect('2000000008').enabled,0);
});

test('default mode uses a six-hour interval and repeats an unanswered question', async t => {
    const f=store(t);
    await f.quiz.command(f.ctx,{type:'quizOn',intervalMs:null,accelerate:null});
    const baseline=f.quiz.inspect('2000000008');
    assert.equal(baseline.interval_ms,6*3600000);
    assert.equal(baseline.acceleration_enabled,0);
    const initial=quizMessages(f.sends)[0];
    const token=JSON.parse(buttons(initial)[0].action.payload).token;
    f.advance(6*3600000-1000);
    await f.quiz.tick();
    assert.equal(quizMessages(f.sends).length,1);
    f.advance(1000);
    await f.quiz.tick();
    assert.equal(quizMessages(f.sends).length,2);
    assert.equal(JSON.parse(buttons(quizMessages(f.sends)[1])[0].action.payload).token,token);
    assert.equal(f.quiz.inspect('2000000008').current_interval_ms,6*3600000);
    assert.notEqual(quizMessages(f.sends)[0].random_id,quizMessages(f.sends)[1].random_id);
});

test('sub-hour acceleration halves after repeats and resets only after correct', async t => {
    const f=store(t);
    await f.quiz.command(f.ctx,{type:'quizOn',intervalMs:1800000,accelerate:true});
    const q1=quizMessages(f.sends)[0];
    const firstToken=JSON.parse(buttons(q1)[0].action.payload).token;
    assert.equal(f.quiz.inspect('2000000008').current_interval_ms,1800000);

    f.advance(1800000);
    await f.quiz.tick();
    assert.equal(quizMessages(f.sends).length,2);
    assert.equal(JSON.parse(buttons(quizMessages(f.sends)[1])[0].action.payload).token,firstToken);
    assert.equal(f.quiz.inspect('2000000008').current_interval_ms,900000);

    f.advance(900000);
    await f.quiz.tick();
    assert.equal(quizMessages(f.sends).length,3);
    assert.equal(f.quiz.inspect('2000000008').current_interval_ms,450000);
    f.advance(450000);
    await f.quiz.tick();
    assert.equal(f.quiz.inspect('2000000008').current_interval_ms,225000);

    // Respond to the FIRST copy even though the same question has been
    // reposted three times. It is still active and must work.
    const row=f.db.prepare('SELECT * FROM huinglish_quiz_questions WHERE token=?').get(firstToken);
    const wrong=(row.correct_index+1)%4;
    const answer=await f.quiz.answer({peerId:'2000000008',userId:'12345',payload:{token:firstToken,choice:wrong}});
    assert.equal(answer.ok,true);
    const questions=quizMessages(f.sends);
    assert.equal(questions.length,5,'wrong answer creates a new question immediately');
    const newToken=JSON.parse(buttons(questions.at(-1))[0].action.payload).token;
    assert.notEqual(newToken,firstToken);
    assert.equal(f.quiz.inspect('2000000008').current_interval_ms,225000,'speed preserved after wrong answer');
    assert.equal(f.quiz.inspect('2000000008').next_at,f.now()+225000);

    // Another person's correct answer on the OLD question must not
    // invalidate the CURRENT new question.
    const previous=await f.quiz.answer({peerId:'2000000008',userId:'67890',payload:{token:firstToken,choice:row.correct_index}});
    assert.equal(previous.ok,true);
    assert.equal(f.quiz.inspect('2000000008').pending_token,newToken);
    assert.equal(f.quiz.inspect('2000000008').current_interval_ms,225000);

    const nextRow=f.db.prepare('SELECT * FROM huinglish_quiz_questions WHERE token=?').get(newToken);
    const correct=await f.quiz.answer({peerId:'2000000008',userId:'67890',payload:{token:newToken,choice:nextRow.correct_index}});
    assert.equal(correct.ok,true);
    const state=f.quiz.inspect('2000000008');
    assert.equal(state.current_interval_ms,1800000,'correct answer resets acceleration');
    assert.equal(state.next_at,f.now()+1800000);
    assert.equal(state.pending_token,'');
});

test('normal mode keeps interval on wrong answer and accepts accelerating aliases', async t => {
    const f=store(t);
    for(const suffix of ['ускорение','ускор','ускорять']){
        const cmd=parseHuinglishCommand('Хуинглиш тесты 1/6 '+suffix);
        assert.equal(cmd.type,'quizOn');
        assert.equal(cmd.intervalMs,600000);
        assert.equal(cmd.accelerate,true);
    }
    await f.quiz.command(f.ctx,{type:'quizOn',intervalMs:600000,accelerate:false});
    const previous=quizMessages(f.sends)[0];
    const token=JSON.parse(buttons(previous)[0].action.payload).token;
    const row=f.db.prepare('SELECT * FROM huinglish_quiz_questions WHERE token=?').get(token);
    await f.quiz.answer({peerId:'2000000008',userId:'12345',
        payload:{token,choice:(row.correct_index+1)%4}});
    const state=f.quiz.inspect('2000000008');
    assert.equal(state.current_interval_ms,600000);
    assert.equal(state.next_at,f.now()+600000);
    assert.equal(quizMessages(f.sends).length,2);
    await f.quiz.command(f.ctx,{type:'quizOff'});
    f.advance(600000);
    await f.quiz.tick();
    assert.equal(quizMessages(f.sends).length,2,'disabled mode stops all questions');
});

test('one-hour chat NEVER receives another quiz before 60 minutes, even after a wrong answer', async t => {
    const f=store(t,[1,2,3]);
    await f.quiz.command(f.ctx,{type:'quizOn',intervalMs:3600000,accelerate:true});
    const first=quizMessages(f.sends)[0];
    const token=JSON.parse(buttons(first)[0].action.payload).token;
    const current=f.db.prepare('SELECT correct_index FROM huinglish_quiz_questions WHERE token=?').get(token);
    const wrong=(current.correct_index+1)%4;
    await f.quiz.answer({peerId:'2000000008',userId:'12345',payload:{token,choice:wrong}});
    assert.equal(quizMessages(f.sends).length,1,'wrong answer cannot bypass the hourly limit');
    assert.equal(f.quiz.inspect('2000000008').next_at,f.now()+3600000);
    f.advance(3599000);
    const restarted=createHuinglishQuiz({vk:f.vk,db:f.db,now:f.now,sitePromosEnabled:false,logger:{info(){},error(){}}});
    await restarted.tick();
    assert.equal(quizMessages(f.sends).length,1,'no early question after process recreation');
    f.advance(1000);
    await restarted.tick();
    assert.equal(quizMessages(f.sends).length,2,'new question exactly at one-hour mark');
    const secondToken=JSON.parse(buttons(quizMessages(f.sends)[1])[0].action.payload).token;
    assert.notEqual(secondToken,token,'wrong answer still advances to new question');
    f.advance(3600000);
    await restarted.tick();
    assert.equal(quizMessages(f.sends).length,3,'unanswered question is repeated after one hour');
    assert.equal(JSON.parse(buttons(quizMessages(f.sends)[2])[0].action.payload).token,secondToken);
    assert.equal(f.quiz.inspect('2000000008').current_interval_ms,3600000,'acceleration cannot break one-hour minimum');
});

test('accelerated short intervals stop at one-minute cadence instead of flooding', async t => {
    const f=store(t);
    await f.quiz.command(f.ctx,{type:'quizOn',intervalMs:60000,accelerate:true});
    for(let i=0;i<10;i++){
        f.advance(60000);
        await f.quiz.tick();
    }
    assert.equal(quizMessages(f.sends).length,11);
    assert.equal(f.quiz.inspect('2000000008').current_interval_ms,60000);
    assert.equal(f.db.prepare('SELECT count(*) n FROM huinglish_quiz_questions').get().n,1);
});

test('all lesson expressions have two distinct everyday examples and a fully decoded A-line', () => {
    assert.equal(Object.keys(HUINGLISH_QUIZ_LEADS).length,71);
    for (const item of HUINGLISH_QUIZ_BANK) {
        const example = HUINGLISH_QUIZ_EXAMPLES[item.answer];
        assert.ok(example && example.length >= 2,item.answer);
        assert.notEqual(example[0].en,example[1].en,item.answer);
        assert.ok(example.every(x=>x.en && x.ru),item.answer);
        const lead=HUINGLISH_QUIZ_LEAD_EXPLANATIONS[item.answer];
        assert.ok(lead?.ipa && (lead?.ru||lead?.russian) && (lead?.translation||lead?.meaning),item.answer);
        const rendered=buildHuinglishQuizAnswerExplanation({right:item,picked:item,correct:true});
        assert.ok(rendered.includes('A: '+HUINGLISH_QUIZ_LEADS[item.answer]),item.answer);
        assert.ok(rendered.includes('🔤 '+lead.ipa),item.answer);
        assert.ok(rendered.includes('🗣 '+(lead.ru||lead.russian)),item.answer);
        assert.ok(rendered.includes('🇷🇺 '+(lead.translation||lead.meaning)),item.answer);
        assert.ok(rendered.includes(example[0].en)&&rendered.includes(example[0].ru),item.answer);
        assert.ok(rendered.includes(example[1].en)&&rendered.includes(example[1].ru),item.answer);
        assert.match(rendered,/Пример 1:[^\n]+\n↳ [^\n]+\n💬 Пример 2:[^\n]+\n↳ [^\n]+/u);
        assert.ok(rendered.length<3500,'VK length '+item.answer);
    }
});

test('full wrong explanations decode a REAL chosen phrase but never reveal the correct one before solution', () => {
    for(const picked of [...HUINGLISH_QUIZ_EXTRA_CHOICES,...HUINGLISH_QUIZ_BANK]) {
        const right=HUINGLISH_QUIZ_BANK.find(x=>x.answer!==picked.answer&&x.meaning!==picked.meaning);
        const msg=buildHuinglishQuizAnswerExplanation({right,picked,correct:false,revealCorrect:false});
        const ex=HUINGLISH_QUIZ_EXAMPLES[picked.answer]||HUINGLISH_QUIZ_OTHER_EXAMPLES[picked.answer];
        assert.ok(msg.includes('❌ ТВОЙ ВАРИАНТ:'));
        assert.ok(msg.includes('🇬🇧 '+picked.answer));
        assert.ok(msg.includes('🔤 '));
        assert.ok(msg.includes('🇷🇺 '+picked.meaning));
        assert.ok(msg.includes('Пример 1: '+ex[0].en));
        assert.ok(msg.includes('Пример 2: '+ex[1].en));
        assert.ok(!msg.includes('✅ ПРАВИЛЬНЫЙ ОТВЕТ:'));
        assert.ok(!msg.includes('🇬🇧 '+right.answer));
        const revealed=buildHuinglishQuizAnswerExplanation({right,picked,correct:false,revealCorrect:true});
        assert.ok(revealed.includes('✅ ПРАВИЛЬНЫЙ ОТВЕТ:'));
        assert.ok(revealed.includes('🇬🇧 '+right.answer));
        assert.ok(revealed.includes(HUINGLISH_QUIZ_EXAMPLES[right.answer][0].en));
        assert.ok(revealed.length<3500);
    }
});

test('play it by ear: A-line, chosen outside phrase and reveal gate are independently decoded', () => {
    const right=HUINGLISH_QUIZ_BANK.find(x=>x.answer==="Let's play it by ear.");
    const picked=HUINGLISH_QUIZ_EXTRA_CHOICES.find(x=>x.answer==="I missed my bus.");
    const hidden=buildHuinglishQuizAnswerExplanation({right,picked,correct:false,revealCorrect:false});
    assert.match(hidden,/A: Should we plan every minute\?/u);
    assert.match(hidden,/🇷🇺 Нужно ли нам распланировать каждую минуту\?/u);
    assert.match(hidden,/🗣 Шуд уи плэн/u);
    assert.match(hidden,/Пример 1: I missed my bus this morning\./u);
    assert.ok(!hidden.includes('🇬🇧 '+right.answer));
    const revealed=buildHuinglishQuizAnswerExplanation({right,picked,correct:false,revealCorrect:true});
    assert.ok(revealed.includes('🇬🇧 '+right.answer));
    assert.match(revealed,/Пример 1: It might rain\. Let's play it by ear\./u);
    assert.match(revealed,/Пример 2: No need to book yet\. Let's play it by ear\./u);
    // This absurd outside phrase is retained for legacy questions only,
    // never selected for a new "play it by ear" question.
    assert.ok(!buildHuinglishQuizOptions(right,HUINGLISH_QUIZ_BANK,101).some(x=>x.answer===picked.answer));
});

test('wrong answer REPLIES to the exact archived/recorded HuInglish lesson part', async t => {
    const f=store(t,[1,2,3,4,5]);
    await f.quiz.command(f.ctx,{type:'quizHideCorrect'});
    await f.quiz.command(f.ctx,{type:'quizOn',intervalMs:3600000,accelerate:false});
    const first=quizMessages(f.sends)[0];
    const token=JSON.parse(buttons(first)[0].action.payload).token;
    const row=f.db.prepare('SELECT * FROM huinglish_quiz_questions WHERE token=?').get(token);
    const item=HUINGLISH_QUIZ_BANK.find(x=>x.id===row.question_id);
    const origin=huinglishQuizOrigin(item);
    assert.ok(origin);
    f.quiz.lessonReference.record({
        platform:'vk',peerId:'2000000008',lessonId:origin.lesson,
        partNumber:origin.part,messageId:51909,conversationMessageId:8809,sentAt:f.now(),
    });
    await f.quiz.answer({peerId:'2000000008',userId:'12345',
        payload:{token,choice:(row.correct_index+1)%4}});
    const delivered=f.sends.find(x=>x.message.includes('❌ НЕПРАВИЛЬНО'));
    assert.ok(delivered);
    assert.match(delivered.message,new RegExp('Проходили в уроке №'+origin.lesson+', часть '+origin.part,'u'));
    assert.match(delivered.message,/нужная фраза пока скрыта/u);
    assert.ok(delivered.forward,'the answer must reply to the exact lesson-part message');
    const reply=JSON.parse(delivered.forward);
    assert.equal(reply.peer_id,2000000008);
    assert.equal(reply.conversation_message_ids,8809);
    assert.equal(reply.is_reply,true,'VK must render this as Reply, not Forward');
    assert.equal(delivered.forward_messages,undefined,'do not forward/copy lesson message');
    assert.equal(quizMessages(f.sends).length,1,'one-hour chat remains rate limited');
});

test('missing/deleted lesson reply falls back to text answer and never drops the explanation', async t => {
    const f=store(t,[1,2,3,4,5]);
    await f.quiz.command(f.ctx,{type:'quizOn',intervalMs:3600000});
    const first=quizMessages(f.sends)[0];
    const token=JSON.parse(buttons(first)[0].action.payload).token;
    const row=f.db.prepare('SELECT * FROM huinglish_quiz_questions WHERE token=?').get(token);
    const origin=huinglishQuizOrigin(HUINGLISH_QUIZ_BANK.find(x=>x.id===row.question_id));
    f.quiz.lessonReference.record({
        platform:'vk',peerId:'2000000008',lessonId:origin.lesson,
        partNumber:origin.part,messageId:51909,conversationMessageId:8809,sentAt:f.now(),
    });
    const original=f.vk.api.messages.send;
    f.vk.api.messages.send=async args=>{
        if(args.forward)throw Error('VK quoted message no longer exists');
        return original(args);
    };
    const result=await f.quiz.answer({peerId:'2000000008',userId:'12345',
        payload:{token,choice:(row.correct_index+1)%4}});
    assert.equal(result.ok,true);
    const delivered=f.sends.find(x=>x.message.includes('❌ НЕПРАВИЛЬНО'));
    assert.ok(delivered);
    assert.equal(delivered.forward,undefined);
    assert.doesNotMatch(delivered.message,/Правильный вариант пока|Сравни порядок слов|Вопрос не повторится/u);
    assert.equal(f.db.prepare('SELECT delivered FROM huinglish_quiz_answers WHERE token=? AND user_id=?').get(token,'12345').delivered,1);
});

test('all repeated VK copies of one question share first-correct and later-short modes', async t => {
    const f=store(t,[1,2,3]);
    await f.quiz.command(f.ctx,{type:'quizOn',intervalMs:60000});
    const first=quizMessages(f.sends)[0];
    const firstToken=JSON.parse(buttons(first)[0].action.payload).token;
    f.advance(60000);
    await f.quiz.tick();
    const secondCopy=quizMessages(f.sends)[1];
    assert.equal(JSON.parse(buttons(secondCopy)[0].action.payload).token,firstToken,
        'all unanswered reminders use same question token');
    const row=f.db.prepare('SELECT correct_index FROM huinglish_quiz_questions WHERE token=?').get(firstToken);
    const firstCorrect=await f.quiz.answer({peerId:'2000000008',userId:'12345',
        payload:{token:firstToken,choice:row.correct_index}});
    assert.equal(firstCorrect.ok,true);
    const expanded=f.sends.at(-1).message;
    assert.match(expanded,/✅ ПРАВИЛЬНО!/u);
    assert.match(expanded,/📖 ЧТО ЗНАЧИЛ ВОПРОС:/u);
    assert.match(expanded,/🔤 \/.+\//u);
    assert.match(expanded,/🗣 .+/u);
    assert.match(expanded,/🇷🇺 .+/u);
    assert.match(expanded,/💬 Пример 1:/u);
    assert.match(expanded,/💬 Пример 2:/u);
    const afterFirst=f.quiz.inspect('2000000008').next_at;

    const secondCorrect=await f.quiz.answer({peerId:'2000000008',userId:'67890',
        payload:{token:firstToken,choice:row.correct_index}});
    assert.equal(secondCorrect.ok,true);
    const compact=f.sends.at(-1).message;
    assert.match(compact,/✅ ДА, ПРАВИЛЬНО!/u);
    assert.match(compact,/🇬🇧 .+\n🔤 \/.+\//u);
    assert.match(compact,/🗣 .+\n🇷🇺 .+/u);
    assert.doesNotMatch(compact,/Пример|📖|Уместно|ЧТО ЗНАЧИЛ|Проходили в уроке/u);
    assert.ok(compact.length < expanded.length/2,
        'later correct responses are much shorter than first one');
    assert.equal(f.quiz.inspect('2000000008').next_at,afterFirst,
        'other participant answering an older copy must not change question schedule');

    const thirdCorrect=await f.quiz.answer({peerId:'2000000008',userId:'13579',
        payload:{token:firstToken,choice:row.correct_index}});
    assert.equal(thirdCorrect.ok,true);
    assert.match(f.sends.at(-1).message,/✅ ДА, ПРАВИЛЬНО!/u);
    assert.doesNotMatch(f.sends.at(-1).message,/Пример/u);
    assert.equal(f.db.prepare('SELECT count(*) n FROM huinglish_quiz_answers WHERE token=? AND delivered=1 AND choice=?')
        .get(firstToken,row.correct_index).n,3);
    assert.equal(quizMessages(f.sends).length,2,
        'answering the old question must not send another question immediately');
});

test('after ANY correct answer, later WRONG replies can reveal the right phrase and two examples', async t => {
    const f=store(t,[1,2,3]);
    await f.quiz.command(f.ctx,{type:'quizOn',intervalMs:3600000});
    const token=JSON.parse(buttons(quizMessages(f.sends)[0])[0].action.payload).token;
    const row=f.db.prepare('SELECT * FROM huinglish_quiz_questions WHERE token=?').get(token);
    await f.quiz.answer({peerId:'2000000008',userId:'12345',payload:{token,choice:row.correct_index}});
    const wrong=(row.correct_index+1)%JSON.parse(row.options_json).length;
    await f.quiz.answer({peerId:'2000000008',userId:'67890',payload:{token,choice:wrong}});
    const text=f.sends.at(-1).message;
    const right=HUINGLISH_QUIZ_BANK.find(x=>x.id===row.question_id);
    assert.match(text,/❌ НЕПРАВИЛЬНО/u);
    assert.match(text,/❌ ТВОЙ ВАРИАНТ:/u);
    assert.match(text,/✅ ПРАВИЛЬНЫЙ ОТВЕТ:/u);
    assert.ok(text.includes('🇬🇧 '+right.answer));
    assert.match(text,/🏠 ЕЩЁ ДВА ЖИВЫХ ПРИМЕРА:/u);
    assert.match(text,/Пример 2:/u);
    assert.equal(quizMessages(f.sends).length,1,'hour-long cadence stays intact');
});

test('one learner can fix a wrong answer, then gets at most one further brief confirmation', async t => {
    const f=store(t,[1,2,3]);
    await f.quiz.command(f.ctx,{type:'quizOn',intervalMs:3600000});
    const first=quizMessages(f.sends)[0];
    const token=JSON.parse(buttons(first)[0].action.payload).token;
    const row=f.db.prepare('SELECT correct_index FROM huinglish_quiz_questions WHERE token=?').get(token);
    const wrong=(row.correct_index+1)%4;
    await f.quiz.answer({peerId:'2000000008',userId:'12345',payload:{token,choice:wrong}});
    const lastSent=f.sends.length;
    const firstCorrect=await f.quiz.answer({peerId:'2000000008',userId:'12345',
        payload:{token,choice:row.correct_index}});
    assert.equal(firstCorrect.ok,true);
    assert.equal(f.sends.length,lastSent+1);
    assert.match(f.sends.at(-1).message,/✅ ПРАВИЛЬНО!/u);
    assert.match(f.sends.at(-1).message,/💬 Пример 2:/u);
    const flags=f.db.prepare('SELECT choice,correction_delivered FROM huinglish_quiz_answers WHERE token=? AND user_id=?')
        .get(token,'12345');
    assert.equal(flags.choice,wrong);
    assert.equal(flags.correction_delivered,1,'correction survives restart');

    // User presses another copy of the same question once more: only a tiny
    // "yes, correct" confirmation. More taps cannot spam chat.
    const short=await f.quiz.answer({peerId:'2000000008',userId:'12345',
        payload:{token,choice:row.correct_index}});
    assert.equal(short.ok,true);
    assert.match(f.sends.at(-1).message,/✅ ДА, ПРАВИЛЬНО!/u);
    assert.doesNotMatch(f.sends.at(-1).message,/Пример|📖/u);
    const count=f.sends.length;
    await f.quiz.answer({peerId:'2000000008',userId:'12345',
        payload:{token,choice:row.correct_index}});
    assert.equal(f.sends.length,count,'repeated taps are de-duplicated');
    const restarted=createHuinglishQuiz({vk:f.vk,db:f.db,now:f.now,sitePromosEnabled:false,logger:{info(){},error(){}}});
    await restarted.answer({peerId:'2000000008',userId:'67890',
        payload:{token,choice:row.correct_index}});
    assert.match(f.sends.at(-1).message,/✅ ДА, ПРАВИЛЬНО!/u,
        'corrected answer is counted as correct across restarts');
});

test('existing quiz answer table receives additive per-user correction columns', t => {
    const db=new DatabaseSync(':memory:');
    t.after(()=>db.close());
    db.exec('CREATE TABLE huinglish_quiz_answers('+
        'token TEXT NOT NULL,user_id TEXT NOT NULL,choice INTEGER NOT NULL,'+
        'delivered INTEGER NOT NULL DEFAULT 0,created_at INTEGER NOT NULL,'+
        'PRIMARY KEY(token,user_id));');
    const vk={api:{messages:{send:async()=>[]}}};
    createHuinglishQuiz({vk,db,logger:{info(){},error(){},warn(){}}});
    const cols=new Set(db.prepare('PRAGMA table_info(huinglish_quiz_answers)').all().map(x=>x.name));
    assert.ok(cols.has('correction_delivered'));
    assert.ok(cols.has('repeat_correct_ack_delivered'));
    db.prepare('INSERT INTO huinglish_quiz_answers(token,user_id,choice,created_at) VALUES(?,?,?,?)')
        .run('old-token','123',1,1);
    const old=db.prepare('SELECT correction_delivered,repeat_correct_ack_delivered FROM huinglish_quiz_answers WHERE token=?')
        .get('old-token');
    assert.equal(old.correction_delivered,0);
    assert.equal(old.repeat_correct_ack_delivered,0);
});

test('multiple wrong replies keep the solution hidden; correct answer to old question unlocks it', async t => {
    const f=store(t,[1,2,3,4,5]);
    await f.quiz.command(f.ctx,{type:'quizHideCorrect'});
    await f.quiz.command(f.ctx,{type:'quizOn',intervalMs:60000});
    const token=JSON.parse(buttons(quizMessages(f.sends)[0])[0].action.payload).token;
    f.advance(60000);await f.quiz.tick();
    assert.equal(JSON.parse(buttons(quizMessages(f.sends)[1])[0].action.payload).token,token);
    const row=f.db.prepare('SELECT * FROM huinglish_quiz_questions WHERE token=?').get(token);
    const ids=JSON.parse(row.options_json);
    const wrongIndices=ids.map((_,i)=>i).filter(i=>i!==row.correct_index);
    const right=HUINGLISH_QUIZ_BANK.find(x=>x.id===row.question_id);
    await f.quiz.answer({peerId:'2000000008',userId:'12345',payload:{token,choice:wrongIndices[0]}});
    const full=f.sends.find(x=>x.message.includes('❌ НЕПРАВИЛЬНО')).message;
    assert.match(full,/📖 ЧТО ЗНАЧИЛ ВОПРОС:/u);
    assert.ok(!full.includes('🇬🇧 '+right.answer));
    const nextToken=JSON.parse(buttons(quizMessages(f.sends).at(-1))[0].action.payload).token;
    assert.notEqual(nextToken,token);
    await f.quiz.answer({peerId:'2000000008',userId:'67890',payload:{token,choice:wrongIndices[1]}});
    const second=f.sends.at(-1).message;
    assert.match(second,/❌ НЕТ, ЭТО НЕ ПОДХОДИТ/u);
    assert.doesNotMatch(second,/Правильный ответ пока|Правильный вариант пока|Сравни порядок слов/u);
    assert.ok(!second.includes('🇬🇧 '+right.answer));
    assert.ok(second.length<full.length);
    const restarted=createHuinglishQuiz({vk:f.vk,db:f.db,now:f.now,sitePromosEnabled:false,logger:{info(){},error(){},warn(){}}});
    await restarted.answer({peerId:'2000000008',userId:'13579',payload:{token,choice:row.correct_index}});
    assert.match(f.sends.at(-1).message,/✅ ПРАВИЛЬНО/u);
    await restarted.answer({peerId:'2000000008',userId:'24680',payload:{token,choice:wrongIndices[2]}});
    const after=f.sends.at(-1).message;
    assert.match(after,/✅ ПРАВИЛЬНЫЙ ВАРИАНТ:/u);
    assert.ok(after.includes('🇬🇧 '+right.answer));
    assert.equal(restarted.inspect('2000000008').pending_token,nextToken,'old question does not affect new one');
});

test('short wrong response covers learned, outside and broken choices without leaking the hidden answer', () => {
    const pool=[...HUINGLISH_QUIZ_BANK,...HUINGLISH_QUIZ_EXTRA_CHOICES,...HUINGLISH_QUIZ_NEAR_CHOICES];
    for(const right of HUINGLISH_QUIZ_BANK) {
        for(const picked of pool.filter(x=>x.answer!==right.answer).slice(0,20)) {
            const hidden=buildHuinglishQuizAnswerExplanation({right,picked,correct:false,shortWrong:true,revealCorrect:false});
            assert.ok(hidden.includes('🇬🇧 '+picked.answer));
            assert.ok(!hidden.includes('🇬🇧 '+right.answer));
            assert.ok(!hidden.includes('🔤 '+HUINGLISH_QUIZ_PRONUNCIATIONS[right.answer].ipa));
            assert.doesNotMatch(hidden,/Правильный ответ пока|Правильный вариант пока|Сравни порядок слов/u);
            assert.doesNotMatch(hidden,/Пример|ЧТО ЗНАЧИЛ ВОПРОС/u);
            const revealed=buildHuinglishQuizAnswerExplanation({right,picked,correct:false,shortWrong:true,revealCorrect:true});
            assert.ok(revealed.includes('🇬🇧 '+right.answer));
            assert.ok(revealed.includes('🔤 '+HUINGLISH_QUIZ_PRONUNCIATIONS[right.answer].ipa));
            assert.ok(revealed.length<1050);
        }
    }
});
test('all lesson questions have curated, unambiguous 4–6 options including outside but contextual contrasts', () => {
    assert.equal(HUINGLISH_QUIZ_NEAR_BY_ANSWER.size,71);
    assert.equal(HUINGLISH_QUIZ_NEAR_CHOICES.length,219);
    for(const right of HUINGLISH_QUIZ_BANK){
        const options=buildHuinglishQuizOptions(right,HUINGLISH_QUIZ_BANK,37);
        assert.ok(options.length>=4&&options.length<=6);
        assert.equal(options.filter(x=>x.answer===right.answer).length,1);
        const near=options.filter(x=>x.id.startsWith('near:'));
        assert.ok(near.length>=2);
        assert.ok(near.every(x=>x.trapExplanation&&x.sourceAnswer===right.answer));
        assert.ok(options.every(x=>x.answer.length<=40));
        const outside=options.filter(x=>x.id.startsWith('extra:'));
        assert.ok(outside.length<=1);
        assert.ok(!options.some(x=>x.answer==='I missed my bus.'),'unrelated bus sentence must not be used');
    }
    const cover=HUINGLISH_QUIZ_BANK.find(x=>x.answer==="What's the cover?");
    assert.ok(buildHuinglishQuizOptions(cover,HUINGLISH_QUIZ_BANK,37)
        .some(x=>x.answer==='The tickets sold out.'),'natural outside distractor should contrast ticket availability vs entry price');
});



test('default mode reveals the correct option with WHY after the first wrong answer', async t => {
    const f=store(t,[1,2,3]);
    assert.equal(f.db.prepare('SELECT count(*) AS n FROM huinglish_quiz_answer_modes').get().n,0);
    await f.quiz.command(f.ctx,{type:'quizOn',intervalMs:60000});
    const first=quizMessages(f.sends)[0];
    const token=JSON.parse(buttons(first)[0].action.payload).token;
    const row=f.db.prepare('SELECT * FROM huinglish_quiz_questions WHERE token=?').get(token);
    const right=HUINGLISH_QUIZ_BANK.find(item=>item.id===row.question_id);
    const total=JSON.parse(row.options_json).length;
    const wrong=(row.correct_index+1)%total;
    await f.quiz.answer({peerId:'2000000008',userId:'12345',payload:{token,choice:wrong}});
    const full=f.sends.find(x=>x.message.includes('❌ НЕПРАВИЛЬНО')).message;
    assert.ok(full.includes('🇬🇧 '+right.answer));
    assert.ok(full.includes('💡 Почему подходит: '));
    assert.ok(full.includes('Так говорят, когда '+right.usage));
    assert.ok(full.includes('Пример 1: '));
    assert.ok(full.includes('Пример 2: '));
    assert.ok(full.includes('🔎 Поиск по сообщениям чата: «'));
    assert.equal(quizMessages(f.sends).length,2,'wrong answer advances to another question');
    const nextToken=JSON.parse(buttons(quizMessages(f.sends).at(-1))[0].action.payload).token;
    assert.notEqual(nextToken,token);
    await f.quiz.answer({peerId:'2000000008',userId:'67890',payload:{token,choice:wrong}});
    const brief=f.sends.at(-1).message;
    assert.ok(brief.includes('✅ ПРАВИЛЬНЫЙ ВАРИАНТ:'));
    assert.ok(brief.includes('🇬🇧 '+right.answer));
    assert.ok(brief.includes('💡 Почему подходит: '),'short wrong answers also explain why');
    assert.equal(f.quiz.inspect('2000000008').pending_token,nextToken,'old responses cannot replace current task');
});

test('both hide commands persist per chat; explicit reveal restores default without resetting quiz', async t => {
    const f=store(t,[1,2,3]);
    for(const command of [
        'хуинглиш не раскрывать правильный',
        'хуинглиш сразу не раскрывать правильный',
        'Гигорейв, Хуинглиш сразу не раскрывать правильный!']) {
        const parsed=parseHuinglishCommand(command);
        assert.equal(parsed?.type,'quizHideCorrect',command);
        assert.equal(detectExplicitApplicationCommand(command).family,'huinglish',command);
    }
    assert.equal(parseHuinglishCommand('хуинглиш раскрывать правильный')?.type,'quizRevealCorrect');
    await f.quiz.command(f.ctx,parseHuinglishCommand('хуинглиш сразу не раскрывать правильный'));
    const mode=f.db.prepare('SELECT hide_correct FROM huinglish_quiz_answer_modes WHERE peer_id=?');
    assert.equal(mode.get('2000000008')?.hide_correct,1);
    assert.equal(f.quiz.inspect('2000000008').enabled,0,'policy command must not start tests');
    await f.quiz.command(f.ctx,{type:'quizOn',intervalMs:60000});
    const token=JSON.parse(buttons(quizMessages(f.sends)[0])[0].action.payload).token;
    const row=f.db.prepare('SELECT * FROM huinglish_quiz_questions WHERE token=?').get(token);
    const right=HUINGLISH_QUIZ_BANK.find(item=>item.id===row.question_id);
    const wrong=(row.correct_index+1)%JSON.parse(row.options_json).length;
    await f.quiz.answer({peerId:'2000000008',userId:'12345',payload:{token,choice:wrong}});
    assert.ok(!f.sends.find(x=>x.message.includes('❌ НЕПРАВИЛЬНО')).message.includes('🇬🇧 '+right.answer));
    const nextToken=f.quiz.inspect('2000000008').pending_token;
    const restarted=createHuinglishQuiz({vk:f.vk,db:f.db,now:f.now,sitePromosEnabled:false,logger:{info(){},error(){},warn(){}}});
    assert.equal(mode.get('2000000008')?.hide_correct,1,'mode persisted across module recreation');
    await restarted.answer({peerId:'2000000008',userId:'67890',payload:{token,choice:wrong}});
    assert.ok(!f.sends.at(-1).message.includes('🇬🇧 '+right.answer),'still hidden on second wrong');
    await restarted.command(f.ctx,parseHuinglishCommand('хуинглиш раскрывать правильный'));
    assert.equal(mode.get('2000000008')?.hide_correct,0);
    assert.equal(restarted.inspect('2000000008').pending_token,nextToken,'switch does not discard live question');
    await restarted.answer({peerId:'2000000008',userId:'13579',payload:{token,choice:wrong}});
    assert.ok(f.sends.at(-1).message.includes('🇬🇧 '+right.answer));
    assert.ok(f.sends.at(-1).message.includes('Почему подходит:'));
    assert.equal(mode.get('2000000011'),undefined,'no bleed into another chat');
});

test('all 219 grammar traps have a precise explanation; hidden mode still hides full answer', () => {
    assert.equal(HUINGLISH_QUIZ_NEAR_CHOICES.length,219);
    for(const picked of HUINGLISH_QUIZ_NEAR_CHOICES) {
        const right=HUINGLISH_QUIZ_BANK.find(item=>item.answer===picked.sourceAnswer);
        assert.ok(right,picked.answer);
        assert.ok(picked.trapExplanation.length>=55,picked.answer);
        assert.ok(!['Искажена грамматическая форма или согласование.','Нарушен порядок слов: так эту конструкцию не строят.'].includes(picked.trapExplanation),picked.answer);
        const normal=buildHuinglishQuizAnswerExplanation({right,picked,correct:false});
        assert.ok(normal.includes('💡 Почему не подходит: '+picked.trapExplanation),picked.answer);
        assert.ok(normal.length<3500,picked.answer);
        const hidden=buildHuinglishQuizAnswerExplanation({right,picked,correct:false,revealCorrect:false});
        assert.ok(hidden.includes(picked.trapExplanation),picked.answer);
        assert.ok(!hidden.includes('🇬🇧 '+right.answer),picked.answer);
        const brief=buildHuinglishQuizAnswerExplanation({right,picked,correct:false,shortWrong:true});
        assert.ok(brief.includes(picked.trapExplanation),picked.answer);
    }
    const rip=HUINGLISH_QUIZ_NEAR_CHOICES.find(x=>x.answer==="That's rip-off!");
    assert.match(rip.trapExplanation,/артикль a/u);
    assert.match(rip.trapExplanation,/существительное/u);
    const cover=HUINGLISH_QUIZ_NEAR_CHOICES.find(x=>x.answer==="What's on the cover?");
    const right=HUINGLISH_QUIZ_BANK.find(x=>x.answer===cover.sourceAnswer);
    assert.match(buildHuinglishQuizAnswerExplanation({right,picked:cover,correct:false}),/В другом контексте/u);
});

test('real correct English which is a wrong option explains why it misses the question', () => {
    const right=HUINGLISH_QUIZ_BANK.find(x=>x.answer==="That's a rip-off!");
    const picked=HUINGLISH_QUIZ_EXTRA_CHOICES.find(x=>x.answer==="That looks expensive.");
    const explanation=buildHuinglishQuizAnswerExplanation({right,picked,correct:false});
    assert.ok(explanation.includes('💡 Почему не подходит:'));
    assert.ok(explanation.includes(picked.meaning));
    assert.ok(explanation.includes(right.scene));
    assert.ok(explanation.includes('✅ ПРАВИЛЬНЫЙ ОТВЕТ:'));
});

test('approved short HuInglish site messages are the ONLY links sent after quiz questions and answers',async t=>{
    const {HUINGLISH_SITE_PROMOS,pickHuinglishSitePromo}=await import('../../src/features/english/huinglishSitePromos.js');
    assert.equal(HUINGLISH_SITE_PROMOS.length,5);
    assert.ok(HUINGLISH_SITE_PROMOS.every(x=>x.length<115 && !x.includes('profile.php')));
    assert.ok(new Set(Array.from({length:70},(_,i)=>pickHuinglishSitePromo('delivery:'+i))).size>=4);
    const f=store(t,[1,2],true);
    await f.quiz.command(f.ctx,{type:'quizOn',intervalMs:60000});
    assert.equal(f.sends.length,3);
    assert.ok(f.sends[1].keyboard);
    assert.ok(HUINGLISH_SITE_PROMOS.includes(f.sends[2].message));
    assert.equal(f.sends[2].keyboard,undefined);
    const q=JSON.parse(buttons(f.sends[1])[0].action.payload).token;
    const row=f.db.prepare('SELECT * FROM huinglish_quiz_questions WHERE token=?').get(q);
    const wrong=(row.correct_index+1)%JSON.parse(row.options_json).length;
    const before=f.sends.length;
    await f.quiz.answer({peerId:'2000000008',userId:'12345',payload:{token:q,choice:wrong}});
    const out=f.sends.slice(before);
    assert.match(out[0].message,/❌ НЕПРАВИЛЬНО/u);
    assert.ok(HUINGLISH_SITE_PROMOS.includes(out[1].message));
    assert.ok(out[2].keyboard,'a short-interval quiz continues immediately after wrong answer');
    assert.ok(HUINGLISH_SITE_PROMOS.includes(out[3].message));
    assert.equal(out[1].keyboard,undefined);
    assert.equal(out[3].keyboard,undefined);
});

test('a correct test answer has exactly one separate short promo and no extra question',async t=>{
    const {HUINGLISH_SITE_PROMOS}=await import('../../src/features/english/huinglishSitePromos.js');
    const f=store(t,[1],true);
    await f.quiz.command(f.ctx,{type:'quizOn',intervalMs:3600000});
    const q=JSON.parse(buttons(quizMessages(f.sends)[0])[0].action.payload).token;
    const correct=f.db.prepare('SELECT correct_index FROM huinglish_quiz_questions WHERE token=?').get(q).correct_index;
    const before=f.sends.length;
    await f.quiz.answer({peerId:'2000000008',userId:'12345',payload:{token:q,choice:correct}});
    const out=f.sends.slice(before);
    assert.equal(out.length,2);
    assert.match(out[0].message,/✅ ПРАВИЛЬНО/u);
    assert.ok(HUINGLISH_SITE_PROMOS.includes(out[1].message));
});

test('meaning images explain verified idiom origins and metaphors without fake literal translations',async()=>{
    const {HUINGLISH_QUIZ_MEANING_IMAGES}=await import('../../src/features/english/huinglishQuizMeaningImages.js');
    const unique=new Set(HUINGLISH_QUIZ_BANK.map(x=>x.answer));
    assert.equal(unique.size,71);
    assert.ok(HUINGLISH_QUIZ_MEANING_IMAGES.size>=50);
    assert.ok([...HUINGLISH_QUIZ_MEANING_IMAGES.keys()].every(x=>unique.has(x)));
    assert.ok([...HUINGLISH_QUIZ_MEANING_IMAGES.values()].every(x=>x.explanation.length<=300));
    const image=(answer)=>HUINGLISH_QUIZ_MEANING_IMAGES.get(answer)?.explanation||'';
    assert.match(image("I see where you're coming from."),/откуда ты идёшь/u);
    assert.match(image("I see where you're coming from."),/мысли|мысленно|позици/u);
    assert.match(image("Let's play it by ear."),/музык|нот/u);
    assert.match(image("Can I take a rain check?"),/бейсбол|дожд/u);
    assert.match(image("That's a rip-off!"),/обман|обвор/u);
    assert.match(image("I'm on the fence."),/забор/u);
    const right=HUINGLISH_QUIZ_BANK.find(x=>x.answer==="I see where you're coming from.");
    const picked=HUINGLISH_QUIZ_NEAR_CHOICES.find(x=>x.sourceAnswer===right.answer);
    const full=buildHuinglishQuizAnswerExplanation({right,picked,correct:false,revealCorrect:true});
    assert.ok(full.includes(image(right.answer)));
    assert.ok(full.includes('🧠 Образ фразы:'));
    assert.ok(full.includes('✅ ПРАВИЛЬНЫЙ ОТВЕТ:'));
    assert.ok(full.length<3500);
    const hidden=buildHuinglishQuizAnswerExplanation({right,picked,correct:false,revealCorrect:false});
    assert.ok(!hidden.includes(image(right.answer)));
    assert.ok(!hidden.includes('🇬🇧 '+right.answer));
    const short=buildHuinglishQuizAnswerExplanation({right,picked,correct:false,shortWrong:true,revealCorrect:true});
    assert.ok(short.includes(image(right.answer)));
    assert.ok(short.length<1050);
    const correct=buildHuinglishQuizAnswerExplanation({right,picked:right,correct:true});
    assert.ok(correct.includes(image(right.answer)));
    const repeated=buildHuinglishQuizAnswerExplanation({right,picked:right,correct:true,shortCorrect:true});
    assert.ok(!repeated.includes('🧠'),'quick confirmations remain short');
});

test('all 96 quiz slots keep correct and wrong replies under VK limits with meaning notes',()=>{
    for(const right of HUINGLISH_QUIZ_BANK){
        const firstPicked=HUINGLISH_QUIZ_NEAR_CHOICES.find(x=>x.sourceAnswer===right.answer);
        const another=HUINGLISH_QUIZ_BANK.find(x=>x.answer!==right.answer);
        for(const picked of [firstPicked,another]){
            assert.ok(picked,right.answer);
            for(const revealCorrect of [true,false]){
                const full=buildHuinglishQuizAnswerExplanation({right,picked,correct:false,revealCorrect});
                assert.ok(full.length<3500,right.answer+' '+picked.answer+' '+revealCorrect);
                if(!revealCorrect)assert.ok(!full.includes('🇬🇧 '+right.answer));
                const brief=buildHuinglishQuizAnswerExplanation({right,picked,correct:false,shortWrong:true,revealCorrect});
                assert.ok(brief.length<1050,right.answer+' '+picked.answer);
            }
        }
        const done=buildHuinglishQuizAnswerExplanation({right,picked:right,correct:true});
        assert.ok(done.length<3500,right.answer);
    }
});
