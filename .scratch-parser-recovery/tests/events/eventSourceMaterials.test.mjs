import assert from 'node:assert/strict';
import test from 'node:test';

import {
    collectOwnerEventSourceMaterials,
    formatOwnerEventSourceMaterials,
    formatOwnerEventSourceRecord,
} from '../../src/features/events/eventSourceMaterials.js';

test('owner edit materials keep complete text and all images from merged sources', () => {
    const event = {
        sourceType: 'vk',
        sourceItemId: 'vk:club:42',
        sourceName: 'primary',
        sourceUrl: 'https://vk.ru/wall-1_42',
        sourceText: 'Полный текст моноанонса\nДата и место события.',
        sourceSegment: 'Дата и место события.',
        sourceImagePaths: ['images/poster-1.jpg', 'images/shared.jpg'],
        imageUrls: ['https://cdn.test/poster-1.jpg'],
        mergedSources: undefined,
    };
    event.mergedSources = [
        {
            sourceType: 'vk_chat',
            sourceItemId: 'chat:99:7',
            sourceName: 'Беседа 99',
            sourceUrl: 'https://vk.ru/im?sel=99',
            sourceText: 'Полный текст мультианонса с дополнительной информацией.',
            sourceSegment: 'Только часть про это событие.',
            sourceImagePaths: ['images/shared.jpg', 'images/multi-2.jpg'],
            imageUrls: ['https://cdn.test/multi-2.jpg'],
            posterVisionFacts: [{ index: 1, poster: false, visionStatus: 'error' }],
        },
    ];

    const materials = collectOwnerEventSourceMaterials(event);
    assert.equal(materials.records.length, 2);
    assert.deepEqual(materials.imagePaths, [
        'images/poster-1.jpg',
        'images/shared.jpg',
        'images/multi-2.jpg',
    ]);
    assert.equal(materials.records[0].text, 'Полный текст моноанонса\nДата и место события.');
    assert.equal(materials.records[1].segment, 'Только часть про это событие.');

    const formatted = formatOwnerEventSourceMaterials(materials);
    assert.match(formatted, /Полный исходный текст:/u);
    assert.match(formatted, /Полный текст моноанонса/u);
    assert.match(formatted, /Полный текст мультианонса с дополнительной информацией/u);
    assert.match(formatted, /Фрагмент, отнесённый к этой карточке:/u);
    assert.match(formatted, /https:\/\/cdn\.test\/poster-1\.jpg/u);
    assert.match(formatted, /https:\/\/cdn\.test\/multi-2\.jpg/u);
    assert.match(formatted, /Сохранено Vision-фактов: 1/u);
    const firstBlock = formatOwnerEventSourceRecord(materials.records[0], 0, materials.records.length);
    assert.match(firstBlock, /Полный исходный текст анонса:/u);
    assert.match(firstBlock, /Полный текст моноанонса\nДата и место события./u);
    assert.match(firstBlock, /https:\/\/cdn\.test\/poster-1\.jpg/u);
});

test('owner edit materials merge duplicate source identities without losing full text', () => {
    const event = {
        sourceItemId: 'vk:1:42',
        sourceText: 'Короткий сегмент карточки',
        sourceImagePaths: ['images/one.jpg'],
        posterVisionFacts: [{ index: 1, poster: true }],
        mergedSources: [{
            sourceItemId: 'vk:1:42',
            sourceText: 'Полный текст исходного поста',
            sourceSegment: 'Фрагмент для этой карточки',
            sourceImagePaths: ['images/two.jpg'],
            posterVisionFacts: [{ index: 2, poster: false, visionStatus: 'error' }],
        }],
    };
    const materials = collectOwnerEventSourceMaterials(event);
    assert.equal(materials.records.length, 1);
    assert.match(materials.records[0].text, /Короткий сегмент карточки/u);
    assert.match(materials.records[0].text, /Полный текст исходного поста/u);
    assert.equal(materials.records[0].segment, 'Фрагмент для этой карточки');
    assert.deepEqual(materials.records[0].imagePaths, ['images/one.jpg', 'images/two.jpg']);
    assert.equal(materials.records[0].visionFacts.length, 2);
});

test('owner edit materials tolerate missing source fields', () => {
    const materials = collectOwnerEventSourceMaterials({ title: 'Событие', mergedSources: [null, {}] });
    assert.equal(materials.records.length, 2);
    assert.match(formatOwnerEventSourceMaterials(materials), /Полный текст этого источника в базе не сохранён/u);
});
