import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';import{join}from'node:path';
import {inspectTelegramPublicPostMedia} from '../../src/platforms/telegram/telegramPostMedia.js';
import {downloadTelegramPostVideo,prepareTelegramEventVideo,getTelegramEventVideo,captureTelegramVideoPost} from '../../src/platforms/telegram/telegramEventVideo.js';
import {TelegramBotApi,createTelegramContext} from '../../src/platforms/telegram/telegramBot.js';
import {isBroadcastEvent,isBroadcastOnlyAnnouncement} from '../../src/features/events/eventBroadcastPolicy.js';
import {explainStrictEventRecord} from '../../src/features/events/eventValidation.js';
import {explainEventAiAdmissionWithPosterFacts} from '../../src/features/events/eventAiAdmission.js';
function directory(t){const d=mkdtempSync(join(tmpdir(),'tg-event-video-'));t.after(()=>rmSync(d,{recursive:true,force:true}));return d;}
const bytes=()=>{const b=Buffer.alloc(128);b.write('ftyp',4,'ascii');return b;};
const url='https://cdn4.telesco.pe/file/event.mp4';
const sourceUrl='https://t.me/nnrravew/530';
test('animated emoji is not a video attachment; blurred duplicate player collapses',()=>{
 const emoji='<video src="https://cdn4.telesco.pe/file/emoji.webm"></video>';
 const wrapper=body=>'<div class="tgme_widget_message"><div class="tgme_widget_message_text">'+body+'</div></div>';
 assert.equal(inspectTelegramPublicPostMedia(wrapper(emoji)).hasVideo,false);
 const video='<video class="tgme_widget_message_video" src="'+url+'"></video>';
 const media=inspectTelegramPublicPostMedia(wrapper(emoji+video+video));
 assert.deepEqual(media.videoUrls,[url]);assert.equal(media.hasVideo,true);
});
test('hidden unsupported template does not trigger web; explicit oversized media does',()=>{
 const label='<div class="message_media_not_supported_label">This media is not supported in your browser</div>';
 assert.equal(inspectTelegramPublicPostMedia('<video src="'+url+'"></video>'+label).mediaUnavailableReason,'');
 assert.equal(inspectTelegramPublicPostMedia(label).mediaUnavailableReason,'browser-unsupported');
 assert.equal(inspectTelegramPublicPostMedia(label.replace('This media is not supported in your browser','Media is too big')).mediaUnavailableReason,'too-big');
});
test('MP4 streaming download validates full body, rejects large/partial/html payloads',async t=>{
 const d=directory(t);
 const result=await downloadTelegramPostVideo(url,{directory:d,fetchImpl:async()=>new Response(bytes(),{headers:{'content-type':'video/mp4','content-length':'128'}})});
 assert.deepEqual(readFileSync(join(d,result.file)),bytes());
 for(const response of [
  new Response(bytes(),{status:206,headers:{'content-type':'video/mp4'}}),
  new Response('error',{headers:{'content-type':'text/html'}}),
  new Response(bytes(),{headers:{'content-type':'video/mp4','content-length':String(51*1024*1024)}}),
  new Response(bytes(),{headers:{'content-type':'video/mp4','content-length':'129'}})
 ])await assert.rejects(downloadTelegramPostVideo(url,{directory:d,fetchImpl:async()=>response}));
});
test('video attaches only to validated exact event, survives reread, and missing venue never downloads',async t=>{
 const d=directory(t),event={title:'NO NAME RAVE',eventDate:'2026-12-05',venue:'ул. Кирова, 5',sourceUrl};
 let calls=0;
 const download=(u,{directory})=>{calls++;return downloadTelegramPostVideo(u,{directory,fetchImpl:async()=>new Response(bytes(),{headers:{'content-type':'video/mp4'}})});};
 const post={sourceUrl,hasVideo:true,hasPhoto:false,videoUrls:[url]};
 assert.equal(await prepareTelegramEventVideo(post,[{...event,venue:''}],{dataDirectory:d,download}),null);assert.equal(calls,0);
 const attachment=await prepareTelegramEventVideo(post,[event],{dataDirectory:d,download});
 assert.equal(attachment.type,'video');assert.equal(calls,1);
 assert.equal(getTelegramEventVideo(event,{dataDirectory:d}).fileSize,128);
 assert.equal(getTelegramEventVideo({...event,eventDate:'2027-12-05'},{dataDirectory:d}),null);
 await prepareTelegramEventVideo(post,[event],{dataDirectory:d,download});assert.equal(calls,1);
});
test('sendVideo uses multipart, caption, reply, topic and keyboard',async()=>{
 let method,form;
 const result=await TelegramBotApi.prototype.sendVideo.call({call:async(m,f)=>{method=m;form=f;return {message_id:44};}},
 {chatId:123,video:{buffer:bytes()},caption:'Анонс',messageThreadId:5,replyToMessageId:33,replyMarkup:{inline_keyboard:[]}});
 assert.equal(method,'sendVideo');assert.equal(form.get('video').size,128);assert.equal(form.get('caption'),'Анонс');
 assert.equal(JSON.parse(form.get('reply_parameters')).message_id,33);assert.equal(form.get('message_thread_id'),'5');assert.equal(result.message_id,44);
});
test('context sends video with existing caption and long-card reply handling',async()=>{
 const sent=[];
 const context=createTelegramContext({api:{
  sendChatAction:async()=>{},sendVideo:async args=>{sent.push(['video',args]);return {message_id:10};},
  sendMessage:async args=>{sent.push(['text',args]);return {message_id:11};}},
  message:{message_id:7,chat:{id:123,type:'private'},from:{id:99,first_name:'Tester'}},
  botUser:{id:456,username:'test_bot'},resolveUserId:()=>99,resolvePeerId:()=>123});
 await context.send({message:'a'.repeat(1500),html:'a'.repeat(1500),attachment:{platform:'telegram',type:'video',buffer:bytes()}});
 assert.equal(sent[0][0],'video');assert.equal(sent[1][0],'text');assert.equal(sent[1][1].replyToMessageId,10);
});
test('broadcasts rejected in text, trusted Vision and final records; cinema and mixed concerts kept',()=>{
 for(const title of ['Трансляция матча','Трансляция концерта','Прямой эфир'])assert.equal(isBroadcastEvent({title}),true);
 assert.equal(isBroadcastEvent({title:'АЗ Алкмар — Ювентус',venue:'О’Хара ирландский паб',description:'Лига Европы УЕФА'}),true);
 assert.equal(isBroadcastEvent({title:'Кинопоказ «Начало»',description:'Показ фильма'}),false);
 assert.equal(isBroadcastEvent({title:'Кавер-группа СОК',description:'Концерт и трансляции матчей в другие дни'}),false);
 assert.equal(isBroadcastOnlyAnnouncement('Концерт 7 ноября. Трансляции матчей 8 ноября.'),false);
 assert.equal(isBroadcastOnlyAnnouncement('Трансляции не будет. Концерт 7 ноября.'),false);
 assert.equal(explainStrictEventRecord({title:'Трансляция концерта',eventDate:'2026-12-05',venue:'Бар X'},{trustedPosterEvent:true}).reason,'broadcast-not-event');
 const gate=explainEventAiAdmissionWithPosterFacts({text:'Трансляция матча 5 декабря в пабе',posterFacts:'Это афиша события: да\nНазвание: Трансляция матча\nДата: 5 декабря',dateFreePhase:true,referenceNow:new Date('2026-11-05')});
 assert.equal(gate.eligible,false);assert.equal(gate.rejectionReason,'broadcast-not-event');
});
test('web fallback inspects exact captured message without scroll and respects original tab lifetime',async()=>{
 const navigations=[];let min=0,closed=0,scans=0;
 const node={count:async()=>1,evaluate:async()=>({html:'<div class="message_media_not_supported_label">Media is too big</div>',visibleError:'Media is too big'}),locator:()=>({evaluateAll:async()=>[url]})};
 const page={frames:()=>[{locator:()=>({first:()=>node})}],isClosed:()=>false,close:async()=>{closed++;},
 goto:async u=>navigations.push(u),
 locator:selector=>selector==='a[href]'?{evaluateAll:async()=>[{text:'Open in Web',href:'https://web.telegram.org/k/#@nnrravew/530'}]}:selector==='body'?{innerText:async()=> 'Channel message'}:{first:()=>{scans++;return node;}}};
 const result=await captureTelegramVideoPost({sourceUrl,channel:'nnrravew',messageId:530,hasVideo:true,mediaUnavailableReason:'too-big'},
 {openTab:async options=>{min=options.minimumOpenMs;return page;},sleep:async()=>{}});
 assert.deepEqual(navigations,['https://web.telegram.org/k/#@nnrravew/530']);assert.deepEqual(result.videoUrls,[url]);assert.equal(min,180000);assert.equal(closed,1);assert.equal(scans,1);
});

