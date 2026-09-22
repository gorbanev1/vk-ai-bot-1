import assert from 'node:assert/strict';
import {
    REQUIRED_VK_PUBLIC_SOURCES,
    mergeVkPublicSourceConfigurations,
} from '../../src/features/scrapers/publicSourcePolicy.js';

const expected = new Map([
    ['deadway36', 20],
    ['liverpool_pub_vrn', 20],
    ['idmamaanarchy', 20],
    ['meetbowling.club', 20],
    ['vavilone_rb', 20],
]);

for (const item of REQUIRED_VK_PUBLIC_SOURCES) {
    assert.equal(expected.get(item.source), item.initialCount);
}
assert.equal(REQUIRED_VK_PUBLIC_SOURCES.length, 5);

const merged = mergeVkPublicSourceConfigurations([
    { source: 'rb_diesel', initialCount: 200 },
    { source: 'deadway36', initialCount: 3 },
]);
const bySource = new Map(merged.map((item) => [item.source.toLowerCase(), item.initialCount]));
assert.equal(bySource.get('rb_diesel'), 20);
assert.equal(bySource.get('deadway36'), 20);
for (const [source, count] of expected) {
    assert.equal(bySource.get(source), count);
}
console.log('publicSourcePolicy.test.mjs OK');
