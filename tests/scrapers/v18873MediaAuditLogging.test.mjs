import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';

const publicSource = readFileSync(new URL('../../src/platforms/vk/vkPublicScraper.js', import.meta.url), 'utf8');
const chatSource = readFileSync(new URL('../../src/platforms/vk/vkChatEventScraper.js', import.meta.url), 'utf8');
const appSource = readFileSync(new URL('../../src/app/botApplication.js', import.meta.url), 'utf8');

test('V188.73 logs DOM media identity/context and stores the AI-to-event audit', () => {
    assert.match(publicSource, /selectorPath/u);
    assert.match(publicSource, /domContext/u);
    assert.match(publicSource, /media\.inventory/u);
    assert.match(publicSource, /media\.audit/u);
    assert.match(publicSource, /bindingCandidates/u);
    assert.match(publicSource, /selectedEvents/u);
    assert.match(publicSource, /finalVerdict/u);
    assert.match(chatSource, /selectorPath/u);
    assert.match(chatSource, /media\.audit/u);
});

test('V188.73 writes complete vision/text AI responses to trace diagnostics', () => {
    assert.match(appSource, /responseText:\s*text/u);
    assert.match(appSource, /text-extraction\.response/u);
    assert.match(publicSource, /vision\.response/u);
    assert.match(chatSource, /vision\.response/u);
});

test('V188.79 zero-post recovery reloads only after delayed page-health recheck', () => {
    assert.match(publicSource, /forceReason:\s*'parser-zero-posts'/u);
    assert.match(publicSource, /healthy-page-parser-miss/u);
    assert.match(publicSource, /page-health\.recheck/u);
    assert.match(publicSource, /page-recovered-during-wait/u);
});

test('V188.73 no longer treats source membership as poster proof', () => {
    assert.doesNotMatch(publicSource, /single-event-source-media\+ui-filtered/u);
    const assetsSource = readFileSync(new URL('../../src/features/events/eventAssets.js', import.meta.url), 'utf8');
    assert.match(assetsSource, /shareSourceImagesAcrossEvents is intentionally ignored/u);
});
