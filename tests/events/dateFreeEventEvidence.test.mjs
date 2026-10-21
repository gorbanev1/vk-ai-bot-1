import test from 'node:test';
import assert from 'node:assert/strict';
import { acceptedDateFreePoster, storedEventDateSupported } from '../../src/features/events/dateFreeEventEvidence.js';
import { setPublicAiResponseMetadata, validatePublicAiEvents } from '../../src/features/events/publicPostLocalParser.js';
import { assignEventImageIndexesFromFacts, evaluatePosterFactForEvent, parseIndexedImageFacts } from '../../src/features/events/eventPosterMatching.js';
import { getParserPosterGateImage } from '../../src/features/scrapers/parserAllRecovery.js';
import { explainEventAiAdmissionWithPosterFacts } from '../../src/features/events/eventAiAdmission.js';
import { buildStrictEventExtractionPrompt } from '../../src/features/events/eventValidation.js';

const facts = '[IMAGE 1]\nТип изображения: poster\nЭто афиша события: да\nУверенность афиши: 98\nНазвание: RammPage\nДата: 24/10/2026\nМесто: Rock Bar\nРаспознанный текст: RammPage 24/10/2026 Rock Bar';
const body = 'Для брони звоните нам. На кухне новое меню.';
const post = { __dateFreeVisionPhase: true, __posterGateFacts: facts, __sourceAnnouncementText: body, text: `${body}\n${facts}`, publishedAt: 1791800000 };
const ai = () => setPublicAiResponseMetadata([{ date: '2026-10-24', title: 'RammPage', venue: 'Rock Bar', evidence: 'составленные моделью данные', image_indexes: [1] }], { structure: 'single_event', valid: true });

test('phase two accepts poster metadata without a matching body or verbatim evidence', () => {
    assert.equal(acceptedDateFreePoster(post), true);
    const events = validatePublicAiEvents(ai(), post);
    assert.equal(events.length, 1);
    assert.equal(events[0].description, body);
    assert.equal(events[0].eventDate, '2026-10-24');
    assert.equal(validatePublicAiEvents(ai(), { ...post, __dateFreeVisionPhase: false }).length, 0);
    assert.equal(validatePublicAiEvents(ai(), { ...post, __posterGateFacts: facts.replace('события: да', 'события: нет') }).length, 0);
});

test('a confirmed poster enters extraction even when its date or title must be completed later', () => {
    const result = explainEventAiAdmissionWithPosterFacts({ text: 'Фотоотчёт за 1 января 2000', posterFacts: '[IMAGE 1]\nЭто афиша события: да\nТип изображения: poster', dateFreePhase: true });
    assert.equal(result.eligible, true);
    assert.equal(result.admissionPath, 'date-free-confirmed-poster');
});

test('phase two poster binding survives independent title composition and persisted read', () => {
    const events = validatePublicAiEvents(ai(), post);
    const [event] = assignEventImageIndexesFromFacts([{ ...events[0], title: 'Rammstein tribute RammPage' }], facts, { dateFreePhase: true });
    assert.equal(event.posterImageIndex, 1);
    assert.equal(evaluatePosterFactForEvent(event, event.posterVisionFacts[0]).accepted, true);
    assert.equal(storedEventDateSupported(event, { sourceText: body }), true);
    assert.equal(storedEventDateSupported({ ...event, eventDate: '2027-10-24' }, { sourceText: body }), false);
});

test('listing uses a confirmed poster date while rejecting ordinary photos and wrong years', () => {
    const event = { title: 'RammPage', eventDate: '2026-10-24', venue: 'Rock Bar' };
    const source = { sourceText: body, publishedAt: 1791800000, imageVisionFacts: [{ poster: true, imageType: 'poster', title: 'RammPage', dates: '24 октября 2026' }] };
    assert.equal(storedEventDateSupported(event, source), true);
    assert.equal(storedEventDateSupported({ ...event, eventDate: '2027-10-24' }, source), false);
    assert.equal(storedEventDateSupported(event, { ...source, imageVisionFacts: [{ poster: false, dates: '24 октября 2026' }] }), false);
});

test('phase two still requires a real calendar date and phase one retains its contract', () => {
    const invalid = ai(); invalid[0].date = '2026-02-30';
    assert.equal(validatePublicAiEvents(invalid, post).length, 0);
    assert.match(buildStrictEventExtractionPrompt(), /подтверждено текстом/u);
    assert.doesNotMatch(buildStrictEventExtractionPrompt({ confirmedPoster: true }), /каждое.*подтверждено текстом/u);
});

test('monthly poster metadata retains every date and artist separated by semicolons', () => {
    const [fact] = parseIndexedImageFacts('[IMAGE 1]\nТип изображения: poster\nЭто афиша события: да\nДата: 15 октября; 16 октября; 17 октября\nУчастники: Илья Алексин; Литера; ДискоКаверС\nРаспознанный текст: 15 октября — Илья Алексин; 16 октября — Литера; 17 октября — ДискоКаверС');
    assert.match(fact.dates, /17 октября/u);
    assert.match(fact.participants, /ДискоКаверС/u);
    assert.match(fact.recognizedText, /17 октября — ДискоКаверС/u);
    assert.match(buildStrictEventExtractionPrompt({confirmedPoster:true}), /Месячное расписание.*multiple_events/u);
});

test('recovery refreshes old joint-gate negatives but keeps successful poster facts', () => {
    const request={sourceId:'vk:test',itemId:'1',sourceUrl:'url',visionPhase:'phase2-date-free-image',sourceText:'body'};
    const key=['vk:test','1','1','image'].join(String.fromCharCode(0));
    const saved={sourceUrl:'url',dateFreePhase:true,secondaryJointGate:false,semanticBodyText:'body',responseText:'Это афиша события: нет'};
    const images=new Map([[key,saved]]);
    assert.equal(getParserPosterGateImage(images,request,1,'image'),'');
    saved.responseText='Это афиша события: да';
    assert.equal(getParserPosterGateImage(images,request,1,'image'),saved.responseText);
    saved.posterGatePolicyVersion=2; saved.responseText='Это афиша события: нет';
    assert.equal(getParserPosterGateImage(images,request,1,'image'),saved.responseText);
});
