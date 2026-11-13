import assert from 'node:assert/strict';
import test from 'node:test';

import { canonicalEventVenues, canonicalizeEventVenue, getCanonicalVenuePublisherUrl } from '../../src/features/events/eventVenueCatalog.js';
import { normalizeEventProposalDraftEvent } from '../../src/features/events/eventProposalWorkflow.js';
import { compareEventsDeterministic, deduplicateEventsTwoContour, eventVenueSimilarity } from '../../src/features/events/eventDuplicateResolution.js';
import { SECONDARY_PARTY_INITIAL_SOURCES, normalizePartySourceKey } from '../../src/features/events/partyPool.js';

test('canonical venue catalog maps every supplied name and transliterated alias', () => {
    const examples = [
        ['Хлам', 'Бар «Хлам»'], ['XLAM BAR', 'Бар «Хлам»'],
        ['ОНИ в баре', 'ОНИ в баре'], ['vinzavod', 'Винзавод'],
        ['Arena Hall', 'Arena Hall'], ['Pinta Haus', 'Рестобар Pinta Haus'],
        ['AURA CLUB', 'AURA CLUB'], ['Понеслось', 'Бар «Понеслось»'],
        ['Barak O Mama', 'BARak O’Mama'], ['Cenzura Bar', 'Цензура Бар'],
        ['Нарядный', 'Нарядный'], ['Коммуна', 'Коммуна'],
        ['Площадка 1900', 'Площадка 1900'], ['Balagan City', 'Balagan City'],
        ['Литера бар', 'Литера BAR'], ['Коптильня', 'Коптильня'],
        ['Живой Контакт', 'Лекторий «Живой Контакт»'], ['Котельная', 'Котельная'],
        ['Diesel Bar', 'Diesel Bar'], ['Дизель Холл', 'Diesel Hall'],
        ['Overlock', 'Бар Overlock'], ['Liverpool Pub', 'Liverpool Pub'],
        ['Артель Чайка', 'Артель «Чайка»'], ['Башня', 'Культурное пространство «Башня»'],
        ['Berserk Bar', 'Berserk Bar'], ['Бар Тупик', 'Бар «Тупик»'],
        ['Мама Анархия', 'Рок-паб «Мама Анархия»'], ['Meet Bowling', 'Митбоулинг Клуб'],
        ['The Last of Vavilone', 'Рок-бар The Last of Vavilone'],
        ['Клуб 12', 'Клуб «12»'], ['Сто Ручьев', 'Клуб «Сто Ручьёв»'],
    ];
    for (const [input, expected] of examples) {
        const result = canonicalizeEventVenue(input);
        assert.equal(result.canonicalName, expected, `${input} should map to ${expected}`);
    }
});

test('catalog names normalize to the exact canonical card name and address', () => {
    for (const venue of canonicalEventVenues()) {
        const result = canonicalizeEventVenue(venue.name);
        assert.equal(result.matched, true, `${venue.name} should match itself`);
        assert.equal(result.canonicalName, venue.name);
        assert.equal(result.canonicalAddress, venue.address);
        assert.equal(result.venue, venue.address ? `${venue.name}, ${venue.address}` : venue.name);
    }
});

