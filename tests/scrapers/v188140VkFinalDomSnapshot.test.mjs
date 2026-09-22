import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, writeFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createManualParserDiagnostics } from '../../src/features/scrapers/manualParserDiagnostics.js';
import { prepareVkFinalDomCapture } from '../../src/features/scrapers/vkDomFinalSnapshot.js';
import { verifyVkFinalDomSnapshot } from '../../scripts/vk-dom-final-verify.mjs';

const dom = '<html lang="ru"><head></head><body><article data-post-id="-1_7"><a href="/wall-1_7">Анонс</a><img src="/poster.jpg"></article></body></html>';
function fakePage() {
    let reads = 0;
    return {
        isClosed: () => false,
        evaluate: async (_callback, options) => {
            if (options?.includeStructure) {
                reads += 1;
                return { html: dom, capturedAt: '2026-09-20T02:20:00Z',
                    state: { pageUrl: 'https://vk.com/public1', baseUri: 'https://vk.com/',
                        scrollY: 450, viewport: { width: 1200, height: 800 } },
                    resources: [{ kind: 'img', attributes: { src: '/poster.jpg' } }],
                    structure: { nodeCount: 1, elements: [{ index: 0, parentIndex: null, tag: 'html' }],
                        postLinkCandidates: [] } };
            }
            return dom; // in-memory parser reads do not persist snapshots
        },
        reads: () => reads,
    };
}

test('directional step and two full control passes: down; no HTML comparison', async () => {
    const heights = [100, 100, 100, 120, 120, 120, 120];
    let state = { atBottom: false, atTop: true, scrollHeight: 100 };
    const calls = [];
    const preparation = await prepareVkFinalDomCapture({
        direction: 'down',
        readState: () => Promise.resolve({ ...state }),
        stepTowardsEdge: () => { calls.push('down'); state.atBottom = true; state.atTop = false; },
        moveToEdge: () => {
            calls.push('edge-down');
            if (heights.length) state.scrollHeight = heights.shift();
            state.atBottom = true;
        },
        pause: async () => {}, controlWaitMs: 0, normalWaitMs: 0, finalSettleMs: 0,
    });
    assert.equal(preparation.prepared, true);
    assert.equal(preparation.direction, 'down');
    assert.equal(preparation.controlsCompleted, 2);
    assert.ok(calls.filter((x) => x === 'edge-down').length >= 2);
    assert.ok(preparation.progress.every((x) => !('html' in x)), 'progress contains only lightweight probes');
});

test('control-induced pagination restarts for native up-direction chat', async () => {
    let state = { atTop: true, atBottom: false, scrollHeight: 100, scrollTop: 0 };
    let controls = 0;
    let upSteps = 0;
    const preparation = await prepareVkFinalDomCapture({
        direction: 'up', readState: async () => ({ ...state }),
        stepTowardsEdge: async () => { upSteps++; state.atTop = true; state.scrollTop = 0; },
        moveToEdge: async () => {
            controls++;
            if (controls === 1) { state.scrollHeight = 120; state.atTop = false; state.scrollTop = 50; }
        }, pause: async () => {},
    });
    assert.equal(preparation.prepared, true);
    assert.equal(preparation.controlRestarts, 1);
    assert.equal(preparation.controlsCompleted, 2);
    assert.equal(upSteps, 1);
});

test('finite budget marks fixture incomplete rather than silently treating maxSteps as bottom', async () => {
    const result = await prepareVkFinalDomCapture({
        direction: 'up', readState: async () => ({ atTop: false, atBottom: true, scrollHeight: 999 }),
        stepTowardsEdge: async () => {}, moveToEdge: async () => {}, maxSteps: 2,
        pause: async () => {},
    });
    assert.equal(result.prepared, false);
    assert.equal(result.status, 'bounded-or-unstable');
    assert.equal(result.steps, 2);
});

test('parser-all keeps existing extraction in memory, persists one final raw VK DOM per source, verifies offline', async () => {
    const data = await mkdtemp(join(tmpdir(), 'vk-final-run-'));
    const diagnostics = createManualParserDiagnostics({ dataDirectory: data, label: 'parser-all' });
    const page = fakePage();
    assert.equal(diagnostics.finalDomOnly, true);
    const first = await diagnostics.captureVkDomFixture({ page, sourceId: 'vk:public1', label: 'scroll-001' });
    assert.equal(first.html, dom);
    assert.equal(first.persisted, false);
    const initial = await diagnostics.captureVkStructureBaseline({ page, sourceId: 'vk:public1' });
    assert.equal(initial.skipped, true);
    const preparation = { direction: 'down', status: 'edge-confirmed-bounded', prepared: true,
        progress: [{ phase: 'main', state: { atBottom: true } }] };
    const saved = await diagnostics.captureVkFinalDomSnapshot({
        page, sourceId: 'vk:public1', sourceKind: 'vk-public', direction: 'down', preparation,
    });
    const again = await diagnostics.captureVkFinalDomSnapshot({
        page, sourceId: 'vk:public1', sourceKind: 'vk-public', direction: 'down', preparation,
    });
    assert.deepEqual(saved, again);
    assert.equal(page.reads(), 1);
    assert.equal(await readFile(join(saved.directory, 'dom.raw.html'), 'utf8'), dom);
    assert.equal((await readdir(join(diagnostics.directory, 'vk-dom-final-snapshots'))).length, 1);
    await assert.rejects(stat(join(diagnostics.directory, 'vk-dom-fixtures')), /ENOENT/);
    const valid = await verifyVkFinalDomSnapshot(saved.directory);
    assert.equal(valid.direction, 'down');
    assert.equal(valid.allHistoryGuaranteed, false);
    await writeFile(join(saved.directory, 'dom.raw.html'), dom.replace('Анонс', 'ПОДМЕНА'));
    await assert.rejects(verifyVkFinalDomSnapshot(saved.directory), /hash\/byte-length mismatch/);
});

test('production captures raw DOM after native VK passes with NO second pagination and preserves directional metadata', async () => {
    const publicSrc = await readFile(new URL('../../src/platforms/vk/vkPublicScraper.js', import.meta.url), 'utf8');
    const chatSrc = await readFile(new URL('../../src/platforms/vk/vkChatEventScraper.js', import.meta.url), 'utf8');
    for (const source of [publicSrc, chatSrc]) {
        assert.doesNotMatch(source, /prepareVkFinalDomCapture\(/);
        assert.match(source, /status: 'native-capture-finished-no-extra-pagination'/);
        assert.match(source, /captureVkFinalDomSnapshot\(/);
    }
    assert.match(publicSrc, /sourceKind: 'vk-public',[\s\S]*?direction: 'down'/);
    assert.match(chatSrc, /sourceKind: 'vk-chat',[\s\S]*?direction: 'up'/);
});

test('Telegram captures existing HTML page without another up-scroll, preserves beforeId and direction', async () => {
    const telegramSource = await readFile(new URL('../../src/platforms/telegram/telegramHtmlScraper.js', import.meta.url), 'utf8');
    assert.doesNotMatch(telegramSource, /prepareVkFinalDomCapture\(/);
    assert.match(telegramSource, /status: 'native-capture-finished-no-extra-pagination'/);
    assert.match(telegramSource, /sourceId: `tg:\$\{channel\}:before:\$\{beforeId \|\| 'latest'\}`/);
    assert.match(telegramSource, /sourceKind: 'telegram-public-html-page', direction: 'up'/);
    assert.match(telegramSource, /const parsedCount = parseTelegramPublicHtml\(html, channel\)\.length/);
});
