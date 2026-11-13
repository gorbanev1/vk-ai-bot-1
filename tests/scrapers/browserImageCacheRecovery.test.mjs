import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventEmitter } from 'node:events';
import { createBrowserImageCacheRecovery as createRecovery, createBrowserImageCapture, recoverPostImagesInBrowser as recoverPost, matchRecoveredImage } from '../../src/features/scrapers/browserImageCacheRecovery.js';

const createBrowserImageCacheRecovery = options => createRecovery({sleep:async()=>{},...options});
const recoverPostImagesInBrowser = options => recoverPost({sleep:async()=>{},...options});
const sourceUrl = 'https://vk.ru/wall-15_1229';
const url = 'https://sun9-55.vkuserphoto.ru/s/v1/ig2/poster.jpg?old=1';
const fresh = 'https://sun9-60.userapi.com/s/v1/ig2/poster.jpg?new=2';
const other = 'https://sun9-60.userapi.com/s/v1/ig2/other.jpg';
function bytes() {
    const image = Buffer.alloc(1024);
    image.set([0x89, 0x50, 0x4e, 0x47]); image.writeUInt32BE(800, 16); image.writeUInt32BE(600, 20);
    return image;
}
function setup(t) {
    const directory = mkdtempSync(join(tmpdir(), 'browser-cache-test-'));
    t.after(() => rmSync(directory, { recursive: true, force: true }));
    return { directory, cache: new Map() };
}
function pageFixture(images = [{ url: fresh, photoId: 'photo-15_33' }]) {
    const page = new EventEmitter();
    page.isClosed = () => false;
    page.evaluate = async (fn, imageUrl) => {
        if (!imageUrl) return images;
        imageUrl = imageUrl.source || imageUrl;
        page.emit('response', {
            ok: () => true, url: () => imageUrl,
            headers: () => ({ 'content-type': 'image/png' }), body: async () => bytes(),
        });
    };
    return page;
}

test('cached bytes are used without browser or external download', async (t) => {
    const { directory, cache } = setup(t), path = join(directory, 'cached.png');
    writeFileSync(path, bytes()); cache.set(url, { path, mimeType: 'image/png' });
    const prepare = createBrowserImageCacheRecovery({ cache, directory, requests: [], recover: () => assert.fail('cache hit must not reopen') });
    assert.equal(await prepare(url), 'data:image/png;base64,' + bytes().toString('base64'));
});

test('missing file and concurrent photos of one post share one browser recovery', async (t) => {
    const { directory, cache } = setup(t);
    cache.set(url, { path: join(directory, 'deleted.image') });
    const requests = [url, other].map((imageUrl) => ({ sourceUrl, imageUrl }));
    let calls = 0;
    const prepare = createBrowserImageCacheRecovery({ cache, directory, requests, recover: async (request) => {
        calls += 1; assert.equal(request.sourceUrl, sourceUrl); assert.equal(request.images.length, 2);
        return request.images.map(({ imageUrl }) => ({ imageUrl, buffer: bytes(), mimeType: 'image/png' }));
    } });
    const results = await Promise.all([prepare(url), prepare(other), prepare(url)]);
    assert.equal(calls, 1); assert.equal(results.length, 3);
    assert.ok(results.every((value) => value.startsWith('data:image/')));
    assert.equal(JSON.parse(readFileSync(join(directory, 'manifest.json'))).length, 2);
    assert.equal(cache.get(url).width, 800);
});

test('unresolved media stay unresolved and a post is not reopened on every retry', async (t) => {
    const { directory, cache } = setup(t); let calls = 0;
    const prepare = createBrowserImageCacheRecovery({ cache, directory, requests: [{ sourceUrl, imageUrl: url }], recover: async () => { calls += 1; return []; } });
    for (let i = 0; i < 2; i++) await assert.rejects(prepare(url), { code: 'BROWSER_IMAGE_UNAVAILABLE' });
    assert.equal(calls, 1); assert.equal(cache.size, 0);
    await assert.rejects(prepare(other), { code: 'BROWSER_IMAGE_UNAVAILABLE' });
});

