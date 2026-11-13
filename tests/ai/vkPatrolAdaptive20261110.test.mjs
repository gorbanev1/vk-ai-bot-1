import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdirSync,mkdtempSync,readFileSync,rmSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

const folder=mkdtempSync(join(tmpdir(),'patrol-adaptive-'));
const old=process.env.GIGORAVE_DATA_DIR;
process.env.GIGORAVE_DATA_DIR=folder;
mkdirSync(join(folder,'vk-patrol-adaptive'),{recursive:true});
writeFileSync(join(folder,'vk-patrol-adaptive','tracking-start.json'),JSON.stringify({day:'2026-11-10'}));
const api=await import('../../src/features/ai/vkPatrolAdaptive.js?test=20261110');

test('scoped 10 million token ledger, 09:00 report and idempotent delivery',async()=>{
 const initial=api.patrolUsage();
 assert.equal(initial.limit,10_000_000);
 assert.equal(initial.tokens,0);
 const result=await api.runPatrolScopedRequest('123',async()=>{
  api.recordPatrolTokenUsage({timestamp:'2026-11-10T12:00:00.000Z',totalTokens:1080,inputTokens:730,
   outputTokens:350,capability:'text',operation:'adaptive-test',model:'gpt-6-astra',usageSource:'provider'});
  return 'ok';
 });
 assert.equal(result.allowed,true);
 assert.equal(result.result,'ok');
 assert.equal(api.patrolUsage('2026-11-10').tokens,1080);
 assert.equal(api.patrolUsage('2026-11-10').calls,1);
 const messages=[];
 const future=new Date('2026-11-11T06:04:00.000Z'); // 09:04 Voronezh / Moscow
 assert.equal(await api.maybeSendPatrolMorningReport(text=>{messages.push(text)},new Date('2026-11-11T05:59:00.000Z')),false);
 assert.equal(await api.maybeSendPatrolMorningReport(text=>{messages.push(text)},future),true);
 assert.equal(messages.length,1);
 assert.match(messages[0],/1\s?080/u);
 assert.equal(await api.maybeSendPatrolMorningReport(text=>{messages.push(text)},future),false);
 assert.equal(messages.length,1);
});
test('patrol planner uses Luna high exclusively and cannot be redirected by Astra channel',()=>{
 const src=readFileSync(new URL('../../src/app/botApplication.js',import.meta.url),'utf8');
 const start=src.indexOf('async function handlePatrolAdaptive('),end=src.indexOf('const huinglishLessons',start);
 assert.ok(start>0&&end>start);
 const handler=src.slice(start,end);
 assert.match(handler,/model:GPT6_LUNA_MODEL_ID,mode:'default'/u);
 assert.match(handler,/modelLadder:\s*\[\s*\{model:GPT6_LUNA_MODEL_ID,mode:'default',reasoningEffort:'high',attempts:1\}\]/u);
 assert.match(handler,/runPatrolAdaptiveModule\('history'/u);
 assert.match(handler,/patrolTraceStatus\('budget-exhausted'/u);
 assert.match(src,/astraChannelRoute && !\/\^vk-patrol-adaptive-\/u\.test/u);
});
test('only explicit personal photo command pins a person, preserving CMID and reference cap',()=>{
 assert.equal(api.isPatrolPeer(2000000011),true);
 assert.equal(api.isPatrolPeer(2000000038),false);
 assert.equal(api.parsePatrolPersonalPhotoCommand('Гигорейв личное фото Олег').name,'Олег');
 assert.equal(api.parsePatrolPersonalPhotoCommand('фото просто'),null);
 const raw={conversation_message_id:321,id:555,from_id:987,text:'фото',
 attachments:[{type:'photo',photo:{id:55,owner_id:987,sizes:[{width:600,height:800,url:'https://example.org/photo.jpg'}]}}]};
 api.logPatrolMessage({peerId:2000000011,conversationMessageId:321},raw,{addressed:false});
 assert.equal(api.patrolRecentPhotoMessages().at(-1).cmid,321);
 const sample='data:image/jpeg;base64,'+Buffer.from('fake image data').toString('base64');
 const pinned=api.savePatrolPersonalPhotos({peerId:2000000011,userId:0,name:'Олег',
   sourceCmid:321,sourceMessageId:555,uploadedBy:321,dataUrls:[sample]});
 assert.equal(pinned.name,'Олег');
 assert.equal(pinned.sourceCmid,321);
 assert.equal(pinned.photos,1);
 assert.equal(api.patrolPinnedPhotoReferences(2000000011,'Дорисуй Олега',6).length,1);
 assert.equal(api.patrolPinnedPhotoReferences(2000000038,'Дорисуй Олега',6).length,0);
 const saved=JSON.parse(readFileSync(join(folder,'vk-patrol-adaptive','people.json'),'utf8'));
 assert.equal(saved.people[0].photos[0].sourceCmid,321);
});
test.after(()=>{if(old===undefined)delete process.env.GIGORAVE_DATA_DIR;else process.env.GIGORAVE_DATA_DIR=old;rmSync(folder,{recursive:true,force:true})});
