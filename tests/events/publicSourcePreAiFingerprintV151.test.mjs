import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import {
    createSourceTextFingerprint,
    fingerprintImageBuffer,
    imageFingerprintSetsEqual,
    normalizeSourcePostText,
    sourceTextSimilarity,
} from '../../src/features/events/sourcePostFingerprint.js';
import {
    compareEventsDeterministic,
    EVENT_DEDUPE_ALGORITHM_VERSION,
} from '../../src/features/events/eventDuplicateResolution.js';

function pngChunk(type, data = Buffer.alloc(0)) {
    const payload = Buffer.isBuffer(data) ? data : Buffer.from(data);
    const out = Buffer.alloc(12 + payload.length);
    out.writeUInt32BE(payload.length, 0);
    out.write(type, 4, 4, 'ascii');
    payload.copy(out, 8);
    // CRC is irrelevant for deterministic structural fingerprint tests.
    out.writeUInt32BE(0, 8 + payload.length);
    return out;
}

function fakePng(metadataText) {
    return Buffer.concat([
        Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
        pngChunk('IHDR', Buffer.alloc(13, 1)),
        pngChunk('tEXt', Buffer.from(metadataText)),
        pngChunk('IDAT', Buffer.from('same-visual-payload')),
        pngChunk('IEND'),
    ]);
}

test('V151 text fingerprints normalize case/ё and >=90% near-duplicate gate is deterministic', () => {
    assert.equal(normalizeSourcePostText('ЁЛКА — ВЕЧЕРИНКА'), 'елка вечеринка');
    assert.equal(
        createSourceTextFingerprint('Ёлка — вечеринка'),
        createSourceTextFingerprint('елка вечеринка'),
    );

    const original = '5 сентября в 20:00 вечеринка Industrial Madness в клубе Diesel Hall. Вход свободный. Билеты и подробности в посте.';
    const tinyEdit = '5 сентября в 20:00 вечеринка Industrial Madness в клубе Diesel Hall. Вход свободный! Билеты и подробности в посте.';
    const unrelated = 'Открытие выставки современного искусства 17 октября в галерее. Начало в 18:30.';
    assert.ok(sourceTextSimilarity(original, tinyEdit) >= 0.90);
    assert.ok(sourceTextSimilarity(original, unrelated) < 0.50);
});

test('V151 image fingerprint ignores PNG metadata while exact SHA still detects byte changes', () => {
    const a = fingerprintImageBuffer(fakePng('author=A'));
    const b = fingerprintImageBuffer(fakePng('author=B'));
    assert.notEqual(a.sha256, b.sha256);
    assert.equal(a.visualHash, b.visualHash);
    assert.equal(imageFingerprintSetsEqual([a], [b]), true);
});

test('V154 exact content title+date wins before time but respects explicit venue identity conflict', () => {
    assert.match(EVENT_DEDUPE_ALGORITHM_VERSION, /v154/u);
    const result = compareEventsDeterministic({
        title: 'Industrial Madness gig',
        eventDate: '2026-09-05',
        timeLabel: '18:00',
        venue: 'Diesel Hall',
    }, {
        title: 'INDUSTRIAL MADNESS концерт',
        eventDate: '2026-09-05',
        timeLabel: '23:30',
        venue: 'Дизель Холл',
    });
    assert.equal(result.verdict, 'same');
    assert.equal(result.hardConflicts.length, 0);
    assert.ok(result.reasons.includes('exact-title-date-absolute-rule'));

    const differentSpace = compareEventsDeterministic({
        title: 'Industrial Madness', eventDate: '2026-09-05', venue: 'Diesel Hall',
    }, {
        title: 'Industrial Madness party', eventDate: '2026-09-05', venue: 'Дизель бар',
    });
    assert.equal(differentSpace.verdict, 'different');
    assert.ok(differentSpace.hardConflicts.includes('different-venue'));
});

test('V151 public source runtime wires AI/vision only behind local fingerprint gates', () => {
    const app = readFileSync(new URL('../../src/app/botApplication.js', import.meta.url), 'utf8');
    const tg = readFileSync(new URL('../../src/platforms/telegram/telegramHtmlScraper.js', import.meta.url), 'utf8');
    const vk = readFileSync(new URL('../../src/platforms/vk/vkPublicScraper.js', import.meta.url), 'utf8');
    const db = readFileSync(new URL('../../src/infrastructure/database/index.js', import.meta.url), 'utf8');

    assert.match(app, /extractEventsWithAi:\s*extractPublicEventsWithGpt/u);
    assert.match(app, /extractImageFactsWithAi:\s*extractPublicPostImageFactsWithVision/u);
    for (const source of [tg, vk]) {
        assert.match(source, /sourceTextSimilarity\(previous\.rawText, post\.text\)/u);
        assert.match(source, /textSimilarity >= 0\.90/u);
        assert.match(source, /fingerprintRemoteImages/u);
        assert.match(source, /imageFingerprintSetsEqual/u);
        assert.match(source, /!nearDuplicateText \|\| imageChanged/u);
    }
    assert.match(db, /'text_fingerprint',[\s\S]*?"TEXT NOT NULL DEFAULT ''"/u);
    assert.match(db, /'image_fingerprints_json',[\s\S]*?"TEXT NOT NULL DEFAULT '\[\]'"/u);
});
