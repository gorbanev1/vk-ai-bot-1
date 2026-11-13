import test from 'node:test';import assert from 'node:assert/strict';
import {manualPosterEvents,manualPosterHint} from '../../src/features/events/manualPosterMultiplicity.js';
import {normalizeEventProposalDraftEvent} from '../../src/features/events/eventProposalWorkflow.js';
test('one poster preserves both independent evenings through draft normalization',()=>{
 const events=manualPosterEvents({structure:'multiple_events',events:[
 {title:"GOTHIC HALLOWEEN'26",date:'2026-10-29',time:'19:00',venue:'The Last of Vavilone'},
 {title:'Ночная смена — Тыквенный Спас',date:'2026-10-30',time:null,venue:'Тупик'},
 ]}).map(normalizeEventProposalDraftEvent);
 assert.equal(events.length,2);assert.equal(events[1].eventDate,'2026-10-30');
 assert.equal(events[1].eventTime,null);assert.ok(events.every(x=>x.isMultiAnnouncement));
 assert.deepEqual(manualPosterHint(events[1],[{date:'2026-10-29',time:'19:00'}],2),{});
});
test('identical program range remains one schedule; program remains one event',()=>{
 for(const structure of ['shared_schedule_event','single_event_program']){
 const result=manualPosterEvents({structure,events:[{date:'2026-12-11',event_end_date:'2026-12-30',event_schedule:{excludedDates:['2026-12-28']}}]});
 assert.equal(result.length,1);assert.equal(result[0].structureDecision,structure);
 assert.equal(result[0].event_end_date,'2026-12-30');assert.equal(result[0].isMultiAnnouncement,false);
 }
});
test('legacy singular response supported; uncertainty never manufactures cards',()=>{
 assert.equal(manualPosterEvents({event:{title:'single'}}).length,1);
 assert.deepEqual(manualPosterEvents({structure:'uncertain',events:[{}]}),[]);
});

test('manual multi-announcement preserves full post for existing platform budget editor',async()=>{
 const {getOriginalEventAnnouncement,prepareEventAnnouncementCopies,configureEventAnnouncementCopies,selectEventAnnouncement}=await import('../../src/features/events/eventAnnouncementCopies.js');
 const full='29 октября — концерт в Вавилоне.\n30 октября — Ночная смена в Тупике.';
 const events=manualPosterEvents({structure:'multiple_events',events:[{date:'2026-10-29'},{date:'2026-10-30'}]})
  .map(event=>({...event,sourceType:'manual',sourceText:full,description:'AI shortened',sourceSegment:'One day only'}));
 configureEventAnnouncementCopies({});
 const prepared=await prepareEventAnnouncementCopies(events);
 assert.ok(prepared.every(event=>event.description===full));
 assert.equal(getOriginalEventAnnouncement({...prepared[1],originalAnnouncement:undefined}),full);
 assert.equal(selectEventAnnouncement(prepared[0],'telegram'),full);
 assert.equal(getOriginalEventAnnouncement({...events[0],sourceType:'vk'}),'One day only');
});

test('production manual Vision extractor retains both cards and never copies first-day time',async()=>{
 const {readFileSync}=await import('node:fs');
 const app=readFileSync('src/app/botApplication.js','utf8');
 const start=app.indexOf('async function extractStrictManualEventWithPosterVision(');
 const end=app.indexOf('async function extractPosterAnchoredManualEvents(',start);
 const body=app.slice(start,end);
 const source='29 октября — LIVE part, Вавилон, 19:00.\n30 октября — Ночная смена, Тупик.';
 let request;
 const dependencies={
  getLocalDateString:()=> '2026-10-28',botTimeZone:'Europe/Moscow',
  parsePublicPostLocally:()=>[{title:'GOTHIC HALLOWEEN',eventDate:'2026-10-29',eventTime:'19:00',venue:'Вавилон'}],
  eventSourceScreenName:()=> 'gothic',
  generateOpenAIVisionText:async input=>{
   request=input;
   return JSON.stringify({structure:'multiple_events',structure_reason:'Разные программы и площадки',
    events:[
     {title:'GOTHIC HALLOWEEN',date:'2026-10-29',time:'19:00',venue:'Вавилон',source_segment:'29 октября — LIVE part, Вавилон, 19:00.'},
     {title:'Ночная смена',date:'2026-10-30',time:null,venue:'Тупик',source_segment:'30 октября — Ночная смена, Тупик.'},
    ]});
  },
  buildStrictEventExtractionPrompt:()=> 'structure contract',
  SHARED_SCHEDULE_INSTRUCTION:'shared schedule contract',
  buildEventTitleContractPrompt:()=>'',formatEventTagPromptInstruction:()=>'',
  EVENT_PROPOSAL_AI_TIMEOUT_MS:60000,EVENT_PARSER_AI_ATTEMPT_TIMEOUT_MS:60000,
  clampInteger:(value,min,max,fallback)=>Math.max(min,Math.min(max,Number(value)||fallback)),
  parseJsonObjectFromText:JSON.parse,normalizeEventProposalDraftEvent,
  stripEventServiceArtifacts:value=>value,manualPosterEvents,manualPosterHint,
 };
 const extract=new Function(...Object.keys(dependencies),'return '+body)(...Object.values(dependencies));
 const result=await extract({imageUrl:'https://example.test/poster.jpg',selectedPost:{text:source},sourceUrl:'https://vk.ru/wall-241222845_22'});
 assert.equal(result.draftEvents.length,2);
 assert.deepEqual(result.draftEvents.map(e=>e.eventDate),['2026-10-29','2026-10-30']);
 assert.equal(result.draftEvents[1].eventTime,null);
 assert.equal(result.draftEvents[1].sourceSegmentText,'30 октября — Ночная смена, Тупик.');
 assert.equal(result.draftEvents[1].sourceText,source);
 assert.equal(request.requestTimeoutMs,60000);
 assert.ok(!request.systemPrompt.includes('РОВНО ОДНО'));
});
