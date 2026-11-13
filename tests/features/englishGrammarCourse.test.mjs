import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {ENGLISH_GRAMMAR_LESSONS} from '../../src/features/english/englishGrammarLessons.js';
import {ENGLISH_GRAMMAR_QUIZ_BANK} from '../../src/features/english/englishGrammarQuizBank.js';
import {
    createEnglishGrammarCourse,parseEnglishGrammarCommand,
    formatEnglishGrammarQuestion,buildEnglishGrammarQuizExplanation,
} from '../../src/features/english/englishGrammarCourse.js';
import {parseHuinglishCommand} from '../../src/features/english/huinglishVkLesson.js';
import {detectExplicitApplicationCommand} from '../../src/features/routing/explicitApplicationCommand.js';

const HOUR=3600000;
const day=()=>Date.parse('2026-11-06T10:00:00Z');
function fixture(t,{platform='vk',peerId='2000000901',time=day(),autoStart=false}={}){
    const root=mkdtempSync(join(tmpdir(),'english-grammar-test-'));
    const dbPath=join(root,'course.sqlite');
    let clock=time,count=500;
    const sent=[],errors=[];
    const vk={api:{messages:{send:async args=>{
        const id=++count;
        sent.push({platform:'vk',id,...args,at:clock});
        return [{peer_id:args.peer_ids?.[0]||args.peer_id,message_id:id,conversation_message_id:id+200}];
    }}}};
    const telegramBot={api:{sendMessage:async args=>{
        const id=++count;sent.push({platform:'telegram',id,...args,at:clock});return {message_id:id};
    }}};
    let app;
    const open=()=>app=createEnglishGrammarCourse({vk,telegramBot,dbPath,dataDir:root,
        now:()=>clock,timeZone:'Europe/Moscow',random:()=>0.5,
        logger:{info(){},error(...args){errors.push(args)},warn(){}},
    });
    open();
    const context=(p=platform,id=peerId)=>({platform:p,peerId:id,isPrivate:false,threadId:0});
    const cmd=async(value,c=context())=>{
        assert.equal(app.handle({...c,text:value}),true,'command not recognised: '+value);
        await app.idle();
    };
    const answer=async(token,choice,userId='123')=>app.handleVkQuizAnswer({peerId,userId,
        payload:{action:'english_quiz',token,choice}});
    const db=new DatabaseSync(dbPath);
    t.after(async()=>{await app.close();db.close();rmSync(root,{recursive:true,force:true});});
    return {root,dbPath,db,sent,errors,vk,telegramBot,cmd,answer,context,
        now:()=>clock,advance:n=>{clock+=n;},set:v=>{clock=v;},
        inspect:()=>app.inspect(platform,peerId),tick:()=>app.tick(),idle:()=>app.idle(),
        restart:async()=>{await app.close();open();},
        get app(){return app},
    };
}
const questionMessages=sent=>sent.filter(x=>x.keyboard);
const buttons=x=>JSON.parse(x.keyboard).buttons.flat();
function currentQuestion(f){
    const message=questionMessages(f.sent).at(-1);
    assert.ok(message,'no English quiz question was sent');
    const token=JSON.parse(buttons(message)[0].action.payload).token;
    return {token,message,row:f.db.prepare('SELECT * FROM english_grammar_quiz_questions WHERE token=?').get(token)};
}
async function finishFirst(f){
    await f.cmd('English вкл');
    await f.cmd('English далее');
    await f.cmd('English далее');
    assert.equal(f.inspect().subscription.completed_lesson,1);
}

test('the grammar course has exactly ten 3-part readable lessons with American pronunciation links',()=>{
    assert.equal(ENGLISH_GRAMMAR_LESSONS.length,10);
    for(const [index,lesson] of ENGLISH_GRAMMAR_LESSONS.entries()){
        assert.equal(lesson.id,index+1);
        assert.equal(lesson.parts.length,3);
        for(const part of lesson.parts){
            assert.ok(part.length>=500&&part.length<=3750);
            assert.match(part,/https:\/\/youglish\.com\/pronounce\/[^\s]+\/english\/us/u);
            assert.match(part,/✅/u);
            assert.match(part,/📚 ENGLISH/u);
        }
    }
});