test('a different photo is never used solely because it occupies the first gallery slot', () => {
    assert.equal(matchRecoveredImage({ imageUrl: url }, [{ url: other }]), null);
    assert.equal(matchRecoveredImage({ imageUrl: url, photoId: '-15_33' }, [{ url: other, photoId: 'photo-15_34' }]), null);
    assert.equal(matchRecoveredImage({ imageUrl: url, photoId: '-15_33' }, [{ url, photoId: 'photo-15_34' }]), null);
    assert.equal(matchRecoveredImage({ imageUrl: 'https://a.example/image.jpg' }, [{ url: 'https://b.example/image.jpg' }]), null);
});

test('renewed CDN URLs and normalized attachment IDs retain exact image identity', () => {
    assert.equal(matchRecoveredImage({ imageUrl: url }, [{ url: fresh }]).url, fresh);
    assert.equal(matchRecoveredImage({ imageUrl: url, photoId: '-15_33' }, [{ url: other, photoId: 'photo-15_33' }]).url, other);
});

test('recovery reads the final post-scroll snapshot using existing dwell and browser responses', async (t) => {
    const { directory } = setup(t), page = pageFixture();
    let finalCalled = false;
    const result = await recoverPostImagesInBrowser({ sourceUrl, images: [{ imageUrl: url }], snapshotDirectory: directory,
        review: async (options) => {
            assert.equal(options.url, sourceUrl); assert.equal(options.allowRelatedApi, false);
            assert.equal(options.beforeScrollWaitMs, 25_000);
            assert.ok(options.settleScrollSteps > 0);
            assert.equal(Object.hasOwn(options, 'minimumOpenMs'), false);
            assert.equal(Object.hasOwn(options, 'allowShortMinimumOpen'), false);
            options.onPageReady(page);
            await options.onFinalSnapshot({ page, snapshot: { imageUrls: [fresh] } }); finalCalled = true;
        },
    });
    assert.equal(finalCalled, true); assert.equal(result.length, 1);
    assert.equal(result[0].imageUrl, url); assert.equal(result[0].recoveredUrl, fresh);
    assert.deepEqual(result[0].buffer, bytes());
    assert.ok(readdirSync(directory).some((name) => name.endsWith('.post.json')));
});

test('manual closure before the final snapshot leaves missing media unresolved without reopening', async () => {
    assert.deepEqual(await recoverPostImagesInBrowser({ sourceUrl, images: [{ imageUrl: url }], review: async () => ({ browserClosedAfterDom: true }) }), []);
});

test('normal source capture saves media collected during scroll and final capture', async (t) => {
    const { directory, cache } = setup(t), page = pageFixture();
    const capture = createBrowserImageCapture({ cache, directory });
    await capture(page, []);
    // A user scroll loads this response before final extraction.
    page.emit('response', { ok: () => true, url: () => url, headers: () => ({ 'content-type': 'image/png' }), body: async () => bytes() });
    await capture(page, [{ imageUrls: [url] }, { imageUrls: [other] }]);
    assert.equal(cache.size, 2);
    assert.equal(cache.get(url).recovery, 'source-capture-browser');
    const prepare = createBrowserImageCacheRecovery({ cache, directory, requests: [], recover: () => assert.fail('no redundant reopening') });
    assert.match(await prepare(other), /^data:image\/png;base64,/);
});

test('non-image responses are not cached or sent to Vision', async (t) => {
    const { directory, cache } = setup(t), page = pageFixture();
    page.evaluate = async (_fn, imageUrl) => page.emit('response', { ok: () => true, url: () => imageUrl, headers: () => ({ 'content-type': 'text/html' }) });
    await createBrowserImageCapture({ cache, directory })(page, [{ imageUrls: [url] }]);
    assert.equal(cache.size, 0);
});

