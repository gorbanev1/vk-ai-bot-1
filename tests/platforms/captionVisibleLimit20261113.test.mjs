import test from 'node:test';
import assert from 'node:assert/strict';
import {createTelegramContext,createTelegramPhotoAttachment} from '../../src/platforms/telegram/telegramBot.js';
test('900 visible characters with long HTML URLs produce one complete photo caption',async()=>{
 const sends=[];
 const context=createTelegramContext({api:{sendChatAction:async()=>{},sendMessage:async p=>{sends.push(['text',p]);return{message_id:1}},sendPhoto:async p=>{sends.push(['photo',p]);return{message_id:2}}},
 message:{chat:{id:701,type:'private'},from:{id:701},message_id:700,text:'card'},menuState:{},botUser:{id:799,username:'Gigorave_bot'},resolvePeerId:()=>701,resolveUserId:()=>701,ownerUserId:'701'});
 const text='Карточка & факты. '+'А'.repeat(880);
 const html='<a href="https://example.org/'+ 'path'.repeat(150)+'">Карточка</a> &amp; факты. '+'А'.repeat(880);
 const attachment=createTelegramPhotoAttachment({buffer:Buffer.from('fixture'),filename:'fixture.jpg'});
 await context.send({message:text,html,htmlCaption:html,attachment,singleMediaMessage:true});
 assert.equal(sends.length,1);assert.equal(sends[0][0],'photo');
 assert.equal(sends[0][1].caption,html);assert.equal(sends[0][1].captionParseMode,'HTML');
});
