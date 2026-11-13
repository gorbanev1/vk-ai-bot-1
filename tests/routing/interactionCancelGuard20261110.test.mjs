import test from 'node:test';import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {isBareGlobalInteractionCancelPhrase,shouldHandleGlobalInteractionCancel as guard} from '../../src/features/routing/interactionCancelGuard.js';
test('unaddressed word «Отмена» in group conversation is never an instruction',()=>{
 for(const word of ['Отмена','отмени','стоп','cancel','сбросить состояние']){
  assert.equal(isBareGlobalInteractionCancelPhrase(word),true);
  assert.equal(guard({value:word,isPrivate:false,addressed:false}),false);
 }
});
test('addressed explicit command and private DM cancel only potentially pending actions',()=>{
 assert.equal(guard({value:'отмена',isPrivate:false,addressed:true}),true);
 assert.equal(guard({value:'отмена',isPrivate:true,addressed:false}),true);
 assert.equal(guard({value:'сбросить состояние',isPrivate:false,addressed:true}),true);
 for(const word of ['Ну ладно','Отмена чё?', 'отмена концерта','не надо тогда','не отменяй','Гигорейв нарисуй кота'])
  assert.equal(isBareGlobalInteractionCancelPhrase(word),false);
});
test('VK/Telegram group front door ignores naked cancel before pending-state and global-cancel paths',()=>{
 const src=readFileSync(process.env.GIGORAVE_CANCEL_TEST_APP||new URL('../../src/app/botApplication.js',import.meta.url),'utf8');
 assert.match(src,/if\(!privateMode&&isBareGlobalInteractionCancelPhrase\(text\)&&!containsBotMention\(text\)\)\s*return;/u);
 assert.match(src,/if\(!isPrivateContext\(context\)&&isBareGlobalInteractionCancelPhrase\(originalText\|\|text\)&&!containsBotMention\(originalText\|\|text\)\)\s*return;/u);
 assert.match(src,/shouldHandleGlobalInteractionCancel\(\{\s*value:/u);
 assert.match(src,/const canceledImageDraft=imagePromptBatcher\.cancel\(imagePromptBatchContextKey\(context\)\)/u);
 assert.match(src,/Отменять нечего:/u);
 assert.doesNotMatch(src,/Активного режима ожидания нет\. Можно отправлять новую команду/u);
});
