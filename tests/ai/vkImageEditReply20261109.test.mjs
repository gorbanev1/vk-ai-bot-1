import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createVkIncomingReplyContext} from '../../src/shared/incomingReplyTransport.js';
test('VK image editor and ordinary text share MessageContext.reply',async()=>{
 const calls=[];
 const native={peerId:2000000011,conversationMessageId:280668,
  reply:async(payload,params)=>{calls.push({type:'reply',payload,params});return {id:123};},
  send:async payload=>{calls.push({type:'send',payload});}};
 const ctx=createVkIncomingReplyContext(native);
 await ctx.send('Да уж, борода огонь 😹');
 await ctx.send({message:'🛠️ gpt-image-2.5',attachment:'photo425925302_457270187'});
 assert.deepEqual(calls.map(x=>x.type),['reply','reply']);
 assert.equal(calls[1].payload.attachment,'photo425925302_457270187');
});
test('Production image editor has no custom VK send or reply blacklist',()=>{
 const p=process.env.GIGORAVE_VK_REPLY_TEST_APP||new URL('../../src/app/botApplication.js',import.meta.url);
 const app=readFileSync(p,'utf8');
 const block=app.slice(app.indexOf('async function sendGptEditedImage('),app.indexOf('async function sendGptGeneratedImage('));
 assert.match(block,/await context\.send\(\{message:'🛠️ '\+imageModel,attachment\}\)/u);
 assert.doesNotMatch(block,/vkImageEditUnsupportedReplyPeers|\.api\.messages\.send|buildVkConversationReplySendParams/u);
 assert.doesNotMatch(app,/vkImageEditUnsupportedReplyPeers/u);
 assert.match(block,/sourceImageDataUrls:\s*preparedSourceImages/u);
});