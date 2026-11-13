import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { getTelegramEventVideo, isTelegramVideoSource } from '../../src/platforms/telegram/telegramEventVideo.js';
import { getEventPosterSafetyAssessment, getEventSourceMediaBindingAssessment } from '../../src/features/events/eventProvenance.js';
import { getVisionBoundSourcePosterPaths } from '../../src/features/events/visionBoundSourcePoster.js';
import { getEventImageFactForDelivery, isMultiAnnouncementForImageDelivery, shouldRejectImageFactForDelivery } from '../../src/features/events/eventImageDeliveryPolicy.js';
import { detectRasterImageDimensions } from '../../src/features/events/eventImageSelection.js';

const app = readFileSync(new URL('../../src/app/botApplication.js', import.meta.url), 'utf8');
const boundPath = 'telegram_announcements/kurazhcity/4127-1.jpg';
const sourcePath = 'vk_announcements/rb_diesel/13935-4.jpg';
function fixture() {
    const fact = { index: 1, poster: true, posterConfidence: 99, imageType: 'poster',
        participants: 'RammPage', dates: '24 October', venue: 'Diesel Hall', imagePath: boundPath };
    return { title: 'RammPage', eventDate: '2026-10-24', participants: 'RammPage',
        venue: 'Diesel Hall', isMultiAnnouncement: true,
        imagePaths: [boundPath], posterImageIndex: 1, posterMatchStatus: 'verified_title_date_poster',
        posterVisionFacts: [fact],
        sourceImagePaths: ['vk/post-1.jpg', 'vk/post-2.jpg', 'vk/post-3.jpg', sourcePath],
        imageVisionFacts: [
            { index: 1, poster: false, imageType: 'logo' },
            { ...fact, index: 4, imagePath: undefined },
        ] };
}
// Header fixtures exercise the real local dimension gates without network IO.
function imageBytes(width, height) {
    const bytes = Buffer.alloc(2048);
    bytes.set([0x89, 0x50, 0x4e, 0x47]);
    bytes.writeUInt32BE(width, 16);
    bytes.writeUInt32BE(height, 20);
    return bytes;
}
function harness({ files = new Map([[boundPath, imageBytes(800, 599)], [sourcePath, imageBytes(240, 180)]]),
    upload = async (path) => 'attachment:' + path } = {}) {
    const uploads = [];
    const records = [];
    const sandbox = {
        console: { log() {}, warn() {}, error() {} },
        getEventPosterSafetyAssessment, getEventSourceMediaBindingAssessment,
        getTelegramEventVideo, isTelegramVideoSource,
        getVisionBoundSourcePosterPaths, getEventImageFactForDelivery,
        isMultiAnnouncementForImageDelivery, shouldRejectImageFactForDelivery,
        detectRasterImageDimensions,
        readFileSync: (path) => { if (!files.has(path)) throw Error('missing file'); return files.get(path); },
        statSync: (path) => ({ size: files.get(path)?.length || 0 }),
        resolveEventImagePath: (path) => files.has(path) ? path : '',
        eventNeedsSpecificAnnouncementPoster: () => true,
        isLikelyVkNonPosterUiImageUrl: (url) => url.includes('/emoji/'),
        getVkPostMeta: () => null,
        parseImageFingerprints: () => [],
        selectBestLocalEventImagePath: (paths) => paths.find((path) => files.has(path)) || '',
        getRawContext: (context) => context,
        uploadEventImageAttachment: async (path) => { uploads.push(path); return upload(path); },
        appendPosterDeliveryForensic: (record) => records.push(record),
    };
    const ranges = [
        ['function isGeneratedEventCardPath(', 'function isUsableLocalEventMediaPath('],
        ['function isUsableMonoSourceImagePath(', 'function collectEventVkWallSourceUrls('],
        ['function eventIsMultiAnnouncementForImageDelivery(', 'const V18877_STARTUP_POSTER_REPAIR_DELAY_MS'],
        ['async function getEventAttachments(', 'async function sendPublicEventMessages('],
        ['function eventHasUsableMediaV18883(', 'function localPosterEvidenceV18886('],
    ];
    const code = ranges.map(([start, end]) => {
        const from = app.indexOf(start), to = app.indexOf(end, from);
        assert.ok(from >= 0 && to > from);
        return app.slice(from, to);
    }).join('\n');
    const { deliver, hasMedia } = vm.runInNewContext(code + '\n({ deliver: getEventAttachments, hasMedia: eventHasUsableMediaV18883 });', sandbox);
    const readiness = app.match(/posterReady: (eventHasUsableMediaV18883[^\n]+),/u)?.[1];
    assert.ok(readiness, 'visibility audit must share the actual delivery policy');
    const auditReady = (event, canonical = event) => vm.runInNewContext(readiness, {
        event, represented: { index: 0 }, dedupe: { events: [canonical] }, eventHasUsableMediaV18883: hasMedia,
    });
    return { deliver, hasMedia, auditReady, uploads, records };
}

