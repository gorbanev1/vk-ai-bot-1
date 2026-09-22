import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const browser = readFileSync(new URL('../../src/infrastructure/browser/browserGrabber.js', import.meta.url), 'utf8');
const vk = readFileSync(new URL('../../src/platforms/vk/vkPublicScraper.js', import.meta.url), 'utf8');

test('persistent Chromium is not idled out before ten minutes', () => {
    assert.match(browser, /configuredBrowserIdleCloseMs/u);
    assert.match(browser, /Math\.max\(10 \* 60_000, Math\.trunc\(configuredBrowserIdleCloseMs\)\)/u);
    assert.match(browser, /: 10 \* 60_000;/u);
});

test('browser-realm VK poster filtering does not reference Node imports', () => {
    assert.match(vk, /function isLikelyVkNonPosterUiImageUrlInPage\(value\)/u);
    assert.match(vk, /isLikelyVkNonPosterUiImageUrlInPage\(url\)/u);

    const evaluateStart = vk.indexOf('const rawPosts = await page.evaluate');
    const evaluateEnd = vk.indexOf('\n    return rawPosts', evaluateStart);
    assert.ok(evaluateStart >= 0 && evaluateEnd > evaluateStart, 'VK rendered-post evaluate block must exist');
    const browserRealm = vk.slice(evaluateStart, evaluateEnd);
    assert.doesNotMatch(browserRealm, /(?<!InPage)isLikelyVkNonPosterUiImageUrl\(url\)/u);
});

test('non-manual VK capture retains bounded fallback retry infrastructure', () => {
    assert.match(vk, /VK_PUBLIC_CAPTURE_ATTEMPTS, 1, 3, 2/u);
    assert.match(vk, /VK_PUBLIC_RECOVERY_SCROLL_STEPS,[\s\S]{0,80}1,[\s\S]{0,80}20,[\s\S]{0,80}8/u);
    assert.match(vk, /recoveryScrollSteps: captureAttempt > 1 \? recoveryScrollSteps : 0/u);
    assert.match(vk, /\[VK PUBLIC CAPTURE RETRY\]/u);
    assert.match(vk, /if \(!keepPageOpen && page && !page\.isClosed\(\)\) \{[\s\S]{0,160}await page\.close\(\)\.catch/u);
    assert.match(vk, /source\.capture\.recovery-scroll\.start/u);
    assert.match(vk, /source\.capture\.retry-success/u);
});
