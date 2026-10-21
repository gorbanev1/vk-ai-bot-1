import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { isAstraTextAttachmentRequest, decodeAstraTextAttachment, runAstraTextAttachmentAnalysis, ASTRA_TEXT_ATTACHMENT_MAX_BYTES, ASTRA_TEXT_ATTACHMENT_BATCH_CHARS, ASTRA_TEXT_ATTACHMENT_PROACTIVE_SPLIT_CHARS, splitAstraTextAttachment, isAstraTextContextRejection } from '../../src/features/audit/astraTextAttachment.js';
import { isProjectArchiveAuditCommand } from '../../src/features/audit/projectArchiveIntent.js';
import { resolveTextAttachmentModelChoice } from '../../src/features/audit/textAttachmentModelSelection.js';

const longRequest = `Гигорейв astra max\nЗАДАЧА: МАКСИМАЛЬНО ГЛУБОКИЙ АНАЛИЗ ПРИКРЕПЛЁННОГО ТЕКСТОВОГО ФАЙЛА GIGORAVE_NEW_CHAT_FULL_CONTEXT_V188117_RU(2).md\nВНИМАНИЕ! ЭТО ЗАДАНИЕ НА АНАЛИЗ ТЕКСТОВОГО ФАЙЛА, А НЕ НА СОЗДАНИЕ WORD-ДОКУМЕНТА. Прочитай прикреплённый файл полностью. Изучи документ как технический контекст разработки проекта GIGORAVE, включая маршрут Telegram ZIP и предыдущие аудиты проекта.`;
const md = { filename: 'GIGORAVE_NEW_CHAT_FULL_CONTEXT_V188117_RU.md', mimeType: 'text/markdown', fileSize: 2000 };

test('regression: the exact text-file analysis intent is routed to Astra TXT despite project/ZIP words', () => {
    assert.equal(isProjectArchiveAuditCommand(longRequest), true, 'old overbroad ZIP heuristic still matches: regression is real');
    assert.equal(isAstraTextAttachmentRequest(longRequest, [md]), true);
    assert.equal(isAstraTextAttachmentRequest('Гигорейв terra high, проанализируй текстовый файл', [md]), true);
    assert.equal(isAstraTextAttachmentRequest('Гигорейв gpt-5.5, проанализируй текстовый файл', [md]), true);
    assert.equal(isAstraTextAttachmentRequest('Гигорейв gpt-5.6-terra, проанализируй текстовый файл', [md]), true);
    assert.equal(isAstraTextAttachmentRequest(longRequest, [{ ...md, filename: 'project.zip' }]), false);
});

test('V188.126: actual single text file routes to TXT independent of caption, ZIP/DOCX remain separate', () => {
    const ordinaryCaption = 'Проведи независимое техническое ревью прикреплённого архива GIGORAVE V188.125. Особ';
    assert.equal(isAstraTextAttachmentRequest(ordinaryCaption, [{...md, filename:'GIGORAVE_V188124_ALL_EVENT_SOURCE_AND_ASTRA_REVIEW_RU.txt'}]), true);
    assert.equal(isAstraTextAttachmentRequest('Проанализируй вложенный текст', [md]), true);
    assert.equal(isAstraTextAttachmentRequest('', [md]), true);
    assert.equal(isAstraTextAttachmentRequest('Гигорейв astra max, аудит исходников. Пришли ZIP.', [{...md, filename:'source.txt'}]), true);
    assert.equal(isAstraTextAttachmentRequest('Астра max, аудит проекта. Прочитай ZIP.', [{...md, filename:'source.zip'}]), false);
    assert.equal(isAstraTextAttachmentRequest(longRequest, [{...md, filename:'source.docx'}]), false);
    assert.equal(isAstraTextAttachmentRequest(longRequest, [{...md, filename:'source.md', kind:'image'}]), false);
    assert.equal(isAstraTextAttachmentRequest(longRequest, [md, md]), false);
    assert.equal(isAstraTextAttachmentRequest(longRequest, []), false);
});

