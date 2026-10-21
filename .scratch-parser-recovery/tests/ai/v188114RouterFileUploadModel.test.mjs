import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, writeFileSync, rmSync, openAsBlob } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, basename } from 'node:path';
import vm from 'node:vm';

const source = readFileSync(new URL('../../src/app/botApplication.js', import.meta.url), 'utf8');
const start = source.indexOf('async function uploadOpenAIInputFile({');
const end = source.indexOf('\nfunction buildOpenAIResponsesTelegramFileContent(', start);
assert.ok(start >= 0 && end > start, 'upload function must remain independently testable');
const uploadSource = source.slice(start, end);

function createUploader({ fetcher, includeModel = true, includeModelQuery = true, attempts = 1 } = {}) {
    const logs = [];
    const context = {
        OPENAI_INPUT_FILE_UPLOAD_INCLUDE_MODEL: includeModel,
        OPENAI_INPUT_FILE_UPLOAD_MODEL_QUERY: includeModelQuery,
        // V188.116 added a disk-cached, explicitly probed upload variant.
        // The original V188.114 behavior is still covered here with no cache.
        PROJECT_ARCHIVE_FILES_UPLOAD_VARIANT: 'auto',
        loadRouterFileProbeCache: () => null,
        getRouterFileVariant: () => null,
        buildRouterFileUploadRequest: () => { throw new Error('Unexpected explicit probe variant in legacy transport test'); },
        URL,
        OPENAI_REQUEST_TIMEOUT_MS: 60_000,
        process: { env: { OPENAI_INPUT_FILE_UPLOAD_ATTEMPTS: String(attempts) } },
        FormData,
        openAsBlob,
        basename,
        fetch: fetcher,
        getCurrentOperationSignal: () => undefined,
        combineAbortSignals: (signals) => signals.find(Boolean),
        buildOperationAbortSignal: () => new AbortController().signal,
        isRetryableProjectAuditError: error => Number(error?.status || 0) >= 500,
        delayMs: async () => {},
        console: { log: (...args) => logs.push(args.join(' ')) },
    };
    return {
        upload: vm.runInNewContext(`(${uploadSource})`, context),
        logs,
    };
}

test('project-audit auto mode refuses real ZIP upload without a confirmed probe', async () => {
    let calls = 0;
    const { upload } = createUploader({ fetcher: async () => { calls++; return new Response('{}'); } });
    await withZip(async filePath => {
        await assert.rejects(upload({filePath, model:'gpt-6-astra',
            idempotencyKey:'project-audit:job123:input-upload',
            requestBaseUrl:'https://router.example/v1', requestApiKey:'dummy'}),
        /PROJECT_ARCHIVE_FILES_VARIANT_UNCONFIRMED/u);
    });
    assert.equal(calls, 0);
});

async function withZip(callback) {
    const directory = mkdtempSync(join(tmpdir(), 'gigorave-model-upload-'));
    const filePath = join(directory, 'sanitized.zip');
    writeFileSync(filePath, Buffer.from([0x50,0x4b,0x03,0x04]));
    try { return await callback(filePath); }
    finally { rmSync(directory, { recursive: true, force: true }); }
}

test('compatible router receives selected Astra model, purpose and file in one multipart POST', async () => {
    let calls = 0;
    const {upload, logs} = createUploader({
        fetcher: async (url, options) => {
            calls++;
            assert.equal(new URL(url).pathname, '/v1/files');
            assert.equal(new URL(url).searchParams.get('model'), 'gpt-6-astra');
            assert.equal(options.method, 'POST');
            assert.equal(options.body.get('model'), 'gpt-6-astra');
            assert.equal(options.body.get('purpose'), 'user_data');
            assert.equal(options.body.get('file').name, 'sanitized.zip');
            assert.equal(options.headers['Idempotency-Key'], 'job:input');
            return new Response(JSON.stringify({id:'file-accepted'}), { status: 200 });
        },
    });
    await withZip(async filePath => {
        const result = await upload({filePath, filename:'sanitized.zip', model:'gpt-6-astra', requestBaseUrl:'https://router.example/v1', requestApiKey:'TEST_SECRET', idempotencyKey:'job:input'});
        assert.equal(result.fileId, 'file-accepted');
    });
    assert.equal(calls, 1);
    assert.match(logs.join('\n'), /model=gpt-6-astra/u);
    assert.match(logs.join('\n'), /queryModel=gpt-6-astra/u);
    assert.match(logs.join('\n'), /multipartFields=model=gpt-6-astra,purpose=user_data,file=\[binary 4 bytes\]/u);
    assert.doesNotMatch(logs.join('\n'), /TEST_SECRET/u);
});

