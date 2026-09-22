import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const app = readFileSync(new URL('../../src/app/botApplication.js', import.meta.url), 'utf8');

test('V188.96 retries VK event poster upload with direct multipart first', () => {
    const begin = app.indexOf('const VK_EVENT_POSTER_UPLOAD_RETRY_DELAYS_MS');
    const end = app.indexOf('\nfunction isGeneratedEventCardPath', begin);
    const source = app.slice(begin, end);

    assert.match(source, /VK_EVENT_POSTER_UPLOAD_RETRY_DELAYS_MS\s*=\s*Object\.freeze\(\[0,\s*450,\s*1_250\]\)/u);
    assert.match(source, /uploadVkMessagePhotoDirect/u);
    assert.match(source, /method=direct-multipart/u);
    assert.match(source, /vk-io-buffer-fallback/u);
    assert.match(source, /Не удалось загрузить подтверждённую афишу во VK после повторов/u);
});

test('V188.96 never silently sends a VK card without a confirmed poster after transport failure', () => {
    const begin = app.indexOf('async function getEventAttachments');
    const end = app.indexOf('\nfunction formatNoPublicEvents', begin);
    const source = app.slice(begin, end);

    assert.match(source, /hadSafePosterCandidate:\s*imagePaths\.length\s*>\s*0/u);
    assert.match(source, /uploadErrors/u);
    assert.match(source, /EVENT POSTER DELIVERY FAILED — CARD WITHHELD/u);
    assert.match(source, /Карточки с подтверждёнными картинками не были отправлены без них/u);

    const failureBranch = source.slice(
        source.indexOf("platform === 'vk'"),
        source.indexOf('skippedWithoutPoster += 1'),
    );
    assert.match(failureBranch, /continue;/u);
    assert.doesNotMatch(failureBranch, /await context\.send\(message\)/u);
});

test('V188.96 preserves text-only output only for events with no proven poster', () => {
    const begin = app.indexOf('async function sendPublicEventMessages');
    const end = app.indexOf('\nfunction formatNoPublicEvents', begin);
    const source = app.slice(begin, end);

    assert.match(source, /EVENT POSTER UNRESOLVED — REAL SOURCE IMAGE NOT PROVEN/u);
    assert.match(source, /await context\.send\(message\)/u);
    assert.match(source, /failedPosterUploads/u);
});
