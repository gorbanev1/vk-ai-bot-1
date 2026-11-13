import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { AsyncLocalStorage } from 'node:async_hooks';
import { buildDateFreePhasePlan, serializeDateFreePhasePlan, restoreDateFreePhasePlan } from '../../src/features/scrapers/parserPhasePlan.js';
import { applyPosterGateResult } from '../../src/features/scrapers/posterGateResult.js';
import { POSTER_SCHEDULE_VISION_INSTRUCTION } from '../../src/features/events/posterScheduleEvidence.js';
import { posterScheduleFactNeedsRefresh } from '../../src/features/events/sharedEventSchedule.js';
import { parseIndexedImageFacts } from '../../src/features/events/eventAssets.js';
import { buildParserRecoveryNotice } from '../../src/features/scrapers/parserAllRecovery.js';
import { createDateFreeParserPolicy, formatDateFreePhaseReport } from '../../src/features/ai/dateFreeParserPolicy.js';
import { parseScraperStartCommand } from '../../src/features/scrapers/scraperCommandRouting.js';

test('one/two phase suffixes accept both word orders in primary and secondary parsers', () => {
    for (const base of ['парсер все', 'парсер все новые', 'тусы второстепенные парсер все']) {
        for (const suffix of ['фаза 1', '1 фаза', 'фаза 2', '2 фазы']) {
            const result = parseScraperStartCommand(`${base} ${suffix}`);
            assert.equal(result.matched, true);
            assert.equal(result.all, true);
            assert.equal(result.phaseCount, suffix.includes('1') ? 1 : 2);
        }
    }
});

test('phase two selects only uncached date-free images; reservations include excluded chats', () => {
    const preview = (id, phase, urls, known = false) => ({ itemId: id, visionPhase: phase, imageUrls: urls, incrementalKnown: known });
    const captures = [
        { sourceId: 'chat:2000000027', kind: 'vk-chat', prefilterPreviews: [preview('1', 'phase1', ['reserved']), preview('2', 'phase2-date-free-image', ['private'])] },
        { sourceId: 'vk:public', cachePath: 'one', prefilterPreviews: [preview('3', 'phase2-date-free-image', ['poster']), preview('4', 'phase2-date-free-image', []), preview('5', 'phase2-date-free-image', ['known'], true)] },
        { sourceId: 'chat:2000000022', kind: 'vk-chat', cachePath: 'two', prefilterPreviews: [preview('6', 'phase2-date-free-image', ['c22'])] },
    ];
    const read = (path) => ({ items: path === 'one' ? [{ postId: 3 }, { postId: 4 }, { postId: 5 }] : [{ conversationMessageId: 6 }] });
    const plan = buildDateFreePhasePlan(captures, read);
    assert.deepEqual(plan.reservedImageUrls, ['reserved']);
    assert.deepEqual([...plan.cacheRows.keys()], ['vk:public', 'chat:2000000022']);
    assert.equal(plan.cacheRows.get('vk:public').items.length, 1);
    assert.deepEqual(plan.failures, []);
    const restored = restoreDateFreePhasePlan(JSON.parse(JSON.stringify(serializeDateFreePhasePlan(plan))), read);
    assert.deepEqual(restored.cacheRows, plan.cacheRows);
    assert.deepEqual(restored.reservedImageUrls, ['reserved']);
});

test('missing phase-two cache is reported, never silently accepted or scraped again', () => {
    const captures = [{ sourceId: 'vk:public', prefilterPreviews: [{ itemId: '1', visionPhase: 'phase2-date-free-image', imageUrls: ['url'] }] }];
    const plan = buildDateFreePhasePlan(captures, () => { throw new Error('missing'); });
    assert.equal(plan.cacheRows.size, 0);
    assert.deepEqual(plan.failures, [{ sourceId: 'vk:public', error: 'missing' }]);
});

