import test from 'node:test';
import assert from 'node:assert/strict';
import { applyPosterDerivedVenueFallback } from '../../src/features/events/eventPosterMatching.js';

test('a bare Vision field label Город cannot become an event venue', () => {
    const [event] = applyPosterDerivedVenueFallback([{
        venue: 'Город',
        posterImageIndex: 1,
        posterVisionFacts: [
            { index: 1, venue: '', poster: true },
            { index: 1, venue: 'ВИНЗАВОД CHAT', poster: true },
        ],
    }]);
    assert.equal(event.venue, 'ВИНЗАВОД CHAT');
    assert.equal(event.venueSource, 'poster');
});

test('invalid metadata labels disappear when there is no supported poster venue', () => {
    for (const venue of ['Город', 'Место', 'Адрес', 'City', 'место не указано']) {
        const [event] = applyPosterDerivedVenueFallback([{venue, posterImageIndex:0,posterVisionFacts:[]}]);
        assert.equal(event.venue, '', venue);
    }
});

test('actual venue names stay unchanged', () => {
    for (const venue of ['Винзавод', 'Городской концертный зал', 'Город кофе']) {
        const [event] = applyPosterDerivedVenueFallback([{venue, posterImageIndex:0,posterVisionFacts:[]}]);
        assert.equal(event.venue, venue);
    }
});