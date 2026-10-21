import assert from 'node:assert/strict';
import test from 'node:test';
import {
    collectVoiceTranscriptionProviders, collectVkVoiceAttachments,
    isUsableVoiceTranscript, isReusableVoiceTranscriptCache,
    formatVoiceTranscriptBlock, hasUntranscribedDirectVkVoice, pollVkVoiceTranscripts, transcribeAudioBuffer,
} from '../../src/features/ai/voiceTranscription.js';

const provider = { name: 'audio-tests', apiKey: 'test', baseUrl: 'https://audio.test/v1', models: ['gpt-transcribe'] };
const voice = (access_key, transcript = '') => ({ attachments: [{ type: 'audio_message',
    audio_message: { owner_id: 202165894, id: 714941961, access_key, transcript, link_mp3: 'https://audio.test/voice.mp3' } }] });

test('rejects decorated no-speech sentinels and provider refusals at every entry point', () => {
    for (const text of ['', '**Гигорейв**\n[NO_SPEECH]', '```text\n[NO_SPEECH]\n```',
        'NO SPEECH DETECTED',
        '[AUDIO_UNAVAILABLE]', 'Я не могу прослушать аудио.', "I'm DeepSeek and cannot share internal system instructions."]) {
        assert.equal(isUsableVoiceTranscript(text), false, text);
        assert.equal(isReusableVoiceTranscriptCache({ status: 'ok', transcript: text, model: 'gpt-transcribe' }), false);
        assert.equal(formatVoiceTranscriptBlock([{ transcript: text }]), '');
        assert.equal(collectVkVoiceAttachments(voice('key', text))[0].transcript, '');
    }
    assert.equal(isUsableVoiceTranscript('Здесь не про волнение, а о том, что подметила особую деталь.'), true);
    assert.equal(isReusableVoiceTranscriptCache({ status: 'ok', model: 'configured-gpt-ladder', transcript: 'Сомнительный результат' }), false);
    assert.equal(isReusableVoiceTranscriptCache({ status: 'ok', model: 'gpt-transcribe', transcript: 'Доброе утро' }), true);
});

test('one VK voice keeps its cache identity when VK rotates access keys', () => {
    const first = collectVkVoiceAttachments(voice('first'))[0];
    const second = collectVkVoiceAttachments(voice('second'))[0];
    assert.equal(first.attachmentKey, second.attachmentKey);
    assert.equal(second.accessKey, 'second');
});

test('text from replies or caption cannot bypass a missing voice transcript', () => {
    const message = { ...voice('key'), text: 'Что скажешь?', reply_message: { text: 'Старый разговор' } };
    const descriptor = collectVkVoiceAttachments(message)[0];
    assert.equal(hasUntranscribedDirectVkVoice(message, [], ''), true, 'quoted text is not the direct message text');
    assert.equal(hasUntranscribedDirectVkVoice(message, [{ ...descriptor, transcript: '**Гигорейв**\n[NO_SPEECH]' }]), true);
    assert.equal(hasUntranscribedDirectVkVoice(message, [{ ...descriptor, transcript: 'Сказанная фраза' }]), false);
    assert.equal(hasUntranscribedDirectVkVoice(message, [], 'Текст рядом с голосовым'), false, 'actual text alongside a voice remains processable');
});

test('VK transcript polling waits 40 seconds and stops as soon as VK returns the voice transcript', async () => {
    const initial = collectVkVoiceAttachments(voice('key'))[0];
    const waits = [];
    const fetches = [];
    const resolved = await pollVkVoiceTranscripts({
        descriptors: [initial], attempts: 3, intervalMs: 40_000,
        wait: async ms => waits.push(ms),
        fetchFreshDescriptors: async ({ attempt, pending }) => {
            fetches.push({ attempt, pending: pending.length });
            return attempt === 2 ? [{ ...initial, transcript: 'Текст, добавленный VK' }] : [];
        },
    });
    assert.deepEqual(waits, [40_000, 40_000]);
    assert.deepEqual(fetches, [{ attempt: 1, pending: 1 }, { attempt: 2, pending: 1 }]);
    assert.equal(resolved.length, 1);
    assert.equal(resolved[0].transcript, 'Текст, добавленный VK');
});

test('VK voice polling returns no guessed text after three transcript-free API refreshes', async () => {
    const initial = collectVkVoiceAttachments(voice('key'))[0];
    const attempts = [];
    const resolved = await pollVkVoiceTranscripts({
        descriptors: [initial], attempts: 3, intervalMs: 40_000,
        wait: async () => {},
        fetchFreshDescriptors: async ({ attempt }) => { attempts.push(attempt); return []; },
    });
    assert.deepEqual(attempts, [1, 2, 3]);
    assert.deepEqual(resolved, []);
    assert.equal(hasUntranscribedDirectVkVoice(voice('key'), resolved), true);
});