test('removing phase-one image keeps remaining OCR bound to the correct image', () => {
    const item = { imageUrls: ['duplicate', 'poster', 'photo'] };
    applyPosterGateResult(item, { dateFreePhase: true, inspectedImageUrls: ['poster', 'photo'], facts: '[IMAGE 2]\nЭто афиша события: да\nНазвание: Test\n\n[IMAGE 3]\nЭто афиша события: нет' });
    assert.deepEqual(item.imageUrls, ['poster', 'photo']);
    assert.ok(item.__posterGateFacts.startsWith('[IMAGE 1]'));
    assert.ok(item.__posterGateFacts.includes('[IMAGE 2]\nЭто афиша события: нет'));
    assert.ok(!item.__posterGateFacts.includes('[IMAGE 0]'));
});

test('cached bytes are sent to Vision while HTTP image identity survives trace and recovery', async () => {
    const app = readFileSync(new URL('../../src/app/botApplication.js', import.meta.url), 'utf8');
    const source = app.slice(app.indexOf('async function extractPosterGateFactsWithVision('), app.indexOf('async function readManualEventImageFacts('));
    const requests = [], traces = [], recovered = [];
    const extract = runInNewContext(`${source}; extractPosterGateFactsWithVision`, {
        process: { env: {} }, console, clampInteger: (value, min, max, fallback) => fallback,
        createManualParserLimiter: () => ({ run: (callback) => callback() }),
        buildEventTitleContractPrompt: () => '', formatEventTagPromptInstruction: () => '',
        EVENT_PARSER_AI_ATTEMPT_TIMEOUT_MS: 150000, parseIndexedImageFacts, formatPrivateError: String,
        POSTER_SCHEDULE_VISION_INSTRUCTION, posterScheduleFactNeedsRefresh,
        generateOpenAIVisionText: async (options) => { requests.push(options); return '[IMAGE 2]\nЭто афиша события: да\nНазвание: Концерт\nДата: 10.10.2026'; },
    });
    const facts = await extract({ imageUrls: ['https://example.com/poster.jpg'], imageIndexes: [2], dateFreePhase: true, sourceText: 'Вход свободный',
        prepareImage: () => 'data:image/jpeg;base64,YWJj',
        trace: (stage, data) => traces.push({ stage, data }),
        getCachedImageFact: (...args) => { recovered.push(args); return ''; },
    });
    assert.equal(requests.length, 1);
    assert.equal(requests[0].imageUrls[0], 'data:image/jpeg;base64,YWJj');
    assert.doesNotMatch(requests[0].userPrompt, /Вход свободный/u);
    assert.match(requests[0].systemPrompt, /Не сравнивай афишу с текстом поста/u);
    assert.equal(recovered[0][1], 'https://example.com/poster.jpg');
    assert.equal(traces.find(row => row.stage === 'image').data.imageUrl, 'https://example.com/poster.jpg');
    assert.ok(facts.includes('[IMAGE 2]'));
});

test('HTTP 400 downloads local bytes, preserves the image number and checkpoints the recovered result', async () => {
    const app = readFileSync(new URL('../../src/app/botApplication.js', import.meta.url), 'utf8');
    const source = app.slice(app.indexOf('async function extractPosterGateFactsWithVision('), app.indexOf('async function readManualEventImageFacts('));
    const calls = [], downloads = [], traces = [];
    const fact = '[IMAGE 6]\nЭто афиша события: нет\nПричина: Фотоотчёт';
    const extract = runInNewContext(`${source}; extractPosterGateFactsWithVision`, {
        process: { env: {} }, console: { log() {}, warn() {} }, clampInteger: (v, min, max, fallback) => fallback,
        createManualParserLimiter: () => ({ run: callback => callback() }),
        buildEventTitleContractPrompt: () => '', formatEventTagPromptInstruction: () => '',
        EVENT_PARSER_AI_ATTEMPT_TIMEOUT_MS: 150000, parseIndexedImageFacts, formatPrivateError: String,
        POSTER_SCHEDULE_VISION_INSTRUCTION, posterScheduleFactNeedsRefresh,
        downloadVisionImageAsset: async url => { downloads.push(url); return { dataUrl: 'data:image/jpeg;base64,YWJj' }; },
        generateOpenAIVisionText: async options => {
            calls.push(options.imageUrls[0]);
            if (calls.length === 1) throw new Error('GPT vision API 400: не удалось скачать вложение');
            assert.match(options.userPrompt, /IMAGE 6/u);
            return fact;
        },
    });
    const url = 'https://example.org/photo.jpg';
    assert.equal(await extract({ imageUrls: [url], imageIndexes: [6], trace: (stage, data) => traces.push({ stage, data }) }), fact);
    assert.deepEqual(calls, [url, 'data:image/jpeg;base64,YWJj']);
    assert.deepEqual(downloads, [url]);
    const saved = traces.find(row => row.stage === 'image');
    assert.equal(saved.data.imageNumber, 6);
    assert.equal(saved.data.imageUrl, url);
    assert.equal(saved.data.responseText, fact);
    assert.equal(traces.some(row => row.stage === 'image_error'), false);
});

