import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { createBrowserTabLifetime } from '../../src/infrastructure/browser/browserTabLifetime.js';

function fixture() {
    let time = 0, sequence = 0;
    const timers = new Map();
    const policy = createBrowserTabLifetime({ now: () => time,
        setTimer: (fn, delay) => { const id = ++sequence; timers.set(id, { at: time + delay, fn }); return id; },
        clearTimer: id => timers.delete(id),
    });
    const page = new EventEmitter();
    const closes = [];
    let closed = false;
    page.isClosed = () => closed;
    page.manualClose = () => { closed = true; page.emit('close'); };
    page.close = async () => { closes.push(time); page.manualClose(); };
    const tick = async ms => {
        time += ms;
        for (const [id, timer] of [...timers]) if (timer.at <= time) { timers.delete(id); timer.fn(); }
        for (let i = 0; i < 10; i++) await Promise.resolve();
    };
    return { policy, page, closes, tick, timers };
}

test('automatic page close waits at least 15 seconds, including blank cleanup', async () => {
    const f = fixture();
    f.policy.protectPage(f.page);
    const closing = f.page.close();
    await f.tick(14999);
    assert.deepEqual(f.closes, []);
    await f.tick(1); await closing;
    assert.deepEqual(f.closes, [15000]);
    assert.equal(f.timers.size, 0);
});

test('context close cannot bypass 45-second submission dwell; manual close ends wait immediately', async () => {
    for (const manual of [false, true]) {
        const f = fixture();
        const context = new EventEmitter();
        context.pages = () => f.page.isClosed() ? [] : [f.page];
        let contextClosed = false;
        context.close = async () => { contextClosed = true; };
        f.policy.protectContext(context);
        f.policy.protectPage(f.page, 45000);
        const closing = context.close();
        await f.tick(1000);
        assert.equal(contextClosed, false);
        if (manual) f.page.manualClose();
        else {
            await f.tick(43999); assert.equal(contextClosed, false);
            await f.tick(1);
        }
        await closing;
        assert.equal(contextClosed, true);
        assert.equal(f.timers.size, 0);
        assert.equal(f.page.listenerCount('close'), 0);
    }
});

test('raising dwell while closure is pending and reusing an old blank page cannot shorten it', async () => {
    const f = fixture();
    f.policy.protectPage(f.page);
    await f.tick(20000);
    f.policy.protectPage(f.page, 45000, { restart: true });
    const closing = f.page.close();
    await f.tick(44999); assert.deepEqual(f.closes, []);
    await f.tick(1); await closing;
    assert.deepEqual(f.closes, [65000]);
});

test('submission navigation error still holds its tab for 45 seconds', async () => {
    const f = fixture();
    const context = { newPage: async () => f.page };
    f.page.goto = async () => { throw new Error('navigation failed'); };
    const code = readFileSync(new URL('../../src/infrastructure/browser/browserGrabber.js', import.meta.url), 'utf8');
    const start = code.indexOf('export async function openScraperTab(');
    const end = code.indexOf('export async function openPinnedScraperPage(', start);
    const open = runInNewContext(code.slice(start, end).replace('export ', '') + '\nopenScraperTab', {
        getScraperBrowserContext: async () => context, attachManagedPage() {},
        browserTabLifetime: f.policy, BROWSER_TAB_MINIMUM_OPEN_MS: 15000,
        DEFAULT_TIMEOUT_MS: 90000, MANUAL_WAIT_MS: 900000,
    });
    const request = open({ url: 'https://example.org', minimumOpenMs: 45000 });
    const checked = assert.rejects(request, /navigation failed/);
    await f.tick(0);
    await f.tick(44999); assert.deepEqual(f.closes, []);
    await f.tick(1); await checked;
    assert.deepEqual(f.closes, [45000]);
});

test('final review extraction sees late-rendered DOM after 45 seconds rather than the initial shell', async () => {
    let time = 0;
    const page = new EventEmitter();
    let closedAt = null, extractedAt = null;
    page.isClosed = () => closedAt !== null;
    page.close = async () => { closedAt = time; page.emit('close'); };
    page.url = () => 'https://example.org/event';
    page.bringToFront = async () => {};
    page.waitForTimeout = async ms => { time += ms; };
    page.waitForLoadState = async () => {};
    page.evaluate = async fn => {
        if (fn.toString().includes('targetPostCount')) return { height: 100, postCount: 20, expanded: 0 };
        if (fn.toString().includes('postLimit')) extractedAt = time;
        return { text: time >= 45000 ? 'Полный поздно загруженный анонс концерта' : 'initial shell', posts: [], imageUrls: [], finalUrl: page.url() };
    };
    const code = readFileSync(new URL('../../src/infrastructure/browser/browserGrabber.js', import.meta.url), 'utf8');
    const start = code.indexOf('export async function openEventLinkForReview(');
    const review = runInNewContext(code.slice(start).replace('export ', '') + '\nopenEventLinkForReview', {
        Date: { now: () => time }, console: { log() {}, warn() {} },
        EVENT_REVIEW_MINIMUM_OPEN_MS: 180000, EVENT_REVIEW_MEDIA_WAIT_MS: 20000,
        MANUAL_EVENT_AUTO_POST_LIMIT: 20,
        openScraperPage: async options => { assert.equal(options.minimumOpenMs, 45000); return page; },
        captureVkStructuredEventEvidence: async () => ({ events: [], exactWallPosts: [] }),
        settleScraperPage: async () => { time += 20000; },
        extractVkStructuredEventsFromBootstrap: () => [], mergeVkStructuredEventCandidates: () => [],
    });
    const result = await review({ url: page.url(), minimumOpenMs: 45000, allowShortMinimumOpen: true });
    assert.equal(extractedAt, 45000);
    assert.equal(closedAt, 45000);
    assert.match(result.text, /Полный поздно/u);
});
