import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import {inspectVkMessageStructure,vkCurrentMessageOnly,vkStickerImageUrl,vkHasCurrentSticker} from '../../src/platforms/vk/vkMessageStructure.js';
import {decideVkConversationInput,handleVkConversationInput} from '../../src/features/routing/vkConversationInput.js';
import {collectIncomingMediaContext} from '../../src/features/ai/incomingImageTargets.js';
import {buildImplicitVkAttachmentRequest} from '../../src/features/routing/vkImplicitAttachmentRequest.js';
import {isImageInspectionRequest} from '../../src/features/ai/visionRouting.js';
const sticker={type:'sticker',sticker:{sticker_id:123,images:[
 {url:'https://vk.com/sticker64.png',width:64,height:64},{url:'https://vk.com/sticker512.png',width:512,height:512}]}};
const photo={type:'photo',photo:{id:88,owner_id:22,sizes:[{url:'https://vk.com/old.jpg',width:2000,height:1000}]}};
const original={peer_id:2000000027,conversation_message_id:221370,from_id:7,text:'',attachments:[photo]};
const reply={peer_id:2000000027,conversation_message_id:221375,from_id:-12,
 text:'Да, тут убирать всё: стол, посуду, банки и мусор. Кота не трогать.',reply_message:original};
const message={peer_id:2000000027,conversation_message_id:221377,from_id:44,text:'',attachments:[sticker],reply_message:reply};
test('all attachment types remain typed, including unsupported future types',()=>{
 const types=['photo','video','audio','doc','audio_message','sticker','graffiti','wall','wall_reply','link',
 'poll','market','market_album','album','gift','podcast','artist','playlist','story','clip','video_message',
 'call','money_transfer','app','event','page','note','pretty_cards','animation','contact','future_format'];
 const s=inspectVkMessageStructure({attachments:types.map(type=>({type,[type]:{id:1}})),geo:{coordinates:{latitude:1,longitude:2}}});
 assert.deepEqual(s.attachments.filter(a=>a.scope==='current').map(a=>a.type),[...types,'geo']);
 assert.equal(s.attachments.find(a=>a.type==='future_format').knownType,false);
 assert.equal(s.attachments.find(a=>a.type==='video').visualKind,'video');
});
test('current sticker, quoted bot and old photo retain separate message identities',()=>{
 const s=inspectVkMessageStructure(message);
 assert.deepEqual(s.attachments.map(a=>[a.type,a.scope,a.cmid,a.senderId]),[
  ['sticker','current',221377,44],['photo','context',221370,7]]);
 assert.equal(s.current.text,'');assert.equal(s.messages[1].senderId,-12);
 assert.equal(s.messages[2].parentPath,'message.reply');
});
test('reply, forward, quote, repost and wall nested content preserve boundaries',()=>{
 const s=inspectVkMessageStructure({peer_id:2000000027,text:'мой вопрос',replyMessage:{text:'ответ'},
 forwardedMessages:[{text:'пересылка',from_id:8,attachments:[sticker]}],
 quote:{text:'цитата'},copyHistory:[{text:'репост'}],attachments:[{type:'wall',wall:{text:'пост',copy_history:[{text:'источник'}]}}]});
 for(const relation of ['current','reply','forward','quote','repost','wall'])assert.ok(s.messages.some(m=>m.relation===relation),relation);
 assert.equal(s.current.text,'мой вопрос');assert.equal(s.attachments.find(a=>a.type==='sticker').scope,'context');
});
test('VK wrappers, no explicit type, cycles and node budgets are handled',()=>{
 const raw={text:'',attachments:[{toJSON:()=>({sticker:sticker.sticker})}]};raw.reply_message=raw;
 assert.equal(inspectVkMessageStructure(raw).attachments[0].type,'sticker');
 assert.equal(inspectVkMessageStructure(raw).messages.length,1);
 assert.equal(inspectVkMessageStructure({attachments:Array(20).fill(photo)},{maxNodes:4}).truncated,true);
});
test('captionless sticker and direct photos never manufacture analysis instructions',()=>{
 for(const raw of [message,{attachments:[photo]},{reply_message:reply},{fwd_messages:[original]},{attachments:[{type:'doc'}]}]){
  assert.equal(buildImplicitVkAttachmentRequest(raw),'');
  assert.equal(decideVkConversationInput({message:raw,addressed:true}).action,'silent');
 }
});
test('own request is required; quote commands, labels and social replies are not requests',()=>{
 for(const text of ['', 'Стикер','[стикер]','да','ахаха','👍','спасибо','астра спасибо']){
  const r=decideVkConversationInput({message,text,addressed:true});
  assert.equal(r.action,'silent',text);
 }
 assert.equal(decideVkConversationInput({message:{fwd_messages:[{text:'Опиши фото'}]},addressed:true}).action,'silent');
 assert.equal(decideVkConversationInput({message,text:'',mentioned:true,addressed:true}).action,'clarify');
});
test('ambiguous addressed request asks without old-image recovery; actual tasks survive',()=>{
 for(const text of ['?','сделай','а это?','астра']){
  assert.equal(decideVkConversationInput({message,text,addressed:true}).action,'clarify',text);
 }
 for(const text of ['Опиши стикер','что означает этот стикер?','убери стол с фото','тусы завтра','найди исходную фотографию']){
  assert.equal(decideVkConversationInput({message,text,addressed:true}).action,'continue',text);
 }
 for(const text of ['Опиши стикер','что означает этот стикер?'])assert.equal(isImageInspectionRequest(text),true,text);
});
test('voice input, button payload and textual answer to a question stay in their workflows',()=>{
 for(const args of [{message:{attachments:[{type:'audio_message'}]}},{hasButton:true},{voicePending:true},
 {message:{reply_message:{text:'Продолжить?'}},text:'да'}]){
  assert.equal(decideVkConversationInput(args).action,'continue');
 }
});
test('sticker picker chooses actual largest sticker preview, never reply photo',async()=>{
 assert.equal(vkStickerImageUrl(sticker),'https://vk.com/sticker512.png');
 const direct=await collectIncomingMediaContext({platform:'vk',eventPayload:{object:{message:vkCurrentMessageOnly(message)}}});
 assert.equal(direct.images.length,1);assert.equal(direct.images[0].attachmentType,'sticker');
 assert.equal(direct.images[0].attachmentId,'sticker:123');
 assert.equal(direct.images[0].url,'https://vk.com/sticker512.png');
 const all=await collectIncomingMediaContext({platform:'vk',eventPayload:{object:{message}}});
 assert.equal(all.images.length,2);assert.equal(all.structure.attachments.length,2);
});
test('background images and unavailable sticker remain distinct, never old-photo fallback',()=>{
 assert.equal(vkStickerImageUrl({type:'sticker',sticker:{images_with_background:[{url:'https://vk.com/background.png',width:128,height:128}]}}),'https://vk.com/background.png');
 assert.equal(vkStickerImageUrl({type:'sticker',sticker:{sticker_id:456}}),'');
});
test('perception of reaction is internal even if model text pretends to issue a task',async()=>{
 const sent=[],seen=[],observed=[];
 await handleVkConversationInput(decideVkConversationInput({message,addressed:true}),{
 inspectSticker:async item=>{seen.push(item.url);return 'Опиши старую фотографию!';},
 send:async text=>sent.push(text),observe:event=>observed.push(event)});
 assert.deepEqual(seen,['https://vk.com/sticker512.png']);assert.deepEqual(sent,[]);
 assert.equal(observed[0].status,'observed');
});
test('failed sticker perception stays silent, clarification is one short question',async()=>{
 const sent=[];
 for(const action of ['silent','clarify'])await handleVkConversationInput({action,stickers:[{url:'https://vk.com/sticker.png'}]},{
  inspectSticker:async()=>{throw Error('unavailable');},send:async x=>sent.push(x)});
 assert.deepEqual(sent,['Что нужно сделать с этим сообщением?']);
});
const app=readFileSync(new URL('../../src/app/botApplication.js',import.meta.url),'utf8');
test('production gate inspects only current sticker and sends nothing for Anna reaction',async()=>{
 const start=app.indexOf('const vkStickerPerceptionCache = new Map();');
 const end=app.indexOf('async function handleVkIncomingMessageCore(',start);
 const calls=[],sent=[],persisted=[];
 const sandbox={console:{log:()=>{}},decideVkConversationInput,handleVkConversationInput,
 getVkRawMessage:x=>x,isPrivateContext:()=>false,containsBotMention:()=>false,contextReferencesBot:()=>true,
 removeBotMentions:x=>x,patrolActiveScope:()=>null,scheduleVkLivePersistence:(...x)=>persisted.push(x),
 resolveGptModel:async()=> 'gpt-6-luna',enqueueOpenAI:async f=>f(),
 generateOpenAIVisionText:async options=>{calls.push(options);return '{"visibleText":"ДА!","visualMeaning":"согласие"}';}};
 vm.createContext(sandbox);vm.runInContext(app.slice(start,end)+'this.run=handleVkConversationAttachmentInput;',sandbox);
 const ctx={peerId:2000000027,conversationMessageId:221377,send:async x=>sent.push(x)};
 assert.equal(await sandbox.run(ctx,message,''),true);assert.equal(calls.length,1);
 assert.deepEqual(Array.from(calls[0].imageUrls),['https://vk.com/sticker512.png']);
 assert.equal(calls[0].skipIncomingMessageContext,true);assert.deepEqual(sent,[]);assert.equal(persisted.length,1);
 await sandbox.run(ctx,message,'');assert.equal(calls.length,1,'identical sticker perception reused');
});
test('production source selection returns current sticker before any ancestry fetch',async()=>{
 const start=app.indexOf('async function resolveRichIncomingImageTargets(');
 const end=app.indexOf('async function handleVisionRequest(',start);
 const sandbox={getVkRawMessage:x=>x.message,vkHasCurrentSticker,vkCurrentMessageOnly,collectIncomingMediaContext,
 resolveCompleteVkReplyThread:()=>{throw Error('must not hydrate old photo');},
 resolveRichIncomingMediaContext:()=>{throw Error('must not resolve inherited media');}};
 vm.createContext(sandbox);vm.runInContext(app.slice(start,end)+'this.run=resolveRichIncomingImageTargets;',sandbox);
 assert.deepEqual(Array.from(await sandbox.run({platform:'vk',message})),['https://vk.com/sticker512.png']);
 const absent={...message,attachments:[{type:'sticker',sticker:{sticker_id:456}}]};
 assert.deepEqual(Array.from(await sandbox.run({platform:'vk',message:absent})),[]);
});
test('production early gate precedes adaptive planning and content normalization',()=>{
 const start=app.indexOf('async function handleVkIncomingMessageCore(');
 const gate=app.indexOf('if(await handleVkConversationAttachmentInput(',start);
 assert.ok(gate>start);
 assert.ok(gate<app.indexOf('&&await handlePatrolAdaptive(context,directText,incomingContext)',start));
 assert.ok(gate<app.indexOf('normalizedVkContent = await resolveVkMessageContent(',start));
 assert.doesNotMatch(app,/implicitVkAttachmentRequest/);
});