test('88 contextual questions: eight per topic plus eight place-preposition contrasts',()=>{
    assert.equal(ENGLISH_GRAMMAR_QUIZ_BANK.length,88);
    const seen=new Set();
    for(const [index,q] of ENGLISH_GRAMMAR_QUIZ_BANK.entries()){
        assert.equal(q.id,'en:'+String(index+1).padStart(3,'0'));
        assert.equal(q.lesson,index<80?Math.floor(index/8)+1:3);
        assert.ok(q.task.length>25&&q.lead.length>4,q.id);
        assert.ok(q.options.length===4);
        assert.equal(q.options.filter(o=>o.correct).length,q.id==='en:077'?2:1);
        for(const opt of q.options){
            assert.ok(opt.answer.length<=40&&opt.answer.length>0,q.id);
            assert.ok(opt.why.length>=18,q.id+' '+opt.answer);
            if(opt.valid)assert.match(opt.why,/Подошло бы/u);
        }
        assert.equal(new Set(q.options.map(o=>o.answer.toLowerCase())).size,4);
        assert.ok(!seen.has(q.id));seen.add(q.id);
        const shown=formatEnglishGrammarQuestion(q);
        assert.ok(shown.includes(q.task));
        assert.ok(shown.includes(q.lead));
        assert.ok(shown.includes('ЗАДАНИЕ'));
    }
});

test('valid English with the wrong meaning is explained as valid, with the missing TASK repeated',()=>{
    const q=ENGLISH_GRAMMAR_QUIZ_BANK[0];
    const valid=q.options[1];
    assert.equal(valid.valid,true);
    const s=buildEnglishGrammarQuizExplanation({item:q,picked:valid,correct:false,revealCorrect:true});
    assert.match(s,/Сама фраза грамматически правильная/u);
    assert.match(s,/Подошло бы/u);
    assert.ok(s.includes(q.task));
    assert.ok(s.includes(q.lead));
    assert.ok(s.includes('🇬🇧 '+q.options[0].answer));
    const hidden=buildEnglishGrammarQuizExplanation({item:q,picked:valid,correct:false,revealCorrect:false});
    assert.ok(!hidden.includes('🇬🇧 '+q.options[0].answer));
    assert.ok(hidden.includes(q.task));
    const bad=buildEnglishGrammarQuizExplanation({item:q,picked:q.options[2],correct:false,revealCorrect:true});
    assert.match(bad,/ошибка в грамматике/u);
    assert.match(bad,/В чём ошибка/u);
    assert.ok(!bad.includes('Сама фраза грамматически правильная'));
});

test('all 88 questions give concise detailed feedback for all four choices in reveal and hide mode',()=>{
    for(const question of ENGLISH_GRAMMAR_QUIZ_BANK){
        for(const opt of question.options){
            for(const revealCorrect of [true,false]){
                const message=buildEnglishGrammarQuizExplanation({item:question,picked:opt,
                    correct:opt.correct,revealCorrect});
                assert.ok(message.length<3500,question.id);
                assert.ok(message.includes(question.task));
                assert.ok(message.includes(question.lead));
                if(!opt.correct&&!revealCorrect)
                    assert.ok(!message.includes('🇬🇧 '+question.options[0].answer),question.id);
                const short=buildEnglishGrammarQuizExplanation({item:question,picked:opt,
                    correct:opt.correct,revealCorrect,short:true});
                assert.ok(short.length<3500,question.id);
            }
        }
    }
});

test('English and Инглиш commands are separate from HuInglish; quiz suffix matches existing commands',()=>{
    const commands=[
        ['English','on'],['инглиш','on'],['гигорейв english вкл','on'],
        ['English выкл','off'],['инглиш выключить','off'],
        ['English далее','next'],['инглиш следующий урок','next'],
        ['English урок 3','lesson'],['Инглиш уроки','list'],
        ['English тесты','quizOn'],['Инглиш тесты 1/6 ускор','quizOn'],
        ['English тесты выкл','quizOff'],['english тесты статус','quizStatus'],
        ['English не раскрывать правильный','quizHideCorrect'],
        ['инглиш сразу не раскрывать правильный','quizHideCorrect'],
        ['English раскрывать правильный','quizRevealCorrect'],
    ];
    for(const [command,type] of commands){
        assert.equal(parseEnglishGrammarCommand(command)?.type,type,command);
        assert.equal(detectExplicitApplicationCommand(command).family,'english-grammar',command);
    }
    assert.equal(parseEnglishGrammarCommand('хуинглиш тесты'),null);
    assert.equal(parseHuinglishCommand('хуинглиш тесты')?.type,'quizOn');
    assert.equal(parseHuinglishCommand('инглиш тесты'),null);
    assert.equal(parseEnglishGrammarCommand('in a car'),null);
});

