import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { extractPosterDateKeys, evaluatePosterFactForEvent, parseIndexedImageFacts, selectBestCompatiblePosterFact } from '../../src/features/events/eventPosterMatching.js';
import { getEventPosterSafetyAssessment } from '../../src/features/events/eventProvenance.js';
import { extractRawDateMentions, isEventDateConsistentWithSource } from '../../src/features/events/publicPostDateEvidence.js';

test('poster date ranges include the first day and each explicit intermediate day', () => {
    for (const text of ['30–31 октября', '30-31 October', 'с 30 по 31 октября']) {
        const keys = extractPosterDateKeys(text);
        assert.ok(keys.includes('30-10'), text);
        assert.ok(keys.includes('31-10'), text);
        assert.ok(!keys.includes('29-10'), text);
    }
    assert.ok(extractPosterDateKeys('16–18 октября').includes('17-10'));
    assert.ok(!extractPosterDateKeys('31–30 октября').includes('31-10'));
});

test('7000$ stays a distinctive performer while bare numbers cannot identify an event', () => {
    const event = { title: '7000$', participants: '7000$', eventDate: '2027-04-10' };
    const fact = { poster: true, imageType: 'poster', posterConfidence: 99, dates: '10 апреля', participants: '7000$' };
    assert.equal(evaluatePosterFactForEvent(event, fact).accepted, true);
    assert.equal(evaluatePosterFactForEvent(event, { ...fact, participants: '7000' }).accepted, false);
    assert.equal(evaluatePosterFactForEvent({ ...event, title: '2027', participants: '' },
        { ...fact, title: '2027', participants: '' }).accepted, false);
    assert.equal(evaluatePosterFactForEvent(event, { ...fact, dates: '9 апреля' }).accepted, false);
});

test('monthly poster retains semicolon-separated names and matches Halloween range start', () => {
    const [fact] = parseIndexedImageFacts('[IMAGE 1]\nТип изображения: poster\nЭто афиша события: да\nНазвание: HUNTING FOR LOVE; HALLOWEEN\nДата: 9 октября; 16–17 октября; 23 октября; 30–31 октября\nУчастники: 9 ГРАММ; NICK VSN; TOXI$');
    assert.equal(fact.title, 'HUNTING FOR LOVE; HALLOWEEN');
    assert.equal(fact.participants, '9 ГРАММ; NICK VSN; TOXI$');
    assert.equal(evaluatePosterFactForEvent({ title: 'HALLOWEEN', eventDate: '2026-10-30' }, fact).accepted, true);
    assert.equal(evaluatePosterFactForEvent({ title: 'HALLOWEEN', eventDate: '2026-10-29' }, fact).accepted, false);
});

test('historical numeric date range cannot reappear as year 2030', () => {
    const text = 'ПЛАНЫ НА НЕДЕЛЮ В КОММУНЕ (26.08-30.08)';
    assert.ok(extractRawDateMentions(text).every((item) => item.explicitYear === null));
    assert.equal(isEventDateConsistentWithSource({ eventDate: '2030-08-26',
        sourceText: text, publishedAt: 1787677021 }), false);
});

const app = readFileSync(new URL('../../src/app/botApplication.js', import.meta.url), 'utf8');
function recoveryHarness() {
    const writes = [];
    const start = app.indexOf('function recoverRelatedLocalPosterFallbackV18920(groups)');
    const end = app.indexOf('\nfunction localEventImageDataUrl', start);
    assert.ok(start > 0 && end > start);
    const recover = vm.runInNewContext(app.slice(start, end) + '\nrecoverRelatedLocalPosterFallbackV18920;', {
        selectBestCompatiblePosterFact, parseIndexedImageFacts,
        startupPosterRepairCandidateImages: (group) => group.imagePaths.map((path, i) => ({ path, sourceIndex: i + 1 })),
        localPosterEvidenceV18886: (path) => ({ path, filename: path.split('/').pop(), sha256: 'a'.repeat(64) }),
        eventHasUsableMediaV18883: (event) => getEventPosterSafetyAssessment(event).accepted,
        invalidateVerifiedPartySnapshot: () => {},
        updateStoredEventRecordFromReparse: (write) => {
            assert.equal(getEventPosterSafetyAssessment(write.event).accepted, true,
                'recovered metadata must pass the existing delivery contract');
            writes.push(write); return 1;
        },
    });
    return { recover, writes };
}

