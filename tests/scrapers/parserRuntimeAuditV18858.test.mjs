import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

test('V188.58: parser poster vision no longer silently recaps configured 75s timeout to 25/30s', async () => {
    const app = await readFile(new URL('../../src/app/botApplication.js', import.meta.url), 'utf8');
    const factsStart = app.indexOf('async function readManualEventImageFacts');
    const factsEnd = app.indexOf('\nasync function ', factsStart + 20);
    const facts = app.slice(factsStart, factsEnd > factsStart ? factsEnd : factsStart + 20_000);
    assert.match(facts, /EVENT_PARSER_AI_ATTEMPT_TIMEOUT_MS/u);
    assert.match(facts, /15_000,[\s\S]{0,80}180_000/u);
    assert.doesNotMatch(facts, /Math\.min\(25_000/u);

    assert.doesNotMatch(app, /requestTimeoutMs:\s*Math\.min\(30_000/u);
    assert.match(app, /events-v188(?:58-log-audit-hardening|59-multi-announcement-media|60-parser-all-poster-refresh)/u);
});

test('V188.58: legacy VK public fallback is constrained to routerState owner', async () => {
    const source = await readFile(new URL('../../src/platforms/vk/vkPublicScraper.js', import.meta.url), 'utf8');
    assert.match(source, /function inferExpectedVkWallOwnerId/u);
    assert.match(source, /"entityId"\\s\*:\\s\*\(\\d\+\)/u);
    assert.match(source, /screenType === 'group' \? -entityId : entityId/u);
    assert.match(source, /if \(expectedOwnerId && Number\(item\.ownerId\) !== expectedOwnerId\)/u);
});