test('grammar data and progress are in separate tables; nothing changes HuInglish schema',async t=>{
    const f=fixture(t);
    const names=f.db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(x=>x.name);
    assert.ok(names.includes('english_grammar_subscriptions'));
    assert.ok(names.includes('english_grammar_quiz_schedules'));
    assert.ok(names.every(x=>!x.startsWith('huinglish_')));
    assert.equal(f.inspect().lessons,10);
    assert.equal(f.inspect().questions,88);
});

test('lesson starts with English вкл, goes in three parts, persists completion on restart',async t=>{
    const f=fixture(t);
    await finishFirst(f);
    assert.equal(f.sent.filter(x=>x.message?.includes('📚 ENGLISH · УРОК 1')).length,3);
    assert.equal(f.inspect().run.status,'finished');
    assert.equal(f.inspect().run.next_part,4);
    assert.equal(f.sent.length,3);
    await f.restart();
    assert.equal(f.inspect().subscription.completed_lesson,1);
    assert.equal(f.inspect().run.status,'finished');
    await f.cmd('English далее');
    assert.match(f.sent.at(-1).message,/завтра/u);
    assert.equal(f.inspect().subscription.completed_lesson,1);
    f.advance(86400000);
    await f.cmd('English далее');
    assert.equal(f.inspect().run.lesson_id,2);
    assert.equal(f.inspect().run.next_part,2);
});

test('every VK lesson part replies to previous lesson, not to website message or wrong target',async t=>{
    const f=fixture(t);
    await f.cmd('English вкл');
    const first=f.sent.at(-1).id;
    await f.cmd('English далее');
    assert.equal(JSON.parse(f.sent.at(-1).forward).conversation_message_ids,first+200);
    const second=f.sent.at(-1).id;
    await f.cmd('English далее');
    assert.equal(JSON.parse(f.sent.at(-1).forward).conversation_message_ids,second+200);
});

test('Telegram can receive the same English lessons with correct reply chain',async t=>{
    const f=fixture(t,{platform:'telegram',peerId:'3001'});
    await f.cmd('English вкл');
    assert.equal(f.sent.length,1);
    const first=f.sent.at(-1).id;
    await f.cmd('English далее');
    assert.equal(f.sent.at(-1).replyToMessageId,first);
    assert.equal(f.sent.length,2);
    await f.cmd('English далее');
    assert.equal(f.inspect().subscription.completed_lesson,1);
});

test('English тесты unlock after finished lesson, use four VK callbacks and persist schedule',async t=>{
    const f=fixture(t);
    await f.cmd('English тесты');
    assert.equal(questionMessages(f.sent).length,0);
    await finishFirst(f);
    await f.cmd('English тесты 1/6 ускорение');
    assert.equal(questionMessages(f.sent).length,1);
    const {row,message}=currentQuestion(f);
    assert.equal(JSON.parse(message.keyboard).buttons.length,4);
    assert.ok(JSON.parse(message.keyboard).buttons.every(x=>x.length===1));
    assert.equal(row.options_json&&JSON.parse(row.options_json).length,4);
    assert.equal(f.inspect().quiz.interval_ms,600000);
    assert.equal(f.inspect().quiz.acceleration_enabled,1);
    await f.restart();
    assert.equal(f.inspect().quiz.pending_token,row.token);
});