test('onsite performance is kept when the source mentions a live stream',()=>{
 assert.equal(isBroadcastEvent({title:'Праздник урожая: интерактивный перформанс',venue:'Башня, Кольцовская 24К',description:'Трапеза и перформанс. Варим варенье в прямом эфире.'}),false);
 assert.equal(isBroadcastOnlyAnnouncement('Перформанс 20 сентября в Башне. Варим варенье в прямом эфире.'),false);
 assert.equal(isBroadcastEvent({title:'Афиша Сентябрь; Матчи Факела в прямом эфире',description:'26 сентября — кавер-группа СОК. Матчи в другие дни.'}),false);
});
test('expired CDN URL is refreshed once through its source post',async t=>{
 const d=directory(t);
 const event={title:'NO NAME RAVE',eventDate:'2026-12-05',venue:'Кирова, 5',sourceUrl};
 const post={channel:'nnrravew',messageId:530,sourceUrl,hasVideo:true,videoUrls:[url]};
 let captures=0,downloads=0;
 const result=await prepareTelegramEventVideo(post,[event],{dataDirectory:d,
  capture:async p=>{captures++;return {...p,videoUrls:[url+'?fresh=1'],videoRecoveryStatus:'public-post-captured'};},
  download:async (u,options)=>{downloads++;if(u===url)throw Error('expired');return downloadTelegramPostVideo(u,{...options,fetchImpl:async()=>new Response(bytes(),{headers:{'content-type':'video/mp4'}})});}
 });
 assert.equal(captures,1);assert.equal(downloads,2);assert.ok(result);
});

test('all display pools and both formats exclude broadcasts before tag filtering',async()=>{
 const {default:vm}=await import('node:vm');
 const app=readFileSync(new URL('../../src/app/botApplication.js',import.meta.url),'utf8');
 const from=app.indexOf('async function selectEventsForSearchFilters('),to=app.indexOf('async function selectAllPartyCandidatesForRange(',from);
 assert.ok(from>=0&&to>from);
 const choose=vm.runInNewContext(app.slice(from,to)+'\nselectEventsForSearchFilters',{isBroadcastEvent});
 for(const partyPool of ['primary','secondary','qtickets']){
  const rows=[{id:1,title:'Трансляция матча',partyPool},{id:2,title:'Кинопоказ «Начало»',partyPool},{id:3,title:'Концерт группы',partyPool}];
  assert.deepEqual(Array.from(await choose(rows),e=>e.id),[2,3]);
 }
 assert.equal(isBroadcastEvent({title:'Футбольный матч',venue:'Стадион Динамо, Барнаул'}),false);
});
