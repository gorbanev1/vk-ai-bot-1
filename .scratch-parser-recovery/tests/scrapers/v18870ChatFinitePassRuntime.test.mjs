import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

test('V188.70 finite VK-chat pass builds ledger id from finitePassStartedAt, not undefined startedAt', () => {
    const source = readFileSync(new URL('../../src/platforms/vk/vkChatEventScraper.js', import.meta.url), 'utf8');
    const finiteStart = source.indexOf('async function runFiniteManualPass');
    const finiteEnd = source.indexOf('async function startManualSession', finiteStart);
    assert.ok(finiteStart >= 0 && finiteEnd > finiteStart);
    const body = source.slice(finiteStart, finiteEnd);
    assert.match(body, /const finitePassStartedAt = Date\.now\(\)/u);
    assert.match(body, /ledgerRunId = `\$\{sourceId\}:\$\{Math\.floor\(finitePassStartedAt \/ 1000\)\}:\$\{process\.pid\}`/u);
    assert.doesNotMatch(body, /\$\{startedAt\}/u);
});
