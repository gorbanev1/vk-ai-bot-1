import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createPublicEventRangeService } from '../../src/features/events/publicEventRange.js';
import { compareEventsDeterministic } from '../../src/features/events/eventDuplicateResolution.js';
import { executeRuntimeModelFailover } from '../../src/features/ai/modelProviderFailover.js';

test('V18820: «эти выходные» включает пятницу', () => {
    const service = createPublicEventRangeService({
        timeZone: 'Europe/Moscow',
        now: () => new Date('2026-09-09T12:00:00+03:00'),
    });
    const range = service.parsePublicEventsRangeCommand('тусы эти выходные');
    assert.equal(range.fromDate, '2026-09-11');
    assert.equal(range.toDate, '2026-09-13');
});

test('V18820: PEREGRUZ/ПЕРЕГРУЗ склеиваются по translit + date + place/source', () => {
    const left = {
        title: 'PEREGRUZ underground techno party',
        eventDate: '2026-09-12',
        eventTime: '22:00',
        venue: 'Клуб «Сова», Плехановская ул. 9, Воронеж',
        participants: 'Vadim XTC, JL.MNSN, INKA EFIMENKO, CHERNO, TONY BAND',
        sourceUrl: 'https://flat.audio/e/2593?par=AAA',
    };
    const right = {
        title: 'ПЕРЕГРУЗ — выступление CHERNO',
        eventDate: '2026-09-12',
        venue: 'Плехановская ул. 9, Воронеж',
        participants: 'CHERNO',
        sourceUrl: 'https://flat.audio/e/2593?par=BBB',
    };
    const result = compareEventsDeterministic(left, right);
    assert.equal(result.verdict, 'same');
    assert.ok(result.reasons.some((reason) => reason.includes('translit')));
    assert.ok(result.reasons.includes('same-source-url'));
});

test('V18820: failover без health quarantine делает 2 попытки и идёт к следующему кандидату', async () => {
    const calls = [];
    const candidates = [
        { provider: 'compat', name: 'k1', secret: 'x', baseUrl: 'https://example.invalid', model: 'default' },
        { provider: 'compat', name: 'k1', secret: 'x', baseUrl: 'https://example.invalid', model: 'pro' },
    ];
    const result = await executeRuntimeModelFailover({
        candidates,
        failuresBeforeQuarantine: 2,
        maxRounds: 1,
        useCredentialHealth: false,
        sleep: async () => {},
        request: async (credential, meta) => {
            calls.push(`${credential.model}:${meta.attempt}`);
            if (credential.model === 'default') throw new Error('timeout');
            return 'ok';
        },
    });
    assert.equal(result.value, 'ok');
    assert.deepEqual(calls, ['default:1', 'default:2', 'pro:1']);
});

test('V18821: VK parser follows copy_history until source with node guard and poster vision wins over hints', async () => {
    const source = await readFile(new URL('../../src/app/botApplication.js', import.meta.url), 'utf8');
    assert.match(source, /const VK_EVENT_MAX_REPOST_NODES = 64;/u);
    assert.doesNotMatch(source, /VK_EVENT_MAX_REPOST_DEPTH/u);
    assert.match(source, /collectVkWallTextRecursive\(wall/u);
    assert.match(source, /for \(const copy of Array\.isArray\(item\?\.copy_history\)/u);
    assert.match(source, /extractPosterAnchoredManualEvents/u);
    assert.match(source, /AI is the final semantic arbiter/u);
    assert.match(source, /useHealthFilter: useCredentialHealth/u);
});
