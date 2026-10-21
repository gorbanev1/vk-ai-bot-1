import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import {
    collectIncomingMediaContext,
} from '../../src/features/ai/incomingImageTargets.js';
import {
    processMediaItemsSequentially,
} from '../../src/features/ai/mediaPipeline.js';

const photo = (id, url = `https://sun9-1.userapi.com/${id}.jpg`) => ({
    type: 'photo',
    photo: {
        owner_id: -100,
        id,
        sizes: [
            { url: `${url}?small=1`, width: 100, height: 100 },
            { url, width: 1600, height: 1200 },
        ],
    },
});

async function vk(message, options = {}) {
    return collectIncomingMediaContext({ platform: 'vk', message }, options);
}

test('V188.51: recursive VK collector finds message -> image', async () => {
    const context = await vk({ attachments: [photo(1)] });
    assert.equal(context.images.length, 1);
    assert.equal(context.images[0].sourcePath, 'message.attachments[0]:photo');
});

test('V188.51: recursive VK collector finds message -> reply -> image', async () => {
    const context = await vk({
        reply_message: { attachments: [photo(2)] },
    });
    assert.equal(context.images.length, 1);
    assert.match(context.images[0].sourcePath, /^message\.reply\.attachments\[0\]:photo$/u);
});

test('V188.51: recursive VK collector finds message -> repost -> image', async () => {
    const context = await vk({
        attachments: [{
            type: 'wall',
            wall: { owner_id: -10, id: 20, attachments: [photo(3)] },
        }],
    });
    assert.equal(context.images.length, 1);
    assert.match(context.images[0].sourcePath, /:wall\.attachments\[0\]:photo$/u);
});

test('V188.51: recursive VK collector finds repost inside repost', async () => {
    const context = await vk({
        attachments: [{
            type: 'wall',
            wall: {
                owner_id: -10,
                id: 21,
                copy_history: [{
                    owner_id: -11,
                    id: 22,
                    attachments: [photo(4)],
                }],
            },
        }],
    });
    assert.equal(context.images.length, 1);
    assert.match(context.images[0].sourcePath, /\.repost\[0\]\.attachments\[0\]:photo$/u);
});

test('V188.51 regression: quoted/reposted 4-page guide keeps all four pages and order', async () => {
    const context = await vk({
        text: 'Гигорейв дай комментарий по поводу этого гайда, чтобы ты дополнил или опроверг',
        reply_message: {
            text: 'Гайд',
            attachments: [{
                type: 'wall',
                wall: {
                    owner_id: -12,
                    id: 30,
                    text: 'Четыре страницы гайда',
                    attachments: [photo(11), photo(12), photo(13), photo(14)],
                },
            }],
        },
    });

    assert.equal(context.images.length, 4);
    assert.deepEqual(context.images.map((image) => image.order), [1, 2, 3, 4]);
    assert.deepEqual(context.images.map((image) => image.imageIndexInGroup), [1, 2, 3, 4]);
    assert.deepEqual(context.images.map((image) => image.imageCountInGroup), [4, 4, 4, 4]);
    assert.ok(context.images.every((image) => image.sourcePath.startsWith('message.reply.')));
    assert.equal(context.stats.imagesDiscovered, 4);
});

test('V188.51: image documents and captions are part of the flattened media context', async () => {
    const context = await vk({
        caption: 'подпись сообщения',
        attachments: [{
            type: 'doc',
            doc: {
                owner_id: 1,
                id: 90,
                ext: 'png',
                title: 'guide-page.png',
                url: 'https://example.com/guide-page.png',
            },
        }],
    });
    assert.equal(context.images.length, 1);
    assert.equal(context.images[0].attachmentType, 'document-image');
    assert.match(context.textNodes.map((node) => node.text).join('\n'), /подпись сообщения/u);
});

test('V188.51: duplicate attachment IDs/URLs are analyzed once', async () => {
    const same = photo(77, 'https://sun9-1.userapi.com/same.jpg');
    const context = await vk({
        attachments: [same],
        reply_message: { attachments: [same] },
        fwd_messages: [{ attachments: [photo(77, 'https://sun9-1.userapi.com/same.jpg')] }],
    });
    assert.equal(context.images.length, 1);
    assert.ok(context.stats.duplicateImagesSkipped >= 1 || context.stats.cyclesSkipped >= 1);
});

test('V188.51: cycles and depth limit are explicit, not silent', async () => {
    const root = { text: 'root' };
    root.reply_message = root;
    const cycle = await vk(root);
    assert.ok(cycle.stats.cyclesSkipped >= 1);

    const events = [];
    let nested = { attachments: [photo(88)] };
    for (let index = 0; index < 8; index += 1) nested = { reply_message: nested };
    const limited = await vk(nested, { maxDepth: 3, onEvent: (event) => events.push(event) });
    assert.equal(limited.images.length, 0);
    assert.ok(events.some((event) => event.type === 'depth-limit'));
});

test('V188.51: one broken image does not abort the other three', async () => {
    const items = [1, 2, 3, 4].map((order) => ({ order, sourcePath: `message.attachments[${order - 1}]` }));
    const failed = [];
    const run = await processMediaItemsSequentially(
        items,
        async (item) => {
            if (item.order === 2) throw new Error('synthetic broken image');
            return { ...item, status: 'processed', ocrText: `page ${item.order}` };
        },
        { onItemError: (_error, item) => failed.push(item.order) },
    );
    assert.equal(run.discovered, 4);
    assert.equal(run.processed, 3);
    assert.equal(run.failed, 1);
    assert.deepEqual(failed, [2]);
    assert.equal(run.results[1].status, 'failed');
    assert.equal(run.results[3].ocrText, 'page 4');
});

test('V188.51: media enrichment is before routing, fully logged, and image edit keeps the real source target', async () => {
    const app = await readFile(new URL('../../src/app/botApplication.js', import.meta.url), 'utf8');
    const audit = await readFile(new URL('../../src/features/ai/mediaAudit.js', import.meta.url), 'utf8');
    const pkg = JSON.parse(await readFile(new URL('../../package.json', import.meta.url), 'utf8'));

    assert.equal(pkg.version, '0.188.57');
    assert.match(app, /resolveRichIncomingMediaContext\(store\.context\)/u);
    assert.match(app, /await getIncomingImageAnalysisBlock\(store\.context\)/u);
    assert.match(app, /sourcePath/u);
    assert.match(app, /sha256/u);
    assert.match(app, /media\.image\.download-started/u);
    assert.match(app, /media\.image\.ocr-started/u);
    assert.match(app, /media\.image\.vision-started/u);
    assert.match(app, /media\.image\.final/u);
    assert.match(app, /summary: `\$\{processed\}\/\$\{results\.length\} processed`/u);
    assert.match(app, /Обработано \$\{processed\} из \$\{total\} изображений/u);
    assert.match(app, /Ошибка записана в лог\. ID операции/u);
    assert.match(audit, /data\/audit\/media/u);
    assert.match(audit, /message-structure\.json/u);
    assert.match(audit, /errors\.jsonl/u);
    assert.match(audit, /ocr\.txt/u);
    assert.match(audit, /vision\.txt/u);
    assert.match(app, /sourceImageUrls = await resolveRichIncomingImageTargets\(rawContext\)/u);
    assert.match(app, /preparedSourceImages\.map\(\(url\) => \(\{/u);
    assert.match(app, /type: 'image_url'/u);
});
