import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {stripKnownVenueNamesFromEventTitle as cleanTitle} from '../../src/features/events/eventVenueInference.js';
import {mergeDuplicateEvents,selectBestPosterCandidateForEvent,buildConfirmedEventMergeAiPayload} from '../../src/features/events/eventDuplicateResolution.js';
import {parseIndexedImageFacts,serializeIndexedImageFacts,selectBestCompatiblePosterFact} from '../../src/features/events/eventPosterMatching.js';
import {buildPosterVisionContext,normalizePosterRole,POSTER_CONTEXT_VISION_INSTRUCTION} from '../../src/features/events/eventPosterRole.js';
import {getEventPosterSafetyAssessment} from '../../src/features/events/eventProvenance.js';
const fixture=JSON.parse(readFileSync(new URL('../fixtures/noname-poster-20261105.json',import.meta.url),'utf8'));
const [overview,overview2,artist,artist2]=fixture.sourceCards;
const path=overview.imagePaths[0];
function permutations(xs){return xs.length?xs.flatMap((x,i)=>permutations(xs.filter((_,j)=>i!==j)).map(t=>[x,...t])):[[]];}
test('brand words survive title cleaning while isolated location and venue are removed',()=>{
 for(const name of ['NO NAME RAVE x VRN PROD','VRN PROD','VRN-PROD','Воронеж в огне','NO NAME RAVE × VRN'])assert.equal(cleanTitle(name),name);
 assert.equal(cleanTitle('STONEHAND (ВОРОНЕЖ) DIESEL HALL'),'STONEHAND');
 assert.equal(cleanTitle('STONEHAND ВОРОНЕЖ'),'STONEHAND');
});
test('real archived candidates are valid and overview wins every order and repeated merge',()=>{
 for(const row of fixture.sourceCards)assert.equal(getEventPosterSafetyAssessment(row).accepted,true);
 for(const order of permutations(fixture.sourceCards)){
  let merged=order.reduce((a,b)=>mergeDuplicateEvents(a,b));
  assert.match(merged.title,/NO NAME RAVE [x×] VRN PROD/iu);
  assert.equal(merged.imagePaths[0],path);
  merged=mergeDuplicateEvents(merged,artist);
  assert.equal(merged.imagePaths[0],path);
  assert.equal(getEventPosterSafetyAssessment(merged).accepted,true);
 }
 const repaired=mergeDuplicateEvents(fixture.stored,overview);
 assert.match(repaired.title,/VRN PROD/iu);assert.equal(repaired.imagePaths[0],path);
});
test('AI selectedImagePath cannot replace the full lineup with an artist portrait',()=>{
 const merged=mergeDuplicateEvents(overview,artist);
 const candidates=buildConfirmedEventMergeAiPayload([overview,artist],merged).posterCandidates;
 assert.equal(selectBestPosterCandidateForEvent(merged,candidates,{requestedPath:artist.imagePaths[0]}).candidate.path,path);
});
test('unbound image cannot gain overview priority',()=>{
 const merged=mergeDuplicateEvents(overview,artist);
 const candidates=buildConfirmedEventMergeAiPayload([overview,artist],merged).posterCandidates;
 const invalid=candidates.map(c=>c.path===path?{...c,posterFact:{...c.posterFact,imagePath:'foreign/not-this-file.jpg'}}:c);
 assert.equal(selectBestPosterCandidateForEvent(merged,invalid).candidate.path,artist.imagePaths[0]);
});
test('Vision role survives fact roundtrip and one-artist solo concert is an overview',()=>{
 const wire='[IMAGE 1]\nТип изображения: poster\nЭто афиша события: да\nНазвание: Сольный концерт\nДата: 05.12.2026\nУчастники: Артист\nРоль афиши: event_overview\nОснование роли на изображении: Сольный концерт\nОснование роли в тексте: Сольный концерт артиста\nПолнота программы: full\nРаспознанный текст: Сольный концерт\nПричина: Афиша всего сольного концерта';
 const facts=parseIndexedImageFacts(wire),round=parseIndexedImageFacts(serializeIndexedImageFacts(facts));
 assert.equal(round[0].posterRole,'event_overview');assert.equal(round[0].participants,'Артист');
 assert.equal(normalizePosterRole('something'),'uncertain');
 const legacy={...overview.posterVisionFacts[0],posterRole:'event_overview',posterRoleImageEvidence:'Общий лайн-ап',posterRoleTextEvidence:''};
 assert.equal(parseIndexedImageFacts(serializeIndexedImageFacts([legacy]))[0].posterRole,'event_overview');
});
test('one post with several images uses the whole-event poster rather than the preferred spotlight',()=>{
 const main={...overview.posterVisionFacts[0],index:2,posterRole:'event_overview',posterRoleImageEvidence:'Общий лайн-ап'};
 const spot={...artist.posterVisionFacts[0],index:1,posterRole:'participant_spotlight',posterRoleTextEvidence:'Сегодня начинаем знакомить вас с артистами'};
 const result=selectBestCompatiblePosterFact(overview,[spot,main],{preferredIndex:1});
 assert.equal(result.fact.index,2);assert.equal(result.ambiguous,false);
});
test('context is sent in primary/secondary/date-free Vision path; typography corrections keep their provenance',()=>{
 const context=buildPosterVisionContext('5 декабря встречаемся в клубе 12');
 assert.ok(context.includes('клубе 12'));
 const facts=parseIndexedImageFacts('[IMAGE 1]\nТип изображения: poster\nЭто афиша события: да\nМесто: Клуб 12\nУточнения по тексту: [{"field":"venue","imageReading":"2 или 72","resolvedValue":"Клуб 12","sourceQuote":"в клубе 12"}]\nРаспознанный текст: [неоднозначный логотип]\nПричина: Уточнено по посту');
 assert.equal(facts[0].venue,'Клуб 12');assert.equal(facts[0].contextCorrections[0].sourceQuote,'в клубе 12');
 assert.equal(facts[0].recognizedText.includes('Клуб 12'),false);
 assert.ok(POSTER_CONTEXT_VISION_INSTRUCTION.includes('Нельзя механически заменять'));
 const app=readFileSync(new URL('../../src/app/botApplication.js',import.meta.url),'utf8');
 assert.ok(app.includes('userPrompt += buildPosterVisionContext(sourceText);'));
});

test('poster role cache is bound to its source text and survives serialization', async()=>{
 const {stampPosterContext,posterContextMatches}=await import('../../src/features/events/eventPosterRole.js');
 const text='5 декабря — сольный концерт в клубе 12';
 const wire=stampPosterContext('[IMAGE 1]\nТип изображения: poster\nРоль афиши: event_overview\nОснование роли на изображении: сольный концерт\nРаспознанный текст: Артист',text);
 const fact=parseIndexedImageFacts(wire)[0];
 assert.equal(posterContextMatches(fact,text),true);
 assert.equal(posterContextMatches(fact,'Представляем участника фестиваля'),false);
 assert.equal(posterContextMatches(fact,'  '+text.replaceAll(' ','  ')+' '),true);
 assert.equal(posterContextMatches(parseIndexedImageFacts(serializeIndexedImageFacts([fact]))[0],text),true);
 assert.equal(posterContextMatches({posterRole:'event_overview'},text),false);
});