test('wrong valid-but-contextual choice says it COULD fit a different scenario and reveals right',async t=>{
    const f=fixture(t);
    await finishFirst(f);
    await f.cmd('English тесты 1/60');
    const original=currentQuestion(f);
    const token=original.token;
    f.db.prepare('UPDATE english_grammar_quiz_questions SET question_id=?,options_json=?,correct_index=? WHERE token=?')
        .run('en:001','[0,1,2,3]',0,token);
    const before=f.sent.length;
    const response=await f.answer(token,1);
    assert.equal(response.ok,true);
    const messages=f.sent.slice(before).filter(x=>!x.keyboard);
    assert.equal(messages.length,1);
    const explanation=messages[0].message;
    assert.ok(explanation.includes('Сама фраза грамматически правильная'));
    assert.ok(explanation.includes('Подошло бы'));
    assert.ok(explanation.includes(ENGLISH_GRAMMAR_QUIZ_BANK[0].task));
    assert.ok(explanation.includes('🇬🇧 '+ENGLISH_GRAMMAR_QUIZ_BANK[0].options[0].answer));
    assert.ok(questionMessages(f.sent).length>=2,'wrong answer should lead to next question when interval is < 1 hour');
});

test('hide command persists without enabling quizzes, unlock command reveals right answer',async t=>{
    const f=fixture(t);
    await f.cmd('English сразу не раскрывать правильный');
    assert.equal(f.inspect().quiz.enabled,0);
    assert.equal(f.inspect().quiz.hide_correct,1);
    await finishFirst(f);
    await f.cmd('English тесты 1/60');
    const token=currentQuestion(f).token;
    f.db.prepare('UPDATE english_grammar_quiz_questions SET question_id=?,options_json=?,correct_index=? WHERE token=?')
        .run('en:001','[0,1,2,3]',0,token);
    const before=f.sent.length;
    await f.answer(token,1);
    const text=f.sent.slice(before).find(x=>x.message?.includes('❌ НЕПРАВИЛЬНО'))?.message;
    assert.ok(text);
    assert.ok(!text.includes('🇬🇧 '+ENGLISH_GRAMMAR_QUIZ_BANK[0].options[0].answer));
    assert.ok(text.includes('Подошло бы'));
    await f.restart();
    assert.equal(f.inspect().quiz.hide_correct,1);
    await f.cmd('English раскрывать правильный');
    assert.equal(f.inspect().quiz.hide_correct,0);
});

test('after wrong reply, old question remains answerable without overwriting newer question',async t=>{
    const f=fixture(t);
    await finishFirst(f);
    await f.cmd('English тесты 1/60');
    const first=currentQuestion(f).token;
    const index=f.db.prepare('SELECT correct_index FROM english_grammar_quiz_questions WHERE token=?').get(first).correct_index;
    await f.answer(first,(index+1)%4);
    const pending=f.inspect().quiz.pending_token;
    assert.ok(pending&&pending!==first,'new test after wrong answer');
    const corrected=await f.answer(first,Number(f.db.prepare('SELECT correct_index FROM english_grammar_quiz_questions WHERE token=?').get(first).correct_index));
    assert.equal(corrected.ok,true);
    assert.equal(f.inspect().quiz.pending_token,pending,'older correction cannot erase current question');
});

test('strict one-hour rule prevents a fresh quiz question right after a wrong answer',async t=>{
    const f=fixture(t);
    await finishFirst(f);
    await f.cmd('English тесты 1');
    const original=currentQuestion(f);
    const before=questionMessages(f.sent).length;
    await f.answer(original.token,(original.row.correct_index+1)%4);
    assert.equal(questionMessages(f.sent).length,before);
    f.advance(HOUR-2000);
    await f.tick();
    assert.equal(questionMessages(f.sent).length,before);
    f.advance(3000);
    await f.tick();
    assert.equal(questionMessages(f.sent).length,before+1);
});

test('turning English tests off does not stop grammar lessons, and vice versa',async t=>{
    const f=fixture(t);
    await finishFirst(f);
    await f.cmd('English тесты');
    await f.cmd('English тесты выкл');
    assert.equal(f.inspect().quiz.enabled,0);
    assert.equal(f.inspect().subscription.enabled,1);
    await f.cmd('English тесты');
    await f.cmd('English выкл');
    assert.equal(f.inspect().quiz.enabled,1);
    assert.equal(f.inspect().subscription.enabled,0);
});

