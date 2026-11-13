import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';

const app = readFileSync(new URL('../../src/app/botApplication.js', import.meta.url), 'utf8');
const diagnostics = readFileSync(new URL('../../src/features/scrapers/manualParserDiagnostics.js', import.meta.url), 'utf8');
const vkPublic = readFileSync(new URL('../../src/platforms/vk/vkPublicScraper.js', import.meta.url), 'utf8');
const vkChat = readFileSync(new URL('../../src/platforms/vk/vkChatEventScraper.js', import.meta.url), 'utf8');

test('parser-all retains the configured randomized 10-20 second VK launch interval', () => {
    assert.match(app, /const vkLaunchMinMs = 10_000/u);
    assert.match(app, /const vkLaunchMaxMs = 20_000/u);
    assert.match(app, /makeGapMs:\s*\(\) => randomInt\(vkLaunchMinMs, vkLaunchMaxMs \+ 1\)/u);
    assert.match(app, /source\.run\.scheduled/u);
    assert.match(app, /scheduledDelayMs/u);
});

test('V188.74 stores a complete DOM file with hash and captures both sides of reload', () => {
    assert.match(diagnostics, /dom\.snapshot\.full/u);
    assert.match(diagnostics, /sha256/u);
    assert.match(diagnostics, /complete:\s*true/u);
    assert.match(vkPublic, /pre-reload-/u);
    assert.match(vkPublic, /post-reload-/u);
    assert.match(vkPublic, /pageReloadState = \{ count: 0, max: 3 \}/u);
});

test('V188.74 media diagnostics include all DOM attributes and ancestor selector chain', () => {
    for (const source of [vkPublic, vkChat]) {
        assert.match(source, /ancestorChain/u);
        assert.match(source, /outerHtml/u);
        assert.match(source, /nearbyText/u);
        assert.match(source, /documentOrdinal/u);
        assert.match(source, /siblingIndex/u);
    }
});


test('V188.78 automatic VK source reload waits at least 10 seconds', () => {
    assert.match(vkPublic, /VK_PUBLIC_RELOAD_BACKOFF_MS/u);
    assert.match(vkPublic, /10_000,\s*15_000,\s*12_000/u);
    assert.match(vkPublic, /setTimeout\(resolveReloadBackoff, reloadBackoffMs\)/u);
    assert.match(vkPublic, /reloadBackoffMs/u);
    const delayPosition = vkPublic.indexOf('setTimeout(resolveReloadBackoff, reloadBackoffMs)');
    const reloadPosition = vkPublic.indexOf('await page.reload({', delayPosition);
    assert.ok(delayPosition >= 0, 'reload backoff must exist');
    assert.ok(reloadPosition > delayPosition, 'the 10-second backoff must happen before page.reload()');
});

test('V188.79 healthy VK pages are never reloaded just because exact extraction returned zero', () => {
    assert.match(vkPublic, /healthy-page-parser-miss/u);
    assert.match(vkPublic, /const recheckedHealth = await inspectVkSourcePageHealth\(page\)/u);
    assert.match(vkPublic, /if \(recheckedHealth\.ready \|\| recheckedHealth\.reason === 'access-gate' \|\| !recheckedHealth\.reload\)/u);
    const delayPosition = vkPublic.indexOf('setTimeout(resolveReloadBackoff, reloadBackoffMs)');
    const recheckPosition = vkPublic.indexOf('const recheckedHealth = await inspectVkSourcePageHealth(page)', delayPosition);
    const reloadPosition = vkPublic.indexOf('await page.reload({', recheckPosition);
    assert.ok(recheckPosition > delayPosition, 'page health must be checked again after the wait');
    assert.ok(reloadPosition > recheckPosition, 'actual reload must happen only after the delayed recheck');
});


test('parser algorithm changes retain the owner-configured three-minute dwell and 25-second settling', () => {
    const imageRecovery = readFileSync(new URL('../../src/features/scrapers/browserImageCacheRecovery.js', import.meta.url), 'utf8');
    assert.match(vkPublic, /const minimumParserPageLifetimeMs = 180_000;/u);
    assert.match(vkChat, /const DEFAULT_POST_SCAN_HOLD_MS = 180_000;/u);
    assert.match(vkPublic, /await page\.waitForTimeout\?\.\(25_000\)/u);
    assert.match(vkChat, /await livePage\.waitForTimeout\(25_000\)/u);
    assert.match(imageRecovery, /CACHE_RECOVERY_SETTLE_MS = 25_000;/u);
});