test('UTF-8 validation and size budgets are enforced before any model request', () => {
    assert.equal(decodeAstraTextAttachment(Buffer.from('\uFEFFПривет, мир!')), 'Привет, мир!');
    assert.throws(() => decodeAstraTextAttachment(Buffer.from([0xff])), /UTF-8/u);
    assert.throws(() => decodeAstraTextAttachment(Buffer.from('hello\0bad')), /бинар/u);
    assert.equal(decodeAstraTextAttachment(Buffer.alloc(600_000, 65)).length, 600_000);
    assert.throws(() => decodeAstraTextAttachment(Buffer.alloc(ASTRA_TEXT_ATTACHMENT_MAX_BYTES + 1, 65)), /предел/u);
});

test('mock end-to-end: MD bytes become only input_text; result is delivered as TXT, never Word/files', async () => {
    const calls = [];
    const delivered = [];
    const content = '# GIGORAVE\nTelegram ZIP → text batches\nВетка V188.117 описана, но V188.120 не проверена.';
    const result = await runAstraTextAttachmentAnalysis({
        descriptor: md,
        requestText: longRequest,
        download: async (descriptor) => { calls.push('download'); assert.equal(descriptor, md); return Buffer.from(content); },
        requestModel: async (options) => {
            calls.push('model');
            assert.equal(options.inputFiles.length, 0);
            assert.equal(options.backgroundResponse, false);
            assert.equal(options.streamOverride, true);
            assert.equal(options.disableTransportFallback, true);
            assert.equal(options.reasoningEffort, 'medium');
            assert.equal(options.verbosity, 'high');
            assert.match(options.userPrompt, /===== BEGIN TEXT FILE .*\.md =====/u);
            assert.ok(options.userPrompt.includes(content));
            assert.ok(!('onResponseArtifacts' in options));
            return 'Раздел 1. Документ описывает старую версию.\nРаздел 2. Требуются новые логи.';
        },
        deliver: async (attachment) => { calls.push('delivery'); delivered.push(attachment); },
    });
    assert.deepEqual(calls, ['download', 'model', 'delivery']);
    assert.equal(delivered.length, 1);
    assert.match(delivered[0].filename, /\.txt$/u);
    assert.equal(delivered[0].mimeType, 'text/plain; charset=utf-8');
    assert.match(delivered[0].buffer.toString('utf8'), /Раздел 1/u);
    assert.equal(result.inputChars, content.length);
});

test('errors and empty model results do not send an invented TXT', async () => {
    let deliveries = 0;
    const setup = (buffer, answer) => ({
        descriptor: md, requestText: longRequest,
        download: async () => buffer,
        requestModel: async () => answer,
        deliver: async () => { deliveries++; },
    });
    await assert.rejects(runAstraTextAttachmentAnalysis(setup(Buffer.from([0xff]), 'ok')), /UTF-8/u);
    await assert.rejects(runAstraTextAttachmentAnalysis(setup(Buffer.from('hello'), '')), /пустой TXT/u);
    assert.equal(deliveries, 0);
});

