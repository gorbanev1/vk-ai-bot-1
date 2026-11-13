
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {sourceContainsEvidence, normalizeEventEvidence, buildStrictEventExtractionPrompt} from '../../src/features/events/eventValidation.js';
import {setPublicAiResponseMetadata, validatePublicAiEvents} from '../../src/features/events/publicPostLocalParser.js';
const fixtures=JSON.parse(readFileSync(new URL('../fixtures/parserContracts20261026.json',import.meta.url),'utf8'));
for(const fixture of fixtures.slice(0,2)) test('archived valid response passes: '+fixture.source,()=>{
 const ai=setPublicAiResponseMetadata(structuredClone(fixture.response.events),{structure:fixture.response.structure,reason:fixture.response.structure_reason,valid:true});
 const post={text:fixture.body+'\n\n[Факты с афиши]\n'+fixture.vision,publishedAt:fixture.publishedAt,referenceNow:new Date('2026-10-26T16:41:45Z')};
 const validated=validatePublicAiEvents(ai,post);
 assert.equal(validated.length,1,JSON.stringify(validated.aiValidationFailures));
});
test('semicolon and array quote formats retain independent exact quotes',()=>{
 const source='Концерт Бутырки. 29 октября. В клубе Балаган.';
 for(const evidence of [['Концерт Бутырки','29 октября','В клубе Балаган'],'«Концерт Бутырки»; «29 октября»; «В клубе Балаган»'])
  assert.equal(sourceContainsEvidence(evidence,source),true);
});
test('all quotes must be real including a sixth quote and punctuation-only entries',()=>{
 const source='Концерт Бутырки. 29 октября. В клубе Балаган.';
 for(const evidence of [['Концерт Бутырки','30 октября'],['Концерт Бутырки',{}],['Концерт Бутырки','!!!'],'Концерт || Бутырки || 29 || октября || Балаган || выдумка'])
  assert.equal(sourceContainsEvidence(evidence,source),false);
 assert.equal(normalizeEventEvidence(['Концерт','']), '');
});
for(const confirmedPoster of [false,true]) test('calendar prompt shares validator dates, poster='+confirmedPoster,()=>{
 const prompt=buildStrictEventExtractionPrompt({referenceDate:'2026-10-26',sourceText:'Йорш. 01 ноября. Клуб 12.',publishedAt:0,confirmedPoster});
 assert.ok(prompt.includes('2026-11-01'));
 assert.ok(prompt.includes('отсутствие напечатанного года само по себе не означает uncertain'));
 assert.ok(prompt.includes('список не задаёт число карточек'));
});
test('past October poster is not shifted into the next year',()=>{
 const prompt=buildStrictEventExtractionPrompt({referenceDate:'2026-10-26',sourceText:'Tuesday 20th October',confirmedPoster:true});
 assert.ok(prompt.includes('2026-10-20'));
 assert.ok(!prompt.includes('2027-10-20'));
});
test('publication year and explicit year take precedence over current year',()=>{
 const prompt=buildStrictEventExtractionPrompt({referenceDate:'2026-10-26',sourceText:'October 31; November 1, 2024',publishedAt:Date.parse('2025-10-26T12:00:00Z')/1000});
 assert.ok(prompt.includes('2025-10-31'));
 assert.ok(prompt.includes('2024-11-01'));
});
test('December publication rolls January into the next year',()=>{
 const prompt=buildStrictEventExtractionPrompt({referenceDate:'2026-12-29',sourceText:'2 января',publishedAt:0});
 assert.ok(prompt.includes('2027-01-02'));
});
