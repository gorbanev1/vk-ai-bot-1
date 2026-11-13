import test from 'node:test';
import assert from 'node:assert/strict';
import {formatHuinglishPartForAudience} from '../../src/features/english/huinglishMultiPlatform.js';
test('group closing contains only one completion and never advertises commands',()=>{
 const src='Some final content.\n\n✅ Урок №5 завершён. №6 доступен завтра: «хуинглиш далее».';
 const result=formatHuinglishPartForAudience(src,{isGroup:true,isFinal:true,lessonId:5,hasNext:true});
 assert.match(result,/✅ Урок №5 завершён\. Следующий урок придёт завтра\./);
 assert.equal((result.match(/завершён/g)||[]).length,1);
 assert.doesNotMatch(result,/хуинглиш далее|хуинглиш урок/iu);
});
test('group intermediary text removes command prompts, private texts stay untouched',()=>{
 const src='EXAMPLE\n\n💬 Продолжить: «хуинглиш далее».';
 assert.doesNotMatch(formatHuinglishPartForAudience(src,{isGroup:true}),/хуинглиш далее/);
 assert.equal(formatHuinglishPartForAudience(src,{isGroup:false}),src);
});
test('group final can end without upcoming lesson and does not invent availability',()=>{
 const text=formatHuinglishPartForAudience('Слова и перевод.',{isGroup:true,isFinal:true,lessonId:7,hasNext:false});
 assert.match(text,/Новый урок появится, когда будет готов/);
 assert.doesNotMatch(text,/завтра/);
});
test('group formatting respects 4096 transport budget even near the limit',()=>{
 const text=formatHuinglishPartForAudience('X'.repeat(4080),{isGroup:true,isFinal:true,lessonId:1,hasNext:true});
 assert.ok(text.length+(text.match(/\n/g)||[]).length<=4096);
});