test('saving the final card consumes the browser cache bytes without a network redownload', async (t) => {
    const { directory, cache } = setup(t);
    const { prepareEventImages } = await import('../../src/features/events/eventAssets.js');
    const { cachedParserImageAsset } = await import('../../src/features/scrapers/browserImageCacheRecovery.js');
    const path = join(directory, 'poster.png'); writeFileSync(path, bytes());
    cache.set(url, { path, mimeType: 'image/png' });
    const prepare = createBrowserImageCacheRecovery({ cache, directory, requests: [], recover: () => assert.fail('cache hit') });
    const originalFetch = globalThis.fetch;
    globalThis.fetch = () => assert.fail('final poster must not be downloaded outside the browser');
    t.after(() => { globalThis.fetch = originalFetch; });
    const result = await prepareEventImages({ events: [{ title: 'Poster', eventDate: '2026-10-30', imageIndexes: [1] }],
        sourceKey: 'test', itemId: '1229', imageUrls: [url], dataDirectory: directory,
        fetchImage: (imageUrl) => cachedParserImageAsset(prepare, imageUrl),
    });
    assert.equal(result.length, 1); assert.equal(result[0].imagePaths.length, 1);
    assert.deepEqual(readFileSync(join(directory, result[0].imagePaths[0])), bytes());
});