test('startup repair persists a trusted status and exact path, not a rejected fallback marker', () => {
    const h = recoveryHarness();
    const result = h.recover([{ imagePaths: ['source/post-1.jpg'],
        imageVisionFacts: [{ index: 1, poster: true, imageType: 'poster', title: 'Сквозь мрак', dates: '7 ноября' }],
        events: [{ id: 754, sourceType: 'vk', title: 'Сквозь мрак', eventDate: '2026-11-07',
            isMultiAnnouncement: true, imagePaths: [], posterMatchStatus: 'no_safe_poster' }] }]);
    assert.equal(result.recovered, 1);
    assert.equal(h.writes[0].event.posterVisionFacts[0].imagePath, 'source/post-1.jpg');
    assert.equal(h.writes[0].event.posterMatchStatus, 'verified_multi_event_poster');
});

test('startup repair recovers historical truncated metadata from its original Vision block', () => {
    const h = recoveryHarness();
    const result = h.recover([{ imagePaths: ['source/month-1.jpg'],
        imageVisionFacts: [{ index: 1, poster: true, imageType: 'poster', title: 'HUNTING FOR LOVE', dates: '9 октября',
            text: 'Тип изображения: poster\nЭто афиша события: да\nНазвание: HUNTING FOR LOVE; HALLOWEEN\nДата: 9 октября; 30–31 октября' }],
        events: [{ id: 122, sourceType: 'telegram', title: 'HALLOWEEN', eventDate: '2026-10-30',
            isMultiAnnouncement: true, imagePaths: [], posterMatchStatus: 'no_safe_poster' }] }]);
    assert.equal(result.recovered, 1);
    assert.match(h.writes[0].event.posterVisionFacts[0].title, /HALLOWEEN/);
});

test('startup repair rejects a fact explicitly bound to a different source file', () => {
    const h = recoveryHarness();
    const result = h.recover([{ imagePaths: ['source/post-1.jpg'],
        imageVisionFacts: [{ index: 1, imagePath: 'other/post-1.jpg', poster: true, imageType: 'poster',
            title: 'Rock Night', dates: '7 ноября' }],
        events: [{ id: 1, sourceType: 'vk', title: 'Rock Night', eventDate: '2026-11-07',
            isMultiAnnouncement: true, imagePaths: [], posterMatchStatus: 'no_safe_poster' }] }]);
    assert.equal(result.recovered, 0);
    assert.equal(h.writes.length, 0);
});

test('startup report reads database rows after the repair has completed', () => {
    const start = app.lastIndexOf('runStartupPosterAudit = () => {');
    const end = app.indexOf('    startupPosterAuditInitialized = true;', start);
    assert.ok(start > 0 && end > start);
    const calls = [];
    let repaired = false;
    const sandbox = {
        runStartupPosterAudit: null, botTimeZone: 'Europe/Moscow',
        getLocalDateString: () => '2026-10-25',
        getStartupPosterRepairGroupsV18877: () => [],
        recoverRelatedLocalPosterFallbackV18920: () => { calls.push('repair'); repaired = true; return { recovered: 1 }; },
        getAllUpcomingEventRecordsForDedupe: () => { calls.push('read'); return [{ repaired }]; },
        eventHasUsableMediaV18883: (event) => event.repaired,
        telegramBotStarted: true, telegramOwnerExternalUserId: 1,
        telegramBot: { api: { sendMessage: () => { throw Error('stale posterless report'); } } },
        console: { log() {}, warn(error) { throw error; } }, formatError: String,
    };
    vm.runInNewContext(app.slice(start, end), sandbox);
    sandbox.runStartupPosterAudit();
    assert.deepEqual(calls, ['repair', 'read']);
});
