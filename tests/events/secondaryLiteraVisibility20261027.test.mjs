import test from 'node:test';
import assert from 'node:assert/strict';
import {
    SECONDARY_PARTY_INITIAL_SOURCES,
    getDefaultSecondaryPartySourceKeys,
    filterSecondaryVkSources,
    classifyEventPartyPool,
    PARTY_POOL_SECONDARY,
} from '../../src/features/events/partyPool.js';
import { createPublicEventRangeService } from '../../src/features/events/publicEventRange.js';

test('current VK Litera is not suppressed by old Telegram Litera', () => {
    const seeds = SECONDARY_PARTY_INITIAL_SOURCES;
    const telegram = [{ source: 'literabar' }, { source: 'xlam_bar' }];
    const vk = [{ source: 'literabar' }, { source: 'xlambar' }];
    assert.deepEqual(
        filterSecondaryVkSources(vk).map((x) => x.source),
        ['literabar', 'xlambar'],
    );
    assert.ok(seeds.some((x) => x.kind === 'vk-public' && x.source === 'literabar'));
    assert.ok(!seeds.some((x) => x.kind === 'telegram' && x.source === 'literabar'));
    assert.equal(classifyEventPartyPool(
        { sourceType: 'vk', sourceName: 'literabar' },
        { secondarySourceKeys: getDefaultSecondaryPartySourceKeys() },
    ), PARTY_POOL_SECONDARY);
});

test('Friday October 30 is included in the same party weekend as Saturday October 31', () => {
    const range = createPublicEventRangeService({
        timeZone: 'Europe/Moscow',
        now: () => new Date('2026-10-27T10:00:00+03:00'),
    }).createPublicEventsRangeByKind('weekend');
    assert.deepEqual([range.fromDate, range.toDate], ['2026-10-30', '2026-11-01']);
    assert.ok('2026-10-30' >= range.fromDate && '2026-10-30' <= range.toDate);
    assert.ok('2026-10-31' >= range.fromDate && '2026-10-31' <= range.toDate);
});