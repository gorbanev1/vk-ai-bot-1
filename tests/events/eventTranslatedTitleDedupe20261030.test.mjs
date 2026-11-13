import assert from 'node:assert/strict';
import { compareEventsDeterministic, deduplicateEventsTwoContour } from '../../src/features/events/eventDuplicateResolution.js';

const ru = {
    title: 'ДЕНЬ ОРТОПЕДИЧЕСКОЙ МЕДСЕСТРЫ',
    eventDate: '2026-10-30', eventTime: '19:30', timeLabel: '19:30',
    venue: 'Berserk Bar', participants: 'Deep Purple State, Лотоъ, секретный гость',
    sourceType: 'telegram', sourceUrl: 'https://t.me/kurazhcity/4142',
};
const en = {
    title: 'ORTHOPEDIC NURSES DAY',
    eventDate: '2026-10-30', eventTime: '19:30', timeLabel: '19:30',
    venue: 'Berserk Bar', participants: 'DEEP STATE; ЛОТОВЬ; ???',
    sourceType: 'vk', sourceUrl: 'https://vk.ru/wall-188108754_2585',
};

const deterministic = compareEventsDeterministic(ru, en);
assert.equal(deterministic.verdict, 'ambiguous');
assert.ok(deterministic.reasons.includes('cross-language-title-ai'));

const arbitrate = async (pairs) => new Map(pairs.map((pair) => [pair.key, {
    verdict: 'same', confidence: 0.99, reason: 'same date, venue and translated title',
}]));
const first = await deduplicateEventsTwoContour([ru, en], { arbitrateAmbiguous: arbitrate });
assert.equal(first.events.length, 1);
assert.deepEqual(new Set(first.events[0].alternativeTitles), new Set([ru.title, en.title]));

const reversed = await deduplicateEventsTwoContour([en, ru], { arbitrateAmbiguous: arbitrate });
assert.equal(reversed.events.length, 1);
assert.deepEqual(new Set(reversed.events[0].alternativeTitles), new Set([ru.title, en.title]));

const differentDate = await deduplicateEventsTwoContour([ru, { ...en, eventDate: '2026-10-31' }], { arbitrateAmbiguous: arbitrate });
assert.equal(differentDate.events.length, 2);

console.log('eventTranslatedTitleDedupe20261030.test.mjs: OK');