test('VK download alternatives preserve foreign signatures and original URL priority', () => {
    const app = readFileSync(new URL('../../src/app/botApplication.js', import.meta.url), 'utf8');
    const source = app.slice(app.indexOf('function visionImageDownloadCandidates('), app.indexOf('async function downloadVisionImageAsset(url)'));
    const candidates = runInNewContext(`${source}; visionImageDownloadCandidates`, { URL, URLSearchParams });
    const foreign = 'https://example.org/poster.jpg?token=secret&size=640';
    assert.deepEqual(Array.from(candidates(foreign)), [foreign]);
    const vk = 'https://sun9-4.vkuserphoto.ru/s/v1/ig2/photo.jpg?quality=95&u=signature&from=bu&cs=360x0';
    const result = Array.from(candidates(vk));
    assert.equal(result[0], vk);
    assert.equal(result.length, 3);
    assert.equal(new URL(result[1]).searchParams.get('u'), 'signature');
});

test('failure-rate pause offers ordinary ladder and skip without automatic retry', () => {
    const result = buildParserRecoveryNotice({ id: 'test', available: true, partyPool: 'primary', phase: 'phase2',
        checkpoint: { phaseTwoModels: { stopped: true } }, cacheRows: new Map(), uncapturedSourceIds: [] });
    assert.equal(result.replyMarkup.inline_keyboard[0][0].callback_data, 'parser_ladder:test');
    assert.equal(result.replyMarkup.inline_keyboard[0][1].callback_data, 'parser_keep:test');
});

test('partial Vision failure preserves facts and resume calls only the failed image', async () => {
    const app = readFileSync(new URL('../../src/app/botApplication.js', import.meta.url), 'utf8');
    const source = app.slice(app.indexOf('async function extractPosterGateFactsWithVision('), app.indexOf('async function readManualEventImageFacts('));
    const calls = [], saved = new Map();
    let fail = true;
    const extract = runInNewContext(`${source}; extractPosterGateFactsWithVision`, {
        process: { env: {} }, console: { log() {}, warn() {} }, clampInteger: (v, min, max, fallback) => fallback,
        createManualParserLimiter: () => ({ run: callback => callback() }),
        buildEventTitleContractPrompt: () => '', formatEventTagPromptInstruction: () => '',
        EVENT_PARSER_AI_ATTEMPT_TIMEOUT_MS: 150000, parseIndexedImageFacts, formatPrivateError: String,
        POSTER_SCHEDULE_VISION_INSTRUCTION, posterScheduleFactNeedsRefresh,
        generateOpenAIVisionText: async options => {
            const url = options.imageUrls[0];
            calls.push(url);
            if (url.endsWith('failed.jpg') && fail) throw new Error('upstream timeout');
            const index = url.endsWith('failed.jpg') ? 3 : 2;
            return `[IMAGE ${index}]\nЭто афиша события: да\nНазвание: Концерт ${index}`;
        },
    });
    const urls = ['https://example.org/good.jpg', 'https://example.org/failed.jpg'];
    const options = { imageUrls: urls, imageIndexes: [2, 3], dateFreePhase: true,
        getCachedImageFact: (number, url) => saved.get(`${number}:${url}`),
        trace: (stage, data) => { if (stage === 'image') saved.set(`${data.imageNumber}:${data.imageUrl}`, data.responseText); },
    };
    await assert.rejects(extract(options), error => {
        assert.equal(error.code, 'POSTER_GATE_UNRESOLVED');
        assert.match(error.partialFacts, /Концерт 2/u);
        assert.doesNotMatch(error.partialFacts, /Концерт 3/u);
        return true;
    });
    fail = false;
    const facts = await extract(options);
    assert.deepEqual(calls, [...urls, urls[1]]);
    assert.deepEqual(parseIndexedImageFacts(facts).map(row => row.index), [2, 3]);
    const item = { imageUrls: ['phase-one', ...urls] };
    applyPosterGateResult(item, { dateFreePhase: true, inspectedImageUrls: urls, inspectedImageIndexes: [2, 3], facts });
    assert.deepEqual(parseIndexedImageFacts(item.__posterGateFacts).map(row => row.index), [1, 2]);
    assert.deepEqual(item.imageUrls, urls);
});