test('existing minimum dwell and intermediate scroll captures remain in the shared collector', () => {
    const browser = readFileSync(new URL('../../src/infrastructure/browser/browserGrabber.js', import.meta.url), 'utf8');
    const publicSource = readFileSync(new URL('../../src/platforms/vk/vkPublicScraper.js', import.meta.url), 'utf8');
    assert.match(browser, /Math\.max\(\s*EVENT_REVIEW_MINIMUM_OPEN_MS,\s*Math\.min\(5 \* 60_000, requestedMinimumOpenMs\)/u);
    assert.match(browser, /await captureDurableDomSnapshot\('scan-' \+ \(step \+ 1\)\)/u);
    assert.match(publicSource, /minimumLifetimeMs - \(Date\.now\(\) - openedAtMs\)/u);
    assert.ok(browser.indexOf('await onFinalSnapshot({ page, snapshot: extracted })') > browser.indexOf("await captureDurableDomSnapshot('after-minimum-dwell')"));
    const app = readFileSync(new URL('../../src/app/botApplication.js', import.meta.url), 'utf8');
    assert.match(app, /minimumPageLifetimeMs: 180_000/u);
    assert.match(app, /imageUrls: \[await prepareImage\(imageUrl\)\]/u);
    assert.match(app, /const allowVkApiEnrichment = false/u);
});

test('an evicted browser response is reloaded in the same page', async (t) => {
    const { directory, cache } = setup(t), page = pageFixture();
    const capture = createBrowserImageCapture({ cache, directory });
    await capture(page, []);
    page.emit('response', { ok: () => true, url: () => url, headers: () => ({ 'content-type': 'image/png' }), body: async () => { throw Error('Resource evicted'); } });
    await capture(page, [{ imageUrls: [url] }]);
    assert.equal(cache.size, 1);
    assert.deepEqual(readFileSync(cache.get(url).path), bytes());
});

test('a stale bootstrap image URL does not hide a renewed matching DOM image', async () => {
    const page = pageFixture(), evaluate = page.evaluate;
    page.evaluate = async (fn, imageUrl) => imageUrl === url ? undefined : evaluate(fn, imageUrl);
    const result = await recoverPostImagesInBrowser({ sourceUrl, images: [{ imageUrl: url }],
        review: async (options) => {
            options.onPageReady(page);
            await options.onFinalSnapshot({ page, snapshot: { imageUrls: [url, fresh] } });
        },
    });
    assert.equal(result.length, 1);
    assert.equal(result[0].recoveredUrl, fresh);
});


test('browser memory-cache bytes can be read in-page when no response event is emitted', async (t) => {
    const { directory, cache } = setup(t), page = pageFixture();
    let inPageReads = 0;
    page.evaluate = async (_fn, argument) => {
        if (argument && typeof argument === 'object') {
            assert.equal(argument.source, url); inPageReads += 1;
            return 'data:image/png;base64,' + bytes().toString('base64');
        }
    };
    await createBrowserImageCapture({ cache, directory })(page, [{ imageUrls: [url] }]);
    assert.equal(inPageReads, 1);
    assert.deepEqual(readFileSync(cache.get(url).path), bytes());
});

test('interrupted browser capture reopens once and concurrent image requests share retries', async (t) => {
    const {directory, cache} = setup(t); let calls = 0;
    const prepare = createBrowserImageCacheRecovery({directory, cache, requests: [{sourceUrl,imageUrl:url}],
        recover: async () => {
            if (++calls === 1) throw Object.assign(new Error('closed'), {code: 'BROWSER_IMAGE_RECOVERY_INTERRUPTED'});
            return [{imageUrl:url,buffer:bytes(),mimeType:'image/png'}];
        }});
    const results = await Promise.all([prepare(url), prepare(url)]);
    assert.equal(calls, 2);
    assert.ok(results.every(result => result.startsWith('data:image/png;base64,')));
});

test('repeated closure is skipped after five attempts and does not reopen forever', async (t) => {
    const {directory, cache} = setup(t); let calls = 0;
    const prepare = createBrowserImageCacheRecovery({directory, cache, requests: [{sourceUrl,imageUrl:url}],
        recover: async () => { calls++; throw Object.assign(new Error('closed'), {code:'BROWSER_IMAGE_RECOVERY_INTERRUPTED'}); }});
    await assert.rejects(prepare(url), {code:'BROWSER_IMAGE_UNAVAILABLE'});
    await assert.rejects(prepare(url), {code:'BROWSER_IMAGE_UNAVAILABLE'});
    assert.equal(calls,5);
    assert.equal(cache.size,0);
});

test('scroll capture consumes observed image bytes without launching recovery requests', async(t)=>{
 const {directory,cache}=setup(t),page=pageFixture();
 page.evaluate=()=>assert.fail('passive capture must not reload media');
 const capture=createBrowserImageCapture({directory,cache});
 await capture(page,[]);
 page.emit('response',{ok:()=>true,url:()=>url,headers:()=>({'content-type':'image/png'}),body:async()=>bytes()});
 await capture(page,[{imageUrls:[url,other]}],{passive:true});
 assert.equal(cache.size,1);assert.ok(cache.has(url));
});
test('CORS failure never opens a direct image tab',async(t)=>{
 const {directory,cache}=setup(t),page=pageFixture();
 page.evaluate=async()=>{throw Error('CORS blocked');};
 page.context=()=>({newPage:()=>assert.fail('must not open naked image URL')});
 await createBrowserImageCapture({directory,cache})(page,[{imageUrls:[url]}]);
 assert.equal(cache.size,0);
});


test('scroll cache checks do not read image bytes; actual consumption still does', async (t) => {
    const { default: fs } = await import('node:fs');
    const { syncBuiltinESMExports } = await import('node:module');
    const { directory, cache } = setup(t), path = join(directory, 'cached.png');
    writeFileSync(path, bytes());
    const urls = Array.from({ length: 40 }, (_, i) => url + '&n=' + i);
    for (const imageUrl of urls) cache.set(imageUrl, { path, mimeType: 'image/png' });
    const page = pageFixture();
    page.evaluate = () => assert.fail('valid cached images must not be reloaded');
    const original = fs.readFileSync; let reads = 0;
    fs.readFileSync = function(file, ...args) {
        if (String(file) === path) reads++;
        return original.call(this, file, ...args);
    };
    syncBuiltinESMExports();
    try {
        const capture = createBrowserImageCapture({ cache, directory });
        await capture(page, [{ imageUrls: urls }], { passive: true });
        await capture(page, [{ imageUrls: urls }]);
        assert.equal(reads, 0);
        const prepare = createBrowserImageCacheRecovery({ cache, directory, requests: [] });
        assert.equal(await prepare(urls[0]), 'data:image/png;base64,' + bytes().toString('base64'));
        assert.equal(reads, 1);
    } finally { fs.readFileSync = original; syncBuiltinESMExports(); }
});

test('empty legacy and truncated known-size hash files are repaired by browser recovery', async (t) => {
    const { createHash } = await import('node:crypto');
    for (const size of [0, 512]) {
        const { directory, cache } = setup(t), buffer = bytes();
        const path = join(directory, createHash('sha256').update(buffer).digest('hex') + '.image');
        writeFileSync(path, buffer.subarray(0, size));
        cache.set(url, { path, mimeType: 'image/png', ...(size ? { byteLength: buffer.length } : {}) });
        let calls = 0;
        const prepare = createBrowserImageCacheRecovery({ cache, directory, requests: [{ sourceUrl, imageUrl: url }],
            recover: async ({ images }) => {
                calls++; assert.deepEqual(images.map(image => image.imageUrl), [url]);
                return [{ imageUrl: url, buffer, mimeType: 'image/png' }];
            } });
        assert.equal(await prepare(url), 'data:image/png;base64,' + buffer.toString('base64'));
        assert.equal(calls, 1);
        assert.deepEqual(readFileSync(path), buffer);
        assert.equal(cache.get(url).byteLength, buffer.length);
    }
});

test('grouped recovery preserves first photo identity and excludes cached siblings and foreign results', async (t) => {
    const { directory, cache } = setup(t), path = join(directory, 'cached.png');
    writeFileSync(path, bytes()); cache.set(other, { path, mimeType: 'image/png' });
    const first = { sourceUrl, imageUrl: url, photoId: 'photo-15_33' };
    const requests = [first, { ...first, photoId: 'photo-15_99' }, { sourceUrl, imageUrl: other }];
    const prepare = createBrowserImageCacheRecovery({ cache, directory, requests, recover: async ({ images }) => {
        assert.deepEqual(images, [first]);
        return [url, fresh].map(imageUrl => ({ imageUrl, buffer: bytes(), mimeType: 'image/png' }));
    } });
    await prepare(url);
    assert.equal(cache.size, 2);
    assert.equal(cache.has(fresh), false);
    assert.equal(cache.get(other).path, path);
});

test('a failed real cache read is recovered even when file metadata looks usable', async (t) => {
    const { default: fs } = await import('node:fs');
    const { syncBuiltinESMExports } = await import('node:module');
    const { directory, cache } = setup(t), path = join(directory, 'cached.png');
    writeFileSync(path, bytes()); cache.set(url, { path, mimeType: 'image/png' });
    const original = fs.readFileSync; let failed = false, recovered = 0;
    fs.readFileSync = function(file, ...args) {
        if (!failed && String(file) === path) { failed = true; throw Error('temporary read failure'); }
        return original.call(this, file, ...args);
    };
    syncBuiltinESMExports();
    try {
        const prepare = createBrowserImageCacheRecovery({ cache, directory, requests: [{ sourceUrl, imageUrl: url }],
            recover: async ({ images }) => {
                recovered++; assert.equal(images.length, 1);
                return [{ imageUrl: url, buffer: bytes(), mimeType: 'image/png' }];
            } });
        assert.ok((await prepare(url)).startsWith('data:image/png;base64,'));
        assert.equal(recovered, 1);
    } finally { fs.readFileSync = original; syncBuiltinESMExports(); }
});

test('a full browser response map still accepts a refreshed response for a known image', async (t) => {
    const { directory, cache } = setup(t), page = pageFixture();
    page.evaluate = () => assert.fail('passive recovery must use the refreshed response');
    const capture = createBrowserImageCapture({ cache, directory });
    await capture(page, []);
    for (let i = 0; i < 2000; i++) page.emit('response', {
        ok: () => true, url: () => i === 0 ? url : other + '?n=' + i,
        headers: () => ({ 'content-type': 'image/png' }), body: async () => { throw Error('evicted'); },
    });
    page.emit('response', { ok: () => true, url: () => url,
        headers: () => ({ 'content-type': 'image/png' }), body: async () => bytes() });
    await capture(page, [{ imageUrls: [url] }], { passive: true });
    assert.deepEqual(readFileSync(cache.get(url).path), bytes());
});
