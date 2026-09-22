import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '../..');
const app = fs.readFileSync(path.join(root, 'src/app/botApplication.js'), 'utf8');

function extractFunction(name) {
    const start = app.indexOf(`async function ${name}(`);
    assert.notEqual(start, -1, `${name} must exist`);
    const next = app.indexOf('\nasync function ', start + 1);
    return app.slice(start, next === -1 ? undefined : next);
}

test('V134 keeps Telegram local-file event photos and sends VK posters through the hardened uploader', () => {
    const body = extractFunction('uploadEventImageAttachment');

    assert.match(body, /platform === 'telegram'/u);
    assert.match(body, /createTelegramPhotoAttachment\(\{\s*filePath:\s*absolute/su);
    assert.match(body, /const buffer = readFileSync\(absolute\)/u);
    assert.match(body, /detectImageMimeType\(buffer\)/u);
    assert.match(body, /uploadGeneratedImageBuffer\(\{\s*context,\s*buffer,\s*mimeType,/su);

    // The old one-shot VK event upload was exactly where photos disappeared.
    assert.doesNotMatch(body, /const uploaded = await vk\.upload\.messagePhoto/u);
    assert.doesNotMatch(body, /const attachment = String\(uploaded\)/u);
});

test('V134 event attachment cache is separated by VK community', () => {
    const body = extractFunction('uploadEventImageAttachment');

    assert.match(body, /const activeVk = getActiveVkConnection\(\)/u);
    assert.match(body, /activeVk\?\.label/u);
    assert.match(body, /activeVk\?\.groupId/u);
    assert.match(body, /eventImageAttachmentCache\.has\(cacheKey\)/u);
    assert.match(body, /eventImageAttachmentCache\.set\(cacheKey, attachment\)/u);
});

test('V134 hardened VK photo uploader still has attachment validation and direct multipart fallback', () => {
    assert.match(app, /function normalizeVkPhotoAttachment\(uploaded\)/u);
    assert.match(app, /contentType:\s*detectedMimeType/u);
    assert.match(app, /contentLength:\s*buffer\.length/u);
    assert.match(app, /uploadVkMessagePhotoDirect\(\{/u);
    assert.match(app, /photos\.getMessagesUploadServer/u);
    assert.match(app, /photos\.saveMessagesPhoto/u);
});
