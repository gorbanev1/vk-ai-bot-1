import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const appSource = readFileSync(new URL('../../src/app/botApplication.js', import.meta.url), 'utf8');
const telegramSource = readFileSync(new URL('../../src/platforms/telegram/telegramBot.js', import.meta.url), 'utf8');

test('V188.100 Telegram poll accepts document-only messages instead of dropping them', () => {
    assert.match(telegramSource, /messageHasModelFileAttachment[\s\S]*?message\?\.document\?\.file_id[\s\S]*?messageHasVoiceAttachment \|\| messageHasModelFileAttachment/u);
    assert.match(telegramSource, /hasModelFileAttachment[\s\S]*?effectiveMessage\?\.document\?\.file_id[\s\S]*?context\.text \|\| hasImageAttachment \|\| hasVoiceAttachment \|\| hasModelFileAttachment/u);
});

test('V188.100 addressed file-only Telegram message enters the normal GPT route without bypassing group gating', () => {
    assert.match(appSource, /if \(!text\) \{[\s\S]*?hasIncomingTelegramModelFileAttachment\(context\)[\s\S]*?privateMode \|\| contextReferencesBot\(context\)[\s\S]*?text = 'gpt Проанализируй прикреплённый файл/u);
    assert.doesNotMatch(appSource, /if \(!text\) \{[\s\S]{0,700}?await handleGptCommand/u);
});

test('V188.100 current Telegram photo/document is downloaded through getFile and cached per request', () => {
    assert.match(appSource, /collectTelegramModelFileDescriptors/u);
    assert.match(appSource, /message\.document/u);
    assert.match(appSource, /Array\.isArray\(message\.photo\)/u);
    assert.match(appSource, /await api\.getFile\(descriptor\.fileId\)/u);
    assert.match(appSource, /api\.buildFileUrl\(filePath\)/u);
    assert.match(appSource, /telegramModelFilesPromise/u);
    assert.match(appSource, /TELEGRAM_MODEL_FILES_MAX_TOTAL_BYTES = clampInteger/u);
});

test('V188.100 generic GPT request forwards loaded Telegram files to the model request', () => {
    assert.match(appSource, /const telegramInputFiles = await getIncomingTelegramModelFiles\(\)/u);
    assert.match(appSource, /inputFiles: telegramInputFiles/u);
    assert.match(appSource, /Array\.isArray\(inputFiles\) && inputFiles\.length/u);
});

test('V188.100 model payload uses first-class Responses API input_file/input_image parts', () => {
    assert.match(appSource, /type: 'input_file'/u);
    assert.match(appSource, /file_data: dataUrl/u);
    assert.match(appSource, /type: 'input_image'/u);
    assert.match(appSource, /image_url: dataUrl/u);
    assert.match(appSource, /fetch\(`\$\{requestBaseUrl\}\/responses`/u);
    assert.match(appSource, /responses-file-input-\$\{resolvedStreaming \? 'stream' : 'nonstream'\}/u);
});

test('V188.100 text-only requests keep the audited chat-completions path', () => {
    assert.match(appSource, /isAstraModel\(model\) \|\| \(Array\.isArray\(inputFiles\) && inputFiles\.length\)[\s\S]*?generateOpenAITextWithFilesAttempt/u);
    assert.match(appSource, /`\$\{requestBaseUrl\}\/chat\/completions`/u);
});
