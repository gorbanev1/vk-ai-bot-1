import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import {
    eventHasSafePosterMatch,
    formatEventProvenance,
    resolveVkChatProvenance,
} from '../../src/features/events/eventProvenance.js';
import {
    applyPosterDerivedVenueFallback,
    assignEventImageIndexesFromFacts,
} from '../../src/features/events/eventPosterMatching.js';

const appSource = readFileSync(new URL('../../src/app/botApplication.js', import.meta.url), 'utf8');
const chatSource = readFileSync(new URL('../../src/platforms/vk/vkChatEventScraper.js', import.meta.url), 'utf8');
const assetsSource = readFileSync(new URL('../../src/features/events/eventAssets.js', import.meta.url), 'utf8');

test('VK chat provenance prefers repost wall over body/attachment links', () => {
    const provenance = resolveVkChatProvenance({
        peerId: 2000000001,
        conversationName: 'Liverpool Crew',
        conversationMessageId: 1234,
        conversationUrl: 'https://vk.ru/im/convo/1?entrypoint=list_all',
        text: 'Ещё ссылка https://vk.ru/wall-2_20',
        repostUrls: ['https://vk.com/wall-1_10'],
        attachmentLinks: ['https://vk.ru/wall-3_30'],
    });
    assert.equal(provenance.canonicalPostUrl, 'https://vk.ru/wall-1_10');
    assert.equal(provenance.canonicalOrigin, 'chat-repost');
    assert.equal(provenance.sourceChatId, 2000000001);
    assert.equal(provenance.sourceMessageId, 1234);
});

test('clean VK chat message remains attributable even without a post URL', () => {
    const provenance = resolveVkChatProvenance({
        peerId: 55,
        conversationName: 'Орги',
        conversationMessageId: 321,
        conversationUrl: 'https://vk.ru/im/convo/55',
        text: '19 сентября встречаемся в Liverpool Pub',
    });
    assert.equal(provenance.canonicalPostUrl, '');
    assert.equal(provenance.canonicalOrigin, 'chat-message-only');
    assert.equal(formatEventProvenance({
        provenanceSourceType: provenance.sourceType,
        sourceChatName: provenance.sourceChatName,
        sourceMessageId: provenance.sourceMessageId,
    }, { compact: true }), '💬 Беседа «Орги», сообщение #321');
});

