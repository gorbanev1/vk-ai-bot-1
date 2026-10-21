import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { parseImageEditRequest } from '../../src/features/ai/imageEditRouting.js';

test('parseImageEditRequest matches "возьми за основу и дорисуй"', () => {
    const parsed = parseImageEditRequest('возьми за основу и дорисуй справа неоновую вывеску');
    assert.equal(parsed.matched, true);
    assert.equal(parsed.instruction, 'справа неоновую вывеску');
});

test('parseImageEditRequest matches short "дорисуй" form', () => {
    const parsed = parseImageEditRequest('дорисуй слева ещё одного человека');
    assert.equal(parsed.matched, true);
    assert.equal(parsed.instruction, 'слева ещё одного человека');
});

test('parseImageEditRequest ignores ordinary vision request', () => {
    const parsed = parseImageEditRequest('что на картинке');
    assert.equal(parsed.matched, false);
});


test('orchestrator imports image edit parser before using it', () => {
    const source = readFileSync(
        new URL('../../src/app/botApplication.js', import.meta.url),
        'utf8',
    );

    assert.match(
        source,
        /import\s*\{\s*parseImageEditRequest,?\s*\}\s*from '\.\.\/features\/ai\/imageEditRouting\.js';/u,
    );
    assert.match(source, /parseImageEditRequest\(parsed\.prompt\)/u);
});

test('optional Telegram startup failure does not abort VK startup', () => {
    const source = readFileSync(
        new URL('../../src/app/botApplication.js', import.meta.url),
        'utf8',
    );

    const telegramAttempt = source.indexOf("reason: 'startup'");
    const degradedLog = source.indexOf("'[TELEGRAM STARTUP DEGRADED]'");
    const vkStart = source.indexOf("`Запускаю VK Long Poll: ${vkConnections.length} сообществ(а)…`");

    assert.ok(telegramAttempt >= 0);
    assert.ok(degradedLog > telegramAttempt);
    assert.ok(vkStart > degradedLog);
    assert.doesNotMatch(
        source.slice(telegramAttempt, vkStart),
        /throw\s+/u,
    );
    assert.match(source, /scheduleTelegramReconnect/u);
});