test('phase-two recovery honors durable owner choice and reuses the planned cache and image facts', async () => {
    const app = readFileSync(new URL('../../src/app/botApplication.js', import.meta.url), 'utf8');
    const start = app.indexOf('async function startAllManualScraperSources(');
    const source = app.slice(start, app.indexOf('    const normalizedPool =', start)).replace('function startAllManualScraperSources', 'function orchestrate') + '\n}';
    for (const ordinary of [false, true]) {
        const dateFreeParserContext = new AsyncLocalStorage();
        const cacheRows = new Map([['vk:venue', { items: [{ postId: 1 }], itemCount: 1 }]]);
        const posterGateImages = new Map([['image', 'fact']]);
        const recovery = { checkpoint: { ordinaryPhaseTwo: ordinary, dateFreePhasePlan: { phaseOneComplete: true } }, posterGateImages };
        let starts = 0, finishes = 0;
        const orchestrate = runInNewContext(`${source}; orchestrate`, {
            PARTY_POOL_PRIMARY: 'primary', Map, dateFreeParserContext, createDateFreeParserPolicy, formatDateFreePhaseReport,
            parserAttemptPacer: async () => {}, updateOperationProgress() {}, saveOperationCheckpoint() {},
            restoreDateFreePhasePlan: () => ({ cacheRows, reservedImageUrls: ['dated'], rawImageCache: new Map() }),
            startAllManualScraperSources: async options => {
                starts++;
                assert.equal(options.phasePass, 2);
                assert.equal(options.cacheOnly, true);
                assert.equal(options.recovery.posterGateImages, posterGateImages);
                assert.equal(options.recovery.cacheRows, cacheRows);
                assert.equal(Boolean(dateFreeParserContext.getStore()), !ordinary);
                return { startProcessing: async () => {
                    finishes++;
                    assert.equal(Boolean(dateFreeParserContext.getStore()), !ordinary);
                    return { ok: true, message: 'done' };
                } };
            },
        });
        const run = await orchestrate({ recovery });
        assert.equal((await run.startProcessing()).ok, true);
        assert.equal(starts, 1);
        assert.equal(finishes, 1);
    }
});

