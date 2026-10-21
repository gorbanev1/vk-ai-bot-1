import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';

import {
    collectTelegramVoiceAttachments,
    collectVkVoiceAttachments,
    formatVoiceTranscriptBlock,
    transcribeAudioBuffer,
} from '../../src/features/ai/voiceTranscription.js';
import {
    extractVkMessageContent,
} from '../../src/platforms/vk/vkMessageContent.js';
import {
    getVoiceTranscriptCache,
    saveVoiceTranscriptCache,
} from '../../src/infrastructure/database/index.js';

const vkMessage = {
    attachments: [{
        type: 'audio_message',
        audio_message: {
            id: 91,
            owner_id: 42,
            duration: 8,
            transcript_state: 'done',
            transcript: 'Сегодня в восемь концерт в Дизеле.',
            link_ogg: 'https://example.test/voice.ogg',
        },
    }],
    fwd_messages: [{
        attachments: [{
            type: 'doc',
            doc: {
                id: 77,
                owner_id: 55,
                preview: {
                    audio_msg: {
                        duration: 4,
                        link_mp3: 'https://example.test/forwarded.mp3',
                    },
                },
            },
        }],
    }],
};

const vkVoices = collectVkVoiceAttachments(vkMessage);
assert.equal(vkVoices.length, 2);
assert.equal(vkVoices[0].isDirect, true);
assert.equal(vkVoices[0].transcript, 'Сегодня в восемь концерт в Дизеле.');
assert.equal(vkVoices[0].attachmentKey, 'vk:42:91');
assert.equal(vkVoices[1].isDirect, false);
assert.equal(vkVoices[1].mp3Url, 'https://example.test/forwarded.mp3');

const normalizedVk = extractVkMessageContent(vkMessage);
assert.match(normalizedVk.text, /Голосовое сообщение VK/u);
assert.match(normalizedVk.text, /Сегодня в восемь концерт в Дизеле\./u);

const telegramVoices = collectTelegramVoiceAttachments({
    message_id: 10,
    voice: {
        file_id: 'file-1',
        file_unique_id: 'unique-1',
        duration: 12,
        file_size: 1234,
    },
    reply_to_message: {
        message_id: 9,
        voice: {
            file_id: 'file-2',
            file_unique_id: 'unique-2',
            duration: 3,
        },
    },
});
assert.equal(telegramVoices.length, 2);
assert.equal(telegramVoices[0].attachmentKey, 'telegram:unique-1');
assert.equal(telegramVoices[0].isDirect, true);
assert.equal(telegramVoices[1].isDirect, false);

const block = formatVoiceTranscriptBlock([
    { transcript: 'Прямое голосовое', isDirect: true },
    { transcript: 'Ответное голосовое', isDirect: false },
], { platform: 'telegram' });
assert.match(block, /Прямое голосовое/u);
assert.match(block, /Ответное голосовое/u);
assert.doesNotMatch(
    formatVoiceTranscriptBlock([
        { transcript: 'Прямое голосовое', isDirect: true },
        { transcript: 'Ответное голосовое', isDirect: false },
    ], { platform: 'telegram', directOnly: true }),
    /Ответное/u,
);

let seenUrl = '';
let seenModel = '';
const fakeFetch = async (url, options) => {
    seenUrl = String(url);
    const form = options.body;
    seenModel = String(form.get('model'));
    return new Response(JSON.stringify({ text: 'распознанный текст' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
    });
};
const transcription = await transcribeAudioBuffer({
    buffer: Buffer.from('not-real-audio'),
    filename: 'voice.ogg',
    mimeType: 'audio/ogg',
    providers: [{
        name: 'test',
        baseUrl: 'https://speech.test/v1',
        apiKey: 'secret',
        models: ['whisper-test'],
    }],
    fetchImpl: fakeFetch,
});
assert.equal(seenUrl, 'https://speech.test/v1/audio/transcriptions');
assert.equal(seenModel, 'whisper-test');
assert.equal(transcription.text, 'распознанный текст');

const cacheKey = `v164-test-${Date.now()}-${Math.random()}`;
saveVoiceTranscriptCache({
    platform: 'telegram',
    attachmentKey: cacheKey,
    peerId: 123,
    conversationMessageId: 456,
    transcript: 'кэшированный текст',
    source: 'test',
    model: 'whisper-test',
    status: 'ok',
});
const cached = getVoiceTranscriptCache({
    platform: 'telegram',
    attachmentKey: cacheKey,
});
assert.equal(cached.transcript, 'кэшированный текст');
assert.equal(cached.peerId, 123);
assert.equal(cached.conversationMessageId, 456);

console.log('V164 voice transcription tests: OK');