test('missing model rejects locally before any /files request', async () => {
    let calls = 0;
    const {upload} = createUploader({fetcher: async () => {calls++; return new Response('{}');}});
    await withZip(async filePath => {
        await assert.rejects(upload({filePath, requestBaseUrl:'https://router.example/v1'}), /ASTRA_INPUT_FILE_UPLOAD_MODEL_MISSING/u);
    });
    assert.equal(calls, 0);
});

test('HTTP 400 does not blindly retry /files', async () => {
    let calls = 0;
    const {upload} = createUploader({ attempts:8, fetcher: async () => {
        calls++;
        return new Response(JSON.stringify({error:{message:'invalid field'}}), {status:400});
    }});
    await withZip(async filePath => {
        await assert.rejects(upload({filePath, model:'gpt-6-astra', requestBaseUrl:'https://router.example/v1'}), /HTTP 400/u);
    });
    assert.equal(calls, 1);
});

test('standard /files endpoints can omit optional router-specific model field', async () => {
    const {upload} = createUploader({includeModel:false, includeModelQuery:false, fetcher: async (url, options) => {
        assert.equal(new URL(url).searchParams.has('model'), false);
        assert.equal(options.body.has('model'), false);
        assert.equal(options.body.get('purpose'), 'user_data');
        return new Response(JSON.stringify({id:'file-standard'}), {status:200});
    }});
    await withZip(async filePath => {
        assert.equal((await upload({filePath, requestBaseUrl:'https://openai.example/v1'})).fileId, 'file-standard');
    });
});

test('Responses file-upload caller passes the already selected model', () => {
    const caller = source.slice(source.indexOf('async function generateOpenAITextWithFilesAttempt('));
    assert.match(caller, /uploadOpenAIInputFile\(\{[\s\S]*?mimeType:[^\n]*\n\s*model,\n\s*requestBaseUrl,/u);
});

test('project audit stage formats object errors as readable messages', () => {
    const stageStart = source.indexOf('function projectAuditStage(');
    const stageEnd = source.indexOf('\nasync function runWithConcurrency(', stageStart);
    const log = [];
    const stageFn = vm.runInNewContext(`(${source.slice(stageStart, stageEnd)})`, {
        getCurrentAiRequestId: () => 'request',
        auditRuntimeEvent: () => {},
        console:{ log: (...args) => log.push(args.join(' ')) },
    });
    stageFn('job-1','failed', {error:{name:'Error',message:'Router requires model'}});
    assert.match(log.join(' '), /error=Router requires model/u);
    assert.doesNotMatch(log.join(' '), /\[object Object\]/u);
});


test('actual serialized multipart bytes contain the model field and ZIP part', async () => {
    let requests = 0;
    const {upload} = createUploader({fetcher: async (url, options) => {
        requests++;
        const parsed = new URL(url);
        assert.equal(parsed.searchParams.get('model'), 'gpt-6-astra');
        assert.equal(options.headers['Content-Type'], undefined,
            'fetch must generate its own multipart boundary');
        const wireRequest = new Request(url, { method: options.method, body: options.body });
        assert.match(wireRequest.headers.get('content-type'), /^multipart\/form-data; boundary=/u);
        const serialized = Buffer.from(await wireRequest.arrayBuffer()).toString('latin1');
        assert.match(serialized, /name="model"\r\n\r\ngpt-6-astra\r\n/u);
        assert.match(serialized, /name="purpose"\r\n\r\nuser_data\r\n/u);
        assert.match(serialized, /name="file"; filename="sanitized.zip"/u);
        assert.match(serialized, /PK\x03\x04/u);
        return new Response(JSON.stringify({id:'file-serialized'}), {status:200});
    }});
    await withZip(async filePath => {
        const uploaded = await upload({filePath, filename:'sanitized.zip', model:'gpt-6-astra',
            requestBaseUrl:'https://router.example/v1/', requestApiKey:'SECRET'});
        assert.equal(uploaded.fileId, 'file-serialized');
    });
    assert.equal(requests, 1);
});

test('model URL query can be disabled without omitting multipart model', async () => {
    const {upload} = createUploader({includeModelQuery:false, fetcher: async (url, options) => {
        assert.equal(new URL(url).searchParams.has('model'), false);
        assert.equal(options.body.get('model'), 'gpt-6-astra');
        return new Response(JSON.stringify({id:'file-form-only'}), {status:200});
    }});
    await withZip(async filePath => {
        assert.equal((await upload({filePath, model:'gpt-6-astra',
            requestBaseUrl:'https://router.example/v1'})).fileId, 'file-form-only');
    });
});

test('model is required when only URL query is enabled', async () => {
    let calls = 0;
    const {upload} = createUploader({includeModel:false, includeModelQuery:true,
        fetcher: async () => {calls++; return new Response('{}');}});
    await withZip(async filePath => {
        await assert.rejects(upload({filePath, requestBaseUrl:'https://router.example/v1'}),
            /ASTRA_INPUT_FILE_UPLOAD_MODEL_MISSING/u);
    });
    assert.equal(calls, 0);
});