test('orchestrator persists phase one before phase two and uses the exact cache without capture', async () => {
    const app = readFileSync(new URL('../../src/app/botApplication.js', import.meta.url), 'utf8');
    const start = app.indexOf('async function startAllManualScraperSources(');
    const end = app.indexOf('    const normalizedPool =', start);
    const body = app.slice(start, end).replace('function startAllManualScraperSources', 'function orchestrate') + '\n}';
    const calls = [], checkpoints = [];
    const dateFreeParserContext = new AsyncLocalStorage();
    const cachedItem = { postId: 20, text: 'Афиша', imageUrls: ['date-free'] };
    const cacheRows = new Map([['vk:public', { path: 'original-cache', items: [cachedItem], itemCount: 1 }]]);
    const orchestrate = runInNewContext(`${body}; orchestrate`, {
        PARTY_POOL_PRIMARY: 'primary', Map, Date, Number, Object,
        dateFreeParserContext, createDateFreeParserPolicy, formatDateFreePhaseReport,
        parserAttemptPacer: async () => {}, updateOperationProgress: () => {},
        getCurrentOperation: () => ({ startedAt: '2026-10-07T12:00:00Z' }),
        saveOperationCheckpoint: (value) => checkpoints.push(value),
        serializeDateFreePhasePlan,
        buildDateFreePhasePlan: () => ({ cacheRows, reservedImageUrls: ['dated'], failures: [] }),
        startAllManualScraperSources: async (options) => {
            calls.push(`start:${options.phasePass}`);
            if (options.phasePass === 2) {
                assert.ok(calls.includes('persist:1'));
                assert.equal(options.cacheOnly, true);
                assert.equal(options.recovery.cacheRows.get('vk:public').items[0], cachedItem);
                assert.deepEqual([...options.reservedImageUrls], ['dated']);
                assert.ok(dateFreeParserContext.getStore());
                assert.equal(options.recovery.sourceIds.length, 1);
            }
            return { captures: [], visionTimingReport: { images: { planned: 1, recognized: 1, announcements: 1, unprocessed: 0 } },
                startProcessing: async () => {
                    if (options.phasePass === 2) assert.ok(dateFreeParserContext.getStore());
                    calls.push(`persist:${options.phasePass}`);
                    return { ok: true, results: [], total: 1, eventsCreatedCount: options.phasePass, message: 'ok' };
                },
            };
        },
    });
    const run = await orchestrate({});
    assert.deepEqual(calls, ['start:1']);
    const summary = await run.startProcessing();
    assert.equal(summary.eventsCreatedCount, 3);
    assert.deepEqual(calls, ['start:1', 'persist:1', 'start:2', 'persist:2']);
    assert.equal(checkpoints[0].dateFreePhasePlan.captures[0].itemIds[0], '20');
    assert.equal(await run.startProcessing(), summary);
});

test('phase-two progress stays live while its poster gate has not returned the run', { timeout: 3000 }, async () => {
    const app = readFileSync(new URL('../../src/app/botApplication.js', import.meta.url), 'utf8');
    const start = app.indexOf('async function startAllManualScraperSources(');
    const body = app.slice(start, app.indexOf('    const normalizedPool =', start)).replace('function startAllManualScraperSources', 'function orchestrate') + '\n}';
    const context = new AsyncLocalStorage();
    let enter, release;
    const entered = new Promise(resolve => { enter = resolve; });
    const held = new Promise(resolve => { release = resolve; });
    const operation = { progress: { tracePath: 'phase-one' } };
    const orchestrate = runInNewContext(`${body}; orchestrate`, {
        PARTY_POOL_PRIMARY: 'primary', Map, dateFreeParserContext: context, createDateFreeParserPolicy, formatDateFreePhaseReport,
        parserAttemptPacer: async () => {}, saveOperationCheckpoint() {}, updateOperationProgress() {},
        getCurrentOperation: () => operation, serializeDateFreePhasePlan,
        buildDateFreePhasePlan: () => ({ cacheRows: new Map([['vk:test', { items: [{ postId: 1 }], itemCount: 1 }]]), reservedImageUrls: [], failures: [] }),
        startAllManualScraperSources: async options => {
            if (options.phasePass === 1) return { captures: [], tracePath: 'phase-one', visionTimingReport: { totalRequests: 1 },
                getPendingCandidates: () => [{ sourceId: 'vk:storuvrn', itemId: '448', status: 'pending' }],
                startProcessing: async () => ({ ok: true, results: [], message: 'first' }) };
            operation.progress.tracePath = 'phase-two';
            await context.getStore().run('vision', async () => 'facts');
            enter();
            await held;
            return { tracePath: 'phase-two', visionTimingReport: { totalRequests: 29 }, getPendingCandidates: () => [],
                startProcessing: async () => ({ ok: true, results: [], message: 'second' }) };
        },
    });
    const run = await orchestrate({});
    assert.equal(run.getPendingCandidates().length, 1);
    const processing = run.startProcessing();
    try {
        await entered;
        assert.equal(run.getPendingCandidates().length, 0);
        assert.equal(run.tracePath, 'phase-two');
        assert.equal(run.phaseTwoModels.models['gpt-5.6-luna'].successes, 1);
    } finally { release(); }
    await processing;
    assert.equal(run.visionTimingReport.totalRequests, 29);
});