test('compact and full provenance use canonical post stored on the event', () => {
    const event = {
        canonicalPostUrl: 'https://vk.ru/wall-77_900',
        provenanceSourceType: 'vk_chat',
        sourceChatName: 'Тусовка',
        sourceMessageId: 42,
    };
    assert.equal(formatEventProvenance(event, { compact: true }), '🔗 vk.ru/wall-77_900 (из беседы «Тусовка»)');
    assert.match(formatEventProvenance(event), /Источник:\nhttps:\/\/vk\.ru\/wall-77_900/u);
    assert.match(formatEventProvenance(event), /Из беседы «Тусовка», сообщение #42/u);
});

test('three separate posters bind to three separate child events', () => {
    const events = [
        { title: 'Алексей Вдовин', eventDate: '2026-09-19', venue: 'Liverpool Pub' },
        { title: 'Игорь Лисов', eventDate: '2026-09-20', venue: 'Liverpool Pub' },
        { title: 'Алексей Панасовский', eventDate: '2026-09-26', venue: 'Liverpool Pub' },
    ];
    const facts = `
[IMAGE 1]\nЭто афиша события: да\nНазвание: Алексей Вдовин\nДата: 19 сентября 2026\nМесто: Liverpool Pub
[IMAGE 2]\nЭто афиша события: да\nНазвание: Игорь Лисов\nДата: 20 сентября 2026\nМесто: Liverpool Pub
[IMAGE 3]\nЭто афиша события: да\nНазвание: Алексей Панасовский\nДата: 26 сентября 2026\nМесто: Liverpool Pub`;
    const mapped = assignEventImageIndexesFromFacts(events, facts);
    assert.deepEqual(mapped.map((event) => event.posterImageIndex), [1, 2, 3]);
    assert.deepEqual(mapped.map((event) => event.posterMatchReason), ['date+title-majority', 'date+title-majority', 'date+title-majority']);
    assert.ok(mapped.every((event) => event.posterMatchStatus === 'verified_multi_event_poster'));
});

test('one multi-event calendar image is shared only when metadata names every child event and date', () => {
    const events = [
        { title: 'Алексей Вдовин', eventDate: '2026-09-19' },
        { title: 'Игорь Лисов', eventDate: '2026-09-20' },
        { title: 'Алексей Панасовский', eventDate: '2026-09-26' },
    ];
    const facts = `[IMAGE 1]\nЭто афиша события: да\nНазвание: Алексей Вдовин / Игорь Лисов / Алексей Панасовский\nДата: 19 сентября 2026, 20 сентября 2026, 26 сентября 2026\nМесто: Liverpool Pub`;
    const mapped = assignEventImageIndexesFromFacts(events, facts);
    // V188.93+: one real schedule poster may bind to several child cards only
    // because its metadata explicitly contains all three dates and identities.
    assert.deepEqual(mapped.map((event) => event.posterImageIndex), [1, 1, 1]);
    assert.ok(mapped.every((event) => event.posterMatchStatus === 'verified_multi_event_poster'));
    assert.ok(mapped.every((event) => event.imageIndexes.length === 1));
});

test('title-only and non-poster photos are rejected as unsafe', () => {
    const event = [{ title: 'Юбилейная 5-я вылазка-знакомство', eventDate: '2026-09-21' }];
    const titleOnly = assignEventImageIndexesFromFacts(event, '[IMAGE 1]\nЭто афиша события: да\nНазвание: Юбилейная 5-я вылазка-знакомство\nДата:');
    assert.equal(titleOnly[0].posterMatchStatus, 'no_safe_poster');
    assert.deepEqual(titleOnly[0].imageIndexes, []);

    const couplePhoto = assignEventImageIndexesFromFacts(event, '[IMAGE 1]\nЭто афиша события: нет\nНазвание: Юбилейная 5-я вылазка-знакомство\nДата: 21 сентября 2026');
    assert.equal(couplePhoto[0].posterMatchStatus, 'no_safe_poster');
    assert.deepEqual(couplePhoto[0].imageIndexes, []);
});


test('legacy status alone is audit-only; even manual posters need selected metadata in V188.99', () => {
    assert.equal(eventHasSafePosterMatch({ posterMatchStatus: 'legacy_single_source_poster' }), false);
    assert.equal(eventHasSafePosterMatch({ posterMatchStatus: 'legacy_unique_source_poster' }), false);
    assert.equal(eventHasSafePosterMatch({ posterMatchStatus: 'legacy_single_repost_poster' }), false);
    assert.equal(eventHasSafePosterMatch({ posterMatchStatus: 'legacy_manual_poster' }), false);
    assert.equal(eventHasSafePosterMatch({
        title: 'Noise Night',
        eventDate: '2026-09-19',
        imagePaths: ['manual/noise-night-1.jpg'],
        posterMatchStatus: 'legacy_manual_poster',
        posterImageIndex: 1,
        posterVisionFacts: [{
            index: 1, poster: true, imageType: 'poster', posterConfidence: 99, textReadability: 95,
            title: 'Noise Night', dates: '19 сентября 2026', recognizedText: 'Noise Night · 19 сентября',
            imagePath: 'manual/noise-night-1.jpg',
        }],
    }), true);
    assert.equal(eventHasSafePosterMatch({ posterMatchStatus: '' }), false);
    assert.equal(eventHasSafePosterMatch({ posterMatchStatus: 'no_safe_poster' }), false);

    const dbSource = readFileSync(new URL('../../src/infrastructure/database/index.js', import.meta.url), 'utf8');
    const start = dbSource.indexOf('function backfillLegacyPosterBindingsV18867Compat');
    const end = dbSource.indexOf('backfillLegacyPosterBindingsV18867Compat();', start);
    const migration = dbSource.slice(start, end);
    assert.match(migration, /sourceUrls\.length !== 1/u);
    assert.match(migration, /chatSiblingCount/u);
    assert.match(migration, /legacy_single_repost_poster/u);
    assert.doesNotMatch(migration, /update\('vk_chat_events'.*legacy_single_source_poster/u);
});

test('poster venue fills only an otherwise empty venue', () => {
    const [mapped] = assignEventImageIndexesFromFacts([
        { title: 'Noise Night', eventDate: '2026-09-19', venue: '' },
    ], '[IMAGE 1]\nЭто афиша события: да\nНазвание: Noise Night\nДата: 19 сентября 2026\nМесто: Liverpool Pub');
    const [withVenue] = applyPosterDerivedVenueFallback([mapped]);
    assert.equal(withVenue.venue, 'Liverpool Pub');
    assert.equal(withVenue.venueSource, 'poster');

    const [kept] = applyPosterDerivedVenueFallback([{ ...mapped, venue: 'Другой клуб' }]);
    assert.equal(kept.venue, 'Другой клуб');
});

test('public formatting always appends source and location, and images are provenance-gated', () => {
    const compactStart = appSource.indexOf('function buildCompactPublicEventsMessage');
    const compactEnd = appSource.indexOf('async function sendCompactPublicEventList', compactStart);
    const compact = appSource.slice(compactStart, compactEnd);
    assert.match(compact, /formatEventProvenance\(event, \{ compact: true \}\)/u);
    assert.match(compact, /место не указано/u);
    assert.match(compact, /— \$\{source\}/u);

    const fullStart = appSource.indexOf('function buildSinglePublicEventMessage');
    const fullEnd = appSource.indexOf('async function normalizeStoredEventForDisplay', fullStart);
    const full = appSource.slice(fullStart, fullEnd);
    assert.match(full, /место не указано/u);
    assert.match(full, /buildPublicEventSourceBlock\(event\)/u);

    const imageStart = appSource.indexOf('async function getEventAttachments');
    const imageEnd = appSource.indexOf('async function sendPublicEventMessages', imageStart);
    const imageDelivery = appSource.slice(imageStart, imageEnd);
    assert.match(imageDelivery, /getEventPosterSafetyAssessment\(event\)/u);
    assert.doesNotMatch(imageDelivery, /filterToExclusiveStoredPosterPaths/u);
    assert.match(assetsSource, /one event card owns at most ONE proven real source image/u);
    assert.match(assetsSource, /generated-fallback-blocked/u);
    assert.match(imageDelivery, /posterSafety\.boundPath/u);
});

test('clean parser captures provenance metadata before final-ledger skip and full mode can reprocess', () => {
    const captureIndex = chatSource.indexOf('upsertManualParserSeenItem({');
    const incrementalSkipIndex = chatSource.indexOf('if (incrementalKnown)', captureIndex);
    assert.ok(captureIndex >= 0 && incrementalSkipIndex > captureIndex);
    const capture = chatSource.slice(captureIndex, incrementalSkipIndex);
    assert.match(capture, /repostUrls/u);
    assert.match(capture, /attachmentLinks/u);
    assert.match(capture, /canonicalPostUrl/u);
    assert.match(chatSource, /forceReprocess:\s*!incrementalOnly/u);
    assert.match(chatSource, /existingAnnouncement && !forceReprocess/u);
});
