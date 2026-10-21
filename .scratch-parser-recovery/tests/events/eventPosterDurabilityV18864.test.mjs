import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import {
    filterToExclusiveStoredPosterPaths,
    getExclusiveStoredPosterPaths,
} from '../../src/features/events/eventPosterPolicy.js';

const appSource = readFileSync(new URL('../../src/app/botApplication.js', import.meta.url), 'utf8');

test('distinct per-event posters from one digest are accepted', () => {
    const rows = [
        { id: 33, sourceType: 'vk', title: 'Алексей Вдовин', eventDate: '2026-09-19', imagePaths: ['vk_announcements/liverpool/2705-3.jpg'] },
        { id: 34, sourceType: 'vk', title: 'Игорь Лисов', eventDate: '2026-09-20', imagePaths: ['vk_announcements/liverpool/2705-1.jpg'] },
        { id: 35, sourceType: 'vk', title: 'Алексей Панасовский', eventDate: '2026-09-26', imagePaths: ['vk_announcements/liverpool/2705-4.jpg'] },
    ];
    const event = { ...rows[0] };
    assert.deepEqual(
        getExclusiveStoredPosterPaths(event, rows),
        ['vk_announcements/liverpool/2705-3.jpg'],
    );
    assert.deepEqual(
        filterToExclusiveStoredPosterPaths(event, rows, [
            'vk_announcements/liverpool/2705-3.jpg',
            'vk_announcements/liverpool/2705-1.jpg',
        ]),
        ['vk_announcements/liverpool/2705-3.jpg'],
    );
});

test('legacy digest poster shared by siblings stays rejected', () => {
    const rows = [
        { id: 1, sourceType: 'vk', title: 'One', eventDate: '2026-09-19', imagePaths: ['vk_announcements/shared.jpg'] },
        { id: 2, sourceType: 'vk', title: 'Two', eventDate: '2026-09-20', imagePaths: ['vk_announcements/shared.jpg'] },
    ];
    assert.deepEqual(getExclusiveStoredPosterPaths(rows[0], rows), []);
    assert.deepEqual(filterToExclusiveStoredPosterPaths(rows[0], rows, ['vk_announcements/shared.jpg']), []);
});

test('ambiguous source with only one child cannot self-prove an exclusive mapping', () => {
    const row = { id: 1, sourceType: 'vk', title: 'One', eventDate: '2026-09-19', imagePaths: ['vk_announcements/one.jpg'] };
    assert.deepEqual(getExclusiveStoredPosterPaths(row, [row]), []);
});

test('approved proposal images are materialized out of event_proposals staging', () => {
    assert.match(appSource, /manual_event_announcements\/proposal-/u);
    assert.match(appSource, /copyFileSync\(sourceAbsolute, targetAbsolutePath\)/u);
    assert.match(appSource, /persistApprovedProposalEventImages\(analysis\.event, proposal\.id, index\)/u);
    assert.match(appSource, /freshEvents:\s*durableAnalyses\.map/u);
    assert.match(appSource, /for \(const analysis of durableAnalyses\)/u);
});

test('parser-all repairs stale manual VK poster paths only through safe poster vision matching', () => {
    assert.match(appSource, /repairMissingUpcomingManualEventPosters/u);
    assert.match(appSource, /extractPosterGateFactsWithVision\(/u);
    assert.match(appSource, /assignEventImageIndexesFromFacts\(/u);
    assert.match(appSource, /manual_event_announcements/u);
    assert.match(appSource, /run\.manual-poster-repair\.complete/u);
});

test('user-facing event delivery stays local-only and never starts browser recovery', () => {
    const start = appSource.indexOf('async function getEventAttachments');
    const end = appSource.indexOf('async function sendPublicEventMessages', start);
    assert.ok(start >= 0 && end > start);
    const body = appSource.slice(start, end);
    assert.doesNotMatch(body, /recoverVkEventPosterWithBrowser/u);
    assert.match(body, /selectBestLocalEventImagePath/u);
});