test('RammPage uses the event-bound full poster before a 240x180 source thumbnail', async () => {
    const h = harness();
    const result = await h.deliver(fixture(), { platform: 'telegram' });
    assert.deepEqual(h.uploads, [boundPath]);
    assert.equal(result.attachments.length, 1);
    assert.equal(result.imagePaths[0], boundPath);
});

test('missing event-bound file falls back at delivery time to a matched source thumbnail', async () => {
    const h = harness({ files: new Map([[sourcePath, imageBytes(240, 180)]]) });
    const result = await h.deliver(fixture(), { platform: 'telegram' });
    assert.deepEqual(h.uploads, [sourcePath]);
    assert.equal(result.attachments.length, 1);
    assert.equal(h.hasMedia(fixture()), true, 'startup audit accepts the same proven thumbnail');
});

test('failed first upload tries another bound poster and emits exactly one attachment', async () => {
    const h = harness({ upload: async (path) => { if (path === boundPath) throw Error('temporary upload failure'); return path; } });
    const result = await h.deliver(fixture(), { platform: 'vk' });
    assert.deepEqual(h.uploads, [boundPath, sourcePath]);
    assert.equal(result.uploadErrors.length, 1);
    assert.equal(result.attachments.length, 1);
    assert.equal(result.imagePaths[0], sourcePath);
});

test('null first upload also tries a bound alternative', async () => {
    const h = harness({ upload: async (path) => path === boundPath ? null : path });
    const result = await h.deliver(fixture(), { platform: 'vk' });
    assert.deepEqual(h.uploads, [boundPath, sourcePath]);
    assert.equal(result.attachments.length, 1);
});

test('mono card keeps its linked source image without Vision confirmation', async () => {
    const event = { ...fixture(), isMultiAnnouncement: false, posterMatchStatus: 'no_safe_poster',
        posterVisionFacts: [], imageVisionFacts: [] };
    const h = harness();
    const result = await h.deliver(event, { platform: 'telegram' });
    assert.equal(h.hasMedia(event), true, 'startup audit accepts an unconfirmed mono-source image');
    assert.equal(result.attachments.length, 1);
    assert.equal(result.imagePaths[0], boundPath);
});

test('an unrelated image from a multi-announcement is not used as fallback', async () => {
    const event = fixture();
    event.posterVisionFacts = [];
    event.imageVisionFacts[1] = { ...event.imageVisionFacts[1], dates: '25 October', participants: 'Other Band' };
    const h = harness();
    const result = await h.deliver(event, { platform: 'telegram' });
    assert.equal(result.attachments.length, 0);
    assert.deepEqual(h.uploads, []);
});

test('image facts are resolved by exact file binding before source-local index', () => {
    const event = fixture();
    assert.equal(getEventImageFactForDelivery(event, boundPath), event.posterVisionFacts[0]);
    assert.equal(getEventImageFactForDelivery(event, sourcePath), event.imageVisionFacts[1]);
    assert.equal(getEventImageFactForDelivery(event, 'other/post-1.jpg'), null);
    assert.equal(getEventImageFactForDelivery(event, 'vk/post-1.jpg').poster, false);
});

test('an explicit rejection on this bound file is not replaced with another source fact', async () => {
    const event = fixture();
    event.posterVisionFacts[0].poster = false;
    event.imageVisionFacts = [];
    const h = harness();
    const result = await h.deliver(event, { platform: 'telegram' });
    assert.equal(result.attachments.length, 0);
});

test('all upload failures remain observable for the existing transport failure policy', async () => {
    const h = harness({ upload: async () => { throw Error('offline'); } });
    const result = await h.deliver(fixture(), { platform: 'vk' });
    assert.equal(result.attachments.length, 0);
    assert.equal(result.uploadErrors.length, 2);
    assert.equal(result.hadSafePosterCandidate, true);
});

test('visibility audit accepts the same shared source poster as delivery', async () => {
    const event = { ...fixture(), posterMatchStatus: 'shared_multi_event_source_image',
        posterMatchReason: 'multi-event-shared-source-image', sourceImagePaths: [boundPath],
        posterVisionFacts: [{ index: 1, imagePath: boundPath, sourceMediaBinding: true,
            fallbackBinding: 'multi-event-shared-source-image', sourceEventCount: 20, sourceImageCount: 1 }],
        imageVisionFacts: [] };
    const h = harness();
    assert.equal(h.auditReady(event), true);
    const result = await h.deliver(event, { platform: 'telegram' });
    assert.equal(result.attachments.length, 1);
});

test('visibility audit checks the canonical merged card and still detects missing files', () => {
    const h = harness(), event = fixture();
    const empty = { ...event, imagePaths: [], sourceImagePaths: [], posterVisionFacts: [], imageVisionFacts: [] };
    assert.equal(h.auditReady(empty, event), true);
    assert.equal(h.auditReady(empty), false);
    assert.equal(harness({ files: new Map() }).auditReady(event), false);
});
