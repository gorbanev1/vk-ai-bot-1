import assert from 'node:assert/strict';
import test from 'node:test';

import { parsePublicPostLocally, validatePublicAiEvents, setPublicAiResponseMetadata } from '../../src/features/events/publicPostLocalParser.js';

const post = {
    publishedAt: Math.floor(new Date('2026-10-01T12:00:00Z').getTime() / 1000),
    referenceNow: new Date('2026-10-01T12:00:00Z'),
    text: `ОКТЯБРЬ\n\n9 ОКТЯБРЯ — КЛАБ-ШОУ 9 ГРАММ\nАртист, чьи треки узнают с первых секунд.\n16–17 ОКТЯБРЯ — HUNTING FOR LOVE\nОсенью всем хочется любви.\n23 ОКТЯБРЯ — NICK VSN TOXI$ OFFICIAL DJ\nКонцертный диджей устроит пожар.\n30–31 ОКТЯБРЯ — ХЭЛЛОУИН\nСамая страшная ночь осени.\nМесто: Винзавод`,
};

test('V189 monthly announcements use one date-specific source segment per card', () => {
    const events = parsePublicPostLocally(post);
    assert.deepEqual(events.map((event) => event.eventDate), [
        '2026-10-09', '2026-10-16', '2026-10-17', '2026-10-23', '2026-10-30', '2026-10-31',
    ]);
    assert.equal(events[1].description, events[2].description);
    assert.match(events[1].description, /HUNTING FOR LOVE/u);
    assert.doesNotMatch(events[1].description, /КЛАБ-ШОУ|NICK VSN|ХЭЛЛОУИН/u);
    assert.doesNotMatch(events[0].description, /HUNTING FOR LOVE|NICK VSN|ХЭЛЛОУИН/u);
});

test('V189 AI full-text source_segment is replaced by the matching source block', () => {
    const allText = post.text;
    const ai = setPublicAiResponseMetadata([
        { _structure: 'multiple_events', date: '2026-10-09', title: '9 ГРАММ', venue: 'Винзавод', evidence: '9 ОКТЯБРЯ — КЛАБ-ШОУ 9 ГРАММ', source_segment: allText },
        { _structure: 'multiple_events', date: '2026-10-23', title: 'NICK VSN', venue: 'Винзавод', evidence: '23 ОКТЯБРЯ — NICK VSN TOXI$ OFFICIAL DJ', source_segment: allText },
    ], { structure: 'multiple_events', valid: true });
    const result = validatePublicAiEvents(ai, post);
    assert.equal(result.aiResponseValid, true);
    assert.match(result[0].description, /9 ОКТЯБРЯ/u);
    assert.doesNotMatch(result[0].description, /NICK VSN|ХЭЛЛОУИН/u);
    assert.match(result[1].description, /23 ОКТЯБРЯ/u);
    assert.doesNotMatch(result[1].description, /КЛАБ-ШОУ|ХЭЛЛОУИН/u);
});

test('validated AI announcement is stored as the card description ahead of the source fragment', () => {
    const ai = setPublicAiResponseMetadata([
        {
            _structure: 'single_event',
            date: '2026-10-09',
            title: '9 ГРАММ',
            venue: 'Винзавод',
            evidence: '9 ОКТЯБРЯ — КЛАБ-ШОУ 9 ГРАММ',
            announcement: 'На концерте прозвучат главные хиты группы. Это клубное шоу в рамках осенней программы площадки.',
            source_segment: '9 ОКТЯБРЯ — КЛАБ-ШОУ 9 ГРАММ',
        },
    ], { structure: 'single_event', valid: true });
    const result = validatePublicAiEvents(ai, post);
    assert.equal(result.aiResponseValid, true);
    assert.equal(result[0].description, 'На концерте прозвучат главные хиты группы. Это клубное шоу в рамках осенней программы площадки.');
    assert.match(result[0].sourceSegment, /9 ОКТЯБРЯ — КЛАБ-ШОУ 9 ГРАММ/u);
    assert.doesNotMatch(result[0].sourceSegment, /NICK VSN|ХЭЛЛОУИН/u);
});

console.log('monthlyAnnouncementSegmentsV189 tests: OK');
