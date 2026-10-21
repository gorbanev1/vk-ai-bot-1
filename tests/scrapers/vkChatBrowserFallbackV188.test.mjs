import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const scraper = readFileSync(
    new URL('../../src/app/botApplication.js', import.meta.url),
    'utf8',
);
const browser = readFileSync(
    new URL('../../src/infrastructure/browser/browserGrabber.js', import.meta.url),
    'utf8',
);

test('VK chat repost fallback opens a separate browser tab and keeps it for 20 seconds', () => {
    const start = scraper.indexOf("method: 'browser.open-wall'");
    assert.ok(start >= 0, 'browser fallback audit must exist');
    const body = scraper.slice(start, start + 5_000);
    assert.match(body, /separateTab:\s*true/u);
    assert.match(body, /keepPageOpen:\s*false/u);
    assert.match(body, /minimumOpenMs:\s*20_000/u);
    assert.match(body, /allowShortMinimumOpen:\s*true/u);
    assert.match(body, /allowRelatedApi:\s*false/u);
    assert.match(body, /setTimeout\(resolveDelay,\s*5_000\s*\+\s*Math\.floor\(Math\.random\(\)\s*\*\s*15_001\)/u);
});

test('VK public DOM extraction binds owner validation to its immutable snapshot', () => {
    const vkPublic = readFileSync(
        new URL('../../src/platforms/vk/vkPublicScraper.js', import.meta.url),
        'utf8',
    );
    const start = vkPublic.indexOf('async function extractRenderedVkPosts(');
    assert.ok(start >= 0);
    const body = vkPublic.slice(start, start + 8_000);
    assert.match(body, /const html = String\(snapshotHtml \|\| ''\)/u);
    assert.match(vkPublic, /inferExpectedVkWallOwnerId\(html, screenName\)/u);
});

test('VK public failed capture holds the source tab through its minimum lifetime for manual recovery', () => {
    const vkPublic = readFileSync(
        new URL('../../src/platforms/vk/vkPublicScraper.js', import.meta.url),
        'utf8',
    );
    const start = vkPublic.indexOf('[VK PUBLIC FAILED CAPTURE HOLD]');
    assert.ok(start >= 0);
    const body = vkPublic.slice(start - 900, start + 1_100);
    assert.match(body, /minimumPageLifetimeMs/u);
    assert.match(body, /manualReloadOrScrollAvailable=true/u);
    assert.match(body, /await page\.waitForTimeout\(remainingLifetimeMs\)/u);
    assert.match(body, /await page\.close\(\)/u);
});

test('chat repost fallback disables related-page API enrichment', () => {
    assert.match(browser, /allowRelatedApi\s*=\s*true/u);
    assert.match(browser, /if \(!events\.length && allowRelatedApi\)/u);
    assert.match(browser, /browser\.vk_related_event\.skipped/u);
    assert.match(scraper, /dom-first-browser-fallback-api-disabled/u);
    assert.match(scraper, /const apiNotAttemptedAudit = allowVkApiEnrichment \? \[\]/u);
});

test('DOM root normalization prefers a complete body over a short nested UI fragment', () => {
    const vkChat = readFileSync(
        new URL('../../src/platforms/vk/vkChatEventScraper.js', import.meta.url),
        'utf8',
    );
    assert.match(vkChat, /const substantial = candidates\.filter\(\(candidate\) => candidate\.text\.length >= 60\)/u);
    assert.match(vkChat, /const rankedCandidates = substantial\.length \? substantial : candidates/u);
    assert.match(vkChat, /const rootCandidates = \[/u);
    assert.match(vkChat, /\.sort\(\(left, right\) => right\.length - left\.length\)/u);
    assert.match(vkChat, /cachedItems\.map\(\(item\) => \{?/u);
    assert.match(vkChat, /normalizeBrowserMessage\(item, conversationUrl\)/u);
    assert.match(vkChat, /extractDomAuditRootTexts\(raw\?\.domAudit\)/u);
    assert.match(vkChat, /balanced tag scan/u);
});

test('short minimum is opt-in and never reduces ordinary three-minute review dwell', () => {
    assert.match(browser, /allowShortMinimumOpen\s*=\s*false/u);
    assert.match(browser, /allowShortMinimumOpen\s*\n?\s*\?\s*Math\.max\(20_000/u);
    assert.match(browser, /Math\.max\(\s*EVENT_REVIEW_MINIMUM_OPEN_MS/u);
});

test('browser fallback audits attempts and empty/error outcomes', () => {
    const start = scraper.indexOf("method: 'browser.open-wall', status: 'attempt'");
    assert.ok(start >= 0);
    const body = scraper.slice(start, start + 7_000);
    assert.match(body, /DOM\/public-wall-fallback-empty/u);
    assert.match(body, /DOM\/public-wall-fallback-error/u);
});

test('wrapper repost text does not suppress root recovery fallback', () => {
    const start = scraper.indexOf('const localStructuralRoot = Boolean(');
    assert.ok(start >= 0);
    const body = scraper.slice(start, start + 500);
    assert.match(body, /message\?\.rootPostTextResolved === true/u);
    assert.match(body, /String\(message\?\.rootPostText \|\| ''\)\.trim\(\)/u);
    assert.doesNotMatch(body, /message\?\.embeddedText \|\| message\?\.repostText/u);
});

test('ordinary bot text with a VK wall URL is not promoted to root repost text', () => {
    const vkChat = readFileSync(
        new URL('../../src/platforms/vk/vkChatEventScraper.js', import.meta.url),
        'utf8',
    );
    const start = vkChat.indexOf('const bodyLooksLikeCapturedRoot = Boolean(');
    assert.ok(start >= 0);
    const body = vkChat.slice(start, start + 650);
    assert.match(body, /domStructuralEvidence\s*&&/u);
    assert.match(vkChat, /const explicitRootText = raw\?\.rootPostTextResolved === true/u);
    assert.match(vkChat, /domStructuralEvidence && raw\?\.rootPostTextResolved === true \? embeddedText/u);
});

test('a URL-matched DOM post supplies its body without relying on an extractor flag', () => {
    const start = scraper.indexOf('browserRootPostText = String(');
    assert.ok(start >= 0);
    const body = scraper.slice(start, start + 420);
    assert.match(body, /target\.text \|\| ''/u);
});

test('nested DOM repost layers preserve every source URL and prefer the deepest root URL', () => {
    const vkChat = readFileSync(
        new URL('../../src/platforms/vk/vkChatEventScraper.js', import.meta.url),
        'utf8',
    );
    assert.ok(vkChat.includes('const urls = [];'));
    assert.ok(vkChat.includes('if (nodeUrl && !urls.includes(nodeUrl)) urls.push(nodeUrl)'));
    assert.match(vkChat, /Array\.isArray\(structuralRoot\?\.urls\)/u);
    assert.ok(vkChat.includes('rootPostSourceUrl: String(structuralRoot?.url || raw?.rootPostSourceUrl'));
});
