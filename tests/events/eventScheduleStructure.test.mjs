import test from 'node:test';
import assert from 'node:assert/strict';
import { parseIndexedImageFacts, serializeIndexedImageFacts } from '../../src/features/events/eventPosterMatching.js';
import { validateSharedEventSchedule, validateScheduleCardinality, inspectDateProgramText, posterScheduleFactNeedsRefresh } from '../../src/features/events/sharedEventSchedule.js';
import { validatePublicAiEvents, setPublicAiResponseMetadata } from '../../src/features/events/publicPostLocalParser.js';
const publishedAt = Date.parse('2026-01-10T12:00:00Z')/1000;
const dates = ['2026-05-01','2026-05-31'];
const sharedEvent = {date:dates[0],title:'Программа',venue:'Бар',image_indexes:[1],schedule:{dateMode:'specific',startDate:dates[0],endDate:dates[1],dates}};
function fact(ocr,kind='',rows=[]){return {index:1,poster:true,dates:'1 и 31 мая',recognizedText:ocr,scheduleKind:kind,dateProgramBindings:rows};}
const mixedCases = [
 '31 мая — концерт группы Альфа\n1 мая — диджей Бета',
 '31 мая отмечаем выпускной, а 1 мая отмечаем открытие сезона.',
 '31 мая: концерт Альфа; 1 мая: концерт Бета.',
 '31.05 — рок-концерт, 01.05 — дискотека.',
 'В мае 31 мая играют Альфа, а 1 мая выступают Бета.',
 '1–31 мая — общая программа, 15 мая — отдельный концерт.',
 '1 мая — DJ Альфа | 31 мая — DJ Бета',
];
for(const text of mixedCases) {
 test('date-specific prose is not shared: '+text,()=>assert.equal(inspectDateProgramText(text).differentPrograms,true));
 test('shared validator vetoes differing programs: '+text,()=>assert.equal(validateSharedEventSchedule(sharedEvent,{sourceText:text,facts:[fact('1 и 31 мая — вечеринки')],publishedAt}).ok,false));
}
for(const text of ['1 мая — концерт Альфа\n31 мая — концерт Альфа','1 мая и 31 мая — концерт Альфа','1, 14 и 31 мая — общая программа','С 1 по 31 мая — одна программа каждый день']) {
 test('common program remains a shared candidate: '+text,()=>assert.equal(inspectDateProgramText(text).differentPrograms,false));
}
const rows=[
 {dateText:'1 мая',title:'Альфа',participants:'',program:'рок-концерт',evidence:'1 мая — Альфа: рок-концерт'},
 {dateText:'31 мая',title:'Бета',participants:'',program:'дискотека',evidence:'31 мая — Бета: дискотека'},
];
const raw='[IMAGE 1]\nЭто афиша события: да\nТип изображения: poster\nДата: 1 и 31 мая\nСтруктура расписания: distinct_events\nОснование расписания: 1 мая — Альфа: рок-концерт\nСвязи дат и программ: '+JSON.stringify(rows,null,2)+'\nРаспознанный текст:\n1 мая — Альфа: рок-концерт\n31 мая — Бета: дискотека\nПричина: разные мероприятия';
test('Vision parser retains multiline OCR and separate date-program bindings',()=>{
 const parsed=parseIndexedImageFacts(raw)[0];assert.match(parsed.recognizedText,/31 мая/);assert.doesNotMatch(parsed.recognizedText,/Причина/);
 assert.equal(parsed.scheduleKind,'distinct_events');assert.deepEqual(parsed.dateProgramBindings,rows);
 const roundTrip=parseIndexedImageFacts(serializeIndexedImageFacts([parsed]))[0];assert.deepEqual(roundTrip.dateProgramBindings,rows);assert.equal(roundTrip.recognizedText,parsed.recognizedText);
});
test('same picture with different date blocks cannot become a range',()=>assert.equal(validateSharedEventSchedule(sharedEvent,{sourceText:'Ждём вас в баре!',facts:parseIndexedImageFacts(raw),publishedAt}).ok,false));
test('legacy truncated OCR is recovered from durable raw Vision before checking structure',()=>{
 const legacy={...parseIndexedImageFacts(raw)[0],scheduleKind:'',dateProgramBindings:[],recognizedText:'1 мая — Альфа: рок-концерт'};
 assert.equal(validateSharedEventSchedule(sharedEvent,{sourceText:'Ждём вас!',facts:[legacy],publishedAt}).ok,false);
});
test('uncertain Vision layout blocks an automatic shared classification',()=>assert.equal(validateSharedEventSchedule(sharedEvent,{facts:[fact('1 и 31 мая — программа','uncertain')],publishedAt}).ok,false));
test('date/program JSON with different participants vetoes shared even if OCR was flattened',()=>{
 const f=fact('1 и 31 мая — концерты Альфа и Бета','shared_program',rows);
 assert.equal(validateSharedEventSchedule(sharedEvent,{facts:[f],publishedAt}).ok,false);
});
const multi = [{date:dates[0],title:'Альфа',venue:'Бар',image_indexes:[1]},{date:dates[1],title:'Бета',venue:'Бар',image_indexes:[1]}];
test('one poster can legitimately supply both independent events',()=>assert.equal(validateScheduleCardinality('multiple_events',multi,{facts:parseIndexedImageFacts(raw),publishedAt}).ok,true));
test('artists cannot be swapped across the dates of one poster',()=>assert.equal(validateScheduleCardinality('multiple_events',[{...multi[0],title:'Бета'},{...multi[1],title:'Альфа'}],{facts:parseIndexedImageFacts(raw),publishedAt}).ok,false));
test('public parser accepts multi with shared image and preserves per-date content',()=>{
 const input=setPublicAiResponseMetadata(multi.map((e,i)=>({...e,_structure:'multiple_events',source_segment:rows[i].evidence,announcement:rows[i].program})),{structure:'multiple_events',valid:true});
 const post={text:raw,__sourceAnnouncementText:'Наше расписание',__posterGateFacts:raw,__dateFreeVisionPhase:true,publishedAt};
 const result=validatePublicAiEvents(input,post);assert.equal(result.aiResponseValid,true,result.aiResponseError);assert.equal(result.length,2);assert.deepEqual(result.map(e=>e.title),['Альфа','Бета']);
 assert.equal(result[0].sourceSegment,rows[0].evidence);assert.equal(result[1].sourceSegment,rows[1].evidence);
});
const commonRaw='С 11 по 30 декабря. Программа: DJ и танцы каждый день.';
const common={index:1,poster:true,dates:'11–30 декабря',recognizedText:commonRaw,scheduleKind:'shared_program',scheduleEvidence:commonRaw,dateProgramBindings:[{dateText:'11–30 декабря',title:'',participants:'DJ',program:'танцы каждый день',evidence:commonRaw}]};
const twins=[{date:'2026-12-11',title:'DJ',image_indexes:[1]},{date:'2026-12-30',title:'DJ',image_indexes:[1]}];
test('a proven shared program is not split into daily duplicates',()=>assert.equal(validateScheduleCardinality('multiple_events',twins,{facts:[common],publishedAt}).ok,false));
test('different programs in text take precedence over an otherwise common poster',()=>assert.equal(validateScheduleCardinality('multiple_events',twins,{sourceText:'11 декабря — концерт Альфа, 30 декабря — дискотека Бета',facts:[common],publishedAt}).ok,true));
test('unsupported Vision assertion alone cannot force a merge',()=>assert.equal(validateScheduleCardinality('multiple_events',twins,{facts:[{...common,scheduleEvidence:'придуманная цитата'}],publishedAt}).ok,true));
test('confirmed real common schedule remains accepted',()=>{
 const e={date:'2026-12-11',schedule:{dateMode:'continuous',startDate:'2026-12-11',endDate:'2026-12-30',dates:[]}};
 assert.equal(validateSharedEventSchedule(e,{sourceText:'Приходите на одну общую праздничную программу',facts:[common],publishedAt}).ok,true);
});
test('malformed Vision JSON keeps raw OCR but never invents bindings',()=>{
 const parsed=parseIndexedImageFacts(raw.replace(JSON.stringify(rows,null,2),'[broken JSON]'))[0];assert.deepEqual(parsed.dateProgramBindings,[]);assert.match(parsed.recognizedText,/31 мая/);assert.equal(parsed.scheduleKind,'distinct_events');
});

