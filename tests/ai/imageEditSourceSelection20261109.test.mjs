import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {DatabaseSync} from 'node:sqlite';
import {selectImmediateImageEditSource as select,buildExplicitImageEditPrompt as prompt} from '../../src/features/ai/imageEditSourceSelection.js';
const photo=(url,id=5)=>({type:'photo',photo:{id,owner_id:12,sizes:[{width:100,height:150,url:'https://test.example/thumb.jpg'},{width:1000,height:1500,url}]}});
test('Patrol 280668: attached photo takes precedence over a quoted message without photos',()=>{
 const m={conversation_message_id:280668,attachments:[photo('https://test.example/cmd.jpg')],reply_message:{conversation_message_id:280650,text:'bot',attachments:[],reply_message:{attachments:[]}}};
 const r=select(m);assert.equal(r.source,'attached-to-command');assert.equal(r.conversationMessageId,280668);
 assert.deepEqual(r.urls,['https://test.example/cmd.jpg']);
});
test('Image in immediate reply wins, never mix with older photographs',()=>{
 const r=select({conversation_message_id:3,reply_message:{conversation_message_id:2,attachments:[photo('https://test.example/reply.jpg')],reply_message:{attachments:[photo('https://test.example/old.jpg')]}}});
 assert.equal(r.source,'immediate-reply');assert.deepEqual(r.urls,['https://test.example/reply.jpg']);
});
test('One-level fallback works for quote wrappers; no recursive scan beyond it',()=>{
 const r=select({reply_message:{conversation_message_id:10,attachments:[],reply_message:{conversation_message_id:9,attachments:[photo('https://test.example/inner.jpg')],reply_message:{attachments:[photo('https://test.example/too-old.jpg')]}}}});
 assert.equal(r.source,'reply-of-reply');assert.deepEqual(r.urls,['https://test.example/inner.jpg']);
 const z=select({reply_message:{attachments:[],reply_message:{attachments:[],reply_message:{attachments:[photo('https://test.example/old.jpg')]}}}});
 assert.deepEqual(z.urls,[]);
});
test('Forwarded photos in reply only if direct sources have none',()=>{
 const r=select({reply_message:{attachments:[],fwd_messages:[{attachments:[photo('https://test.example/forward.jpg')]}]}});
 assert.equal(r.source,'reply-forward');assert.deepEqual(r.urls,['https://test.example/forward.jpg']);
});
test('Repeated attachment URL only once and no reply works',()=>{
 const p=photo('https://test.example/current.jpg');
 const r=select({attachments:[p,p]});assert.equal(r.hasReply,false);assert.deepEqual(r.urls,['https://test.example/current.jpg']);
});
test('User action verb and beard/scalp instructions are retained',()=>{
 assert.match(prompt('дорисуй волосы'),/^дорисуй волосы\n/u);
 assert.match(prompt('Добавь мне бороду 😹'),/естественную реалистичную бороду/u);
 assert.equal(prompt('дорисуй солнце'),'дорисуй солнце');
});
test('Real VK archived photo from Patrol 280668 is available at the command level',()=>{
 const db=new DatabaseSync('data/bot.sqlite',{readOnly:true});
 try{
  const row=db.prepare('SELECT raw_message_json FROM vk_message_archive WHERE peer_id=? AND conversation_message_id=?').get(2000000011,280668);
  assert.ok(row);
  const result=select(JSON.parse(row.raw_message_json));
  assert.equal(result.source,'attached-to-command');assert.equal(result.conversationMessageId,280668);
  assert.equal(result.urls.length,1);
 }finally{db.close();}
});
test('Production edit handler uses authoritative selector and preserves explicit prompt',()=>{
 const app=readFileSync(new URL('../../src/app/botApplication.js',import.meta.url),'utf8');
 const fragment=app.slice(app.indexOf('async function sendGptEditedImage('),app.indexOf('async function sendGptGeneratedImage('));
 assert.match(fragment,/selectImmediateImageEditSource\(original\)/u);
 assert.match(fragment,/buildExplicitImageEditPrompt\(editRequest\.prompt\)/u);
 assert.match(fragment,/sourceImageDataUrls:\s*preparedSourceImages/u);
 assert.doesNotMatch(fragment,/editRequest\.instruction/u);
});
