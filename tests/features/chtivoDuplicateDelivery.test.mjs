import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { chtivoPartRandomId } from '../../src/features/chtivo/chtivoDeliveryId.js';

test('one logical VK reading part retains same random id across retries', () => {
    const a = chtivoPartRandomId(2000000006, 3, 6, 17);
    const b = chtivoPartRandomId(2000000006, 3, 6, 17);
    assert.equal(a, b);
    assert.ok(Number.isInteger(a) && a >= 1 && a <= 2147483647);
});

test('different peer, book, chapter, and part have different delivery ids', () => {
    const keys = [
        [2000000006, 3, 6, 17],
        [2000000008, 3, 6, 17],
        [2000000006, 4, 6, 17],
        [2000000006, 3, 7, 17],
        [2000000006, 3, 6, 18],
    ];
    assert.equal(new Set(keys.map(args => chtivoPartRandomId(...args))).size, keys.length);
});

// Actual command/scheduler delivery and stable IDs are exercised in chtivoReplyChain.test.mjs.

test('schedule ticks and incoming chitivo commands share the same peer lock', () => {
    const feature = readFileSync(new URL('../../src/features/chtivo/chtivo.js', import.meta.url), 'utf8');
    assert.match(feature, /if \(schedulerTickRunning\) return;/u);
    assert.match(feature, /if \(!context \|\| peerLocks\.has\(peerId\)\) continue;/u);
    assert.match(feature, /peerLocks\.add\(peerId\);/u);
    assert.match(feature, /peerLocks\.delete\(peerId\);/u);
});

test('manual continuation accepts both далее and отправить command forms', () => {
    const feature = readFileSync(new URL('../../src/features/chtivo/chtivo.js', import.meta.url), 'utf8');
    assert.match(feature, /\^\(\?:далее\|отправить\)\$/u);
});
