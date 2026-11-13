import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';
import {Buffer} from 'node:buffer';
import {getAutoSummaryScheduleSlots,resolveAutoSummaryRunWindow} from '../../src/features/ai/autoSummaryRouting.js';
import {getLocalDateString,zonedDateTimeToUtcMilliseconds} from '../../src/shared/date.js';

const source=readFileSync(new URL('../../src/app/botApplication.js',import.meta.url),'utf8');
const range=(from,to)=>{
 const a=source.indexOf(from),b=source.indexOf(to,a+from.length);
 assert.ok(a>=0&&b>a,'missing function source '+from);
 return source.slice(a,b);
};
const timezone='Europe/Moscow',day='2026-11-07';
const startAt=Date.parse('2026-11-06T21:00:00.000Z')/1000;
const endAt=Date.parse('2026-11-07T21:00:00.000Z')/1000;
const settings={peerId:2000000010,mode:'custom',schedule:['12:00','18:00','22:00']};
const makeHistory=(count=4500)=>Array.from({length:count},(_,index)=>({
 peerId:settings.peerId,sourcePeerId:settings.peerId,senderId:100+index%12,
 conversationMessageId:index+1,createdAt:startAt+1+Math.round(index*(endAt-startAt-4)/count),
 text:'Сообщение '.repeat(23)+' '+index
}));
function collect(history,runs=[],dailySummaries=[]) {
 const saved=new Map(runs.map(x=>[x.slot,x]));
 const context={
  botTimeZone:timezone,
  getAutoSummaryScheduleSlots,
  getAutoSummaryRun:(_id,_date,slot)=>saved.get(slot)||null,
  getHierarchyDailySummaries:()=>dailySummaries,
  getHierarchyMessageStates:()=>[],
  hierarchyMessageKey:x=>String(x.conversationMessageId),
  getLocalDateString,zonedDateTimeToUtcMilliseconds,resolveAutoSummaryRunWindow,
  loadLinkedSummaryHistory:()=>history,
  filterAutoSummaryMessages:x=>x,
 };
 runInNewContext(range('function collectConfiguredPeriodicSummaryInput(','async function runConfiguredAutoSummaryPeriodicTick(')
 +'\nthis.run=collectConfiguredPeriodicSummaryInput;',context);
 return context.run;
}
test('start-up imports every symbol used by auto-summary schedule restoration',()=>{
 const importBlock=source.match(/import\s*\{([\s\S]*?)\}\s*from '\.\.\/features\/ai\/autoSummaryRouting\.js'/u)?.[1]||'';
 assert.match(importBlock,/\bgetAutoSummaryScheduleSlots\b/u);
 assert.deepEqual(getAutoSummaryScheduleSlots('custom',settings.schedule),settings.schedule);
 assert.match(source,/repairAutoSummarySchedulesAfterRestart\(\);\s*runDetachedSupervisedOperation\(\{name:'custom-auto-summary:startup'/u);
 assert.match(source,/getDueAutoSummarySettings\(now\)\.filter\(row => !customOnly \|\| row\.mode === 'custom'\)/u);
});
test('no prepared daily batches -> full original history, no truncation or invented text',()=>{
 const history=makeHistory(),input=collect(history)({ ...settings },{kind:'daily',key:day,startAt,endAt});
 assert.equal(input.originalCount,4500);
 assert.equal(input.messages.length,4500);
 assert.equal(input.messages[0].conversationMessageId,1);
 assert.equal(input.messages.at(-1).conversationMessageId,4500);
});
test('if no stored day summaries, weekly/monthly use the source messages',()=>{
 const history=makeHistory(840),run=collect(history);
 for(const kind of ['weekly','monthly']){
  const input=run(settings,{kind,key:day,startAt,endAt});
  assert.equal(input.originalCount,840,kind);
  assert.equal(input.messages.length,840,kind);
 }
});
test('existing daily slot summary replaces only its covered time; missing portions use raw messages',()=>{
 const history=[
  {createdAt:Date.parse('2026-11-07T08:00:00Z')/1000,conversationMessageId:1,text:'before 12:00'},
  {createdAt:Date.parse('2026-11-07T13:00:00Z')/1000,conversationMessageId:2,text:'after 12:00'},
 ];
 const run=collect(history,[{slot:'12:00',finishedAt:100,summaryText:'Итог утра',messageCount:1}]);
 const input=run(settings,{kind:'daily',key:day,startAt,endAt});
 assert.equal(input.originalCount,2);
 assert.ok(input.messages.some(x=>x.text.includes('Итог утра')));
 assert.ok(input.messages.some(x=>x.text==='after 12:00'));
 assert.ok(!input.messages.some(x=>x.text==='before 12:00'));
});
test('large history is split by budget and per-batch count and all items are retained',()=>{
 const context={Buffer,Math,console,SUMMARY_COMMAND_INPUT_TOKEN_BUDGET:24000,SUMMARY_COMMAND_BATCH_MESSAGES:3000};
 const code=range('function estimateSummaryTokens(', 'function summaryCommandCacheKey(')
   +range('function splitStableSummaryMessageBatches(', 'async function runCachedSummaryStage(')
   +'\nthis.run=splitStableSummaryMessageBatches;';
 runInNewContext(code,context);
 const history=makeHistory();
 const entries=history.map(x=>({line:'[дата] участник: '+x.text}));
 const batches=context.run(entries);
 assert.ok(batches.length>1,'should break into multiple model calls');
 assert.ok(batches.every(batch=>batch.length>0&&batch.length<=3000));
 assert.equal(batches.reduce((count,batch)=>count+batch.length,0),history.length);
 assert.match(source,/if \(batch\.length > 1 && isContextWindowError\(error\)\)/u,'context-window error retries by splitting batch');
 assert.match(source,/while \(summaries\.length > 1\)/u,'partial outputs merged to single final summary');
});
