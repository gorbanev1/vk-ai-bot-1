import assert from 'node:assert/strict';
import test from 'node:test';
import { venueNameTokens } from '../../src/features/events/venueNameTokens.js';
import { findVenueImportMatches } from '../../src/features/events/venueImportMatching.js';
import { titleIdentityTokens } from '../../src/features/events/eventIdentityTokens.js';
import { sourceRefreshTokenSimilarity } from '../../src/features/events/eventSourceRefresh.js';
import { canonicalizeEventVenue } from '../../src/features/events/eventVenueCatalog.js';
import { eventVenueSimilarity } from '../../src/features/events/eventDuplicateResolution.js';

test('function words and venue types never provide the common name anchor', () => {
    const words = 'the and with without through from или чтобы которые бар bar клуб club hall студия loft в баре';
    assert.deepEqual(venueNameTokens(words), []);
    assert.deepEqual(titleIdentityTokens(words), []);
    assert.equal(findVenueImportMatches('Alpha bar with', [{ name: 'Beta bar with' }]).length, 0);
    assert.equal(sourceRefreshTokenSimilarity('Alpha bar with', 'Beta bar with'), 0);
    assert.equal(eventVenueSimilarity('Alpha bar with', 'Beta bar with'), 0);
    assert.equal(canonicalizeEventVenue('The Rock Bar, ул. Горького, 104, Краснодар').matched, false);
    assert.equal(canonicalizeEventVenue('Клуб «12»').canonicalName, 'Клуб «12»');
    assert.equal(findVenueImportMatches('Ливерпуль паб', [{ name: 'Liverpool Pub' }]).length, 1);
    assert.deepEqual(venueNameTokens('The Last of Vavilone'), ['last', 'vavilone']);
});
