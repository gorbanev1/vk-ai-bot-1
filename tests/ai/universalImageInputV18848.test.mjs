import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import { resolveIncomingImageTargets } from '../../src/features/ai/incomingImageTargets.js';

test('V188.48: Telegram current + replied images are both visible to the universal image preprocessor', async () => {
    const api = {
        async getFile(fileId) { return { file_path: `${fileId}.jpg` }; },
        buildFileUrl(filePath) { return `https://api.telegram.org/file/bot/redacted/${filePath}`; },
    };
    const urls = await resolveIncomingImageTargets({
        platform: 'telegram',
        telegramApi: api,
        message: {
            photo: [{ file_id: 'current-photo' }],
            reply_to_message: { photo: [{ file_id: 'reply-photo' }] },
        },
    });
    assert.equal(urls.length, 2);
    assert.match(urls[0], /current-photo/u);
    assert.match(urls[1], /reply-photo/u);
});

test('V188.48: universal vision/OCR is injected centrally into text modes, including documents and image edits', async () => {
    const source = await readFile(new URL('../../src/app/botApplication.js', import.meta.url), 'utf8');
    assert.match(source, /async function getIncomingImageAnalysisBlock\(/u);
    assert.match(source, /РАСПОЗНАННОЕ_СОДЕРЖИМОЕ_ПРИКРЕПЛЁННЫХ_ИЗОБРАЖЕНИЙ/u);
    assert.match(source, /includeImageAnalysis \? getIncomingImageAnalysisBlock\(rawContext\)/u);
    assert.doesNotMatch(source, /if \(!store\?\.context \|\| !store\.incomingText\)/u);
    assert.match(source, /СЛУЖЕБНОЕ ОПИСАНИЕ ИСХОДНИКА ДЛЯ РЕДАКТИРОВАНИЯ/u);
    assert.match(source, /handleDocumentArtifactRequest/u);
    assert.match(source, /generateDefaultGptText/u);
});
