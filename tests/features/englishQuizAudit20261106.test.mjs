import test from 'node:test';
import assert from 'node:assert/strict';
import {HUINGLISH_QUIZ_BANK as bank} from '../../src/features/english/huinglishQuizBank.js';
import {HUINGLISH_QUIZ_NEAR_CHOICES as near} from '../../src/features/english/huinglishQuizNearChoices.js';
import {buildHuinglishQuizAnswerExplanation as explain} from '../../src/features/english/huinglishQuizAnswerExplanation.js';
import {buildHuinglishQuizOptions as options} from '../../src/features/english/huinglishQuizChoices.js';
import {ENGLISH_GRAMMAR_QUIZ_BANK as english} from '../../src/features/english/englishGrammarQuizBank.js';
import {parseEnglishGrammarCommand,buildEnglishGrammarQuizExplanation} from '../../src/features/english/englishGrammarCourse.js';
import {detectExplicitApplicationCommand} from '../../src/features/routing/explicitApplicationCommand.js';
const item=answer=>bank.find(q=>q.answer===answer);
test('minute is idiomatic in the dialogue but does not ASK how the friend has been',()=>{
 for(const shortWrong of [false,true])for(const revealCorrect of [false,true]){
  const text=explain({right:item("How've you been?"),picked:item("It's been a minute."),correct:false,shortWrong,revealCorrect});
  assert.match(text,/Сама фраза правильная/u);assert.match(text,/естественный ответ/u);
  assert.match(text,/не вопрос о делах/u);assert.ok(!text.includes('ошибка в английской конструкции'));
  if(!revealCorrect)assert.ok(!text.includes('🇬🇧 How\'ve you been?'));
 }
});
test('direct-question feedback teaches auxiliary before subject, not statement order',()=>{
 const picked=near.find(q=>q.answer==='How you have been?');
 assert.match(picked.trapExplanation,/have стоит ПЕРЕД you/u);
 assert.ok(!picked.trapExplanation.includes('сначала называют того'));
 const embedded=near.find(q=>q.answer==='Look it who is!');
 assert.match(embedded.trapExplanation,/вложенная конструкция/u);
});
test('new HuInglish questions exclude contextually acceptable near-synonyms, legacy ids remain',()=>{
 for(const [right,bad]of [["I'm gonna head out.","I'm gonna head on."],['Read the room.','Read a room.'],["It's giving main character energy.","It's giving main characters energy."]]){
  assert.ok(near.some(q=>q.answer===bad));
  for(let seed=0;seed<15;seed++)assert.ok(!options(item(right),bank,seed).some(q=>q.answer===bad));
 }
});
test('English commands accept both word orders and use the same explicit routing',()=>{
 for(const command of ['тесты English вкл','English тесты вкл','Гигорейв тесты English vocal','тесты инглиш 1/6 ускорение']){
  assert.equal(parseEnglishGrammarCommand(command)?.type,'quizOn',command);
  assert.equal(detectExplicitApplicationCommand(command).family,'english-grammar',command);
 }
 assert.equal(parseEnglishGrammarCommand('тесты English выкл').type,'quizOff');
 assert.equal(parseEnglishGrammarCommand('тесты English статус').type,'quizStatus');
 assert.equal(parseEnglishGrammarCommand('хуинглиш тесты'),null);
});
test('new place tasks teach overlapping beach meanings and American in-school meaning',()=>{
 const beach=english.find(q=>q.id==='en:081'),surface=english.find(q=>q.id==='en:082');
 assert.ok(beach.task.includes('пляж'));assert.match(beach.options[0].why,/On the beach тоже возможно/u);
 assert.match(surface.options[0].why,/At the beach тоже грамотно/u);
 assert.ok(!beach.options.slice(1).some(o=>o.answer==='On the beach.'));
 const school=english.find(q=>q.id==='en:083');
 assert.match(school.task,/на каникулах за границей/u);assert.equal(school.options[0].answer,"I'm still in school.");
 const valid=english.find(q=>q.id==='en:021').options.find(o=>o.answer==="I'm at the bus.");
 assert.equal(valid.valid,true);
 const text=buildEnglishGrammarQuizExplanation({item:english.find(q=>q.id==='en:021'),picked:valid,correct:false});
 assert.match(text,/Сама фраза грамматически правильная/u);
});
