import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {DatabaseSync} from 'node:sqlite';
import {traceVkReplyConversation,selectVkReplyThreadImageSource,formatVkReplyThreadContext,classifyVkImageThreadFollowup} from '../../src/features/ai/vkReplyThreadContext.js';
import {parseImageEditRequest} from '../../src/features/ai/imageEditRouting.js';
const author=344464161,peer=2000000011;
function archived(cmid){
 const d=new DatabaseSync('data/bot.sqlite',{readOnly:true});
 try{const item=d.prepare('SELECT raw_message_json FROM vk_message_archive WHERE peer_id=? AND conversation_message_id=? ORDER BY source_peer_id DESC LIMIT 1').get(peer,cmid);assert.ok(item,'Missing archived Patrol example '+cmid);return JSON.parse(item.raw_message_json);}finally{d.close();}
}
const analyze=cmid=>{const message=archived(cmid);return {message,path:traceVkReplyConversation(message,{currentSenderId:author}),image:selectVkReplyThreadImageSource(message,{currentSenderId:author})};};
test('VK Patrol: edit follow-up 280714 finds exactly ONE nearest photo from CMID 280709',()=>{
 const r=analyze(280714);
 assert.equal(r.path.length,8);
 assert.equal(r.image.source,'thread-reply-depth-5');
 assert.equal(r.image.conversationMessageId,280709);
 assert.equal(r.image.depth,5);
 assert.equal(r.image.urls.length,1);
 assert.match(r.image.urls[0],/^https:\/\//u);
 assert.equal(parseImageEditRequest(r.message.text).matched,true);
});
test('VK Patrol: reply to an edited photo 280710 picks that image rather than the older one',()=>{
 const r=analyze(280710);
 assert.equal(r.image.source,'immediate-reply');
 assert.equal(r.image.conversationMessageId,280709);
 assert.equal(r.image.urls.length,1);
 assert.equal(classifyVkImageThreadFollowup(r.message.text,{source:r.image,thread:r.path}).type,'clarify');
});
test('VK Patrol: cancel 280712 is not interpreted as an expensive photo change',()=>{
 const r=analyze(280712);
 assert.equal(r.image.conversationMessageId,280709);
 assert.equal(classifyVkImageThreadFollowup(r.message.text,{source:r.image,thread:r.path}).type,'cancel');
});
test('VK Patrol: explicit 280707 edit still picks most recent picture 280691',()=>{
 const r=analyze(280707);
 assert.equal(r.image.conversationMessageId,280691);
 assert.equal(r.image.source,'immediate-reply');
 assert.equal(classifyVkImageThreadFollowup(r.message.text,{source:r.image,thread:r.path}).type,'none');
});
test('VK Patrol: original attached photo 280668 is authoritative over quoted text',()=>{
 const r=analyze(280668);
 assert.equal(r.image.source,'attached-to-command');
 assert.equal(r.image.conversationMessageId,280668);
 assert.equal(r.image.urls.length,1);
});
test('VK Patrol: last message 280717 has context across former cancel and edited photo',()=>{
 const r=analyze(280717);
 const text=formatVkReplyThreadContext(r.message,{currentSenderId:author});
 assert.ok(text.length<3101);
 assert.match(text,/Не, не надо тогда/u);
 assert.match(text,/Убери тогда волосы/u);
 assert.match(text,/есть фотография/u);
 assert.match(text,/280709/u);
 assert.ok(text.indexOf('Не, не надо тогда')<text.indexOf('Убери тогда волосы'));
});
const photo=url=>({type:'photo',photo:{sizes:[{url,width:800,height:950}]}});
test('Thread avoids other participants historical photos and unrelated branches',()=>{
 const message={date:1794260000,from_id:99,conversation_message_id:30,
  reply_message:{from_id:-233007447,conversation_message_id:29,
   reply_message:{from_id:123,conversation_message_id:28,
    attachments:[photo('https://test.example/other-person.jpg')]} }};
 const image=selectVkReplyThreadImageSource(message,{currentSenderId:99});
 assert.deepEqual(image.urls,[]);
 assert.equal(traceVkReplyConversation(message,{currentSenderId:99}).length,2);
});
test('Thread only traverses recent image ancestors when deeper than direct reply',()=>{
 const message={date:1794260000,from_id:99,conversation_message_id:30,
  reply_message:{date:1794259900,from_id:-233007447,conversation_message_id:29,
   reply_message:{date:1794000000,from_id:99,conversation_message_id:28,
    attachments:[photo('https://test.example/stale.jpg')]} }};
 assert.equal(selectVkReplyThreadImageSource(message,{currentSenderId:99}).urls.length,0);
});
test('No random photo from same chat when a reply chain has no image',()=>{
 const message={date:1794260000,from_id:99,conversation_message_id:12,
  reply_message:{from_id:-233007447,conversation_message_id:11,text:'обычный текст'}};
 assert.equal(selectVkReplyThreadImageSource(message,{currentSenderId:99}).urls.length,0);
 assert.equal(classifyVkImageThreadFollowup('Не, не надо тогда',{
  source:selectVkReplyThreadImageSource(message,{currentSenderId:99}),
  thread:traceVkReplyConversation(message,{currentSenderId:99})
 }).type,'none');
});
test('Production uses reply chain for image edits AND bounded GPT chat context, no quota charge without source',()=>{
 const app=readFileSync(process.env.GIGORAVE_VK_REPLY_TEST_APP||new URL('../../src/app/botApplication.js',import.meta.url),'utf8');
 assert.match(app,/formatVkSourceChain\(completeThread\)/u);
 assert.match(app,/const deeper=selectVkReplyThreadImageSource\(original/u);
 assert.match(app,/classifyVkImageThreadFollowup\(normalizedIncomingRequest/u);
 assert.match(app,/GPT IMAGE EDIT NO SOURCE NO CHARGE/u);
 const start=app.indexOf("    if(plannedImageEditRequest.matched&&getRawContext(context)?.platform==='vk')");
 const consume=app.indexOf('consumeGptModelDailyRateLimit({',start);
 assert.ok(start>0&&consume>start,'source verification must occur before quota consumption');
 const edit=app.slice(app.indexOf('async function sendGptEditedImage('),app.indexOf('async function sendGptGeneratedImage('));
 assert.match(edit,/await context\.send\(\{message:'🛠️ '\+imageModel,attachment\}\)/u);
});
