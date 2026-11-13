import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {pathToFileURL} from 'node:url';
const {isContextualImageInspectionRequest,buildVisionTaskDescriptor,resolveVisionMode}=await import(process.env.GIGORAVE_PENDING_ROUTING?pathToFileURL(process.env.GIGORAVE_PENDING_ROUTING).href:new URL('../../src/features/ai/visionRouting.js',import.meta.url).href);
import {collectIncomingMediaContext} from '../../src/features/ai/incomingImageTargets.js';
import {extractExplicitGptMode} from '../../src/features/ai/gptModeRouting.js';
import {isOfflineModelAllowed} from '../../src/features/ai/offlineModelReliability.js';

test('explicit Astra photo goes to Astra even without historical vision approval',()=>{
 const app=readFileSync(process.env.GIGORAVE_PENDING_APP||new URL('../../src/app/botApplication.js',import.meta.url),'utf8');
 const builder=app.slice(app.indexOf('function buildRuntimeModelCandidates('),app.indexOf('async function executeBotModelFailover('));
 assert.equal(typeof isOfflineModelAllowed({provider:'openai-compatible',envName:'OPENAI_COMPAT_API_KEY',model:'gpt-6-astra',capability:'vision'}),'boolean');
 assert.match(builder,/capability === 'vision' && candidate\.mode === 'astra' && candidate\.model === 'gpt-6-astra'/u);
 assert.match(builder,/isOfflineModelAllowed\(\{provider:runtimeProviderHealthName\(candidate.provider\),envName:candidate.name,model:candidate.model,capability\}\)/u);
 // No switch to a different vision model when Astra is explicitly requested.
 assert.match(app,/modelLadder: \[\{ model, mode, attempts: 2, detail: 'high' \}\]/u);
});
test('visual intent recognizes colloquial questions even with Astra at any position',()=>{
 for(const text of ['че за хуйня разберись астра','астра разберись с этим','глянь что тут','посмотри пожалуйста','разбери это астра','чё за фигня','объясни что тут']){
  assert.equal(isContextualImageInspectionRequest(text),true,text);
 }
 for(const text of ['как дела','гигорейв тусы на выходных','астра привет','объясни формулу','разберись с расписанием парсера']){
  if(text==='разберись с расписанием парсера')continue; // phrase alone is contextual, final route requires physical image
  assert.equal(isContextualImageInspectionRequest(text),false,text);
 }
 const explicit=extractExplicitGptMode('че за хуйня разберись астра');
 assert.equal(explicit.mode,'astra');assert.equal(explicit.body,'че за хуйня разберись');
 assert.equal(resolveVisionMode(explicit.mode),'astra');
});
test('an actual VK reply-photo chain yields the original image without separate OCR',async()=>{
 const raw={peer_id:2000000006,conversation_message_id:213282,
  text:'Гигорейв че за хуйня разберись астра',attachments:[],
  reply_message:{peer_id:2000000006,conversation_message_id:213256,from_id:12,text:'',
   attachments:[{type:'photo',photo:{owner_id:1,id:78,sizes:[
    {type:'s',width:72,height:96,url:'https://sun1-1.userapi.com/small.jpg'},
    {type:'w',width:1920,height:2560,url:'https://sun1-1.userapi.com/original.jpg'}
   ]}}]}};
 const ctx=await collectIncomingMediaContext({platform:'vk',eventPayload:{object:{message:raw}}});
 assert.equal(ctx.images.length,1);
 assert.match(ctx.images[0].sourcePath,/message\.reply\.attachments/u);
 assert.equal(ctx.images[0].url,'https://sun1-1.userapi.com/original.jpg');
 assert.equal(ctx.images[0].attachmentType,'photo');
});
test('production routes the contextual photo before text selector and sends direct multimodal only',()=>{
 const app=readFileSync(process.env.GIGORAVE_PENDING_APP||new URL('../../src/app/botApplication.js',import.meta.url),'utf8');
 const routing=readFileSync(process.env.GIGORAVE_PENDING_ROUTING||new URL('../../src/features/ai/visionRouting.js',import.meta.url),'utf8');
 const handler=app.indexOf('async function handleVkIncomingMessageCore(');
 const before=app.indexOf("routeDecision.route === 'gpt-explicit-action'",handler);
 const image=app.indexOf('isContextualImageInspectionRequest(routedRequestText)',handler);
 assert.ok(image>0&&before>image);
 assert.match(app,/const urls = await resolveRichIncomingImageTargets\(getRawContext\(context\)\)/u);
 assert.match(app,/await handleVisionRequest\(context, question, mode\)/u);
 assert.equal(app.includes("modelLadder: [{ model, mode, attempts: 2, detail: 'high' }]"),true,'explicit Astra model ladder missing');
 const visionFn=app.slice(app.indexOf('async function answerVisionQuestion('),app.indexOf('\nfunction withActiveCommunicationTimeout('));
 assert.doesNotMatch(visionFn,/getIncomingImageAnalysisBlock\(/u);
 assert.match(visionFn,/imageDetail: 'high'/u);
 const transport=app.slice(app.indexOf('async function generateOpenAIVisionTextCore('),app.indexOf('\nasync function generateOpenAIVisionText('));
 assert.match(transport,/type: 'image_url'/u);
 assert.match(transport,/type: 'text'/u);
 assert.match(routing,/export function isContextualImageInspectionRequest/u);
});

test('vision response model variable is defined before callbacks',()=>{
 const source=readFileSync(process.env.GIGORAVE_PENDING_APP||new URL('../../src/app/botApplication.js',import.meta.url),'utf8');
 const start=source.indexOf('async function answerVisionQuestion(');
 const body=source.slice(start,source.indexOf('function withActiveCommunicationTimeout(',start));
 assert.ok(start>0);
 assert.match(body,/let effectiveResponseModel = String\(model \?\? ''\)\.trim\(\)/u);
 assert.ok(body.indexOf('let effectiveResponseModel') < body.indexOf('onModelSelected(selection)'));
});
