import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
    ROUTER_FILE_PROBE_VARIANTS,
    buildRouterFileUploadRequest,
    getRouterFileVariant,
    probeRouterFileUploads,
    probeRouterInputFileOnce,
    routerFileProbeCachePath,
    saveRouterFileProbeCache,
    loadRouterFileProbeCache,
} from '../../src/features/ai/routerFileProbe.js';

const identity = { baseUrl: 'https://router.example/v1', model: 'gpt-6-astra', credentialName: 'test', apiKey: 'dummy-not-a-secret' };
function fixture() {
    const dir = mkdtempSync(join(tmpdir(), 'gigorave-router-probe-'));
    const file = join(dir, 'fixture.zip');
    writeFileSync(file, Buffer.from('fake tiny file bytes'));
    return { file, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}
function rejected(status, message = 'Model name not specified') {
    return new Response(JSON.stringify({ error: { message } }), { status, headers: { 'content-type': 'application/json' } });
}

test('known variants are finite and identify model locations without leaking credentials', async () => {
    assert.equal(ROUTER_FILE_PROBE_VARIANTS.length, 8);
    const blob = new Blob(['sample'], { type: 'application/zip' });
    const { url, options } = buildRouterFileUploadRequest({ ...identity, apiKey: 'private', fileBlob: blob, filename: 'tiny.zip', variant: 'multipart-model-query-model' });
    const request = new Request(url, options);
    const body = await request.text();
    assert.equal(new URL(request.url).searchParams.get('model'), 'gpt-6-astra');
    assert.match(body, /name="model"\r\n\r\ngpt-6-astra/u);
    assert.match(body, /name="purpose"\r\n\r\nuser_data/u);
    assert.match(body, /name="file"; filename="tiny.zip"/u);
    assert.equal(getRouterFileVariant('not-a-variant'), null);
});

test('explicit HTTP 400 switches upload variant and stops at first confirmed file_id', async () => {
    const { file, cleanup } = fixture();
    try {
        const observed = [];
        const response = await probeRouterFileUploads({ ...identity, fixturePath: file,
            fetchImpl: async (url, options) => {
                const form = options.body;
                observed.push({ url, model: form.get('model'), purpose: form.get('purpose'), file: form.get('file') });
                return observed.length === 1 ? rejected(400) : new Response(JSON.stringify({ id: 'file-test-123' }), { status: 200 });
            },
        });
        assert.equal(response.ok, true);
        assert.equal(response.fileId, 'file-test-123');
        assert.equal(response.variantId, 'multipart-model');
        assert.equal(observed.length, 2);
        assert.equal(observed[0].model, null);
        assert.equal(observed[1].model, 'gpt-6-astra');
        assert.equal(observed[1].file.size, 20);
    } finally { cleanup(); }
});

test('no further upload on uncertain 2xx response without id', async () => {
    const { file, cleanup } = fixture();
    try {
        let calls = 0;
        const result = await probeRouterFileUploads({ ...identity, fixturePath: file,
            fetchImpl: async () => { calls += 1; return new Response('{}', { status: 200 }); },
        });
        assert.equal(calls, 1);
        assert.equal(result.stopReason, 'ambiguous-upload-acceptance');
    } finally { cleanup(); }
});

test('no variant-switch on 401, 403, 429, 5xx, 404 or network failure', async () => {
    const { file, cleanup } = fixture();
    try {
        for (const status of [401, 403, 429, 500, 524, 404]) {
            let calls = 0;
            const result = await probeRouterFileUploads({ ...identity, fixturePath: file,
                fetchImpl: async () => { calls += 1; return rejected(status); },
            });
            assert.equal(calls, 1, `HTTP ${status} retried`);
            assert.equal(result.ok, false);
        }
        let calls = 0;
        const result = await probeRouterFileUploads({ ...identity, fixturePath: file,
            fetchImpl: async () => { calls += 1; throw new Error('socket disconnected'); },
        });
        assert.equal(calls, 1);
        assert.equal(result.stopReason, 'ambiguous-network-error');
    } finally { cleanup(); }
});

test('all eight known explicit rejects are bounded and cannot trigger paid /responses', async () => {
    const { file, cleanup } = fixture();
    try {
        const urls = [];
        const result = await probeRouterFileUploads({ ...identity, fixturePath: file,
            fetchImpl: async (url) => { urls.push(url); assert.match(url, /\/files(?:\?|$)/u); return rejected(400); },
        });
        assert.equal(result.ok, false);
        assert.equal(result.stopReason, 'known-variants-exhausted');
        assert.equal(urls.length, ROUTER_FILE_PROBE_VARIANTS.length);
    } finally { cleanup(); }
});

test('one opted-in Responses probe never retries after accepted, rejected or ambiguous POST', async () => {
    for (const mode of ['accepted', 'rejected', 'network']) {
        let calls = 0;
        const response = await probeRouterInputFileOnce({ ...identity, fileId: 'file-test',
            fetchImpl: async (url, options) => {
                calls += 1;
                assert.match(url, /\/responses$/u);
                const json = JSON.parse(options.body);
                assert.equal(json.model, 'gpt-6-astra');
                assert.equal(json.input[0].content[1].file_id, 'file-test');
                if (mode === 'network') throw new Error('524 proxy disconnected');
                if (mode === 'rejected') return rejected(400, 'unsupported input_file');
                return new Response(JSON.stringify({ id: 'resp-123', status: 'completed', output_text: 'ROUTER_PROBE.txt' }), { status: 200 });
            },
        });
        assert.equal(calls, 1);
        assert.equal(response.status, mode === 'accepted' ? 'response-accepted' : mode === 'rejected' ? 'rejected' : 'ambiguous-response-post');
    }
});

test('cache records working upload format and never persists key or file id', () => {
    const identityUnique = { ...identity, credentialName: `test-${Date.now()}-${Math.random()}` };
    const path = routerFileProbeCachePath(identityUnique);
    try {
        saveRouterFileProbeCache(identityUnique, { variantId: 'multipart-model', fileId: 'file-should-not-be-cached' });
        assert.equal(loadRouterFileProbeCache(identityUnique)?.id, 'multipart-model');
        const content = readFileSync(path, 'utf8');
        assert.doesNotMatch(content, /dummy-not-a-secret|file-should-not-be-cached/u);
        assert.equal(loadRouterFileProbeCache({ ...identityUnique, apiKey: 'changed-key' }), null);
    } finally { rmSync(path, { force: true }); }
});