test('every canonical venue links to its supplied VK and Telegram publisher', () => {
    const expected = {
        'Бар «Хлам»': ['https://vk.com/xlambar', 'https://t.me/xlam_bar'],
        'ОНИ в баре': ['https://vk.com/onibar', 'https://t.me/onibarvrn'],
        'Винзавод': ['https://vk.com/vinzavodpro', 'https://t.me/vinzavodproo'],
        'Arena Hall': ['https://vk.com/arena_voronez', 'https://t.me/arena_hall_vrn'],
        'Рестобар Pinta Haus': ['https://vk.com/pinta_haus', 'https://t.me/pintahausvrn'],
        'AURA CLUB': ['https://vk.com/auravrn', 'https://t.me/auraclubvrn'],
        'Бар «Понеслось»': ['https://vk.com/poneslosbar_vrn', 'https://t.me/poneslosbar_vrn'],
        'BARak O’Mama': ['https://vk.com/barakomama', 'https://t.me/barak_omama'],
        'Цензура Бар': ['https://vk.com/cenzura_bar', 'https://t.me/cenzurabar'],
        'Нарядный': ['https://vk.com/naryadny.rest', 'https://t.me/naryadnyrest'],
        'Коммуна': ['https://vk.com/kommunavrn', 'https://t.me/kommunavrn'],
        'Площадка 1900': ['https://vk.com/rest1900', ''],
        'Balagan City': ['https://vk.com/balagan.city', 'https://t.me/+_ITgIS9HEpVlMjIy'],
        'Литера BAR': ['https://vk.com/literabar', 'https://t.me/literabar'],
        'Коптильня': ['https://vk.com/koptilnyarest', ''],
        'Лекторий «Живой Контакт»': ['https://vk.com/zhivoikontakt_vrn', ''],
        'Котельная': ['https://vk.com/kotelnaya_inc', 'https://t.me/kotelnaya_inc'],
        'Diesel Bar': ['https://vk.com/rb_diesel', 'https://t.me/rb_diesel'],
        'Diesel Hall': ['https://vk.com/rb_diesel', 'https://t.me/rb_diesel'],
        'Бар Overlock': ['https://vk.com/overlockbar', 'https://t.me/overlock_bar'],
        'Liverpool Pub': ['https://vk.com/liverpool_pub_vrn', 'https://t.me/liverpoolgerold'],
        'Артель «Чайка»': ['https://vk.com/artartelchaika', 'https://t.me/art_chayka'],
        'Культурное пространство «Башня»': ['https://vk.com/bashnyakult', ''],
        'Berserk Bar': ['https://vk.com/berserk_bar', 'https://t.me/berserkbar'],
        'Бар «Тупик»': ['https://vk.com/deadway36', 'https://t.me/tupikbar'],
        'Рок-паб «Мама Анархия»': ['https://vk.com/idmamaanarchy', 'https://t.me/rokpab'],
        'Митбоулинг Клуб': ['https://vk.com/meetbowling.club', 'https://t.me/meetbowling_club'],
        'Рок-бар The Last of Vavilone': ['https://vk.com/vavilone_rb', ''],
        'Клуб «12»': ['https://vk.com/12bpg', ''],
        'Клуб «Сто Ручьёв»': ['https://vk.com/storuvrn', ''],
    };
    assert.deepEqual(Object.keys(expected).sort(), canonicalEventVenues().map(({ name }) => name).sort());
    for (const venue of canonicalEventVenues()) {
        assert.equal(getCanonicalVenuePublisherUrl(venue.name, 'vk'), expected[venue.name][0], `${venue.name} VK link`);
        assert.equal(getCanonicalVenuePublisherUrl(venue.name, 'telegram'), expected[venue.name][1] || expected[venue.name][0], `${venue.name} Telegram link`);
        assert.equal(getCanonicalVenuePublisherUrl(venue.name, 'tg'), expected[venue.name][1] || expected[venue.name][0], `${venue.name} TG alias link`);
    }
});

test('known venues survive partial transliterated names without mapping numeric fragments or venue lists', () => {
    assert.equal(canonicalizeEventVenue('Ливерпуль паб').canonicalName, 'Liverpool Pub');
    assert.equal(canonicalizeEventVenue('The Last of Vavilon, ул. Кирова, 5').canonicalName, 'Рок-бар The Last of Vavilone');
    assert.equal(canonicalizeEventVenue('Площадка 1900').canonicalName, 'Площадка 1900');
    assert.equal(canonicalizeEventVenue('1900').matched, false);
    assert.equal(canonicalizeEventVenue('Тупик, 1917, Сосисочная, Аут, Келлер, Митбоулинг Клуб').matched, false);
    assert.equal(canonicalizeEventVenue('Студия Дон Милонгеро, Воронеж, Орджоникидзе 6').matched, false);
    assert.equal(canonicalizeEventVenue('The Rock Bar, ул. Горького, 104, Краснодар').matched, false);
});

