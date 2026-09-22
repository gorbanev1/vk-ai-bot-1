import assert from 'node:assert/strict';
import test from 'node:test';
import { eventHasSafePosterMatch } from '../../src/features/events/eventProvenance.js';

test('V188.98 rendering rejects stale selected Vision facts even when historical status says exact_poster_match', () => {
    const stale = {
        title: 'Праздник урожая',
        eventDate: '2099-09-20',
        imagePaths: ['owner_event_corrections/harvest-1.jpg'],
        posterMatchStatus: 'exact_poster_match',
        posterImageIndex: 1,
        posterVisionFacts: [{
            index: 1,
            title: 'Дивная Масленица',
            dates: '21 февраля 2099',
            poster: true,
            posterConfidence: 99,
            imagePath: 'owner_event_corrections/harvest-1.jpg',
        }],
    };
    assert.equal(eventHasSafePosterMatch(stale), false);

    const fixed = {
        ...stale,
        posterVisionFacts: [{
            index: 1,
            title: 'Праздник урожая',
            dates: '20 сентября 2099',
            poster: true,
            posterConfidence: 99,
            imagePath: 'owner_event_corrections/harvest-1.jpg',
        }],
    };
    assert.equal(eventHasSafePosterMatch(fixed), true);
});