test('Telegram dispatch gives text handler priority over ZIP and generic Word/GPT file intake', () => {
    const code = readFileSync(new URL('../../src/app/botApplication.js', import.meta.url), 'utf8');
    const entry = code.slice(code.indexOf('async function handleTelegramIncomingCore('), code.indexOf('async function handleTelegramIncomingCore(') + 14_000);
    assert.ok(entry.indexOf('maybeHandleAstraTextAttachmentIncoming(') >= 0);
    assert.ok(entry.indexOf('maybeHandleAstraTextAttachmentIncoming(') < entry.indexOf('maybeHandleProjectArchiveAuditIncoming('));
    assert.ok(entry.indexOf('maybeHandleProjectArchiveAuditIncoming(') < entry.indexOf('hasIncomingTelegramModelFileAttachment('));
    const route = code.slice(code.indexOf('async function executeTelegramTextJob('), code.indexOf('async function maybeHandleProjectArchiveAuditIncoming('));
    assert.match(route, /runAstraTextAttachmentAnalysis\(/u);
    assert.match(route, /downloadTelegramFileBuffer\(/u);
    assert.match(route, /createTelegramDocumentAttachment\(result\)/u);
    assert.match(route, /generateOpenAIText\(\{/u);
    assert.doesNotMatch(route, /uploadOpenAIInputFile|handleDocumentArtifactRequest|input_file|base64/u);
});

test('runtime Telegram text handler: ordinary review caption selects default mini MEDIUM, sends one TXT', async () => {
    const { runInNewContext } = await import('node:vm');
    const { mkdtemp, rm } = await import('node:fs/promises');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const journalRoot = await mkdtemp(join(tmpdir(), 'gigorave-text-runtime-test-'));
    const code = readFileSync(new URL('../../src/app/botApplication.js', import.meta.url), 'utf8');
    const start = code.indexOf('async function executeTelegramTextJob(');
    const end = code.indexOf('async function maybeHandleProjectArchiveAuditIncoming(', start);
    assert.ok(start > 0 && end > start);
    const seen = { fetches: 0, model: 0, sends: [], markers: [] };
    const raw = {
        telegramApi: {
            getFile: async () => ({file_path: 'documents/safe.md'}),
            buildFileUrl: (path) => `https://telegram.invalid/${path}`,
        },
    };
    const sandbox = {
        isOwnerContext: () => true,
        isPrivateContext: () => true,
        collectTelegramModelFileDescriptors: () => [md],
        getRawContext: () => raw,
        isAstraTextAttachmentRequest,
        openAIApiKey: 'test-only',
        telegramOwnerExternalUserId: '12345',
        randomUUID: () => '00000000-0000-4000-8000-000000000007',
        saveTextJobRecipient: async (manifest) => { seen.manifest = manifest; },
        appendTelegramTextTransferLog: async () => {},
        markTextJobDelivered: async (metadata) => { seen.deliveredJob = metadata.jobId; return true; },
        getTelegramTextJobDeliveryState: async () => null,
        markTelegramTextJobDelivery: async () => {},
        beginTelegramTextJob: ({jobId}) => ({jobId, controller: new AbortController(), running:true}),
        finishTelegramTextJob: async () => {},
        observeTelegramTextJob: async () => {},
        saveTelegramTextJobInput: async () => {},
        readTelegramTextJobLog: async () => 'test log',
        recoverTelegramTextStageByGet: async () => { throw new Error('test no remote'); },
        ASTRA_TEXT_ATTACHMENT_MAX_BYTES,
        Buffer,
        console: {log: () => {}, warn: () => {}, error: (s, err) => {throw new Error(`${s}: ${err}`);}},
        resolveTextAttachmentModelChoice,
        resolveGptModel: async (mode) => {assert.equal(mode, 'default'); return 'gpt-5.4-mini';},
        process: { env: {} },
        isAstraModel: (model) => model === 'gpt-6-astra',
        getTelegramFileMetadataResilient: raw.telegramApi.getFile,
        downloadTelegramFileBuffer: async (url) => {
            seen.fetches++;
            assert.match(url, /^https:\/\/telegram\.invalid\//u);
            return Buffer.from('# GIGORAVE context\nText only.');
        },
        enqueueOpenAI: (fn) => fn(),
        generateOpenAIText: async (opts) => {
            seen.model++;
            assert.equal(opts.model, 'gpt-5.4-mini');
            assert.deepEqual(Array.from(opts.inputFiles), []);
            assert.equal(opts.streamOverride, true);
            assert.equal(opts.disableTransportFallback, true);
            assert.equal(opts.maxCandidates, 1);
            assert.equal(opts.reasoningEffort, 'medium');
            assert.equal(opts.allowAdvancedControlRetry, false);
            assert.match(opts.userPrompt, /Text only\./u);
            return 'Обработан только приложенный контекст.';
        },
        createTelegramDocumentAttachment: (result) => ({type: 'document', ...result}),
        runAstraTextAttachmentAnalysis: (options) => runAstraTextAttachmentAnalysis({
            ...options, retryOptions: { ...options.retryOptions, journalRoot },
        }),
        formatPrivateError: (err) => err.message,
    };
    const handler = runInNewContext(`${code.slice(start,end)}\nmaybeHandleAstraTextAttachmentIncoming`, sandbox);
    const context = {
        markDurableIntake: (item) => seen.markers.push(item.reason),
        send: async (message) => seen.sends.push(message),
    };
    assert.equal(await handler(context, 'Проведи независимое техническое ревью прикреплённого архива GIGORAVE V188.125. Особ'), true);
    assert.equal(seen.fetches, 1);
    assert.equal(seen.manifest.chatId, '12345');
    assert.equal(seen.deliveredJob, seen.manifest.jobId);
    assert.equal(seen.model, 1);
    assert.deepEqual(seen.markers, ['astra-text-attachment']);
    assert.equal(seen.sends.length, 3);
    assert.match(seen.sends[0], /gpt-5[.]4-mini/u);
    assert.equal(seen.sends[1].attachment.type, 'document');
    assert.equal(seen.sends[1].attachment.filename, 'GIGORAVE_TEXT_ANALYSIS.txt');
    assert.match(seen.sends[2].attachment.filename, /transfer[.]log$/u);
    assert.match(seen.sends[1].attachment.buffer.toString('utf8'), /Обработан только приложенный/u);
    await rm(journalRoot, {recursive:true,force:true});
});


test('large UTF-8 input is proactively split into sequential text-only model calls and one TXT', async () => {
    const source = 'Привет, Astra!\n'.repeat(60_000);
    assert.ok(Buffer.byteLength(source, 'utf8') > 524_288);
    const requests = [];
    const delivered = [];
    const result = await runAstraTextAttachmentAnalysis({
        descriptor: {filename: 'big.txt'}, requestText: 'Гигорейв astra max. Анализируй текст.',
        download: async () => Buffer.from(source, 'utf8'),
        requestModel: async (options) => { requests.push(options); return 'Полный анализ всего документа.'; },
        deliver: async (item) => delivered.push(item),
    });
    const partCalls = requests.filter((item) => item.userPrompt.includes('===== BEGIN TEXT PART ====='));
    assert.ok(partCalls.length > 1);
    assert.equal(requests.some((item) => item.userPrompt.includes('===== BEGIN TEXT FILE')), false);
    assert.equal(partCalls.map((item) => item.userPrompt.split('===== BEGIN TEXT PART =====\n')[1].split('\n===== END TEXT PART =====')[0]).join(''), source);
    assert.ok(partCalls.every((item) => item.inputFiles.length === 0 && item.streamOverride === true));
    assert.equal(result.batches, partCalls.length);
    assert.equal(delivered.length, 1);
    assert.match(delivered[0].buffer.toString('utf8'), /Полный анализ/u);
});

test('smaller input is tried whole; confirmed provider 413/context rejection triggers batches and one TXT', async () => {
    const source = 'А'.repeat(75_000) + '\n' + 'Б'.repeat(75_000) + '\n' + 'В'.repeat(75_000);
    let active = 0;
    let maxActive = 0;
    const calls = [];
    const delivered = [];
    const result = await runAstraTextAttachmentAnalysis({
        descriptor: {filename: 'large.txt'}, requestText: 'Гигорейв astra max. Анализируй текст.',
        download: async () => Buffer.from(source, 'utf8'),
        requestModel: async (options) => {
            active++;
            maxActive = Math.max(maxActive, active);
            calls.push(options);
            try {
                if (calls.length === 1) {
                    const err = new Error('context_length_exceeded');
                    err.status = 413;
                    throw err;
                }
                if (options.userPrompt.includes('===== BEGIN TEXT PART =====')) return `Анализ части ${calls.length}`;
                return 'Итоговая сводка всех частей';
            } finally { active--; }
        },
        deliver: async (result) => delivered.push(result),
    });
    assert.equal(maxActive, 1);
    assert.ok(calls[0].userPrompt.includes(source), 'first attempt must contain the entire source');
    const partCalls = calls.filter((item) => item.userPrompt.includes('===== BEGIN TEXT PART ====='));
    assert.ok(partCalls.length > 1);
    const extracted = partCalls.map((item) => item.userPrompt.split('===== BEGIN TEXT PART =====\n')[1].split('\n===== END TEXT PART =====')[0]).join('');
    assert.equal(extracted, source, 'every source character covered exactly once, in original order');
    assert.equal(result.batches, partCalls.length);
    assert.equal(delivered.length, 1);
    const txt = delivered[0].buffer.toString('utf8');
    assert.match(txt, /АНАЛИЗ ЧАСТИ 1\//u);
    assert.match(txt, /Итоговая сводка/u);
});

test('opt-out policy: ambiguous started inference, stream interruption and generic timeout NEVER cause another POST', async () => {
    for (const {status, message, started} of [
        {status: 504, message: 'Gateway timeout'},
        {status: 413, message: 'context_length_exceeded', started: true},
        {status: 500, message: 'connection reset'},
    ]) {
        const err = new Error(message);
        err.status = status;
        if (started) err.inferenceMayHaveStarted = true;
        let calls = 0;
        await assert.rejects(runAstraTextAttachmentAnalysis({
            descriptor: {filename: 'big.txt'}, requestText: 'Гигорейв astra max. Анализируй текст.',
            download: async () => Buffer.from('А'.repeat(600_000)),
            requestModel: async () => { calls++; throw err; },
            retryOptions: { allowAmbiguousRepost: false, wait: async () => {} },
            deliver: async () => assert.fail('no result can be delivered'),
        }), /context_length_exceeded|timeout|connection reset/u);
        assert.equal(calls, status === 413 ? 1 : 3);
    }
});

test('confirmed rejection excludes already started and unrelated 413-like prose', () => {
    assert.equal(isAstraTextContextRejection({status: 400, message: 'context_length_exceeded'}), true);
    assert.equal(isAstraTextContextRejection({status: 413, message: 'Payload Too Large'}), true);
    assert.equal(isAstraTextContextRejection({status: 413, message: 'Payload Too Large', responseId: 'resp_123'}), false);
    assert.equal(isAstraTextContextRejection({status: 504, message: 'context length proxy timeout'}), false);
    assert.equal(isAstraTextContextRejection({status: 400, message: 'wrong model'}), false);
    const rejection = `GPT STREAM ERROR context_length_exceeded: This model's maximum context length is 372000 tokens, but the request requires 484612 estimated input tokens plus up to 20000 output tokens.`;
    assert.equal(isAstraTextContextRejection({ status: null, message: rejection, inferenceMayHaveStarted: true }), true);
    assert.equal(isAstraTextContextRejection({ status: null, message: rejection, responseId: 'resp_123' }), false);
    assert.equal(isAstraTextContextRejection({ status: null, message: 'GPT RESPONSES STREAM ERROR: stream_read_error' }), false);
});

test('split preserves original Unicode text exactly and respects default chunk budget', () => {
    const source = ('Строка🙂\n'.repeat(14_000));
    const chunks = splitAstraTextAttachment(source);
    assert.ok(chunks.length > 1);
    assert.ok(chunks.every((part) => part.text.length <= ASTRA_TEXT_ATTACHMENT_BATCH_CHARS));
    assert.equal(chunks.map((part) => part.text).join(''), source);
});

// V188.128: the observed 2.04M-char GIGORAVE source exceeds Terra's provider
// context ceiling; do not bill or wait for the obviously doomed full request.
test('2M-char source skips full POST and retains model key, effort and complete ordered coverage', async () => {
    const source = 'src/features/events/safeFile.js\n' + 'строка кода\n'.repeat(200_000);
    assert.ok(source.length > 2_000_000);
    assert.ok(source.length > ASTRA_TEXT_ATTACHMENT_PROACTIVE_SPLIT_CHARS);
    const calls = [];
    const delivered = [];
    const events = [];
    const result = await runAstraTextAttachmentAnalysis({
        descriptor: { filename: 'source.txt' }, requestText: 'Проведи ревью',
        model: 'gpt-5.6-terra', reasoningEffort: 'high',
        download: async () => Buffer.from(source),
        onProgress: (event) => events.push(event),
        requestModel: async (options) => {
            calls.push(options);
            assert.equal(options.reasoningEffort, 'high');
            assert.deepEqual(options.inputFiles, []);
            assert.ok(options.userPrompt.length < ASTRA_TEXT_ATTACHMENT_BATCH_CHARS + 2000);
            return options.userPrompt.includes('BEGIN TEXT PART') ? 'Проверена часть' : 'Сводка';
        },
        deliver: async (value) => delivered.push(value),
    });
    const parts = calls.filter((opts) => opts.userPrompt.includes('===== BEGIN TEXT PART ====='));
    assert.ok(parts.length >= 29);
    assert.equal(calls.some((opts) => opts.userPrompt.includes('===== BEGIN TEXT FILE')), false);
    assert.equal(parts.map((opts) => opts.userPrompt.split('===== BEGIN TEXT PART =====\n')[1].split('\n===== END TEXT PART =====')[0]).join(''), source);
    assert.equal(result.batches, parts.length);
    assert.equal(events.find((event) => event.stage === 'chunk-plan').totalBatches, parts.length);
    assert.equal(delivered.length, 1);
    assert.match(delivered[0].buffer.toString('utf8'), /ПОДРОБНЫЕ РЕЗУЛЬТАТЫ/u);
});