test('phase-two barriers release empty and finished sources while another source is still in Vision', { timeout: 3000 }, async () => {
    const app = readFileSync(new URL('../../src/app/botApplication.js', import.meta.url), 'utf8');
    const source = app.slice(app.indexOf('async function startAllManualScraperSources('), app.indexOf('const SECONDARY_PARTY_AUTO_TASK_KEY'));
    const sources = ['empty', 'fast', 'slow'].map(id => ({ id: `vk:${id}`, kind: 'vk-public', label: id }));
    const saved = [];
    let releaseSlow, fastSaved;
    const slow = new Promise(resolve => { releaseSlow = resolve; });
    const fast = new Promise(resolve => { fastSaved = resolve; });
    const noop = () => {};
    const diagnostics = { relativeLogPath: 'trace', directory: 'scratch', log: noop, saveParserReport: noop, saveTextReport: noop };
    const runAll = runInNewContext(`${source}; startAllManualScraperSources`, {
        process: { env: {} }, console: { log: noop, error: noop }, setTimeout, clearTimeout,
        PARTY_POOL_PRIMARY: 'primary', PARTY_POOL_SECONDARY: 'secondary',
        getManualScraperSources: () => sources, getCurrentOperation: () => ({ startedAt: '2026-10-07T12:00:00Z' }),
        createManualParserDiagnostics: () => diagnostics, saveOperationCheckpoint: noop, updateOperationProgress: noop, auditRuntimeEvent: noop,
        clampInteger: (value, min, max, fallback) => fallback,
        createManualParserLimiter: () => ({ run: callback => callback() }),
        createBrowserImageCapture: () => async () => {},
        createBrowserImageCacheRecovery: () => async () => 'data:image/png;base64,dGVzdA==',
        resolve: (...parts) => parts.join('/'),
        createVkLaunchStagger: () => () => { throw new Error('Must not reopen browser sources'); },
        existsSync: () => false, formatPrivateError: String, formatError: String, formatScraperErrorForUser: String,
        isParserVisionTimeout: () => false, parseIndexedImageFacts, vkChatEventScrapers: [], EVENT_PARSER_AI_ATTEMPT_TIMEOUT_MS: 150000,
        extractPosterGateFactsWithVision: async ({ sourceLabel }) => {
            if (sourceLabel === 'slow') await slow;
            return '[IMAGE 1]\nЭто афиша события: нет\nТип изображения: ordinary-photo';
        },
        startManualScraperSourceWithRecovery: async (entry, options) => {
            assert.ok(Array.isArray(options.cachedItems));
            assert.equal(options.cacheOnly, true);
            assert.equal(options.processingGate, null);
            const posterGateRequests = entry.label === 'empty' ? [] : [{ itemId: '1', source: entry.label, imageUrls: [`https://example.com/${entry.label}.jpg`], visionPhase: 'phase2-date-free-image' }];
            const payload = { itemCount: 1, posterGateRequests, prefilterPreviews: [], candidatePreviews: [] };
            options.onCaptureComplete(payload);
            await options.posterGateGate;
            if (posterGateRequests.length) assert.equal(options.getPosterGateResult(entry.id, '1').attempted, true);
            options.onAdmissionComplete(payload);
            saved.push(entry.label);
            if (entry.label === 'fast') fastSaved();
            return { ok: true, result: { eventsCreatedCount: 1 } };
        },
    });
    const pending = runAll({ phaseCount: 2, phasePass: 2, recovery: { sourceIds: sources.map(s => s.id), cacheRows: new Map(sources.map(s => [s.id, { path: 'cache', items: [] }])) } });
    try {
        await fast;
        assert.ok(saved.includes('empty'));
        assert.ok(saved.includes('fast'));
        assert.ok(!saved.includes('slow'));
    } finally { releaseSlow(); }
    const run = await pending;
    const summary = await run.startProcessing();
    assert.equal(summary.ok, true);
    assert.equal(summary.eventsCreatedCount, 3);
});
