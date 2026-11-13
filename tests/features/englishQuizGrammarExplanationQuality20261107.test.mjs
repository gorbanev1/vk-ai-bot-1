import test from 'node:test';
import assert from 'node:assert/strict';
import {HUINGLISH_QUIZ_BANK as bank} from '../../src/features/english/huinglishQuizBank.js';
import {HUINGLISH_QUIZ_NEAR_CHOICES as near} from '../../src/features/english/huinglishQuizNearChoices.js';
import {buildHuinglishQuizAnswerExplanation as explainH} from '../../src/features/english/huinglishQuizAnswerExplanation.js';
import {ENGLISH_GRAMMAR_QUIZ_BANK as grammar} from '../../src/features/english/englishGrammarQuizBank.js';
import {buildEnglishGrammarQuizExplanation as explainG} from '../../src/features/english/englishGrammarCourse.js';
const byAnswer=new Map(bank.map(x=>[x.answer,x]));
test('you DOES you explains person, number, auxiliary form, and the exact mistake',()=>{
 const selected=near.find(x=>x.answer==='You does you.');
 assert.ok(selected);
 const shown=explainH({right:byAnswer.get(selected.sourceAnswer),picked:selected,correct:false});
 for(const rule of [/2-го лица/u,/does — только с he\/she\/it/u,/3-е лицо, единственное число/u,/does неверно согласован с you/u,/второе you — дополнение/iu])assert.match(shown,rule);
 assert.ok(!shown.includes('Здесь есть ошибка в английской конструкции'));
 const hidden=explainH({right:byAnswer.get(selected.sourceAnswer),picked:selected,correct:false,shortWrong:true,revealCorrect:false});
 assert.match(hidden,/3-е лицо, единственное число/u);
 assert.ok(!hidden.includes('🇬🇧 You do you.'));
});
test('all 219 HuInglish near misses have unique specific explanations and safe VK size',()=>{
 assert.equal(near.length,219);const unique=new Set();
 for(const wrong of near){
  const right=byAnswer.get(wrong.sourceAnswer);assert.ok(right,wrong.sourceAnswer);
  const explanation=wrong.trapExplanation;unique.add(explanation);
  assert.ok(explanation.length>=90,wrong.answer);
  assert.ok(!explanation.includes('Здесь есть ошибка в английской конструкции'),wrong.answer);
  for(const revealCorrect of [false,true]){
   const text=explainH({right,picked:wrong,correct:false,revealCorrect,shortWrong:!revealCorrect});
   assert.ok(text.length<=3500,wrong.answer);
   assert.ok(text.includes(explanation),wrong.answer);
   if(!revealCorrect)assert.ok(!text.includes('🇬🇧 '+right.answer),wrong.answer);
  }
 }
 assert.equal(unique.size,219,'all wrong choices require individually targeted rationale');
});
test('agreement errors with you, I and that name grammatical person and form',()=>{
 for(const [phrase,person,rule] of [
  ['You cracks me up.',/2-е лицо/u,/3-е лицо/u],
  ['You has to be there.',/2-е лицо/u,/3-е лицо/u],
  ['That check out.',/3-е лицо, единственное число/u,/s\/-es/u],
  ['Low-key, I likes it.',/1-е лицо/u,/3-е лицо/u],
  ['I feels you.',/1-е лицо/u,/3-е лицо/u]]){
   const picked=near.find(x=>x.answer===phrase);assert.ok(picked,phrase);
   assert.match(picked.trapExplanation,person,phrase);assert.match(picked.trapExplanation,rule,phrase);
 }
});
test('all 96 correct HuInglish quiz answers include construction rule, not just a scenario',()=>{
 for(const right of bank){
  const text=explainH({right,picked:right,correct:true});
  assert.match(text,/📘 Грамматика:/u,right.answer);
  assert.ok(text.length<3500,right.answer);
 }
 const chosen=bank.find(x=>x.answer==='You do you.');
 const text=explainH({right:chosen,picked:chosen,correct:true});
 assert.match(text,/2-го лица/u);
 assert.match(text,/does относится к he\/she\/it/u);
});
test('all 88 English Grammar questions explain selected option and keep hide mode',()=>{
 assert.equal(grammar.length,88);
 for(const item of grammar){
  assert.equal(item.options.length,4,item.id);
  for(const picked of item.options.slice(1)){
   const full=explainG({item,picked,correct:false,revealCorrect:true});
   assert.ok(full.includes('🇬🇧 '+picked.answer),item.id);
   assert.ok(full.includes(picked.why),item.id);assert.ok(full.length<3500,item.id);
   const hidden=explainG({item,picked,correct:false,revealCorrect:false});
   assert.ok(hidden.includes(picked.why),item.id);
   assert.ok(!hidden.includes('🇬🇧 '+item.options[0].answer),item.id);
  }
 }
 const coffee=grammar.find(x=>x.options.some(o=>o.answer==='Does you like coffee?'));
 assert.ok(coffee);
 const display=explainG({item:coffee,picked:coffee.options.find(o=>o.answer==='Does you like coffee?'),correct:false});
 assert.match(display,/you — 2-е лицо/u);assert.match(display,/he\/she\/it — 3-е лицо единственного числа/u);
});
