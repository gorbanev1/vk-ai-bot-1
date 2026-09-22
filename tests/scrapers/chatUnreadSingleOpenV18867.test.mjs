import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const chat = readFileSync(new URL('../../src/platforms/vk/vkChatEventScraper.js', import.meta.url), 'utf8');
const app = readFileSync(new URL('../../src/app/botApplication.js', import.meta.url), 'utf8');
const vk = readFileSync(new URL('../../src/platforms/vk/vkPublicScraper.js', import.meta.url), 'utf8');
const browser = readFileSync(new URL('../../src/infrastructure/browser/browserGrabber.js', import.meta.url), 'utf8');

test('VK chat detects the real unread tail and sweeps down before the finite upward pass', () => {
    assert.match(chat, /ConvoHistory__unreadSeparator/u);
    assert.match(chat, /перейти к непрочитанным сообщениям/iu);
    assert.match(chat, /async function inspectConversationNavigationState/u);
    assert.match(chat, /async function scrollConversationDown/u);

    const finiteStart = chat.indexOf('async function runFiniteManualPass');
    const finiteEnd = chat.indexOf('\n    async function startManualSession', finiteStart);
    assert.ok(finiteStart >= 0 && finiteEnd > finiteStart);
    const finite = chat.slice(finiteStart, finiteEnd);
    const inspectAt = finite.indexOf('inspectConversationNavigationState(livePage)');
    const downAt = finite.indexOf('scrollConversationDown(livePage');
    const mainLoopAt = finite.indexOf('for (let round = 0; round < 250; round += 1)');
    const upAt = finite.indexOf('scrollConversationUp(livePage', mainLoopAt);
    assert.ok(inspectAt >= 0 && downAt > inspectAt, 'unread/scroll state must be inspected before downward sweep');
    assert.ok(mainLoopAt > downAt, 'downward unread sweep must finish before the normal finite loop');
    assert.ok(upAt > mainLoopAt, 'upward history pass must happen after the downward sweep');
    assert.match(finite, /normalTargetReached && returnedToInitialFrontier/u);
    assert.match(finite, /source\.unread\.scroll/u);
    assert.match(finite, /downSweepCapturedMessages/u);
    assert.match(chat, /async function sweepUnreadTailForManualSession/u);
    assert.match(chat, /manual-unread-down-up/u);
    assert.match(chat, /await sweepUnreadTailForManualSession\(\)/u);
});

test('configured manual source is started once; failures never auto-open a second source tab', () => {
    const recoveryStart = app.indexOf('async function startManualScraperSourceWithRecoveryInner');
    const recoveryEnd = app.indexOf('\nasync function startAllManualScraperSources', recoveryStart);
    assert.ok(recoveryStart >= 0 && recoveryEnd > recoveryStart);
    const recovery = app.slice(recoveryStart, recoveryEnd);
    const starts = recovery.match(/startManualScraperSource\(source\.id, options\)/gu) || [];
    assert.equal(starts.length, 1);
    assert.match(recovery, /MANUAL SCRAPER SOURCE SINGLE OPEN/u);
    assert.doesNotMatch(recovery, /pinFailedScraperSourceForOwner\(/u);
    assert.doesNotMatch(recovery, /attempts:\s*2/u);
});

test('manual VK public capture has one attempt and finite sources reuse one page', () => {
    assert.match(vk, /singleOpenPerRun = false/u);
    assert.match(vk, /\(keepPageOpen \|\| singleOpenPerRun\)[\s\S]{0,80}\? 1/u);
    assert.match(app, /source\.kind === 'vk-public' \? \{ singleOpenPerRun: true \}/u);
    assert.match(vk, /reuseKey: \(keepPageOpen \|\| deferClose\) \? `vk-public:\$\{screenName\}` : ''/u);
    assert.match(chat, /reuseKey: `vk-chat:\$\{peerId\}`/u);
});

test('empty Chromium leftovers are cleaned without closing meaningful owner pages', () => {
    assert.match(browser, /POST_PARSER_BLANK_CLOSE_MS/u);
    assert.match(browser, /scheduleOrphanBrowserCleanup\(context, POST_PARSER_BLANK_CLOSE_MS\)/u);
    assert.match(browser, /closeUnexpectedBlankScraperPages/u);
    assert.match(browser, /SCRAPER BLANK TAB CLEANUP/u);
    assert.match(browser, /meaningfulPages\.length > 0\) return/u);
});


test('parser-all poster maintenance cannot reopen Chromium after source capture', () => {
    const repairStart = app.indexOf('async function repairMissingUpcomingManualEventPosters');
    const repairEnd = app.indexOf('\nasync function', repairStart + 20);
    assert.ok(repairStart >= 0 && repairEnd > repairStart);
    const repair = app.slice(repairStart, repairEnd);
    assert.doesNotMatch(repair, /recoverVkEventPosterWithBrowser\(/u);
    assert.match(repair, /parser-all-single-open-no-browser-revisit/u);
});