test('all 88 questions can be rotated before repeating when all 10 lessons are finished',async t=>{
    const f=fixture(t);
    await f.cmd('English вкл');
    f.db.prepare('UPDATE english_grammar_subscriptions SET completed_lesson=10 WHERE platform=? AND peer_id=?')
        .run('vk','2000000901');
    await f.cmd('English тесты 1/60');
    for(let i=0;i<87;i++){
        const {row,token}=currentQuestion(f);
        const result=await f.answer(token,row.correct_index);
        assert.equal(result.ok,true);
        f.advance(61000);
        await f.tick();
    }
    const questions=f.db.prepare('SELECT question_id FROM english_grammar_quiz_questions ORDER BY created_at').all();
    assert.equal(questions.length,88);
    assert.equal(new Set(questions.map(q=>q.question_id )).size,88);
});

test('quiz not sent during quiet hours; active quiz resumes after dawn',async t=>{
    const f=fixture(t,{time:Date.parse('2026-11-06T00:40:00Z')}); // Moscow 03:40
    await f.cmd('English вкл');
    f.db.prepare('UPDATE english_grammar_subscriptions SET completed_lesson=1 WHERE platform=? AND peer_id=?')
        .run('vk','2000000901');
    await f.cmd('English тесты 1/60');
    assert.equal(questionMessages(f.sent).length,0);
    f.set(Date.parse('2026-11-06T03:30:00Z')); // Moscow 06:30
    await f.tick();
    assert.equal(questionMessages(f.sent).length,1);
});

test('telegram discussion thread is persisted and a different topic cannot continue its lesson',async t=>{
    const f=fixture(t,{platform:'telegram',peerId:'3002'});
    const original={...f.context(),threadId:7};
    const elsewhere={...f.context(),threadId:8};
    await f.cmd('English вкл',original);
    const id=f.sent[0].id;
    assert.equal(f.inspect().subscription.thread_id,7);
    await f.restart();
    await f.cmd('English далее',elsewhere);
    assert.equal(f.inspect().run.next_part,2);
    assert.match(f.sent.at(-1).text,/другой теме/u);
    assert.equal(f.sent.at(-1).messageThreadId,8);
    await f.cmd('English далее',original);
    assert.equal(f.inspect().run.next_part,3);
    assert.equal(f.sent.at(-1).replyToMessageId,id);
    assert.equal(f.sent.at(-1).messageThreadId,7);
});

test('three VK lesson parts are paced across 46?54 active minutes if not manually advanced',async t=>{
    const f=fixture(t);
    await f.cmd('English вкл');
    const first=f.inspect().run;
    assert.ok(first.due_at-f.now()>=23*60000 && first.due_at-f.now()<=27*60000);
    f.set(first.due_at);
    await f.tick();
    const second=f.inspect().run;
    assert.equal(second.next_part,3);
    assert.ok(second.due_at-f.now()>=23*60000 && second.due_at-f.now()<=27*60000);
    f.set(second.due_at);
    await f.tick();
    assert.equal(f.inspect().subscription.completed_lesson,1);
});

test('dictionary-accepted participle is credited and unlocks reveal without changing saved button order',async t=>{
 const f=fixture(t);await finishFirst(f);await f.cmd('English не раскрывать правильный');await f.cmd('English тесты 1');
 const token=currentQuestion(f).token;
 f.db.prepare('UPDATE english_grammar_quiz_questions SET question_id=?,options_json=?,correct_index=? WHERE token=?').run('en:077','[0,1,2,3]',0,token);
 const before=f.sent.length;
 assert.equal((await f.answer(token,2,'456')).ok,true);
 const reply=f.sent.slice(before).find(x=>!x.keyboard)?.message;
 assert.match(reply,/✅ ПРАВИЛЬНО/u);assert.ok(reply.includes('I had forgot my phone.'));
 const state=f.db.prepare('SELECT * FROM english_grammar_quiz_answers WHERE token=? AND user_id=?').get(token,'456');
 assert.equal(state.delivered,1);assert.equal(state.corrected,1);
 const beforeWrong=f.sent.length;await f.answer(token,3,'789');
 assert.ok(f.sent.slice(beforeWrong).some(x=>x.message?.includes('ПРАВИЛЬНЫЙ ОТВЕТ')));
});