test('date after the program is not mistaken for a common date list',()=>{
 assert.equal(inspectDateProgramText('Концерт Альфа — 1 мая; дискотека Бета — 31 мая').differentPrograms,true);
 assert.equal(inspectDateProgramText('Концерт Альфа — 1 мая и 31 мая').differentPrograms,false);
});
test('a shared label without corroborating bindings remains unresolved',()=>{
 const e={date:'2026-12-11',schedule:{dateMode:'continuous',startDate:'2026-12-11',endDate:'2026-12-30',dates:[]}};
 assert.equal(validateSharedEventSchedule(e,{facts:[{...common,dateProgramBindings:[]}],publishedAt}).ok,false);
});

test('old multi-date Vision cache is refreshed; complete evidence is reused',()=>{
 assert.equal(posterScheduleFactNeedsRefresh(fact('1 и 31 мая — концерты')),true);
 assert.equal(posterScheduleFactNeedsRefresh({...fact('1 мая — концерт'),dates:'1 мая'}),false);
 assert.equal(posterScheduleFactNeedsRefresh(parseIndexedImageFacts(raw)[0]),false);
 assert.equal(posterScheduleFactNeedsRefresh(common),false);
 assert.equal(posterScheduleFactNeedsRefresh({...common,scheduleKind:'uncertain'}),true);
});
test('new schedule fields do not leak into tags',()=>{
 const f=parseIndexedImageFacts(raw.replace('Структура расписания:', 'Теги: rock, dj\nСтруктура расписания:'))[0];
 assert.deepEqual(f.tags,['rock','dj']);
});
