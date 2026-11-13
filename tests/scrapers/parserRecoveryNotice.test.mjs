import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import * as notices from '../../src/features/scrapers/parserRecoveryNotice.js';
const {createParserRecoveryScope,parserRecoveryScopeToken,matchesParserRecoveryScope,buildParserRecoveryMarkup,parseParserRecoveryCallback,parserRecoveryActions}=notices;
const row={sourceId:'vk:literabar',itemId:'8847',sourceUrl:'https://vk.ru/wall-1_8847',error:'MISSING_USABLE_POSTER',item:{text:'21 ноября'}};
test('poster warning offers only archive, exact-post browser retry and fresh status',()=>{
 const scope=createParserRecoveryScope([row],{posterWarning:true}), markup=buildParserRecoveryMarkup([row],scope);
 assert.deepEqual(markup.inline_keyboard.map(([b])=>parseParserRecoveryCallback(b.callback_data).action),['archive','browser','status']);
 for(const [b] of markup.inline_keyboard)assert.ok(Buffer.byteLength(b.callback_data)<=64);
});
test('image CDN and unaddressable messages cannot become browser retry buttons',()=>{
 for(const sourceUrl of ['https://sun9.userapi.com/photo.jpg','https://vk.ru/photo-1_7','https://vk.ru/club1','']){
  const candidate={...row,sourceUrl},scope=createParserRecoveryScope([candidate],{posterWarning:true});
  assert.deepEqual(parserRecoveryActions([candidate],scope).map(x=>x[0]),['archive','status']);
 }
});
test('text validation offers reprocessing stored evidence without needless browser capture',()=>{
 const candidate={...row,error:'evidence-not-verbatim-in-source'};
 const scope=createParserRecoveryScope([candidate]);
 assert.deepEqual(parserRecoveryActions([candidate],scope).map(x=>x[0]),['archive','status']);
});
test('durable scope never widens to unrelated errors and is stable across JSON/restart/order',()=>{
 const second={...row,itemId:'999'};
 const scope=createParserRecoveryScope([row,second,row],{posterWarning:true});
 assert.equal(scope.keys.length,2);
 assert.equal(parserRecoveryScopeToken(scope),parserRecoveryScopeToken(JSON.parse(JSON.stringify(createParserRecoveryScope([second,row],{posterWarning:true})))));
 assert.equal(matchesParserRecoveryScope(row,scope),true);
 assert.equal(matchesParserRecoveryScope({...row,itemId:'1'},scope),false);
 assert.equal(matchesParserRecoveryScope({...row,sourceId:'tg:literabar'},scope),false);
 assert.equal(matchesParserRecoveryScope(row,{keys:[]}),false);
 assert.equal(matchesParserRecoveryScope(row,null),true);
 assert.deepEqual(parserRecoveryActions([],scope).map(x=>x[0]),['status']);
});
const app=readFileSync(new URL('../../src/app/botApplication.js',import.meta.url),'utf8');
function callbackFixture({owner=true,privateChat=true,exists=true,rows=[row],busy=false}={}){
 const scope=createParserRecoveryScope([row],{posterWarning:true}),sent=[],calls=[];
 const context={answerCallbackQuery:async value=>calls.push(['ack',value]),send:async value=>sent.push(value)};
 const data='parser_fix:browser:'+parserRecoveryScopeToken(scope);
 const start=app.indexOf('async function handleParserWarningCallback('),end=app.indexOf('\nasync function notifyParserItemErrorOwner',start);
 const callback=vm.runInNewContext(app.slice(start,end)+'\nhandleParserWarningCallback;',{
  ...notices,getRawContext:()=>({callbackQuery:{data}}),isOwnerContext:()=>owner,isPrivateContext:()=>privateChat,
  getMaintenanceState:()=>exists?{details:JSON.parse(JSON.stringify(scope))}:null,
  currentParserWarningRows:()=>({rows}),
  sendParserWarningStatus:async()=>calls.push(['status']),
  replayOpenParserErrorsForOwner:async (ctx,options)=>{calls.push(['replay',options]);return busy?undefined:{queued:true};},
 });
 return {callback,context,calls,sent,scope};
}
test('production callback rejects non-owner and group clicks before touching recovery',async()=>{
 for(const flags of [{owner:false},{privateChat:false}]){
  const f=callbackFixture(flags);assert.equal(await f.callback(f.context),true);
  assert.equal(f.calls.length,1);assert.equal(f.calls[0][0],'ack');assert.equal(f.calls[0][1].showAlert,true);
 }
});
test('production callback passes exact persisted scope and browser mode to existing recovery',async()=>{
 const f=callbackFixture();await f.callback(f.context);
 assert.deepEqual(f.calls.map(x=>x[0]),['ack','replay']);
 assert.equal(f.calls[1][1].missingCapture,true);
 assert.deepEqual(JSON.parse(JSON.stringify(f.calls[1][1].scope)),f.scope);
 await f.calls[1][1].onSettled();assert.equal(f.calls.at(-1)[0],'status');
});
test('old repaired warning and missing scope do not launch browser or global replay',async()=>{
 const repaired=callbackFixture({rows:[]});await repaired.callback(repaired.context);
 assert.deepEqual(repaired.calls.map(x=>x[0]),['ack','status']);
 const missing=callbackFixture({exists:false});await missing.callback(missing.context);
 assert.equal(missing.calls.length,1);assert.equal(missing.sent.length,1);
});
test('scope filters actual recovery rows before grouping and archive updates',()=>{
 const start=app.indexOf('async function replayOpenParserErrorsForOwner('),end=app.indexOf('\nasync function ',start+20);
 const body=app.slice(start,end);
 assert.match(body,/const allErrors = listParserErrors[^;]+matchesParserRecoveryScope\(row, scope\)/);
 assert.match(body,/eventHasUsableMediaV18883\)\.filter\(row => matchesParserRecoveryScope\(row, scope\)\)/);
 assert.match(body,/if \(!replayDetached\) parserErrorReplayRunning = false/);
 assert.match(app,/candidate.sourceId === row.sourceId && candidate.itemId === row.itemId/);
});
test('split owner warning places keyboard on final chunk only',async()=>{
 const sent=[],start=app.indexOf('async function sendAiModelDiscoveryOwnerReport('),end=app.indexOf('\nasync function ',start+20);
 const send=vm.runInNewContext(app.slice(start,end)+'\nsendAiModelDiscoveryOwnerReport;',{
  telegramBot:{api:{sendMessage:async v=>sent.push(v)}},telegramBotStarted:true,telegramOwnerExternalUserId:'owner',console,
 });
 const scope=createParserRecoveryScope([row],{posterWarning:true}),markup=buildParserRecoveryMarkup([row],scope);
 await send('x'.repeat(8000),{replyMarkup:markup});
 assert.equal(sent.length,3);assert.ok(sent.every(x=>x.text.length<=3800));
 assert.equal(sent[0].replyMarkup,undefined);assert.equal(sent[1].replyMarkup,undefined);
 assert.equal(sent[2].replyMarkup,markup);
});