test('street number is extracted after numbers in street names and mismatch markers are idempotent', () => {
    assert.equal(canonicalizeEventVenue('Котельная, ул. 20-летия Октября, 75А').venue, 'Котельная, ул. 20-летия Октября, 75А');
    assert.equal(canonicalizeEventVenue('Diesel Hall, ул. Генерала Лизюкова, 4', { allowNearAddressMatch: true }).venue, 'Diesel Hall, ул. Генерала Лизюкова, 4');
    assert.equal(canonicalizeEventVenue('Balagan City, ул. Кольцовская, 35, ТЦ «Галерея Чижова», 4-й этаж', { allowNearAddressMatch: true }).venue, 'Balagan City, ул. Кольцовская, 35, ТЦ «Галерея Чижова», 4-й этаж');
    assert.equal(canonicalizeEventVenue('Liverpool Pub, Куколкина, 33А', { allowNearAddressMatch: true }).venue, 'Liverpool Pub, ул. Куколкина, 33А/2');
    assert.equal(canonicalizeEventVenue('Diesel Hall, ул. Генерала Лизюкова, 8', { allowNearAddressMatch: true }).venue, 'Diesel Hall, ул. Генерала Лизюкова, 4 ❓(ул. Генерала Лизюкова, 8)❓');
    const mismatch = 'Diesel Hall, ул. Генерала Лизюкова, 4 ❓(ул. Генерала Лизюкова, 8)❓';
    assert.equal(canonicalizeEventVenue(mismatch).venue, mismatch);
});

test('same named venue deduplicates despite inconsistent house number and displays uncertainty', async () => {
    const canonical = canonicalizeEventVenue('Diesel Hall, ул. Генерала Лизюкова, 4');
    const wrong = canonicalizeEventVenue('Дизель холл, Лизюкова 8');
    assert.equal(canonical.venue, 'Diesel Hall, ул. Генерала Лизюкова, 4');
    assert.equal(wrong.venue, 'Diesel Hall, ул. Генерала Лизюкова, 4 ❓(Лизюкова 8)❓');
    assert.equal(eventVenueSimilarity(canonical.venue, wrong.venue), 1);

    const left = { title: 'RammPage (трибьют Rammstein)', eventDate: '2026-10-24', eventTime: '19:00', venue: 'Diesel Hall, ул. Генерала Лизюкова, 4' };
    const right = { ...left, venue: 'Дизель холл, Лизюкова 8' };
    assert.equal(compareEventsDeterministic(left, right).verdict, 'same');
    const result = await deduplicateEventsTwoContour([left, right]);
    assert.equal(result.events.length, 1);
    assert.equal(result.events[0].venue, 'Diesel Hall, ул. Генерала Лизюкова, 4 ❓(Лизюкова 8)❓');
    assert.equal(result.events[0].eventDays[0].venue, 'Diesel Hall, ул. Генерала Лизюкова, 4 ❓(Лизюкова 8)❓');
    // Source lineage may retain the original OCR evidence for audit, but the
    // user-facing venue and per-day schedule must use the canonical address.
    assert.ok(result.events[0].venue.includes('❓(Лизюкова 8)❓'));
    assert.ok(result.events[0].eventDays[0].venue.includes('❓(Лизюкова 8)❓'));
});

test('known venue source replaces OCR address but preserves a genuinely other venue', () => {
    assert.equal(normalizeEventProposalDraftEvent({ venue: 'Дизель Холл, ул. Генерала Лизюкова, 8' }).venue, 'Diesel Hall, ул. Генерала Лизюкова, 4 ❓(ул. Генерала Лизюкова, 8)❓');
    assert.equal(normalizeEventProposalDraftEvent({ venue: 'Diesel Bar' }).venue, 'Diesel Bar, ул. Генерала Лизюкова, 4');
    assert.ok(eventVenueSimilarity('Diesel Bar', 'Diesel Hall') <= 0.18);
});

test('each secondary venue source is registered only once with Telegram preferred', () => {
    const keys = SECONDARY_PARTY_INITIAL_SOURCES.map((item) => normalizePartySourceKey(item.kind, item.source));
    assert.equal(new Set(keys).size, keys.length);
    assert.ok(SECONDARY_PARTY_INITIAL_SOURCES.some((item) => item.kind === 'telegram' && item.source === 'xlam_bar'));
    assert.ok(!SECONDARY_PARTY_INITIAL_SOURCES.some((item) => item.kind === 'vk-public' && item.source === 'xlambar'));
    assert.ok(SECONDARY_PARTY_INITIAL_SOURCES.some((item) => item.kind === 'vk-public' && item.source === 'rest1900'));
});
