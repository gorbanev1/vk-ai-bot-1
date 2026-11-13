import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {buildTelegramMilanaMarkerMenu,withTelegramMarkerMenu,resolveTelegramMenuInput,buildTelegramPartyMenu,
 setTelegramMilanaMarkerModeProvider,createTelegramContext} from '../../src/platforms/telegram/telegramBot.js';
const labels=menu=>(menu?.keyboard||[]).flat().map(item=>item.text);
test('paused test plus Тусы opens real party reply-keyboard with quiz resume first',()=>{
 const result=resolveTelegramMenuInput('🎉 Тусы',{}, {isOwner:true});
 assert.equal(result.type,'response');assert.equal(result.state.menuPath,'parties');
 const menu=withTelegramMarkerMenu(result.replyMarkup,{mode:'paused',isOwner:true});
 assert.equal(menu.keyboard[0][0].text,'▶️ Продолжить тест по словам-маркерам');
 assert(labels(menu).includes('🍺 Второстепенные тусы'));
 assert(labels(menu).includes('🌐 Вообще все тусы'));
 assert(labels(menu).includes('⬅️ Назад'));
 assert(labels(menu).includes('🏠 Главное меню'));
 assert(!labels(menu).includes('🖼 Изображения'));
 assert.deepEqual(menu.keyboard.slice(1),result.replyMarkup.keyboard);
});
test('active marker still exposes original party menu and deduplicates quiz row',()=>{
 const base=buildTelegramPartyMenu({isOwner:true});
 const decorated=withTelegramMarkerMenu(base,{mode:'active',isOwner:true});
 const twice=withTelegramMarkerMenu(decorated,{mode:'active',isOwner:true});
 assert.deepEqual(decorated,twice);
 assert.equal(decorated.keyboard[0][0].text,'🚪 Выйти из режима теста по словам-маркерам');
 assert.deepEqual(decorated.keyboard.slice(1),base.keyboard);
});
test('back navigates to main without losing resumed quiz, while no quiz preserves submenu',()=>{
 const opened=resolveTelegramMenuInput('🎉 Тусы',{}, {isOwner:true});
 const back=resolveTelegramMenuInput('⬅️ Назад',opened.state, {isOwner:true});
 const menu=withTelegramMarkerMenu(back.replyMarkup,{mode:'paused',isOwner:true});
 assert.equal(menu.keyboard[0][0].text,'▶️ Продолжить тест по словам-маркерам');
 assert(labels(menu).includes('🎉 Тусы'));
 assert.deepEqual(withTelegramMarkerMenu(opened.replyMarkup,{mode:null}),opened.replyMarkup);
});
test('inline callback buttons remain intact',()=>{
 const inline={inline_keyboard:[[{text:'Сегодня',callback_data:'party_quick:primary:today'}]]};
 assert.equal(withTelegramMarkerMenu(inline,{mode:'paused',isOwner:true}),inline);
});
test('ordinary context.send renders current party keyboard even while owner quiz is paused',async()=>{
 let calls=[];
 setTelegramMilanaMarkerModeProvider(({chatId})=>chatId==='123456789'?'paused':null);
 try{
  const context=createTelegramContext({
   api:{sendMessage:async x=>{calls.push(x);return {message_id:18}}},
   message:{message_id:12,chat:{id:123456789,type:'private'},from:{id:123456789,first_name:'Owner'},text:'тусы сегодня'},
   botUser:{id:987000,username:'Gigorave_bot'},
   menuState:{menuPath:'parties',partyDisplayMode:'full'},ownerUserId:'123456789',
   resolvePeerId:()=>-90001,resolveUserId:()=>555,
  });
  await context.send('Сегодняшняя афиша');
  assert.equal(calls.length,1);
  assert.equal(calls[0].replyMarkup.keyboard[0][0].text,'▶️ Продолжить тест по словам-маркерам');
  assert(labels(calls[0].replyMarkup).includes('🍺 Второстепенные тусы'));
  assert(!labels(calls[0].replyMarkup).includes('🖼 Изображения'));
 }finally{setTelegramMilanaMarkerModeProvider(null)}
});
test('runtime routes response submenu and callback context through stored menu path',()=>{
 const src=readFileSync(new URL('../../src/platforms/telegram/telegramBot.js',import.meta.url),'utf8');
 assert.match(src,/menuResult.replyMarkup \?\? buildTelegramPrivateMenuForState\(menuResult.state/);
 assert.match(src,/menuState:dmMenuStates.get\(String\(callbackMessage.chat\?\.id/);
 assert.match(src,/const privateReplyMenu = withTelegramMarkerMenu\(/);
});