function replayFixture({failList=false}={}) {
 const start=app.indexOf('async function replayOpenParserErrorsForOwner('),end=app.indexOf('\nasync function ',start+20);
 const calls=[];
 const sandbox={
  ...notices,console,recoveryPostUrl:row=>row.sourceUrl||'',repairArchivedUpcomingPosters:async()=>({recovered:0}),
  listParserErrors:()=>{if(failList)throw Error('read failed');return [row,{...row,sourceId:'vk:other',itemId:'9'}];},
  getStartupPosterRepairGroupsV18877:()=>[],buildPosterRecoveryCandidates:()=>[],
  getLocalDateString:()=> '2026-10-31',botTimeZone:'Europe/Moscow',eventHasUsableMediaV18883:()=>false,
  getManualScraperSources:()=>[],PARTY_POOL_PRIMARY:'primary',PARTY_POOL_SECONDARY:'secondary',
  runDetachedSupervisedOperation:(options)=>{calls.push(options);return Promise.resolve();},
 };
 const api=vm.runInNewContext('let parserErrorReplayRunning=false;\n'+app.slice(start,end)+
  '\n({run:replayOpenParserErrorsForOwner,busy:()=>parserErrorReplayRunning})',sandbox);
 return {api,calls,context:{send:async()=>{}}};
}
test('production replay groups only warning items despite unrelated durable errors',async()=>{
 const f=replayFixture();
 const result=await f.api.run(f.context,{scope:createParserRecoveryScope([row],{posterWarning:true})});
 assert.equal(result.found,1);assert.equal(result.queued,true);
 assert.equal(f.calls.length,1);assert.equal(f.calls[0].metadata.errorCount,1);assert.equal(f.calls[0].metadata.sourceCount,1);
});
test('preparation failure releases replay lock so another attempt remains possible',async()=>{
 const f=replayFixture({failList:true});
 await assert.rejects(f.api.run(f.context),/read failed/);
 assert.equal(f.api.busy(),false);
 await assert.rejects(f.api.run(f.context),/read failed/);
});
