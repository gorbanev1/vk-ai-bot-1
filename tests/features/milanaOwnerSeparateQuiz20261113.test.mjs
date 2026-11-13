import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,rmSync,existsSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createMilanaTenseMarkerService,routeTenseMarkerSession,MARKER_EXIT_BUTTON,MARKER_RESUME_BUTTON} from '../../src/features/education/milanaTenseMarkerService.js';
import {buildTelegramMilanaMarkerMenu,setTelegramMilanaMarkerModeProvider} from '../../src/platforms/telegram/telegramBot.js';
const user='120001111',owner='130002222';
const context=(id,message)=>({platform:'telegram',isDM:true,telegramChatType:'private',
 externalPeerId:id,externalSenderId:id,originalText:message,text:message,
 conversationMessageId:950,send:async()=>({message_id:951})});
test('owner and Milana commands route separately including status, theory, resume and reset',()=>{
 for(const cmd of ['слова маркеры времен','слова маркеры времен статус','слова маркеры времен теория','слова маркеры времен сброс','слова маркеры времен продолжить']){
  assert.equal(routeTenseMarkerSession(cmd,{isOwner:true})?.target,'owner',cmd);
 }
 for(const cmd of ['слова маркеры времен милане','милане слова маркеры времен','слова маркеры времен статус милане','слова маркеры времен милане статус','слова маркеры времен для миланы']){
  assert.equal(routeTenseMarkerSession(cmd,{isOwner:true})?.target,'milana',cmd);
 }
 assert.equal(routeTenseMarkerSession('слова маркеры времен',{isMilana:true})?.target,'milana');
 assert.equal(routeTenseMarkerSession('слова маркеры времен',{isOwner:false,isMilana:false}),null);
 assert.equal(routeTenseMarkerSession('слова маркеры времен',{isOwner:true,isPrivate:false}),null);
});
test('owner study starts independently; live Milana progress and 10 original messages are untouched',async()=>{
 const root=mkdtempSync(join(tmpdir(),'gig-marker-owner-'));try{
  mkdirSync(join(root,'data'),{recursive:true});mkdirSync(join(root,'Milana'),{recursive:true});
  writeFileSync(join(root,'data','telegram-reminders.json'),JSON.stringify({helpNudges:[{id:'test',chatId:user}]}),'utf8');
  const existingMilana={
   mode:'active',recipientChatId:user,everStarted:true,theoryIndex:9,
   active:{id:'TM006',questionMessageIds:[707],askedAt:'2026-11-13T09:00:00Z'},
   used:['TM001','TM002','TM003','TM004','TM005','TM006'],
   grades:[{id:'TM001',percent:95}],skips:[],lastError:'',nextRetryAt:0,
  };
  writeFileSync(join(root,'Milana','tense-markers-state.json'),JSON.stringify(existingMilana),'utf8');
  const posts=[],api={sendMessage:async p=>{posts.push(p);return{message_id:900+posts.length}}};
  const base={root,telegramApi:api,gradeAnswer:async()=>({percent:90,correct:'ok',mistakes:'none',advice:'be clear'}),clockNow:()=>new Date('2026-11-13T14:00:00Z'),autoStartDay:''};
  const milana=createMilanaTenseMarkerService({...base,buildKeyboard:mode=>buildTelegramMilanaMarkerMenu({mode,isOwner:false})});
  const ownerFile=join(root,'data','tense-markers-owner-state.json');
  const self=createMilanaTenseMarkerService({...base,recipientChatId:owner,progressFile:ownerFile,
    sessionLabel:'личный тест владельца',buildKeyboard:mode=>buildTelegramMilanaMarkerMenu({mode,isOwner:true})});
  assert.equal(milana.snapshot().active.id,'TM006');
  assert.equal(milana.snapshot().grades.length,1);
  assert.equal(self.mode(),'idle');
  const markerRoute=routeTenseMarkerSession('слова маркеры времен',{isOwner:true});
  assert.equal(markerRoute.target,'owner');
  await self.handleMessage(context(owner,'слова маркеры времен'),{isOwner:true});
  assert.equal(self.mode(),'active');
  assert.equal(self.snapshot().theoryIndex,9);
  assert.equal(self.snapshot().active.id,'TM001');
  assert.equal(posts.length,10);
  assert(posts.every(p=>String(p.chatId)===owner),'No lesson text goes to Milana when owner starts');
  assert(existsSync(ownerFile));
  assert.equal(milana.snapshot().active.id,'TM006');
  assert.equal(readFileSync(join(root,'Milana','tense-markers-state.json'),'utf8'),JSON.stringify(existingMilana),'Milana state untouched byte for byte');
  setTelegramMilanaMarkerModeProvider(({chatId,userId})=>{
   if(self.isMilanaIds(chatId,userId))return self.mode();
   if(milana.isMilanaIds(chatId,userId))return milana.mode();
   return null;
  });
  const oldOwner=buildTelegramMilanaMarkerMenu({mode:'idle',isOwner:true});
  const ownerMenu=buildTelegramMilanaMarkerMenu({mode:self.mode(),isOwner:true});
  const milanaMenu=buildTelegramMilanaMarkerMenu({mode:milana.mode(),isOwner:false});
  assert.deepEqual(ownerMenu.keyboard.slice(1),oldOwner.keyboard,'Owner standard keyboard unchanged');
  assert.equal(ownerMenu.keyboard[0][0].text,MARKER_EXIT_BUTTON);
  assert.equal(milanaMenu.keyboard[0][0].text,MARKER_EXIT_BUTTON);
  assert.notDeepEqual(ownerMenu.keyboard.slice(1),milanaMenu.keyboard.slice(1),'Owner and child keep their own original menus');
  await self.handleMessage(context(owner,MARKER_EXIT_BUTTON),{isOwner:true});
  assert.equal(self.mode(),'paused');assert.equal(milana.mode(),'active');
  assert.equal(self.snapshot().active.id,'TM001');
  assert.equal(posts.at(-1).replyMarkup.keyboard[0][0].text,MARKER_RESUME_BUTTON);
  await self.handleMessage(context(owner,MARKER_RESUME_BUTTON),{isOwner:true});
  assert.equal(self.mode(),'active');assert.equal(milana.snapshot().active.id,'TM006');
  const reloaded=createMilanaTenseMarkerService({...base,recipientChatId:owner,progressFile:ownerFile,
    sessionLabel:'личный тест владельца',buildKeyboard:mode=>buildTelegramMilanaMarkerMenu({mode,isOwner:true})});
  assert.equal(reloaded.mode(),'active');assert.equal(reloaded.snapshot().active.id,'TM001');
  assert.equal(reloaded.snapshot().theoryIndex,9,'No repeated theory after restart');
  assert.equal(milana.snapshot().grades.length,1);
  setTelegramMilanaMarkerModeProvider(null);
 }finally{rmSync(root,{recursive:true,force:true})}
});
test('owner inline answers are accepted only in their own quiz, not Milana quiz',async()=>{
 const root=mkdtempSync(join(tmpdir(),'gig-marker-callback-'));
 try{
  mkdirSync(join(root,'data'),{recursive:true});
  writeFileSync(join(root,'data','telegram-reminders.json'),JSON.stringify({helpNudges:[{id:'test',chatId:user}]}),'utf8');
  const sent=[],api={sendMessage:async x=>{sent.push(x);return{message_id:1700+sent.length}}};
  const service=createMilanaTenseMarkerService({root,telegramApi:api,recipientChatId:owner,progressFile:join(root,'data','owner.json'),
    clockNow:()=>new Date('2026-11-13T14:00:00Z'),autoStartDay:'',
    buildKeyboard:mode=>buildTelegramMilanaMarkerMenu({mode,isOwner:true}),
    gradeAnswer:async()=>({percent:80,correct:'result now',mistakes:'none',advice:'Present Perfect'})});
  await service.handleMessage(context(owner,'слова маркеры времен'),{isOwner:true});
  const chosen=service.snapshot().active;
  assert.equal(chosen.id,'TM001');
  let replies=0;
  const callback=(id)=>({...context(id,''),callbackQuery:{data:'tmq:TM001:1',message:{message_id:chosen.questionMessageIds[0]}},answerCallbackQuery:async()=>{replies++}});
  await service.handleCallback(callback(user));
  assert.equal(service.snapshot().grades.length,0);
  await service.handleCallback(callback(owner));
  assert.equal(service.snapshot().grades.length,1);
  assert.equal(service.snapshot().grades[0].percent,100);
  assert.equal(service.snapshot().active.id,'TM002');
 }finally{rmSync(root,{recursive:true,force:true})}
});
