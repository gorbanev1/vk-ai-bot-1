import { readFileSync, writeFileSync, existsSync, mkdirSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { detectRasterImageDimensions } from '../events/eventImageSelection.js';
import { createVkLaunchStagger } from './vkLaunchStagger.js';

// Shared by both parser phases, scoped to their raw-image cache (one run).
const recoveryRuns = new WeakMap();
const isClosedRecoveryPage = error => /BROWSER_IMAGE_RECOVERY_CLOSED/.test(error?.code || '') ||
    /Target page, context or browser has been closed|Browser page closed|page has been closed/iu.test(String(error?.message || ''));
function recoverySourceKey(value) {
    try {
        const url = new URL(value);
        if (/^(?:www\.)?vk\.(?:ru|com)$/iu.test(url.hostname) && /^\/wall-?\d+_\d+\/?$/u.test(url.pathname)) {
            return 'https://vk.ru' + url.pathname.replace(/\/$/u, '');
        }
        if (url.hostname === 't.me' && /^\/(?:s\/)?\w+\/\d+\/?$/u.test(url.pathname)) {
            return 'https://t.me' + url.pathname.replace(/^\/s\//u, '/').replace(/\/$/u, '');
        }
    } catch {}
    return String(value || '');
}

export const CACHE_RECOVERY_SETTLE_MS = 25_000;
const MAX_IMAGE_BYTES = 20 * 1024 * 1024;
const photoIdentity = (value) => String(value || '').match(/(?:photo)?(-?\d+_\d+)/iu)?.[1] || '';
const sameImagePath = (left, right) => {
    try {
        const a = new URL(left), b = new URL(right);
        const vkCdn = (host) => /(?:^|\.)(?:userapi\.com|vkuserphoto\.ru|vkuseraudio\.net|vk\.com|vk\.ru)$/iu.test(host);
        return a.pathname.length > 1 && a.pathname === b.pathname &&
            (a.origin === b.origin || (vkCdn(a.hostname) && vkCdn(b.hostname)));
    } catch { return false; }
};
export function matchRecoveredImage(request, images) {
    const identity = photoIdentity(request.photoId);
    const candidates = images.filter((image) => !identity || !photoIdentity(image.photoId) || photoIdentity(image.photoId) === identity);
    return candidates.find((image) => image.url === request.imageUrl) ||
        candidates.find((image) => sameImagePath(image.url, request.imageUrl)) ||
        (identity ? candidates.find((image) => photoIdentity(image.photoId) === identity) : null) || null;
}

function observeImages(page) {
    const responses = new Map();
    page.on('response', (response) => {
        if ((responses.size < 2000 || responses.has(response.url())) && response.ok() && /^image\//iu.test(response.headers()['content-type'] || '')) responses.set(response.url(), response);
    });
    return responses;
}

// A browser image load exposes its response body without cross-origin fetch
// permissions. This also handles images loaded before the observer attached.
// No context.request, Node fetch, or VK API is involved.
async function readBrowserImage(page, url, responses, { passive = false } = {}) {
    const readResponse = async () => {
        const response = responses.get(url);
        if (!response || Number(response.headers()['content-length'] || 0) > MAX_IMAGE_BYTES) return null;
        try {
            const buffer = await response.body();
            const mimeType = String(response.headers()['content-type'] || '').split(';')[0];
            if (!buffer.length || buffer.length > MAX_IMAGE_BYTES || !/^image\//iu.test(mimeType)) return null;
            return { buffer, mimeType };
        } catch { return null; }
    };
    const loaded = await readResponse();
    if (loaded) return loaded;
    if (passive) return null;
    // Read only an image already rendered in the source DOM. A tainted
    // canvas is not a reason to navigate to the CDN or fetch the URL directly.
    const dataUrl = await page.evaluate(({ source, maximum }) => {
        const image = [...document.images].find(img => (img.currentSrc || img.src) === source);
        if (!image?.complete || !image.naturalWidth || !image.naturalHeight) return '';
        if (image.naturalWidth * image.naturalHeight > maximum) return '';
        const canvas = document.createElement('canvas');
        canvas.width = image.naturalWidth; canvas.height = image.naturalHeight;
        canvas.getContext('2d').drawImage(image, 0, 0);
        return canvas.toDataURL('image/png');
    }, { source: url, maximum: MAX_IMAGE_BYTES }).catch(() => '');
    const encoded = String(dataUrl || '').match(/^data:(image\/[^;]+);base64,(.+)$/su);
    if (encoded) {
        const buffer = Buffer.from(encoded[2], 'base64');
        if (buffer.length && buffer.length <= MAX_IMAGE_BYTES) return { buffer, mimeType: encoded[1] };
    }
    return await readResponse();

}

// Presence checks during scrolling must not read and base64-encode every
// already captured image again. Actual Vision consumption still reads bytes.
function hasCachedImage(cache, url) {
    const image = cache.get(url);
    try {
        if (!image?.path) return false;
        const stat = statSync(image.path);
        return stat.isFile() && stat.size > 0 &&
            (!image.byteLength || stat.size === image.byteLength);
    } catch { return false; }
}
function readCachedImage(cache, url) {
    const image = cache.get(url);
    try {
        if (image?.path && existsSync(image.path)) {
            const buffer = readFileSync(image.path);
            if (buffer.length && (!image.byteLength || buffer.length === image.byteLength)) return `data:${image.mimeType || 'image/jpeg'};base64,${buffer.toString('base64')}`;
        }
    } catch {}
    return '';
}
function saveImage(cache, directory, image) {
    const sha256 = createHash('sha256').update(image.buffer).digest('hex');
    mkdirSync(directory, { recursive: true });
    const path = resolve(directory, `${sha256}.image`);
    let existingSize = 0;
    try { existingSize = statSync(path).size; } catch {}
    // A previous interrupted write must not permanently poison a hash path.
    if (existingSize !== image.buffer.length) writeFileSync(path, image.buffer);
    cache.set(image.imageUrl, { ...detectRasterImageDimensions(image.buffer), path, sha256, byteLength: image.buffer.length,
        mimeType: image.mimeType, recoveredUrl: image.recoveredUrl || image.imageUrl,
        recovery: image.recovery || 'source-post-browser' });
}
function saveManifest(cache, directory) {
    mkdirSync(directory, { recursive: true });
    writeFileSync(resolve(directory, 'manifest.json'), JSON.stringify([...cache]), 'utf8');
}

// Called by existing collectors: attach before scrolling; consume the union of
// their intermediate and final post captures while the same tab is still open.
export function createBrowserImageCapture({ cache, directory, trace = () => {} }) {
    const observers = new WeakMap();
    return async (page, items, { passive = false } = {}) => {
        if (!page || page.isClosed()) return;
        if (!observers.has(page)) observers.set(page, observeImages(page));
        const responses = observers.get(page);
        const urls = [...new Set(items.flatMap((item) => Array.isArray(item.imageUrls) ? item.imageUrls : []))]
            .filter((url) => /^https?:\/\//iu.test(url) && !hasCachedImage(cache, url));
        let next = 0, captured = 0;
        await Promise.all(Array.from({ length: Math.min(4, urls.length) }, async () => {
            while (next < urls.length && !page.isClosed()) {
                const url = urls[next++];
                const asset = await readBrowserImage(page, url, responses, { passive });
                if (asset) { saveImage(cache, directory, { ...asset, imageUrl: url, recovery: 'source-capture-browser' }); captured += 1; }
            }
        }));
        if (captured || (!passive && urls.length)) saveManifest(cache, directory);
        if (urls.length) trace('browser.capture-media', {
            requested: urls.length, captured, unresolved: urls.length - captured,
            phase: passive ? 'scroll-observation' : 'final-recovery',
        });
    };
}

export const SOURCE_IMAGE_RETRY_ACTIONS = 4;
const isVkCarousel = (sourceUrl, images) => /https?:\/\/(?:www\.)?vk\.(?:ru|com)\/.*wall-?\d+_\d+/iu.test(sourceUrl || '') && images.length > 1;
export const isUnavailableBrowserImage = error => error?.code === 'BROWSER_IMAGE_UNAVAILABLE';
const defaultSleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function imageActionPause(sleep, random) {
    const delay = 5_000 + Math.floor(Math.min(1, Math.max(0, Number(random()) || 0)) * 5_000);
    await sleep(delay);
}

// Browser equivalent of "Load image": retry the existing DOM node in its
// authenticated post/message, or click a source-owned retry control.
export async function reloadSourceDomImage(page, source) {
    return page.evaluate(url => {
        const image = [...document.images].find(img => (img.currentSrc || img.src) === url);
        if (!image) return false;
        image.scrollIntoView({ block: 'center', behavior: 'instant' });
        const container = image.closest('[data-photo-id], [data-testid*="photo"], figure') || image.parentElement;
        const retry = [...(container?.querySelectorAll('button, [role="button"]') || [])].find(node =>
            /^(?:загрузить изображение|загрузить фото|повторить загрузку|load image|retry)$/iu.test(
                String(node.textContent || node.getAttribute('aria-label') || '').trim()));
        if (retry) retry.click();
        else {
            // Preserve the original signed URL and its page/referrer context.
            const original = image.currentSrc || image.src;
            image.loading = 'eager';
            image.removeAttribute('src');
            image.src = original;
        }
        return true;
    }, source);
}

export async function recoverPostImagesInBrowser({ sourceUrl, images, dataDirectory = './data',
    trace = () => {}, review = null, snapshotDirectory = '', sleep = defaultSleep,
    random = Math.random, carousel = isVkCarousel(sourceUrl, images), hasAnnouncementDate = false,
    retryBudget = { remaining: carousel ? 1 : images.length === 1 && hasAnnouncementDate ? 7 : SOURCE_IMAGE_RETRY_ACTIONS } }) {
    const origin = new URL(sourceUrl);
    if (!/^https?:$/iu.test(origin.protocol) ||
        /(?:^|\.)(?:userapi\.com|vkuserphoto\.ru|vkuseraudio\.net)$/iu.test(origin.hostname) ||
        /\.(?:jpe?g|png|webp|gif)(?:$|[?#])/iu.test(sourceUrl) ||
        (/(?:^|\.)vk\.(?:ru|com)$/iu.test(origin.hostname) &&
            !/wall-?\d+_\d+|\/im(?:\/|$)|\/mail|\/convo\//iu.test(origin.pathname + origin.search))) {
        throw Object.assign(new Error('Recovery requires an original post/message, not an image URL'), {code:'BROWSER_IMAGE_UNAVAILABLE'});
    }
    const openReview = review || (await import('../../infrastructure/browser/browserGrabber.js')).openEventLinkForReview;
    let responses = new Map(), finalSnapshotRead = false;
    const recovered = [], bodyReads = new Set();
    let sourcePage = null, closedBeforeFinal = false, responseListener = null;
    const retainResponse = response => {
        if (!response.ok() || !/^image\//iu.test(response.headers()['content-type'] || '')) return;
        if (Number(response.headers()['content-length'] || 0) > MAX_IMAGE_BYTES) return;
        const matches = images.filter(request => matchRecoveredImage(request, [{url: response.url()}]));
        if (!matches.length) return;
        const task = (async () => {
            try {
                const buffer = await response.body();
                if (!buffer.length || buffer.length > MAX_IMAGE_BYTES) return;
                for (const request of matches) if (!recovered.some(image => image.imageUrl === request.imageUrl)) {
                    recovered.push({imageUrl: request.imageUrl, recoveredUrl: response.url(), buffer,
                        mimeType: String(response.headers()['content-type']).split(';')[0]});
                }
            } catch {}
        })();
        bodyReads.add(task);
        void task.finally(() => bodyReads.delete(task));
    };
    const attachCapture = page => {
        if (sourcePage === page) return;
        sourcePage = page;
        responses = observeImages(page);
        responseListener = retainResponse;
        page.on('response', responseListener);
        page.once('close', () => { if (!finalSnapshotRead) closedBeforeFinal = true; });
    };
    try {
    const reviewResult = await openReview({ url: sourceUrl, dataDirectory, allowRelatedApi: false, separateTab: true,
        beforeScrollWaitMs: CACHE_RECOVERY_SETTLE_MS, settleScrollSteps: 3, trace,
        // Attach before navigation so fast media responses are retained too.
        onPageCreated: attachCapture,
        onPageReady: attachCapture,
        onFinalSnapshot: async ({page, snapshot}) => {
            let visible = [];
            const pending = () => images.filter(request => !recovered.some(image => image.imageUrl === request.imageUrl));
            const collect = async () => {
                visible = await page.evaluate(() => [...document.images].map(image => ({
                    url: image.currentSrc || image.src,
                    photoId: (image.closest('a[href]')?.getAttribute('href') || '').match(/photo-?\d+_\d+/i)?.[0] || '',
                })).filter(image => /^https?:\/\//i.test(image.url)));
                const candidates = [...visible, ...[...responses.keys()].map(url => ({url,photoId:''}))];
                for (const request of pending()) {
                    const remaining = [...candidates];
                    while (remaining.length) {
                        const match = matchRecoveredImage(request, remaining);
                        if (!match) break;
                        remaining.splice(remaining.indexOf(match), 1);
                        const asset = await readBrowserImage(page, match.url, responses);
                        if (asset) {
                            if (!recovered.some(image => image.imageUrl === request.imageUrl)) recovered.push({imageUrl:request.imageUrl,recoveredUrl:match.url,...asset});
                            break;
                        }
                    }
                }
            };
            await collect();
            let cycle = 0;
            while (pending().length && retryBudget.remaining > 0) {
                retryBudget.remaining--;
                await imageActionPause(sleep, random);
                let reloaded = false;
                if (cycle % 2 === 0) {
                    const targets = [...new Set(pending().map(request => matchRecoveredImage(request, visible)?.url).filter(Boolean))]
                        .slice(0, carousel ? 1 : undefined);
                    for (const [index, target] of targets.entries()) {
                        if (index) await imageActionPause(sleep, random);
                        reloaded = await reloadSourceDomImage(page, target) || reloaded;
                    }
                }
                if (!reloaded) {
                    // Reopen only the parent post/message in this same tab.
                    await page.goto(sourceUrl, {waitUntil:'domcontentloaded',timeout:45_000});
                    await sleep(CACHE_RECOVERY_SETTLE_MS);
                } else await imageActionPause(sleep, random);
                trace('browser.image.retry', {sourceUrl,cycle:++cycle,remaining:retryBudget.remaining,
                    action:reloaded?'source-dom-load-image':'reopen-source'});
                await collect();
            }
            if (snapshotDirectory) {
                mkdirSync(snapshotDirectory, {recursive:true});
                const key = createHash('sha256').update(sourceUrl).digest('hex');
                const html = typeof page.content === 'function' ? await page.content() : snapshot?.html;
                writeFileSync(resolve(snapshotDirectory, key+'.post.json'), JSON.stringify({
                    sourceUrl,capturedAt:new Date().toISOString(),snapshot:{...snapshot,html,imageUrls:visible.map(image=>image.url)},
                    skippedImageUrls:pending().map(image=>image.imageUrl),
                }), 'utf8');
            }
            finalSnapshotRead = true;
            trace('browser.complete', {sourceUrl,requested:images.length,recovered:recovered.length,
                skippedImageUrls:pending().map(image=>image.imageUrl)});
        },
    });
    closedBeforeFinal = Boolean(reviewResult?.browserClosedAfterDom) || (closedBeforeFinal && !reviewResult?.browserErrorAfterDom);
    } catch (error) {
        if (!isClosedRecoveryPage(error)) throw error;
        closedBeforeFinal = true;
    } finally {
        if (responseListener) sourcePage?.off('response', responseListener);
        await Promise.all(bodyReads);
    }
    if (closedBeforeFinal) {
        trace('browser.manual-close', {sourceUrl, recovered: recovered.length,
            skippedImageUrls: images.filter(request => !recovered.some(image => image.imageUrl === request.imageUrl)).map(image => image.imageUrl)});
        // Closing a tab is not a request to reopen it; missing bytes stay missing.
        return recovered;
    }
    if (!finalSnapshotRead) throw Object.assign(new Error('Browser closed before final image snapshot'), {code:'BROWSER_IMAGE_RECOVERY_INTERRUPTED'});
    return recovered;
}

export function createBrowserImageCacheRecovery({ cache, requests, directory, recover = recoverPostImagesInBrowser, trace = () => {}, sleep = defaultSleep, random = Math.random }) {
    let run = recoveryRuns.get(cache);
    if (!run) {
        run = {pending: new Map(), waitForLaunch: createVkLaunchStagger({
            // Existing recovery opening interval; only starts are serialized.
            makeGapMs: () => 5_000 + Math.min(10_000, Math.max(0, Math.floor(random() * 10_001))),
            sleep,
            onGap: data => trace('browser.open-gap', data),
        })};
        recoveryRuns.set(cache, run);
    }
    const groups = new Map(), pending = run.pending, sourceByUrl = new Map();
    for (const request of requests) {
        if (!request.sourceUrl || !request.imageUrl) continue;
        const sourceKey = recoverySourceKey(request.sourceUrl);
        const group = groups.get(sourceKey) || new Map();
        if (!group.has(request.imageUrl)) group.set(request.imageUrl, request);
        groups.set(sourceKey, group);
        if (!sourceByUrl.has(request.imageUrl)) sourceByUrl.set(request.imageUrl, sourceKey);
    }
    return async function prepare(imageUrl, sourceUrl) {
        const cached = readCachedImage(cache, imageUrl);
        if (cached) return cached;
        const origin = recoverySourceKey(sourceUrl || sourceByUrl.get(imageUrl));
        if (!origin) throw Object.assign(new Error('No source post for missing cached image'), { code: 'BROWSER_IMAGE_UNAVAILABLE' });
        if (!pending.has(origin)) pending.set(origin, (async () => {
            const group = groups.get(origin);
            const images = [...(group?.values() || [])];
            if (!group?.has(imageUrl)) images.push({ sourceUrl: origin, imageUrl });
            // This URL already failed a real read, even if its stat looks valid.
            const missing = images.filter((item) => item.imageUrl === imageUrl || !hasCachedImage(cache, item.imageUrl));
            const missingUrls = new Set(missing.map((item) => item.imageUrl));
            let recovered = [];
            const carousel = isVkCarousel(origin, images);
            const hasAnnouncementDate = images.some(image => image.hasAnnouncementDate);
            const singleDatedImage = images.length === 1 && Number(images[0]?.sourceImageCount || 1) === 1 && hasAnnouncementDate;
            const retryBudget = {remaining:carousel ? 1 : singleDatedImage ? 7 : SOURCE_IMAGE_RETRY_ACTIONS};
            await run.waitForLaunch(origin);
            while (true) {
                try {
                    recovered = await recover({sourceUrl:origin,images:missing,trace,snapshotDirectory:directory,
                        retryBudget,carousel,hasAnnouncementDate,sleep,random});
                    break;
                } catch (error) {
                    const interrupted = error?.code === 'BROWSER_IMAGE_RECOVERY_INTERRUPTED' ||
                        /Target page, context or browser has been closed|Browser closed before final image snapshot|net::ERR_|Navigation.*timeout|page.goto.*Timeout/iu.test(String(error?.message || ''));
                    if (isUnavailableBrowserImage(error) || isClosedRecoveryPage(error)) break;
                    if (!interrupted) throw error;
                    if (retryBudget.remaining <= 0) break;
                    retryBudget.remaining--;
                    await imageActionPause(sleep, random);
                    trace('browser.reopen-interrupted', {sourceUrl:origin,remaining:retryBudget.remaining});
                }
            }
            for (const image of recovered) {
                if (missingUrls.has(image.imageUrl)) saveImage(cache, directory, image);
            }
            saveManifest(cache, directory);
        })());
        await pending.get(origin);
        const result = readCachedImage(cache, imageUrl);
        if (!result) throw Object.assign(new Error('Image still missing after original post browser recovery'), { code: 'BROWSER_IMAGE_UNAVAILABLE' });
        return result;
    };
}

// Preserve URL identities for matching; only the transport receives local bytes.
export async function cachedParserImageAsset(prepareImage, url) {
    const dataUrl = await prepareImage(url);
    const match = String(dataUrl).match(/^data:(image\/[^;]+);base64,(.+)$/su);
    if (!match) throw new Error('Parser image cache returned no image bytes');
    return { buffer: Buffer.from(match[2], 'base64'), contentType: match[1], finalUrl: url };
}