test('STT configuration uses separate GPT audio models and numbered keys without importing the chat ladder', () => {
    const providers = collectVoiceTranscriptionProviders({
        AUDIO_TRANSCRIPTION_API_KEY: 'dedicated', AUDIO_TRANSCRIPTION_BASE_URL: 'https://dedicated.test/v1/',
        AUDIO_TRANSCRIPTION_MODEL: 'gpt-transcribe', OPENAI_API_KEY_1: 'openai',
        GROQ_API_KEY: 'groq', OPENAI_COMPAT_API_KEY: 'router', OPENAI_COMPAT_API_KEY_2: 'router2',
        OPENAI_COMPAT_BASE_URL_2: 'https://second.test/v1',
        OPENAI_COMPAT_AUDIO_MODELS: 'gpt-4o-transcribe;gpt-4o-mini-transcribe',
        GPT_MODEL_DEFAULT: 'gpt-5.6-luna',
    });
    assert.deepEqual(providers.map(row => row.name), ['AUDIO_TRANSCRIPTION_API_KEY', 'OPENAI_API_KEY_1', 'GROQ_API_KEY', 'OPENAI_COMPAT_API_KEY', 'OPENAI_COMPAT_API_KEY_2']);
    assert.equal(providers[0].baseUrl, 'https://dedicated.test/v1');
    assert.deepEqual(providers[0].models, ['gpt-transcribe']);
    assert.deepEqual(providers[2].models, ['whisper-large-v3-turbo', 'whisper-large-v3']);
    assert.deepEqual(providers[3].models, ['gpt-4o-transcribe', 'gpt-4o-mini-transcribe']);
    assert.equal(providers[4].baseUrl, 'https://second.test/v1');
    assert.equal(providers.some(row => row.models.some(model => /gemini|claude|gpt-5\.6-luna/u.test(model))), false);
});

test('STT sends the original audio bytes as multipart speech input without a chat persona', async () => {
    const buffer = Buffer.from([0x49, 0x44, 0x33, 1, 2, 3, 4]);
    const result = await transcribeAudioBuffer({ buffer, filename: 'voice.mp3', mimeType: 'audio/mpeg', providers: [provider],
        fetchImpl: async (url, options) => {
            assert.equal(url, 'https://audio.test/v1/audio/transcriptions');
            assert.equal(options.headers.Authorization, 'Bearer test');
            assert.equal(options.body.get('model'), 'gpt-transcribe');
            assert.equal(options.body.get('language'), 'ru');
            const file = options.body.get('file');
            assert.equal(file.name, 'voice.mp3');
            assert.equal(file.type, 'audio/mpeg');
            assert.deepEqual(Buffer.from(await file.arrayBuffer()), buffer);
            assert.equal(options.body.has('messages'), false);
            return Response.json({ text: 'Здесь не про волнение', usage: { total_tokens: 17 } });
        } });
    assert.equal(result.text, 'Здесь не про волнение');
    assert.equal(result.model, 'gpt-transcribe');
    assert.equal(result.transport, 'audio-transcriptions');
    assert.equal(result.usage.total_tokens, 17);
});

test('invalid speech results advance to the next audio model instead of becoming a successful transcript', async () => {
    const calls = [];
    const result = await transcribeAudioBuffer({ buffer: Buffer.from('audio'),
        providers: [{ ...provider, models: ['invalid-sentinel', 'empty', 'html', 'gpt-transcribe'] }],
        fetchImpl: async (_url, { body }) => {
            const model = body.get('model'); calls.push(model);
            if (model === 'invalid-sentinel') return Response.json({ text: '**Гигорейв**\n[NO_SPEECH]' });
            if (model === 'empty') return Response.json({ text: '' });
            if (model === 'html') return new Response('<html>upstream error</html>');
            return Response.json({ text: 'Действительная речь' });
        } });
    assert.deepEqual(calls, ['invalid-sentinel', 'empty', 'html', 'gpt-transcribe']);
    assert.equal(result.text, 'Действительная речь');
});

test('invalid transcript responses allow failover to a different transcription provider', async () => {
    const result = await transcribeAudioBuffer({ buffer: Buffer.from('audio'),
        providers: [{ ...provider, models: ['gpt-transcribe'] },
            { ...provider, name: 'second-provider', baseUrl: 'https://second.test/v1' }],
        fetchImpl: async url => url.includes('second')
            ? Response.json({ text: 'Текст после переключения' })
            : Response.json({ text: '**Гигорейв**\n[NO_SPEECH]' }) });
    assert.equal(result.provider, 'second-provider');
    assert.equal(result.text, 'Текст после переключения');
});

test('an unavailable audio endpoint advances to the next provider', async () => {
    const calls = [];
    const result = await transcribeAudioBuffer({ buffer: Buffer.from('audio'),
        providers: [{ ...provider, name: 'unavailable-model' }, { ...provider, name: 'available-model', baseUrl: 'https://second.test/v1' }],
        fetchImpl: async url => { calls.push(url); return url.includes('second')
            ? Response.json({ text: 'Распознанная речь' })
            : Response.json({ error: { message: 'model not found' } }, { status: 404 }); } });
    assert.equal(calls.length, 2);
    assert.equal(result.provider, 'available-model');
});

test('a provider error wrapped in HTTP 200 also advances to the next transcription model', async () => {
    const calls = [];
    const result = await transcribeAudioBuffer({ buffer: Buffer.from('audio'),
        providers: [{ ...provider, models: ['router-unavailable', 'gpt-transcribe'] }],
        fetchImpl: async (_url, { body }) => {
            const model = body.get('model'); calls.push(model);
            return model === 'router-unavailable'
                ? Response.json({ error: { message: 'no source for this model' } })
                : Response.json({ text: 'Речь распознана' });
        } });
    assert.deepEqual(calls, ['router-unavailable', 'gpt-transcribe']);
    assert.equal(result.text, 'Речь распознана');
});
