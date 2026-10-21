import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { assertTrustedModelImageUrl } from '../../src/app/imageDownloadPolicy.js';

const source = readFileSync(new URL('../../src/app/botApplication.js', import.meta.url), 'utf8');
function compile(name, next, context) {
    const start = source.indexOf(name);
    const end = source.indexOf(next, start + name.length);
    assert.ok(start >= 0 && end > start);
    const functionName = /(?:async )?function\s+(\w+)/u.exec(name)[1];
    return runInNewContext(`${source.slice(start, end)}\n;(${functionName})`, context);
}

test('model image URL policy rejects local/HTTP/unknown hosts and accepts exact configured HTTPS', () => {
    assert.throws(() => assertTrustedModelImageUrl('http://router.example/image.png', {
        baseUrls: ['https://router.example/v1'],
    }), /HTTPS/u);
    assert.throws(() => assertTrustedModelImageUrl('https://127.0.0.1/private', {
        additionalHosts: '127.0.0.1',
    }), /IP literal/u);
    assert.throws(() => assertTrustedModelImageUrl('https://router.example.evil.test/image', {
        baseUrls: ['https://router.example/v1'],
    }), /not trusted/u);
    assert.throws(() => assertTrustedModelImageUrl('https://user:pw@router.example/image', {
        baseUrls: ['https://router.example/v1'],
    }), /HTTPS/u);
    assert.equal(assertTrustedModelImageUrl('https://router.example/image', {
        baseUrls: ['https://router.example/v1'],
    }), 'https://router.example/image');
    assert.equal(assertTrustedModelImageUrl('https://images.example/p.png', {
        additionalHosts: 'images.example',
    }), 'https://images.example/p.png');
});

test('image download blocks redirects to local hosts and never auto-follows provider redirects', async () => {
    const fetchCalls = [];
    const fn = compile('async function downloadOpenAIImage(url) {', '\nfunction isValidOpenAIImageBuffer(', {
        assertTrustedModelImageUrl,
        runtimeModelCredentials: [{baseUrl:'https://router.example/v1'}],
        openAIBaseUrl: 'https://router.example/v1',
        process: {env: {}},
        OPENAI_IMAGE_REQUEST_TIMEOUT_MS: 1000,
        buildOperationAbortSignal: () => undefined,
        OPENAI_IMAGE_MAX_BYTES: 50,
        fetch: async (url, options) => {fetchCalls.push({url, options}); return {ok:false,status:302};},
    });
    await assert.rejects(fn('https://router.example/image'), /HTTP 302/u);
    assert.equal(fetchCalls.length,1);
    assert.equal(fetchCalls[0].options.redirect,'manual');
    await assert.rejects(fn('https://localhost/image'), /not trusted/u);
    assert.equal(fetchCalls.length,1);
});

test('image download enforces size even when content-length is missing', async () => {
    let cancelled = false;
    const fn = compile('async function downloadOpenAIImage(url) {', '\nfunction isValidOpenAIImageBuffer(', {
        assertTrustedModelImageUrl,
        runtimeModelCredentials: [{baseUrl:'https://router.example/v1'}],
        openAIBaseUrl: 'https://router.example/v1',
        process: {env: {}}, Buffer,
        OPENAI_IMAGE_REQUEST_TIMEOUT_MS: 1000,
        buildOperationAbortSignal: () => undefined,
        OPENAI_IMAGE_MAX_BYTES: 5,
        fetch: async () => ({
            ok:true,status:200,
            headers: {get: () => null},
            body:{getReader:()=>({
                read: async () => ({value: new Uint8Array(6), done:false}),
                cancel: async () => {cancelled = true;},
                releaseLock() {},
            })},
        }),
    });
    await assert.rejects(fn('https://router.example/image'), /слишком большое/u);
    assert.equal(cancelled, true);
});

test('model catalogue unions numbered runtime credentials and tolerates one rejected key', async () => {
    const calls = [];
    const cache = {models:[],fetchedAt:0};
    const fn = compile('async function getOpenAIModels({ force = false } = {}) {', '\nasync function answerGptQuestion(', {
        openAIModelsCache: cache,
        OPENAI_MODELS_CACHE_MS: 99999,
        runtimeModelCredentials: [
            {baseUrl:'https://one.test/v1',secret:'k1',name:'one'},
            {baseUrl:'https://two.test/v1',secret:'k2',name:'two'},
            {baseUrl:'https://bad.test/v1',secret:'k3',name:'bad'},
        ],
        openAIApiKey:'',openAIBaseUrl:'https://fallback.test/v1',
        normalizeOpenAIBaseUrl: (url) => url,
        OPENAI_REQUEST_TIMEOUT_MS: 1000,
        buildOperationAbortSignal: () => undefined,
        fetch: async (url) => {
            calls.push(url);
            if (url.includes('bad.test')) return {ok:false,status:401};
            return {ok:true,json:async()=>({data: [{id:'common'},{id:url.includes('two.test')?'only-two':'only-one'}]})};
        },
        console: {warn() {}},
        formatPrivateError: (error) => String(error.message),
    });
    const models = await fn({force:true});
    assert.deepEqual([...models].sort(), ['common','only-one','only-two']);
    assert.equal(calls.length,3);
});
